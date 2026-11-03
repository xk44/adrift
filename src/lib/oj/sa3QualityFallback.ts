/**
 * Stable Audio 3 "Quality" speed needs the Medium base checkpoint. When the
 * backend doesn't list it, the action route runs Fast instead (SA3_SPEEDS.fast:
 * medium checkpoint, 8 steps, cfg 1) and says so in `warnings.nodes`, the
 * degraded-but-queued channel every job client already toasts (same as
 * bypassed optional nodes). The run's params record speed "fast".
 *
 * Unknown listing (backend unreachable / no CheckpointLoaderSimple) → keep
 * what was asked; queue-time validation reports a real missing file.
 */
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  SA3_ACTIONS,
  SA3_MEDIUM_BASE_CKPT,
  checkpointsFromObjectInfo,
} from "./sa3Params";

export const SA3_QUALITY_FALLBACK_NOTE = `Quality needs ${SA3_MEDIUM_BASE_CKPT}, which isn't installed. Ran Fast instead.`;

const base = (f: string) =>
  f.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";

/** Note to return when `params` must drop to Fast, else null (pure). */
export function sa3QualityFallbackNote(
  action: string,
  params: Record<string, unknown>,
  checkpoints: string[] | null,
): string | null {
  if (!SA3_ACTIONS.includes(action) || params.speed !== "quality") return null;
  if (!checkpoints) return null;
  const want = SA3_MEDIUM_BASE_CKPT.toLowerCase();
  return checkpoints.some((c) => base(c) === want)
    ? null
    : SA3_QUALITY_FALLBACK_NOTE;
}

/** Route step: downgrades params.speed in place; returns the note, if any. */
export async function applySa3QualityFallback(
  action: string,
  params: Record<string, unknown>,
  baseUrl?: string,
): Promise<string | null> {
  if (!SA3_ACTIONS.includes(action) || params.speed !== "quality") return null;
  const info = await getObjectInfoCached(baseUrl);
  const note = sa3QualityFallbackNote(
    action,
    params,
    checkpointsFromObjectInfo(info),
  );
  if (note) params.speed = "fast";
  return note;
}
