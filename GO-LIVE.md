# GO-LIVE checklist — shipping the CREHQ MCP server

This is a runnable proof-of-concept today. To turn it into a product CREHQ can
distribute, here's what's left, in order.

## 1. Keys & access (smallest lift, do first)
- [x] Confirm the self-serve sandbox flow emails a `crehq_live_…` key from the
      browser form. The signup route is Turnstile-gated in production, so direct
      unauthenticated cURL signup intentionally returns `403`.
      The key table (`xcrehqy_crehq_api_keys`) stores keys **hashed**
      (`key_prefix` + `key_hash`), so the plaintext is only seen once at issue.
- [ ] Decide the tier gate for MCP users (sandbox to try, paid for production).
      Premium tools (`crehq_whitespace`, `crehq_co_tenancy`, `crehq_site_timeline`)
      are Intel/Enterprise-only — make sure the API returns a clean 403 with an
      upgrade message for lower tiers (the server already surfaces that hint).
- [ ] Verify the documented endpoints all exist on prod with the exact paths
      this server uses (companies, locations, sites/timeline, intelligence,
      datasets, trends). `./test.sh` covers the read GETs; spot-check
      `/sites/{uid}/timeline`, `/intelligence/*`, `/companies/{id}/occupancy`.
- [ ] Keep the Modeled Site Profile tools staged until Mark approves publishing
      `/intelligence/site-profiles/*`; the local MCP catalog can advertise the
      tools, but production users should expect 404s until that route is live.

## 2. Hosting / distribution model — pick one (or do both)

**A. Local stdio (ship now).** Users run `node dist/index.js` from their own
machine with their key in env. Zero infra for CREHQ. This is the default and
what Claude Desktop / Cursor / Claude Code expect.
- [x] Publish to npm as `crehq-mcp-server` so users can
      `npx crehq-mcp-server` — no clone/build step.
- [x] Add CI that runs `npm run build` + `npm run typecheck`.
- [x] Tag future releases as `vX.Y.Z`; GitHub Actions publishes npm from tags
      or manual dispatch.

**B. Hosted / remote MCP server (scales to non-technical users & web Claude).**
Wrap the same tool handlers behind a Streamable-HTTP / SSE transport
(`@modelcontextprotocol/sdk` server with `StreamableHTTPServerTransport`) so
users add a URL instead of installing anything. This is required for the
Claude **connector directory** and for Claude.ai web/mobile.
- [x] Add an HTTP transport entrypoint alongside the stdio one.
- [x] Add OAuth 2.1 (the MCP authorization spec) or a hosted key-exchange so a
      user authorizes once and CREHQ maps the session → their API key, instead
      of pasting a raw key. This is the main net-new work for option B.
- [x] Deploy to Cloudflare Workers at `https://mcp.crehq.com`.
- [x] Add CI deploy workflow for `remote/` changes.

## 3. Listings / discovery
- [x] Add an `mcp` badge + "Connect to Claude" snippet to https://crehq.com/developers/.
- [x] Add MCP Registry ownership metadata (`mcpName`) and `server.json` for the
      current official registry path.
- [ ] **MCP Registry** — publish `io.github.groundroof/crehq-mcp-server` after
      `crehq-mcp-server@0.1.4` is live on npm. GitHub Actions can authenticate
      with OIDC.
- [ ] **Anthropic connector / MCP directory** — submit the hosted server (needs
      option B + OAuth). Highest-intent channel for Claude users.
- [ ] **`modelcontextprotocol/servers`** — no longer the community directory;
      it now points users to the MCP Registry. Keep this checked by verifying
      registry publication instead of opening a PR there.
- [ ] **mcp.so**, **Smithery**, **PulseMCP**, **Glama** — submit listings;
      Smithery can host/build the stdio server for users automatically.

## 4. Productizing & metered pricing (the business case)
The MCP server is a new, low-friction sales surface: an agent reads the tool
descriptions and pulls users into CREHQ data mid-conversation. Suggested
per-call metered tier on top of the existing $99/$1,500/$20k plans:
- [ ] **Free**: ~100 lookups/mo (maps to the sandbox key) — let agents try it.
- [ ] **Metered**: ~$20–$50 per 1,000 lookups for standard company/location reads.
- [ ] **Premium per-call**: higher unit price (or an add-on) for the
      differentiators — `whitespace`, `co-tenancy`, `site-timeline`,
      `occupancy` — since those are the unique, defensible answers.
- [ ] Meter on the existing `selfserve/usage` endpoint + `request_count` /
      `rate_limit_per_min` columns already on the key table; bill via Stripe.
- [ ] Track which tools convert (the descriptions are the sales copy) and
      iterate on wording.

## 5. Hardening before "production"
- [ ] Pin the SDK version and add a smoke test in CI that boots the server,
      lists tools, and asserts a known error shape (the repo already has the
      one-off harness used to verify this — promote it to a test).
- [ ] Add structured logging (stderr only — stdout is the protocol channel).
- [ ] Add a lightweight client-side cache/backoff for the cached intel
      endpoints (`X-CREHQ-Cache`, 6h TTL) to save quota.
- [ ] Confirm response shapes match the tool descriptions with a real key, and
      tighten any field docs that drift from production.
- [ ] Security review: never log the API key; redact it from any error output.

## Status of this artifact
- ✅ Builds & typechecks clean (`npm run build`, `npm run typecheck`).
- ✅ 29 tools, correct names/descriptions/JSON schemas, Zod-validated inputs.
- ⏳ Modeled Site Profile MCP tools are staged; production REST publication is
      intentionally held for approval.
- ✅ Verified end-to-end against the **live** API (real 403 + correct hint;
      MCP handshake, tool list, and validation all pass over stdio).
- ✅ Published to npm as `crehq-mcp-server`.
- ✅ Hosted remote MCP source is version-controlled in `remote/` and deployed
      to Cloudflare Workers.
- ⏳ Real data rows require a valid `CREHQ_API_KEY` / authorized remote session.
- ⛔ No production data was created or modified to build this.
