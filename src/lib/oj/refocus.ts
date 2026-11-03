/**
 * Depth-of-field tools (packs/image-tools/refocus.json, rack_focus.json):
 * Depth Anything 3 depth (near = white) feeds cj_image_tools' layered lens
 * blur (CJRefocus / CJRackFocus, comfy_nodes/cj_image_tools/cj_lens_blur.py).
 *
 * - "refocus": one clicked point on a photo sets the focal plane.
 * - "rack_focus": focus pulls from point A (held until time A) to point B
 *   (landed at time B) on a clip; depth is estimated per frame and both
 *   points are re-sampled on every frame.
 *
 * Points are normalized (0..1, origin top-left); times are seconds from the
 * start of the clip.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const REFOCUS_ACTION = "refocus";
export const RACK_FOCUS_ACTION = "rack_focus";

export interface FocusPoint {
  x: number;
  y: number;
  /** Seconds into the clip (rack focus only). */
  t?: number;
}

export const REFOCUS_DEPTH_MODELS: Record<string, string> = {
  quality: "depth_anything_3_mono_large.safetensors",
  fast: "depth_anything_3_base.safetensors",
};

/** DA3 working resolution (longest side, multiple of 14). */
export const REFOCUS_DEPTH_RES = { image: 1008, video: 504 } as const;

/** Frames the rack focus renders (head of the clip): every frame is held in RAM with its depth. */
export const RACK_FOCUS_MAX_FRAMES = 241;

export const RACK_FOCUS_EASES = [
  "smooth",
  "linear",
  "ease_in",
  "ease_out",
] as const;
export type RackFocusEase = (typeof RACK_FOCUS_EASES)[number];

/** Slider 0..100 → node blur_amount (CoC radius, % of the long side, for a full near-far gap). */
export const REFOCUS_BLUR_MAX_PERCENT = 6;
export const REFOCUS_DEFAULT_BLUR = 40;
export const REFOCUS_DEFAULT_HIGHLIGHTS = 30;

export const REFOCUS_DEPTH_OF_FIELD: Record<string, number> = {
  shallow: 0.015,
  normal: 0.04,
  deep: 0.1,
};

const num = (value: unknown): number => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Any {x, y[, t]} → a clamped point, or null when x / y are missing. */
export function focusPoint(value: unknown): FocusPoint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = num(v.x);
  const y = num(v.y);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  const t = num(v.t);
  return {
    x: Math.round(clamp01(x) * 1000) / 1000,
    y: Math.round(clamp01(y) * 1000) / 1000,
    ...(Number.isNaN(t) ? {} : { t: Math.max(0, Math.round(t * 100) / 100) }),
  };
}

export function refocusBlurAmount(value: unknown): number {
  const n = num(value);
  const pct = Number.isNaN(n)
    ? REFOCUS_DEFAULT_BLUR
    : Math.min(100, Math.max(0, n));
  return Math.round((pct / 100) * REFOCUS_BLUR_MAX_PERCENT * 1000) / 1000;
}

export function refocusHighlights(value: unknown): number {
  const n = num(value);
  const pct = Number.isNaN(n)
    ? REFOCUS_DEFAULT_HIGHLIGHTS
    : Math.min(100, Math.max(0, n));
  return Math.round(pct) / 100;
}

export function refocusFocusRange(value: unknown): number {
  const key = typeof value === "string" ? value : "";
  return REFOCUS_DEPTH_OF_FIELD[key] ?? REFOCUS_DEPTH_OF_FIELD.normal;
}

export function refocusDepthModel(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  return REFOCUS_DEPTH_MODELS[key] ?? REFOCUS_DEPTH_MODELS.quality;
}

export function rackFocusEase(value: unknown): RackFocusEase {
  return (RACK_FOCUS_EASES as readonly unknown[]).includes(value)
    ? (value as RackFocusEase)
    : "smooth";
}

/**
 * Rack points in time order. A missing time defaults to the clip start (A)
 * or 2 s after A (B); a B before A is swapped.
 */
export function rackFocusPoints(
  a: unknown,
  b: unknown,
): { a: Required<FocusPoint>; b: Required<FocusPoint> } {
  const pa = focusPoint(a);
  const pb = focusPoint(b);
  if (!pa || !pb)
    throw new Error(`${RACK_FOCUS_ACTION}: pick focus point A and point B`);
  const ta = pa.t ?? 0;
  const tb = pb.t ?? ta + 2;
  const A = { x: pa.x, y: pa.y, t: ta };
  const B = { x: pb.x, y: pb.y, t: tb };
  return tb < ta ? { a: B, b: A } : { a: A, b: B };
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === classType)
    .sort((a, b) => Number(a) - Number(b));
}

const noSampler = (imageInputId: string): WorkflowSlots => ({
  ksamplerId: "",
  posTextId: "",
  posTextInputName: "text",
  negTextId: "",
  latentDimsId: "",
  imageInputId,
});

function setDepth(
  workflow: Workflow,
  action: string,
  params: Record<string, unknown>,
  resolution: number,
) {
  const [loaderId] = nodeIdsOf(workflow, "LoadDA3Model");
  const [inferId] = nodeIdsOf(workflow, "DA3Inference");
  if (!loaderId || !inferId)
    throw new Error(`${action}: workflow needs LoadDA3Model and DA3Inference`);
  setNodeInput(
    workflow,
    loaderId,
    "model_name",
    refocusDepthModel(params.depthModel),
  );
  setNodeInput(workflow, inferId, "resolution", resolution);
}

function setLens(
  workflow: Workflow,
  nodeId: string,
  params: Record<string, unknown>,
) {
  setNodeInput(workflow, nodeId, "blur_amount", refocusBlurAmount(params.blur));
  setNodeInput(
    workflow,
    nodeId,
    "highlights",
    refocusHighlights(params.highlights),
  );
  setNodeInput(
    workflow,
    nodeId,
    "focus_range",
    refocusFocusRange(params.depthOfField),
  );
}

export function buildRefocusWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${REFOCUS_ACTION}: source run has no image`);
  const [loadId] = nodeIdsOf(workflow, "LoadImage");
  const [lensId] = nodeIdsOf(workflow, "CJRefocus");
  if (!loadId || !lensId)
    throw new Error(
      `${REFOCUS_ACTION}: workflow needs LoadImage and CJRefocus`,
    );
  const focus = focusPoint(params.focus) ?? { x: 0.5, y: 0.5 };
  setNodeInput(workflow, loadId, "image", imageRef);
  setDepth(workflow, REFOCUS_ACTION, params, REFOCUS_DEPTH_RES.image);
  setNodeInput(workflow, lensId, "focus_x", focus.x);
  setNodeInput(workflow, lensId, "focus_y", focus.y);
  setLens(workflow, lensId, params);
  return { workflow, slots: noSampler(loadId), seed: 0 };
}

export function buildRackFocusWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${RACK_FOCUS_ACTION}: source run has no video`);
  const [videoId] = nodeIdsOf(workflow, "LoadVideo");
  const [lensId] = nodeIdsOf(workflow, "CJRackFocus");
  if (!videoId || !lensId)
    throw new Error(
      `${RACK_FOCUS_ACTION}: workflow needs LoadVideo and CJRackFocus`,
    );
  const { a, b } = rackFocusPoints(params.focusA, params.focusB);
  setNodeInput(workflow, videoId, "file", videoRef);
  const [capId] = nodeIdsOf(workflow, "VideoTemporalCrop");
  if (capId) {
    setNodeInput(workflow, capId, "start_frame", 0);
    setNodeInput(workflow, capId, "length", RACK_FOCUS_MAX_FRAMES);
  }
  setDepth(workflow, RACK_FOCUS_ACTION, params, REFOCUS_DEPTH_RES.video);
  setNodeInput(workflow, lensId, "a_x", a.x);
  setNodeInput(workflow, lensId, "a_y", a.y);
  setNodeInput(workflow, lensId, "a_time", a.t);
  setNodeInput(workflow, lensId, "b_x", b.x);
  setNodeInput(workflow, lensId, "b_y", b.y);
  setNodeInput(workflow, lensId, "b_time", b.t);
  setNodeInput(workflow, lensId, "ease", rackFocusEase(params.ease));
  setLens(workflow, lensId, params);
  return {
    workflow,
    slots: noSampler(videoId),
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
