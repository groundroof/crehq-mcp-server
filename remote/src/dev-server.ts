/**
 * Local Node dev server (alternative to `wrangler dev`).
 *
 * Adapts node:http <-> the Fetch API so the SAME `handleRequest` router (used by
 * the Cloudflare Worker) runs locally with an in-memory store. This is the
 * fastest way to drive the OAuth 2.1 handshake + an MCP tool call end-to-end
 * without Cloudflare credentials.
 *
 * Run:  npm run dev          (PORT defaults to 8787)
 * Env:  ISSUER, CREHQ_API_BASE, CREHQ_TIMEOUT_MS (all optional).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleRequest } from "./router.js";
import { MemoryStore } from "./storage.js";
import { DEFAULT_API_BASE } from "./client.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const store = new MemoryStore();
const crehqApiBase = (process.env.CREHQ_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
const timeoutMs = Number.parseInt(process.env.CREHQ_TIMEOUT_MS ?? "30000", 10) || 30000;

async function toFetchRequest(nodeReq: IncomingMessage, origin: string): Promise<Request> {
  const url = origin + (nodeReq.url ?? "/");
  const method = nodeReq.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const c of nodeReq) chunks.push(c as Buffer);
    // All request bodies this server accepts are UTF-8 text (JSON / form-encoded).
    body = Buffer.concat(chunks).toString("utf8");
  }
  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}

async function writeFetchResponse(res: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = res.status;
  res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  const buf = Buffer.from(await res.arrayBuffer());
  nodeRes.end(buf);
}

const server = createServer((nodeReq, nodeRes) => {
  const issuer = (process.env.ISSUER && process.env.ISSUER.replace(/\/+$/, "")) || `http://localhost:${PORT}`;
  void (async () => {
    try {
      const origin = `http://localhost:${PORT}`;
      const req = await toFetchRequest(nodeReq, origin);
      const out = await handleRequest(req, store, { issuer, crehqApiBase, timeoutMs });
      await writeFetchResponse(out, nodeRes);
    } catch (err) {
      nodeRes.statusCode = 500;
      nodeRes.setHeader("content-type", "application/json");
      nodeRes.end(JSON.stringify({ error: "internal_error", message: (err as Error).message }));
    }
  })();
});

server.listen(PORT, () => {
  process.stdout.write(
    `[crehq-mcp-remote] dev server on http://localhost:${PORT}\n` +
      `  issuer:     ${process.env.ISSUER ?? `http://localhost:${PORT}`}\n` +
      `  crehq base: ${crehqApiBase}\n` +
      `  endpoints:  /.well-known/oauth-authorization-server  /register  /authorize  /token  /mcp\n`,
  );
});
