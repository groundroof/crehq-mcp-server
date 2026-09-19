/**
 * CREHQ MCP tool registry, shared by the remote Streamable-HTTP
 * server. Copied from the stdio package and extended with a `requiredScope`
 * field used for OAuth tier gating.
 *
 * Scope model (maps to CREHQ key `permissions.scopes` / tiers):
 *   - SCOPE_BASIC  ("read:locations") : companies, locations, datasets, trends.
 *   - SCOPE_INTEL  ("read:intelligence"): whitespace, co-tenancy, site-timeline,
 *                                          point-in-time occupancy, credit signals,
 *                                          modeled site profiles (premium).
 *
 * Endpoint contract sourced from https://crehq.com/developers/ and the live
 * route namespace at https://crehq.com/wp-json/crehq/v1 (verified 2026-06-17).
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { CrehqApiError, type CrehqClient } from "./client.js";
import { ok, fail, type ToolContent } from "./format.js";

/** OAuth scope that grants the basic (read) tool tier. */
export const SCOPE_BASIC = "read:locations";
/** OAuth scope that grants the premium intelligence tool tier. */
export const SCOPE_INTEL = "read:intelligence";
/** All scopes this server can issue, in the order shown on the consent screen. */
export const ALL_SCOPES = [SCOPE_BASIC, SCOPE_INTEL] as const;

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  /** OAuth scope required to invoke this tool. */
  requiredScope: typeof SCOPE_BASIC | typeof SCOPE_INTEL;
  handler: (client: CrehqClient, args: Record<string, unknown>) => Promise<ToolContent>;
}

async function call(
  fn: () => Promise<Awaited<ReturnType<CrehqClient["request"]>>>,
): Promise<ToolContent> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

// --- shared schema fragments -------------------------------------------------
const perPage = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Results per page (max 200, default 50).");
const page = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Page number for cursor/offset pagination (default 1).");
const d2LocationFields = "provenance,sources,confidence_score,first_observed_at";
/**
 * Appended to the self-serve location tools. The API reports the exact budget
 * on every call, so no limit numbers are hard-coded here.
 */
const selfServeGuidanceNote =
  "On CREHQ self-serve/sandbox keys the rows you receive per brand are limited monthly: every response states the exact row_budget, a coverage_note, and the full_dataset offer when a complete file is on sale. Relay those to the user instead of paging or re-filtering around the limit. If a brand is not found, retry with one of the did_you_mean slugs the error returns.";

/** Site types accepted by /selfserve/site-selector/match (comma list). */
const SITE_SELECTOR_SITE_TYPES = [
  "endcap",
  "inline",
  "freestanding",
  "pad",
  "drive_thru",
  "strip_center",
  "shopping_center",
  "lifestyle_center",
  "mall",
  "urban",
  "non_traditional",
  "conversion",
  "office",
  "industrial",
] as const;
const siteTypeAlternation = SITE_SELECTOR_SITE_TYPES.join("|");
const siteTypeListPattern = new RegExp(`^\\s*(?:${siteTypeAlternation})\\s*(?:,\\s*(?:${siteTypeAlternation})\\s*)*$`);
const usStateCode = z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a 2-letter US state code, e.g. IN.");
const nonNegativeInt = z.number().int().min(0);

// --- team workspaces (crehq_team_*) ---------------------------------------
/** Team id or slug, as crehq_team_list reports it. */
const teamRef = z.string().trim().min(1).max(191).describe("Team id or slug from crehq_team_list.");
/** /selfserve/teams/{team}{rest} with the team reference URL-encoded. */
function teamPath(team: unknown, rest = ""): string {
  return `/selfserve/teams/${encodeURIComponent(String(team).trim())}${rest}`;
}

/** Normalize "a, b ,c" to "a,b,c"; undefined when empty. */
function commaList(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const joined = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
  return joined || undefined;
}

function upperState(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

const upgradeIntentFields: Record<string, string> = {
  franchise_fdd: "fdd",
  item19_financials: "item19",
  credit_signals: "credit_signals",
  credit_profile: "credit_profile",
  credit_rating: "credit_rating",
  site_selection_criteria: "site_requirements",
  real_estate_requirements: "real_estate_requirements",
  real_estate_contacts: "contacts",
  source_provenance: "provenance",
  change_history: "event_history",
  bulk_download: "provenance",
  whitespace: "trade_area",
  co_tenancy: "trade_area",
  modeled_site_profile: "trade_area",
  recent_location_context: "trade_area",
  site_timeline: "event_history",
  other: "provenance",
};

function intentIdLine(err: CrehqApiError): string {
  const body = err.body;
  if (!body || typeof body !== "object") return "";
  const rawIntent = (body as { intent_id?: unknown }).intent_id;
  if (typeof rawIntent !== "number" && typeof rawIntent !== "string") return "";
  const intentId = String(rawIntent).trim();
  if (!intentId) return "";
  return `\nCREHQ intent_id: ${intentId}. Use this exact intent_id for follow-up; do not invent a separate request_id.`;
}

function affiliationInput(a: Record<string, unknown>): {
  url?: string;
  venue_name?: string;
  address?: string;
  session_id?: string;
  source?: string;
} {
  return {
    url: typeof a.url === "string" && a.url.trim() ? a.url.trim() : undefined,
    venue_name: typeof a.venue_name === "string" && a.venue_name.trim() ? a.venue_name.trim() : undefined,
    address: typeof a.address === "string" && a.address.trim() ? a.address.trim() : undefined,
    session_id: typeof a.session_id === "string" && a.session_id.trim() ? a.session_id.trim() : undefined,
    source: typeof a.source === "string" && a.source.trim() ? a.source.trim() : "mcp",
  };
}

function nestedBodyField(body: unknown, field: string): unknown {
  if (!body || typeof body !== "object") return undefined;
  const direct = (body as Record<string, unknown>)[field];
  if (direct !== undefined) return direct;
  const data = (body as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>)[field] : undefined;
}

function affiliationPaymentRequired(err: CrehqApiError): ToolContent {
  const rawPurchaseUrl = nestedBodyField(err.body, "purchase_url");
  const rawIntentId = nestedBodyField(err.body, "intent_id");
  const purchaseUrl = typeof rawPurchaseUrl === "string" ? rawPurchaseUrl.trim() : "";
  const intentId =
    typeof rawIntentId === "string" || typeof rawIntentId === "number" ? String(rawIntentId).trim() : "";
  const details = err.body && typeof err.body === "object" ? `\n\nCREHQ response:\n${JSON.stringify(err.body, null, 2)}` : "";

  return {
    content: [
      {
        type: "text",
        text:
          `CREHQ affiliation resolution requires user-approved purchase (HTTP 402): ${err.message}` +
          `\npurchase_url: ${purchaseUrl || "not returned"}` +
          `\nCREHQ intent_id: ${intentId || "not returned"}. Use this exact intent_id for follow-up.` +
          "\nAfter checkout, CREHQ emails a new Pro key. Install that key in this MCP client, reconnect, and then retry the resolver call; the current credential is not upgraded in place." +
          details,
      },
    ],
    isError: true,
  };
}

async function resolveAffiliation(c: CrehqClient, a: Record<string, unknown>): Promise<ToolContent> {
  const input = affiliationInput(a);
  if (!input.url && !input.venue_name && !input.address) {
    return {
      content: [
        {
          type: "text",
          text: "Provide at least one identity input: url, venue_name, or address.",
        },
      ],
      isError: true,
    };
  }

  try {
    return ok(await c.resolveEntityAffiliation(input));
  } catch (err) {
    if (err instanceof CrehqApiError && err.status === 402) return affiliationPaymentRequired(err);
    return fail(err);
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: "crehq_request_upgrade",
    requiredScope: SCOPE_BASIC,
    description:
      "Use this when the user asks CREHQ for data that is NOT included in the free sandbox: CREHQ Credit Signals / credit-intelligence profiles, ownership/sponsor/capital-structure/rating-history data, site-selection criteria, real-estate requirements, tenant requirements, franchise/FDD data, Item 19 financials, real-estate contacts, source provenance, event/change history, bulk dataset downloads, whitespace analysis, co-tenancy, modeled site profiles, recent location context with traffic/demographics, site timeline, point-in-time occupancy, or higher limits. This returns a clear upgrade prompt and records the requested topic as a CREHQ paywall/upgrade-intent signal for follow-up. Do NOT tell the user CREHQ lacks credit signals, modeled site profiles, or recent traffic/demographic context merely because the free footprint endpoint omits them.",
    schema: {
      requested_data: z
        .enum([
          "franchise_fdd",
          "item19_financials",
          "credit_signals",
          "credit_profile",
          "credit_rating",
          "site_selection_criteria",
          "real_estate_requirements",
          "real_estate_contacts",
          "source_provenance",
          "change_history",
          "bulk_download",
          "whitespace",
          "co_tenancy",
          "modeled_site_profile",
          "recent_location_context",
          "site_timeline",
          "other",
        ])
        .describe("The paid data category the user asked for, including credit signals, modeled site profiles, recent traffic/demographic context, site-selection criteria, or real-estate requirements."),
      brand: z.string().optional().describe("Optional brand slug/name involved in the request, e.g. 'taco-bell'."),
      question: z.string().optional().describe("The user's original request or short summary."),
    },
    handler: async (c, a) => {
      const requested = String(a.requested_data ?? "other");
      const field = upgradeIntentFields[requested] ?? "provenance";
      const brand = typeof a.brand === "string" && a.brand.trim() ? a.brand.trim() : undefined;

      if (c.apiSurface === "selfserve") {
        try {
          await c.request("/selfserve/locations", {
            query: { brand, fields: field, limit: 1 },
          });
        } catch (err) {
          if (err instanceof CrehqApiError && err.status === 402) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `CREHQ has this type of data, but "${requested}" is not included in the free sandbox tier. ` +
                    `The request${brand ? ` for ${brand}` : ""} has been recorded as upgrade intent. ` +
                    `Upgrade or request production access at https://crehq.com/developers/sandbox/` +
                    intentIdLine(err) +
                    (a.question ? `\n\nUser request: ${String(a.question)}` : ""),
                },
              ],
              isError: true,
            };
          }
          return fail(err);
        }
      }

      return {
        content: [
          {
            type: "text",
            text:
              `The user asked for "${requested}"${brand ? ` for ${brand}` : ""}. ` +
              "If their current CREHQ contract does not include this data, upgrade the key/tier and re-authorize the connector. " +
              "Production and Intelligence access: https://crehq.com/developers/sandbox/",
          },
        ],
        isError: true,
      };
    },
  },

  {
    name: "crehq_resolve_entity_affiliation",
    requiredScope: SCOPE_BASIC,
    description:
      "Resolve a public venue or business identity across hotels, restaurants, retail, healthcare, banks, auto dealers, EV charging, and other location categories. Use this when the user asks which chain or brand a venue belongs to, who operates or owns a location, or whether a venue is independent. Provide at least one of url, venue_name, or address; additional identity hints improve disambiguation. Returns affiliation_status (branded, independent, not_a_commercial_venue, or unresolved), canonical name, entity type, brand, operator, parent company, confidence, evidence, and checked time. Treat independent, not_a_commercial_venue, and unresolved as valid outcomes; never invent an affiliation beyond the returned evidence. If paid access is required, preserve the exact purchase_url and CREHQ intent_id for user-approved checkout, then install the newly emailed Pro key and reconnect before retrying.",
    schema: {
      url: z.string().trim().url().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//, "URL must use http:// or https://").max(2048).optional().describe("Public venue/business website URL using http:// or https://."),
      venue_name: z.string().trim().min(1).max(200).optional().describe("Venue or business name, used alone or to disambiguate the URL."),
      address: z.string().trim().min(1).max(300).optional().describe("Street address, city/region, and country when known."),
      session_id: z.string().trim().min(1).max(96).optional().describe("Optional stable caller session id for attribution and post-purchase retry."),
      source: z.enum(["landing_page", "mcp", "api", "cli", "unknown"]).optional().describe("Optional non-secret source label. Defaults to mcp."),
    },
    handler: resolveAffiliation,
  },

  // ========================================================================
  // COMPANIES / BRANDS
  // ========================================================================
  {
    name: "crehq_companies_list",
    requiredScope: SCOPE_BASIC,
    description:
      "List franchise & multi-unit brands (companies) tracked in CREHQ's canonical, multi-source government-verified location database — restaurants, retail, banks, auto dealers, healthcare, hotels, EV charging and more. Filter by category or expansion status to discover brands actively opening or closing units. Each record links to verified store counts, FDD financials, real-estate criteria, and decision-maker contacts. Paginated.",
    schema: {
      category: z
        .string()
        .optional()
        .describe("Filter by vertical/category slug, e.g. 'restaurant', 'bank', 'auto-dealer', 'ev-charging'."),
      expansion_status: z
        .enum(["expanding", "stable", "contracting"])
        .optional()
        .describe("Filter brands by growth trajectory derived from location lifecycle data."),
      per_page: perPage,
      page,
    },
    handler: (c, a) =>
      call(() =>
        c.request("/companies", {
          query: {
            category: a.category as string,
            expansion_status: a.expansion_status as string,
            per_page: a.per_page as number,
            page: a.page as number,
          },
        }),
      ),
  },
  {
    name: "crehq_companies_search",
    requiredScope: SCOPE_BASIC,
    description:
      "Full-text search CREHQ's brand universe by name to resolve a company to its canonical CREHQ id. Handles messy/alias names (e.g. 'mcdonald-s' → McDonald's Corporation). ALWAYS use this first to get a company_id before calling company detail, franchise/FDD, real-estate, contacts, occupancy, whitespace, or co-tenancy tools.",
    schema: {
      q: z.string().min(1).describe("Search term — brand or company name (partial OK)."),
      per_page: perPage,
    },
    handler: (c, a) =>
      c.apiSurface === "selfserve"
        ? call(() => c.request("/selfserve/brand-resolve", { query: { q: a.q as string, limit: a.per_page as number } }))
        : call(() => c.request("/companies/search", { query: { q: a.q as string, per_page: a.per_page as number } })),
  },
  {
    name: "crehq_company_get",
    requiredScope: SCOPE_BASIC,
    description:
      "Get a single brand's canonical CREHQ profile: verified current location count, vertical/category, parent/ownership (incl. private-equity backing where known), geographic footprint summary, and verification trace. The authoritative, de-duplicated source-of-truth record for a brand.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_company_credit_signals",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM CREDIT INTELLIGENCE — get CREHQ Credit Signals for a brand: ownership and parent/issuer context, PE sponsor data, rating history, capital structure, debt/maturity/covenant facts, unit-count trajectory, footprint status counts, and material events. Use this when the user asks about tenant credit, creditworthiness, lender diligence, leverage, ratings, sponsor ownership, or distress/health signals for a brand. Requires credit-intel / read:intelligence access; if this tool is unavailable or scope-gated, use crehq_request_upgrade with requested_data='credit_signals' instead of saying CREHQ lacks the data.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/credit-signals`)),
  },
  {
    name: "crehq_company_franchise",
    requiredScope: SCOPE_BASIC,
    description:
      "Retrieve FDD (Franchise Disclosure Document)-derived financials for a brand: franchise fees, royalty rates, total initial investment ranges, and Item 19 financial performance representations where disclosed. Sourced and multi-source-verified from state franchise registries — the hard numbers an analyst, investor, or prospective franchisee needs to underwrite a concept.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/franchise`)),
  },
  {
    name: "crehq_company_real_estate",
    requiredScope: SCOPE_BASIC,
    description:
      "Get a brand's site-selection criteria and target real-estate profile: preferred site types, building/lot size, target geographies and trade areas, and expansion markets. Essential for landlords, brokers, and site-selectors who want to know what a tenant is looking for before pitching them space.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/real-estate`)),
  },
  {
    name: "crehq_company_contacts",
    requiredScope: SCOPE_BASIC,
    description:
      "Get real-estate decision-maker contacts for a brand (development, site-selection, and franchising roles) compiled from public records and the brand's own disclosures. The shortcut from 'which brand is expanding' to 'who do I email'.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/contacts`)),
  },

  // ========================================================================
  // SITE SELECTION  (CREHQ self-serve routes; visible on selfserve AND full keys)
  // ========================================================================
  {
    name: "crehq_brand_cotenancy",
    requiredScope: SCOPE_BASIC,
    description:
      "What actually sits next to a brand: CREHQ's measured spatial adjacency across the brand's US estate. Returns neighbouring brands and venue classes with the share of the brand's locations that have them nearby, and a lift figure comparing this brand against others on the same neighbour. Use it to defend a tenant mix (\"Qdoba sits within 0.25mi of a Starbucks at 53% of its locations\"). This is adjacency, never a lease or a co-tenancy clause, and it does not prove causation.",
    schema: {
      company: z.string().describe("CREHQ brand slug or company_id. Resolve a name with crehq_companies_search first."),
      band: z.enum(["0.10mi", "0.25mi"]).optional().describe("Radius band. Default 0.25mi."),
      kind: z.enum(["brand", "venue_class"]).optional().describe("Limit to named brands, or to venue classes like grocery or fitness_center."),
      limit: z.number().int().min(1).max(50).optional().describe("Neighbours to return (default 20)."),
      include_noncommercial: z
        .boolean()
        .optional()
        .describe("ATM networks, EV chargers, nonprofit-registry addresses and libraries are left out by default. Set true to include them."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/cotenancy", {
          query: {
            company: String(a.company),
            band: a.band as string,
            kind: a.kind as string,
            limit: a.limit as number,
            include_noncommercial: a.include_noncommercial ? "1" : undefined,
          },
        }),
      ),
  },
  {
    name: "crehq_brand_economics",
    requiredScope: SCOPE_BASIC,
    description:
      "A franchise brand's published costs to a franchisee — initial franchise fee, total investment range, royalty and ad-fund rates, liquid capital and net worth required — but ONLY figures CREHQ verified verbatim against the Franchise Disclosure Document it holds, each with the quoted sentence. A field comes back null with verified false when CREHQ has not checked it; report that as unverified rather than substituting a number from elsewhere. These are franchisor costs, not rent and not landlord income.",
    schema: {
      company: z.string().describe("CREHQ brand slug or company_id. Resolve a name with crehq_companies_search first."),
    },
    handler: (c, a) => call(() => c.request("/selfserve/brand-economics", { query: { company: String(a.company) } })),
  },
  {
    name: "crehq_access_summary",
    requiredScope: SCOPE_BASIC,
    description:
      "What THIS CREHQ key can and cannot reach, in plain terms: the access level, what is included, what CREHQ holds that this key does not include and why, and the row limits per brand and per month. Call this when a tool is refused, before telling the user CREHQ lacks the data — CREHQ may hold it while this key does not include it.",
    schema: {},
    handler: (c) => call(() => c.request("/selfserve/access-summary")),
  },
  // ========================================================================
  // TEAM WORKSPACES — the team's OWN shortlists, notes and saved sites.
  // These call /selfserve/teams/... (crehq-teams-api.php). They hold what the
  // team's members wrote, never CREHQ data, and the API answers only for teams
  // the key's account belongs to. Brands are never guessed: the API refuses a
  // name that is not an exact match and returns did_you_mean instead.
  // ========================================================================
  {
    name: "crehq_team_list",
    requiredScope: SCOPE_BASIC,
    description:
      "Call this FIRST before any other crehq_team_* tool: the team workspaces this CREHQ account belongs to, with id, slug, role, window and counts. A team workspace holds the team's own shortlists, compare boards, saved sites and notes written by its members (not CREHQ data), and nothing here reaches another team's workspace.",
    schema: {},
    handler: (c) => call(() => c.request("/selfserve/teams")),
  },
  {
    name: "crehq_team_items",
    requiredScope: SCOPE_BASIC,
    description:
      "The brands and sites on a team's shortlist or one of its lists (its own picks, not CREHQ data; nothing from other teams). Each brand item carries the CREHQ id, slug and name to pass to the other tools.",
    schema: {
      team: teamRef,
      list_id: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("A list id from crehq_team_list / the team's lists, or 0 for the unfiled shortlist only. Omit for every item on the team."),
      item_type: z.enum(["brand", "site"]).optional().describe("Only brands or only sites."),
    },
    handler: (c, a) =>
      call(() => c.request(teamPath(a.team, "/items"), { query: { list_id: a.list_id as number, item_type: a.item_type as string } })),
  },
  {
    name: "crehq_team_item_add",
    requiredScope: SCOPE_BASIC,
    description:
      "Add a CREHQ brand to a team's own shortlist (or one of its lists) — the team's own list, not CREHQ data, never another team's; idempotent, the same brand twice returns the existing item. Pass the brand's slug or company_id (an exact brand name also works) and never invent one: when unsure, resolve it with crehq_companies_search first, and if the API answers brand_not_found with did_you_mean, ask the user rather than picking a suggestion silently.",
    schema: {
      team: teamRef,
      brand: z
        .string()
        .trim()
        .min(1)
        .describe("CREHQ brand slug (preferred) or company_id, or the EXACT brand name. Partial names are refused with did_you_mean."),
      list_id: z.number().int().positive().optional().describe("Add to this list (shortlist or compare board); omit for the team's unfiled shortlist."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(teamPath(a.team, "/items"), {
          method: "POST",
          body: { item_type: "brand", ref: String(a.brand).trim(), list_id: a.list_id as number | undefined },
        }),
      ),
  },
  {
    name: "crehq_team_item_remove",
    requiredScope: SCOPE_BASIC,
    description:
      "Remove one item from a team's own shortlist or list by its item id (from crehq_team_items). This changes only the team's own list, not CREHQ data, and never another team's.",
    schema: {
      team: teamRef,
      item_id: z.number().int().positive().describe("The item id from crehq_team_items (not the brand's company_id)."),
    },
    handler: (c, a) => call(() => c.request(teamPath(a.team, `/items/${Number(a.item_id)}`), { method: "DELETE" })),
  },
  {
    name: "crehq_team_note_add",
    requiredScope: SCOPE_BASIC,
    description:
      "Write a note in a team's workspace on a brand, a saved site, a list or the team itself; @Name mentions a team member. Notes are the team's own working notes (visible to its members and staff, never to another team), not CREHQ data. For a brand target pass the slug or company_id — never a guessed name — and put what the note rests on (tool names, URLs, figures) in evidence.",
    schema: {
      team: teamRef,
      target_type: z.enum(["brand", "site", "list", "team"]).describe("What the note is about."),
      target: z
        .string()
        .trim()
        .optional()
        .describe("brand: CREHQ slug / company_id / exact brand name; site or list: its id; team: omit."),
      body: z.string().trim().min(1).max(20000).describe("The note text (plain text; @Name mentions a team member)."),
      evidence: z
        .record(z.unknown())
        .optional()
        .describe("Optional JSON object with what the note rests on: tool names, URLs, figures, run ids."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(teamPath(a.team, "/notes"), {
          method: "POST",
          body: {
            target_type: a.target_type,
            target_id: typeof a.target === "string" && a.target.trim() ? a.target.trim() : undefined,
            body: a.body,
            evidence: a.evidence,
          },
        }),
      ),
  },
  {
    name: "crehq_team_notes",
    requiredScope: SCOPE_BASIC,
    description:
      "Read a team's notes, optionally only those on one brand, site, list or the team. They are the team members' own working notes (may be wrong or out of date), not CREHQ data, and never another team's.",
    schema: {
      team: teamRef,
      target_type: z.enum(["brand", "site", "list", "team"]).optional().describe("Limit to notes on this kind of target."),
      target: z.string().trim().optional().describe("With target_type: brand slug / company_id, site id or list id."),
      limit: z.number().int().min(1).max(200).optional().describe("Notes to return, newest first (default 100)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(teamPath(a.team, "/notes"), {
          query: { target_type: a.target_type as string, target_id: a.target as string, limit: a.limit as number },
        }),
      ),
  },
  {
    name: "crehq_team_site_save",
    requiredScope: SCOPE_BASIC,
    description:
      "Save (or, with id, update) a site the team is evaluating — name, address, coordinates, suites and the traffic/population/income the team measured — in the team's own workspace so members and the site selector can reuse it. It stores the team's own inputs, not CREHQ data, and never another team's site.",
    schema: {
      team: teamRef,
      id: z.number().int().positive().optional().describe("Existing site id to update; omit to create."),
      name: z.string().trim().max(191).optional().describe("Site label, e.g. 'Sagamore Pkwy endcap'."),
      address: z.string().trim().max(255).optional(),
      city: z.string().trim().max(64).optional(),
      state: usStateCode.optional().describe("2-letter US state code."),
      postal_code: z.string().trim().max(64).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      suites: z
        .array(z.object({ name: z.string().trim().min(1).max(64), sqft: z.number().int().positive().optional() }))
        .max(100)
        .optional()
        .describe("Available suites, e.g. [{name:'A', sqft:1800}]."),
      inputs: z
        .object({
          aadt: nonNegativeInt.optional().describe("Annual average daily traffic measured at the site."),
          population: nonNegativeInt.optional().describe("Population within radius_mi."),
          hhi: nonNegativeInt.optional().describe("Household income (USD) within radius_mi."),
          radius_mi: z.number().positive().optional().describe("Radius in miles the population/income cover."),
        })
        .optional()
        .describe("What the team measured at the site, for crehq_site_selector_match."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(teamPath(a.team, "/sites"), {
          method: "POST",
          body: {
            id: a.id,
            name: a.name,
            address: a.address,
            city: a.city,
            state: upperState(a.state),
            postal_code: a.postal_code,
            lat: a.lat,
            lng: a.lng,
            suites: a.suites,
            inputs: a.inputs,
          },
        }),
      ),
  },
  {
    name: "crehq_team_site_runs",
    requiredScope: SCOPE_BASIC,
    description:
      "The site-selector runs a team saved for one of its own sites (site id from crehq_team_list / crehq_team_items), newest first, each with the parameters used and a snapshot of the result at that time. These are the team's own saved snapshots (never another team's), not CREHQ data and not a live answer: re-run crehq_site_selector_match for current results.",
    schema: {
      team: teamRef,
      site_id: z.number().int().positive().describe("The team's site id."),
      limit: z.number().int().min(1).max(200).optional().describe("Runs to return (default 20)."),
    },
    handler: (c, a) =>
      call(() => c.request(teamPath(a.team, `/sites/${Number(a.site_id)}/runs`), { query: { limit: a.limit as number } })),
  },
  {
    name: "crehq_site_selector_match",
    requiredScope: SCOPE_BASIC,
    description:
      "CREHQ's tenant-shortlist engine for a vacant unit. Describe the space (size, site type, state, category) and, optionally, what you measured at the site (AADT traffic, population and household income within a radius) and its co-tenants; it returns a ranked list of brands that could fit. It keeps two kinds of evidence apart: STATED fit, from what a brand PUBLISHES about the space it wants, and REVEALED fit, from percentiles over where the brand actually operates today across its current US estate. Coverage is uneven: many brands publish no requirements, and revealed percentiles exist only where CREHQ has the underlying location and context data. Every response carries measured coverage in `limits`, and the response `notes` explain how the criteria were applied. Read `limits` and `notes` before concluding a brand does not fit: a missing published value or thin revealed coverage is not evidence of a mismatch, and include_unknown=true keeps brands that lack evidence for a criterion. A shortlist entry is evidence for outreach, not confirmation that the brand wants this site. Use crehq_company_site_requirements to see one brand's published criteria and sources. Pass the site's lat and lng to learn, per brand, whether it ALREADY operates within market_radius miles (market_presence: in_market, locations_within_radius, nearest_miles); presence=absent turns the shortlist into brands NOT YET in that market, the usual question for a new development. Presence is a footprint fact from CREHQ's active US locations, never evidence that a brand wants the market.",
    schema: {
      sqft: z.number().int().positive().optional().describe("Size of the vacant unit in square feet."),
      site_type: z
        .string()
        .trim()
        .toLowerCase()
        .regex(siteTypeListPattern, `site_type must be a comma list of: ${SITE_SELECTOR_SITE_TYPES.join(", ")}.`)
        .optional()
        .describe(`Comma-separated site type(s) of the unit. Allowed: ${SITE_SELECTOR_SITE_TYPES.join(", ")}.`),
      category: z.string().trim().min(1).optional().describe("Optional brand category to shortlist within, e.g. 'restaurant'."),
      state: usStateCode.optional().describe("2-letter US state of the site, e.g. 'IN'."),
      lat: z.number().min(-90).max(90).optional().describe("Site latitude in decimal degrees. Give lat AND lng to get market_presence on every brand."),
      lng: z.number().min(-180).max(180).optional().describe("Site longitude in decimal degrees (negative across the US)."),
      market_radius: z
        .union([z.literal(1), z.literal(3), z.literal(5), z.literal(10), z.literal(25)])
        .optional()
        .describe("Straight-line radius in miles for the presence test: 1, 3, 5, 10 or 25 ONLY. Defaults to 10. Any other value is refused, never rounded."),
      presence: z
        .enum(["any", "absent", "present"])
        .optional()
        .describe("Needs lat and lng. absent = keep only brands with NO active US location within the radius ('not yet in this market'); present = only brands already there; any (default) = keep all and just report presence."),
      aadt_actual: nonNegativeInt.optional().describe("Annual average daily traffic (vehicles/day) you measured at the site."),
      population_actual: nonNegativeInt.optional().describe("Population you measured within `radius` miles of the site."),
      hhi_actual: nonNegativeInt.optional().describe("Household income (USD) you measured within `radius` miles of the site."),
      radius: z.number().int().positive().optional().describe("Radius in miles that your population/income measurements cover."),
      revealed_strictness: z
        .enum(["core", "operating", "rank"])
        .optional()
        .describe("How strictly revealed (current-estate) evidence is applied: core, operating, or rank. The response notes describe how the chosen mode was applied."),
      cotenants: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Comma-separated CREHQ brand slugs of existing co-tenants at or next to the site, e.g. 'target,starbucks'."),
      cotenant_class: z.string().trim().min(1).optional().describe("Optional co-tenant class label for the site, passed to CREHQ as-is."),
      include_unknown: z
        .boolean()
        .optional()
        .describe("When true, keep brands that have no stated or revealed evidence for a criterion instead of dropping them."),
      franchise_available: z
        .boolean()
        .optional()
        .describe("When true, limit to brands CREHQ records as offering franchises; brands with unrecorded franchise status may be excluded."),
      sort: z.enum(["score", "name", "locations", "size", "fit"]).optional().describe("Sort order: score, name, locations, size, or fit."),
      page,
      per_page: z.number().int().min(1).max(50).optional().describe("Results per page (max 50)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/site-selector/match", {
          query: {
            sqft: a.sqft as number,
            site_type: commaList(a.site_type),
            category: a.category as string,
            state: upperState(a.state),
            lat: a.lat as number,
            lng: a.lng as number,
            market_radius: a.market_radius as number,
            presence: a.presence as string,
            aadt_actual: a.aadt_actual as number,
            population_actual: a.population_actual as number,
            hhi_actual: a.hhi_actual as number,
            radius: a.radius as number,
            revealed_strictness: a.revealed_strictness as string,
            cotenants: commaList(a.cotenants),
            cotenant_class: a.cotenant_class as string,
            include_unknown: a.include_unknown as boolean,
            franchise_available: a.franchise_available as boolean,
            sort: a.sort as string,
            page: a.page as number,
            per_page: a.per_page as number,
          },
        }),
      ),
  },
  {
    name: "crehq_brands_matching_site",
    requiredScope: SCOPE_BASIC,
    description:
      "Match a described site (size, site type, traffic, population, income, co-tenants, state) against the site requirements CREHQ has recorded for brands, and return the brands that are compatible. Give the site's lat and lng to learn, per brand, whether it ALREADY operates within market_radius_miles (market_presence); presence=absent keeps only brands NOT YET in that market, a footprint fact and never evidence the brand wants the market. Recorded requirements are partial: many brands have none, so a brand's absence from the results is not proof it would reject the site (include_unknown=true keeps brands with no recorded value for a criterion). For a full vacant-unit shortlist that separates published (stated) requirements from where brands actually operate (revealed) and reports coverage, prefer crehq_site_selector_match.",
    schema: {
      sqft: z.number().int().positive().optional().describe("Size of the unit in square feet."),
      site_type: z.string().trim().min(1).optional().describe("Site type of the unit, e.g. 'endcap' or 'freestanding'."),
      aadt: nonNegativeInt.optional().describe("Annual average daily traffic (vehicles/day) at the site."),
      population: nonNegativeInt.optional().describe("Population within radius_miles of the site."),
      hhi: nonNegativeInt.optional().describe("Household income (USD) within radius_miles of the site."),
      radius_miles: z.number().positive().optional().describe("Radius in miles for the population/income values."),
      lat: z.number().min(-90).max(90).optional().describe("Site latitude in decimal degrees. Give lat AND lng to get market_presence on every brand."),
      lng: z.number().min(-180).max(180).optional().describe("Site longitude in decimal degrees (negative across the US)."),
      market_radius_miles: z
        .union([z.literal(1), z.literal(3), z.literal(5), z.literal(10), z.literal(25)])
        .optional()
        .describe("Straight-line radius in miles for the presence test: 1, 3, 5, 10 or 25 ONLY. Defaults to 10. Any other value is refused, never rounded."),
      presence: z
        .enum(["any", "absent", "present"])
        .optional()
        .describe("Needs lat and lng. absent = keep only brands with NO active US location within the radius ('not yet in this market'); present = only brands already there; any (default) = keep all and report presence."),
      cotenants: z.string().trim().min(1).optional().describe("Comma-separated CREHQ brand slugs of existing co-tenants."),
      category: z.string().trim().min(1).optional().describe("Optional brand category filter."),
      state: usStateCode.optional().describe("2-letter US state of the site."),
      limit: z.number().int().min(1).optional().describe("Maximum number of brands to return."),
      include_unknown: z
        .boolean()
        .optional()
        .describe("When true, keep brands with no recorded value for a criterion instead of excluding them."),
      require_envelope_fit: z
        .boolean()
        .optional()
        .describe("When true, require the site to fit within each brand's recorded requirement envelope (stricter; fewer results)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/brands-matching-site", {
          query: {
            sqft: a.sqft as number,
            site_type: commaList(a.site_type),
            aadt: a.aadt as number,
            population: a.population as number,
            hhi: a.hhi as number,
            radius_miles: a.radius_miles as number,
            cotenants: commaList(a.cotenants),
            category: a.category as string,
            state: upperState(a.state),
            lat: a.lat as number,
            lng: a.lng as number,
            market_radius_miles: a.market_radius_miles as number,
            presence: a.presence as string,
            limit: a.limit as number,
            include_unknown: a.include_unknown as boolean,
            require_envelope_fit: a.require_envelope_fit as boolean,
          },
        }),
      ),
  },
  {
    name: "crehq_company_site_requirements",
    requiredScope: SCOPE_BASIC,
    description:
      "Get one brand's PUBLISHED site-selection criteria as CREHQ has recorded them: unit size, site types, lease terms, traffic, population, household income, and co-tenancy text, each with its source. These are what the brand states it wants, not a measurement of where it operates. Published criteria are often partial, dated, or absent; a missing field means CREHQ has no published value, not that the brand has no requirement. Check the sources before quoting a requirement as current.",
    schema: {
      company: z
        .union([z.string().trim().min(1).max(200), z.number().int().positive()])
        .describe("CREHQ brand slug (e.g. 'planet-fitness') or numeric company id."),
    },
    handler: (c, a) =>
      call(() => c.request("/selfserve/company-requirements", { query: { company: String(a.company) } })),
  },
  {
    name: "crehq_brand_investment",
    requiredScope: SCOPE_BASIC,
    description:
      "A franchise brand's estimated initial investment table (FDD Item 7) as printed in its latest Franchise Disclosure Document: the total range plus each line item (franchise fee, rent and deposits, build-out, equipment, signage, inventory, working capital...) with low/high dollars, when it is due and who is paid. Only figures CREHQ matched verbatim against the filing text are returned; line_items_status says whether the rows reconciled to the printed total. These are the franchisor's published costs to a franchisee, not rent. Needs a Researcher Pass on the key's account (402 otherwise). Resolve a name with crehq_companies_search first.",
    schema: {
      company: z
        .union([z.string().trim().min(1).max(200), z.number().int().positive()])
        .describe("CREHQ brand slug (e.g. 'wingstop') or numeric company id."),
    },
    handler: (c, a) =>
      call(() => c.request("/selfserve/brand-investment", { query: { company: String(a.company) } })),
  },
  {
    name: "crehq_brand_expansion",
    requiredScope: SCOPE_BASIC,
    description:
      "Where a franchise brand is growing, by US state, from its latest Franchise Disclosure Document (FDD Item 20): franchised outlets at the start and end of the latest fiscal year with openings, terminations, non-renewals, reacquisitions and other closures per state (Table 3), plus agreements signed but not yet open and the franchisor's PROJECTED new franchised and company-owned openings for the next fiscal year per state (Table 5). Pass state (two-letter code) to get one state's row, e.g. 'IN' for brands planning Indiana openings. Every row shown was matched verbatim against the filing; a state that is absent was not listed or did not verify, which is not zero. Projected openings are stated plans, not commitments. Needs a Researcher Pass on the key's account (402 otherwise).",
    schema: {
      company: z
        .union([z.string().trim().min(1).max(200), z.number().int().positive()])
        .describe("CREHQ brand slug or numeric company id. Resolve a name with crehq_companies_search first."),
      state: z
        .string()
        .trim()
        .length(2)
        .optional()
        .describe("Optional two-letter US state code to return just that state's row (e.g. 'IN')."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/brand-expansion", {
          query: { company: String(a.company), state: a.state ? String(a.state).toUpperCase() : undefined },
        }),
      ),
  },

  // ========================================================================
  // LOCATIONS
  // ========================================================================
  {
    name: "crehq_locations_list",
    requiredScope: SCOPE_BASIC,
    description:
      "List individual store/branch/site records, filterable by brand, US state, and category. Each location carries a stable entity_uid, geocoded address, open/closed status, and a multi-source verification trace. The raw, government-cross-checked footprint behind any brand. This free/sandbox footprint output does NOT include credit signals, ownership/rating history, capital structure, or tenant-credit diligence; for those requests use crehq_company_credit_signals if available, otherwise call crehq_request_upgrade with requested_data='credit_signals'. " +
      selfServeGuidanceNote,
    schema: {
      brand: z.string().optional().describe("Brand slug or name to filter by (e.g. 'planet-fitness')."),
      state: z.string().optional().describe("US state, 2-letter code or full name (e.g. 'TX')."),
      country: z
        .string()
        .optional()
        .describe("Self-serve keys: 2-letter ISO country code (e.g. 'ES') to pick the market for brands CREHQ serves per country. With state= it must be US."),
      category: z.string().optional().describe("Vertical/category slug."),
      include_provenance: z
        .boolean()
        .optional()
        .describe("For CREHQ Pro self-serve keys, include D2 provenance, source, confidence and first-observed fields. Free sandbox keys will return upgrade intent."),
      per_page: perPage,
      page,
    },
    handler: (c, a) =>
      c.apiSurface === "selfserve"
        ? a.brand
          ? call(() =>
              c.request("/selfserve/locations", {
                query: {
                  brand: a.brand as string,
                  state: a.state as string,
                  country: a.country as string,
                  limit: (a.per_page as number) ?? 25,
                  page: a.page as number,
                  fields: a.include_provenance ? d2LocationFields : undefined,
                },
              }),
            )
          : Promise.resolve({
              content: [
                {
                  type: "text",
                  text:
                    "Free CREHQ sandbox keys require a bounded location query. " +
                    "For this tool, pass a brand slug/name such as brand=\"starbucks\". " +
                    "Use crehq_locations_nearby for lat/lng radius searches.",
                },
              ],
              isError: true,
            })
        : call(() =>
            c.request("/locations", {
              query: {
                brand: a.brand as string,
                state: a.state as string,
                category: a.category as string,
                per_page: a.per_page as number,
                page: a.page as number,
              },
            }),
          ),
  },
  {
    name: "crehq_purchased_datasets_list",
    requiredScope: SCOPE_BASIC,
    description:
      "List dataset snapshots purchased by the owner of the connected CREHQ self-serve key. Use this before querying a buyer-owned dataset through MCP. It shows snapshot_as_of, hosted_access_until, whether hosted MCP querying is active, and whether the buyer still owns the file snapshot after hosted access expires.",
    schema: {
      include_expired: z
        .boolean()
        .optional()
        .describe("Include expired hosted-access snapshots. Defaults to true so the agent can explain owned-file vs hosted-MCP access."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/datasets", {
          query: { include_expired: a.include_expired as boolean },
        }),
      ),
  },
  {
    name: "crehq_intelligence_preview",
    requiredScope: SCOPE_BASIC,
    description:
      "For CREHQ Pro self-serve keys, spend the key's one monthly controlled intelligence preview credit. Returns a bounded evidence frame for a tenant-credit, site-selection, co-tenancy, franchise, or monitoring question without exposing raw premium tables or redistribution rights. Free keys receive a 402 upgrade prompt; full enterprise keys should use the dedicated premium tools directly.",
    schema: {
      brand: z.string().optional().describe("Tenant/brand slug or name, e.g. 'family-dollar'."),
      preview_type: z
        .enum(["credit_brief", "site_selection", "cotenancy", "franchise", "monitoring"])
        .optional()
        .describe("Type of controlled intelligence preview. Defaults to credit_brief."),
      question: z.string().optional().describe("Short user question to frame the preview."),
    },
    handler: (c, a) =>
      c.apiSurface === "selfserve"
        ? call(() =>
            c.request("/selfserve/intelligence-preview", {
              method: "POST",
              body: {
                brand: a.brand as string,
                preview_type: (a.preview_type as string) ?? "credit_brief",
                question: a.question as string,
              },
            }),
          )
        : Promise.resolve({
            content: [
              {
                type: "text",
                text:
                  "Controlled intelligence previews are for self-serve Pro keys. This key appears to use the full CREHQ API surface; use the dedicated premium tools such as crehq_company_credit_signals, whitespace, co-tenancy, or site-profile tools when the contract includes them.",
              },
            ],
          }),
  },
  {
    name: "crehq_purchased_dataset_locations",
    requiredScope: SCOPE_BASIC,
    description:
      "Query rows from a dataset snapshot the connected key owner has purchased. This is for buyer-owned point-in-time snapshots, not live CREHQ refresh. The response includes snapshot_as_of, hosted_access_until, artifact basis, and row results. If hosted access expired, it returns an upgrade/update-plan message while acknowledging that the buyer still owns the original file snapshot.",
    schema: {
      dataset: z.string().optional().describe("Purchased dataset slug, e.g. 'pilot-flying-j'."),
      purchase_id: z.number().int().positive().optional().describe("Specific CREHQ purchase id from crehq_purchased_datasets_list."),
      q: z.string().optional().describe("Optional text search across name/address/city/store id."),
      city: z.string().optional().describe("Optional city filter."),
      state: z.string().optional().describe("Optional 2-letter state filter."),
      country: z.string().optional().describe("Optional 2-letter country filter."),
      lat: z.number().optional().describe("Latitude for radius search."),
      lng: z.number().optional().describe("Longitude for radius search."),
      radius: z.number().positive().max(250).optional().describe("Radius in miles for lat/lng search, max 250."),
      per_page: perPage,
      page,
    },
    handler: (c, a) =>
      call(() =>
        c.request("/selfserve/dataset-locations", {
          query: {
            dataset: a.dataset as string,
            purchase_id: a.purchase_id as number,
            q: a.q as string,
            city: a.city as string,
            state: a.state as string,
            country: a.country as string,
            lat: a.lat as number,
            lng: a.lng as number,
            radius: a.radius as number,
            limit: (a.per_page as number) ?? 25,
            page: a.page as number,
          },
        }),
      ),
  },
  {
    name: "crehq_location_get",
    requiredScope: SCOPE_BASIC,
    description:
      "Get one location's full record by id: geocoded address, brand, lifecycle status, attributes (e.g. drive-thru, square footage, fuel/EV ports where applicable), and the sources that verify it exists.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ location id.") },
    handler: (c, a) => call(() => c.request(`/locations/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_locations_search",
    requiredScope: SCOPE_BASIC,
    description:
      "Search locations across multiple fields at once — name, brand, street address, city/state/geography. Use when you have a fuzzy description of a physical place rather than an id.",
    schema: {
      name: z.string().optional().describe("Location or brand name fragment."),
      brand: z.string().optional().describe("Brand slug/name."),
      address: z.string().optional().describe("Street address fragment."),
      state: z.string().optional().describe("US state code or name."),
      city: z.string().optional().describe("City name."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() =>
        c.request("/locations/search", {
          query: {
            name: a.name as string,
            brand: a.brand as string,
            address: a.address as string,
            state: a.state as string,
            city: a.city as string,
            per_page: a.per_page as number,
          },
        }),
      ),
  },
  {
    name: "crehq_locations_nearby",
    requiredScope: SCOPE_BASIC,
    description:
      "Radius search: find all tracked locations within N miles of a lat/lng point. Powers trade-area analysis, competitor mapping, and 'what's near this address' questions. Returns distance-sorted, government-verified storefronts across every vertical CREHQ covers. " +
      selfServeGuidanceNote,
    schema: {
      lat: z.number().describe("Latitude (decimal degrees)."),
      lng: z.number().describe("Longitude (decimal degrees)."),
      radius_mi: z.number().min(0.1).max(100).optional().describe("Search radius in miles (default 5)."),
      brand: z.string().optional().describe("Optional: restrict to one brand."),
      category: z.string().optional().describe("Optional: restrict to one vertical/category."),
      include_noncommercial: z
        .boolean()
        .optional()
        .describe(
          "Radius results leave out IRS nonprofit-registry addresses, ATM networks, EV chargers and libraries by default. Set true to include them (e.g. counting chargers or civic anchors near a site)."
        ),
      include_provenance: z
        .boolean()
        .optional()
        .describe("For CREHQ Pro self-serve keys, include D2 provenance, source, confidence and first-observed fields. Free sandbox keys will return upgrade intent."),
      per_page: perPage,
    },
    handler: (c, a) =>
      c.apiSurface === "selfserve"
        ? call(() =>
            c.request("/selfserve/locations", {
              query: {
                lat: a.lat as number,
                lng: a.lng as number,
                radius: (a.radius_mi as number) ?? 5,
                brand: a.brand as string,
                limit: (a.per_page as number) ?? 25,
                fields: a.include_provenance ? d2LocationFields : undefined,
                include_noncommercial: a.include_noncommercial ? "1" : undefined,
              },
            }),
          )
        : call(() =>
            c.request("/locations/nearby", {
              query: {
                lat: a.lat as number,
                lng: a.lng as number,
                radius_mi: a.radius_mi as number,
                brand: a.brand as string,
                category: a.category as string,
                per_page: a.per_page as number,
                include_noncommercial: a.include_noncommercial ? "1" : undefined,
              },
            }),
          ),
  },
  {
    name: "crehq_locations_bulk",
    requiredScope: SCOPE_BASIC,
    description:
      "Bulk location retrieval for ETL/pipeline use: fetch many locations in one call by a list of ids, a list of brands, or a GeoJSON polygon (e.g. a custom market boundary). Use this instead of looping single-location calls when hydrating a dataset.",
    schema: {
      ids: z.array(z.union([z.string(), z.number()])).optional().describe("Explicit list of location ids/entity_uids."),
      brands: z.array(z.string()).optional().describe("List of brand slugs to pull all locations for."),
      polygon: z
        .unknown()
        .optional()
        .describe("GeoJSON Polygon/MultiPolygon geometry; returns locations inside the boundary."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() =>
        c.request("/locations/bulk", {
          method: "POST",
          body: { ids: a.ids, brands: a.brands, polygon: a.polygon, per_page: a.per_page },
        }),
      ),
  },
  {
    name: "crehq_locations_events",
    requiredScope: SCOPE_BASIC,
    description:
      "Pull the cross-brand location LIFECYCLE STREAM — openings, closings, relocations, ownership/brand changes — since a timestamp. The real-time expansion/contraction signal that drives prospecting, market-monitoring, and 'who's moving right now' alerts. Returns a next-since cursor for incremental polling.",
    schema: {
      since: z
        .string()
        .describe("ISO-8601 timestamp; returns events on/after this time. Use the returned next_since_cursor for the next poll."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() => c.request("/locations/events", { query: { since: a.since as string, per_page: a.per_page as number } })),
  },
  {
    name: "crehq_location_history",
    requiredScope: SCOPE_BASIC,
    description:
      "Full append-only event log for ONE physical store/site (by entity_uid): every open/close/rebrand/attribute change CREHQ has recorded, with dates and sources. Time-series provenance for a single location.",
    schema: {
      entity_uid: z.string().describe("Stable CREHQ entity_uid for the location."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max events to return (default 200, max 1000)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(`/locations/${encodeURIComponent(a.entity_uid as string)}/history`, {
          query: { limit: a.limit as number },
        }),
      ),
  },

  // ========================================================================
  // CHANGES / OCCUPANCY / SITE TIMELINE  (flagship differentiators)
  // ========================================================================
  {
    name: "crehq_company_changes",
    requiredScope: SCOPE_BASIC,
    description:
      "Date-bounded feed of everything that changed for ONE brand's footprint — openings, closings, relocations, attribute edits — between two timestamps and optionally filtered by event type. The brand-scoped version of the lifecycle stream, ideal for monitoring a target account.",
    schema: {
      id: z.union([z.string(), z.number()]).describe("CREHQ company id."),
      since: z.string().optional().describe("ISO-8601 start timestamp."),
      until: z.string().optional().describe("ISO-8601 end timestamp."),
      types: z.string().optional().describe("Comma-separated event types to include (e.g. 'opened,closed,relocated')."),
      limit: z.number().int().min(1).max(5000).optional().describe("Max events (default 500, max 5000)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(`/companies/${encodeURIComponent(String(a.id))}/changes`, {
          query: { since: a.since as string, until: a.until as string, types: a.types as string, limit: a.limit as number },
        }),
      ),
  },
  {
    name: "crehq_company_occupancy",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — POINT-IN-TIME roster: reconstruct exactly which locations a brand operated on a given historical date. Answers 'how many units did this chain have on 2022-01-01 and where' — true historical footprint, not just today's count. Powers growth-curve and same-store analysis. (Intel & Enterprise tiers.)",
    schema: {
      id: z.union([z.string(), z.number()]).describe("CREHQ company id."),
      date: z.string().optional().describe("ISO date (YYYY-MM-DD) for the snapshot; omit for current."),
      limit: z.number().int().min(1).max(10000).optional().describe("Max rows (default 1000, max 10000)."),
      offset: z.number().int().min(0).optional().describe("Row offset for pagination."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(`/companies/${encodeURIComponent(String(a.id))}/occupancy`, {
          query: { date: a.date as string, limit: a.limit as number, offset: a.offset as number },
        }),
      ),
  },
  {
    name: "crehq_site_timeline",
    requiredScope: SCOPE_INTEL,
    description:
      "FLAGSHIP DIFFERENTIATOR (PREMIUM) — given a physical site (site_uid), return the full chronological tenancy history: every brand that has EVER occupied that address and when. Answers 'this was a Blockbuster, then a Sprint store, now a Chipotle.' Unmatched for backfill/teardown analysis, second-generation space, and landlord due diligence. (Intel & Enterprise tiers.)",
    schema: { site_uid: z.string().describe("Stable CREHQ site_uid for the physical address.") },
    handler: (c, a) => call(() => c.request(`/sites/${encodeURIComponent(a.site_uid as string)}/timeline`)),
  },

  // ========================================================================
  // INTELLIGENCE  (premium: Intel + Enterprise tiers)
  // ========================================================================
  {
    name: "crehq_whitespace",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — whitespace analysis: postal codes/markets where a brand's competitors are present and performing but the brand itself is ABSENT. The ranked, data-driven shortlist of where a chain should expand next. Built on CREHQ's full multi-vertical, government-verified footprint. (Intel & Enterprise tiers.)",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id to analyze."),
      country: z.string().optional().describe("ISO country code (default 'US')."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/intelligence/whitespace", {
          query: { company_id: String(a.company_id), country: (a.country as string) ?? "US" },
        }),
      ),
  },
  {
    name: "crehq_co_tenancy",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — co-tenancy analysis: which brands most often co-locate within a given radius of this brand's stores (the chains that cluster together: e.g. who anchors near Chipotle). Drives site-selection, anchor-tenant matching, and trade-area benchmarking. (Intel & Enterprise tiers.)",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id to analyze."),
      radius_meters: z.number().int().min(10).max(5000).optional().describe("Co-location radius in meters (default 200)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/intelligence/co-tenancy", {
          query: { company_id: String(a.company_id), radius_meters: (a.radius_meters as number) ?? 200 },
        }),
      ),
  },
  {
    name: "crehq_location_site_profile",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — CREHQ Modeled Site Profile for one physical location: traffic/AADT, route class, trade-area demographics, radius demographics, drive-time context, nearby tenants, format signals, lifecycle timing, and provenance/coverage flags. This is CREHQ-modeled from observed location/context data, not a brand-stated requirement sheet. The backing REST route is staged until Mark approves production publication.",
    schema: {
      entity_id: z.union([z.string(), z.number()]).describe("CREHQ location entity_id."),
    },
    handler: (c, a) =>
      call(() => c.request(`/intelligence/site-profiles/locations/${encodeURIComponent(String(a.entity_id))}`)),
  },
  {
    name: "crehq_company_site_pattern",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — CREHQ Modeled Site Pattern for a brand: empirical medians, ranges, percentiles, road-type mix, co-tenant mix, trade-area density, recent-location context, and layer coverage/confidence. Use this to infer revealed-preference site patterns from where the brand actually operates. Do not present it as company-stated requirements unless the response includes stated-requirement provenance. The backing REST route is staged until Mark approves production publication.",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id to model."),
      country: z.string().optional().describe("ISO country code filter (default 'US' where modeled context layers are available)."),
      include_locations: z.boolean().optional().describe("Include representative location rows in the response (default false)."),
      limit: z.number().int().min(1).max(500).optional().describe("Max representative rows when include_locations=true."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(`/intelligence/site-profiles/companies/${encodeURIComponent(String(a.company_id))}`, {
          query: {
            country: a.country as string,
            include_locations: a.include_locations as boolean,
            limit: a.limit as number,
          },
        }),
      ),
  },
  {
    name: "crehq_recent_location_context",
    requiredScope: SCOPE_INTEL,
    description:
      "PREMIUM INTELLIGENCE — context for a brand's most recently observed locations: event timing, address/market, traffic counts when backfilled, route class, trade-area demographics, radius demographics, drive-time context, and coverage flags. Useful for questions like 'traffic counts for the last 50 Starbucks locations CREHQ observed.' Event rows distinguish verified openings from first-observed/reconciliation events. The backing REST route is staged until Mark approves production publication.",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id."),
      country: z.string().optional().describe("ISO country code filter (default all available rows)."),
      event_type: z
        .enum(["first_observed", "opened", "closed", "reopened", "status_changed", "relocated", "renamed", "identifier_changed"])
        .optional()
        .describe("Lifecycle event type to use for recency (default first_observed)."),
      only_with_traffic: z.boolean().optional().describe("When true, return only recent rows with traffic/AADT attached."),
      limit: z.number().int().min(1).max(500).optional().describe("Max locations to return (default 50, max 500)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request(`/intelligence/site-profiles/companies/${encodeURIComponent(String(a.company_id))}/recent`, {
          query: {
            country: a.country as string,
            event_type: a.event_type as string,
            only_with_traffic: a.only_with_traffic as boolean,
            limit: a.limit as number,
          },
        }),
      ),
  },

  // ========================================================================
  // DATASETS
  // ========================================================================
  {
    name: "crehq_datasets_list",
    requiredScope: SCOPE_BASIC,
    description:
      "Browse CREHQ's catalog of packaged, ready-to-license datasets (whole-brand footprints, vertical rollups, FDD financials, etc.), filterable by category, country, and freshness. Each entry exposes row counts, schema, and refresh date — the menu of bulk data products.",
    schema: {
      category: z.string().optional().describe("Filter by category slug."),
      country: z.string().optional().describe("ISO country code filter."),
      freshness: z.string().optional().describe("Freshness filter (e.g. '30d', '90d')."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() =>
        c.request("/datasets", {
          query: {
            category: a.category as string,
            country: a.country as string,
            freshness: a.freshness as string,
            per_page: a.per_page as number,
          },
        }),
      ),
  },
  {
    name: "crehq_dataset_get",
    requiredScope: SCOPE_BASIC,
    description:
      "Get full metadata for one dataset by slug: row count, column schema, coverage, verification methodology, last-refresh date, and licensing notes — everything needed to evaluate it before download.",
    schema: { slug: z.string().describe("Dataset slug (from crehq_datasets_list).") },
    handler: (c, a) => call(() => c.request(`/datasets/${encodeURIComponent(a.slug as string)}`)),
  },
  {
    name: "crehq_dataset_download",
    requiredScope: SCOPE_BASIC,
    description:
      "Download a licensed dataset by slug in your chosen format (CSV, JSON, GeoJSON, or XLSX). Requires a tier/contract that includes the dataset. Returns the raw payload (or a signed link) for direct ingestion.",
    schema: {
      slug: z.string().describe("Dataset slug."),
      format: z.enum(["json", "csv", "geojson", "xlsx"]).optional().describe("Desired format (default json)."),
    },
    handler: (c, a) => {
      const format = (a.format as string) ?? "json";
      const acceptMap: Record<string, string> = {
        json: "application/json",
        csv: "text/csv",
        geojson: "application/geo+json",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      return call(() => c.request(`/datasets/${encodeURIComponent(a.slug as string)}/download`, { accept: acceptMap[format] }));
    },
  },
  {
    name: "crehq_dataset_categories",
    requiredScope: SCOPE_BASIC,
    description:
      "List all dataset categories with counts — a quick map of how CREHQ's data products are organized across verticals.",
    schema: {},
    handler: (c) => call(() => c.request("/datasets/categories")),
  },

  // ========================================================================
  // TRENDS
  // ========================================================================
  {
    name: "crehq_trends_company",
    requiredScope: SCOPE_BASIC,
    description:
      "Time-series trends for ONE brand: outlet-count history, fee/royalty trends, and FDD financial trajectory over time. The growth/health curve of a concept in a single call.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id.") },
    handler: (c, a) => call(() => c.request(`/trends/company/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_trends_geographic",
    requiredScope: SCOPE_BASIC,
    description:
      "Geographic trend analysis: metro/state concentration and opening/closing velocity across CREHQ's footprint. Surfaces which markets are heating up or cooling down across brands and verticals.",
    schema: {
      country: z.string().optional().describe("ISO country code (default 'US')."),
      category: z.string().optional().describe("Optional vertical/category filter."),
      state: z.string().optional().describe("Optional US state filter."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/trends/geographic", {
          query: { country: a.country as string, category: a.category as string, state: a.state as string },
        }),
      ),
  },
];

/** Convert a Zod raw shape to the JSON Schema the MCP SDK advertises to clients. */
export function toJsonSchema(shape: ZodRawShape): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(shape)) {
    properties[key] = zodToJson(def as ZodTypeAny);
    if (!(def as ZodTypeAny).isOptional()) required.push(key);
  }
  return { type: "object", properties, required };
}

/** Minimal Zod→JSON-Schema mapping covering the types used in this registry. */
function zodToJson(def: ZodTypeAny): Record<string, unknown> {
  const description = def.description;
  const base = (obj: Record<string, unknown>): Record<string, unknown> =>
    description ? { ...obj, description } : obj;

  const inner = def._def as {
    typeName: string;
    innerType?: ZodTypeAny;
    values?: string[];
    type?: ZodTypeAny;
    options?: ZodTypeAny[];
    checks?: Array<{ kind?: string; regex?: RegExp }>;
  };
  const typeName = inner.typeName;

  switch (typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return { ...zodToJson(inner.innerType as ZodTypeAny), ...(description ? { description } : {}) };
    case "ZodString":
      const regexCheck = inner.checks?.find((check) => check.kind === "regex" && check.regex instanceof RegExp);
      return base({
        type: "string",
        ...(inner.checks?.some((check) => check.kind === "url") ? { format: "uri" } : {}),
        ...(regexCheck?.regex ? { pattern: regexCheck.regex.source } : {}),
      });
    case "ZodNumber":
      return base({ type: "number" });
    case "ZodBoolean":
      return base({ type: "boolean" });
    case "ZodEnum":
      return base({ type: "string", enum: inner.values });
    case "ZodArray":
      return base({ type: "array", items: zodToJson(inner.type as ZodTypeAny) });
    case "ZodObject":
      return base(toJsonSchema((def as z.ZodObject<ZodRawShape>).shape));
    case "ZodRecord":
      return base({ type: "object" });
    case "ZodUnion": {
      const opts = (inner.options ?? []).map((o) => zodToJson(o));
      const types = Array.from(new Set(opts.map((o) => o.type).filter(Boolean)));
      return base({ type: types.length === 1 ? types[0] : types });
    }
    case "ZodUnknown":
    default:
      return base({});
  }
}
