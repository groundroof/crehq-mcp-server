/**
 * Guidance pass-through contract for self-serve keys (hosted server).
 *
 * The CREHQ self-serve API explains its own limits in its responses: row
 * budgets, coverage notes, the full-dataset offer, upgrade/enterprise links,
 * brand suggestions, market scope and Enhanced (D2) preview labels. These
 * tests replay REAL bodies captured from the live API on 2026-09-15 with an
 * internal sandbox key (revoked afterwards; the key is not in the fixtures)
 * through the MCP tools/call path and check the agent-visible text.
 *
 * PRINT_SAMPLES=1 prints the formatted text for a few cases.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleRpc, type McpSession } from "../src/mcp.js";
import { ok } from "../src/format.js";

interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const FIXTURES = new URL("../../test/fixtures/selfserve/", import.meta.url);
const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Fixture;

const session: McpSession = {
  crehqApiKey: "crehq_live_guidance_test",
  scopes: ["read:locations"],
  apiSurface: "selfserve",
  clientOptions: {
    apiBase: "https://api.example.test/wp-json/crehq/v1",
    timeoutMs: 1_000,
  },
};

let current: Fixture | undefined;
let lastUrl: URL | undefined;
let rpcId = 0;
const samples: Record<string, string> = {};

async function callTool(
  name: string,
  args: Record<string, unknown>,
  fixtureName: string,
): Promise<{ text: string; isError: boolean }> {
  current = loadFixture(fixtureName);
  const response = await handleRpc(
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  assert.ok(response && response.result && typeof response.result === "object", `${fixtureName}: tools/call returned a result`);
  const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = result.content?.[0]?.text ?? "";
  samples[fixtureName] = text;
  return { text, isError: result.isError === true };
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    lastUrl = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(current, "a fixture is loaded before each call");
    return new Response(JSON.stringify(current.body), {
      status: current.status,
      headers: { "content-type": "application/json", ...current.headers },
    });
  };

  // ---- errors ---------------------------------------------------------------
  const notFound = await callTool("crehq_locations_list", { brand: "plannet-fitnes", per_page: 1 }, "err_brand_not_found");
  assert.equal(notFound.isError, true);
  assert.match(notFound.text, /HTTP 404, brand_not_found\): No CREHQ brand matches "plannet-fitnes"\. Did you mean: planet-fitness \(Planet Fitness\)\?/);
  assert.match(notFound.text, /did_you_mean \(retry with brand=\): planet-fitness/);
  assert.match(notFound.text, /api_hint: Try a slug from the data-store catalog/);
  assert.match(notFound.text, /Suggestion: If a did_you_mean slug is what the user meant/);
  assert.doesNotMatch(notFound.text, /Not found: the requested record/);

  const budget = await callTool("crehq_locations_list", { brand: "cashland", per_page: 5 }, "err_row_budget_exhausted");
  assert.equal(budget.isError, true);
  assert.match(budget.text, /HTTP 403, row_budget_exhausted\): This key has received its 1 rows for Cashland this month/);
  assert.match(
    budget.text,
    /row_budget: this brand 1 of 1 rows used this month \(limit: 10% of 10 locations \(max 50\)\); all brands \d[\d,]* of 1,000 rows; resets 2026-10-01T00:00:00Z/,
  );
  assert.match(budget.text, /full_dataset: Cashland \(\$79, D1, scope full, 10 locations\) https:\/\/crehq\.com\/data-store\/cashland\//);
  assert.match(budget.text, /upgrade_url: https:\/\/crehq\.com\//);
  assert.match(budget.text, /Suggestion: Rows per brand are limited monthly/);
  assert.match(budget.text, /For competition access, use included aggregate tools/);
  assert.match(budget.text, /do not ask students to purchase their grant/);
  assert.doesNotMatch(budget.text, /api-keys/, "row budget errors no longer get the generic tier-upgrade hint");

  const selectorCap = await callTool("crehq_locations_list", { brand: "giant-tiger-canada", per_page: 1 }, "err_selector_cap");
  assert.equal(selectorCap.isError, true);
  assert.match(selectorCap.text, /HTTP 403, selector_cap\): Monthly distinct-brand cap reached/);
  assert.match(selectorCap.text, /selector_cap: 25 of 25 distinct brands used in 2026-09; giant-tiger-canada was not served/);
  assert.match(selectorCap.text, /upgrade_url: https:\/\//);
  assert.match(selectorCap.text, /enterprise_url: https:\/\//);

  const pageCap = await callTool("crehq_locations_list", { brand: "planet-fitness", page: 99, per_page: 1 }, "err_pagination_capped");
  assert.match(pageCap.text, /HTTP 403, pagination_capped\): The sandbox does not support exhaustive pagination/);
  assert.match(pageCap.text, /upgrade_url: https:\/\/crehq\.com\/developers\/upgrade\//);
  assert.match(pageCap.text, /Suggestion: Do not request deeper pages/);

  const market = await callTool("crehq_locations_list", { brand: "mcdonalds", country: "AQ", per_page: 1 }, "err_brand_market_not_available");
  assert.equal(lastUrl?.searchParams.get("country"), "AQ", "country= is forwarded on the self-serve surface");
  assert.match(market.text, /HTTP 404, brand_market_not_available\): The sandbox serves this brand for these countries only/);
  assert.match(market.text, /available_countries( for [a-z0-9-]+)? \(retry with country=\): CN, ES, IN, IT, US/);
  assert.match(market.text, /Suggestion: Retry with country= set to one of available_countries/);

  const conflict = await callTool(
    "crehq_locations_list",
    { brand: "planet-fitness", state: "TX", country: "CA", per_page: 1 },
    "err_conflicting_country_state",
  );
  assert.equal(lastUrl?.searchParams.get("state"), "TX", "state= is forwarded on the self-serve surface");
  assert.match(conflict.text, /HTTP 400, invalid_country\): state= is a US state, so country= must be US or omitted\./);
  assert.match(conflict.text, /Suggestion: Fix country=/);

  const gated = await callTool("crehq_locations_list", { brand: "planet-fitness", include_provenance: true, per_page: 1 }, "err_payment_required_402");
  assert.match(gated.text, /HTTP 402, payment_required\): "provenance" is a D2 premium field/);
  assert.match(gated.text, /gated_field: provenance \(D2, multi-source-provenance\)/);
  assert.match(gated.text, /intent_id: 34/);
  assert.match(gated.text, /upgrade_url: https:\/\/crehq\.com\/developers\/sandbox\/#pro-checkout/);

  const rate = await callTool("crehq_locations_list", { brand: "planet-fitness", per_page: 1 }, "err_rate_limited_429");
  assert.match(rate.text, /HTTP 429, rate_limited\): Per-second rate limit exceeded/);
  assert.match(rate.text, /limit_type: rate/);
  assert.match(rate.text, /Suggestion: Slow down and retry after 47s\./);

  // ---- success --------------------------------------------------------------
  const pf = await callTool("crehq_locations_list", { brand: "planet-fitness", per_page: 2 }, "success_planet_fitness");
  assert.equal(pf.isError, false);
  assert.ok(pf.text.startsWith("--- CREHQ guidance (from this response) ---\n"), "guidance leads the output");
  assert.match(pf.text, /results: showing 1–2 of 2,861 total_available; has_more: true/);
  assert.match(pf.text, /coverage_note: Rows 1–2 of 2,861, ordered by state, city, name/);
  assert.match(
    pf.text,
    /row_budget: this brand 2 of 50 rows used this month, 48 left \(limit: 10% of 2,861 locations \(max 50\)\); all brands 2 of 1,000 rows, 998 left; resets 2026-10-01T00:00:00Z/,
  );
  assert.match(pf.text, /full_dataset: Planet Fitness \(\$99, D1, scope full, 2,861 locations\) https:\/\/crehq\.com\/data-store\/planet-fitness\//);
  assert.match(pf.text, /--- data ---\n\{/);
  assert.match(pf.text, /"store_id"/, "rows are still returned in full");

  const resolved = await callTool("crehq_locations_list", { brand: "planetfitness", per_page: 1 }, "success_resolved_from");
  assert.match(resolved.text, /resolved_from: "planetfitness" was matched to brand planet-fitness/);

  const es = await callTool("crehq_locations_list", { brand: "mcdonalds", country: "ES", per_page: 2 }, "success_market_scope_mcd_es");
  assert.match(es.text, /market_scope: country ES, brand mcdonalds-es \(basis mcdonalds_market_map\); these rows cover that market only/);

  const d2 = await callTool("crehq_locations_list", { brand: "jimmy-johns", per_page: 2 }, "success_d2_preview");
  assert.match(d2.text, /Enhanced \(D2\) preview: Location \+ Enhanced Data; fields: amenities 99\.57% filled, has_drive_thru 97\.07% filled/);
  assert.match(d2.text, /2 of 5 preview rows used this month/);
  assert.match(d2.text, /Rows with a "d2_preview" object \(2 here\): those values are an Enhanced \(D2\) preview sample, not part of the free Location File\./);
  assert.match(d2.text, /Enhanced \(D2\) note: Everything in the Location File/);
  assert.match(d2.text, /full_d2_dataset: Jimmy John's/);

  const none = await callTool("crehq_locations_list", { brand: "yummi-go-gourmet", per_page: 2 }, "success_coverage_none");
  assert.match(none.text, /coverage: none\. CREHQ has no published locations for this brand yet\./);
  assert.doesNotMatch(none.text, /results:/);

  const small = await callTool("crehq_locations_list", { brand: "cashland", per_page: 5 }, "success_small_brand_budget");
  assert.match(small.text, /this brand 1 of 1 rows used this month, 0 left/);
  assert.match(small.text, /this response was cut to the remaining budget/);

  // Responses without guidance fields (full API surface) are unchanged.
  assert.equal(ok({ data: { id: 1 }, meta: {} }).content[0].text, JSON.stringify({ id: 1 }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}

if (process.env.PRINT_SAMPLES) {
  for (const name of ["err_row_budget_exhausted", "err_brand_not_found", "err_selector_cap", "success_d2_preview"]) {
    const text = samples[name] ?? "";
    const cut = text.indexOf("--- data ---");
    console.log(`\n===== ${name} =====\n${cut >= 0 ? text.slice(0, cut).trimEnd() : text}`);
  }
}

console.log("PASS remote self-serve guidance pass-through (14 live fixtures)");
