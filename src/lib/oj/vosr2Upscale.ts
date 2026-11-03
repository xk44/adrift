/**
 * "Photo upscale (VOSR2)" (packs/vosr2/vosr2_upscale.json): VOSR 2.0
 * one-step diffusion super-resolution (ComfyUI-VOSR2 custom nodes), image
 * only: LoadImage → VOSR2Upscale (VOSR2ModelLoader) → SaveImage.
 *
 * Knobs (params): scale 2x | 4x (default 4x; numbers 2 / 4 also accepted,
 * anything else → 4x), color wavelet | adain | none (default wavelet). The
 * seed comes from the source job (clamped to the node's 0..int64 range).
 * Tiling is not a user knob: the builder always writes VOSR2_TILES.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const VOSR2_UPSCALE_ACTION = "upscale_vosr2";

/** Bundle folder under models/vosr2/ (VOSR2ModelLoader.model). */
export const VOSR2_MODEL_FOLDER = "VOSR2";

/** Node ids in vosr2_upscale.json. */
export const VOSR2_ID = {
  loadImage: "1",
  loader: "2",
  upscale: "3",
  save: "4",
} as const;

/**
 * VOSR2Upscale tiling, sized for a 24 GB card at 4x of a ~1 MP photo
 * (4096 px output). VOSR 2.0 was trained at up to 512 px, so the DiT must
 * tile at 512 once the output passes 512x512 (64 px overlap hides seams at
 * ~1.3x the tile count of 32). vae_tile_size 0 decodes the whole image at
 * once in fp32 and runs out of memory past ~1024 px, so the VAE tiles at
 * 1024 (node-default 32 px overlap).
 */
export const VOSR2_TILES = {
  tile_size: 512,
  tile_overlap: 64,
  vae_tile_size: 1024,
  vae_tile_overlap: 32,
} as const;

export const VOSR2_SCALES = [2, 4] as const;
export type Vosr2Scale = (typeof VOSR2_SCALES)[number];

/** VOSR2Upscale.color_alignment options (node default first). */
export const VOSR2_COLOR_METHODS = ["wavelet", "adain", "none"] as const;
export type Vosr2ColorMethod = (typeof VOSR2_COLOR_METHODS)[number];

/** "2x" / "4x" / 2 / 4 → that factor; anything else → 4. */
export function vosr2Scale(value: unknown): Vosr2Scale {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim().toLowerCase().replace(/x$/, ""))
        : NaN;
  return n === 2 ? 2 : 4;
}

export function vosr2ColorMethod(value: unknown): Vosr2ColorMethod {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (VOSR2_COLOR_METHODS as readonly string[]).includes(v)
    ? (v as Vosr2ColorMethod)
    : "wavelet";
}

/** Non-negative integer seed (the node's minimum is 0). */
export function vosr2Seed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function buildVosr2UpscaleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${VOSR2_UPSCALE_ACTION}: source run has no image`);
  for (const [id, cls] of [
    [VOSR2_ID.loadImage, "LoadImage"],
    [VOSR2_ID.loader, "VOSR2ModelLoader"],
    [VOSR2_ID.upscale, "VOSR2Upscale"],
    [VOSR2_ID.save, "SaveImage"],
  ] as const) {
    if (workflow[id]?.class_type !== cls)
      throw new Error(
        `${VOSR2_UPSCALE_ACTION}: workflow is missing ${cls} (node ${id})`,
      );
  }

  const seed = vosr2Seed(job?.seed);
  setNodeInput(workflow, VOSR2_ID.loadImage, "image", imageRef);
  setNodeInput(workflow, VOSR2_ID.upscale, "upscale", vosr2Scale(params.scale));
  setNodeInput(
    workflow,
    VOSR2_ID.upscale,
    "color_alignment",
    vosr2ColorMethod(params.color),
  );
  setNodeInput(workflow, VOSR2_ID.upscale, "seed", seed);
  for (const [key, value] of Object.entries(VOSR2_TILES))
    setNodeInput(workflow, VOSR2_ID.upscale, key, value);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: VOSR2_ID.loadImage,
    },
    seed,
  };
}
