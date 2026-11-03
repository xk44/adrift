/**
 * "Layers" (packs/qwen-layered/layers.json): Qwen-Image-Layered decomposes
 * one image into N transparent RGBA layers, core ComfyUI nodes only.
 *
 * The sampled latent holds 1 + N frames: frame 0 is the reconstructed
 * composite (decoded alone, alpha dropped, saved FIRST so it is the job's
 * first image = flattened preview), frames 1..N are the layers back to
 * front, saved as transparent PNGs. On a simple scene the model may leave
 * a layer empty (fully transparent) when N exceeds what it can separate.
 *
 * No speed LoRA exists for this model. speed "fast" (default) = template
 * 20 steps / cfg 2.5; "best" = the original 50 steps / cfg 4.0 (~2.5x time).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const LAYERS_ACTION = "layers";

export const LAYERS_COUNTS = [2, 3, 4, 6] as const;
export const LAYERS_DEFAULT_COUNT = 4;
/** Max side of the working image (the model's 640 bucket, or 1024). */
export const LAYERS_RESOLUTIONS = [640, 1024] as const;

export const LAYERS_SPEEDS = {
  fast: { steps: 20, cfg: 2.5 },
  best: { steps: 50, cfg: 4.0 },
} as const;
export type LayersSpeed = keyof typeof LAYERS_SPEEDS;

const MAX_TEXT = 1000;

export function layersCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return LAYERS_DEFAULT_COUNT;
  return Math.min(8, Math.max(2, Math.round(n)));
}

export function layersResolution(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return n === 1024 ? 1024 : 640;
}

export function layersSpeed(value: unknown): LayersSpeed {
  return value === "best" ? "best" : "fast";
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === classType)
    .sort((a, b) => Number(a) - Number(b));
}

export function buildLayersWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${LAYERS_ACTION}: source run has no image`);

  const [loadId] = nodeIdsOf(workflow, "LoadImage");
  const [scaleId] = nodeIdsOf(workflow, "ImageScaleToMaxDimension");
  const [latentId] = nodeIdsOf(workflow, "EmptyQwenImageLayeredLatentImage");
  const [samplerId] = nodeIdsOf(workflow, "KSampler");
  const positive = samplerId ? workflow[samplerId].inputs.positive : undefined;
  const refId = Array.isArray(positive) ? String(positive[0]) : "";
  const conditioning = workflow[refId]?.inputs.conditioning;
  const posId = Array.isArray(conditioning) ? String(conditioning[0]) : "";
  if (
    !loadId ||
    !scaleId ||
    !latentId ||
    !samplerId ||
    workflow[posId]?.class_type !== "CLIPTextEncode"
  ) {
    throw new Error(
      `${LAYERS_ACTION}: workflow needs LoadImage, ImageScaleToMaxDimension, EmptyQwenImageLayeredLatentImage and a KSampler whose positive is ReferenceLatent(CLIPTextEncode)`,
    );
  }

  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(
    workflow,
    scaleId,
    "largest_size",
    layersResolution(params.resolution),
  );
  setNodeInput(workflow, latentId, "layers", layersCount(params.layers));
  const caption =
    typeof (params.text ?? params.prompt) === "string"
      ? String(params.text ?? params.prompt)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_TEXT)
      : "";
  setNodeInput(workflow, posId, "text", caption);

  const speed = LAYERS_SPEEDS[layersSpeed(params.speed)];
  setNodeInput(workflow, samplerId, "steps", speed.steps);
  setNodeInput(workflow, samplerId, "cfg", speed.cfg);
  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, samplerId, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: samplerId,
      posTextId: posId,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed,
  };
}
