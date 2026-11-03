/**
 * "Smooth motion / slow-mo" (packs/interp/interpolate.json): core ComfyUI
 * frame interpolation (RIFE 4.26 / RIFE heavy / FILM) on a source clip.
 *   smooth: fps × multiplier, same duration, source audio kept.
 *   slowmo: source fps kept, clip runs multiplier × longer. Audio is DROPPED
 *           (core nodes cannot time-stretch it; muxing the original would end
 *           early and drift).
 * Video in, video out; listed in VIDEO_INPUT_ACTIONS.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const INTERPOLATE_ACTION = "interpolate";

export const INTERP_MODELS: Record<string, string> = {
  rife: "rife_v4.26.safetensors",
  rife_heavy: "rife_v4.26_heavy.safetensors",
  film: "film_net_fp16.safetensors",
};

export function interpModel(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return INTERP_MODELS[key] ?? INTERP_MODELS.rife;
}

/**
 * Output-frame budget. FrameInterpolate holds every frame in RAM as float32
 * (1080p ≈ 25 MB/frame), so a VideoTemporalCrop head cap keeps the source at
 * floor(INTERP_MAX_OUTPUT_FRAMES / multiplier) frames (audio trims with it).
 */
export const INTERP_MAX_OUTPUT_FRAMES = 960;

export function interpSourceFrameCap(multiplier: 2 | 4): number {
  return Math.floor(INTERP_MAX_OUTPUT_FRAMES / multiplier);
}

/** 2 or 4 (anything else → 2). */
export function interpMultiplier(value: unknown): 2 | 4 {
  return Number(value) === 4 ? 4 : 2;
}

export function isSlowmo(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["slowmo", "slow-mo", "slow_mo", "slow"].includes(
      value.trim().toLowerCase(),
    )
  );
}

/** Source frame the interpolated clip starts at (non-negative int; default 0). */
export function interpStartFrame(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildInterpolateWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${INTERPOLATE_ACTION}: source run has no video`);

  const videoId = nodeIdOf(workflow, "LoadVideo");
  const componentsId = nodeIdOf(workflow, "GetVideoComponents");
  const loaderId = nodeIdOf(workflow, "FrameInterpolationModelLoader");
  const interpId = nodeIdOf(workflow, "FrameInterpolate");
  const createId = nodeIdOf(workflow, "CreateVideo");
  if (!videoId || !componentsId || !loaderId || !interpId || !createId) {
    throw new Error(
      `${INTERPOLATE_ACTION}: workflow needs LoadVideo, GetVideoComponents, FrameInterpolationModelLoader, FrameInterpolate and CreateVideo`,
    );
  }
  const multiplier = interpMultiplier(params.multiplier);
  setNodeInput(workflow, videoId, "file", videoRef);
  setNodeInput(workflow, loaderId, "model_name", interpModel(params.model));
  setNodeInput(workflow, interpId, "multiplier", multiplier);
  const capId = nodeIdOf(workflow, "VideoTemporalCrop");
  if (capId) {
    setNodeInput(workflow, capId, "start_frame", interpStartFrame(params.start_frame));
    setNodeInput(workflow, capId, "length", interpSourceFrameCap(multiplier));
  }

  const mathId = nodeIdOf(workflow, "ComfyMathExpression");
  if (isSlowmo(params.mode)) {
    setNodeInput(workflow, createId, "fps", [componentsId, 2]);
    delete workflow[createId].inputs.audio;
    if (mathId) delete workflow[mathId];
  } else {
    if (!mathId)
      throw new Error(`${INTERPOLATE_ACTION}: workflow has no fps math node`);
    setNodeInput(workflow, mathId, "expression", `a * ${multiplier}`);
    setNodeInput(workflow, mathId, "values.a", [componentsId, 2]);
    setNodeInput(workflow, createId, "fps", [mathId, 0]);
    setNodeInput(workflow, createId, "audio", [componentsId, 1]);
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: videoId,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
