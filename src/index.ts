#!/usr/bin/env node
/**
 * CREHQ MCP server — exposes CREHQ's live location-intelligence REST API
 * (https://crehq.com/wp-json/crehq/v1) as Model Context Protocol tools so that
 * Claude and other MCP clients can query brands, locations, FDD financials,
 * site-level tenancy history, whitespace, co-tenancy, and staged modeled site
 * profile tools as native tools.
 *
 * Transport: stdio (the standard for Claude Desktop / local connectors).
 * Auth:      CREHQ_API_KEY env var (sandbox/dev/prod/enterprise).
 *
 * This wraps an EXISTING production API; it does not modify any server-side
 * data. See README.md for setup and GO-LIVE.md for shipping.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CrehqClient, loadConfig } from "./client.js";
import { TOOLS, toJsonSchema } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new CrehqClient(config);

  // Warn (to stderr — never stdout, which carries the MCP protocol) if no key.
  if (!client.hasKey) {
    process.stderr.write(
      "[crehq-mcp] WARNING: CREHQ_API_KEY is not set. Tools will return an auth hint until a key is configured. " +
        "Get a free sandbox key at https://crehq.com/developers/sandbox/\n",
    );
  }

  const server = new Server(
    { name: "crehq-mcp-server", version: "0.1.1" },
    { capabilities: { tools: {} } },
  );

  // Advertise the tool catalog (names + descriptions + JSON schemas).
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.schema),
    })),
  }));

  // Dispatch a tool call: validate args with Zod, then run the handler.
  // (Results are cast to the SDK's CallToolResult shape; our ToolContent is a
  // structural subset — content blocks + optional isError.)
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const parsed = z.object(tool.schema).safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `Invalid arguments for ${tool.name}:\n${issues}` }],
        isError: true,
      };
    }

    try {
      return (await tool.handler(client, parsed.data as Record<string, unknown>)) as CallToolResult;
    } catch (err) {
      // Defensive net: handlers already convert CrehqApiError to content, but a
      // truly unexpected throw should still not kill the server.
      return {
        content: [{ type: "text", text: `Unhandled error in ${tool.name}: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[crehq-mcp] CREHQ MCP server ready over stdio with ${TOOLS.length} tools. Base: ${config.apiBase}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[crehq-mcp] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
