/**
 * Lightweight HMAC-SHA256 session tokens — no external JWT libraries.
 *
 * Token format (3 dot-separated parts):
 *   base64url(header) . base64url(payload) . base64url(signature)
 *
 * Header:  { alg: "HS256", typ: "JWT" }
 * Payload: { sub: "admin", iat: <unix-ms>, exp: <unix-ms>, auth: <unix-ms>, gen: <n>, sid: <id> }
 * Signature: HMAC-SHA256(header.payload, signingKey(secret, gen))
 *
 * Absolute lifetime: `auth` is when the session was first signed in. Refresh
 * keeps it, so no chain of refreshes outlives MAX_SESSION_LIFETIME_MS (30
 * days); after that the user has to sign in again. Tokens without `auth`
 * (minted before this field existed) fall back to `iat`.
 *
 * Revocation ("sign out everywhere"): the signing key is derived from the
 * secret and a generation counter kept in data/runtime_settings.json:
 *   gen 0  -> key = secret   (so tokens from before the counter keep working)
 *   gen N  -> key = HMAC-SHA256(secret, "gen:" + N)
 * Node routes (requireAdmin, refresh) verify with the CURRENT generation, so
 * bumping it voids every older token at once without a server-side session
 * list. The edge middleware cannot read the settings file; it derives the key
 * from the token's own `gen` claim, which proves the token was minted with the
 * secret but not that it is current. That is enough there: the middleware
 * only uses a verified bearer to skip its CSRF check (a bearer header is never
 * sent by a browser on its own), and the route's requireAdmin still rejects a
 * revoked token. The raw ADMIN_API_KEY is not affected; rotate it to revoke it.
 *
 * Devices ("unpair this device"): sign-in adds a random `sid` claim, kept
 * across refreshes, and records it in data/sessions.json (lib/sessionRegistry
 * .ts: label, sign-in time, last seen; no raw User-Agent, no IP). Node routes
 * verify with verifyPairedSessionToken, which also requires the sid to still
 * be in that file, so removing an entry unpairs one device. Same split as the
 * generation: the edge middleware cannot read the file and does not check it.
 * Tokens without a sid (minted before this field existed) are not tied to a
 * device; they keep working until they expire or the generation is bumped
 * ("Unpair all other devices" and logout?all=1 both bump it).
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readSessionGeneration } from "@/lib/runtimeSettings";
import {
  isSessionPaired,
  MAX_SESSION_LIFETIME_MS as LIFETIME_MS,
} from "@/lib/sessionRegistry";

export interface SessionPayload {
  sub: "admin";
  iat: number; // issued-at ms
  exp: number; // expiry ms
  /** When the session was first signed in (ms); kept across refreshes. */
  auth?: number;
  /** Session key generation the token was signed with (absent = 0). */
  gen?: number;
  /** Device session id (see lib/sessionRegistry.ts); absent on old tokens. */
  sid?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
/** Hard cap on a session, refreshes included. */
export const MAX_SESSION_LIFETIME_MS = LIFETIME_MS; // 30 days (defined in sessionRegistry)
const REFRESH_THRESHOLD = 0.25; // refresh when < 25% of TTL remains

// encoding helpers

function b64uEncode(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function b64uDecode<T>(s: string): T {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;
}

const HEADER_ENCODED = b64uEncode({ alg: "HS256", typ: "JWT" });

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Signing key for a generation (see the header comment). */
export function sessionSigningKey(secret: string, generation: number): string {
  if (!generation) return secret;
  return createHmac("sha256", secret).update(`gen:${generation}`).digest("base64url");
}

/** The current generation; 0 when the settings file has none. */
export function currentSessionGeneration(): number {
  try {
    return readSessionGeneration();
  } catch {
    return 0;
  }
}

export interface SessionTokenOptions {
  /** Original sign-in time (refresh passes the old token's). Default: now. */
  authAt?: number;
  /** Key generation. Default: the current one. */
  generation?: number;
  /** Device session id to embed (refresh passes the old token's). */
  sid?: string;
}

/** A new random device session id (128 bits, base64url). */
export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

// public API

/**
 * Issue a new session token. exp never passes authAt + MAX_SESSION_LIFETIME_MS.
 */
export function createSessionToken(
  secret: string,
  ttlMs = DEFAULT_TTL_MS,
  opts: SessionTokenOptions = {},
): string {
  const now = Date.now();
  const auth = opts.authAt ?? now;
  const gen = opts.generation ?? currentSessionGeneration();
  const payload: SessionPayload = {
    sub: "admin",
    iat: now,
    exp: Math.min(now + ttlMs, auth + MAX_SESSION_LIFETIME_MS),
    auth,
    gen,
  };
  if (opts.sid) payload.sid = opts.sid;
  const unsigned = `${HEADER_ENCODED}.${b64uEncode(payload)}`;
  const sig = sign(unsigned, sessionSigningKey(secret, gen));
  return `${unsigned}.${sig}`;
}

/**
 * Verify a session token against the current (or the given) generation.
 * Returns `{ valid: true, payload }` or `{ valid: false, error }`.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  opts: { generation?: number } = {},
): { valid: true; payload: SessionPayload } | { valid: false; error: string } {
  const generation = opts.generation ?? currentSessionGeneration();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed token" };
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const unsigned = `${headerB64}.${payloadB64}`;
  const expected = sign(unsigned, sessionSigningKey(secret, generation));

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuf = Buffer.from(sigB64, "base64url");
    const expBuf = Buffer.from(expected, "base64url");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: "Invalid signature" };
    }
  } catch {
    return { valid: false, error: "Invalid signature" };
  }

  let payload: SessionPayload;
  try {
    payload = b64uDecode<SessionPayload>(payloadB64);
  } catch {
    return { valid: false, error: "Malformed payload" };
  }

  if (!payload || typeof payload !== "object" || typeof payload.exp !== "number") {
    return { valid: false, error: "Malformed payload" };
  }
  if ((payload.gen ?? 0) !== generation) {
    return { valid: false, error: "Session revoked" };
  }

  const now = Date.now();
  if (now > payload.exp) {
    return { valid: false, error: "Token expired" };
  }
  const authAt = typeof payload.auth === "number" ? payload.auth : payload.iat;
  if (typeof authAt !== "number" || now > authAt + MAX_SESSION_LIFETIME_MS) {
    return { valid: false, error: "Session too old; sign in again" };
  }

  return { valid: true, payload };
}

/**
 * verifySessionToken plus the device check: a token carrying a `sid` is only
 * valid while that sid is in the device registry (data/sessions.json). Tokens
 * without a sid (legacy) pass this check; see the header comment.
 */
export function verifyPairedSessionToken(
  token: string,
  secret: string,
  opts: { generation?: number } = {},
): ReturnType<typeof verifySessionToken> {
  const res = verifySessionToken(token, secret, opts);
  if (!res.valid) return res;
  const sid = res.payload.sid;
  if (sid !== undefined && (typeof sid !== "string" || !isSessionPaired(sid))) {
    return { valid: false, error: "Device unpaired" };
  }
  return res;
}

/**
 * Refresh a session token if it is valid and within the refresh window
 * (less than 25% of its original TTL remaining).
 *
 * Returns a new token string, or null if the token is not eligible for refresh.
 */
export function refreshSessionToken(
  token: string,
  secret: string,
  ttlMs = DEFAULT_TTL_MS,
): string | null {
  const result = verifyPairedSessionToken(token, secret);
  if (!result.valid) return null;

  const { iat, exp } = result.payload;
  const originalTtl = exp - iat;
  const remaining = exp - Date.now();

  if (remaining / originalTtl > REFRESH_THRESHOLD) return null;

  // Keep the original sign-in time: refreshes never extend past the cap.
  const authAt = result.payload.auth ?? iat;
  return createSessionToken(secret, ttlMs, {
    authAt,
    generation: result.payload.gen ?? 0,
    sid: typeof result.payload.sid === "string" ? result.payload.sid : undefined,
  });
}

/**
 * Resolve the session secret from env vars.
 * Prefers SESSION_SECRET; falls back to ADMIN_API_KEY.
 * Returns empty string in dev (no auth configured) — callers must handle this.
 */
export function resolveSessionSecret(): string {
  return (
    process.env.SESSION_SECRET?.trim() ||
    process.env.ADMIN_API_KEY?.trim() ||
    ""
  );
}
