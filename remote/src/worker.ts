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

export interface Env {
  OAUTH_KV: KVLike;
  ISSUER?: string;
  CREHQ_API_BASE?: string;
  CREHQ_TIMEOUT_MS?: string;
  /**
   * DEV-ONLY escape hatch for `wrangler dev` testing without a real key.
   * Must be the exact string "yes-i-know" to take effect. NEVER set this var in
   * production (do not add it to wrangler.toml [vars] for the deployed env).
   */
  UNSAFE_SKIP_KEY_VALIDATION?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const issuer = (env.ISSUER && env.ISSUER.replace(/\/+$/, "")) || url.origin;
    const store = new KvStore(env.OAUTH_KV);
    return handleRequest(req, store, {
      issuer,
      crehqApiBase: (env.CREHQ_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
      timeoutMs: Number.parseInt(env.CREHQ_TIMEOUT_MS ?? "30000", 10) || 30000,
      unsafeSkipKeyValidation: env.UNSAFE_SKIP_KEY_VALIDATION === "yes-i-know",
    });
  },
};
