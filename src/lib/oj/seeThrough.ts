/**
 * "Layer Split" (packs/image-tools/see_through.json): one illustration →
 * ComfyUI-See-through (SDXL LayerDiff3D + Marigold depth) → ~24 tagged,
 * amodally completed RGBA parts, each with a depth PNG, plus a
 * <prefix>_..._layers.json manifest whose server path comes back as the job's
 * text output (SavePSD → PreviewAny). The job image is CJLayerPreview
 * (cj_image_tools): the parts recomposited by depth beside a labelled sheet.
 *
 * Knobs (params): detail max (1280) | fast (1024) generation resolution,
 * steps 30 | 20, seed, split (left/right parts, tblr_split), lowVram
 * (group_offload on both loaders).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { LAYER_DETAIL_RESOLUTION } from "@/lib/layers/seeThrough";

export const SEE_THROUGH_ACTION = "see_through";

/** Node ids in see_through.json. */
export const SEE_THROUGH_ID = {
  loadImage: "1",
  layerModel: "2",
  depthModel: "3",
  layers: "4",
  depth: "5",
  post: "6",
  save: "7",
  manifest: "8",
  preview: "9",
  /** CJLayerPreview: depth composite + parts sheet, the job's thumbnail. */
  previewRender: "10",
} as const;

/** Generation resolution per detail choice (the input is padded to a square). */
export const SEE_THROUGH_RESOLUTION = LAYER_DETAIL_RESOLUTION;

export const SEE_THROUGH_STEPS = [30, 20] as const;
export const SEE_THROUGH_DEFAULT_STEPS = 30;

/** SavePSD prefix; it lands in the output root, so never a sub-path. */
export const SEE_THROUGH_PREFIX = "adrift_layers";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Booleans may arrive as picks ("on" / "off") or real booleans. */
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const v = str(value);
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return fallback;
}

export function seeThroughResolution(value: unknown): number {
  return SEE_THROUGH_RESOLUTION[str(value)] ?? SEE_THROUGH_RESOLUTION.max;
}

export function seeThroughSteps(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return (SEE_THROUGH_STEPS as readonly unknown[]).includes(n)
    ? (n as number)
    : SEE_THROUGH_DEFAULT_STEPS;
}

export function seeThroughSeed(value: unknown): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n) % 2 ** 32
    : Math.floor(Math.random() * 2 ** 32);
}

export function buildSeeThroughWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${SEE_THROUGH_ACTION}: source run has no image`);
  for (const id of Object.values(SEE_THROUGH_ID)) {
    if (!workflow[id])
      throw new Error(`${SEE_THROUGH_ACTION}: workflow is missing node ${id}`);
  }

  const seed = seeThroughSeed(params.seed);
  const lowVram = flag(params.lowVram, false);

  setNodeInput(workflow, SEE_THROUGH_ID.loadImage, "image", imageRef);
  setNodeInput(workflow, SEE_THROUGH_ID.layerModel, "group_offload", lowVram);
  setNodeInput(workflow, SEE_THROUGH_ID.depthModel, "group_offload", lowVram);
  setNodeInput(
    workflow,
    SEE_THROUGH_ID.layers,
    "resolution",
    seeThroughResolution(params.detail),
  );
  setNodeInput(
    workflow,
    SEE_THROUGH_ID.layers,
    "num_inference_steps",
    seeThroughSteps(params.steps),
  );
  setNodeInput(workflow, SEE_THROUGH_ID.layers, "seed", seed);
  setNodeInput(workflow, SEE_THROUGH_ID.depth, "seed", seed);
  setNodeInput(
    workflow,
    SEE_THROUGH_ID.post,
    "tblr_split",
    flag(params.split, true),
  );
  setNodeInput(
    workflow,
    SEE_THROUGH_ID.save,
    "filename_prefix",
    SEE_THROUGH_PREFIX,
  );

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: SEE_THROUGH_ID.loadImage,
    },
    seed,
  };
}
