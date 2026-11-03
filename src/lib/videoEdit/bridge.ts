/**
 * Bridge cut: a start/end-frame tool generates the shot between two clips
 * (last frame of one, first frame of the next); the result is inserted at
 * the cut. Pure.
 */
import {
  buildLightboxTools,
  filterLightboxTools,
  type LightboxTool,
} from "@/lib/ui/lightboxTools";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import { clipLength, clipStarts, type EditList } from "./editList";

/** Start/end-frame tools, preferred first (local open weights, then cloud). */
export const BRIDGE_TOOL_KEYS = [
  "action:ltx25_transition",
  "action:transition",
] as const;

export function bridgeTools(catalog: CatalogTool[] | null): LightboxTool[] {
  const all = filterLightboxTools(buildLightboxTools(catalog), {
    media: "image",
    external: false,
    query: "",
  });
  return BRIDGE_TOOL_KEYS.flatMap((k) => all.filter((t) => t.key === k));
}

export interface BridgePlan {
  /** Timeline time of the cut between the two clips. */
  cut: number;
  /** Timeline times to grab: last frame of the left clip, first of the right. */
  fromT: number;
  toT: number;
  /** 1-based clip numbers, for labels. */
  left: number;
  right: number;
}

/** The cut after `clipId` and where its two frames are; null at the end. */
export function bridgePlan(edit: EditList, clipId: string): BridgePlan | null {
  const i = edit.clips.findIndex((c) => c.id === clipId);
  if (i < 0 || i >= edit.clips.length - 1) return null;
  const starts = clipStarts(edit);
  const a = edit.clips[i];
  const cut = starts[i] + clipLength(a);
  // Half a frame before the cut lands on the left clip's last frame.
  const half = 0.5 / (a.src.fps > 0 ? a.src.fps : 24);
  return {
    cut,
    fromT: Math.max(starts[i], cut - Math.min(half, clipLength(a) / 2)),
    toT: cut,
    left: i + 1,
    right: i + 2,
  };
}
