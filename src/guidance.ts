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
export function hintForCode(body: unknown): string | undefined {
  if (!isObj(body)) return undefined;
  switch (errorCode(body)) {
    case "row_budget_exhausted":
      return (
        "Rows per brand are limited monthly on this key, and the budget in row_budget is used up. " +
        "Tell the user; do not retry with other filters, radii or pages (each one counts against the budget). " +
        "Offer full_dataset for the complete file, or upgrade_url for a larger monthly budget."
      );
    case "selector_cap":
      return (
        "This key has reached its monthly limit of distinct brands/areas. Brands and areas already queried this month still work. " +
        "Offer upgrade_url, or enterprise_url for broad or production use."
      );
    case "pagination_capped":
      return "Do not request deeper pages; the sandbox is not a bulk-export path. Offer the licensed dataset (full_dataset from an earlier page, or upgrade_url).";
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
      return "This field is not included in this key's tier. Retry without it, or offer the user upgrade_url.";
    case "rate_limited":
      return text(body.limit_type) === "quota"
        ? "This key's monthly call quota is used up. Offer upgrade_url, or wait for the monthly reset."
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

/** Guidance lines for a successful self-serve response: coverage, paging, budgets, offers, D2 preview. */
export function successGuidanceLines(data: unknown): string[] {
  if (!isObj(data)) return [];
  const lines: string[] = [];
  const coverageNone = text(data.coverage) === "none";
  if (coverageNone) {
    lines.push(`coverage: none. ${text(data.message) ?? "CREHQ has no published locations for this brand yet."}`);
  }

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
  return lines;
}
