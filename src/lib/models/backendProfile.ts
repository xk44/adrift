/**
 * Client helper: the connected ComfyUI's BackendProfile (GPU, memory, what
 * formats it can load), cached so every model card / filter can ask cheaply.
 *
 *   const profile = await getBackendProfile();          // cached 60 s
 *   const res = profile && checkCompat({ fileName, bytes }, profile);
 *
 * Reads GET /api/comfy/system (read-only). Concurrent callers share one
 * request. Returns null when ComfyUI is unreachable; failures are cached for a
 * shorter time so a later connect is picked up quickly.
 */
import { profileFromSystemStats, type BackendProfile } from "./compat";

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 5_000;

let cached: { at: number; value: BackendProfile | null } | null = null;
let inflight: Promise<BackendProfile | null> | null = null;

export interface GetBackendProfileOptions {
  /** Ignore the cache (e.g. right after the connection changed). */
  force?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export async function getBackendProfile(
  opts: GetBackendProfileOptions = {},
): Promise<BackendProfile | null> {
  const now = Date.now();
  if (!opts.force && cached) {
    const ttl = cached.value ? OK_TTL_MS : FAIL_TTL_MS;
    if (now - cached.at < ttl) return cached.value;
  }
  if (inflight && !opts.force) return inflight;
  const f = opts.fetchImpl ?? fetch;
  const p = (async () => {
    try {
      const res = await f("/api/comfy/system", { cache: "no-store" });
      if (!res.ok) return null;
      return profileFromSystemStats(await res.json());
    } catch {
      return null;
    }
  })();
  inflight = p;
  try {
    const value = await p;
    cached = { at: Date.now(), value };
    return value;
  } finally {
    if (inflight === p) inflight = null;
  }
}

/** Seed the cache from a profile fetched elsewhere (the wizard's test). */
export function primeBackendProfile(value: BackendProfile | null): void {
  cached = { at: Date.now(), value };
}

/** Drop the cache (connection changed). */
export function clearBackendProfile(): void {
  cached = null;
  inflight = null;
}
