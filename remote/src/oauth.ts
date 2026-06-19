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
 *   `crehq_live_<key>`. After the user authenticates they reach the consent
 *   screen and LINK their CREHQ API key (pasted, or — in production — issued by
 *   "Sign in with CREHQ"). We validate that key against the live API, derive
 *   the granted scopes from it, and store the {access_token -> {key, scopes}}
 *   mapping. Tools then run with that user's own key + entitlements.
 *
 *   PRODUCTION BRIDGE (documented, not built here): replace the paste step with
 *   an OIDC/login redirect to CREHQ's WordPress that, on success, looks up or
 *   mints a scoped key in `xcrehqy_crehq_api_keys` (via `POST /selfserve/signup`
 *   or `POST /api-keys`) and returns it to this AS. The key's `permissions.scopes`
 *   JSON already drives tier gating server-side. See DEPLOY.md.
 *
 * SECURITY: tokens are opaque random strings; only their records (in the Store)
 * hold the CREHQ key. Auth codes are single-use and short-lived. PKCE is
 * mandatory. Secrets/keys are never logged. Redirect URIs are exact-matched.
 */
import {
  randomToken,
  sha256Hex,
  verifyPkce,
  timingSafeEqual,
} from "./crypto.js";
import type { Store } from "./storage.js";
import { ALL_SCOPES, SCOPE_BASIC } from "./tools.js";
import { CrehqClient } from "./client.js";

// --- TTLs --------------------------------------------------------------------
const AUTH_CODE_TTL = 300; // 5 min (OAuth 2.1 recommends <= 10 min)
const ACCESS_TOKEN_TTL = 3600; // 1 hour
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const PENDING_AUTH_TTL = 600; // consent-screen session

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
  apiSurface: "selfserve" | "full";
}

interface TokenRecord {
  crehqApiKey: string;
  scopes: string[];
  client_id: string;
  apiSurface: "selfserve" | "full";
}

// --- config ------------------------------------------------------------------
export interface OAuthConfig {
  /** Public base URL of this server, e.g. https://mcp.crehq.com (no trailing /). */
  issuer: string;
  /** CREHQ REST API base. */
  crehqApiBase: string;
  /** Per-request timeout for the key-validation probe. */
  timeoutMs: number;
  /**
   * TEST-ONLY: skip the live CREHQ key-validation probe during consent and
   * trust the pasted key as-is, granting the requested scopes. This exists so
   * the OAuth handshake + MCP transport mechanics can be exercised without a
   * real sandbox key. It is OFF by default and must NEVER be enabled in
   * production (the Worker entry never sets it). When on, the tool call still
   * proxies to the LIVE CREHQ API, so an invalid key yields a real 401 — which
   * is exactly the wiring proof we want.
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

  /**
   * Complete the consent step: the user supplied a CREHQ API key. Validate it
   * against the live CREHQ API, derive granted scopes, mint an auth code, and
   * return the redirect URL (back to the client with ?code=&state=).
   */
  async completeConsent(
    pendingId: string,
    crehqApiKey: string,
  ): Promise<{ ok: true; redirect: string } | { ok: false; message: string }> {
    const pending = await this.store.getJSON<PendingAuth>(P.pending(pendingId));
    if (!pending) {
      return { ok: false, message: "Your authorization session expired. Please restart the connection." };
    }
    const key = (crehqApiKey ?? "").trim();
    if (!key) {
      return { ok: false, message: "A CREHQ API key is required to authorize." };
    }

    // Validate the key against the LIVE CREHQ API (and derive entitlements).
    // TEST-ONLY bypass: trust the key and grant the requested scopes.
    const validation = this.cfg.unsafeSkipKeyValidation
      ? { valid: true as const, scopes: pending.scope.split(" ").filter(Boolean), apiSurface: "full" as const }
      : await this.validateCrehqKey(key);
    if (!validation.valid) {
      return { ok: false, message: validation.message };
    }

    // Granted scopes = intersection of requested scopes and what the key allows.
    const requested = pending.scope.split(" ").filter(Boolean);
    const grantedScopes = requested.filter((s) => validation.scopes.includes(s));
    if (grantedScopes.length === 0) {
      // Always grant basic if the key is valid at all (every key can read).
      grantedScopes.push(SCOPE_BASIC);
    }

    await this.store.del(P.pending(pendingId));

    const code = randomToken(32);
    const codeRec: AuthCodeRecord = { ...pending, crehqApiKey: key, grantedScopes, apiSurface: validation.apiSurface };
    await this.store.putJSON(P.code(await sha256Hex(code)), codeRec, AUTH_CODE_TTL);

    const url = new URL(pending.redirect_uri);
    url.searchParams.set("code", code);
    if (pending.state) url.searchParams.set("state", pending.state);
    return { ok: true, redirect: url.toString() };
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
    apiSurface: "selfserve" | "full",
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

  // === Bearer-token introspection (used by the /mcp handler) =================

  /** Resolve a bearer access token into its {key, scopes}. null if invalid. */
  async resolveAccessToken(token: string): Promise<{ crehqApiKey: string; scopes: string[]; apiSurface: "selfserve" | "full" } | null> {
    if (!token) return null;
    const rec = await this.store.getJSON<TokenRecord>(P.access(await sha256Hex(token)));
    if (!rec) return null;
    return { crehqApiKey: rec.crehqApiKey, scopes: rec.scopes, apiSurface: rec.apiSurface ?? "full" };
  }

  // === helpers ===============================================================

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
   *
   * Full-API heuristic for scope derivation:
   *   - A key that authorizes a basic read (200/404 on /companies/search) gets
   *     read:locations.
   *   - We then probe premium endpoints. Whitespace covers legacy intelligence
   *     packs; credit-signals covers the newer credit-intel pack. If either
   *     probe does NOT return 401/403, the key has premium intelligence access
   *     -> add read:intelligence. 401/403 on both means basic-only.
   *
   * PRODUCTION: replace this probe with reading the key's `permissions.scopes`
   * from `xcrehqy_crehq_api_keys` (server already enforces scopes), exposed via
   * a small authenticated `/api-keys/usage`-style endpoint that returns the
   * scope list for the presented key.
   */
  private async validateCrehqKey(
    key: string,
  ): Promise<
    | { valid: true; scopes: string[]; apiSurface: "selfserve" | "full" }
    | { valid: false; message: string }
  > {
    const client = new CrehqClient({ apiKey: key, apiBase: this.cfg.crehqApiBase, timeoutMs: this.cfg.timeoutMs });

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
    const scopes: string[] = [SCOPE_BASIC];

    // Step 3: detect the intelligence tier. One read:intelligence MCP scope
    // fronts multiple CREHQ pack scopes; accept any premium probe that passes.
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
    return { valid: true, scopes: Array.from(new Set(scopes)), apiSurface: "full" };
  }
}
