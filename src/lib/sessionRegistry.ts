/**
 * Device registry: which signed-in devices are still paired.
 *
 * Every sign-in gets a random session id (`sid`, a claim in the session
 * token, see lib/session.ts) and an entry here:
 *   { sid, label, createdAt, lastSeenAt }   (times in unix ms)
 * `label` is a short device name derived from the User-Agent at sign-in
 * ("iPhone · Safari", "Mac · Chrome", "Adrift iOS app"). The raw User-Agent
 * and the IP address are never stored.
 *
 * Node routes accept a token with a sid only while the sid is listed here, so
 * removing an entry unpairs that device. `lastSeenAt` is written on sign-in,
 * on token refresh, and at most once an hour while a device keeps using the
 * app (requireAdmin), never on every request.
 *
 * Saved to data/sessions.json (ADRIFT_SESSIONS_FILE overrides; data/ is
 * gitignored), written atomically (tmp + rename, mode 0600). Entries older
 * than the session lifetime cap are pruned; the list is capped at
 * MAX_SESSIONS (oldest last-seen dropped first).
 *
 * Under vitest the registry is off unless ADRIFT_SESSIONS_FILE is set, so a
 * developer's real file can never affect tests; while off every sid counts as
 * paired.
 *
 * Server-side only.
 */
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "@/lib/runtimeSettings";

/** Hard cap on a session, refreshes included (re-exported by lib/session). */
export const MAX_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAX_SESSIONS = 200;
/** Minimum gap between "still active" writes for one device. */
export const ACTIVE_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 h
export const SESSION_REGISTRY_VERSION = 1;
const MAX_LABEL_LENGTH = 60;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface DeviceSession {
  sid: string;
  label: string;
  /** Sign-in time (= the token's `auth` claim), unix ms. */
  createdAt: number;
  /** Last sign-in / refresh / hourly activity mark, unix ms. */
  lastSeenAt: number;
}

interface RegistryDoc {
  version: number;
  sessions: DeviceSession[];
}

export function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && SID_RE.test(sid);
}

export function sessionRegistryPath(): string {
  const override = process.env.ADRIFT_SESSIONS_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "sessions.json");
}

function disabledInTests(): boolean {
  return !!process.env.VITEST && !process.env.ADRIFT_SESSIONS_FILE?.trim();
}

/** True when the registry is in use (always, outside tests). */
export function sessionRegistryEnabled(): boolean {
  return !disabledInTests();
}

// Labels

/**
 * Short device name from a User-Agent ("iPhone · Safari"). Only this label is
 * stored, never the User-Agent itself.
 */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  const s = (ua ?? "").slice(0, 512);
  if (!s.trim()) return "Unknown device";
  // Native app: URLSession's default UA is "<App>/<build> CFNetwork/… Darwin/…".
  if (/^Adrift\b/i.test(s) || (/CFNetwork\//.test(s) && /Darwin\//.test(s))) {
    return "Adrift iOS app";
  }

  let device = "";
  if (/iPhone/.test(s)) device = "iPhone";
  else if (/iPad/.test(s)) device = "iPad";
  else if (/Android/.test(s)) device = "Android";
  else if (/CrOS/.test(s)) device = "Chromebook";
  else if (/Windows/.test(s)) device = "Windows";
  else if (/Macintosh|Mac OS X/.test(s)) device = "Mac";
  else if (/Linux/.test(s)) device = "Linux";

  let browser = "";
  if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/SamsungBrowser\//.test(s)) browser = "Samsung Internet";
  else if (/Chrome\/|CriOS\/|Chromium\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  else if (/^curl\//i.test(s)) browser = "curl";

  const label =
    device && browser
      ? `${device} · ${browser}`
      : device || browser || "Unknown device";
  return label.slice(0, MAX_LABEL_LENGTH);
}

// Read / write

function cleanEntry(raw: unknown): DeviceSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isValidSessionId(r.sid)) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt))
    return null;
  const lastSeenAt =
    typeof r.lastSeenAt === "number" && Number.isFinite(r.lastSeenAt)
      ? r.lastSeenAt
      : r.createdAt;
  const label =
    typeof r.label === "string" && r.label.trim()
      ? r.label.trim().slice(0, MAX_LABEL_LENGTH)
      : "Unknown device";
  return { sid: r.sid, label, createdAt: r.createdAt, lastSeenAt };
}

/** Drop entries past the lifetime cap, de-duplicate, keep the newest MAX_SESSIONS. */
export function pruneSessions(
  list: DeviceSession[],
  now = Date.now(),
): DeviceSession[] {
  const seen = new Set<string>();
  const live: DeviceSession[] = [];
  for (const e of list) {
    if (seen.has(e.sid)) continue;
    if (now > e.createdAt + MAX_SESSION_LIFETIME_MS) continue;
    seen.add(e.sid);
    live.push(e);
  }
  if (live.length <= MAX_SESSIONS) return live;
  return [...live]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_SESSIONS);
}

function sanitizeDoc(raw: unknown): RegistryDoc {
  const out: RegistryDoc = { version: SESSION_REGISTRY_VERSION, sessions: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.version === "number" && r.version > SESSION_REGISTRY_VERSION)
    return out;
  if (Array.isArray(r.sessions)) {
    for (const e of r.sessions) {
      const c = cleanEntry(e);
      if (c) out.sessions.push(c);
    }
  }
  return out;
}

// requireAdmin reads this on every request: short mtime-checked cache.
const CACHE_TTL_MS = 1000;
let cache: {
  file: string;
  at: number;
  mtimeMs: number;
  value: RegistryDoc;
} | null = null;

function readDoc(): RegistryDoc {
  const file = sessionRegistryPath();
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_TTL_MS)
    return cache.value;
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) {
    cache.at = now;
    return cache.value;
  }
  let value: RegistryDoc = { version: SESSION_REGISTRY_VERSION, sessions: [] };
  if (mtimeMs >= 0) {
    try {
      value = sanitizeDoc(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // Corrupt or unreadable: no device is paired; everyone signs in again.
      value = { version: SESSION_REGISTRY_VERSION, sessions: [] };
    }
  }
  cache = { file, at: now, mtimeMs, value };
  return value;
}

export function invalidateSessionRegistryCache(): void {
  cache = null;
}

/** Read-modify-write; `mutate` gets a fresh copy of the (pruned) list. */
function updateSessions(
  mutate: (list: DeviceSession[]) => DeviceSession[],
): DeviceSession[] {
  if (disabledInTests()) return [];
  invalidateSessionRegistryCache();
  const now = Date.now();
  const current = pruneSessions(
    readDoc().sessions.map((e) => ({ ...e })),
    now,
  );
  const next = pruneSessions(mutate(current), now);
  const doc: RegistryDoc = { version: SESSION_REGISTRY_VERSION, sessions: next };
  writeAtomic(sessionRegistryPath(), `${JSON.stringify(doc, null, 2)}\n`);
  invalidateSessionRegistryCache();
  return next;
}

// Public API

/** Paired devices, most recently seen first. */
export function listSessions(now = Date.now()): DeviceSession[] {
  if (disabledInTests()) return [];
  return pruneSessions(readDoc().sessions, now).sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt,
  );
}

export function getSession(sid: string, now = Date.now()): DeviceSession | null {
  if (disabledInTests()) return null;
  return listSessions(now).find((e) => e.sid === sid) ?? null;
}

/** True while `sid` is paired (always true while the registry is off). */
export function isSessionPaired(sid: string, now = Date.now()): boolean {
  if (disabledInTests()) return true;
  if (!isValidSessionId(sid)) return false;
  return getSession(sid, now) !== null;
}

/** Add (or replace) a device entry. Throws when the file can't be written. */
export function registerSession(entry: {
  sid: string;
  label: string;
  createdAt: number;
  lastSeenAt?: number;
}): void {
  if (!isValidSessionId(entry.sid)) throw new Error("Invalid session id");
  const clean: DeviceSession = {
    sid: entry.sid,
    label: entry.label.trim().slice(0, MAX_LABEL_LENGTH) || "Unknown device",
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt ?? Date.now(),
  };
  updateSessions((list) => [clean, ...list.filter((e) => e.sid !== entry.sid)]);
}

/**
 * Mark a device as seen. With `minIntervalMs`, skips the write when the last
 * mark is more recent than that (cheap enough to call per request). Returns
 * false when the sid is not paired.
 */
export function touchSession(
  sid: string,
  opts: { now?: number; minIntervalMs?: number } = {},
): boolean {
  if (disabledInTests()) return true;
  const now = opts.now ?? Date.now();
  const cur = getSession(sid, now);
  if (!cur) return false;
  if (opts.minIntervalMs && now - cur.lastSeenAt < opts.minIntervalMs)
    return true;
  updateSessions((list) =>
    list.map((e) => (e.sid === sid ? { ...e, lastSeenAt: now } : e)),
  );
  return true;
}

/** Unpair one device. Returns false when it was not paired. */
export function removeSession(sid: string): boolean {
  if (disabledInTests()) return false;
  if (!getSession(sid)) return false;
  updateSessions((list) => list.filter((e) => e.sid !== sid));
  return true;
}

/** Unpair every device except `keepSid` (all of them when omitted). Returns the count removed. */
export function removeOtherSessions(keepSid?: string): number {
  if (disabledInTests()) return 0;
  let removed = 0;
  updateSessions((list) => {
    const kept = list.filter((e) => e.sid === keepSid);
    removed = list.length - kept.length;
    return kept;
  });
  return removed;
}

/** Unpair every device. */
export function clearSessions(): number {
  return removeOtherSessions(undefined);
}
