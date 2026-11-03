/**
 * Pure helpers for the tool runner "studio" layout: a controls column, a
 * large preview stage, one Generate button with a time hint and a strip of
 * this tool's recent results.
 */
import type { ImagineRun } from "@/types";
import type { ActionPicker } from "./toolsPage";
import { coverBackground, coverSpec, patternStyle } from "./hubVisuals";
import type { HubCategory } from "./hub";

/**
 * Picker keys that are named looks / presets: drawn as a visual grid of
 * preset tiles instead of segmented pills or a chip list. Speed, length,
 * engine and other plain settings stay compact.
 */
export const PRESET_PICKER_KEYS: ReadonlySet<string> = new Set([
  "preset",
  "look",
  "light",
  "camera",
  "cameraMove",
  "asmr",
]);

/** A picker shown as a preset tile grid (named looks with 4+ options). */
export function isPresetPicker(
  p: Pick<ActionPicker, "key" | "options">,
): boolean {
  return PRESET_PICKER_KEYS.has(p.key) && p.options.length >= 4;
}

/** Tiles past this count get a search box and a scrolling grid. */
export const PRESET_GRID_SCROLL_MIN = 13;

/**
 * Procedural tile art for a preset: the hub cover gradient seeded by the
 * picker + option id, so each preset keeps one stable look across visits.
 */
export function presetThumb(
  pickerKey: string,
  optionId: string,
): {
  background: string;
  pattern: { backgroundImage: string; backgroundSize: string };
} {
  const spec = coverSpec({
    key: `preset:${pickerKey}:${optionId}`,
    hubCategory: "Image",
  });
  return {
    background: coverBackground(spec),
    pattern: patternStyle(spec.pattern),
  };
}

/** What a run is expected to make, for the Generate time hint. */
export type RunOutput = "image" | "video" | "audio" | "text";

/** Hub section to output kind (apps are image edits unless they chain video). */
export function outputForCategory(
  hubCategory: HubCategory | string | null | undefined,
  toolCategory?: string | null,
): RunOutput {
  if (hubCategory === "Audio" || toolCategory === "Audio") return "audio";
  if (
    hubCategory === "Video" ||
    hubCategory === "VFX" ||
    toolCategory === "Animate & 3D" ||
    toolCategory === "LTX VFX"
  )
    return "video";
  if (toolCategory === "Describe") return "text";
  return "image";
}

/**
 * Rough wall time on a 24 GB consumer GPU once models are loaded. A hint,
 * not a promise: first runs also load weights.
 */
export function runTimeHint(output: RunOutput, fast = false): string {
  switch (output) {
    case "video":
      return fast ? "~1 min" : "~2-4 min";
    case "audio":
      return "~30 s";
    case "text":
      return "~10 s";
    default:
      return fast ? "~10 s" : "~30 s";
  }
}

/** One line under Generate: cost (always free, local weights) + time. */
export function runHintLine(output: RunOutput, fast = false): string {
  return `Free · runs on your GPU · ${runTimeHint(output, fast)}`;
}

/** True when the picks select a fast / turbo path. */
export function picksAreFast(
  picks: Record<string, string | undefined>,
): boolean {
  return ["speed", "mode", "h3Speed", "quality"].some((k) => {
    const v = picks[k];
    return typeof v === "string" && /fast|turbo|lightning|distill/i.test(v);
  });
}

/** Most recent results kept per tool in the strip. */
export const RECENT_RUNS_CAP = 12;

/**
 * Run ids that appeared since `seen` was taken, newest first. Runs loaded
 * from the shared server history are never "new" (they are not this tool's
 * session and may belong to anyone on the server).
 */
export function newRunIds(
  seen: ReadonlySet<string>,
  runs: readonly ImagineRun[],
): string[] {
  return runs
    .filter((r) => !seen.has(r.run_id) && r.historySource !== "server")
    .map((r) => r.run_id);
}

/** Prepend fresh ids (deduped), capped. */
export function mergeRecentIds(
  prev: readonly string[],
  fresh: readonly string[],
  cap = RECENT_RUNS_CAP,
): string[] {
  const out: string[] = [];
  for (const id of [...fresh, ...prev]) if (!out.includes(id)) out.push(id);
  return out.slice(0, cap);
}

/** Ids resolved against the store (dropped runs disappear), in id order. */
export function resolveRecentRuns(
  ids: readonly string[],
  runs: readonly ImagineRun[],
): ImagineRun[] {
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is ImagineRun => !!r);
}

/** Thumbnail for the recent strip: first finished image/video, else null. */
export function runThumb(
  run: ImagineRun,
): { kind: "image" | "video"; url: string } | null {
  for (const job of run.jobs) {
    if (job.status !== "done") continue;
    if (job.images?.length) return { kind: "image", url: job.images[0] };
    if (job.videos?.length) return { kind: "video", url: job.videos[0] };
  }
  return null;
}

/** Strip state of a run: still working, failed, finished. */
export function runPhase(run: ImagineRun): "working" | "error" | "done" {
  const jobs = run.jobs;
  if (!jobs.length) return "working";
  if (jobs.some((j) => j.status === "running" || j.status === "queued"))
    return "working";
  if (jobs.every((j) => j.status === "error" || j.status === "cancelled"))
    return "error";
  return "done";
}
