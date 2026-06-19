/**
 * MCP protocol handler over the Streamable-HTTP transport.
 *
 * The Streamable-HTTP transport (MCP spec 2025-03-26) is intentionally simple:
 *   - The client POSTs a JSON-RPC 2.0 message to a single endpoint (e.g. /mcp).
 *   - The server replies either with a single JSON-RPC response
 *     (Content-Type: application/json) or, for streamed/multi-message replies,
 *     a text/event-stream. For our request/response tools, a single JSON reply
 *     is sufficient and is what Claude's connector layer accepts.
 *   - GET on the endpoint MAY open a server->client SSE channel; we return 405
 *     (we have no server-initiated messages), which is spec-compliant.
 *
 * This handler is platform-agnostic: it takes a parsed JSON-RPC message and an
 * authenticated session (which carries the resolved CREHQ key + granted scopes)
 * and returns a JSON-RPC response object. The Worker/Node entrypoint owns HTTP.
 */
import { z } from "zod";
import { CrehqClient, type CrehqClientOptions } from "./client.js";
import { TOOLS, toJsonSchema } from "./tools.js";
import { upgradeRequired, type ToolContent } from "./format.js";

export const PROTOCOL_VERSION = "2025-03-26";
export const SERVER_INFO = { name: "crehq-mcp-remote", version: "0.1.0" } as const;

/** Per-request authenticated context resolved from the OAuth access token. */
export interface McpSession {
  /** Resolved CREHQ API key for the user (e.g. crehq_live_...). NEVER logged. */
  crehqApiKey: string;
  /** Scopes granted to this token (subset of ALL_SCOPES). */
  scopes: string[];
  /** Sandbox/self-serve keys can only call the bounded selfserve surface. */
  apiSurface: "selfserve" | "full";
  /** CREHQ API base + timeout. */
  clientOptions: Omit<CrehqClientOptions, "apiKey" | "apiSurface">;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function result(id: JsonRpcRequest["id"], value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}
function rpcError(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Dispatch one JSON-RPC request. Returns a JSON-RPC response, or `null` for
 * notifications (no id) which must not be answered.
 */
export async function handleRpc(
  msg: JsonRpcRequest,
  session: McpSession,
): Promise<JsonRpcResponse | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg.id ?? null, RPC.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");
  }

  // Notifications (e.g. notifications/initialized) carry no id; ack silently.
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "CREHQ location-intelligence tools. Resolve a brand to its company id with " +
          "crehq_companies_search first, then call detail/intelligence tools. Premium " +
          "intelligence tools (credit signals, whitespace, co-tenancy, site-timeline, occupancy) require " +
          "the read:intelligence scope. Free sandbox location results are footprint-only; if a user asks for " +
          "credit signals, ownership/rating/capital-structure, site-selection requirements, contacts, FDD, " +
          "or other premium data and the tool is unavailable, use crehq_request_upgrade instead of saying " +
          "CREHQ does not have it.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification: no response

    case "ping":
      return result(msg.id, {});

    case "tools/list": {
      const visible = TOOLS.filter((t) => isVisibleTool(t.name, session) && session.scopes.includes(t.requiredScope));
      return result(msg.id, {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toJsonSchema(t.schema),
        })),
      });
    }

    case "tools/call": {
      if (isNotification) return null;
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        return rpcError(msg.id, RPC.METHOD_NOT_FOUND, `Unknown tool: ${String(params.name)}`);
      }
      if (!isVisibleTool(tool.name, session)) {
        return result(
          msg.id,
          asCallResult({
            content: [
              {
                type: "text",
                text:
                  `"${tool.name}" is not available with a free CREHQ sandbox key. ` +
                  "Sandbox keys support bounded location lookups by brand or radius. " +
                  "Use crehq_request_upgrade to record upgrade intent. Upgrade to a production API key to unlock brand search, datasets, FDD, contacts, history, credit signals, and intelligence tools.",
              },
            ],
            isError: true,
          }),
        );
      }

      // --- TIER GATING ---------------------------------------------------
      // Return a clean, non-fatal upgrade message (as tool content) rather
      // than a hard RPC error, so the agent can relay it to the user.
      if (!session.scopes.includes(tool.requiredScope)) {
        return result(msg.id, asCallResult(upgradeRequired(tool.name, tool.requiredScope)));
      }

      const parsed = z.object(tool.schema).safeParse(params.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        return result(
          msg.id,
          asCallResult({
            content: [{ type: "text", text: `Invalid arguments for ${tool.name}:\n${issues}` }],
            isError: true,
          }),
        );
      }

      const client = new CrehqClient({
        ...session.clientOptions,
        apiKey: session.crehqApiKey,
        apiSurface: session.apiSurface,
      });
      try {
        const out = await tool.handler(client, parsed.data as Record<string, unknown>);
        return result(msg.id, asCallResult(out));
      } catch (err) {
        // Handlers already convert CrehqApiError to content; this is a net.
        return result(
          msg.id,
          asCallResult({
            content: [{ type: "text", text: `Unhandled error in ${tool.name}: ${(err as Error).message}` }],
            isError: true,
          }),
        );
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(msg.id, RPC.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/** Shape a ToolContent as an MCP tools/call result object. */
function asCallResult(tc: ToolContent): { content: unknown[]; isError?: boolean } {
  return { content: tc.content, isError: tc.isError };
}

function isVisibleTool(name: string, session: McpSession): boolean {
  if (session.apiSurface !== "selfserve") return true;
  return name === "crehq_locations_list" || name === "crehq_locations_nearby" || name === "crehq_request_upgrade";
}

export { RPC };
