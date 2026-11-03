/**
 * Video editor "Tools" panel: every hub tool that takes a clip (same registry
 * as the lightbox panel, so new video tools show up without changes here),
 * annotated with how much of the range it uses and whether it takes a smart
 * selection. Plus the hand-off that sends a cut range to a tool and the
 * routing of the runs that come back. Pure (no React, no DOM).
 */

import type { ImagineRun } from "@/types";
import {
  ACTION_TOOLS,
  videoWindowSeconds,
  type CatalogTool,
  type VideoToolWindow,
} from "@/lib/tools/toolsPage";
import {
  buildLightboxTools,
  filterLightboxTools,
  groupLightboxTools,
  type LightboxTool,
  type LightboxToolGroup,
} from "@/lib/ui/lightboxTools";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_MAX_OCCURRENCES,
  SMART_TRACK_MAX_POINTS,
  SMART_TRACK_WINDOW_SECONDS,
  type SmartTrackOccurrence,
} from "@/lib/tools/smartTrack";
import type { ToolHandoff } from "@/lib/tools/toolHandoff";
import { VIDEO_SOURCE_EXT } from "./sourceRef";

export interface VideoEditorTool extends LightboxTool {
  /** Action spec id for "action:<id>" keys, else null. */
  specId: string | null;
  /** Part of the clip the tool processes (from its spec); null = all of it. */
  window: VideoToolWindow | null;
  /** Takes the editor's smart selection (click points tracked across frames). */
  smartSelect: boolean;
  /** One-line note on what the tool needs from the clip ("one face", ...). */
  hint: string;
}

const actionIdOf = (key: string) =>
  key.startsWith("action:") ? key.slice("action:".length) : null;

/** Seconds of a range starting on a clip at `fps` that `tool` processes; null = all. */
export function toolWindowSeconds(
  tool: Pick<VideoEditorTool, "window">,
  fps: number,
): number | null {
  return videoWindowSeconds(tool.window ?? undefined, fps);
}

/**
 * The part of [start, end) a tool actually renders: the cut that is sent and
 * the range its result later replaces (footage after it stays untouched).
 */
export function toolRange(
  tool: Pick<VideoEditorTool, "window">,
  start: number,
  end: number,
  fps: number,
): { start: number; end: number } {
  const w = toolWindowSeconds(tool, fps);
  return { start, end: w ? Math.min(end, start + w) : end };
}

/** The parenthesised part of an input label minus the window, as a hint. */
function labelHint(label: string | undefined): string {
  const m = label ? /\(([^)]*)\)/.exec(label) : null;
  if (!m) return "";
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/\b(first|up to)\b/i.test(s) && !/\bfps\b/i.test(s))
    .join(", ");
}

export function annotateVideoTool(tool: LightboxTool): VideoEditorTool {
  const specId = actionIdOf(tool.key);
  const spec = specId ? ACTION_TOOLS.find((s) => s.id === specId) : undefined;
  const smartSelect = Boolean(specId && SMART_TRACK_ACTIONS.has(specId));
  const smartWindow = specId ? SMART_TRACK_WINDOW_SECONDS[specId] : undefined;
  return {
    ...tool,
    specId,
    window:
      spec?.videoWindow ??
      (smartSelect && smartWindow ? { seconds: smartWindow } : null),
    smartSelect,
    hint: labelHint(spec?.videoInput),
  };
}

/** Every installed tool that takes a clip (catalog null until loaded). */
export function buildVideoEditorTools(
  catalog: CatalogTool[] | null = null,
): VideoEditorTool[] {
  return filterLightboxTools(buildLightboxTools(catalog), {
    media: "video",
    external: false,
    query: "",
  })
    .filter((t) => t.target.kind === "open")
    .map(annotateVideoTool);
}

export function filterVideoEditorTools(
  tools: VideoEditorTool[],
  query: string,
): VideoEditorTool[] {
  return filterLightboxTools(tools, {
    media: "video",
    external: false,
    query,
  }) as VideoEditorTool[];
}

/** Lightbox groups, in their usual order. */
export function groupVideoEditorTools(
  tools: VideoEditorTool[],
): LightboxToolGroup[] {
  return groupLightboxTools(tools);
}

const shortSeconds = (n: number) => `${Math.round(n * 10) / 10} s`;

/** Short trailing tag for a row: "Mask · 3 s" / "10 s" / "". */
export function videoToolNote(tool: VideoEditorTool, fps = 24): string {
  const parts: string[] = [];
  if (tool.smartSelect) parts.push("Mask");
  const w = toolWindowSeconds(tool, fps);
  if (w) parts.push(shortSeconds(w));
  return parts.join(" · ");
}

/**
 * What happens to a range of `seconds` in this tool, in plain words; null
 * when the whole range is used.
 */
export function rangeWarning(
  tool: Pick<VideoEditorTool, "window" | "title">,
  seconds: number,
  fps: number,
): string | null {
  const w = toolWindowSeconds(tool, fps);
  if (!w || seconds <= w + 0.05) return null;
  return `${tool.title} renders the first ${shortSeconds(w)} of the range; only that part is sent and replaced, the rest stays as it is.`;
}

// smart selection

/** Click on the frame, in 0..1 of the displayed picture (not pixels). */
export interface NormPoint {
  x: number;
  y: number;
}

/** One subject pick: timeline time + include / exclude clicks. */
export interface SelectionPick {
  /** Timeline seconds. */
  t: number;
  positive: NormPoint[];
  negative: NormPoint[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Add a click to the pick at `t` (same frame) or start a new pick. */
export function addPickPoint(
  picks: SelectionPick[],
  t: number,
  point: NormPoint,
  negative: boolean,
  frame: number,
): SelectionPick[] {
  const p = { x: clamp01(point.x), y: clamp01(point.y) };
  const i = picks.findIndex((k) => Math.abs(k.t - t) < frame / 2);
  if (i === -1) {
    if (picks.length >= SMART_TRACK_MAX_OCCURRENCES) return picks;
    const next: SelectionPick = negative
      ? { t, positive: [], negative: [p] }
      : { t, positive: [p], negative: [] };
    return [...picks, next].sort((a, b) => a.t - b.t);
  }
  const k = picks[i];
  if (k.positive.length + k.negative.length >= SMART_TRACK_MAX_POINTS)
    return picks;
  const updated: SelectionPick = negative
    ? { ...k, negative: [...k.negative, p] }
    : { ...k, positive: [...k.positive, p] };
  return picks.map((x, j) => (j === i ? updated : x));
}

/** Where a w×h picture lands when letterboxed into a W×H frame. */
export function fitRect(
  W: number,
  H: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  if (!(w > 0 && h > 0 && W > 0 && H > 0)) return { x: 0, y: 0, w: W, h: H };
  const k = Math.min(W / w, H / h);
  const fw = w * k;
  const fh = h * k;
  return { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh };
}

/**
 * Picks inside [start, end) → the tool's smart-track occurrences: time
 * relative to the cut, points in the cut's pixels. A pick is relative to its
 * own clip's picture, which the cut letterboxes when clip sizes differ, so
 * `sizeAt(t)` (the clip frame at timeline time t) places it inside that box.
 * Picks with no include click are dropped (the tracker needs a subject).
 */
export function picksToOccurrences(
  picks: SelectionPick[],
  start: number,
  end: number,
  cut: { width: number; height: number },
  sizeAt?: (t: number) => { width: number; height: number } | null,
): SmartTrackOccurrence[] {
  const W = Math.max(1, cut.width);
  const H = Math.max(1, cut.height);
  return picks
    .filter((k) => k.t >= start - 1e-6 && k.t < end && k.positive.length > 0)
    .slice(0, SMART_TRACK_MAX_OCCURRENCES)
    .map((k) => {
      const size = sizeAt?.(k.t);
      const r = size ? fitRect(W, H, size.width, size.height) : { x: 0, y: 0, w: W, h: H };
      const px = (p: NormPoint) => ({
        x: Math.min(W - 1, Math.max(0, Math.round(r.x + clamp01(p.x) * (r.w - 1)))),
        y: Math.min(H - 1, Math.max(0, Math.round(r.y + clamp01(p.y) * (r.h - 1)))),
      });
      return {
        t: Math.round((k.t - start) * 1000) / 1000,
        positive: k.positive.map(px),
        negative: k.negative.map(px),
      };
    });
}

// hand-off

/** Cut range ready for a tool (POST /api/video-edit/render mode "range"). */
export interface RangeCut {
  url: string;
  width: number;
  height: number;
  duration: number;
}

export function videoToolHandoff(
  tool: Pick<VideoEditorTool, "key" | "target">,
  cut: RangeCut,
  label: string,
  smartTrack: SmartTrackOccurrence[],
  now: number,
): ToolHandoff {
  const toolKey = tool.target.kind === "open" ? tool.target.toolKey : tool.key;
  return {
    toolKey,
    media: "video",
    itemId: `video-editor:${now}`,
    url: cut.url,
    label,
    width: cut.width,
    height: cut.height,
    origin: "video-editor",
    ...(smartTrack.length ? { smartTrack } : {}),
    at: now,
  };
}

// results

/** A run started from the video editor, waiting for its result. */
export interface VideoToolRun {
  runId: string;
  title: string;
  /** Timeline range the cut came from. */
  start: number;
  end: number;
  /** The cut that was sent (the "before" of the compare). */
  cutUrl: string;
  at: number;
}

export interface VideoToolOutput {
  kind: "video" | "image";
  url: string;
  runId: string;
  jobIndex: number;
}

export type VideoToolRoute =
  | { kind: "wait" }
  | { kind: "failed"; message: string }
  /** Every finished job's clip (or still), so batch variants all come back. */
  | { kind: "done"; outputs: VideoToolOutput[] }
  | { kind: "other"; output: "3d" | "audio" };

const isVideoUrl = (u: string) => {
  const name = /[?&]filename=([^&]+)/.exec(u)?.[1];
  let probe = u.split("?")[0];
  if (name) {
    try {
      probe = decodeURIComponent(name);
    } catch {
      probe = name;
    }
  }
  return VIDEO_SOURCE_EXT.test(probe);
};

/** What a tracked run turned into, once it is finished. */
export function routeVideoToolRun(
  tracked: Pick<VideoToolRun, "title">,
  run: ImagineRun | undefined,
): VideoToolRoute {
  if (!run) return { kind: "wait" };
  const jobs = run.jobs ?? [];
  if (jobs.length === 0) return { kind: "wait" };
  if (jobs.some((j) => j.status === "queued" || j.status === "running"))
    return { kind: "wait" };
  const done = jobs.filter((j) => j.status === "done");
  if (done.length === 0) {
    const failed = jobs.find((j) => j.status === "error");
    return {
      kind: "failed",
      message: failed?.error
        ? `${tracked.title} failed: ${failed.error}`
        : `${tracked.title} did not finish.`,
    };
  }
  const outputs: VideoToolOutput[] = [];
  for (const job of done) {
    const video =
      job.videos?.find(Boolean) ?? job.images?.find((u) => u && isVideoUrl(u));
    const image = video ? undefined : job.images?.find(Boolean);
    const url = video ?? image;
    if (url)
      outputs.push({
        kind: video ? "video" : "image",
        url,
        runId: run.run_id,
        jobIndex: job.index,
      });
  }
  // Clips first: when a run made both, the clips are what replaces the range.
  if (outputs.some((o) => o.kind === "video"))
    return {
      kind: "done",
      outputs: outputs.filter((o) => o.kind === "video"),
    };
  if (outputs.length) return { kind: "done", outputs };
  const job = done[0];
  if (job.meshes?.length) return { kind: "other", output: "3d" };
  if (job.audios?.length) return { kind: "other", output: "audio" };
  return { kind: "failed", message: `${tracked.title} returned nothing.` };
}
