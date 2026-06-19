# CREHQ hosted MCP connector handoff

Verified locally and deployed on 2026-06-18.

## Current state

- Local project: `/Users/markhubert/crehq-mcp-remote`
- Cloudflare Worker target: `crehq-mcp-remote`
- Transport: Streamable HTTP at `POST /mcp`
- Auth: OAuth 2.1 Authorization Code + PKCE S256, Dynamic Client Registration, refresh-token rotation
- Tool count: 26 CREHQ tools
- Basic scope: `read:locations`
- Premium scope: `read:intelligence`
- `npm run build` passes.
- `npm run test:oauth` passes 7/7 without a live key, proving discovery, DCR, PKCE handling, consent rendering, and live invalid-key rejection.
- Cloudflare auth is available as `mark@groundroof.com`.
- Worker deployed to `https://mcp.crehq.com` and `https://crehq-mcp-remote.mark-ef1.workers.dev`.
- Current deployed Worker version: `abba868d-9cf7-4356-a0f8-1665893ca1eb`.
- KV namespace ids are wired in `wrangler.toml`.
- Live smoke tests passed:
  - `GET https://mcp.crehq.com/health` -> `200`, 26 tools
  - `GET /.well-known/oauth-authorization-server` -> `200`
  - `GET /.well-known/oauth-protected-resource` -> `200`
  - unauthenticated `POST /mcp` -> `401` with `WWW-Authenticate` metadata pointer
  - `POST /register` -> `201` Dynamic Client Registration works
  - full deployed OAuth flow with a temporary sandbox key -> `200` token, scope `read:locations`
  - sandbox tool catalog -> 3 tools: `crehq_locations_list`, `crehq_locations_nearby`, `crehq_request_upgrade`
  - sandbox `crehq_locations_list` call with `brand=starbucks` -> live rows
  - sandbox `crehq_request_upgrade` call for FDD/franchise data -> upgrade prompt and self-serve intent logging

## Remaining go-live items

Mark must provide or approve:

1. Review key: provide a sandbox `crehq_live_...` key for live connector testing and directory reviewers.
2. Policy: decide which CREHQ API tiers get `read:intelligence`.

Recommended default policy:

- Free sandbox: `read:locations` only, with the catalog limited to sandbox-safe bounded location lookup tools plus `crehq_request_upgrade` for paywall prompts and upgrade-intent logging.
- Developer and Production: `read:locations`; keep high-volume downloads and production usage governed by existing API tier limits.
- Intel/Enterprise or explicit paid add-on: `read:intelligence` for `crehq_whitespace`, `crehq_co_tenancy`, `crehq_site_timeline`, and `crehq_company_occupancy`.

## Deployment record

The connector is deployed. Re-deploy with:

```bash
cd /Users/markhubert/crehq-mcp-remote
npm run build
npm run deploy
```

Smoke test:

```bash
curl -i https://mcp.crehq.com/health
curl -i https://mcp.crehq.com/.well-known/oauth-authorization-server
curl -i https://mcp.crehq.com/.well-known/oauth-protected-resource
curl -i -X POST https://mcp.crehq.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected unauthenticated `/mcp` result: `401` with a `WWW-Authenticate` header pointing to protected-resource metadata.

## Directory submission package

Use after `https://mcp.crehq.com/mcp` is live and smoke-tested.

### Name

CREHQ Location Intelligence

### Short description

Verified U.S. retail, franchise, and multi-unit location intelligence for AI agents.

### Long description

CREHQ gives AI agents authenticated access to verified location-intelligence data for retail, restaurant, franchise, banking, healthcare, auto, nonprofit, hotel, and other multi-unit brands. Agents can resolve brand identities, search current and historical storefronts, inspect FDD/franchise economics, pull real-estate/site-selection criteria, identify operator and development contacts, review lifecycle events, analyze site tenancy history, and use premium whitespace and co-tenancy intelligence where the user has the right CREHQ tier.

CREHQ data is license-controlled. Free sandbox keys expose limited read access for evaluation; paid API tiers govern production volume, downloads, and premium intelligence.

### Category

Data, real estate, retail analytics, franchise intelligence, location intelligence.

### MCP URL

```text
https://mcp.crehq.com/mcp
```

### OAuth

Supported. OAuth 2.1 Authorization Code + PKCE S256 with Dynamic Client Registration.

Discovery URLs:

```text
https://mcp.crehq.com/.well-known/oauth-authorization-server
https://mcp.crehq.com/.well-known/oauth-protected-resource
```

### Website and docs

```text
https://crehq.com/
https://crehq.com/developers/
https://crehq.com/developers/sandbox/
https://crehq.com/apis/
```

### Legal URLs

Verified live on 2026-06-18:

```text
https://crehq.com/privacy/
https://crehq.com/terms/
https://crehq.com/license-terms/
```

### Support contact

```text
admin@crehq.com
```

### Test credentials

Provide a sandbox `crehq_live_...` key minted from:

```text
https://crehq.com/developers/sandbox/
```

Do not put the key in public repository files. Give it only in the private reviewer form or dashboard.

## Listings after hosted deploy

- Anthropic connector directory: submit hosted MCP URL plus OAuth discovery, privacy, terms, and test key.
- `modelcontextprotocol/servers`: submit the stdio package or hosted connector metadata, depending on their current contribution format.
- mcp.so, Smithery, PulseMCP, Glama: submit hosted URL, category, summary, docs link, and legal URLs.

Before final submission, verify each directory's current form requirements. Directory requirements change faster than this repo.
