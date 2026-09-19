/**
 * Team-workspace tools contract (hosted server).
 *
 * The eight crehq_team_* tools call the Teams REST layer at
 * /wp-json/crehq/v1/selfserve/teams/... (crehq-teams-api.php) with the key's
 * bearer token. These tests replay REAL bodies captured from the live API on
 * 2026-09-19 with a temporary developer-tier key linked to the test account
 * 21678 (deleted afterwards; the key is not in the fixtures) through the MCP
 * tools/call path, and check: the exact path / method / query / JSON body each
 * tool sends, that the tools are visible to self-serve keys, that the API's
 * refusals (brand_not_found + did_you_mean, pass_required, forbidden) reach
 * the agent as non-fatal tool errors, and that the JSON schema for nested
 * objects (suites, inputs) is emitted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleRpc, type McpSession } from "../src/mcp.js";
import { TOOLS, toJsonSchema } from "../src/tools.js";

interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const FIXTURES = new URL("../../test/fixtures/teams/", import.meta.url);
const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Fixture;

const TEAM_TOOLS = [
  "crehq_team_list",
  "crehq_team_items",
  "crehq_team_item_add",
  "crehq_team_item_remove",
  "crehq_team_note_add",
  "crehq_team_notes",
  "crehq_team_site_save",
  "crehq_team_site_runs",
];

const session: McpSession = {
  crehqApiKey: "crehq_live_teams_test",
  scopes: ["read:locations"],
  apiSurface: "selfserve",
  clientOptions: {
    apiBase: "https://api.example.test/wp-json/crehq/v1",
    timeoutMs: 1_000,
  },
};

interface Captured {
  url: URL;
  method: string;
  body: unknown;
  auth: string;
}

let current: Fixture | undefined;
let last: Captured | undefined;
let rpcId = 0;

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
  assert.ok(response && response.result && typeof response.result === "object", `${name}: tools/call returned a result`);
  const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean };
  return { text: result.content?.[0]?.text ?? "", isError: result.isError === true };
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    last = {
      url,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("authorization") ?? "",
    };
    assert.ok(current, "a fixture is loaded before each call");
    return new Response(JSON.stringify(current.body), {
      status: current.status,
      headers: { "content-type": "application/json", ...current.headers },
    });
  };

  // ---- registry + visibility ---------------------------------------------
  const names = new Set(TOOLS.map((t) => t.name));
  for (const name of TEAM_TOOLS) assert.ok(names.has(name), `${name} is registered`);

  const listed = await handleRpc({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }, session);
  const visible = ((listed?.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
  for (const name of TEAM_TOOLS) assert.ok(visible.includes(name), `${name} is visible to a self-serve key`);

  const fullListed = await handleRpc({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }, { ...session, apiSurface: "full" });
  const fullVisible = ((fullListed?.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
  for (const name of TEAM_TOOLS) assert.ok(fullVisible.includes(name), `${name} is visible on the full surface too`);

  const init = await handleRpc({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: {} }, session);
  const instructions = String((init?.result as { instructions?: string }).instructions ?? "");
  assert.match(instructions, /crehq_team_list first/, "initialize tells the agent to call crehq_team_list first");
  assert.match(instructions, /not CREHQ data/, "initialize says team data is the team's own, not CREHQ data");

  for (const name of TEAM_TOOLS) {
    const tool = TOOLS.find((t) => t.name === name)!;
    assert.ok(!tool.description.includes("\n"), `${name}: one-line description`);
    assert.match(tool.description, /team's own|team members' own|its own picks/, `${name}: says the data is the team's own`);
    assert.match(tool.description, /not CREHQ data/, `${name}: says it is not CREHQ data`);
    assert.match(tool.description, /another team|other teams/, `${name}: says it never reaches another team`);
  }

  // ---- schema: nested objects are emitted (suites / inputs) --------------
  const siteSchema = toJsonSchema(TOOLS.find((t) => t.name === "crehq_team_site_save")!.schema) as {
    properties: Record<string, { type?: string; items?: { type?: string; properties?: Record<string, unknown> }; properties?: Record<string, unknown> }>;
    required: string[];
  };
  assert.deepEqual(siteSchema.required, ["team"]);
  assert.equal(siteSchema.properties.suites.type, "array");
  assert.equal(siteSchema.properties.suites.items?.type, "object");
  assert.ok(siteSchema.properties.suites.items?.properties?.sqft, "suite items expose sqft");
  assert.equal(siteSchema.properties.inputs.type, "object");
  assert.ok(siteSchema.properties.inputs.properties?.aadt, "inputs expose aadt");
  const noteSchema = toJsonSchema(TOOLS.find((t) => t.name === "crehq_team_note_add")!.schema) as { properties: Record<string, { type?: string }>; required: string[] };
  assert.deepEqual(noteSchema.required, ["team", "target_type", "body"]);
  assert.equal(noteSchema.properties.evidence.type, "object");

  // ---- crehq_team_list -----------------------------------------------------
  const teams = await callTool("crehq_team_list", {}, "teams_list");
  assert.equal(teams.isError, false);
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams");
  assert.equal(last?.method, "GET");
  assert.equal(last?.auth, "Bearer crehq_live_teams_test", "the key rides as a bearer token");
  assert.match(teams.text, /"slug": "crehq-test-2026-qa-team-0"/);
  assert.match(teams.text, /"role": "member"/);
  assert.match(teams.text, /They are not CREHQ data/);

  // ---- crehq_team_items ----------------------------------------------------
  const items = await callTool("crehq_team_items", { team: "crehq-test-2026-qa-team-0", list_id: 0 }, "items_all");
  assert.equal(items.isError, false);
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/crehq-test-2026-qa-team-0/items");
  assert.equal(last?.url.searchParams.get("list_id"), "0", "list_id 0 (unfiled) is forwarded, not dropped");
  assert.match(items.text, /"slug": "jersey-mikes"/);

  // ---- crehq_team_item_add: slug, name (existing), list, refusal -----------
  const added = await callTool("crehq_team_item_add", { team: "4", brand: "jersey-mikes" }, "item_add_created");
  assert.equal(added.isError, false);
  assert.equal(last?.method, "POST");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/items");
  assert.deepEqual(last?.body, { item_type: "brand", ref: "jersey-mikes" }, "no list_id key when omitted");
  assert.match(added.text, /"created": true/);
  assert.match(added.text, /"id": 26289/);

  const existing = await callTool("crehq_team_item_add", { team: "4", brand: "Jersey Mike's", list_id: 6 }, "item_add_existing");
  assert.deepEqual(last?.body, { item_type: "brand", ref: "Jersey Mike's", list_id: 6 });
  assert.match(existing.text, /"created": false/, "idempotent add reports the existing item");

  const refused = await callTool("crehq_team_item_add", { team: "4", brand: "Jersey" }, "item_add_brand_not_found");
  assert.equal(refused.isError, true);
  assert.match(refused.text, /HTTP 404, brand_not_found\): No published CREHQ brand is exactly "Jersey"/);
  assert.match(refused.text, /did_you_mean \(retry with brand=\): jersey-mikes/);
  assert.match(refused.text, /Suggestion: If a did_you_mean slug is what the user meant/);

  // ---- crehq_team_item_remove ---------------------------------------------
  const removed = await callTool("crehq_team_item_remove", { team: "4", item_id: 34 }, "item_remove");
  assert.equal(removed.isError, false);
  assert.equal(last?.method, "DELETE");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/items/34");
  assert.match(removed.text, /"deleted": true/);

  // ---- crehq_team_note_add / crehq_team_notes -----------------------------
  const note = await callTool(
    "crehq_team_note_add",
    { team: "4", target_type: "brand", target: "jersey-mikes", body: "Strong fit for suite A.", evidence: { source: "crehq_brand_economics" } },
    "note_add",
  );
  assert.equal(note.isError, false);
  assert.equal(last?.method, "POST");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/notes");
  assert.deepEqual(last?.body, {
    target_type: "brand",
    target_id: "jersey-mikes",
    body: "Strong fit for suite A.",
    evidence: { source: "crehq_brand_economics" },
  });
  assert.match(note.text, /"mentions": \[\s*21678\s*\]/, "an @mention resolved to the member id");

  await callTool("crehq_team_note_add", { team: "4", target_type: "team", body: "Kickoff." }, "note_add");
  assert.deepEqual(last?.body, { target_type: "team", body: "Kickoff." }, "team notes send no target_id");

  const notes = await callTool("crehq_team_notes", { team: "4", target_type: "brand", target: "jersey-mikes", limit: 20 }, "notes_brand");
  assert.equal(notes.isError, false);
  assert.equal(last?.method, "GET");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/notes");
  assert.equal(last?.url.searchParams.get("target_type"), "brand");
  assert.equal(last?.url.searchParams.get("target_id"), "jersey-mikes");
  assert.equal(last?.url.searchParams.get("limit"), "20");
  assert.match(notes.text, /notes_about/);

  // ---- crehq_team_site_save / crehq_team_site_runs ------------------------
  const site = await callTool(
    "crehq_team_site_save",
    {
      team: "4",
      name: "API test site",
      address: "123 Main St",
      city: "West Lafayette",
      state: "in",
      postal_code: "47906",
      lat: 40.4259,
      lng: -86.9081,
      suites: [{ name: "A", sqft: 1800 }, { name: "B", sqft: 2400 }],
      inputs: { aadt: 24000, population: 52000, hhi: 61000, radius_mi: 3 },
    },
    "site_save",
  );
  assert.equal(site.isError, false);
  assert.equal(last?.method, "POST");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/sites");
  const sent = last?.body as Record<string, unknown>;
  assert.equal(sent.state, "IN", "state is upper-cased");
  assert.equal(sent.id, undefined, "no id on create");
  assert.deepEqual(sent.suites, [{ name: "A", sqft: 1800 }, { name: "B", sqft: 2400 }]);
  assert.deepEqual(sent.inputs, { aadt: 24000, population: 52000, hhi: 61000, radius_mi: 3 });
  assert.match(site.text, /"created": true/);

  await callTool("crehq_team_site_save", { team: "4", id: 4, name: "Renamed" }, "site_update");
  assert.deepEqual(last?.body, { id: 4, name: "Renamed" }, "update sends only the fields given");

  const runs = await callTool("crehq_team_site_runs", { team: "4", site_id: 4, limit: 5 }, "runs_list");
  assert.equal(runs.isError, false);
  assert.equal(last?.method, "GET");
  assert.equal(last?.url.pathname, "/wp-json/crehq/v1/selfserve/teams/4/sites/4/runs");
  assert.equal(last?.url.searchParams.get("limit"), "5");
  assert.match(runs.text, /"result_count": 3/);
  assert.match(runs.text, /Re-run crehq_site_selector_match for a current answer/);

  // ---- refusals reach the agent as non-fatal tool errors ------------------
  const noPass = await callTool("crehq_team_list", {}, "err_pass_required");
  assert.equal(noPass.isError, true);
  assert.match(noPass.text, /HTTP 403, pass_required\): Team workspaces need a Researcher Pass/);

  const notMember = await callTool("crehq_team_items", { team: "2" }, "err_forbidden_not_member");
  assert.equal(notMember.isError, true);
  assert.match(notMember.text, /HTTP 403, forbidden\): This account is not a member of that team/);

  const noKey = await callTool("crehq_team_list", {}, "err_missing_api_key");
  assert.equal(noKey.isError, true);
  assert.match(noKey.text, /HTTP 401, missing_api_key\)/);

  // ---- argument validation never reaches the network ---------------------
  last = undefined;
  const bad = await handleRpc(
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "crehq_team_item_remove", arguments: { team: "4", item_id: "34" } } },
    session,
  );
  const badResult = bad?.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(badResult.isError, true);
  assert.match(badResult.content?.[0]?.text ?? "", /Invalid arguments for crehq_team_item_remove/);
  assert.equal(last, undefined, "no request was sent for invalid arguments");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS remote team-workspace tools (8 tools, 14 live fixtures)");
