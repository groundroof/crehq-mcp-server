/**
 * Platform-agnostic HTTP router (Fetch API: Request -> Response).
 *
 * The same `handleRequest` runs inside a Cloudflare Worker `fetch` handler and
 * inside the local Node dev server (which adapts node:http <-> Fetch). It wires:
 *   - OAuth 2.1 discovery, registration, authorize, consent, token
 *   - "Sign in with CREHQ" callback (/authorize/crehq-callback)
 *   - The bearer-gated MCP Streamable-HTTP endpoint (/mcp)
 *   - A health check and a tiny landing page.
 *
 * The `/mcp` endpoint requires a valid OAuth access token or a raw CREHQ API
 * key; missing/invalid credentials get a 401 with a WWW-Authenticate challenge
 * that points at the protected-resource metadata (per RFC 9728 / the MCP auth
 * spec), which is how Claude's connector discovers the authorization server.
 */
import { OAuthServer, PENDING_AUTH_TTL, type OAuthConfig } from "./oauth.js";
import type { Store } from "./storage.js";
import { consentPage, messagePage } from "./consent.js";
import { handleRpc, type JsonRpcRequest, type McpSession } from "./mcp.js";
import { TOOLS } from "./tools.js";
import { timingSafeEqual } from "./crypto.js";

export interface AppConfig extends OAuthConfig {}

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
  "access-control-max-age": "86400",
};
/** Authorization-flow pages carry one-time identifiers: never cache, never leak via Referer. */
const AUTH_PAGE_HEADERS: Record<string, string> = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

/** Binds the browser that saw the consent page to the sign-in callback. */
export const PENDING_COOKIE = "crehq_mcp_pending";
const RESTART_MESSAGE = "Please restart the connection from your AI app.";

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extra } });
}
function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...HTML_HEADERS, ...CORS_HEADERS, ...extra } });
}
/** 302 with mutable headers (Response.redirect's headers are immutable in Workers). */
function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...AUTH_PAGE_HEADERS, ...extra } });
}

function pendingCookie(pendingId: string): string {
  return `${PENDING_COOKIE}=${pendingId}; Path=/authorize; Secure; HttpOnly; SameSite=Lax; Max-Age=${PENDING_AUTH_TTL}`;
}
function clearPendingCookie(): string {
  return `${PENDING_COOKIE}=; Path=/authorize; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

export async function handleRequest(req: Request, store: Store, cfg: AppConfig): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const oauth = new OAuthServer(store, cfg);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // --- Discovery ------------------------------------------------------------
  if (path === "/.well-known/oauth-authorization-server") {
    return json(oauth.authorizationServerMetadata());
  }
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    return json(oauth.protectedResourceMetadata());
  }
  // Some clients probe the OIDC discovery doc; reuse the AS metadata shape.
  if (path === "/.well-known/openid-configuration") {
    return json(oauth.authorizationServerMetadata());
  }

  // --- Dynamic Client Registration -----------------------------------------
  if (path === "/register" && req.method === "POST") {
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request", error_description: "Body must be JSON." }, 400);
    }
    const { status, json: out } = await oauth.registerClient(body);
    return json(out, status);
  }

  // --- Authorization endpoint ----------------------------------------------
  if (path === "/authorize" && req.method === "GET") {
    const r = await oauth.beginAuthorize(url.searchParams);
    if (r.ok) {
      return html(
        consentPage({
          pendingId: r.pendingId,
          clientName: r.clientName,
          scopes: r.scopes,
          signInUrl: oauth.signInUrl(r.pendingId, r.clientName),
        }),
        200,
        { ...AUTH_PAGE_HEADERS, "set-cookie": pendingCookie(r.pendingId) },
      );
    }
    if (r.redirect) {
      return Response.redirect(r.redirect, 302);
    }
    return html(messagePage("Authorization error", r.message), r.status);
  }

  // --- "Sign in with CREHQ" callback -----------------------------------------
  if (path === "/authorize/crehq-callback" && req.method === "GET") {
    return handleCrehqCallback(req, url, oauth);
  }

  // --- Consent submission (paste an API key) --------------------------------
  if (path === "/authorize/consent" && req.method === "POST") {
    const form = await readForm(req);
    const pendingId = form.get("pending_id") ?? "";
    const apiKey = form.get("crehq_api_key") ?? "";
    const r = await oauth.completeConsent(pendingId, apiKey);
    if (r.ok) {
      // Only clear the cookie if it belongs to THIS authorization (another tab may own it).
      const ownsCookie = pendingId !== "" && readCookie(req, PENDING_COOKIE) === pendingId;
      return redirect(r.redirect, ownsCookie ? { "set-cookie": clearPendingCookie() } : {});
    }
    // Re-render consent with the error if the pending authorization still exists.
    const ctx = await oauth.consentContext(pendingId);
    if (ctx) {
      return html(
        consentPage({ ...ctx, signInUrl: oauth.signInUrl(ctx.pendingId, ctx.clientName), error: r.message }),
        400,
        AUTH_PAGE_HEADERS,
      );
    }
    return html(messagePage("Authorization error", r.message), 400, AUTH_PAGE_HEADERS);
  }

  // --- Token endpoint -------------------------------------------------------
  if (path === "/token" && req.method === "POST") {
    const params = await readForm(req);
    const { status, json: out } = await oauth.token(params, req.headers.get("authorization"));
    // Token responses must not be cached.
    return json(out, status, { "cache-control": "no-store", pragma: "no-cache" });
  }

  // --- MCP Streamable-HTTP endpoint -----------------------------------------
  if (path === "/mcp") {
    return handleMcp(req, oauth, cfg);
  }

  // --- Health + landing -----------------------------------------------------
  if (path === "/health") {
    return json({ status: "ok", server: "crehq-mcp-remote", tools: TOOLS.length });
  }
  if (path === "/") {
    return html(
      messagePage(
        "CREHQ Remote MCP Server",
        `Streamable-HTTP MCP endpoint at /mcp (OAuth 2.1 required). ${TOOLS.length} CREHQ location-intelligence tools. See https://crehq.com/developers/.`,
      ),
    );
  }

  return json({ error: "not_found" }, 404);
}

// --- Sign in with CREHQ callback ----------------------------------------------

/**
 * GET /authorize/crehq-callback?pending=<id>&grant=<grant>   (approved)
 * GET /authorize/crehq-callback?pending=<id>&error=...       (cancelled)
 *
 * 1. The crehq_mcp_pending cookie must equal `pending` (same browser that saw
 *    the consent page), else a restart message.
 * 2. The pending authorization must still exist, else a message page.
 * 3. `error` present -> redirect to the client with error=access_denied.
 * 4. Otherwise exchange the grant and finish exactly like the paste path.
 */
async function handleCrehqCallback(req: Request, url: URL, oauth: OAuthServer): Promise<Response> {
  const pendingId = url.searchParams.get("pending") ?? "";
  const cookieValue = readCookie(req, PENDING_COOKIE);
  if (!pendingId || !cookieValue || !timingSafeEqual(cookieValue, pendingId)) {
    return html(messagePage("Connection not recognized", RESTART_MESSAGE), 400, AUTH_PAGE_HEADERS);
  }
  const clearCookie = { "set-cookie": clearPendingCookie() };

  if (url.searchParams.has("error")) {
    const denied = await oauth.denyAuthorization(pendingId);
    if (denied.ok) return redirect(denied.redirect, clearCookie);
    return html(messagePage("Authorization expired", denied.message), denied.status, { ...AUTH_PAGE_HEADERS, ...clearCookie });
  }

  const r = await oauth.completeCrehqSignIn(pendingId, url.searchParams.get("grant") ?? "");
  if (r.ok) return redirect(r.redirect, clearCookie);
  if (r.expired) {
    return html(messagePage("Authorization expired", r.message), r.status, { ...AUTH_PAGE_HEADERS, ...clearCookie });
  }
  // The pending authorization is still valid, so keep the cookie: the user can
  // go back to the consent page and retry or use an API key instead.
  return html(messagePage("CREHQ sign-in was not completed", r.message), r.status, AUTH_PAGE_HEADERS);
}

// --- MCP handling ------------------------------------------------------------

async function handleMcp(req: Request, oauth: OAuthServer, cfg: AppConfig): Promise<Response> {
  // GET = client wants to open a server->client SSE stream. We have no
  // server-initiated messages, so 405 (spec-allowed).
  if (req.method === "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, allow: "POST, OPTIONS" },
    });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...CORS_HEADERS, allow: "POST, OPTIONS" } });
  }

  // --- Bearer auth ----------------------------------------------------------
  // OAuth access token first; a raw `crehq_live_` API key is accepted when no
  // OAuth token record matches (coding tools that cannot run OAuth).
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const resolved = token ? await oauth.resolveBearer(token) : null;
  if (!resolved) {
    // RFC 9728: point the client at the protected-resource metadata so it can
    // discover the authorization server and start the OAuth flow.
    const challenge = `Bearer realm="CREHQ MCP", resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource"`;
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized: a valid OAuth access token is required." },
      },
      401,
      { "www-authenticate": challenge },
    );
  }

  const session: McpSession = {
    crehqApiKey: resolved.crehqApiKey,
    scopes: resolved.scopes,
    apiSurface: resolved.apiSurface,
    clientOptions: { apiBase: cfg.crehqApiBase, timeoutMs: cfg.timeoutMs },
  };

  // Parse the JSON-RPC body. Support a single message or a batch array.
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400);
  }

  if (Array.isArray(payload)) {
    const responses: unknown[] = [];
    for (const item of payload) {
      const r = await handleRpc(item as JsonRpcRequest, session);
      if (r) responses.push(r);
    }
    // If every message was a notification, return 202 with no body.
    if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(responses);
  }

  const response = await handleRpc(payload as JsonRpcRequest, session);
  if (!response) {
    // Notification: ack with 202 and no body.
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return json(response);
}

// --- form parsing (application/x-www-form-urlencoded or JSON) ----------------

async function readForm(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) p.set(k, String(v));
      return p;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}
