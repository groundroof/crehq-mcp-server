# CREHQ Remote MCP Server

A **hosted, remote** [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
CREHQ's location-intelligence REST API (`https://crehq.com/wp-json/crehq/v1`) as 26 native AI-agent
tools — over the **Streamable-HTTP** transport, gated by **OAuth 2.1** (authorization code + PKCE).

Unlike the stdio package (`crehq-mcp-server`, for local Claude Desktop), this server is built to be
**hosted on a public URL** so it can be added inside **web Claude** (Settings → Connectors) and
submitted to **Anthropic's connector directory**, mcp.so, Smithery, and PulseMCP.

> Deploy target: **Cloudflare Workers** (primary). Also runs as a plain Node dev server for local
> testing. See [`DEPLOY.md`](./DEPLOY.md).

---

## What it does

- **Transport:** MCP Streamable-HTTP at `POST /mcp` (single JSON-RPC endpoint; spec rev `2025-03-26`).
- **Auth:** a self-contained OAuth 2.1 Authorization Server with:
  - Authorization-Server Metadata (RFC 8414) + Protected-Resource Metadata (RFC 9728)
  - Dynamic Client Registration (RFC 7591) — required by Claude's connector
  - Authorization Code + **PKCE (S256, mandatory)**, refresh tokens with rotation
  - `WWW-Authenticate` challenge on `/mcp` pointing at the resource metadata (the discovery handshake)
- **Per-user CREHQ key bridging:** after the user authorizes, they link a CREHQ API key
  (`crehq_live_…`). The key is validated against the live CREHQ API, its tier/scopes are derived,
  and a `{access_token → {key, scopes}}` mapping is stored. Every tool call then runs with **that
  user's own key and entitlements**.
- **Scope / tier gating:**
  - `read:locations` — companies, locations, datasets, trends, FDD, contacts (21 tools)
  - `read:intelligence` — premium: whitespace, co-tenancy, site-timeline, point-in-time occupancy
  - Premium tools are hidden from `tools/list` and return a clean **upgrade message** if a
    basic-scoped token tries to call them.

## The 26 tools

Companies/brands (6) · Locations (7) · Changes/Occupancy/Site-Timeline (3) · Intelligence (2) ·
Datasets (4) · Trends (2). Tool names and descriptions are identical to the stdio package; see
[`src/tools.ts`](./src/tools.ts). Premium (intel-scoped): `crehq_company_credit_signals`, `crehq_whitespace`, `crehq_co_tenancy`,
`crehq_site_timeline`, `crehq_company_occupancy`.

## Architecture

```
src/
  worker.ts      Cloudflare Worker entry (KV-backed) — PRIMARY deploy target
  dev-server.ts  Node http <-> Fetch adapter (in-memory store) — local dev/testing
  router.ts      Platform-agnostic Fetch router: OAuth endpoints + /mcp (used by BOTH entries)
  oauth.ts       OAuth 2.1 AS: discovery, DCR, /authorize, /token, PKCE, refresh, key bridging
  consent.ts     Server-rendered consent screen (link your CREHQ key)
  mcp.ts         MCP JSON-RPC handler (initialize / tools/list / tools/call) + tier gating
  tools.ts       The 26 CREHQ tool definitions (+ requiredScope)
  client.ts      CREHQ REST client (per-request key; Fetch-based; runs in Workers + Node)
  crypto.ts      Web Crypto helpers (random tokens, SHA-256, PKCE S256 verify)
  storage.ts     Store interface: KvStore (Workers KV) | MemoryStore (local)
  format.ts      Result/error/upgrade-message formatting
test/
  oauth-flow.test.ts  Real-key path (proves live validation; 7 checks)
  full-flow.test.ts   Full mechanics incl. token issuance + MCP transport (17 checks)
```

The same `handleRequest(req, store, cfg)` runs in the Worker and in Node — only the storage backend
(KV vs in-memory) and the issuer differ.

## Run it locally

### Option A — Cloudflare runtime (closest to production)
```bash
npm install
npx wrangler dev --port 8787 --local --var ISSUER:http://localhost:8787
curl http://localhost:8787/health
```

### Option B — plain Node dev server (no Cloudflare needed)
```bash
npm install
npm run dev        # builds, then serves on http://localhost:8787
```

### Tests
```bash
npm run typecheck            # clean
npm run test:oauth           # OAuth handshake + live key validation (7 checks)
node dist/test/full-flow.test.js   # full token + MCP transport mechanics (17 checks)
```

With a real key:
```bash
CREHQ_TEST_API_KEY=crehq_live_xxx node dist/test/oauth-flow.test.js   # fetches real rows
```

## How it was tested (local)

Verified end-to-end against the **live CREHQ API** in both the Node harness and the real Cloudflare
`workerd` runtime (via `wrangler dev`):

1. Discovery docs (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`)
2. Dynamic Client Registration → `client_id`
3. PKCE S256 `/authorize` → consent page; non-S256 PKCE rejected
4. Consent links the CREHQ key → validated against the **live API** → `?code=` redirect
5. `/token` (code + verifier) → `access_token` + `refresh_token`; wrong verifier → `invalid_grant`;
   code is single-use (replay rejected); refresh grant rotates the token
6. `/mcp` without Bearer → **401 + `WWW-Authenticate`** (resource_metadata)
7. `initialize` → serverInfo; `tools/list` → scope-filtered (21 basic / 26 with intel)
8. `tools/call crehq_companies_search` → **proxied to the live CREHQ API**
9. Premium tool with a basic token → clean upgrade message (no API call)

A valid CREHQ key is required for *real rows*; with a dummy key the live API returns a genuine
**HTTP 403**, which proves the request reached `crehq.com` with the per-user key. The 26-tool catalog
and every OAuth/MCP layer are verified independently of any key.

## Security notes

- API keys live only in the token store (Workers KV, encrypted at rest); they are **never logged**
  and never returned to the MCP client.
- Tokens are opaque random strings (revocable); auth codes are single-use, 5-min TTL; PKCE S256 is
  mandatory; redirect URIs are exact-matched; refresh tokens rotate.
- `UNSAFE_SKIP_KEY_VALIDATION` is a **dev-only** flag (it skips live key validation for testing). The
  production Worker config must never set it. See `DEPLOY.md`.
