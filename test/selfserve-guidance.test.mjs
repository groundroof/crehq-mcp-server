// Guidance pass-through contract for self-serve keys (stdio package).
//
// Replays REAL bodies captured from the live CREHQ self-serve API on
// 2026-09-15 (internal sandbox key, revoked afterwards; not in the fixtures)
// through the stdio client + formatter and checks the agent-visible text.
// Fixtures are shared with the hosted server in remote/test/fixtures/selfserve/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CrehqClient } from "../dist/client.js";
import { ok, fail } from "../dist/format.js";
import { TOOLS } from "../dist/tools.js";

const FIXTURES = new URL("../remote/test/fixtures/selfserve/", import.meta.url);
const loadFixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));

const client = new CrehqClient({
  apiKey: "crehq_live_guidance_test",
  apiBase: "https://api.example.test/wp-json/crehq/v1",
  timeoutMs: 1_000,
  apiSurface: "selfserve",
});

let current;
let lastUrl;
const originalFetch = globalThis.fetch;

async function render(fixtureName) {
  current = loadFixture(fixtureName);
  try {
    return ok(await client.request("/selfserve/locations", { query: { brand: "fixture" } }));
  } catch (err) {
    return fail(err);
  }
}

try {
  globalThis.fetch = async (input) => {
    lastUrl = new URL(input instanceof Request ? input.url : String(input));
    return new Response(JSON.stringify(current.body), {
      status: current.status,
      headers: { "content-type": "application/json", ...current.headers },
    });
  };

  const notFound = await render("err_brand_not_found");
  assert.equal(notFound.isError, true);
  assert.match(notFound.content[0].text, /HTTP 404, brand_not_found\): No CREHQ brand matches "plannet-fitnes"\. Did you mean: planet-fitness \(Planet Fitness\)\?/);
  assert.match(notFound.content[0].text, /did_you_mean \(retry with brand=\): planet-fitness/);

  const budget = (await render("err_row_budget_exhausted")).content[0].text;
  assert.match(budget, /HTTP 403, row_budget_exhausted\): This key has received its 1 rows for Cashland/);
  assert.match(budget, /row_budget: this brand 1 of 1 rows used this month \(limit: 10% of 10 locations \(max 50\)\)/);
  assert.match(budget, /full_dataset: Cashland \(\$79, D1, scope full, 10 locations\) https:\/\/crehq\.com\/data-store\/cashland\//);
  assert.match(budget, /upgrade_url: https:\/\//);
  assert.match(budget, /Suggestion: Rows per brand are limited monthly/);
  assert.doesNotMatch(budget, /crehq_request_upgrade so CREHQ can record upgrade intent/, "row budget errors skip the generic 403 hint");

  const cap = (await render("err_selector_cap")).content[0].text;
  assert.match(cap, /selector_cap: 25 of 25 distinct brands used in 2026-09/);
  assert.match(cap, /enterprise_url: https:\/\//);

  const rate = (await render("err_rate_limited_429")).content[0].text;
  assert.match(rate, /HTTP 429, rate_limited\): Per-second rate limit exceeded/);
  assert.match(rate, /retry after 47s/);

  const pf = (await render("success_planet_fitness")).content[0].text;
  assert.ok(pf.startsWith("--- CREHQ guidance (from this response) ---\n"));
  assert.match(pf, /results: showing 1–2 of 2,861 total_available; has_more: true/);
  assert.match(pf, /row_budget: this brand 2 of 50 rows used this month, 48 left/);
  assert.match(pf, /full_dataset: Planet Fitness \(\$99, D1, scope full, 2,861 locations\)/);

  const d2 = (await render("success_d2_preview")).content[0].text;
  assert.match(d2, /Enhanced \(D2\) preview: Location \+ Enhanced Data; fields: amenities 99\.57% filled/);
  assert.match(d2, /Rows with a "d2_preview" object \(2 here\): those values are an Enhanced \(D2\) preview sample/);

  const es = (await render("success_market_scope_mcd_es")).content[0].text;
  assert.match(es, /market_scope: country ES, brand mcdonalds-es/);

  const none = (await render("success_coverage_none")).content[0].text;
  assert.match(none, /coverage: none\. CREHQ has no published locations for this brand yet\./);

  // The stdio locations tool forwards state/country on the self-serve surface.
  const tool = TOOLS.find((t) => t.name === "crehq_locations_list");
  current = loadFixture("err_brand_market_not_available");
  const market = await tool.handler(client, { brand: "mcdonalds", country: "AQ" });
  assert.equal(lastUrl.searchParams.get("country"), "AQ");
  assert.match(market.content[0].text, /available_countries( for [a-z0-9-]+)? \(retry with country=\): CN, ES, IN, IT, US/);
  assert.match(tool.description, /rows you receive per brand are limited monthly/i);

  assert.equal(ok({ data: { id: 1 }, meta: {} }).content[0].text, JSON.stringify({ id: 1 }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS stdio self-serve guidance pass-through");
