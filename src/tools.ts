/**
 * CREHQ MCP tool registry.
 *
 * Each entry pairs an LLM-facing name + description (the description is a sales
 * surface — it tells Claude what CREHQ uniquely can answer) with a Zod input
 * schema and a handler that maps to one CREHQ REST endpoint.
 *
 * Endpoint contract sourced from https://crehq.com/developers/ and
 * https://crehq.com/apis/ (verified 2026-06-17).
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { CrehqApiError, type CrehqClient } from "./client.js";
import { ok, fail, type ToolContent } from "./format.js";

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (client: CrehqClient, args: Record<string, unknown>) => Promise<ToolContent>;
}

/** Run a request and normalize success/error into MCP content. */
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
const page = z.number().int().min(1).optional().describe("Page number for cursor/offset pagination (default 1).");

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
  site_timeline: "event_history",
  other: "provenance",
};

export const TOOLS: ToolDef[] = [
  {
    name: "crehq_request_upgrade",
    description:
      "Use this when the user asks CREHQ for data that is NOT included in the free sandbox: CREHQ Credit Signals / credit-intelligence profiles, ownership/sponsor/capital-structure/rating-history data, site-selection criteria, real-estate requirements, tenant requirements, franchise/FDD data, Item 19 financials, real-estate contacts, source provenance, event/change history, bulk dataset downloads, whitespace analysis, co-tenancy, site timeline, point-in-time occupancy, or higher limits. This returns a clear upgrade prompt and, for free sandbox keys, records the requested topic as a CREHQ paywall/upgrade-intent signal for follow-up. Do NOT tell the user CREHQ lacks credit signals, franchise/FDD, or site-selection data merely because the free footprint endpoint omits them.",
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
          "site_timeline",
          "other",
        ])
        .describe("The paid data category the user asked for, including credit signals, site-selection criteria or real-estate requirements."),
      brand: z.string().optional().describe("Optional brand slug/name involved in the request, e.g. 'taco-bell'."),
      question: z.string().optional().describe("The user's original request or short summary."),
    },
    handler: async (c, a) => {
      const requested = String(a.requested_data ?? "other");
      const field = upgradeIntentFields[requested] ?? "provenance";
      const brand = typeof a.brand === "string" && a.brand.trim() ? a.brand.trim() : undefined;

      if ((await c.apiSurface()) === "selfserve") {
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
              "If their current CREHQ contract does not include this data, upgrade the key/tier and reconnect this MCP server with the upgraded key. " +
              "Production and Intelligence access: https://crehq.com/developers/sandbox/",
          },
        ],
        isError: true,
      };
    },
  },

  // ========================================================================
  // COMPANIES / BRANDS
  // ========================================================================
  {
    name: "crehq_companies_list",
    description:
      "List franchise & multi-unit brands (companies) tracked in CREHQ's canonical, multi-source government-verified location database — restaurants, retail, banks, auto dealers, healthcare, hotels, EV charging and more. Filter by category or expansion status to discover brands actively opening or closing units. Each record links to verified store counts, FDD financials, real-estate criteria, and decision-maker contacts. Paginated.",
    schema: {
      category: z.string().optional().describe("Filter by vertical/category slug, e.g. 'restaurant', 'bank', 'auto-dealer', 'ev-charging'."),
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
          query: { category: a.category as string, expansion_status: a.expansion_status as string, per_page: a.per_page as number, page: a.page as number },
        }),
      ),
  },
  {
    name: "crehq_companies_search",
    description:
      "Full-text search CREHQ's brand universe by name to resolve a company to its canonical CREHQ id. Handles messy/alias names (e.g. 'mcdonald-s' → McDonald's Corporation). ALWAYS use this first to get a company_id before calling company detail, credit signals, franchise/FDD, real-estate, contacts, occupancy, whitespace, or co-tenancy tools.",
    schema: {
      q: z.string().min(1).describe("Search term — brand or company name (partial OK)."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() => c.request("/companies/search", { query: { q: a.q as string, per_page: a.per_page as number } })),
  },
  {
    name: "crehq_company_get",
    description:
      "Get a single brand's canonical CREHQ profile: verified current location count, vertical/category, parent/ownership (incl. private-equity backing where known), geographic footprint summary, and verification trace. The authoritative, de-duplicated source-of-truth record for a brand.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_company_credit_signals",
    description:
      "PREMIUM CREDIT INTELLIGENCE — get CREHQ Credit Signals for a brand: ownership and parent/issuer context, PE sponsor data, rating history, capital structure, debt/maturity/covenant facts, unit-count trajectory, footprint status counts, and material events. Use this when the user asks about tenant credit, creditworthiness, lender diligence, leverage, ratings, sponsor ownership, or distress/health signals for a brand. Requires credit-intel access; if unavailable or scope-gated, use crehq_request_upgrade with requested_data='credit_signals' instead of saying CREHQ lacks the data.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/credit-signals`)),
  },
  {
    name: "crehq_company_franchise",
    description:
      "Retrieve FDD (Franchise Disclosure Document)-derived financials for a brand: franchise fees, royalty rates, total initial investment ranges, and Item 19 financial performance representations where disclosed. Sourced and multi-source-verified from state franchise registries — the hard numbers an analyst, investor, or prospective franchisee needs to underwrite a concept.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/franchise`)),
  },
  {
    name: "crehq_company_real_estate",
    description:
      "PREMIUM SITE-SELECTION DATA — get a brand's site-selection criteria and target real-estate profile: preferred site types, building/lot size, target geographies and trade areas, and expansion markets. Essential for landlords, brokers, and site-selectors who want to know what a tenant is looking for before pitching them space. If unavailable or scope-gated, use crehq_request_upgrade with requested_data='site_selection_criteria' instead of saying CREHQ lacks site requirements.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/real-estate`)),
  },
  {
    name: "crehq_company_contacts",
    description:
      "Get real-estate decision-maker contacts for a brand (development, site-selection, and franchising roles) compiled from public records and the brand's own disclosures. The shortcut from 'which brand is expanding' to 'who do I email'.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id (from crehq_companies_search).") },
    handler: (c, a) => call(() => c.request(`/company/${encodeURIComponent(String(a.id))}/contacts`)),
  },

  // ========================================================================
  // LOCATIONS
  // ========================================================================
  {
    name: "crehq_locations_list",
    description:
      "List individual store/branch/site records, filterable by brand, US state, and category. Each location carries a stable entity_uid, geocoded address, open/closed status, and a multi-source verification trace. The raw, government-cross-checked footprint behind any brand. Free sandbox keys can use this as a bounded brand lookup. This footprint output does NOT include credit signals, ownership/rating history, capital structure, site-selection criteria, FDD/Item 19, or tenant-credit diligence; for those requests use the relevant premium tool if available, otherwise call crehq_request_upgrade with the matching requested_data value.",
    schema: {
      brand: z.string().optional().describe("Brand slug or name to filter by (e.g. 'planet-fitness')."),
      state: z.string().optional().describe("US state, 2-letter code or full name (e.g. 'TX')."),
      category: z.string().optional().describe("Vertical/category slug."),
      per_page: perPage,
      page,
    },
    handler: async (c, a) =>
      (await c.apiSurface()) === "selfserve"
        ? a.brand
          ? call(() =>
              c.request("/selfserve/locations", {
                query: {
                  brand: a.brand as string,
                  limit: (a.per_page as number) ?? 25,
                  page: a.page as number,
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
                    "Use crehq_locations_nearby for lat/lng radius searches, or crehq_request_upgrade for premium data like credit signals, FDD, site-selection criteria, contacts, provenance, or bulk downloads.",
                },
              ],
              isError: true,
            })
        : call(() =>
            c.request("/locations", {
              query: { brand: a.brand as string, state: a.state as string, category: a.category as string, per_page: a.per_page as number, page: a.page as number },
            }),
          ),
  },
  {
    name: "crehq_location_get",
    description:
      "Get one location's full record by id: geocoded address, brand, lifecycle status, attributes (e.g. drive-thru, square footage, fuel/EV ports where applicable), and the sources that verify it exists.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ location id.") },
    handler: (c, a) => call(() => c.request(`/locations/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_locations_search",
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
          query: { name: a.name as string, brand: a.brand as string, address: a.address as string, state: a.state as string, city: a.city as string, per_page: a.per_page as number },
        }),
      ),
  },
  {
    name: "crehq_locations_nearby",
    description:
      "Radius search: find all tracked locations within N miles of a lat/lng point. Powers trade-area analysis, competitor mapping, and 'what's near this address' questions. Returns distance-sorted, government-verified storefronts across every vertical CREHQ covers.",
    schema: {
      lat: z.number().describe("Latitude (decimal degrees)."),
      lng: z.number().describe("Longitude (decimal degrees)."),
      radius_mi: z.number().min(0.1).max(100).optional().describe("Search radius in miles (default 5)."),
      brand: z.string().optional().describe("Optional: restrict to one brand."),
      category: z.string().optional().describe("Optional: restrict to one vertical/category."),
      per_page: perPage,
    },
    handler: async (c, a) =>
      (await c.apiSurface()) === "selfserve"
        ? call(() =>
            c.request("/selfserve/locations", {
              query: {
                lat: a.lat as number,
                lng: a.lng as number,
                radius: (a.radius_mi as number) ?? 5,
                brand: a.brand as string,
                limit: (a.per_page as number) ?? 25,
              },
            }),
          )
        : call(() =>
            c.request("/locations/nearby", {
              query: { lat: a.lat as number, lng: a.lng as number, radius_mi: a.radius_mi as number, brand: a.brand as string, category: a.category as string, per_page: a.per_page as number },
            }),
          ),
  },
  {
    name: "crehq_locations_bulk",
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
    description:
      "Pull the cross-brand location LIFECYCLE STREAM — openings, closings, relocations, ownership/brand changes — since a timestamp. The real-time expansion/contraction signal that drives prospecting, market-monitoring, and 'who's moving right now' alerts. Returns a next-since cursor for incremental polling.",
    schema: {
      since: z.string().describe("ISO-8601 timestamp; returns events on/after this time. Use the returned next_since_cursor for the next poll."),
      per_page: perPage,
    },
    handler: (c, a) => call(() => c.request("/locations/events", { query: { since: a.since as string, per_page: a.per_page as number } })),
  },
  {
    name: "crehq_location_history",
    description:
      "Full append-only event log for ONE physical store/site (by entity_uid): every open/close/rebrand/attribute change CREHQ has recorded, with dates and sources. Time-series provenance for a single location.",
    schema: {
      entity_uid: z.string().describe("Stable CREHQ entity_uid for the location."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max events to return (default 200, max 1000)."),
    },
    handler: (c, a) =>
      call(() => c.request(`/locations/${encodeURIComponent(a.entity_uid as string)}/history`, { query: { limit: a.limit as number } })),
  },

  // ========================================================================
  // CHANGES / OCCUPANCY / SITE TIMELINE  (flagship differentiators)
  // ========================================================================
  {
    name: "crehq_company_changes",
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
    description:
      "POINT-IN-TIME roster: reconstruct exactly which locations a brand operated on a given historical date. Answers 'how many units did this chain have on 2022-01-01 and where' — true historical footprint, not just today's count. Powers growth-curve and same-store analysis.",
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
    description:
      "FLAGSHIP DIFFERENTIATOR — given a physical site (site_uid), return the full chronological tenancy history: every brand that has EVER occupied that address and when. Answers 'this was a Blockbuster, then a Sprint store, now a Chipotle.' Unmatched for backfill/teardown analysis, second-generation space, and landlord due diligence. No other location dataset reconstructs address-level succession like this.",
    schema: { site_uid: z.string().describe("Stable CREHQ site_uid for the physical address.") },
    handler: (c, a) => call(() => c.request(`/sites/${encodeURIComponent(a.site_uid as string)}/timeline`)),
  },

  // ========================================================================
  // INTELLIGENCE  (premium: Intel + Enterprise tiers)
  // ========================================================================
  {
    name: "crehq_whitespace",
    description:
      "PREMIUM INTELLIGENCE — whitespace analysis: postal codes/markets where a brand's competitors are present and performing but the brand itself is ABSENT. The ranked, data-driven shortlist of where a chain should expand next. Built on CREHQ's full multi-vertical, government-verified footprint. (Intel & Enterprise tiers.)",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id to analyze."),
      country: z.string().optional().describe("ISO country code (default 'US')."),
    },
    handler: (c, a) =>
      call(() => c.request("/intelligence/whitespace", { query: { company_id: String(a.company_id), country: (a.country as string) ?? "US" } })),
  },
  {
    name: "crehq_co_tenancy",
    description:
      "PREMIUM INTELLIGENCE — co-tenancy analysis: which brands most often co-locate within a given radius of this brand's stores (the chains that cluster together: e.g. who anchors near Chipotle). Drives site-selection, anchor-tenant matching, and trade-area benchmarking. (Intel & Enterprise tiers.)",
    schema: {
      company_id: z.union([z.string(), z.number()]).describe("CREHQ company id to analyze."),
      radius_meters: z.number().int().min(10).max(5000).optional().describe("Co-location radius in meters (default 200)."),
    },
    handler: (c, a) =>
      call(() =>
        c.request("/intelligence/co-tenancy", { query: { company_id: String(a.company_id), radius_meters: (a.radius_meters as number) ?? 200 } }),
      ),
  },
  {
    name: "crehq_location_site_profile",
    description:
      "CREHQ Modeled Site Profile for one physical location: traffic/AADT, route class, trade-area demographics, radius demographics, drive-time context, nearby tenants, format signals, lifecycle timing, and provenance/coverage flags. This is CREHQ-modeled from observed location/context data, not a brand-stated requirement sheet.",
    schema: {
      entity_id: z.union([z.string(), z.number()]).describe("CREHQ location entity_id."),
    },
    handler: (c, a) => call(() => c.request(`/intelligence/site-profiles/locations/${encodeURIComponent(String(a.entity_id))}`)),
  },
  {
    name: "crehq_company_site_pattern",
    description:
      "CREHQ Modeled Site Pattern for a brand: empirical medians, ranges, percentiles, road-type mix, co-tenant mix, trade-area density, recent-opening context, and layer coverage/confidence. Use this to infer revealed-preference site patterns from where the brand actually operates. Do not present it as company-stated requirements unless the response includes stated-requirement provenance.",
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
    description:
      "Context for a brand's most recently observed locations: event timing, address/market, traffic counts when backfilled, route class, trade-area demographics, radius demographics, drive-time context, and coverage flags. Useful for questions like 'traffic counts for the last 50 Starbucks locations CREHQ observed.' Event rows distinguish verified openings from first-observed/reconciliation events.",
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
    description:
      "Browse CREHQ's catalog of packaged, ready-to-license datasets (whole-brand footprints, vertical rollups, FDD financials, etc.), filterable by category, country, and freshness. Each entry exposes row counts, schema, and refresh date — the menu of bulk data products.",
    schema: {
      category: z.string().optional().describe("Filter by category slug."),
      country: z.string().optional().describe("ISO country code filter."),
      freshness: z.string().optional().describe("Freshness filter (e.g. '30d', '90d')."),
      per_page: perPage,
    },
    handler: (c, a) =>
      call(() => c.request("/datasets", { query: { category: a.category as string, country: a.country as string, freshness: a.freshness as string, per_page: a.per_page as number } })),
  },
  {
    name: "crehq_dataset_get",
    description:
      "Get full metadata for one dataset by slug: row count, column schema, coverage, verification methodology, last-refresh date, and licensing notes — everything needed to evaluate it before download.",
    schema: { slug: z.string().describe("Dataset slug (from crehq_datasets_list).") },
    handler: (c, a) => call(() => c.request(`/datasets/${encodeURIComponent(a.slug as string)}`)),
  },
  {
    name: "crehq_dataset_download",
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
    description: "List all dataset categories with counts — a quick map of how CREHQ's data products are organized across verticals.",
    schema: {},
    handler: (c) => call(() => c.request("/datasets/categories")),
  },

  // ========================================================================
  // TRENDS
  // ========================================================================
  {
    name: "crehq_trends_company",
    description:
      "Time-series trends for ONE brand: outlet-count history, fee/royalty trends, and FDD financial trajectory over time. The growth/health curve of a concept in a single call.",
    schema: { id: z.union([z.string(), z.number()]).describe("CREHQ company id.") },
    handler: (c, a) => call(() => c.request(`/trends/company/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: "crehq_trends_geographic",
    description:
      "Geographic trend analysis: metro/state concentration and opening/closing velocity across CREHQ's footprint. Surfaces which markets are heating up or cooling down across brands and verticals.",
    schema: {
      country: z.string().optional().describe("ISO country code (default 'US')."),
      category: z.string().optional().describe("Optional vertical/category filter."),
      state: z.string().optional().describe("Optional US state filter."),
    },
    handler: (c, a) =>
      call(() => c.request("/trends/geographic", { query: { country: a.country as string, category: a.category as string, state: a.state as string } })),
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

  const inner = def as unknown as { _def: { typeName: string; innerType?: ZodTypeAny; values?: string[]; type?: ZodTypeAny; options?: ZodTypeAny[] } };
  const typeName = inner._def.typeName;

  switch (typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return { ...zodToJson(inner._def.innerType as ZodTypeAny), ...(description ? { description } : {}) };
    case "ZodString":
      return base({ type: "string" });
    case "ZodNumber":
      return base({ type: "number" });
    case "ZodBoolean":
      return base({ type: "boolean" });
    case "ZodEnum":
      return base({ type: "string", enum: inner._def.values });
    case "ZodArray":
      return base({ type: "array", items: zodToJson(inner._def.type as ZodTypeAny) });
    case "ZodUnion": {
      // Used for id fields that accept string|number.
      const opts = (inner._def.options ?? []).map((o) => zodToJson(o));
      const types = Array.from(new Set(opts.map((o) => o.type).filter(Boolean)));
      return base({ type: types.length === 1 ? types[0] : types });
    }
    case "ZodUnknown":
    default:
      return base({});
  }
}
