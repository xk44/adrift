/**
 * Video editor: what accepting a tool result should keep from the range it
 * replaces. Most video tools return picture only and at their own frame
 * rate (Wan: 16 fps); dropped straight in, the edit would lose its sound
 * there and the export would switch rate. Pure.
 */
import { rangeSegments, type EditList, type VideoSource } from "./editList";

export interface ConformPlan {
  /** The replaced range has sound worth keeping. */
  rangeHasAudio: boolean;
  /** Default for "keep the original sound". */
  keepAudio: boolean;
  /** Frame rate of the edit where the result goes. */
  editFps: number;
  /** The result's rate differs from the edit's. */
  fpsDiffers: boolean;
  /** Default for "match the edit's frame rate". */
  matchFps: boolean;
}

export function conformPlan(
  edit: EditList,
  start: number,
  end: number,
  result: VideoSource,
): ConformPlan {
  const segs = rangeSegments(edit, start, Math.max(end, start + 1e-3));
  const rangeHasAudio = segs.some(
    (s) => s.hasAudio && !s.muted && s.volume > 0,
  );
  const editFps = segs[0]?.fps || edit.clips[0]?.src.fps || 24;
  const fpsDiffers = Math.abs(result.fps - editFps) > 0.01;
  return {
    rangeHasAudio,
    // A result with its own sound (lip-sync, add sound) keeps it.
    keepAudio: rangeHasAudio && !result.hasAudio,
    editFps,
    fpsDiffers,
    // A much higher rate is most likely a smoothing pass: keep it.
    matchFps: fpsDiffers && result.fps < editFps * 1.5,
  };
}
