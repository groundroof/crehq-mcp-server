/**
 * Cloudflare Worker entrypoint (PRIMARY deploy target).
 *
 * Binds:
 *   - OAUTH_KV (KV namespace)  : OAuth clients, codes, tokens, key mappings.
 *   - ISSUER (var)             : public origin, e.g. https://mcp.crehq.com
 *   - CREHQ_API_BASE (var)     : defaults to https://crehq.com/wp-json/crehq/v1
 *   - CREHQ_TIMEOUT_MS (var)   : optional per-request timeout.
 *
 * The Worker derives the issuer from the request origin if ISSUER is unset, so
 * `wrangler dev` works out of the box (issuer = http://localhost:8787).
 */
import { handleRequest } from "./router.js";
import { KvStore, type KVLike } from "./storage.js";
import { DEFAULT_API_BASE } from "./client.js";

type WorkerEnv = Env & {
  OAUTH_KV: KVLike;
  /**
   * DEV-ONLY escape hatch for `wrangler dev` testing without a real key.
   * Must be the exact string "yes-i-know" to take effect. NEVER set this var in
   * production (do not add it to wrangler.toml [vars] for the deployed env).
   */
  UNSAFE_SKIP_KEY_VALIDATION?: string;
};

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    const started = Date.now();
    const issuer = (env.ISSUER && env.ISSUER.replace(/\/+$/, "")) || url.origin;
    const store = new KvStore(env.OAUTH_KV);
    try {
      const response = await handleRequest(req, store, {
        issuer,
        crehqApiBase: (env.CREHQ_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
        timeoutMs: Number.parseInt(env.CREHQ_TIMEOUT_MS ?? "30000", 10) || 30000,
        unsafeSkipKeyValidation: env.UNSAFE_SKIP_KEY_VALIDATION === "yes-i-know",
      });
      console.log(
        JSON.stringify({
          message: "mcp_request",
          method: req.method,
          path: url.pathname,
          status: response.status,
          duration_ms: Date.now() - started,
        }),
      );
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "mcp_request_failed",
          method: req.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - started,
        }),
      );
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
