/**
 * Thin HTTP client for the CREHQ REST API (https://crehq.com/wp-json/crehq/v1).
 *
 * Adapted from the stdio package's client for the REMOTE (multi-tenant) server:
 *  - The API key is supplied PER REQUEST (resolved from the OAuth access token),
 *    not read from a process-wide env var, because one Worker serves many users.
 *  - Built on the Fetch API (works in Cloudflare Workers and Node 18+).
 *  - Maps HTTP failures (401/403/404/429/4xx/5xx) into clear, agent-readable
 *    errors that point the user at the right next step.
 *  - Surfaces CREHQ pagination + cache + rate-limit headers to the caller.
 *
 * SECURITY: this client never logs the API key. Callers must not log the key
 * either; only the non-secret key_prefix may be recorded.
 */

export const DEFAULT_API_BASE = "https://crehq.com/wp-json/crehq/v1";
const SIGNUP_URL = "https://crehq.com/developers/sandbox/";

export interface CrehqClientOptions {
  /** The resolved CREHQ API key for this request (e.g. crehq_live_...). */
  apiKey: string;
  /** API base URL, no trailing slash. */
  apiBase: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Which CREHQ API surface this key can use. */
  apiSurface?: "selfserve" | "full";
}

/** Headers worth surfacing back to the agent (pagination, cache, rate limit). */
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
  data: unknown;
  meta: Record<string, string>;
}

/** Error carrying enough context for the tool layer to produce a helpful message. */
export class CrehqApiError extends Error {
  readonly status: number;
  readonly hint: string;

  constructor(status: number, message: string, hint = "") {
    super(message);
    this.name = "CrehqApiError";
    this.status = status;
    this.hint = hint;
  }
}

type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  query?: Record<string, QueryValue>;
  body?: unknown;
  accept?: string;
}

export class CrehqClient {
  constructor(private readonly opts: CrehqClientOptions) {}

  get hasKey(): boolean {
    return this.opts.apiKey.trim().length > 0;
  }

  get apiSurface(): "selfserve" | "full" {
    return this.opts.apiSurface ?? "full";
  }

  async request(path: string, opts: RequestOptions = {}): Promise<CrehqResult> {
    if (!this.hasKey) {
      throw new CrehqApiError(
        401,
        "No CREHQ API key is linked to this session.",
        `Re-authorize the connector and link a valid CREHQ key, or get a free sandbox key at ${SIGNUP_URL}.`,
      );
    }

    const url = new URL(this.opts.apiBase + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "X-API-Key": this.opts.apiKey,
      Accept: opts.accept ?? "application/json",
      "User-Agent": "crehq-mcp-remote/0.1.0",
    };

    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    init.signal = controller.signal;

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CrehqApiError(
          504,
          `Request to ${path} timed out after ${this.opts.timeoutMs}ms.`,
          "Retry, narrow the query (smaller per_page / tighter filters).",
        );
      }
      throw new CrehqApiError(
        0,
        `Network error calling CREHQ (${path}): ${(err as Error).message}`,
        "Check connectivity to crehq.com and the configured API base.",
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

  private toApiError(status: number, body: unknown, meta: Record<string, string>): CrehqApiError {
    const apiMessage = extractMessage(body);
    switch (status) {
      case 401:
        return new CrehqApiError(
          401,
          apiMessage ?? "Unauthorized: the linked CREHQ API key was not accepted.",
          `The key may be revoked or expired. Re-authorize the connector. Free sandbox keys: ${SIGNUP_URL}.`,
        );
      case 403:
        return new CrehqApiError(
          403,
          apiMessage ?? "Forbidden: the API key is not scoped for this endpoint.",
          "Your CREHQ tier does not include this data. Upgrade at https://crehq.com/api-keys/ to unlock it.",
        );
      case 404:
        return new CrehqApiError(
          404,
          apiMessage ?? "Not found: the requested record or path does not exist.",
          "Check the id/slug/uid. Use the search tools to resolve an identifier first.",
        );
      case 429: {
        const retry = meta["retry-after"];
        return new CrehqApiError(
          429,
          apiMessage ?? "Rate limited.",
          retry ? `Slow down and retry after ${retry}s.` : "Slow down and retry shortly.",
        );
      }
      default:
        if (status >= 500) {
          return new CrehqApiError(
            status,
            apiMessage ?? `CREHQ server error (${status}).`,
            "Transient server-side issue. Retry with backoff.",
          );
        }
        return new CrehqApiError(
          status,
          apiMessage ?? `Request failed (${status}).`,
          "Review the parameters against the tool's input schema.",
        );
    }
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  if (typeof body === "string" && body.length > 0 && body.length < 500) return body;
  return undefined;
}
