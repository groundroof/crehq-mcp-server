/**
 * Helpers to turn a CrehqResult into the MCP tool-result content blocks the
 * SDK expects, and to render CrehqApiError into a non-fatal, agent-readable
 * message (tools surface errors as content + isError, never by throwing, so a
 * single failing call doesn't kill the agent's turn).
 */
import { CrehqApiError, type CrehqResult } from "./client.js";

export interface ToolContent {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Wrap a successful API result as a pretty-printed JSON text block + meta. */
export function ok(result: CrehqResult): ToolContent {
  const metaKeys = Object.keys(result.meta);
  const metaNote =
    metaKeys.length > 0
      ? `\n\n--- response metadata ---\n${formatMeta(result.meta)}`
      : "";
  return {
    content: [{ type: "text", text: JSON.stringify(result.data, null, 2) + metaNote }],
  };
}

/** Wrap a caught error as a non-fatal tool error with an actionable hint. */
export function fail(err: unknown): ToolContent {
  if (err instanceof CrehqApiError) {
    const lines = [`CREHQ API error (HTTP ${err.status || "n/a"}): ${err.message}`];
    if (err.hint) lines.push(`Suggestion: ${err.hint}`);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }
  return {
    content: [{ type: "text", text: `Unexpected error: ${(err as Error).message}` }],
    isError: true,
  };
}

function formatMeta(meta: Record<string, string>): string {
  const labels: Record<string, string> = {
    "x-wp-total": "total_results",
    "x-wp-totalpages": "total_pages",
    "x-crehq-next-since": "next_since_cursor",
    "x-crehq-cache": "cache",
    "x-ratelimit-remaining": "rate_limit_remaining",
    "x-ratelimit-limit": "rate_limit",
    "retry-after": "retry_after_seconds",
  };
  return Object.entries(meta)
    .filter(([k]) => k !== "link")
    .map(([k, v]) => `${labels[k] ?? k}: ${v}`)
    .join("\n");
}
