import assert from "node:assert/strict";
import { z } from "zod";
import { TOOLS, toJsonSchema } from "../src/tools.js";
import { handleRpc, type JsonRpcResponse, type McpSession } from "../src/mcp.js";

const session: McpSession = {
  crehqApiKey: "crehq_live_affiliation_test",
  scopes: ["read:locations"],
  apiSurface: "selfserve",
  clientOptions: {
    apiBase: "https://api.example.test/wp-json/crehq/v1",
    timeoutMs: 1_000,
  },
};

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function callResult(response: JsonRpcResponse | null): CallResult {
  assert.ok(response && response.result && typeof response.result === "object");
  return response.result as CallResult;
}

const listResponse = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, session);
assert.ok(listResponse && listResponse.result && typeof listResponse.result === "object");
const listedTools = (listResponse.result as { tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools ?? [];
const names = listedTools.map((tool) => tool.name).sort();
assert.deepEqual(names, [
    "crehq_access_summary",
    "crehq_brand_cotenancy",
    "crehq_brand_economics",
    "crehq_brand_expansion",
    "crehq_brand_investment",
    "crehq_brands_matching_site",
    "crehq_companies_search",
    "crehq_company_site_requirements",
    "crehq_intelligence_preview",
    "crehq_locations_list",
    "crehq_locations_nearby",
    "crehq_purchased_dataset_locations",
    "crehq_purchased_datasets_list",
    "crehq_request_upgrade",
    "crehq_resolve_entity_affiliation",
    "crehq_site_selector_match",
    "crehq_team_item_add",
    "crehq_team_item_remove",
    "crehq_team_items",
    "crehq_team_list",
    "crehq_team_note_add",
    "crehq_team_notes",
    "crehq_team_site_runs",
    "crehq_team_site_save",
  ]);
assert.equal(names.includes("crehq_company_get"), false, "full-only tools remain hidden from selfserve keys");
assert.equal(names.includes("crehq_whitespace"), false, "premium intelligence tools remain hidden");

const blockedFullTool = callResult(
  await handleRpc(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "crehq_company_get", arguments: { id: 1 } },
    },
    session,
  ),
);
assert.equal(blockedFullTool.isError, true);
assert.match(blockedFullTool.content?.[0]?.text ?? "", /is not included in this key/i);

// Check the full catalog, not just the subset exposed to this session.
const jsonTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function checkSchema(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(checkSchema); return; }
  const schema = node as Record<string, unknown>;
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.length > 0, "JSON Schema type arrays cannot be empty");
    for (const type of types) assert.ok(jsonTypes.has(String(type)), `Invalid schema type: ${type}`);
  }
  Object.values(schema).forEach(checkSchema);
}
for (const tool of TOOLS) checkSchema(toJsonSchema(tool.schema));
for (const [name, field] of [["crehq_site_selector_match", "market_radius"], ["crehq_brands_matching_site", "market_radius_miles"]]) {
  const schema = listedTools.find((t) => t.name === name)?.inputSchema.properties[field];
  assert.ok(schema && typeof schema === "object");
  assert.deepEqual((schema as { anyOf: unknown[] }).anyOf, [1, 3, 5, 10, 25].map((n) => ({ type: "number", const: n })));
}
const numeric = toJsonSchema({ n: z.number().int().min(1).max(100), mixed: z.union([z.string(), z.number()]) });
assert.deepEqual(numeric.properties.n, { type: "integer", minimum: 1, maximum: 100 });
assert.deepEqual(numeric.properties.mixed, { anyOf: [{ type: "string" }, { type: "number" }] });
const init = await handleRpc({ jsonrpc: "2.0", id: "instructions", method: "initialize" }, session);
const instructions = (init?.result as { instructions: string }).instructions;
assert.match(instructions, /Begin with crehq_access_summary/);
assert.match(instructions, /crehq_brand_investment/);
assert.match(instructions, /do not send students to checkout/);

const advertised = listedTools.find((tool) => tool.name === "crehq_resolve_entity_affiliation");
assert.ok(advertised);
assert.deepEqual(Object.keys(advertised.inputSchema.properties).sort(), ["address", "session_id", "source", "url", "venue_name"]);
assert.equal((advertised.inputSchema.properties.url as { format?: string }).format, "uri");
assert.match((advertised.inputSchema.properties.url as { pattern?: string }).pattern ?? "", /Hh.*Tt.*Pp/);

const invalidUrl = callResult(
  await handleRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "crehq_resolve_entity_affiliation", arguments: { url: "not-a-url" } },
    },
    session,
  ),
);
assert.equal(invalidUrl.isError, true);
assert.match(invalidUrl.content?.[0]?.text ?? "", /Invalid arguments/);

const nonHttpUrl = callResult(
  await handleRpc(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "crehq_resolve_entity_affiliation", arguments: { url: "ftp://example.com/venue" } },
    },
    session,
  ),
);
assert.equal(nonHttpUrl.isError, true);
assert.match(nonHttpUrl.content?.[0]?.text ?? "", /Invalid arguments/);

const missingIdentity = callResult(
  await handleRpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "crehq_resolve_entity_affiliation", arguments: { session_id: "session-only" } },
    },
    session,
  ),
);
assert.equal(missingIdentity.isError, true);
assert.match(missingIdentity.content?.[0]?.text ?? "", /url, venue_name, or address/i);

const originalFetch = globalThis.fetch;
let responseMode: "success" | "payment" = "success";
let calls = 0;
let expectedSelfservePath = "";

try {
  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    calls++;
    const requestUrl = input instanceof Request ? input.url : String(input);
    assert.equal(new Headers(init.headers).get("x-api-key"), "crehq_live_affiliation_test");
    const parsedUrl = new URL(requestUrl);
    const path = parsedUrl.pathname;
    if (path !== "/wp-json/crehq/v1/affiliation/resolve") {
      assert.equal(path, expectedSelfservePath);
      assert.equal(init.method, path.endsWith("/intelligence-preview") ? "POST" : "GET");
      if (path.endsWith("/dataset-locations")) {
        assert.equal(parsedUrl.searchParams.get("dataset"), "pilot-flying-j");
        assert.equal(parsedUrl.searchParams.get("limit"), "2");
      }
      return new Response(JSON.stringify({ ok: true, path }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), {
      url: "https://www.earleycrescent.org/",
      venue_name: "Earley CresCent",
      address: "Lower Earley, Reading, UK",
      session_id: "session-123",
      source: "mcp",
    });

    if (responseMode === "payment") {
      return new Response(
        JSON.stringify({
          code: "payment_required",
          message: "Upgrade to continue affiliation resolution.",
          data: {
            status: 402,
            intent_id: "742",
            tracking_id: "aff_742",
            purchase_url: "https://crehq.com/checkout/?intent_id=742",
            price: { amount: 99, currency: "USD", interval: "month" },
            requested_data: "entity_affiliation",
            retry_after_purchase: true,
            unknown_future_field: "preserved",
          },
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
        unknown_future_field: "preserved",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const args = {
    url: " https://www.earleycrescent.org/ ",
    venue_name: " Earley CresCent ",
    address: " Lower Earley, Reading, UK ",
    session_id: " session-123 ",
  };
  const success = callResult(
    await handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crehq_resolve_entity_affiliation", arguments: args } },
      session,
    ),
  );
  assert.equal(success.isError, undefined);
  assert.match(success.content?.[0]?.text ?? "", /not_a_commercial_venue/);
  assert.match(success.content?.[0]?.text ?? "", /unknown_future_field/);

  responseMode = "payment";
  const payment = callResult(
    await handleRpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "crehq_resolve_entity_affiliation", arguments: args } },
      session,
    ),
  );
  assert.equal(payment.isError, true);
  assert.match(payment.content?.[0]?.text ?? "", /purchase_url: https:\/\/crehq\.com\/checkout\/\?intent_id=742/);
  assert.match(payment.content?.[0]?.text ?? "", /emails a new Pro key/i);
  assert.match(payment.content?.[0]?.text ?? "", /not upgraded in place/i);
  assert.match(payment.content?.[0]?.text ?? "", /CREHQ intent_id: 742/);
  assert.match(payment.content?.[0]?.text ?? "", /"unknown_future_field": "preserved"/);
  assert.match(payment.content?.[0]?.text ?? "", /"amount": 99/);

  const selfserveCalls: Array<{ name: string; arguments: Record<string, unknown>; path: string }> = [
    { name: "crehq_purchased_datasets_list", arguments: {}, path: "/wp-json/crehq/v1/selfserve/datasets" },
    {
      name: "crehq_purchased_dataset_locations",
      arguments: { dataset: "pilot-flying-j", per_page: 2 },
      path: "/wp-json/crehq/v1/selfserve/dataset-locations",
    },
    {
      name: "crehq_intelligence_preview",
      arguments: { brand: "family-dollar", preview_type: "credit_brief" },
      path: "/wp-json/crehq/v1/selfserve/intelligence-preview",
    },
  ];
  for (const [index, selfserveCall] of selfserveCalls.entries()) {
    expectedSelfservePath = selfserveCall.path;
    const routed = callResult(
      await handleRpc(
        {
          jsonrpc: "2.0",
          id: 10 + index,
          method: "tools/call",
          params: { name: selfserveCall.name, arguments: selfserveCall.arguments },
        },
        session,
      ),
    );
    assert.equal(routed.isError, undefined, `${selfserveCall.name} remains callable with a basic selfserve session`);
  }
  assert.equal(calls, 5);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS remote selfserve catalog, affiliation POST, success preservation, and 402 checkout formatting");
