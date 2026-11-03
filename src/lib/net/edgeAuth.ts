/**
 * Bearer verification that runs in the Edge runtime (middleware), using Web
 * Crypto instead of node:crypto. Mirrors lib/auth.ts + lib/session.ts: a
 * bearer is valid if it equals ADMIN_API_KEY or is an unexpired HS256 session
 * token signed with SESSION_SECRET (falls back to ADMIN_API_KEY).
 *
 * Same rules as lib/session.ts (expiry + the 30-day absolute cap), with one
 * difference: the edge runtime cannot read the session generation from
 * data/runtime_settings.json, so the key is derived from the token's own
 * `gen` claim. A revoked token can therefore pass here, which only skips the
 * middleware's CSRF check for a bearer header; the route's requireAdmin
 * verifies against the current generation and rejects it.
 */

/** Keep in sync with MAX_SESSION_LIFETIME_MS in lib/session.ts (a test checks). */
export const EDGE_MAX_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GENERATION = 1_000_000_000;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeText(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmac(keyText: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64urlFromBytes(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))),
  );
}

async function verifySessionTokenEdge(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  try {
    const payload = JSON.parse(b64urlDecodeText(p)) as {
      exp?: unknown;
      iat?: unknown;
      auth?: unknown;
      gen?: unknown;
    };
    const gen = payload.gen ?? 0;
    if (typeof gen !== "number" || !Number.isInteger(gen) || gen < 0 || gen > MAX_GENERATION)
      return false;
    const signingKey = gen === 0 ? secret : await hmac(secret, `gen:${gen}`);
    if (!constantTimeEqual(await hmac(signingKey, `${h}.${p}`), sig)) return false;
    const now = Date.now();
    if (typeof payload.exp !== "number" || now > payload.exp) return false;
    const authAt = typeof payload.auth === "number" ? payload.auth : payload.iat;
    return typeof authAt === "number" && now <= authAt + EDGE_MAX_SESSION_LIFETIME_MS;
  } catch {
    return false;
  }
}

/** True when `token` is the admin key or a valid session token. */
export async function isVerifiedBearer(token: string): Promise<boolean> {
  const key = process.env.ADMIN_API_KEY?.trim() ?? "";
  if (!key || !token) return false;
  if (constantTimeEqual(token, key)) return true;
  const secret = process.env.SESSION_SECRET?.trim() || key;
  return verifySessionTokenEdge(token, secret);
}
