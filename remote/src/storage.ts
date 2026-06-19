/**
 * Pluggable key/value storage for OAuth state (clients, auth codes, tokens,
 * token->CREHQ-key mappings). Two implementations:
 *   - KvStore: backed by a Cloudflare Workers KV namespace (production).
 *   - MemoryStore: in-process Map with TTL (local PoC / Node dev / tests).
 *
 * Keys are namespaced by prefix. Values are JSON. TTLs are seconds.
 *
 * SECURITY: stored token records contain the user's CREHQ API key. In KV this
 * lives in Cloudflare's encrypted-at-rest store. Records are never logged.
 */

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Store {
  getJSON<T>(key: string): Promise<T | null>;
  putJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Wraps a Workers KV namespace as a Store. */
export class KvStore implements Store {
  constructor(private readonly kv: KVLike) {}

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async putJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    // Workers KV requires expirationTtl >= 60s; clamp small TTLs up.
    const opts = ttlSeconds ? { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) } : undefined;
    await this.kv.put(key, JSON.stringify(value), opts);
  }

  async del(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

/** In-memory Store with TTL expiry — for local dev, Node, and tests. */
export class MemoryStore implements Store {
  private readonly map = new Map<string, { value: string; expiresAt: number | null }>();

  async getJSON<T>(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async putJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.map.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}
