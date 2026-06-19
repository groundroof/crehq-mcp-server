/**
 * Crypto helpers built on the Web Crypto API (globalThis.crypto), which is
 * available in Cloudflare Workers and Node.js >= 18. No Node-only imports, so
 * the same code runs in `wrangler dev` and in the local Node test harness.
 */

/** URL-safe base64 (no padding) of raw bytes. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a cryptographically-random URL-safe token of `bytes` entropy. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** SHA-256 of a UTF-8 string, returned as a hex digest. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const b = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 of a UTF-8 string, returned base64url (for PKCE S256). */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

/**
 * Verify a PKCE code_verifier against the stored code_challenge.
 * Supports the S256 method (required by OAuth 2.1) and the plain method.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
  method: string,
): Promise<boolean> {
  if (!verifier || !challenge) return false;
  if (method === "S256") {
    const computed = await sha256Base64Url(verifier);
    return timingSafeEqual(computed, challenge);
  }
  if (method === "plain") {
    return timingSafeEqual(verifier, challenge);
  }
  return false;
}

/** Constant-time string comparison to avoid leaking length/content via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
