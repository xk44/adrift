/**
 * Active Runs Store
 * In-memory store for tracking active generation runs
 * In production, this would be Redis or a database
 */

import type { ImagineRun } from "@/types";

// In-memory store for active runs.
// Capped to prevent unbounded growth when runs are added but never deleted
// (e.g. if the client never polls completion or the server restarts mid-run).
const MAX_ACTIVE_RUNS = 500;
// Backed by globalThis: Next dev can compile each API route into its own
// module graph, so a plain module-level Map gives the imagine and action
// routes different registries ("Run not found" for runs created seconds ago).
const globalStore = globalThis as { __cjActiveRuns?: Map<string, ImagineRun> };
const activeRuns = (globalStore.__cjActiveRuns ??= new Map<
  string,
  ImagineRun
>());

/**
 * Evict the oldest entries when the map exceeds the cap.
 * Map iteration order is insertion order, so the first entries are oldest.
 */
function evictIfNeeded(): void {
  while (activeRuns.size > MAX_ACTIVE_RUNS) {
    const oldest = activeRuns.keys().next();
    if (oldest.done) break;
    activeRuns.delete(oldest.value);
  }
}

export function getActiveRun(runId: string): ImagineRun | undefined {
  return activeRuns.get(runId);
}

export function updateActiveRun(runId: string, run: ImagineRun): void {
  activeRuns.set(runId, run);
  evictIfNeeded();
}

export function deleteActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

export function addActiveRun(run: ImagineRun): void {
  activeRuns.set(run.run_id, run);
  evictIfNeeded();
}

export function getAllActiveRuns(): ImagineRun[] {
  return Array.from(activeRuns.values());
}

export function clearActiveRuns(): void {
  activeRuns.clear();
}
