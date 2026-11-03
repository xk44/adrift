/**
 * Video editor "Effects (LTX)": the LTX-2.5 video-in VFX tools surfaced as a
 * one-click row on the selected clip (or the in / out range). Each effect is
 * an ordinary hub tool from buildVideoEditorTools, so the cut, hand-off,
 * runner and result return are the Tools panel's own; this module only picks
 * them, orders them and words the LTX window limits. Pure (no React).
 */

import {
  toolWindowSeconds,
  type VideoEditorTool,
} from "@/lib/videoEdit/videoTools";

export type LtxEffectId =
  "day_to_night" | "add_water" | "clean_plate" | "alpha_matte" | "expand";

export interface LtxEffectDef {
  id: LtxEffectId;
  /** Hub tool key the effect opens ("action:<spec id>"). */
  toolKey: string;
  /** Short button label. */
  label: string;
}

/** Display order of the effects row. */
export const LTX_EFFECTS: readonly LtxEffectDef[] = [
  {
    id: "day_to_night",
    toolKey: "action:ltx_day_to_night",
    label: "Day to night",
  },
  { id: "add_water", toolKey: "action:ltx_add_water", label: "Add water" },
  {
    id: "clean_plate",
    toolKey: "action:ltx_clean_plate",
    label: "Clean plate",
  },
  {
    id: "alpha_matte",
    toolKey: "action:ltx_alpha_matte",
    label: "Alpha matte",
  },
  // Expand video defaults to its LTX-2.5 outpaint engine.
  { id: "expand", toolKey: "action:video_expand", label: "Expand" },
];

export interface LtxEffect extends LtxEffectDef {
  tool: VideoEditorTool;
}

/**
 * The effects whose tool is in the editor's tool list, in LTX_EFFECTS order.
 * A tool missing from the list (not registered for video) is left out.
 */
export function ltxEffectTools(tools: VideoEditorTool[]): LtxEffect[] {
  const byKey = new Map(tools.map((t) => [t.key, t]));
  const out: LtxEffect[] = [];
  for (const def of LTX_EFFECTS) {
    const tool = byKey.get(def.toolKey);
    if (tool) out.push({ ...def, tool });
  }
  return out;
}

const secs = (n: number) => `${Math.round(n * 10) / 10} s`;

export interface LtxEffectLimit {
  /** Seconds of footage the effect renders (its LTX window); null = all. */
  windowSeconds: number | null;
  /** The range is longer than the window. */
  over: boolean;
  /** Plain-words warning when `over`, else null. */
  warning: string | null;
}

/** How a range of `seconds` (at `fps`) fits the effect's LTX window. */
export function ltxEffectLimit(
  effect: Pick<LtxEffect, "label" | "tool">,
  seconds: number,
  fps: number,
): LtxEffectLimit {
  const w = toolWindowSeconds(effect.tool, fps);
  if (!w) return { windowSeconds: null, over: false, warning: null };
  const over = seconds > w + 0.05;
  return {
    windowSeconds: w,
    over,
    warning: over
      ? `${effect.label}: the clip is ${secs(seconds)} but the LTX window is ${secs(w)}. Only the first ${secs(w)} is sent and replaced; trim the clip or mark in / out to pick the part.`
      : null,
  };
}

/** Button tooltip: what runs on what, plus the window. */
export function ltxEffectTitle(
  effect: Pick<LtxEffect, "label" | "tool">,
  rangeText: string,
  seconds: number,
  fps: number,
): string {
  const lim = ltxEffectLimit(effect, seconds, fps);
  const parts = [`${effect.label} (LTX) on ${rangeText}`];
  if (lim.windowSeconds) parts.push(`LTX window ${secs(lim.windowSeconds)}`);
  if (lim.warning) parts.push(lim.warning);
  return parts.join(". ");
}
