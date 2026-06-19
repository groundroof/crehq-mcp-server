/**
 * End-to-end test: drives the full OAuth 2.1 handshake against the in-process
 * router (the SAME `handleRequest` the Worker uses) and then makes MCP calls
 * over the Streamable-HTTP endpoint.
 *
 * Flow exercised:
 *   1. Discovery   GET /.well-known/oauth-authorization-server + protected-resource
 *   2. DCR         POST /register (RFC 7591) -> client_id
 *   3. PKCE        generate verifier + S256 challenge
 *   4. Authorize   GET /authorize -> consent page (pending_id)
 *   5. Consent     POST /authorize/consent (links CREHQ key) -> redirect ?code
 *   6. Token       POST /token (code + PKCE verifier) -> access_token + refresh
 *   7. Negative    POST /token with a WRONG verifier -> invalid_grant
 *   8. Refresh     POST /token grant_type=refresh_token -> new access_token
 *   9. MCP no-auth POST /mcp without Bearer -> 401 + WWW-Authenticate
 *  10. MCP init    POST /mcp initialize -> serverInfo
 *  11. MCP list    POST /mcp tools/list -> tool catalog (scope-filtered)
 *  12. MCP call    POST /mcp tools/call crehq_locations_list -> LIVE CREHQ API
 *  13. Tier gate   POST /mcp tools/call premium tool when scope absent -> upgrade
 *
 * The CREHQ key for step 5/12 comes from CREHQ_TEST_API_KEY. If unset, the test
 * still PROVES the wiring: the consent step will reject (live 401/403), which
 * exercises the validate->reject path end to end. Set the env var to see real
 * rows. The key is NEVER printed.
 */
import { handleRequest, type AppConfig } from "../src/router.js";
import { MemoryStore } from "../src/storage.js";
import { sha256Base64Url, base64url } from "../src/crypto.js";
import { DEFAULT_API_BASE } from "../src/client.js";

const store = new MemoryStore();
const ISSUER = "http://localhost:8787";
const cfg: AppConfig = {
  issuer: ISSUER,
  crehqApiBase: (process.env.CREHQ_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
  timeoutMs: 30000,
};

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

function req(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(new Request(ISSUER + path, init), store, cfg);
}
function form(obj: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(obj).toString(),
  };
}

async function main(): Promise<void> {
  console.log("\n=== CREHQ Remote MCP — OAuth 2.1 + Streamable-HTTP E2E ===");
  console.log(`CREHQ base: ${cfg.crehqApiBase}`);
  console.log(`Test key:   ${TEST_KEY ? "provided (will fetch real rows)" : "NOT set (will prove the 401/403 path)"}\n`);

  // 1. Discovery -------------------------------------------------------------
  const asMeta = await (await req("/.well-known/oauth-authorization-server")).json();
  check("discovery: AS metadata", asMeta.issuer === ISSUER && !!asMeta.authorization_endpoint && !!asMeta.token_endpoint);
  check("discovery: PKCE S256 advertised", Array.isArray(asMeta.code_challenge_methods_supported) && asMeta.code_challenge_methods_supported.includes("S256"));
  const prMeta = await (await req("/.well-known/oauth-protected-resource")).json();
  check("discovery: protected-resource points at AS", Array.isArray(prMeta.authorization_servers) && prMeta.authorization_servers[0] === ISSUER);

  // 2. Dynamic Client Registration ------------------------------------------
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const regRes = await req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude (test)", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  const reg = await regRes.json();
  check("DCR: 201 + client_id issued", regRes.status === 201 && typeof reg.client_id === "string", reg.client_id);
  const clientId = reg.client_id as string;

  // 3. PKCE ------------------------------------------------------------------
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));

  // 4. Authorize -------------------------------------------------------------
  const authQs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:locations read:intelligence",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authRes = await req(`/authorize?${authQs.toString()}`);
  const authHtml = await authRes.text();
  const m = authHtml.match(/name="pending_id" value="([^"]+)"/);
  const pendingId = m?.[1] ?? "";
  check("authorize: consent page rendered with pending_id", authRes.status === 200 && pendingId.length > 0);

  // negative: PKCE plain rejected
  const noPkce = await req(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: "x", code_challenge_method: "plain" }).toString()}`);
  check("authorize: rejects non-S256 PKCE (302 error redirect)", noPkce.status === 302 && (noPkce.headers.get("location") ?? "").includes("invalid_request"));

  // 5. Consent (links the CREHQ key, validated against LIVE API) -------------
  const consentRes = await req(
    "/authorize/consent",
    form({ pending_id: pendingId, crehq_api_key: TEST_KEY || "crehq_live_invalid_test_key_000" }),
  );

  if (!TEST_KEY) {
    // No key -> live validation should reject -> consent re-renders with error.
    const txt = await consentRes.text();
    check(
      "consent: invalid key rejected via LIVE CREHQ validation (proves wiring)",
      consentRes.status === 400 && /not accepted|expired|required/i.test(txt),
      "no CREHQ_TEST_API_KEY set",
    );
    console.log("\n  NOTE: set CREHQ_TEST_API_KEY=crehq_live_... to exercise the token + real tool-call path.");
    summarize();
    return;
  }

  check("consent: 302 redirect back to client with code", consentRes.status === 302);
  const loc = consentRes.headers.get("location") ?? "";
  const redirUrl = new URL(loc);
  const code = redirUrl.searchParams.get("code") ?? "";
  check("consent: state echoed back", redirUrl.searchParams.get("state") === state);
  check("consent: authorization code present", code.length > 0);

  // 7. Negative token exchange (wrong PKCE verifier) -------------------------
  // (run BEFORE the real exchange, on a fresh code, to avoid consuming it)
  // We re-run consent to get a second single-use code for the negative test.
  const auth2 = await req(`/authorize?${authQs.toString()}`);
  const pid2 = (await auth2.text()).match(/name="pending_id" value="([^"]+)"/)?.[1] ?? "";
  const consent2 = await req("/authorize/consent", form({ pending_id: pid2, crehq_api_key: TEST_KEY }));
  const code2 = new URL(consent2.headers.get("location") ?? ISSUER).searchParams.get("code") ?? "";
  const badExchange = await req("/token", form({ grant_type: "authorization_code", code: code2, redirect_uri: redirectUri, client_id: clientId, code_verifier: "wrong-verifier" }));
  check("token: wrong PKCE verifier -> invalid_grant", badExchange.status === 400 && (await badExchange.json()).error === "invalid_grant");

  // 6. Token exchange (correct) ----------------------------------------------
  const tokRes = await req("/token", form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }));
  const tok = await tokRes.json();
  check("token: access_token issued", tokRes.status === 200 && typeof tok.access_token === "string");
  check("token: refresh_token issued", typeof tok.refresh_token === "string");
  check("token: cache-control no-store", (tokRes.headers.get("cache-control") ?? "").includes("no-store"));
  const accessToken: string = tok.access_token;
  const grantedScopes: string[] = (tok.scope ?? "").split(" ").filter(Boolean);
  console.log(`  ...granted scopes: ${grantedScopes.join(", ")}`);

  // single-use code: replay must fail
  const replay = await req("/token", form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }));
  check("token: authorization code is single-use (replay rejected)", replay.status === 400);

  // 8. Refresh ---------------------------------------------------------------
  const refRes = await req("/token", form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }));
  const ref = await refRes.json();
  check("token: refresh_token grant -> new access_token", refRes.status === 200 && typeof ref.access_token === "string" && ref.access_token !== accessToken);

  // 9. MCP without auth ------------------------------------------------------
  const noAuth = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  check("mcp: 401 without Bearer", noAuth.status === 401);
  check("mcp: WWW-Authenticate points at resource metadata", (noAuth.headers.get("www-authenticate") ?? "").includes("resource_metadata"));

  const mcp = (msg: unknown) =>
    req("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: JSON.stringify(msg) });

  // 10. initialize -----------------------------------------------------------
  const initR = await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } })).json();
  check("mcp: initialize returns serverInfo", initR.result?.serverInfo?.name === "crehq-mcp-remote");

  // 11. tools/list -----------------------------------------------------------
  const listR = await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
  const toolNames: string[] = (listR.result?.tools ?? []).map((t: { name: string }) => t.name);
  check("mcp: tools/list returns tools", toolNames.length > 0, `${toolNames.length} tools visible for granted scopes`);
  const hasIntel = grantedScopes.includes("read:intelligence");
  check(
    "mcp: tool catalog scope-filtered correctly",
    hasIntel ? toolNames.includes("crehq_whitespace") : !toolNames.includes("crehq_whitespace"),
    hasIntel ? "intel tools visible" : "intel tools hidden (basic key)",
  );

  // 12. tools/call -> LIVE CREHQ API -----------------------------------------
  const callR = await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "crehq_locations_list", arguments: { brand: "starbucks", per_page: 2 } } })).json();
  const callText: string = callR.result?.content?.[0]?.text ?? "";
  const callOk = !callR.result?.isError && callText.length > 0;
  check("mcp: tools/call crehq_locations_list hit LIVE CREHQ API", callOk, callOk ? "got rows" : `error: ${callText.slice(0, 120)}`);
  console.log(`  ...live response (first 240 chars):\n    ${callText.replace(/\n/g, "\n    ").slice(0, 240)}`);

  // 13. tier gating ----------------------------------------------------------
  if (!hasIntel) {
    const gateR = await (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crehq_whitespace", arguments: { company_id: "1" } } })).json();
    const gateText: string = gateR.result?.content?.[0]?.text ?? "";
    check("mcp: premium tool blocked with upgrade message when scope absent", gateR.result?.isError === true && /premium|upgrade|scope/i.test(gateText));
  } else {
    const gateR = await (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crehq_whitespace", arguments: { company_id: "1" } } })).json();
    check("mcp: premium tool reachable with intel scope (proxies to API)", !!gateR.result?.content);
  }

  summarize();
}

function summarize(): void {
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
