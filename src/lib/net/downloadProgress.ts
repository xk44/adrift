/**
 * In-memory progress for server-side downloads, so the browser can poll a
 * GET while the POST that does the work is still running. Lives on
 * globalThis so every route module in the process sees the same map.
 */

export interface DownloadProgress {
  received: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  done?: boolean;
  error?: string;
}

const KEY = "__adriftDownloadProgress";
const KEEP_FINISHED_MS = 5 * 60_000;
const MAX_ENTRIES = 200;

function store(): Map<string, DownloadProgress> {
  const g = globalThis as unknown as Record<
    string,
    Map<string, DownloadProgress> | undefined
  >;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

function prune(now: number) {
  const map = store();
  for (const [k, v] of map) {
    if ((v.done || v.error) && now - v.updatedAt > KEEP_FINISHED_MS)
      map.delete(k);
  }
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function startProgress(key: string, total: number): void {
  const now = Date.now();
  prune(now);
  store().set(key, { received: 0, total, startedAt: now, updatedAt: now });
}

export function addProgress(key: string, delta: number): void {
  const p = store().get(key);
  if (!p) return;
  p.received += delta;
  p.updatedAt = Date.now();
}

export function finishProgress(key: string, error?: string): void {
  const p = store().get(key);
  if (!p) return;
  p.updatedAt = Date.now();
  if (error) p.error = error;
  else p.done = true;
}

export function getProgress(key: string): DownloadProgress | null {
  const p = store().get(key);
  return p ? { ...p } : null;
}

/** 0-100, or -1 when the size is unknown. */
export function progressPercent(
  p: Pick<DownloadProgress, "received" | "total">,
): number {
  if (!p.total || p.total <= 0) return -1;
  return Math.max(0, Math.min(100, Math.floor((p.received / p.total) * 100)));
}
