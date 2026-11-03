/**
 * Upscale video, engine "NVIDIA RTX" (packs/rtx/rtx_upscale.json): NVIDIA RTX
 * Video Super Resolution through Comfy-Org/Nvidia_RTX_Nodes_ComfyUI. Runs
 * locally (not an API node) but calls NVIDIA's proprietary nvidia-vfx SDK,
 * so it is opt-in and never counts as open weights. Deterministic and
 * non-generative: sharper than bicubic, no invented detail.
 * Size choices match the other engines' picks: "2x" (stops at a 3840 long
 * side), "1080p" (short side 1080), "4k" (long side 3840). The node allows up
 * to 4x and has no VRAM limit worth capping, but the upscaled clip is held in
 * RAM as a float tensor, so the graph caps it at RTX_MAX_PIXEL_FRAMES
 * pixel-frames (240 frames at 4K) and 4096 frames.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { seedvr2Scale, type Seedvr2Scale } from "./seedvr2Upscale";

export const RTX_UPSCALE_ACTION = "rtx_upscale";

/** Width x height x frames the template keeps (its "Frame cap" node). */
export const RTX_MAX_PIXEL_FRAMES = 1_990_656_000;

export const RTX_DEFAULT_QUALITY = "HIGHBITRATE_ULTRA";

/** Scale factor expression over source width (a) and height (b), 1x..4x. */
export function rtxScaleExpression(scale: unknown): string {
  const s: Seedvr2Scale = seedvr2Scale(scale);
  if (s === "1080p") return "max(1, min(4, 1080 / min(a, b)))";
  if (s === "4k") return "max(1, min(4, 3840 / max(a, b)))";
  return "min(2, max(1, 3840 / max(a, b)))";
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildRtxUpscaleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const ref = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!ref) throw new Error(`${RTX_UPSCALE_ACTION}: source run has no video`);

  const load = nodeIdOf(workflow, "LoadVideo");
  const vsr = nodeIdOf(workflow, "RTXVideoSuperResolution");
  const scale = Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === "ComfyMathExpression" &&
      workflow[id]._meta?.title === "Scale factor",
  );
  const missing = [
    ["LoadVideo", load],
    ["RTXVideoSuperResolution", vsr],
    ["ComfyMathExpression (Scale factor)", scale],
  ]
    .filter(([, id]) => !id)
    .map(([cls]) => cls);
  if (missing.length) {
    throw new Error(
      `${RTX_UPSCALE_ACTION}: workflow is missing ${missing.join(", ")}`,
    );
  }

  setNodeInput(workflow, load!, "file", ref);
  setNodeInput(
    workflow,
    scale!,
    "expression",
    rtxScaleExpression(params.scale),
  );
  setNodeInput(workflow, vsr!, "quality", RTX_DEFAULT_QUALITY);

  const seed = typeof job?.seed === "number" ? job.seed : 0;
  return {
    workflow,
    slots: {
      ksamplerId: vsr!,
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: load!,
    },
    seed,
  };
}
