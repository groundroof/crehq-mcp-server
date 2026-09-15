/**
 * OAuth 2.1 Authorization Server for the CREHQ remote MCP connector.
 *
 * Implements the slice of OAuth that Claude's connector layer (and the wider
 * MCP remote-server spec) requires:
 *   - Authorization Server Metadata        (RFC 8414)
 *   - Protected Resource Metadata           (RFC 9728)
 *   - Dynamic Client Registration           (RFC 7591)  POST /register
 *   - Authorization Code + PKCE (S256)      (OAuth 2.1)  GET  /authorize
 *   - Token endpoint (code + refresh)       (OAuth 2.1)  POST /token
 *
 * KEY BRIDGING (the CREHQ part):
 *   The connector must ultimately call the CREHQ REST API with a
 *   `crehq_live_<key>`. The consent screen links a key to the pending
 *   authorization in one of two ways, which share ONE code path
 *   (`bindKeyToPending`):
 *     1. "Sign in with CREHQ" (primary): the user signs in on the CREHQ
 *        WordPress site (/mcp-connect/), approves, and is redirected back to
 *        /authorize/crehq-callback with a one-time grant. This server exchanges
 *        the grant for a key via an HMAC-signed server-to-server POST to
 *        `${CREHQ_API_BASE}/selfserve/mcp-connect/exchange`. Disabled (button hidden) when
 *        CREHQ_CONNECT_SECRET is empty.
 *     2. Paste an API key (secondary): validated against the live API.
 *   Either way we derive the granted scopes, mint a single-use auth code bound
 *   to the pending PKCE data, and store {access_token -> {key, scopes}}. Tools
 *   then run with that user's own key + entitlements.
 *
 *   /mcp also accepts a raw `crehq_live_` key as the bearer (coding tools that
 *   cannot run OAuth). It is validated with the same probe and the result is
 *   cached for 5 minutes under sha256(key) — never under the plaintext key.
 *
 * SECURITY: tokens are opaque random strings; only their records (in the Store)
 * hold the CREHQ key. Auth codes are single-use and short-lived. PKCE is
 * mandatory. Secrets/keys are never logged. Redirect URIs are exact-matched.
 */
import {
  hmacSha256Hex,
  randomToken,
  sha256Hex,
  verifyPkce,
  timingSafeEqual,
} from "./crypto.js";
import type { Store } from "./storage.js";
import { ALL_SCOPES, SCOPE_BASIC } from "./tools.js";
import { CrehqClient, DEFAULT_SITE_ORIGIN } from "./client.js";

// --- TTLs --------------------------------------------------------------------
const AUTH_CODE_TTL = 300; // 5 min (OAuth 2.1 recommends <= 10 min)
const ACCESS_TOKEN_TTL = 3600; // 1 hour
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
/** Consent-screen session. The crehq_mcp_pending cookie Max-Age matches this. */
export const PENDING_AUTH_TTL = 600;
/** How long a successful raw-API-key validation is trusted before re-probing. */
const RAW_KEY_CACHE_TTL = 300;

/** Prefix that marks a bearer token as a raw CREHQ API key rather than an OAuth token. */
const RAW_KEY_PREFIX = "crehq_live_";
/** Upper bound on a sign-in grant we will sign and forward. */
const MAX_GRANT_LENGTH = 512;

const SESSION_EXPIRED_MESSAGE = "Your authorization session expired. Please restart the connection from your AI app.";

export type ApiSurface = "selfserve" | "full";

// --- stored record shapes ----------------------------------------------------
export interface ClientRecord {
  client_id: string;
  /** Public clients (PKCE) have no secret; we support confidential too. */
  client_secret?: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  created_at: number;
}

interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
}

interface AuthCodeRecord extends PendingAuth {
  crehqApiKey: string;
  grantedScopes: string[];
  apiSurface: ApiSurface;
}

interface TokenRecord {
  crehqApiKey: string;
  scopes: string[];
  client_id: string;
  apiSurface: ApiSurface;
}

/** Cached raw-key validation. Deliberately holds NO key material. */
interface RawKeyRecord {
  scopes: string[];
  apiSurface: ApiSurface;
}

export interface ResolvedBearer {
  crehqApiKey: string;
  scopes: string[];
  apiSurface: ApiSurface;
}

/** A CREHQ key plus what it may do, ready to bind to a pending authorization. */
interface LinkedKey {
  crehqApiKey: string;
  allowedScopes: string[];
  apiSurface: ApiSurface;
}

type Failure = { ok: false; status: number; message: string };

/** Outcome of finishing (or refusing) a pending authorization. */
export type AuthorizationResult =
  | { ok: true; redirect: string }
  | (Failure & { /** true when the pending authorization no longer exists. */ expired?: boolean });

// --- config ------------------------------------------------------------------
export interface OAuthConfig {
  /** Public base URL of this server, e.g. https://mcp.crehq.com (no trailing /). */
  issuer: string;
  /** CREHQ REST API base. */
  crehqApiBase: string;
  /** Per-request timeout for the key-validation probe and the grant exchange. */
  timeoutMs: number;
  /** CREHQ WordPress origin hosting /mcp-connect/ (default https://crehq.com). */
  crehqSiteOrigin?: string;
  /**
   * Shared HMAC-SHA256 secret for the "Sign in with CREHQ" grant exchange.
   * Empty/unset disables sign-in: the button is hidden and the callback refuses.
   */
  crehqConnectSecret?: string;
  /**
   * TEST-ONLY: skip the live CREHQ key-validation probe during consent and
   * trust the pasted key as-is, granting the requested scopes. This exists so
   * the OAuth handshake + MCP transport mechanics can be exercised without a
   * real sandbox key. It is OFF by default and must NEVER be enabled in
   * production (the Worker entry never sets it). When on, the tool call still
   * proxies to the LIVE CREHQ API, so an invalid key yields a real 401 — which
   * is exactly the wiring proof we want. It does NOT affect raw-key bearers.
   */
  unsafeSkipKeyValidation?: boolean;
}

// --- prefixes ----------------------------------------------------------------
const P = {
  client: (id: string) => `oauth:client:${id}`,
  pending: (id: string) => `oauth:pending:${id}`,
  code: (hash: string) => `oauth:code:${hash}`,
  access: (hash: string) => `oauth:at:${hash}`,
  refresh: (hash: string) => `oauth:rt:${hash}`,
  rawKey: (hash: string) => `apikey:validated:${hash}`,
};

export class OAuthServer {
  constructor(
    private readonly store: Store,
    private readonly cfg: OAuthConfig,
  ) {}

  // === Discovery metadata ====================================================

  authorizationServerMetadata(): Record<string, unknown> {
    const i = this.cfg.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      scopes_supported: [...ALL_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: "https://crehq.com/developers/",
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    const i = this.cfg.issuer;
    return {
      resource: `${i}/mcp`,
      authorization_servers: [i],
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://crehq.com/developers/",
    };
  }

  // === Dynamic Client Registration (RFC 7591) ================================

  async registerClient(body: unknown): Promise<{ status: number; json: unknown }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const redirect_uris = Array.isArray(b.redirect_uris)
      ? (b.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (redirect_uris.length === 0) {
      return {
        status: 400,
        json: { error: "invalid_redirect_uri", error_description: "redirect_uris is required." },
      };
    }
    for (const uri of redirect_uris) {
      try {
        const u = new URL(uri);
        // OAuth 2.1: redirect URIs must be https (loopback http allowed for dev).
        const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
        if (u.protocol !== "https:" && !isLoopback) {
          return {
            status: 400,
            json: { error: "invalid_redirect_uri", error_description: `redirect_uri must be https: ${uri}` },
          };
        }
      } catch {
        return {
          status: 400,
          json: { error: "invalid_redirect_uri", error_description: `Malformed redirect_uri: ${uri}` },
        };
      }
    }

    const requestedAuth = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "none";
    const authMethod: ClientRecord["token_endpoint_auth_method"] =
      requestedAuth === "client_secret_post" || requestedAuth === "client_secret_basic" ? requestedAuth : "none";

    const client_id = `crehq-mcp-${randomToken(12)}`;
    const record: ClientRecord = {
      client_id,
      redirect_uris,
      client_name: typeof b.client_name === "string" ? b.client_name : undefined,
      token_endpoint_auth_method: authMethod,
      created_at: Date.now(),
    };
    if (authMethod !== "none") {
      record.client_secret = randomToken(32);
    }

    // Clients are durable; KV has no TTL here (omit ttl).
    await this.store.putJSON(P.client(client_id), record);

    const out: Record<string, unknown> = {
      client_id,
      redirect_uris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(record.created_at / 1000),
    };
    if (record.client_name) out.client_name = record.client_name;
    if (record.client_secret) out.client_secret = record.client_secret;
    return { status: 201, json: out };
  }

  // === Authorization endpoint (GET /authorize) ===============================

  /**
   * Validate an /authorize request and create a pending-auth session.
   * Returns the consent context to render, or an error to redirect/surface.
   */
  async beginAuthorize(query: URLSearchParams): Promise<
    | { ok: true; pendingId: string; clientName: string; scopes: string[] }
    | { ok: false; redirect?: string; status: number; message: string }
  > {
    const client_id = query.get("client_id") ?? "";
    const redirect_uri = query.get("redirect_uri") ?? "";
    const response_type = query.get("response_type") ?? "";
    const state = query.get("state") ?? "";
    const code_challenge = query.get("code_challenge") ?? "";
    const code_challenge_method = query.get("code_challenge_method") ?? "";
    const requestedScope = query.get("scope") ?? SCOPE_BASIC;

    const client = await this.store.getJSON<ClientRecord>(P.client(client_id));
    if (!client) {
      return { ok: false, status: 400, message: "Unknown client_id." };
    }
    // Exact redirect_uri match (no substring/prefix matching) per OAuth 2.1.
    if (!client.redirect_uris.includes(redirect_uri)) {
      return { ok: false, status: 400, message: "redirect_uri does not match a registered URI." };
    }
    // From here, errors can be redirected back to the client per OAuth 2.1.
    if (response_type !== "code") {
      return { ok: false, redirect: this.errRedirect(redirect_uri, state, "unsupported_response_type"), status: 302, message: "unsupported_response_type" };
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      return { ok: false, redirect: this.errRedirect(redirect_uri, state, "invalid_request", "PKCE S256 is required."), status: 302, message: "PKCE S256 required" };
    }

    const scopes = this.normalizeScopes(requestedScope);
    const pendingId = randomToken(18);
    const pending: PendingAuth = {
      client_id,
      redirect_uri,
      state,
      scope: scopes.join(" "),
      code_challenge,
      code_challenge_method,
    };
    await this.store.putJSON(P.pending(pendingId), pending, PENDING_AUTH_TTL);
    return { ok: true, pendingId, clientName: client.client_name ?? client_id, scopes };
  }

  /** Re-derive the consent-screen context for a still-pending authorization (null if gone). */
  async consentContext(pendingId: string): Promise<{ pendingId: string; clientName: string; scopes: string[] } | null> {
    const pending = await this.loadPending(pendingId);
    if (!pending) return null;
    const client = await this.store.getJSON<ClientRecord>(P.client(pending.client_id));
    return {
      pendingId,
      clientName: client?.client_name ?? pending.client_id,
      scopes: pending.scope.split(" ").filter(Boolean),
    };
  }

  /**
   * The CREHQ-hosted approval URL for a pending authorization, or null when
   * sign-in is disabled (no CREHQ_CONNECT_SECRET) so the page falls back to paste.
   */
  signInUrl(pendingId: string, clientName: string): string | null {
    if (!this.connectSecret()) return null;
    const origin = (this.cfg.crehqSiteOrigin || DEFAULT_SITE_ORIGIN).replace(/\/+$/, "");
    return `${origin}/mcp-connect/?pending=${encodeURIComponent(pendingId)}&client=${encodeURIComponent(clientName)}`;
  }

  /**
   * Paste path: the user supplied a CREHQ API key. Validate it against the live
   * CREHQ API, derive granted scopes, and finish via the shared bind path.
   */
  async completeConsent(pendingId: string, crehqApiKey: string): Promise<AuthorizationResult> {
    return this.bindKeyToPending(pendingId, async (pending) => {
      const key = (crehqApiKey ?? "").trim();
      if (!key) {
        return { ok: false, status: 400, message: "A CREHQ API key is required to authorize." };
      }
      // TEST-ONLY bypass: trust the key and grant the requested scopes.
      const validation = this.cfg.unsafeSkipKeyValidation
        ? { valid: true as const, scopes: pending.scope.split(" ").filter(Boolean), apiSurface: "full" as const }
        : await this.validateCrehqKey(key);
      if (!validation.valid) {
        return { ok: false, status: 400, message: validation.message };
      }
      return { ok: true, linked: { crehqApiKey: key, allowedScopes: validation.scopes, apiSurface: validation.apiSurface } };
    });
  }

  /**
   * Sign-in path: CREHQ WordPress redirected back with a one-time grant.
   * Exchange it (HMAC-signed) for a key, then finish via the shared bind path.
   */
  async completeCrehqSignIn(pendingId: string, grant: string): Promise<AuthorizationResult> {
    return this.bindKeyToPending(pendingId, async () => {
      const secret = this.connectSecret();
      if (!secret) {
        return {
          ok: false,
          status: 503,
          message: "Sign in with CREHQ is not enabled on this server. Go back and use an API key instead.",
        };
      }
      if (!grant || grant.length > MAX_GRANT_LENGTH) {
        return {
          ok: false,
          status: 400,
          message: "The CREHQ sign-in response was incomplete. Please restart the connection from your AI app.",
        };
      }
      const exchanged = await this.exchangeConnectGrant(secret, grant, pendingId);
      if (!exchanged.ok) return exchanged;
      const allowedScopes =
        exchanged.apiSurface === "selfserve" ? [SCOPE_BASIC] : await this.fullSurfaceScopes(this.keyClient(exchanged.key));
      return { ok: true, linked: { crehqApiKey: exchanged.key, allowedScopes, apiSurface: exchanged.apiSurface } };
    });
  }

  /** The user cancelled at CREHQ: consume the pending auth and send access_denied to the client. */
  async denyAuthorization(pendingId: string): Promise<AuthorizationResult> {
    const pending = await this.loadPending(pendingId);
    if (!pending) return { ok: false, status: 400, message: SESSION_EXPIRED_MESSAGE, expired: true };
    await this.store.del(P.pending(pendingId));
    return { ok: true, redirect: this.errRedirect(pending.redirect_uri, pending.state, "access_denied") };
  }

  /**
   * THE shared completion path for paste and sign-in: load the pending auth,
   * resolve a key for it, intersect scopes, consume the pending record, mint a
   * single-use code bound to the pending PKCE data, and build the redirect.
   * The pending record is only consumed on success, so a failed key check or
   * exchange leaves the consent screen usable.
   */
  private async bindKeyToPending(
    pendingId: string,
    resolveKey: (pending: PendingAuth) => Promise<{ ok: true; linked: LinkedKey } | Failure>,
  ): Promise<AuthorizationResult> {
    const pending = await this.loadPending(pendingId);
    if (!pending) return { ok: false, status: 400, message: SESSION_EXPIRED_MESSAGE, expired: true };

    const resolved = await resolveKey(pending);
    if (!resolved.ok) return resolved;
    const { crehqApiKey, allowedScopes, apiSurface } = resolved.linked;

    // Granted scopes = intersection of requested scopes and what the key allows.
    const requested = pending.scope.split(" ").filter(Boolean);
    const grantedScopes = requested.filter((s) => allowedScopes.includes(s));
    if (grantedScopes.length === 0) {
      // Always grant basic if the key is valid at all (every key can read).
      grantedScopes.push(SCOPE_BASIC);
    }

    await this.store.del(P.pending(pendingId));

    const code = randomToken(32);
    const codeRec: AuthCodeRecord = { ...pending, crehqApiKey, grantedScopes, apiSurface };
    await this.store.putJSON(P.code(await sha256Hex(code)), codeRec, AUTH_CODE_TTL);

    const url = new URL(pending.redirect_uri);
    url.searchParams.set("code", code);
    if (pending.state) url.searchParams.set("state", pending.state);
    return { ok: true, redirect: url.toString() };
  }

  /**
   * POST {"grant","pending"} to `${CREHQ_API_BASE}/selfserve/mcp-connect/exchange`, signed
   * with X-CREHQ-Connect-Timestamp + X-CREHQ-Connect-Signature =
   * hex(HMAC-SHA256(secret, `${ts}.${grant}.${pending}`)). Only HTTP 200 with a
   * `crehq_live_` key is success; anything else becomes a user-facing message
   * with secrets and key-like strings redacted.
   */
  private async exchangeConnectGrant(
    secret: string,
    grant: string,
    pending: string,
  ): Promise<{ ok: true; key: string; apiSurface: ApiSurface } | Failure> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmacSha256Hex(secret, `${timestamp}.${grant}.${pending}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    let body: unknown = null;
    try {
      res = await fetch(`${this.cfg.crehqApiBase}/selfserve/mcp-connect/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "crehq-mcp-remote/0.1.1",
          "X-CREHQ-Connect-Timestamp": timestamp,
          "X-CREHQ-Connect-Signature": signature,
        },
        body: JSON.stringify({ grant, pending }),
        // Never re-POST the grant to wherever a redirect points.
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
    } catch {
      return {
        ok: false,
        status: 502,
        message: "CREHQ could not be reached to finish sign-in. Please restart the connection from your AI app.",
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 200) {
      const message =
        safeExchangeMessage(body, [secret, grant]) ??
        `CREHQ did not approve this connection (HTTP ${res.status}). Please restart the connection from your AI app.`;
      const status = res.status === 401 || res.status === 403 ? 403 : res.status >= 400 && res.status < 500 ? 400 : 502;
      return { ok: false, status, message };
    }

    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const key = typeof rec.key === "string" ? rec.key.trim() : "";
    if (!key.startsWith(RAW_KEY_PREFIX) || key.length <= RAW_KEY_PREFIX.length) {
      return {
        ok: false,
        status: 502,
        message: "CREHQ returned an unexpected sign-in response. Please restart the connection from your AI app.",
      };
    }
    // Least privilege: anything other than an explicit "full" is the bounded surface.
    const apiSurface: ApiSurface = rec.api_surface === "full" ? "full" : "selfserve";
    return { ok: true, key, apiSurface };
  }

  // === Token endpoint (POST /token) ==========================================

  async token(
    params: URLSearchParams,
    authHeader: string | null,
  ): Promise<{ status: number; json: unknown }> {
    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      return this.exchangeCode(params, authHeader);
    }
    if (grantType === "refresh_token") {
      return this.refresh(params, authHeader);
    }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  }

  private async exchangeCode(
    params: URLSearchParams,
    authHeader: string | null,
  ): Promise<{ status: number; json: unknown }> {
    const code = params.get("code") ?? "";
    const redirect_uri = params.get("redirect_uri") ?? "";
    const code_verifier = params.get("code_verifier") ?? "";
    const clientAuth = await this.authenticateClient(params, authHeader);
    if (!clientAuth.ok) return { status: 401, json: { error: "invalid_client" } };

    const codeKey = P.code(await sha256Hex(code));
    const rec = await this.store.getJSON<AuthCodeRecord>(codeKey);
    if (!rec) return { status: 400, json: { error: "invalid_grant", error_description: "Auth code is invalid or expired." } };
    // Single-use: delete immediately (replay protection).
    await this.store.del(codeKey);

    if (rec.client_id !== clientAuth.client_id) {
      return { status: 400, json: { error: "invalid_grant", error_description: "Code was issued to another client." } };
    }
    if (rec.redirect_uri !== redirect_uri) {
      return { status: 400, json: { error: "invalid_grant", error_description: "redirect_uri mismatch." } };
    }
    const pkceOk = await verifyPkce(code_verifier, rec.code_challenge, rec.code_challenge_method);
    if (!pkceOk) {
      return { status: 400, json: { error: "invalid_grant", error_description: "PKCE verification failed." } };
    }

    return this.issueTokens(rec.client_id, rec.crehqApiKey, rec.grantedScopes, rec.apiSurface);
  }

  private async refresh(
    params: URLSearchParams,
    authHeader: string | null,
  ): Promise<{ status: number; json: unknown }> {
    const refresh_token = params.get("refresh_token") ?? "";
    const clientAuth = await this.authenticateClient(params, authHeader);
    if (!clientAuth.ok) return { status: 401, json: { error: "invalid_client" } };

    const rtKey = P.refresh(await sha256Hex(refresh_token));
    const rec = await this.store.getJSON<TokenRecord>(rtKey);
    if (!rec) return { status: 400, json: { error: "invalid_grant", error_description: "Refresh token invalid or expired." } };
    if (rec.client_id !== clientAuth.client_id) {
      return { status: 400, json: { error: "invalid_grant", error_description: "Refresh token belongs to another client." } };
    }
    // Rotate the refresh token (OAuth 2.1 best practice for public clients).
    await this.store.del(rtKey);
    return this.issueTokens(rec.client_id, rec.crehqApiKey, rec.scopes, rec.apiSurface);
  }

  private async issueTokens(
    client_id: string,
    crehqApiKey: string,
    scopes: string[],
    apiSurface: ApiSurface,
  ): Promise<{ status: number; json: unknown }> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const record: TokenRecord = { crehqApiKey, scopes, client_id, apiSurface };
    await this.store.putJSON(P.access(await sha256Hex(accessToken)), record, ACCESS_TOKEN_TTL);
    await this.store.putJSON(P.refresh(await sha256Hex(refreshToken)), record, REFRESH_TOKEN_TTL);
    return {
      status: 200,
      json: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL,
        refresh_token: refreshToken,
        scope: scopes.join(" "),
      },
    };
  }

  // === Bearer resolution (used by the /mcp handler) ==========================

  /** Resolve a bearer access token into its {key, scopes}. null if invalid. */
  async resolveAccessToken(token: string): Promise<ResolvedBearer | null> {
    if (!token) return null;
    const rec = await this.store.getJSON<TokenRecord>(P.access(await sha256Hex(token)));
    if (!rec) return null;
    return { crehqApiKey: rec.crehqApiKey, scopes: rec.scopes, apiSurface: rec.apiSurface ?? "full" };
  }

  /**
   * Resolve any /mcp bearer: an OAuth access token first; otherwise, if it looks
   * like a raw CREHQ API key, validate it (cached 300 s under sha256(key)).
   */
  async resolveBearer(token: string): Promise<ResolvedBearer | null> {
    const oauthToken = await this.resolveAccessToken(token);
    if (oauthToken) return oauthToken;
    return this.resolveRawApiKey(token);
  }

  private async resolveRawApiKey(token: string): Promise<ResolvedBearer | null> {
    if (!token.startsWith(RAW_KEY_PREFIX) || token.length <= RAW_KEY_PREFIX.length || token.length > 256) return null;
    const cacheKey = P.rawKey(await sha256Hex(token));
    const cached = await this.store.getJSON<RawKeyRecord>(cacheKey);
    if (cached) return { crehqApiKey: token, scopes: cached.scopes, apiSurface: cached.apiSurface };

    const validation = await this.validateCrehqKey(token);
    if (!validation.valid) return null;
    const record: RawKeyRecord = { scopes: validation.scopes, apiSurface: validation.apiSurface };
    await this.store.putJSON(cacheKey, record, RAW_KEY_CACHE_TTL);
    return { crehqApiKey: token, scopes: validation.scopes, apiSurface: validation.apiSurface };
  }

  // === helpers ===============================================================

  private connectSecret(): string {
    const secret = this.cfg.crehqConnectSecret ?? "";
    return secret.trim() ? secret : "";
  }

  private async loadPending(pendingId: string): Promise<PendingAuth | null> {
    if (!pendingId) return null;
    return this.store.getJSON<PendingAuth>(P.pending(pendingId));
  }

  private keyClient(key: string): CrehqClient {
    return new CrehqClient({ apiKey: key, apiBase: this.cfg.crehqApiBase, timeoutMs: this.cfg.timeoutMs });
  }

  private async authenticateClient(
    params: URLSearchParams,
    authHeader: string | null,
  ): Promise<{ ok: true; client_id: string } | { ok: false }> {
    // client_secret_basic
    let client_id = params.get("client_id") ?? "";
    let client_secret = params.get("client_secret") ?? "";
    if (authHeader?.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        const idx = decoded.indexOf(":");
        if (idx >= 0) {
          client_id = decodeURIComponent(decoded.slice(0, idx));
          client_secret = decodeURIComponent(decoded.slice(idx + 1));
        }
      } catch {
        return { ok: false };
      }
    }
    if (!client_id) return { ok: false };
    const client = await this.store.getJSON<ClientRecord>(P.client(client_id));
    if (!client) return { ok: false };

    if (client.token_endpoint_auth_method === "none") {
      // Public client (PKCE-protected); no secret check.
      return { ok: true, client_id };
    }
    if (!client.client_secret || !timingSafeEqual(client.client_secret, client_secret)) {
      return { ok: false };
    }
    return { ok: true, client_id };
  }

  private normalizeScopes(scopeParam: string): string[] {
    const requested = scopeParam.split(/\s+/).filter(Boolean);
    const valid = requested.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
    if (valid.length === 0) valid.push(SCOPE_BASIC);
    return Array.from(new Set(valid));
  }

  private errRedirect(redirect_uri: string, state: string, error: string, description?: string): string {
    const u = new URL(redirect_uri);
    u.searchParams.set("error", error);
    if (description) u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return u.toString();
  }

  /**
   * Validate a CREHQ API key against the live API and derive its scopes.
   *
   * Validation order:
   *   1. Try the self-serve key introspection endpoint first. Free sandbox keys
   *      are deliberately scoped to `/selfserve/*`, so probing `/companies/*`
   *      rejects valid sandbox keys. A successful `/selfserve/usage` proves the
   *      key is active and grants the basic MCP scope only.
   *   2. Fall back to the broader API probe for paid/admin keys that are not
   *      provisioned for the self-serve surface.
   *   3. `fullSurfaceScopes()` detects the intelligence tier for full keys.
   *
   * PRODUCTION: replace this probe with reading the key's `permissions.scopes`
   * from `xcrehqy_crehq_api_keys` (server already enforces scopes), exposed via
   * a small authenticated `/api-keys/usage`-style endpoint that returns the
   * scope list for the presented key.
   */
  private async validateCrehqKey(
    key: string,
  ): Promise<
    | { valid: true; scopes: string[]; apiSurface: ApiSurface }
    | { valid: false; message: string }
  > {
    const client = this.keyClient(key);

    // Step 1: sandbox/self-serve keys. These are valid CREHQ keys but are not
    // accepted by the broader enterprise API namespace.
    try {
      await client.request("/selfserve/usage");
      return { valid: true, scopes: [SCOPE_BASIC], apiSurface: "selfserve" };
    } catch (err) {
      const e = err as { status?: number };
      // 401/403 here may simply mean this is a paid/admin key without the
      // selfserve:read scope. Fall through and test the broader API surface.
      if (e.status !== 401 && e.status !== 403) {
        // Non-auth statuses still prove the key made it through auth.
        return { valid: true, scopes: [SCOPE_BASIC], apiSurface: "selfserve" };
      }
    }

    // Step 2: prove a paid/admin key is accepted with a cheap basic read.
    try {
      await client.request("/companies/search", { query: { q: "mcdonalds", per_page: 1 } });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401 || e.status === 403) {
        return {
          valid: false,
          message:
            "That CREHQ API key was not accepted (401/403). Check it is active, or get a free sandbox key at https://crehq.com/developers/sandbox/.",
        };
      }
      // Other statuses (e.g. 404/429/5xx) still prove the key authenticated.
    }
    return { valid: true, scopes: await this.fullSurfaceScopes(client), apiSurface: "full" };
  }

  /**
   * Scopes for a key already known to use the full API surface.
   *   - Every such key gets read:locations.
   *   - Whitespace covers legacy intelligence packs; credit-signals covers the
   *     newer credit-intel pack. If either probe does NOT return 401/403, the
   *     key has premium intelligence access -> add read:intelligence.
   */
  private async fullSurfaceScopes(client: CrehqClient): Promise<string[]> {
    const scopes: string[] = [SCOPE_BASIC];
    let hasIntelligence = false;
    try {
      await client.request("/intelligence/whitespace", { query: { company_id: "1", country: "US" } });
      hasIntelligence = true;
    } catch (err) {
      const e = err as { status?: number };
      // 403 = not entitled (basic only). 400/404/422/5xx = entitled but bad args.
      if (e.status !== 403 && e.status !== 401) {
        hasIntelligence = true;
      }
    }
    if (!hasIntelligence) {
      try {
        await client.request("/company/24734/credit-signals");
        hasIntelligence = true;
      } catch (err) {
        const e = err as { status?: number };
        if (e.status !== 403 && e.status !== 401) {
          hasIntelligence = true;
        }
      }
    }
    if (hasIntelligence) scopes.push("read:intelligence");
    return Array.from(new Set(scopes));
  }
}

/**
 * The exchange endpoint's `message`, made safe to show a user: single-line,
 * capped, with the connect secret / grant and any CREHQ-key-shaped string
 * redacted. HTML escaping happens in the page renderer.
 */
function safeExchangeMessage(body: unknown, secrets: string[]): string | null {
  const raw = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  if (typeof raw !== "string") return null;
  let message = raw.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret && secret.length >= 8) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/crehq_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]");
  if (message.length > 300) message = `${message.slice(0, 297)}...`;
  return message || null;
}
