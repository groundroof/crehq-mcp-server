/**
 * Full-mechanics E2E test with the TEST-ONLY key-validation bypass enabled
 * (cfg.unsafeSkipKeyValidation = true). This proves every moving part of the
 * server WITHOUT a real sandbox key:
 *
 *   - OAuth 2.1: register -> authorize -> consent -> token (code+PKCE) -> refresh
 *   - Token issuance + single-use codes + refresh rotation
 *   - MCP Streamable-HTTP: 401 challenge, initialize, tools/list, tools/call
 *   - Scope-filtered tool catalog (basic vs intel)
 *   - Tier gating (premium tool blocked for a basic-scoped token)
 *   - The tools/call PROXIES TO THE LIVE CREHQ API. Because the pasted key is a
 *     dummy, the live API returns a real 401 — which is surfaced as a non-fatal
 *     tool error. THAT 401 is the end-to-end proof that requests reach crehq.com
 *     with the per-user key. (Set CREHQ_TEST_API_KEY to get real rows instead.)
 *
 * This file demonstrates that the only thing standing between this build and
 * live rows is a valid CREHQ key — every other layer is verified here.
 */
import { handleRequest, type AppConfig } from "../src/router.js";
import { MemoryStore } from "../src/storage.js";
import { sha256Base64Url, base64url } from "../src/crypto.js";
import { DEFAULT_API_BASE } from "../src/client.js";

const ISSUER = "http://localhost:8787";
const TEST_KEY = (process.env.CREHQ_TEST_API_KEY ?? "").trim();

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run(scopeRequest: string, label: string): Promise<void> {
  console.log(`\n--- scenario: ${label} (scope="${scopeRequest}") ---`);
  const store = new MemoryStore();
  const cfg: AppConfig = {
    issuer: ISSUER,
    crehqApiBase: (process.env.CREHQ_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    timeoutMs: 30000,
    unsafeSkipKeyValidation: !TEST_KEY, // real key => real validation
  };
  const req = (path: string, init: RequestInit = {}) => handleRequest(new Request(ISSUER + path, init), store, cfg);
  const form = (obj: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(obj).toString(),
  });

  // DCR
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri] }) })).json();
  const clientId = reg.client_id as string;

  // PKCE + authorize
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const authQs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopeRequest, state, code_challenge: challenge, code_challenge_method: "S256" });
  const pendingId = (await (await req(`/authorize?${authQs}`)).text()).match(/name="pending_id" value="([^"]+)"/)?.[1] ?? "";

  // consent
  const consent = await req("/authorize/consent", form({ pending_id: pendingId, crehq_api_key: TEST_KEY || "crehq_live_dummy_poc_key" }));
  const code = new URL(consent.headers.get("location") ?? ISSUER).searchParams.get("code") ?? "";
  check("oauth: authorization code minted", consent.status === 302 && code.length > 0);

  // token
  const tok = await (await req("/token", form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }))).json();
  check("oauth: access + refresh token issued", typeof tok.access_token === "string" && typeof tok.refresh_token === "string");
  const accessToken = tok.access_token as string;
  const granted = (tok.scope ?? "").split(" ").filter(Boolean);
  console.log(`  ...granted scopes: ${granted.join(", ")}`);

  // refresh rotation
  const ref = await (await req("/token", form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }))).json();
  check("oauth: refresh grant -> new access token", typeof ref.access_token === "string" && ref.access_token !== accessToken);

  const mcp = (msg: unknown, token = accessToken) =>
    req("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(msg) });

  // initialize
  const init = await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
  check("mcp: initialize -> serverInfo", init.result?.serverInfo?.name === "crehq-mcp-remote", `protocol ${init.result?.protocolVersion}`);

  // notification (no id) -> 202 no body
  const notif = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("mcp: notification acked with 202 (no body)", notif.status === 202);

  // tools/list scope-filtered. A free self-serve sandbox key only exposes the
  // bounded tools that can actually return data on `/selfserve/*`.
  const list = await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
  const names: string[] = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
  const hasIntel = granted.includes("read:intelligence");
  const selfserveCatalog =
    names.length === 3 &&
    names.includes("crehq_locations_list") &&
    names.includes("crehq_locations_nearby") &&
    names.includes("crehq_request_upgrade");
  check(
    "mcp: tools/list count matches tier",
    selfserveCatalog || names.length === (hasIntel ? 26 : 21),
    `${names.length} tools (intel=${hasIntel}, selfserve=${selfserveCatalog})`,
  );
  check("mcp: intel tools gated in catalog", hasIntel ? names.includes("crehq_whitespace") : !names.includes("crehq_whitespace"));

  // tools/call -> live API (dummy key => real 401, real key => rows)
  const call = await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "crehq_locations_list", arguments: { brand: "starbucks", per_page: 2 } } })).json();
  const text: string = call.result?.content?.[0]?.text ?? "";
  if (TEST_KEY) {
    check("mcp: tools/call returned LIVE rows", !call.result?.isError && text.length > 0, "real key");
  } else {
    check("mcp: tools/call reached LIVE CREHQ API (real 401/403 for dummy key proves proxy wiring)", call.result?.isError === true && /HTTP 40[13]|Unauthorized|Invalid or revoked|not accepted/i.test(text), text.slice(0, 90));
  }
  console.log(`  ...live API said (first 160 chars): ${text.replace(/\n/g, " ").slice(0, 160)}`);

  // tier gating for basic-only token
  if (!hasIntel) {
    const gate = await (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crehq_whitespace", arguments: { company_id: "1" } } })).json();
    check("mcp: premium tool blocked with upgrade message (no API call)", gate.result?.isError === true && /premium|upgrade|scope/i.test(gate.result?.content?.[0]?.text ?? ""));
  }
}

async function main(): Promise<void> {
  console.log("\n=== CREHQ Remote MCP — FULL MECHANICS E2E ===");
  console.log(`mode: ${TEST_KEY ? "REAL key (live validation + rows)" : "PoC bypass (proves transport + real-API 401 proxy)"}`);
  await run("read:locations", "basic tier");
  await run("read:locations read:intelligence", "intelligence tier");
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
