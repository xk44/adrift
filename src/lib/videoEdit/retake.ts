/**
 * Video editor Retake: the in / out range (or selected clip) is cut with up
 * to VIDEO_RETAKE_CONTEXT_SECONDS of context on each side, the cut opens in
 * the Retake card with the range prefilled (seconds from the cut start), and
 * the result replaces the cut on the timeline (frames outside the range are
 * the source frames, so only the range changes). Pure (no React).
 */

import type { TimeRange } from "@/store/videoEditStore";
import {
  VIDEO_RETAKE_ACTION,
  videoRetakeCut,
  type VideoRetakeCut,
} from "@/lib/oj/videoRetake";

export const RETAKE_TOOL_KEY = `action:${VIDEO_RETAKE_ACTION}`;

export type RetakePlan =
  | { ok: true; cut: VideoRetakeCut }
  | { ok: false; reason: string };

export function retakePlan(
  range: TimeRange,
  duration: number,
  fps: number,
): RetakePlan {
  if (range.source === "all")
    return {
      ok: false,
      reason: "Mark the moment to retake with in / out (I and O) first.",
    };
  const cut = videoRetakeCut(range.start, range.end, duration, fps);
  if (!cut)
    return {
      ok: false,
      reason:
        range.end - range.start <= 1 / Math.max(1, fps)
          ? "The range is too short to retake."
          : "Retake takes up to about 4.5 s. Mark a shorter range.",
    };
  return { ok: true, cut };
}

/**
 * Card picks (slider strings, 0.1 s steps) for the Retake runner: the start
 * rounds down and the end up, so the whole marked range is regenerated.
 */
export function retakePrefillPicks(cut: VideoRetakeCut): Record<string, string> {
  const down = Math.floor(cut.retakeStart * 10 + 1e-6) / 10;
  const up = Math.ceil(cut.retakeEnd * 10 - 1e-6) / 10;
  return {
    retake_start: String(down),
    retake_end: String(Math.max(up, down + 0.1)),
    retake_to_end: cut.toEnd ? "1" : "",
  };
}
