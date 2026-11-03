/**
 * "Upscale video" Fast engine (packs/utility/video_upscale.json): every frame
 * through the user's video upscaler, batched (KJNodes
 * ImageUpscaleWithModelBatched), then to the target size.
 *
 *   2x     downscale_ratio = 2 / model factor, no resize node
 *   1080p  shorter side 1080, 4k longer side 3840 (ResizeImageMaskNode);
 *          downscale_ratio brings the model output just above the target
 *          when the source size is known, so 4x frames never pile up
 *
 * The loader is "default" (Settings → Upscaler, video row) unless
 * params.upscale_model pins one; the submit-time resolver rescales
 * downscale_ratio when it swaps in a model with another factor.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  DEFAULT_MODEL_SCALE,
  UPSCALE_MODEL_PARAM,
  UPSCALE_SIZE_PARAM,
  VIDEO_UPSCALE_ACTION,
  sanitizeUpscaleModel,
  videoUpscaleScale,
  type VideoUpscaleScale,
} from "@/lib/upscale/upscaleModels";
import { knownScale } from "@/lib/upscale/upscalerPref";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export { VIDEO_UPSCALE_ACTION };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ResizeImageMaskNode inputs for an absolute target; null for 2x. */
export function videoUpscaleResizeInputs(
  scale: VideoUpscaleScale,
): Record<string, string | number> | null {
  if (scale === "1080p") {
    return {
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
    };
  }
  if (scale === "4k") {
    return {
      resize_type: "scale longer dimension",
      "resize_type.longer_size": 3840,
    };
  }
  return null;
}

/**
 * Per-batch downscale after the model: exact for 2x; for 1080p / 4k the
 * smallest ratio that still lands at or above the target (source size
 * known), else half the model's output.
 */
export function videoDownscaleRatio(
  scale: VideoUpscaleScale,
  modelScale: number,
  source?: { width?: number; height?: number },
): number {
  if (scale === "2x") return Math.min(1, round2(2 / modelScale));
  const w = source?.width ?? 0;
  const h = source?.height ?? 0;
  if (w > 0 && h > 0) {
    const want =
      scale === "1080p" ? 1080 / Math.min(w, h) : 3840 / Math.max(w, h);
    const r = Math.ceil((want / modelScale) * 100) / 100;
    return Math.min(1, Math.max(0.01, r));
  }
  return Math.min(1, round2(2 / modelScale));
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildVideoUpscaleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${VIDEO_UPSCALE_ACTION}: source has no video`);

  const ids: Record<string, string | undefined> = {};
  for (const cls of [
    "LoadVideo",
    "UpscaleModelLoader",
    "ImageUpscaleWithModelBatched",
    "ResizeImageMaskNode",
    "CreateVideo",
  ]) {
    ids[cls] = nodeIdOf(workflow, cls);
  }
  const missing = Object.entries(ids)
    .filter(([cls, id]) => !id && cls !== "ResizeImageMaskNode")
    .map(([cls]) => cls);
  if (missing.length) {
    throw new Error(
      `${VIDEO_UPSCALE_ACTION}: workflow is missing ${missing.join(", ")}`,
    );
  }
  const loadId = ids.LoadVideo as string;
  const loaderId = ids.UpscaleModelLoader as string;
  const upId = ids.ImageUpscaleWithModelBatched as string;
  const createId = ids.CreateVideo as string;
  const resizeId = ids.ResizeImageMaskNode;

  setNodeInput(workflow, loadId, "file", videoRef);

  const chosen = sanitizeUpscaleModel(params[UPSCALE_MODEL_PARAM]);
  if (chosen) setNodeInput(workflow, loaderId, "model_name", chosen);
  const loader = workflow[loaderId];
  loader._meta = {
    ...loader._meta,
    upscaler: chosen ? "fixed" : "default",
    upscaleContent: "video",
  };
  const model = String(loader.inputs.model_name ?? "");
  const modelScale = knownScale(model) ?? DEFAULT_MODEL_SCALE;

  const scale = videoUpscaleScale(params[UPSCALE_SIZE_PARAM]);
  setNodeInput(
    workflow,
    upId,
    "downscale_ratio",
    videoDownscaleRatio(scale, modelScale, sourceRun),
  );
  const resize = videoUpscaleResizeInputs(scale);
  if (resize && resizeId) {
    const inputs = workflow[resizeId].inputs;
    for (const key of Object.keys(inputs)) {
      if (key.startsWith("resize_type")) delete inputs[key];
    }
    Object.assign(inputs, resize);
    setNodeInput(workflow, resizeId, "input", [upId, 0]);
    setNodeInput(workflow, createId, "images", [resizeId, 0]);
  } else {
    setNodeInput(workflow, createId, "images", [upId, 0]);
    if (resizeId) delete workflow[resizeId];
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
