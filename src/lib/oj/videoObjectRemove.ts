/**
 * "Remove object from video" / "Remove text from video"
 * (packs/wan22/video_object_remove.json, one graph for both actions).
 *
 * SAM 3.1 tracks whatever the text prompt names through the clip, the mask is
 * grown and dilated in time (CJMaskTemporal max), Wan2.2 Fun VACE repaints
 * only the masked pixels (original frames as control video, mask as
 * control_masks), and CJPasteBackSave keeps the source everywhere outside the
 * mask at source resolution and copies the source audio. Only the masked area
 * can change. control_masks and the paste-back's allowed area take a second,
 * wider temporal dilation (node 38, see vaceMask.ts) so VACE's 1-in-4 latent
 * mask sampling never leaves a greyed patch un-regenerated (grey smear).
 * params.temporalRadius overrides the first dilation (k frames each side).
 *
 * - video_object_remove: "What to remove" (any object, comma-separated for
 *   several; a person works too, but person_remove keeps the H3 relay recipe).
 * - video_remove_text: SAM prompt from a preset (captions / watermark / all
 *   text) or a custom one; more objects, a denser detect interval and a wider
 *   mask, since glyphs are thin and SAM finds them frame by frame.
 * - Both: params.smartTrack (Smart select clicks) replaces the text SAM branch.
 *
 * Limits: LabsH3PrepareVideo resamples to 24 fps, ~0.5 MP on the 32-px grid
 * and keeps the first VIDEO_REMOVE_SECONDS (73 frames = a 4n+1 VACE window),
 * modest for a 24 GB GPU.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyVaceSpeed, vaceSpeed } from "./vaceVideo";
import { maskTemporalRadius, vaceMaskAliasRadius } from "./vaceMask";
import {
  applySmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";

export const VIDEO_OBJECT_REMOVE_ACTION = "video_object_remove";
export const VIDEO_REMOVE_TEXT_ACTION = "video_remove_text";

/** 24 fps window: 3 s -> 73 frames (17n+5 prep window, also 4n+1 for VACE). */
export const VIDEO_REMOVE_SECONDS = 3.0;
export const VIDEO_REMOVE_LENGTH = 73;

/** Fixed node ids in packs/wan22/video_object_remove.json. */
export const VOR_NODES = {
  loraHi: "5",
  shiftHi: "7",
  pos: "9",
  neg: "10",
  vace: "11",
  hi: "12",
  lo: "13",
  paste: "17",
  load: "20",
  prep: "21",
  samModel: "30",
  samText: "31",
  track: "32",
  trackMask: "33",
  grow: "34",
  temporal: "35",
  latentMask: "38",
} as const;

export const VIDEO_OBJECT_DEFAULT_TARGET = "object";

/** SAM 3.1 prompts: comma-separated, ":N" = max detections for that prompt. */
export const VIDEO_TEXT_PRESETS: Record<
  string,
  { label: string; sam: string }
> = {
  all: {
    label: "All text",
    sam: "text:8, subtitle:4, caption:4, watermark:2, logo:2",
  },
  captions: { label: "Captions / subtitles", sam: "subtitle:4, caption:4" },
  watermark: { label: "Watermark / logo", sam: "watermark:2, logo:2" },
};

export const VIDEO_TEXT_DEFAULT_PRESET = "all";

const OBJECT_TUNING = {
  threshold: 0.4,
  // Targets + their shadows (withTargetShadows).
  maxObjects: 8,
  detectInterval: 4,
  grow: 10,
  temporal: 2,
};
const TEXT_TUNING = {
  threshold: 0.35,
  maxObjects: 16,
  detectInterval: 2,
  grow: 16,
  temporal: 3,
};

const BASE_NEGATIVE =
  "blurry, smeared, ghosting, artifacts, low quality, distorted, worst quality, jpeg artifacts";

export function cleanRemoveTarget(value: unknown, fallback: string): string {
  const t =
    typeof value === "string"
      ? value
          .replace(/\s+/g, " ")
          .replace(/^[\s,]+|[\s,]+$/g, "")
          .slice(0, 120)
          .trim()
      : "";
  return t || fallback;
}

/** Readable name for prompts: "cup:2, bag" -> "cup, bag". */
export function plainTarget(target: string): string {
  return target
    .split(",")
    .map((p) => p.replace(/:\s*\d+\s*$/, "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * SAM prompt for object removal: each target plus "<target> shadow". A cast
 * shadow left outside the mask makes VACE paint a matching object back
 * (real-footage pass: "red car" came back as a grey van riding its own
 * shadow; "red car, red car shadow" left an empty road). Skipped when the
 * target already names a shadow or keepShadow is set.
 */
export function withTargetShadows(target: string, keepShadow = false): string {
  if (keepShadow || /shadow/i.test(target)) return target;
  const shadows = plainTarget(target)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `${t} shadow`);
  return shadows.length ? `${target}, ${shadows.join(", ")}` : target;
}

export const OBJECT_REMOVE_POSITIVE =
  "Empty clean background, natural continuation of the surrounding surfaces, textures and lighting, " +
  "consistent with the rest of the video.";

export function objectRemovePrompts(target: string): {
  positive: string;
  negative: string;
} {
  const plain = plainTarget(target) || VIDEO_OBJECT_DEFAULT_TARGET;
  // The positive must never name the target: umT5 has no negation ("without
  // the red car" reads as "red car"), and fast mode samples at cfg 1, which
  // ignores the negative entirely, so the named object was painted back in.
  return {
    positive: OBJECT_REMOVE_POSITIVE,
    negative: `${plain}, shadow of the ${plain}, ${BASE_NEGATIVE}`,
  };
}

export const TEXT_REMOVE_PROMPTS = {
  positive:
    "Clean video without any text, captions, subtitles, watermarks or logos, natural continuation of the background surfaces, textures and lighting.",
  negative: `text, letters, words, captions, subtitles, watermark, logo, typography, ${BASE_NEGATIVE}`,
};

export function videoTextPreset(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(VIDEO_TEXT_PRESETS, key)
    ? key
    : VIDEO_TEXT_DEFAULT_PRESET;
}

/**
 * Mask timing shared by the VACE removal/swap graphs: node 35 (radius k)
 * greys the control video; node 38 widens it by the VACE latent alias radius
 * for control_masks and the paste-back's expanded_mask.
 */
export function applyVaceMaskTiming(
  workflow: Workflow,
  temporalRadius: number,
  length: number = VIDEO_REMOVE_LENGTH,
): void {
  setNodeInput(workflow, VOR_NODES.temporal, "radius", temporalRadius);
  setNodeInput(workflow, VOR_NODES.latentMask, "mask", [VOR_NODES.temporal, 0]);
  setNodeInput(workflow, VOR_NODES.latentMask, "mode", "max");
  setNodeInput(
    workflow,
    VOR_NODES.latentMask,
    "radius",
    vaceMaskAliasRadius(length),
  );
  setNodeInput(workflow, VOR_NODES.vace, "control_masks", [
    VOR_NODES.latentMask,
    0,
  ]);
  setNodeInput(workflow, VOR_NODES.paste, "expanded_mask", [
    VOR_NODES.latentMask,
    0,
  ]);
}

function buildRemove(
  action: string,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
  mode: "object" | "text",
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);
  for (const id of Object.values(VOR_NODES)) {
    if (!workflow[id])
      throw new Error(`${action}: workflow is missing node ${id}`);
  }

  setNodeInput(workflow, VOR_NODES.load, "file", videoRef);
  setNodeInput(
    workflow,
    VOR_NODES.prep,
    "duration_seconds",
    VIDEO_REMOVE_SECONDS,
  );
  setNodeInput(workflow, VOR_NODES.vace, "length", VIDEO_REMOVE_LENGTH);

  let sam: string;
  let prompts: { positive: string; negative: string };
  if (mode === "text") {
    const custom = cleanRemoveTarget(params.target, "");
    sam = custom || VIDEO_TEXT_PRESETS[videoTextPreset(params.textPreset)].sam;
    prompts = TEXT_REMOVE_PROMPTS;
  } else {
    const target = cleanRemoveTarget(params.target, VIDEO_OBJECT_DEFAULT_TARGET);
    sam = withTargetShadows(target, params.keepShadow === true);
    prompts = objectRemovePrompts(target);
  }
  const tune = mode === "text" ? TEXT_TUNING : OBJECT_TUNING;
  setNodeInput(workflow, VOR_NODES.samText, "text", sam);
  setNodeInput(
    workflow,
    VOR_NODES.track,
    "detection_threshold",
    tune.threshold,
  );
  setNodeInput(workflow, VOR_NODES.track, "max_objects", tune.maxObjects);
  setNodeInput(
    workflow,
    VOR_NODES.track,
    "detect_interval",
    tune.detectInterval,
  );
  setNodeInput(workflow, VOR_NODES.grow, "expand", tune.grow);
  // Smart select (both modes): the clicked + tracked subject replaces the
  // text SAM branch; text mode keeps its wider grow / temporal dilation.
  const clicks = occurrencesInWindow(
    parseSmartTrack(params.smartTrack),
    VIDEO_REMOVE_SECONDS,
    action,
  );
  if (clicks.length > 0) {
    applySmartTrack(workflow, {
      sourceVideo: [VOR_NODES.load, 0],
      frames: [VOR_NODES.prep, 0],
      width: [VOR_NODES.prep, 2],
      height: [VOR_NODES.prep, 3],
      samModel: [VOR_NODES.samModel, 0],
      occurrences: clicks,
      replace: [VOR_NODES.trackMask, 0],
      remove: [VOR_NODES.track, VOR_NODES.trackMask],
    });
  }
  applyVaceMaskTiming(
    workflow,
    maskTemporalRadius(params.temporalRadius, tune.temporal),
  );
  setNodeInput(workflow, VOR_NODES.pos, "text", prompts.positive);
  setNodeInput(workflow, VOR_NODES.neg, "text", prompts.negative);
  setNodeInput(workflow, VOR_NODES.paste, "protect_text", false);
  setNodeInput(
    workflow,
    VOR_NODES.paste,
    "filename_prefix",
    mode === "text" ? "video/CJ_TextRemove" : "video/CJ_ObjectRemove",
  );

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, VOR_NODES.hi, "noise_seed", seed);
  applyVaceSpeed(
    workflow,
    {
      hi: VOR_NODES.hi,
      lo: VOR_NODES.lo,
      loraHi: VOR_NODES.loraHi,
      shiftHi: VOR_NODES.shiftHi,
    },
    vaceSpeed(params.speed),
  );

  return {
    workflow,
    slots: {
      ksamplerId: VOR_NODES.hi,
      posTextId: VOR_NODES.pos,
      posTextInputName: "text",
      negTextId: VOR_NODES.neg,
      latentDimsId: "",
      imageInputId: VOR_NODES.load,
    },
    seed,
  };
}

export function buildVideoObjectRemoveWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildRemove(
    VIDEO_OBJECT_REMOVE_ACTION,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
    "object",
  );
}

export function buildVideoRemoveTextWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildRemove(
    VIDEO_REMOVE_TEXT_ACTION,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
    "text",
  );
}
