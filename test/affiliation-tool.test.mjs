import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CrehqClient } from "../dist/client.js";
import { TOOLS, toJsonSchema } from "../dist/tools.js";

const registryManifest = JSON.parse(
  await readFile(new URL("../server.json", import.meta.url), "utf8"),
);
assert.ok(
  registryManifest.description.length <= 100,
  `MCP Registry description must be at most 100 characters; received ${registryManifest.description.length}`,
);

const tool = TOOLS.find((candidate) => candidate.name === "crehq_resolve_entity_affiliation");
assert.ok(tool, "stdio registry exposes crehq_resolve_entity_affiliation");

const advertised = toJsonSchema(tool.schema);
assert.deepEqual(Object.keys(advertised.properties).sort(), ["address", "session_id", "source", "url", "venue_name"]);
assert.deepEqual(advertised.required, [], "identity alternatives remain optional in JSON Schema");
assert.equal(advertised.properties.url.format, "uri", "URL is advertised with JSON Schema URI format");
assert.match(advertised.properties.url.pattern, /Hh.*Tt.*Pp/, "URL schema advertises an HTTP(S)-only pattern");
assert.equal(z.object(tool.schema).safeParse({ url: "not-a-url" }).success, false, "invalid URLs are rejected");
assert.equal(z.object(tool.schema).safeParse({ url: "ftp://example.com/venue" }).success, false, "non-HTTP URLs are rejected");
assert.equal(z.object(tool.schema).safeParse({ venue_name: "x".repeat(201) }).success, false, "backend name limit is mirrored");
assert.equal(z.object(tool.schema).safeParse({ address: "x".repeat(301) }).success, false, "backend address limit is mirrored");
assert.equal(z.object(tool.schema).safeParse({ session_id: "x".repeat(97) }).success, false, "backend session limit is mirrored");
assert.equal(z.object(tool.schema).safeParse({ source: "search_console" }).success, false, "backend source allowlist is mirrored");

const client = new CrehqClient({
  apiKey: "crehq_live_affiliation_test",
  apiBase: "https://api.example.test/wp-json/crehq/v1",
  timeoutMs: 1_000,
  apiSurface: "selfserve",
});

const missingIdentity = await tool.handler(client, { session_id: "session-only" });
assert.equal(missingIdentity.isError, true);
assert.match(missingIdentity.content[0].text, /url, venue_name, or address/i);

const originalFetch = globalThis.fetch;
let responseMode = "success";
let calls = 0;

try {
  globalThis.fetch = async (input, init = {}) => {
    calls++;
    const requestUrl = input instanceof Request ? input.url : String(input);
    assert.equal(requestUrl, "https://api.example.test/wp-json/crehq/v1/affiliation/resolve");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("x-api-key"), "crehq_live_affiliation_test");
    assert.deepEqual(JSON.parse(String(init.body)), {
      url: "https://www.earleycrescent.org/",
      venue_name: "Earley CresCent",
      session_id: "session-123",
      source: "mcp",
    });

    if (responseMode === "payment") {
      return new Response(
        JSON.stringify({
          code: "payment_required",
          message: "Upgrade to continue affiliation resolution.",
          intent_id: 741,
          tracking_id: "aff_741",
          purchase_url: "https://crehq.com/checkout/?intent_id=741",
          price: { amount: 99, currency: "USD", interval: "month" },
          requested_data: "entity_affiliation",
          retry_after_purchase: true,
          result_preview: { affiliation_status: "unresolved" },
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        resolver_version: "affiliation-v1",
        affiliation_status: "not_a_commercial_venue",
        entity_type: "community_center",
        canonical_name: "Earley CresCent",
        brand: null,
        operator: "Earley Crescent Community Association",
        parent_company: null,
        confidence: { score: 0.98, level: "high", method: "evidence" },
        evidence: [{ type: "website", label: "About", value: "Community centre" }],
        checked_at: "2026-07-10T00:00:00Z",
        quota: { mode: "authenticated", remaining: 9 },
        future_field: "preserved",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const args = {
    url: " https://www.earleycrescent.org/ ",
    venue_name: " Earley CresCent ",
    session_id: " session-123 ",
  };
  const success = await tool.handler(client, args);
  assert.equal(success.isError, undefined);
  assert.match(success.content[0].text, /not_a_commercial_venue/);
  assert.match(success.content[0].text, /future_field/);

  responseMode = "payment";
  const payment = await tool.handler(client, args);
  assert.equal(payment.isError, true);
  assert.match(payment.content[0].text, /purchase_url: https:\/\/crehq\.com\/checkout\/\?intent_id=741/);
  assert.match(payment.content[0].text, /emails a new Pro key/i);
  assert.match(payment.content[0].text, /not upgraded in place/i);
  assert.match(payment.content[0].text, /CREHQ intent_id: 741/);
  assert.match(payment.content[0].text, /"result_preview"/);
  assert.match(payment.content[0].text, /"amount": 99/);
  assert.equal(calls, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS stdio affiliation registry, client POST, success preservation, and 402 checkout formatting");

const locationsTool = TOOLS.find((candidate) => candidate.name === "crehq_locations_list");
const purchasedLocationsTool = TOOLS.find((candidate) => candidate.name === "crehq_purchased_dataset_locations");
assert.ok(locationsTool, "stdio registry exposes crehq_locations_list");
assert.ok(purchasedLocationsTool, "stdio registry preserves purchased dataset locations");

const fullClient = new CrehqClient({
  apiKey: "crehq_live_locations_test",
  apiBase: "https://api.example.test/wp-json/crehq/v1",
  timeoutMs: 1_000,
  apiSurface: "full",
});
const locationRequests = [];

try {
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    locationRequests.push(url);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-wp-total": "41", "x-wp-totalpages": "6" },
    });
  };

  await locationsTool.handler(client, {
    brand: "planet-fitness",
    country: "ES",
    category: "fitness",
    include_provenance: true,
    per_page: 7,
    page: 3,
  });
  assert.equal(locationRequests[0].pathname, "/wp-json/crehq/v1/selfserve/locations");
  assert.deepEqual(Object.fromEntries(locationRequests[0].searchParams), {
    brand: "planet-fitness",
    country: "ES",
    category: "fitness",
    limit: "7",
    page: "3",
    fields: "provenance,sources,confidence_score,first_observed_at",
  });

  await locationsTool.handler(client, { brand: "planet-fitness", state: "TX", country: "ES", category: "fitness" });
  assert.equal(locationRequests[1].pathname, "/wp-json/crehq/v1/selfserve/locations");
  assert.deepEqual(Object.fromEntries(locationRequests[1].searchParams), {
    brand: "planet-fitness",
    state: "TX",
    country: "ES",
    category: "fitness",
    limit: "25",
  }, "the MCP preserves a state/country conflict for backend validation");

  await locationsTool.handler(fullClient, { state: "TX", category: "fitness", per_page: 7, page: 3 });
  assert.equal(locationRequests[2].pathname, "/wp-json/crehq/v1/locations");
  assert.deepEqual(Object.fromEntries(locationRequests[2].searchParams), {
    state: "TX",
    country: "US",
    category: "fitness",
    per_page: "7",
    page: "3",
  });

  await locationsTool.handler(fullClient, { state: "", category: "restaurant" });
  assert.deepEqual(Object.fromEntries(locationRequests[3].searchParams), { category: "restaurant" });

  await locationsTool.handler(fullClient, { category: "restaurant" });
  assert.deepEqual(Object.fromEntries(locationRequests[4].searchParams), { category: "restaurant" });

  await locationsTool.handler(fullClient, { state: "   ", category: "restaurant" });
  assert.deepEqual(Object.fromEntries(locationRequests[5].searchParams), {
    state: "   ",
    category: "restaurant",
  }, "raw whitespace is preserved but does not infer country");

  const beforeNoBrand = locationRequests.length;
  const noBrand = await locationsTool.handler(client, { category: "restaurant" });
  assert.equal(noBrand.isError, true);
  assert.match(noBrand.content[0].text, /require a bounded location query/i);
  assert.equal(locationRequests.length, beforeNoBrand, "missing-brand selfserve query does not fetch");

  await purchasedLocationsTool.handler(client, {
    dataset: "pilot-flying-j",
    state: "ON",
    country: "CA",
    per_page: 2,
    page: 4,
  });
  assert.equal(locationRequests[6].pathname, "/wp-json/crehq/v1/selfserve/dataset-locations");
  assert.deepEqual(Object.fromEntries(locationRequests[6].searchParams), {
    dataset: "pilot-flying-j",
    state: "ON",
    country: "CA",
    limit: "2",
    page: "4",
  }, "purchased snapshot country and paging remain untouched");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS stdio current-upstream locations filters, US bridge, boundaries, pagination, and provenance");
