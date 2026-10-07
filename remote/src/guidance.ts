/**
 * Relay the guidance the CREHQ self-serve API puts in its own responses —
 * coverage notes, row budgets, full-dataset offers, upgrade links, brand
 * suggestions, market scope and Enhanced (D2) preview labels — as short,
 * agent-readable lines.
 *
 * Every number shown comes from the response itself. Do NOT add hard-coded
 * limits here: budgets differ per tier and per brand, and the API reports the
 * exact values on every call.
 *
 * Kept identical in src/guidance.ts (stdio package) and
 * remote/src/guidance.ts (hosted server).
 */

type Obj = Record<string, unknown>;

interface Suggestion {
  slug: string;
  name?: string;
}

function isObj(value: unknown): value is Obj {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function count(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** 2861 -> "2,861" (locale-independent so output is identical in Node and Workers). */
function num(value: number): string {
  const [whole, fraction] = String(value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter((item): item is string => item !== undefined);
}

function suggestions(body: Obj): Suggestion[] {
  if (!Array.isArray(body.did_you_mean)) return [];
  const out: Suggestion[] = [];
  for (const item of body.did_you_mean) {
    const slug = isObj(item) ? text(item.slug) : text(item);
    if (!slug) continue;
    const name = isObj(item) ? text(item.name) : undefined;
    out.push(name && name !== slug ? { slug, name } : { slug });
  }
  return out;
}

/** Machine-readable error code: `error` (self-serve bodies) or `code` (WordPress REST errors). */
export function errorCode(body: unknown): string | undefined {
  if (!isObj(body)) return undefined;
  return text(body.error) ?? text(body.code);
}

/**
 * The API's own human message. When the API sent none (brand_not_found carries
 * only `error`, `hint` and `did_you_mean`), build one from the code.
 */
export function apiMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.length > 0 && body.length < 500 ? body : undefined;
  if (!isObj(body)) return undefined;
  const message = text(body.message);
  if (message) return message;
  const code = errorCode(body);
  if (!code) return undefined;
  if (code === "brand_not_found") {
    const brand = text(body.brand);
    const dym = suggestions(body).map((s) => (s.name ? `${s.slug} (${s.name})` : s.slug));
    return (
      `No CREHQ brand matches ${brand ? `"${brand}"` : "the requested brand"}.` +
      (dym.length > 0 ? ` Did you mean: ${dym.join(", ")}?` : "")
    );
  }
  return `CREHQ rejected the request (${code}).`;
}

/** One line describing a complete licensed file the API offers. */
export function fullDatasetLine(value: unknown, label = "full_dataset"): string | undefined {
  if (!isObj(value)) return undefined;
  const url = text(value.url);
  const name = text(value.name);
  if (!url && !name) return undefined;
  const details: string[] = [];
  const price = count(value.price_usd);
  if (price !== undefined) details.push(`$${num(price)}`);
  const tier = text(value.tier);
  if (tier) details.push(tier);
  const scope = text(value.scope);
  if (scope) details.push(`scope ${scope}`);
  const locations = count(value.location_count);
  if (locations !== undefined) details.push(`${num(locations)} locations`);
  return `${label}: ${name ?? "complete file"}${details.length > 0 ? ` (${details.join(", ")})` : ""}${url ? ` ${url}` : ""}`;
}

/** One line with the key's row budget exactly as the API reported it. */
export function rowBudgetLine(value: unknown): string | undefined {
  if (!isObj(value)) return undefined;
  const parts: string[] = [];
  const brandUsed = count(value.brand_used);
  const brandLimit = count(value.brand_limit);
  if (brandUsed !== undefined && brandLimit !== undefined) {
    let part = `this brand ${num(brandUsed)} of ${num(brandLimit)} rows used this month`;
    const left = count(value.brand_remaining);
    if (left !== undefined) part += `, ${num(left)} left`;
    const basis = text(value.brand_limit_basis);
    if (basis) part += ` (limit: ${basis})`;
    parts.push(part);
  }
  const monthUsed = count(value.month_used);
  const monthLimit = count(value.month_limit);
  if (monthUsed !== undefined && monthLimit !== undefined) {
    let part = `all brands ${num(monthUsed)} of ${num(monthLimit)} rows`;
    const left = count(value.month_remaining);
    if (left !== undefined) part += `, ${num(left)} left`;
    parts.push(part);
  }
  if (value.truncated === true) parts.push("this response was cut to the remaining budget");
  const resets = text(value.resets_at);
  if (resets) parts.push(`resets ${resets}`);
  return parts.length > 0 ? `row_budget: ${parts.join("; ")}` : undefined;
}

/** Guidance lines for a non-2xx response body: suggestions, markets, budgets, offers, upgrade links. */
export function errorGuidanceLines(body: unknown): string[] {
  if (!isObj(body)) return [];
  const lines: string[] = [];
  const code = errorCode(body);

  const dym = suggestions(body);
  if (dym.length > 0) lines.push(`did_you_mean (retry with brand=): ${dym.map((s) => s.slug).join(", ")}`);
  const hint = text(body.hint);
  if (hint) lines.push(`api_hint: ${hint}`);

  // WordPress REST errors carry their extras under `data` (e.g. ambiguous_county
  // candidates, unknown_county / unknown_category did_you_mean).
  const errData = isObj(body.data) ? body.data : undefined;
  if (errData) {
    const candidates = list(errData.candidates);
    if (candidates.length > 0) lines.push(`candidates: ${candidates.join("; ")}`);
    const dataDym = list(errData.did_you_mean);
    if (dataDym.length > 0) lines.push(`did_you_mean: ${dataDym.join("; ")}`);
  }

  const countries = list(body.available_countries);
  if (countries.length > 0) {
    const brand = text(body.brand);
    lines.push(`available_countries${brand ? ` for ${brand}` : ""} (retry with country=): ${countries.join(", ")}`);
  }

  if (code === "selector_cap") {
    const used = count(body.used);
    const cap = count(body.cap);
    if (used !== undefined && cap !== undefined) {
      const noun = text(body.selector_type) === "brand" ? "brands" : "areas";
      const period = text(body.period);
      const blocked = text(body.selector);
      lines.push(
        `selector_cap: ${num(used)} of ${num(cap)} distinct ${noun} used${period ? ` in ${period}` : ""}` +
          (blocked ? `; ${blocked} was not served` : ""),
      );
    }
  }

  if (code === "payment_required") {
    const field = text(body.field);
    if (field) {
      const extra = [text(body.data_tier), text(body.dataset_or_pack)].filter((v): v is string => !!v);
      lines.push(`gated_field: ${field}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`);
    }
    const intent = text(body.intent_id);
    if (intent) lines.push(`intent_id: ${intent}`);
  }

  if (code === "rate_limited") {
    const limitType = text(body.limit_type);
    if (limitType) lines.push(`limit_type: ${limitType}`);
  }

  const budget = rowBudgetLine(body.row_budget);
  if (budget) lines.push(budget);
  const full = fullDatasetLine(body.full_dataset);
  if (full) lines.push(full);
  const upgrade = text(body.upgrade_url);
  if (upgrade) lines.push(`upgrade_url: ${upgrade}`);
  const enterprise = text(body.enterprise_url);
  if (enterprise) lines.push(`enterprise_url: ${enterprise}`);
  return lines;
}

/**
 * Next-step suggestion for a self-serve error code, or undefined so the caller
 * falls back to its generic HTTP-status hint.
 */
/**
 * True when the API refused the key because it EXPIRED. WordPress reports this
 * under several codes (invalid_api_key, rest_forbidden_expired_api_key,
 * expired_token, api_key_expired), so the code alone is not enough: the
 * additive `data.reason` field or the message decides.
 */
export function isExpiredKey(body: unknown): boolean {
  if (!isObj(body)) return false;
  const code = errorCode(body);
  if (code === "api_key_expired" || code === "rest_forbidden_expired_api_key" || code === "expired_token") return true;
  const data = isObj(body.data) ? body.data : undefined;
  if (data && text(data.reason) === "expired") return true;
  return code === "invalid_api_key" && /expired/i.test(text(body.message) ?? "");
}

const EXPIRED_KEY_HINT =
  "The CREHQ key linked to this connector has EXPIRED. This is not a tier or data limit: do not offer an upgrade or checkout. " +
  "Remove and re-add the CREHQ connector (or re-authorize it) to sign in again and issue a fresh key; if the account's access itself has ended, " +
  "the user can check it at https://crehq.com/account/.";

export function hintForCode(body: unknown): string | undefined {
  if (!isObj(body)) return undefined;
  if (isExpiredKey(body)) return EXPIRED_KEY_HINT;
  switch (errorCode(body)) {
    case "invalid_api_key":
      return "The CREHQ key linked to this connector was not accepted (revoked, replaced or unknown). This is not a tier limit: do not offer an upgrade. Re-authorize the connector to link a current key.";
    case "terms_not_accepted":
      return "Sign in to CREHQ and accept the current competition terms, then retry. This is an account setup step; do not offer an upgrade or checkout.";
    case "pass_required":
    case "researcher_pass_required":
      return "Check the account's CREHQ access and confirm the connector is linked to the CREHQ account with the Researcher Pass or competition grant. Reconnect the correct account if needed; do not ask competition students to buy their granted access.";
    case "team_not_found":
    case "forbidden":
      return "Select a team listed for this account and check its membership role. Team membership and role restrictions are not resolved by purchasing an upgrade.";
    case "row_budget_exhausted":
      return (
        "Rows per brand are limited monthly on this key, and the budget in row_budget is used up. " +
        "Tell the user; do not retry with other filters, radii or pages (each one counts against the budget). " +
        "Check the account's CREHQ access. For competition access, use included aggregate tools where available or explain the reset; do not ask students to purchase their grant. Other accounts can consider full_dataset or upgrade_url."
      );
    case "selector_cap":
      return (
        "This key has reached its monthly limit of distinct brands/areas. Brands and areas already queried this month still work. " +
        "Check the account's CREHQ access before offering an upgrade. For competition access, reuse included selectors or explain the reset; do not send students to checkout."
      );
    case "pagination_capped":
      return "Do not request deeper pages; the sandbox is not a bulk-export path. Use included aggregate tools where available. Check the account's CREHQ access before offering a licensed dataset; competition students should not be sent to checkout.";
    case "brand_not_found":
      return suggestions(body).length > 0
        ? "If a did_you_mean slug is what the user meant, retry with that exact slug; otherwise ask the user for the exact brand name."
        : "Ask the user for the exact brand name, or try a catalog slug as api_hint suggests.";
    case "brand_market_not_available":
      return "Retry with country= set to one of available_countries, or tell the user CREHQ does not serve that market for this brand.";
    case "invalid_country":
      return "Fix country=: it must be a 2-letter ISO code, and when state= is set it must be US or omitted.";
    case "invalid_state":
      return "Pass a valid US state code or name as state=.";
    case "payment_required":
      return "This field is not included in this key's tier. Retry without it and check the account's CREHQ access for included alternatives. Do not send competition accounts to checkout for granted access.";
    case "rate_limited":
      return text(body.limit_type) === "quota"
        ? "This key's monthly call quota is used up. Explain the monthly reset. Check the account access before offering an upgrade; do not send competition accounts to checkout."
        : undefined;
    default:
      return undefined;
  }
}

function d2PreviewLines(data: Obj): string[] {
  const block = data.d2_preview;
  if (!isObj(block)) return [];
  const label = text(block.label) ?? "Enhanced (D2) preview";
  const parts: string[] = [];
  const product = text(block.product);
  if (product) parts.push(product);
  if (Array.isArray(block.fields)) {
    const fields: string[] = [];
    for (const item of block.fields) {
      const field = isObj(item) ? text(item.field) : text(item);
      if (!field) continue;
      const fill = isObj(item) ? count(item.fill_pct) : undefined;
      fields.push(fill !== undefined ? `${field} ${num(fill)}% filled` : field);
    }
    if (fields.length > 0) parts.push(`fields: ${fields.join(", ")}`);
  }
  const used = count(block.monthly_used);
  const limit = count(block.monthly_limit);
  if (used !== undefined && limit !== undefined) parts.push(`${num(used)} of ${num(limit)} preview rows used this month`);

  const lines = [`${label}: ${parts.join("; ")}`];
  const rows = Array.isArray(data.locations) ? data.locations.filter((row) => isObj(row) && isObj(row.d2_preview)).length : 0;
  if (rows > 0) {
    lines.push(
      `Rows with a "d2_preview" object (${num(rows)} here): those values are an Enhanced (D2) preview sample, not part of the free Location File.`,
    );
  }
  const note = text(block.note);
  if (note) lines.push(`Enhanced (D2) note: ${note}`);
  const full = fullDatasetLine(block.full_d2_dataset, "full_d2_dataset");
  if (full) lines.push(full);
  return lines;
}

/**
 * Site context (/selfserve/site/context): access level, sections that are not covered,
 * could not be confirmed or are stale, capped lists, and what CREHQ does not hold.
 * Detected by shape (a sections object plus a not_crehq list). Never adds an upgrade
 * offer the API did not send: upgrade_url is absent for competition accounts.
 */
export function siteContextLines(data: Obj): string[] {
  if (!isObj(data.sections) || !Array.isArray(data.not_crehq)) return [];
  const lines: string[] = [];
  const access = isObj(data.access) ? data.access : undefined;
  const level = access ? text(access.level) : undefined;
  if (level) {
    const basis = access ? text(access.basis) : undefined;
    let line = `site_context: access ${level}${basis ? ` (${basis})` : ""}`;
    if (level === "summary") {
      line += "; one headline per section plus coverage flags";
      const upgrade = access ? text(access.upgrade_url) : undefined;
      if (upgrade) line += `; the full report needs a Researcher Pass or a Pro API key: ${upgrade}`;
    }
    lines.push(line);
  }
  for (const [id, raw] of Object.entries(data.sections)) {
    if (!isObj(raw)) continue;
    const note = text(raw.note);
    if (raw.covered === false) {
      lines.push(`${id}: not covered here (not held, not zero)${note ? `. ${note}` : ""}`);
    } else if (raw.covered === null) {
      lines.push(`${id}: coverage could not be confirmed${note ? `. ${note}` : ""}`);
    }
    if (raw.stale === true) {
      const vintage = text(raw.vintage);
      lines.push(`${id}: stale${vintage ? ` (vintage ${vintage})` : ""}; a newer release exists than the one loaded`);
    }
    if (isObj(raw.rows_capped)) {
      for (const [list, cap] of Object.entries(raw.rows_capped)) {
        if (!isObj(cap)) continue;
        const returned = count(cap.returned);
        const available = count(cap.available);
        if (returned !== undefined && available !== undefined) {
          lines.push(`${id}.${list}: ${num(returned)} of ${num(available)} rows returned (key's per-call cap)`);
        }
      }
    }
  }
  const topics = data.not_crehq
    .map((item) => (isObj(item) ? text(item.topic) : undefined))
    .filter((topic): topic is string => topic !== undefined);
  if (topics.length > 0) {
    lines.push(`not_crehq: CREHQ does not hold ${topics.join("; ")}. Relay where_to_get_it instead of estimating these.`);
  }
  return lines;
}

/** Guidance lines for a successful self-serve response: coverage, paging, budgets, offers, D2 preview. */
export function successGuidanceLines(data: unknown): string[] {
  if (!isObj(data)) return [];
  const lines: string[] = [];
  const coverageNone = text(data.coverage) === "none";
  if (coverageNone) {
    lines.push(`coverage: none. ${text(data.message) ?? "CREHQ has no published locations for this brand yet."}`);
  }

  // Parameters the API did not apply, and its own notices (2026-10-07): first, so an
  // agent never presents unfiltered rows as filtered.
  const ignored = list(data.ignored_params);
  if (ignored.length > 0) {
    lines.push(`ignored_params: ${ignored.join(", ")} (the API did not apply these; the rows are NOT filtered by them)`);
  }
  for (const notice of list(data.notices)) lines.push(`notice: ${notice}`);

  const selector = isObj(data.selector) ? data.selector : undefined;
  const selectedBrand = selector ? text(selector.brand) : undefined;
  const resolvedFrom = text(data.resolved_from);
  if (resolvedFrom) {
    lines.push(
      `resolved_from: "${resolvedFrom}" was matched to brand ${selectedBrand ?? "(see selector)"}; use that slug in follow-up calls`,
    );
  }

  if (isObj(data.market_scope)) {
    const scope = data.market_scope;
    const country = text(scope.country);
    const basis = text(scope.basis);
    lines.push(
      `market_scope: ${country ? `country ${country}` : "one market"}${selectedBrand ? `, brand ${selectedBrand}` : ""}` +
        `${basis ? ` (basis ${basis})` : ""}; these rows cover that market only`,
    );
  }

  const total = count(data.total_available);
  if (total !== undefined && !coverageNone) {
    const showing = isObj(data.showing) ? data.showing : undefined;
    const from = showing ? count(showing.from) : undefined;
    const to = showing ? count(showing.to) : undefined;
    let line =
      from !== undefined && to !== undefined
        ? `results: showing ${num(from)}–${num(to)} of ${num(total)} total_available`
        : `results: ${num(total)} total_available`;
    if (typeof data.has_more === "boolean") line += `; has_more: ${data.has_more}`;
    if (data.end_of_results === true) line += "; end_of_results: true";
    lines.push(line);
  }

  const note = text(data.coverage_note);
  if (note) lines.push(`coverage_note: ${note}`);
  const budget = rowBudgetLine(data.row_budget);
  if (budget) lines.push(budget);
  const full = fullDatasetLine(data.full_dataset);
  if (full) lines.push(full);
  lines.push(...d2PreviewLines(data));
  lines.push(...siteContextLines(data));
  return lines;
}
