# CREHQ MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns
[CREHQ](https://crehq.com)'s **live location-intelligence REST API** into native
tools for Claude and other AI agents. Ask an agent *"where should Chipotle open
next?"*, *"who has ever occupied this address?"*, *"what are Aspen Dental's
credit signals?"*, or *"what are Planet Fitness's franchise fees and where are they expanding?"* — and it can actually answer,
backed by CREHQ's canonical, **multi-source government-verified** database of
franchise & multi-unit brands, individual storefronts, FDD financials, credit signals, and
site-level tenancy history.

This is a thin wrapper over CREHQ's existing production API
(`https://crehq.com/wp-json/crehq/v1`). It does not store data or modify
anything server-side — it authenticates with your API key and forwards calls.

---

## What it exposes (28 tools)

**Companies / brands**
- `crehq_companies_list` — list brands, filter by category & expansion status
- `crehq_companies_search` — resolve a brand name → CREHQ company id (start here)
- `crehq_company_get` — canonical brand profile, verified unit count, ownership
- `crehq_company_credit_signals` — credit profile, sponsor/issuer context, ratings, capital structure
- `crehq_company_franchise` — FDD fees, royalties, investment, Item 19 figures
- `crehq_company_real_estate` — site-selection criteria & target geographies
- `crehq_company_contacts` — real-estate / development decision-maker contacts

**Locations**
- `crehq_locations_list` — store records by brand / state / category
- `crehq_location_get` — one location with full attributes & verification trace
- `crehq_locations_search` — fuzzy multi-field location search
- `crehq_locations_nearby` — radius search around a lat/lng (trade-area mapping)
- `crehq_locations_bulk` — bulk pull by id list, brand list, or GeoJSON polygon
- `crehq_locations_events` — cross-brand open/close/relocate lifecycle stream
- `crehq_location_history` — full event log for one physical store

**History & flagship differentiators**
- `crehq_company_changes` — date-bounded change feed for one brand
- `crehq_company_occupancy` — point-in-time roster (footprint on a past date)
- `crehq_site_timeline` — **every brand that ever occupied an address, over time**

**Premium intelligence** (Intel & Enterprise tiers)
- `crehq_whitespace` — markets where competitors are present but the brand isn't
- `crehq_co_tenancy` — which brands cluster near this brand's stores
- `crehq_location_site_profile` — CREHQ Modeled Site Profile for one location
- `crehq_company_site_pattern` — empirical brand site pattern from observed footprint/context
- `crehq_recent_location_context` — recent observed/opening rows with traffic, demographics, and coverage flags

Modeled Site Profile outputs must be described as **CREHQ-modeled from observed
location/context data**, not as company-stated site requirements unless the
response includes explicit stated-requirement provenance.

The Modeled Site Profile REST routes are staged pending explicit production
approval. Until those routes are published, these three tools may return a
`404` even though the MCP catalog advertises them for local testing.

**Datasets**
- `crehq_datasets_list` / `crehq_dataset_get` / `crehq_dataset_download` / `crehq_dataset_categories`

**Trends**
- `crehq_trends_company` — outlet/fee/financial time series for a brand
- `crehq_trends_geographic` — metro/state concentration & velocity

---

## Getting an API key

1. **Free sandbox** (1,000 calls/mo, 2 req/s, no credit card):
   https://crehq.com/developers/sandbox/ — enter your email and a key is
   emailed to you. Or request one via the API:
   ```bash
   curl -X POST "https://crehq.com/wp-json/crehq/v1/selfserve/signup" \
     -H "Content-Type: application/json" \
     -d '{"email":"you@example.com"}'
   ```
   The key is delivered by email only and looks like `crehq_live_xxxxxxxx…`.
2. **Paid tiers** — Developer from **$99/mo**, Production from **$1,500/mo**,
   Enterprise **$20k+/yr** (dedicated key, SLA, premium intel endpoints).
   See https://crehq.com/developers/ and https://crehq.com/apis/.

---

## Install & build

Requires Node.js ≥ 18.

Install the published stdio server with `npx`:

```bash
CREHQ_API_KEY=crehq_live_xxxxx npx crehq-mcp-server
```

Or build from source:

```bash
git clone <this-repo> crehq-mcp-server
cd crehq-mcp-server
npm install
npm run build          # compiles TypeScript → dist/
cp .env.example .env    # then edit .env and set CREHQ_API_KEY
```

Verify your key against the live API before wiring up a client:

```bash
export CREHQ_API_KEY=crehq_live_xxxxx
./test.sh               # exercises 6 read endpoints with curl
```

Run the server standalone (it speaks MCP over stdio, so it will wait for a
client on stdin — Ctrl-C to exit):

```bash
CREHQ_API_KEY=crehq_live_xxxxx node dist/index.js
```

---

## Connect to Claude Desktop

Add this to your `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "crehq": {
      "command": "node",
      "args": ["/absolute/path/to/crehq-mcp-server/dist/index.js"],
      "env": {
        "CREHQ_API_KEY": "crehq_live_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The CREHQ tools appear under the tools (🔌) menu.

### Other MCP clients

Any stdio-capable MCP client (Claude Code, Cursor, Cline, Continue, the
`mcp` CLI, custom `@modelcontextprotocol/sdk` clients, etc.) connects the same
way — run `node dist/index.js` as the server command with `CREHQ_API_KEY` in
the environment.

**Claude Code:**
```bash
claude mcp add crehq --env CREHQ_API_KEY=crehq_live_xxxxx -- npx crehq-mcp-server
```

## Hosted remote connector

The hosted Cloudflare Worker version is kept in `remote/`. It provides the
same CREHQ connector as a remote MCP server at `https://mcp.crehq.com`, with
OAuth/key exchange and scope gating for premium tools. Its own deploy notes are
in `remote/DEPLOY.md` and connector-submission copy is in
`remote/CONNECTOR-SUBMISSION.md`.

## Maintainer workflow

GitHub Actions owns the repeatable release path:

- `CI` builds and tests the stdio package and the hosted Worker on every push.
- `Deploy Remote MCP` deploys `remote/` changes to Cloudflare Workers and then
  verifies `https://mcp.crehq.com/health`.
- `Publish npm` publishes the stdio package from a `vX.Y.Z` tag or manual
  workflow dispatch. It skips safely when that package version already exists.

Required repository secrets are already named:

- `NPM_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

---

## Configuration

| Env var            | Required | Default                                      | Purpose                              |
|--------------------|----------|----------------------------------------------|--------------------------------------|
| `CREHQ_API_KEY`    | yes      | —                                            | Your `crehq_live_…` key              |
| `CREHQ_API_BASE`   | no       | `https://crehq.com/wp-json/crehq/v1`         | Override API base (staging/proxy)    |
| `CREHQ_TIMEOUT_MS` | no       | `30000`                                      | Per-request timeout in ms            |

---

## Error handling

Tools never crash the agent's turn — failures come back as a readable message
with a fix-it hint:

- **No key set** → instructs you to set `CREHQ_API_KEY` and links the sandbox.
- **401 / 403** → "invalid or revoked key / endpoint not in your tier" + upgrade link.
- **404** → "check the id/slug; resolve it with a search tool first."
- **429** → respects `Retry-After`; reminds you of the free-tier 2 req/s limit.
- **5xx / timeout / network** → transient-error guidance to retry with backoff.

Pagination, cache, and stream cursors (`X-WP-Total`, `X-CREHQ-Next-Since`,
`X-CREHQ-Cache`, rate-limit headers) are surfaced in a `response metadata`
footer on each result so the agent can paginate and poll correctly.

---

## Note on testing

The build, typecheck, MCP protocol handshake, tool catalog, argument
validation, and the full HTTP request/response/error pipeline are verified
end-to-end against the **live** production API (a real request returns a real
`403 Invalid or revoked API key` with the correct hint). Fetching real data
rows requires a valid key — the sandbox key is delivered by email, so set
`CREHQ_API_KEY` and run `./test.sh` to confirm live data responses.

---

## License

MIT. CREHQ data is licensed separately per your API tier/contract.
