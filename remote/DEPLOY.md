# DEPLOY — CREHQ Remote MCP Server

This is a **deployed, locally-tested** build. It is live at:

- `https://mcp.crehq.com/mcp`
- `https://crehq-mcp-remote.mark-ef1.workers.dev/mcp`

Deployment record:

- Cloudflare Worker: `crehq-mcp-remote`
- Current deployed Worker version: `abba868d-9cf7-4356-a0f8-1665893ca1eb`
- KV namespace: wired in `wrangler.toml`
- Custom domain: `mcp.crehq.com`
- Deployed by: `mark@groundroof.com`

---

## 1. Platform choice & rationale

**Cloudflare Workers** (primary). Why:

- CREHQ is already entirely on Cloudflare (DNS, CDN, cache rules, beacon Worker). A Worker on the
  same account inherits the zone, TLS, and `mcp.crehq.com` DNS with no new vendor.
- Workers gives hosting **+** an OAuth-capable edge **+** a globally-replicated KV store for token
  state, in one deploy unit — exactly what a remote MCP connector needs.
- The MCP Streamable-HTTP transport is a single `POST` JSON endpoint, which maps cleanly onto a
  Worker `fetch` handler. No long-lived connections required (we use request/response JSON-RPC).
- Anthropic's connector directory expects a stable HTTPS MCP URL with OAuth 2.1 discovery — a Worker
  on a custom domain satisfies this directly.

> A plain Node service (Express/Fastify) would also work and the code supports it (`src/dev-server.ts`
> runs the identical router). But Workers is the recommended target because it bundles hosting + OAuth
> state + CREHQ's existing edge with the least new surface. Use the Node path only if you prefer to
> host on existing CREHQ VM infra (`sv1.groundroof.com`) behind nginx; in that case run
> `node dist/dev-server.js` under a process manager and put it behind TLS + the `mcp.crehq.com` proxy,
> and swap `MemoryStore` for a durable store (Redis/DB) so tokens survive restarts.

---

## 2. One-time setup

```bash
cd ~/crehq-mcp-remote
npm install
npx wrangler login           # authenticate to Mark's Cloudflare account

# Create the KV namespace that holds OAuth clients, codes, tokens, key mappings:
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create OAUTH_KV --preview
```

Paste the two returned ids into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "xxxxxxxx..."          # from `kv namespace create OAUTH_KV`
preview_id = "yyyyyyyy..."  # from `--preview`
```

This has already been completed for the live deployment. Keep these steps for rebuilds or if the
KV namespace is replaced.

Set the public issuer (the server's own URL) in `wrangler.toml [vars]`:

```toml
[vars]
ISSUER = "https://mcp.crehq.com"     # or the workers.dev URL if not using a custom domain
CREHQ_API_BASE = "https://crehq.com/wp-json/crehq/v1"
CREHQ_TIMEOUT_MS = "30000"
```

> **Do NOT** set `UNSAFE_SKIP_KEY_VALIDATION` in the deployed `[vars]`. It is a dev-only test flag.

---

## 3. DNS / custom domain (recommended)

In `wrangler.toml`, uncomment the route block:

```toml
[[routes]]
pattern = "mcp.crehq.com"
custom_domain = true
```

Because `crehq.com` is already on this Cloudflare account, `wrangler deploy` will provision the
`mcp.crehq.com` hostname and its TLS cert automatically. (If you skip this, the server is reachable at
`https://crehq-mcp-remote.<account>.workers.dev` and you set `ISSUER` to that URL instead.)

---

## 4. Deploy

```bash
npm run build        # typecheck (optional sanity; wrangler bundles src/ itself)
npm run deploy       # == wrangler deploy
```

Smoke-test the live deploy:

```bash
curl https://mcp.crehq.com/health
curl https://mcp.crehq.com/.well-known/oauth-authorization-server
curl https://mcp.crehq.com/.well-known/oauth-protected-resource
```

Current smoke-test status:

- `GET /health` returns `200` with `tools: 26`
- `GET /.well-known/oauth-authorization-server` returns `200`
- `GET /.well-known/oauth-protected-resource` returns `200`
- unauthenticated `POST /mcp` returns `401` with the expected OAuth metadata challenge
- full deployed OAuth flow with a temporary sandbox key returns a token with `read:locations`
- free sandbox key catalog is limited to `crehq_locations_list`, `crehq_locations_nearby`, and `crehq_request_upgrade`
- `crehq_locations_list` with `brand=starbucks` returns live rows through `/selfserve/locations`
- `crehq_request_upgrade` returns a paywall prompt and records upgrade intent for requests such as FDD/franchise data

---

## 5. OAuth endpoints (for reference / manual client config)

All relative to `ISSUER`:

| Purpose | Method | Path |
|---|---|---|
| AS metadata (RFC 8414) | GET | `/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | GET | `/.well-known/oauth-protected-resource` |
| Dynamic Client Registration (RFC 7591) | POST | `/register` |
| Authorize (code + PKCE S256) | GET | `/authorize` |
| Consent submit (links CREHQ key) | POST | `/authorize/consent` |
| Token (authorization_code, refresh_token) | POST | `/token` |
| MCP Streamable-HTTP | POST | `/mcp` |

Claude's connector performs **Dynamic Client Registration automatically** — you do not pre-register a
client. You only give Claude the **MCP URL** (`https://mcp.crehq.com/mcp`); it discovers the AS from
the `WWW-Authenticate` / protected-resource metadata and runs the rest.

---

## 6. The production CREHQ key bridge (PoC → live)

**PoC (what's built):** the consent screen asks the user to paste their `crehq_live_…` key. The server
validates it against the live API and derives scopes by probing a basic read and a premium endpoint.

**Production "Sign in with CREHQ" (recommended next step, ~half a day on the WP side):** replace the
paste step with a redirect to CREHQ's existing self-serve key system, which already exists and matches
this design 1:1:

- **Key store:** `xcrehqy_crehq_api_keys`. Secret of record is `key_hash` (SHA-256); `key_prefix` is
  the non-secret display hint; **scopes/tier live in the `permissions` JSON**, e.g.
  `{"scopes":["selfserve:read"],"tier":"free","monthly_quota":1000}`.
- **Issue a key:** `POST /wp-json/crehq/v1/selfserve/signup {"email":"..."}` →
  `CrehqSelfServeKeys::issue_free_key()` (`wp-content/mu-plugins/crehq-selfserve-lib/keys.php`) mints
  `crehq_live_<random>`, stores the hash + scoped `permissions`, and emails the plaintext once.
- **Auth + scope enforcement (already live):** `crehq-rest-auth-gate.php` /
  `CrehqSelfServeKeys::authenticate()` looks up by `key_hash` and returns `403` for invalid/revoked/
  expired keys (the exact 403 this connector surfaces). Scope enforcement is the "apiscope lockdown"
  (note the `.bak-apiscope-*` file) — so **the server already gates by `permissions.scopes`**.

**Bridge work to make it seamless:**
1. Add an OIDC-style login at CREHQ (or a small signed redirect) that, on success, **looks up or mints**
   a scoped key for the logged-in WP user and hands it back to this AS — so the user never sees/pastes a
   raw key.
2. Add a tiny authenticated endpoint, e.g. `GET /selfserve/usage` (already in the route namespace) or a
   new `GET /api-keys/introspect`, that returns the presented key's `permissions.scopes`. Then replace
   the probe-based scope derivation in `oauth.ts → validateCrehqKey()` with a direct read of those
   scopes (faster + authoritative). Map CREHQ scopes → MCP scopes:
   `selfserve:read`/basic tiers → `read:locations`; Intel/Enterprise tiers (or a `pack:*`/
   `read:intelligence` scope) → `read:intelligence`.
3. (Optional) Record the issued connector grant against the WP user for revocation/billing.

No WordPress change is required for the PoC to function — only to remove the paste step.

---

## 7. Submit to the Anthropic connector directory (+ others)

**Pre-reqs the directory checks:** public HTTPS MCP URL; OAuth 2.1 with discovery (this build has it);
a privacy policy + terms URL; clear tool descriptions (done); least-privilege scopes (done).

1. **Anthropic Connector Directory** — apply via the form linked from
   `https://www.anthropic.com/` developer/partners pages (the "Build a connector" / directory
   submission flow). Provide:
   - MCP server URL: `https://mcp.crehq.com/mcp`
   - OAuth: "supported, dynamic client registration" (point to the well-known discovery URL)
   - Name/description/icon, privacy policy (`https://crehq.com/privacy/`), terms.
   - Test credentials: a sandbox `crehq_live_…` key (mint one via `/selfserve/signup` to Mark's email).
2. **Verify in web Claude first:** Settings → Connectors → "Add custom connector" → paste
   `https://mcp.crehq.com/mcp` → complete the OAuth consent → confirm tools appear and a
   `crehq_companies_search` call returns rows. (This is the same flow the directory reviewers run.)
3. **mcp.so** — submit at `https://mcp.so/submit` (URL + description + category "data/real estate").
4. **Smithery** — `https://smithery.ai`; add a `smithery.yaml` describing the remote URL + OAuth, or
   submit via their dashboard. (Remote/hosted servers are listed without packaging.)
5. **PulseMCP** — `https://www.pulsemcp.com/submit` (server URL + metadata).

---

## 8. What Mark must provide / decide (go-live checklist)

| # | Decision / secret | Needed for |
|---|---|---|
| 1 | `wrangler login` to the CREHQ Cloudflare account | any deploy |
| 2 | Approve **`mcp.crehq.com`** as the connector hostname (or accept `*.workers.dev`) | DNS + `ISSUER` + directory |
| 3 | KV namespace ids (from step 2 commands) pasted into `wrangler.toml` | token storage |
| 4 | A **sandbox CREHQ key** (mint via `/selfserve/signup` to Mark's email) for directory reviewers + your own end-to-end test | directory submission + real-row verification |
| 5 | Privacy-policy + terms URLs (`https://crehq.com/privacy/`, `/terms/` — confirm they exist) | directory eligibility |
| 6 | Go/no-go on building **"Sign in with CREHQ"** (§6) to remove the key-paste step | seamless UX (optional for launch) |
| 7 | Tier→scope policy: which CREHQ tiers grant `read:intelligence` (whitespace/co-tenancy/timeline/occupancy) | scope mapping (§6.2) |
| 8 | (If self-serve API sales are gated — see project memory "HELD: P2 self-serve API") confirm it's OK to expose these tools publicly via the directory | business call |

Items 1–3 are done for the current deployment. Item 4 is still needed for private directory-review
testing with real data. Items 6–8 are policy/UX refinements, not blockers for a working connector.
