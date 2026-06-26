/**
 * Thin HTTP client for the CREHQ REST API (https://crehq.com/wp-json/crehq/v1).
 *
 * Responsibilities:
 *  - Inject the API key (Authorization: Bearer + X-API-Key, per the docs).
 *  - Build query strings / JSON bodies.
 *  - Map HTTP failures (401/403/404/429/4xx/5xx) into clear, agent-readable
 *    errors that point the user at the sandbox signup when appropriate.
 *  - Surface CREHQ pagination + cache + stream headers to the caller.
 */

export const DEFAULT_API_BASE = "https://crehq.com/wp-json/crehq/v1";
const SANDBOX_URL = "https://crehq.com/developers/sandbox/";
const USER_AGENT = "crehq-mcp-server/0.1.6";
export type CrehqApiSurface = "auto" | "selfserve" | "full";

export interface CrehqConfig {
  apiKey: string;
  apiBase: string;
  timeoutMs: number;
  apiSurface: CrehqApiSurface;
}

/** Headers worth surfacing back to the agent (pagination, cache, event streams). */
const SURFACED_HEADERS = [
  "x-wp-total",
  "x-wp-totalpages",
  "x-crehq-next-since",
  "x-crehq-cache",
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "retry-after",
  "link",
];

export interface CrehqResult {
  /** Parsed JSON body (object or array), or raw text when not JSON. */
  data: unknown;
  /** Selected response headers (pagination/cache/stream cursors). */
  meta: Record<string, string>;
}

/**
 * Error that carries enough context for the tool layer to produce a helpful,
 * non-fatal message back to the LLM instead of crashing the server.
 */
export class CrehqApiError extends Error {
  readonly status: number;
  readonly hint: string;
  readonly body?: unknown;

  constructor(status: number, message: string, hint = "", body?: unknown) {
    super(message);
    this.name = "CrehqApiError";
    this.status = status;
    this.hint = hint;
    this.body = body;
  }
}

export function loadConfig(): CrehqConfig {
  const apiKey = (process.env.CREHQ_API_KEY ?? "").trim();
  const apiBase = (process.env.CREHQ_API_BASE ?? DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(process.env.CREHQ_TIMEOUT_MS ?? "30000", 10) || 30000;
  const rawSurface = (process.env.CREHQ_API_SURFACE ?? "auto").trim().toLowerCase();
  const apiSurface: CrehqApiSurface =
    rawSurface === "selfserve" || rawSurface === "full" ? rawSurface : "auto";
  return { apiKey, apiBase, timeoutMs, apiSurface };
}

type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  /** Query string parameters; undefined/null values are dropped. */
  query?: Record<string, QueryValue>;
  /** JSON request body (for POST/PUT). */
  body?: unknown;
  /** Desired representation, sent as the Accept header (e.g. text/csv). */
  accept?: string;
}

export class CrehqClient {
  private detectedApiSurface?: "selfserve" | "full";

  constructor(private readonly config: CrehqConfig) {}

  /** True when no key is configured — lets tools fail fast with guidance. */
  get hasKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  /**
   * Detect whether the configured key is a free self-serve sandbox key.
   * Sandbox keys are intentionally restricted to `/selfserve/*`; full keys use
   * the broader REST API. The detection is cached for the MCP process lifetime.
   */
  async apiSurface(): Promise<"selfserve" | "full"> {
    if (this.config.apiSurface === "selfserve" || this.config.apiSurface === "full") {
      return this.config.apiSurface;
    }
    if (this.detectedApiSurface) return this.detectedApiSurface;
    if (!this.hasKey) {
      this.detectedApiSurface = "full";
      return this.detectedApiSurface;
    }

    this.detectedApiSurface = (await this.probeSelfserveUsage()) ? "selfserve" : "full";
    return this.detectedApiSurface;
  }

  /**
   * Perform a request against a CREHQ endpoint path (e.g. "/companies").
   * Throws CrehqApiError on any non-2xx response or transport failure.
   */
  async request(path: string, opts: RequestOptions = {}): Promise<CrehqResult> {
    if (!this.hasKey) {
      throw new CrehqApiError(
        401,
        "No CREHQ_API_KEY configured.",
        `Set the CREHQ_API_KEY environment variable. Get a free sandbox key at ${SANDBOX_URL}.`,
      );
    }

    const url = new URL(this.config.apiBase + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      // The CREHQ docs accept either header; we send both for maximum
      // compatibility across gateway configurations.
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-API-Key": this.config.apiKey,
      Accept: opts.accept ?? "application/json",
      "User-Agent": USER_AGENT,
    };

    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    init.signal = controller.signal;

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new CrehqApiError(
          504,
          `Request to ${path} timed out after ${this.config.timeoutMs}ms.`,
          "Retry, narrow the query (smaller per_page / tighter filters), or raise CREHQ_TIMEOUT_MS.",
        );
      }
      throw new CrehqApiError(
        0,
        `Network error calling CREHQ (${path}): ${(err as Error).message}`,
        "Check connectivity to crehq.com and the CREHQ_API_BASE value.",
      );
    } finally {
      clearTimeout(timer);
    }

    const meta: Record<string, string> = {};
    for (const name of SURFACED_HEADERS) {
      const v = res.headers.get(name);
      if (v) meta[name] = v;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const rawText = await res.text();
    let parsed: unknown = rawText;
    if (isJson && rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (!res.ok) {
      throw this.toApiError(res.status, parsed, meta);
    }

    return { data: parsed, meta };
  }

  /** Map a non-2xx response into a CrehqApiError with an actionable hint. */
  private toApiError(status: number, body: unknown, meta: Record<string, string>): CrehqApiError {
    const apiMessage = extractMessage(body);

    switch (status) {
      case 401:
        return new CrehqApiError(
          401,
          apiMessage ?? "Unauthorized: no API key was accepted.",
          `Set CREHQ_API_KEY to a valid key. Get a free sandbox key (1,000 calls/mo, no credit card) at ${SANDBOX_URL}.`,
          body,
        );
      case 403:
        return new CrehqApiError(
          403,
          apiMessage ?? "Forbidden: the API key is invalid, revoked, or not scoped for this endpoint.",
          `Verify the key is active and that your tier includes this endpoint. If this was a request for credit signals, FDD, site-selection criteria, contacts, source provenance, change history, bulk data, whitespace, co-tenancy, site timeline, or higher limits, use crehq_request_upgrade so CREHQ can record upgrade intent. Upgrade or request scope at https://crehq.com/api-keys/. Sandbox keys: ${SANDBOX_URL}.`,
          body,
        );
      case 404:
        return new CrehqApiError(
          404,
          apiMessage ?? "Not found: the requested record or path does not exist.",
          "Check the id/slug/uid. Use the search tools to resolve an identifier first.",
          body,
        );
      case 429: {
        const retry = meta["retry-after"];
        return new CrehqApiError(
          429,
          apiMessage ?? "Rate limited.",
          retry
            ? `Slow down and retry after ${retry}s.`
            : "Slow down (free tier is 2 req/s, 1,000 calls/mo) and retry shortly. Higher limits are available on paid tiers.",
          body,
        );
      }
      default:
        if (status >= 500) {
          return new CrehqApiError(
            status,
            apiMessage ?? `CREHQ server error (${status}).`,
            "This is a transient server-side issue. Retry with backoff; if it persists, contact CREHQ.",
            body,
          );
        }
        return new CrehqApiError(
          status,
          apiMessage ?? `Request failed (${status}).`,
          "Review the parameters against the tool's input schema.",
          body,
        );
    }
  }

  private async probeSelfserveUsage(): Promise<boolean> {
    const url = new URL(this.config.apiBase + "/selfserve/usage");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-API-Key": this.config.apiKey,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      await res.arrayBuffer().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pull a human message out of a WP-REST / CREHQ error body. */
function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  if (typeof body === "string" && body.length > 0 && body.length < 500) return body;
  return undefined;
}
