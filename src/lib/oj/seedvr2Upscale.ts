/**
 * "Upscale (SeedVR2)" (packs/seedvr2/seedvr2_upscale.json): core ComfyUI
 * SeedVR2 one-step restoration upscale for images AND clips. The graph carries
 * both branches; the builder looks at the source job (video first unless
 * `params.media === "image"`) and keeps one:
 *   image: LoadImage → Resize → … → SaveImage
 *   video: LoadVideo → GetVideoComponents → Resize → … → TemporalChunk (auto,
 *          sized to free VRAM) → sampler → TemporalMerge → … → CreateVideo
 *          (source fps + audio) → SaveVideo
 * Encode/decode are tiled (512 px, 64-frame temporal tiles) so a 24 GB card
 * survives 1080p video. Not in VIDEO_INPUT_ACTIONS: image sources are valid.
 * params.model picks the DiT (fast = 3B, quality = 7B, sharp = 7B sharp; the
 * pack lists the 7B loaders as optional nodes so setup/docs know the files,
 * and the builder drops them). params.color sets SeedVR2PostProcessing's
 * color match (lab default).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { isOptionalNode } from "@/lib/comfy/optionalNodes";

export const SEEDVR2_UPSCALE_ACTION = "seedvr2_upscale";

export type Seedvr2ModelId = "fast" | "quality" | "sharp";

export const SEEDVR2_MODELS: Record<Seedvr2ModelId, string> = {
  fast: "seedvr2_3b_fp8_e4m3fn.safetensors",
  quality: "seedvr2_7b_fp8_e4m3fn.safetensors",
  sharp: "seedvr2_7b_sharp_fp8_e4m3fn.safetensors",
};

/** SeedVR2PostProcessing.color_correction_method options (core ComfyUI). */
export const SEEDVR2_COLOR_METHODS = ["lab", "wavelet", "adain", "none"] as const;
export type Seedvr2ColorMethod = (typeof SEEDVR2_COLOR_METHODS)[number];

export function seedvr2ColorMethod(value: unknown): Seedvr2ColorMethod {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SEEDVR2_COLOR_METHODS as readonly string[]).includes(v)
    ? (v as Seedvr2ColorMethod)
    : "lab";
}

export type Seedvr2Scale = "2x" | "1080p" | "4k";
export const SEEDVR2_SCALES: Seedvr2Scale[] = ["2x", "1080p", "4k"];

export function seedvr2Scale(value: unknown): Seedvr2Scale {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SEEDVR2_SCALES as string[]).includes(v) ? (v as Seedvr2Scale) : "2x";
}

export function seedvr2Model(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return key in SEEDVR2_MODELS
    ? SEEDVR2_MODELS[key as Seedvr2ModelId]
    : SEEDVR2_MODELS.fast;
}

/**
 * ResizeImageMaskNode inputs for a scale choice. "1080p" = shorter side 1080,
 * "4k" = longer side 3840. Video caps at 1080p: a 4K SeedVR2 pass over every
 * frame does not fit a 24 GB card in a sane time, so 4k on a clip → 1080p.
 * Video "2x" is clamped to the same short side in-graph by the builder
 * (clampMultiplierToShortSide), since the source size is only known there.
 */
export function seedvr2ResizeInputs(
  scale: Seedvr2Scale,
  isVideo: boolean,
): Record<string, string | number> {
  const s = isVideo && scale === "4k" ? "1080p" : scale;
  if (s === "1080p") {
    return {
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
    };
  }
  if (s === "4k") {
    return {
      resize_type: "scale longer dimension",
      "resize_type.longer_size": 3840,
    };
  }
  return { resize_type: "scale by multiplier", "resize_type.multiplier": 2 };
}

/** Short side a SeedVR2 clip's "2x" stops at (the same ceiling as 4k → 1080p). */
export const SEEDVR2_VIDEO_MAX_SHORT_SIDE = 1080;

/**
 * Turn a "scale by multiplier" resize into min(multiplier, maxShort / source
 * short side), computed in-graph from the resize's own input, so "2x" on a
 * clip that is already large stops at maxShort instead of running out of
 * memory. No-op for other resize types or an unlinked input.
 */
export function clampMultiplierToShortSide(
  workflow: Workflow,
  resizeId: string,
  maxShort: number,
): string[] {
  const inputs = workflow[resizeId]?.inputs;
  const factor = inputs?.["resize_type.multiplier"];
  if (
    !inputs ||
    inputs.resize_type !== "scale by multiplier" ||
    typeof factor !== "number" ||
    !Array.isArray(inputs.input)
  ) {
    return [];
  }
  const fresh = (hint: string) => {
    let id = hint;
    for (let i = 2; workflow[id]; i++) id = `${hint}_${i}`;
    return id;
  };
  const size = fresh(`${resizeId}_src_size`);
  workflow[size] = {
    class_type: "GetImageSize",
    inputs: { image: inputs.input },
    _meta: { title: "Source size" },
  };
  const mult = fresh(`${resizeId}_scale_clamp`);
  workflow[mult] = {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: `min(${factor}, ${maxShort} / min(a, b))`,
      "values.a": [size, 0],
      "values.b": [size, 1],
    },
    _meta: { title: `Scale clamp (${maxShort}p)` },
  };
  inputs["resize_type.multiplier"] = [mult, 0];
  return [size, mult];
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === classType && !isOptionalNode(workflow[id]),
  );
}

const VIDEO_ONLY = [
  "LoadVideo",
  "GetVideoComponents",
  "SeedVR2TemporalChunk",
  "SeedVR2TemporalMerge",
  "CreateVideo",
  "SaveVideo",
];
const IMAGE_ONLY = ["LoadImage", "SaveImage"];

export function buildSeedvr2UpscaleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  const isVideo = Boolean(videoRef) && params.media !== "image";
  const sourceRef = isVideo ? videoRef : imageRef;
  if (!sourceRef) {
    throw new Error(
      `${SEEDVR2_UPSCALE_ACTION}: source run has no image or video`,
    );
  }

  const ids: Record<string, string | undefined> = {};
  for (const cls of [
    "LoadImage",
    "LoadVideo",
    "GetVideoComponents",
    "ResizeImageMaskNode",
    "UNETLoader",
    "VAEEncodeTiled",
    "SeedVR2TemporalChunk",
    "SeedVR2Conditioning",
    "KSampler",
    "SeedVR2TemporalMerge",
    "VAEDecodeTiled",
    "SeedVR2PostProcessing",
  ]) {
    ids[cls] = nodeIdOf(workflow, cls);
  }
  const required = isVideo
    ? [
        "LoadVideo",
        "GetVideoComponents",
        "ResizeImageMaskNode",
        "UNETLoader",
        "VAEEncodeTiled",
        "SeedVR2TemporalChunk",
        "SeedVR2Conditioning",
        "KSampler",
        "SeedVR2TemporalMerge",
        "VAEDecodeTiled",
      ]
    : [
        "LoadImage",
        "ResizeImageMaskNode",
        "UNETLoader",
        "VAEEncodeTiled",
        "SeedVR2Conditioning",
        "KSampler",
        "VAEDecodeTiled",
      ];
  const missing = required.filter((cls) => !ids[cls]);
  if (missing.length) {
    throw new Error(
      `${SEEDVR2_UPSCALE_ACTION}: workflow is missing ${missing.join(", ")}`,
    );
  }
  const id = (cls: string) => ids[cls] as string;

  const resizeId = id("ResizeImageMaskNode");
  const resize = workflow[resizeId].inputs;
  for (const key of Object.keys(resize)) {
    if (key.startsWith("resize_type")) delete resize[key];
  }
  Object.assign(
    resize,
    seedvr2ResizeInputs(seedvr2Scale(params.scale), isVideo),
  );
  setNodeInput(
    workflow,
    id("UNETLoader"),
    "unet_name",
    seedvr2Model(params.model),
  );
  const postId = ids.SeedVR2PostProcessing;
  if (postId) {
    setNodeInput(
      workflow,
      postId,
      "color_correction_method",
      seedvr2ColorMethod(params.color),
    );
  }

  if (isVideo) {
    setNodeInput(workflow, id("LoadVideo"), "file", sourceRef);
    setNodeInput(workflow, resizeId, "input", [id("GetVideoComponents"), 0]);
    clampMultiplierToShortSide(workflow, resizeId, SEEDVR2_VIDEO_MAX_SHORT_SIDE);
    // encode → chunk → (conditioning + sampler) → merge → decode
    const chunk: [string, number] = [id("SeedVR2TemporalChunk"), 0];
    setNodeInput(workflow, id("SeedVR2TemporalChunk"), "latent", [
      id("VAEEncodeTiled"),
      0,
    ]);
    setNodeInput(
      workflow,
      id("SeedVR2Conditioning"),
      "vae_conditioning",
      chunk,
    );
    setNodeInput(workflow, id("KSampler"), "latent_image", chunk);
    setNodeInput(workflow, id("SeedVR2TemporalMerge"), "latents", [
      id("KSampler"),
      0,
    ]);
    setNodeInput(workflow, id("VAEDecodeTiled"), "samples", [
      id("SeedVR2TemporalMerge"),
      0,
    ]);
  } else {
    setNodeInput(workflow, id("LoadImage"), "image", sourceRef);
    setNodeInput(workflow, resizeId, "input", [id("LoadImage"), 0]);
    setNodeInput(workflow, id("SeedVR2Conditioning"), "vae_conditioning", [
      id("VAEEncodeTiled"),
      0,
    ]);
    setNodeInput(workflow, id("KSampler"), "latent_image", [
      id("VAEEncodeTiled"),
      0,
    ]);
    setNodeInput(workflow, id("VAEDecodeTiled"), "samples", [
      id("KSampler"),
      0,
    ]);
  }
  const drop = isVideo ? IMAGE_ONLY : VIDEO_ONLY;
  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId];
    // Optional nodes here are the alternate-model loaders (setup/docs only).
    if (isOptionalNode(node) || drop.includes(node?.class_type))
      delete workflow[nodeId];
  }

  const seed = typeof job?.seed === "number" ? job.seed : 0;
  setNodeInput(workflow, id("KSampler"), "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: id("KSampler"),
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: isVideo ? id("LoadVideo") : id("LoadImage"),
    },
    seed,
  };
}
