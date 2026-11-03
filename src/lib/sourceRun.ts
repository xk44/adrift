/**
 * Resolve a run that isn't in the Create feed's loaded pages — the target of
 * a tool run's "from ↗" provenance link — via GET /api/jobs/recent?run_id=.
 */
import { runGalleryImages, type RecentHistoryRun } from "@/lib/historyHydration";
import type { GalleryImage } from "@/types";

/**
 * Images of `runId` (empty when the run is gone or has no images yet).
 * Throws on network/HTTP failure so callers can tell "missing" from "offline".
 */
export async function fetchRunImages(
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GalleryImage[]> {
  const response = await fetchImpl(
    `/api/jobs/recent?run_id=${encodeURIComponent(runId)}`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const runs =
    payload && typeof payload === "object"
      ? (payload as { ok?: unknown; runs?: unknown }).runs
      : undefined;
  if (!Array.isArray(runs)) throw new Error("malformed response");
  const run = (runs as RecentHistoryRun[]).find((r) => r?.run_id === runId);
  return run && Array.isArray(run.jobs) ? runGalleryImages(run) : [];
}
