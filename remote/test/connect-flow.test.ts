/**
 * Offline tests for:
 *   - "Sign in with CREHQ" (/authorize cookie + button, /authorize/crehq-callback,
 *     HMAC-signed grant exchange, replay, cookie binding, cancel, 403)
 *   - the shared paste/sign-in completion path
 *   - raw `crehq_live_` API-key bearers on /mcp (validation, 300 s sha256 cache, 401)
 *   - the three site-selection tools (catalog visibility + exact query params)
 *
 * globalThis.fetch is mocked for the exchange endpoint and the CREHQ API, so no
 * request leaves the process. The router under test is the same `handleRequest`
 * the Worker uses.
 */
import { createHmac } from "node:crypto";
import { handleRequest, type AppConfig } from "../src/router.js";
import { MemoryStore, type Store } from "../src/storage.js";
import { base64url, sha256Base64Url, sha256Hex } from "../src/crypto.js";

type JsonObject = Record<string, any>;

const ISSUER = "https://mcp.crehq.test";
const API_BASE = "https://api.crehq.test/wp-json/crehq/v1";
const SITE_ORIGIN = "https://www.crehq.test";
const CONNECT_SECRET = "test-connect-secret-4f9c2b7e1d";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CLIENT_NAME = "Claude (Purdue test)";
const ISSUED_KEY = "crehq_live_cohort_issued_key_0001";
const RAW_SELFSERVE_KEY = "crehq_live_raw_selfserve_key_0002";
const RAW_FULL_KEY = "crehq_live_raw_full_key_0003";
const RAW_INVALID_KEY = "crehq_live_raw_invalid_key_0004";

const SITE_TOOLS = ["crehq_site_selector_match", "crehq_brands_matching_site", "crehq_company_site_requirements"];
const OPENINGS_TOOLS = ["crehq_openings_nearby"];
const COHORT_TOOLS = ["crehq_companies_search", "crehq_brand_cotenancy", "crehq_brand_economics", "crehq_access_summary"];
const FDD_TOOLS = ["crehq_brand_investment", "crehq_brand_expansion"];
const TEAM_TOOLS = [
  "crehq_team_list",
  "crehq_team_items",
  "crehq_team_item_add",
  "crehq_team_item_remove",
  "crehq_team_note_add",
  "crehq_team_notes",
  "crehq_team_site_save",
  "crehq_team_site_runs",
];
const SELFSERVE_CATALOG = [
  "crehq_request_upgrade",
  "crehq_resolve_entity_affiliation",
  "crehq_locations_list",
  "crehq_locations_nearby",
  "crehq_purchased_datasets_list",
  "crehq_purchased_dataset_locations",
  "crehq_intelligence_preview",
  ...SITE_TOOLS,
  ...COHORT_TOOLS,
  ...FDD_TOOLS,
  ...OPENINGS_TOOLS,
  ...TEAM_TOOLS,
];

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

/** MemoryStore that records every write so tests can inspect KV key names/values. */
class RecordingStore implements Store {
  private readonly inner = new MemoryStore();
  readonly puts: Array<{ key: string; value: string; ttl?: number }> = [];
  getJSON<T>(key: string): Promise<T | null> {
    return this.inner.getJSON<T>(key);
  }
  async putJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.puts.push({ key, value: JSON.stringify(value), ttl: ttlSeconds });
    await this.inner.putJSON(key, value, ttlSeconds);
  }
  del(key: string): Promise<void> {
    return this.inner.del(key);
  }
}

// --- fetch mock ----------------------------------------------------------------

interface Upstream {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}
const upstream: Upstream[] = [];
let exchangeReply: (call: Upstream) => Response = () => jsonResponse(500, { message: "exchange not configured" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const call: Upstream = {
    url,
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: typeof init.body === "string" ? init.body : "",
  };
  upstream.push(call);
  if (!url.href.startsWith(`${API_BASE}/`)) return jsonResponse(599, { message: "unexpected upstream" });
  const route = url.pathname.slice(new URL(API_BASE).pathname.length);
  const key = call.headers.get("x-api-key") ?? "";

  if (route === "/selfserve/mcp-connect/exchange") return exchangeReply(call);
  if (route === "/selfserve/usage") {
    return key === RAW_SELFSERVE_KEY || key === ISSUED_KEY
      ? jsonResponse(200, { calls_used: 3, monthly_quota: 1000 })
      : jsonResponse(401, { message: "Invalid or revoked API key." });
  }
  if (route === "/companies/search") {
    return key === RAW_FULL_KEY ? jsonResponse(200, []) : jsonResponse(401, { message: "Invalid or revoked API key." });
  }
  if (route === "/intelligence/whitespace" || route.endsWith("/credit-signals")) {
    return jsonResponse(403, { message: "Not entitled." });
  }
  if (route.startsWith("/selfserve/")) return jsonResponse(200, { route, limits: { measured: true }, notes: [] });
  return jsonResponse(404, { message: "not mocked" });
};

// --- helpers -------------------------------------------------------------------

function makeApp(connectSecret: string) {
  const store = new RecordingStore();
  const cfg: AppConfig = {
    issuer: ISSUER,
    crehqApiBase: API_BASE,
    timeoutMs: 5000,
    crehqSiteOrigin: SITE_ORIGIN,
    crehqConnectSecret: connectSecret,
  };
  const req = (path: string, init: RequestInit = {}) => handleRequest(new Request(ISSUER + path, init), store, cfg);
  return { store, req };
}
type App = ReturnType<typeof makeApp>;

function form(obj: Record<string, string>, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(obj).toString(),
  };
}

async function startAuthorization(app: App, scope = "read:locations read:intelligence") {
  const regRes = await app.req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const reg = (await regRes.json()) as JsonObject;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await app.req(`/authorize?${qs.toString()}`);
  const html = await res.text();
  const pendingId = html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? "";
  return { clientId: reg.client_id as string, verifier, state, res, html, pendingId, setCookie: res.headers.get("set-cookie") ?? "" };
}

function callback(app: App, params: Record<string, string>, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  return app.req(`/authorize/crehq-callback?${new URLSearchParams(params).toString()}`, { headers });
}

const exchangeCount = (): number => upstream.filter((c) => c.url.pathname.endsWith("/selfserve/mcp-connect/exchange")).length;
const isClearedCookie = (res: Response): boolean => {
  const sc = res.headers.get("set-cookie") ?? "";
  return sc.startsWith("crehq_mcp_pending=;") && sc.includes("Max-Age=0") && sc.includes("Path=/authorize");
};

function mcp(app: App, token: string, msg: unknown): Promise<Response> {
  return app.req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(msg),
  });
}

async function listToolNames(app: App, token: string): Promise<{ status: number; names: string[] }> {
  const res = await mcp(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  if (res.status !== 200) return { status: res.status, names: [] };
  const body = (await res.json()) as JsonObject;
  return { status: res.status, names: (body.result?.tools ?? []).map((t: { name: string }) => t.name) };
}

async function callTool(app: App, token: string, name: string, args: Record<string, unknown>): Promise<JsonObject> {
  const res = await mcp(app, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return ((await res.json()) as JsonObject).result ?? {};
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && b.every((n) => a.includes(n));
const successExchange = (): Response =>
  jsonResponse(200, {
    key: ISSUED_KEY,
    api_surface: "selfserve",
    tier: "free",
    cohort: "purdue-fall-2026",
    expires_at: "2026-12-20 23:59:59",
  });

// --- scenarios -----------------------------------------------------------------

async function testConsentPage(): Promise<void> {
  console.log("\n--- /authorize: cookie + Sign in with CREHQ button ---");
  const app = makeApp(CONNECT_SECRET);
  const a = await startAuthorization(app);
  check("authorize: 200 with pending id", a.res.status === 200 && a.pendingId.length > 0);
  check(
    "authorize: sets crehq_mcp_pending cookie with exact attributes",
    a.setCookie === `crehq_mcp_pending=${a.pendingId}; Path=/authorize; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    a.setCookie.replace(a.pendingId, "<pending>"),
  );
  const href = (a.html.match(/id="crehq-signin" href="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&");
  let signIn: URL | null = null;
  try {
    signIn = new URL(href);
  } catch {
    signIn = null;
  }
  check(
    "authorize: primary button -> CREHQ_SITE_ORIGIN/mcp-connect/?pending=&client=",
    signIn !== null &&
      `${signIn.origin}${signIn.pathname}` === `${SITE_ORIGIN}/mcp-connect/` &&
      signIn.searchParams.get("pending") === a.pendingId &&
      signIn.searchParams.get("client") === CLIENT_NAME &&
      href.includes(`&client=${encodeURIComponent(CLIENT_NAME)}`),
  );
  check(
    "authorize: paste form kept as secondary 'Use an API key instead'",
    a.html.includes("Use an API key instead") && a.html.includes('name="crehq_api_key"'),
  );

  const off = makeApp("");
  const b = await startAuthorization(off);
  check(
    "authorize: empty CREHQ_CONNECT_SECRET -> button hidden, paste form shown",
    b.res.status === 200 && !b.html.includes("/mcp-connect/") && !b.html.includes("crehq-signin") && b.html.includes('name="crehq_api_key"'),
  );
  const before = exchangeCount();
  const disabled = await callback(off, { pending: b.pendingId, grant: "grant_disabled_000001" }, `crehq_mcp_pending=${b.pendingId}`);
  check(
    "callback: sign-in disabled -> message page, no exchange",
    disabled.status === 503 && !disabled.headers.get("location") && exchangeCount() === before,
  );
}

async function testSignInHappyPathAndReplay(): Promise<void> {
  console.log("\n--- sign-in happy path + replay ---");
  const app = makeApp(CONNECT_SECRET);
  const a = await startAuthorization(app);
  const grant = `grant_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const cookie = `theme=dark; crehq_mcp_pending=${a.pendingId}`;
  exchangeReply = successExchange;

  const before = upstream.length;
  const res = await callback(app, { pending: a.pendingId, grant }, cookie);
  const location = res.headers.get("location") ?? "";
  check("sign-in: 302 back to the client's redirect_uri", res.status === 302 && location.startsWith(`${REDIRECT_URI}?`));
  const back = new URL(location || ISSUER);
  const code = back.searchParams.get("code") ?? "";
  check("sign-in: code + original state returned", code.length > 0 && back.searchParams.get("state") === a.state);
  check("sign-in: pending cookie cleared", isClearedCookie(res));

  const exchanges = upstream.slice(before).filter((c) => c.url.pathname.endsWith("/selfserve/mcp-connect/exchange"));
  const ex = exchanges[0];
  check(
    "exchange: exactly one POST to CREHQ_API_BASE/selfserve/mcp-connect/exchange",
    exchanges.length === 1 && ex?.method === "POST" && ex.url.href === `${API_BASE}/selfserve/mcp-connect/exchange`,
  );
  const ts = ex?.headers.get("x-crehq-connect-timestamp") ?? "";
  const sig = ex?.headers.get("x-crehq-connect-signature") ?? "";
  const expected = createHmac("sha256", CONNECT_SECRET).update(`${ts}.${grant}.${a.pendingId}`).digest("hex");
  check("exchange: X-CREHQ-Connect-Timestamp is current unix seconds", /^\d{10}$/.test(ts) && Math.abs(Number(ts) - Date.now() / 1000) < 30, ts);
  check("exchange: X-CREHQ-Connect-Signature = lowercase hex HMAC-SHA256(secret, ts.grant.pending)", /^[0-9a-f]{64}$/.test(sig) && sig === expected);
  let exBody: JsonObject = {};
  try {
    exBody = JSON.parse(ex?.body ?? "") as JsonObject;
  } catch {
    exBody = {};
  }
  check(
    "exchange: JSON body is exactly {grant, pending}",
    (ex?.headers.get("content-type") ?? "").includes("application/json") &&
      Object.keys(exBody).sort().join(",") === "grant,pending" &&
      exBody.grant === grant &&
      exBody.pending === a.pendingId,
  );
  check(
    "exchange: connect secret never transmitted",
    !!ex && ![...ex.headers.values()].some((v) => v.includes(CONNECT_SECRET)) && !ex.body.includes(CONNECT_SECRET),
  );

  const tokRes = await app.req(
    "/token",
    form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: a.clientId, code_verifier: a.verifier }),
  );
  const tok = (await tokRes.json()) as JsonObject;
  check("sign-in: code redeems with the PKCE verifier", tokRes.status === 200 && typeof tok.access_token === "string");
  check("sign-in: selfserve surface -> scope read:locations only (read:intelligence was requested)", tok.scope === "read:locations", tok.scope);

  const list = await listToolNames(app, tok.access_token);
  check("mcp: selfserve session lists the 3 new site tools", list.status === 200 && SITE_TOOLS.every((n) => list.names.includes(n)));
  check(`mcp: selfserve catalog is exactly the ${SELFSERVE_CATALOG.length} whitelisted tools`, sameSet(list.names, SELFSERVE_CATALOG), `${list.names.length} tools`);

  const callBefore = upstream.length;
  const result = await callTool(app, tok.access_token, "crehq_company_site_requirements", { company: "planet-fitness" });
  const calls = upstream.slice(callBefore);
  check(
    "mcp: site tool proxies with the CREHQ-issued key",
    result.isError === undefined && calls.length === 1 && calls[0].headers.get("x-api-key") === ISSUED_KEY,
  );

  const exBefore = exchangeCount();
  const replay = await callback(app, { pending: a.pendingId, grant }, cookie);
  const replayHtml = await replay.text();
  check(
    "replay: used pending id rejected (message page, no code, no second exchange)",
    replay.status === 400 && !replay.headers.get("location") && /expired/i.test(replayHtml) && exchangeCount() === exBefore,
  );
  const replayDeny = await callback(app, { pending: a.pendingId, error: "access_denied" }, cookie);
  check("replay: used pending id cannot produce an error redirect either", replayDeny.status === 400 && !replayDeny.headers.get("location"));

  await testSiteToolQueries(app, tok.access_token);
}

async function testSiteToolQueries(app: App, token: string): Promise<void> {
  console.log("\n--- site tools: exact upstream routes + query params ---");
  const cases: Array<{ name: string; args: Record<string, unknown>; path: string; query: Record<string, string> }> = [
    {
      name: "crehq_site_selector_match",
      args: {
        sqft: 2400,
        site_type: "Endcap, drive_thru",
        category: "restaurant",
        state: "in",
        aadt_actual: 18500,
        population_actual: 42000,
        hhi_actual: 61000,
        radius: 3,
        revealed_strictness: "operating",
        cotenants: "starbucks, chipotle",
        cotenant_class: "grocery_anchored",
        include_unknown: true,
        franchise_available: false,
        sort: "fit",
        page: 2,
        per_page: 25,
      },
      path: "/selfserve/site-selector/match",
      query: {
        sqft: "2400",
        site_type: "endcap,drive_thru",
        category: "restaurant",
        state: "IN",
        aadt_actual: "18500",
        population_actual: "42000",
        hhi_actual: "61000",
        radius: "3",
        revealed_strictness: "operating",
        cotenants: "starbucks,chipotle",
        cotenant_class: "grocery_anchored",
        include_unknown: "true",
        franchise_available: "false",
        sort: "fit",
        page: "2",
        per_page: "25",
      },
    },
    {
      name: "crehq_brands_matching_site",
      args: {
        sqft: 1800,
        site_type: "inline",
        aadt: 12000,
        population: 30000,
        hhi: 55000,
        radius_miles: 5,
        cotenants: "target",
        category: "fitness",
        state: "OH",
        limit: 20,
        include_unknown: false,
        require_envelope_fit: true,
      },
      path: "/selfserve/brands-matching-site",
      query: {
        sqft: "1800",
        site_type: "inline",
        aadt: "12000",
        population: "30000",
        hhi: "55000",
        radius_miles: "5",
        cotenants: "target",
        category: "fitness",
        state: "OH",
        limit: "20",
        include_unknown: "false",
        require_envelope_fit: "true",
      },
    },
    {
      name: "crehq_company_site_requirements",
      args: { company: 24734 },
      path: "/selfserve/company-requirements",
      query: { company: "24734" },
    },
  ];
  for (const tc of cases) {
    const before = upstream.length;
    const result = await callTool(app, token, tc.name, tc.args);
    const sent = upstream.slice(before);
    const got = sent[0] ? Object.fromEntries([...sent[0].url.searchParams.entries()].sort()) : {};
    const want = Object.fromEntries(Object.entries(tc.query).sort());
    check(
      `${tc.name}: GET ${tc.path} with exact query`,
      result.isError === undefined &&
        sent.length === 1 &&
        sent[0].method === "GET" &&
        sent[0].url.pathname === `${new URL(API_BASE).pathname}${tc.path}` &&
        JSON.stringify(got) === JSON.stringify(want),
      new URLSearchParams(got).toString(),
    );
  }

  const before = upstream.length;
  const badPerPage = await callTool(app, token, "crehq_site_selector_match", { per_page: 51 });
  const badType = await callTool(app, token, "crehq_site_selector_match", { site_type: "kiosk" });
  check(
    "crehq_site_selector_match: per_page > 50 and unknown site_type rejected before any API call",
    badPerPage.isError === true && badType.isError === true && /Invalid arguments/.test(badType.content?.[0]?.text ?? "") && upstream.length === before,
  );
}

async function testCookieMismatch(): Promise<void> {
  console.log("\n--- cookie binding ---");
  const app = makeApp(CONNECT_SECRET);
  const a = await startAuthorization(app);
  exchangeReply = successExchange;
  const before = exchangeCount();

  const wrong = await callback(app, { pending: a.pendingId, grant: "grant_mismatch_0000001" }, "crehq_mcp_pending=someone-elses-pending");
  const wrongHtml = await wrong.text();
  check(
    "cookie mismatch: rejected with 'Please restart the connection from your AI app.'",
    wrong.status === 400 && !wrong.headers.get("location") && wrongHtml.includes("Please restart the connection from your AI app."),
  );
  const missing = await callback(app, { pending: a.pendingId, grant: "grant_mismatch_0000002" });
  const missingHtml = await missing.text();
  check(
    "cookie missing: rejected with the same restart message",
    missing.status === 400 && missingHtml.includes("Please restart the connection from your AI app."),
  );
  check("cookie mismatch/missing: exchange never called", exchangeCount() === before);

  const ok = await callback(app, { pending: a.pendingId, grant: "grant_after_mismatch_01" }, `crehq_mcp_pending=${a.pendingId}`);
  check(
    "cookie mismatch: pending authorization not burned (matching browser still completes)",
    ok.status === 302 && new URL(ok.headers.get("location") ?? ISSUER).searchParams.has("code"),
  );

  const ghost = "ghost_pending_id_000000";
  const gone = await callback(app, { pending: ghost, grant: "grant_ghost_000000001" }, `crehq_mcp_pending=${ghost}`);
  const goneHtml = await gone.text();
  check(
    "unknown/expired pending (cookie matches): message page, no exchange",
    gone.status === 400 && !gone.headers.get("location") && /expired/i.test(goneHtml) && exchangeCount() === before + 1,
  );
}

async function testExchangeForbiddenThenPaste(): Promise<void> {
  console.log("\n--- exchange 403 -> message page; paste still works (shared path) ---");
  const app = makeApp(CONNECT_SECRET);
  const a = await startAuthorization(app);
  const grant = "grant_forbidden_0000001";
  exchangeReply = () =>
    jsonResponse(403, {
      code: "crehq_connect_invalid",
      message: `This CREHQ approval expired or was already used (grant ${grant}, key crehq_live_leaked_value_9).`,
      data: { status: 403 },
    });
  const res = await callback(app, { pending: a.pendingId, grant }, `crehq_mcp_pending=${a.pendingId}`);
  const html = await res.text();
  check("exchange 403: message page, no redirect", res.status === 403 && !res.headers.get("location") && html.startsWith("<!doctype html>"));
  check("exchange 403: shows the returned message", html.includes("This CREHQ approval expired or was already used"));
  check(
    "exchange 403: never echoes grant, key-shaped strings, or the connect secret",
    !html.includes(grant) && !html.includes("crehq_live_") && !html.includes(CONNECT_SECRET) && html.includes("[redacted]"),
  );
  check("exchange 403: cookie kept (pending authorization still usable)", !res.headers.get("set-cookie"));

  const paste = await app.req(
    "/authorize/consent",
    form({ pending_id: a.pendingId, crehq_api_key: ISSUED_KEY }, { cookie: `crehq_mcp_pending=${a.pendingId}` }),
  );
  const pasteLoc = new URL(paste.headers.get("location") ?? ISSUER);
  check(
    "paste after failed sign-in: live-validated key -> 302 with code + state, cookie cleared",
    paste.status === 302 && pasteLoc.searchParams.has("code") && pasteLoc.searchParams.get("state") === a.state && isClearedCookie(paste),
  );
  const tokRes = await app.req(
    "/token",
    form({
      grant_type: "authorization_code",
      code: pasteLoc.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: a.clientId,
      code_verifier: a.verifier,
    }),
  );
  const tok = (await tokRes.json()) as JsonObject;
  check("paste: selfserve key -> read:locations token", tokRes.status === 200 && tok.scope === "read:locations");

  const badPaste = await callback(app, { pending: a.pendingId, grant }, `crehq_mcp_pending=${a.pendingId}`);
  check("paste consumed the pending id: later sign-in callback rejected", badPaste.status === 400 && !badPaste.headers.get("location"));
}

async function testAccessDenied(): Promise<void> {
  console.log("\n--- cancel at CREHQ -> access_denied ---");
  const app = makeApp(CONNECT_SECRET);
  const a = await startAuthorization(app);
  const before = exchangeCount();
  const res = await callback(app, { pending: a.pendingId, error: "access_denied" }, `crehq_mcp_pending=${a.pendingId}`);
  const loc = new URL(res.headers.get("location") ?? ISSUER);
  check("access_denied: 302 to the client's redirect_uri", res.status === 302 && `${loc.origin}${loc.pathname}` === REDIRECT_URI);
  check(
    "access_denied: error=access_denied + state, no code",
    loc.searchParams.get("error") === "access_denied" && loc.searchParams.get("state") === a.state && !loc.searchParams.has("code"),
  );
  check("access_denied: no exchange call, cookie cleared", exchangeCount() === before && isClearedCookie(res));
  const later = await callback(app, { pending: a.pendingId, grant: "grant_after_cancel_0001" }, `crehq_mcp_pending=${a.pendingId}`);
  check("access_denied: pending consumed (later grant for it rejected)", later.status === 400 && exchangeCount() === before);
}

async function testRawKeyBearer(): Promise<void> {
  console.log("\n--- raw crehq_live_ API key as /mcp bearer ---");
  const app = makeApp("");

  const before = upstream.length;
  const first = await listToolNames(app, RAW_SELFSERVE_KEY);
  const probes = upstream.slice(before);
  check("raw key: valid key accepted on /mcp", first.status === 200 && first.names.length > 0);
  check(
    "raw key: validated with the same /selfserve/usage probe",
    probes.length === 1 && probes[0].url.pathname.endsWith("/selfserve/usage") && probes[0].headers.get("x-api-key") === RAW_SELFSERVE_KEY,
  );
  check("raw key: selfserve catalog incl. the site + cohort tools", sameSet(first.names, SELFSERVE_CATALOG), `${first.names.length} tools`);

  const hash = await sha256Hex(RAW_SELFSERVE_KEY);
  const cachePut = app.store.puts.find((p) => p.key.endsWith(hash));
  check("raw key: validation cached under sha256(key) for 300 s", cachePut?.ttl === 300, cachePut?.key.replace(hash, "<sha256>"));
  check(
    "raw key: plaintext key never a KV key name or stored value",
    app.store.puts.every((p) => !p.key.includes(RAW_SELFSERVE_KEY) && !p.value.includes(RAW_SELFSERVE_KEY)),
  );
  const mid = upstream.length;
  const second = await listToolNames(app, RAW_SELFSERVE_KEY);
  check("raw key: second request served from cache (no re-probe)", second.status === 200 && upstream.length === mid);

  const callBefore = upstream.length;
  const result = await callTool(app, RAW_SELFSERVE_KEY, "crehq_site_selector_match", { sqft: 1200 });
  const sent = upstream.slice(callBefore);
  check(
    "raw key: tool call forwards the raw key upstream",
    result.isError === undefined && sent.length === 1 && sent[0].headers.get("x-api-key") === RAW_SELFSERVE_KEY,
  );

  const full = await listToolNames(app, RAW_FULL_KEY);
  check(
    "raw key: full-surface key also sees the 3 site tools (and full-only tools, no intel)",
    full.status === 200 && SITE_TOOLS.every((n) => full.names.includes(n)) && full.names.includes("crehq_company_get") && !full.names.includes("crehq_whitespace"),
    `${full.names.length} tools`,
  );

  const noAuth = await app.req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const challenge = noAuth.headers.get("www-authenticate") ?? "";
  const invalid = await mcp(app, RAW_INVALID_KEY, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const invalidBody = (await invalid.json()) as JsonObject;
  check("raw key: invalid key -> 401 JSON-RPC -32001", invalid.status === 401 && invalidBody.error?.code === -32001);
  check(
    "raw key: invalid key gets the same WWW-Authenticate challenge as no token",
    challenge.includes("resource_metadata=") && invalid.headers.get("www-authenticate") === challenge,
  );
  const invalidHash = await sha256Hex(RAW_INVALID_KEY);
  check("raw key: invalid key not cached", !app.store.puts.some((p) => p.key.endsWith(invalidHash)));

  const b = upstream.length;
  const garbage = await mcp(app, "not-an-oauth-token", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  check("bearer: unknown non-crehq_live_ token -> 401 with no upstream probe", garbage.status === 401 && upstream.length === b);
}

async function main(): Promise<void> {
  console.log("\n=== CREHQ Remote MCP — Sign in with CREHQ, raw-key bearer, site tools (offline) ===");
  try {
    await testConsentPage();
    await testSignInHappyPathAndReplay();
    await testCookieMismatch();
    await testExchangeForbiddenThenPaste();
    await testAccessDenied();
    await testRawKeyBearer();
    check("no request left the mocked CREHQ API base", upstream.every((c) => c.url.href.startsWith(`${API_BASE}/`)));
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
