/**
 * Model-presence check for pack workflows (server side). Reads the loader
 * nodes of a graph and reports which weight files are absent under
 * COMFY_ROOT/models, so a tool can show a clear "model not installed" state
 * instead of failing at queue time. Mirrors how the edit-tool catalog
 * decides `installed` / `packAvailable` (editTools.listModelFiles).
 */
import type { Workflow } from "@/types";
import { isOptionalNode } from "@/lib/comfy/optionalNodes";
import { listModelFiles } from "./editTools";

interface LoaderSpec {
  input: string;
  /** models/<dir> folders ComfyUI searches for this loader. */
  dirs: string[];
  /**
   * The input names a bundle folder, not a file: require this file inside
   * it (<value>/<bundleFile>), since folders are not listed on disk.
   */
  bundleFile?: string;
}

const LOADERS: Record<string, LoaderSpec[]> = {
  UNETLoader: [{ input: "unet_name", dirs: ["diffusion_models", "unet"] }],
  CLIPLoader: [{ input: "clip_name", dirs: ["text_encoders", "clip"] }],
  DualCLIPLoader: [
    { input: "clip_name1", dirs: ["text_encoders", "clip"] },
    { input: "clip_name2", dirs: ["text_encoders", "clip"] },
  ],
  VAELoader: [{ input: "vae_name", dirs: ["vae"] }],
  LatentUpscaleModelLoader: [
    { input: "model_name", dirs: ["latent_upscale_models"] },
  ],
  UpscaleModelLoader: [{ input: "model_name", dirs: ["upscale_models"] }],
  LoraLoaderModelOnly: [{ input: "lora_name", dirs: ["loras"] }],
  // ComfyUI-Anima-Ref-Adapter: the adapter LoRA (models/loras); v2 node and
  // the pilot loader. The node downloads a missing file on first use, so it
  // must count as a required weight here (no surprise downloads).
  AnimaRefAdapter: [{ input: "lora_name", dirs: ["loras"] }],
  AnimaRefAdapterLoader: [{ input: "lora_name", dirs: ["loras"] }],
  LoraLoader: [{ input: "lora_name", dirs: ["loras"] }],
  // Open-H3-Regenerate (2K finish); curve_table is the reference UNET itself.
  OpenH3RegenLora: [
    { input: "lora_name", dirs: ["loras"] },
    { input: "curve_name", dirs: ["loras"] },
  ],
  CheckpointLoaderSimple: [{ input: "ckpt_name", dirs: ["checkpoints"] }],
  // ComfyUI-WanVideoWrapper (FlashVSR upscale).
  WanVideoModelLoader: [{ input: "model", dirs: ["diffusion_models", "unet"] }],
  WanVideoExtraModelSelect: [
    { input: "extra_model", dirs: ["diffusion_models", "unet"] },
  ],
  LoadWanVideoT5TextEncoder: [
    { input: "model_name", dirs: ["text_encoders", "clip"] },
  ],
  WanVideoFlashVSRDecoderLoader: [{ input: "model_name", dirs: ["vae"] }],
  FrameInterpolationModelLoader: [
    { input: "model_name", dirs: ["frame_interpolation"] },
  ],
  LoadMoGeModel: [{ input: "model_name", dirs: ["geometry_estimation"] }],
  // Precomputed conditioning tensors (Marigold V2), models/embeddings.
  ConditioningLoader: [{ input: "conditioning_name", dirs: ["embeddings"] }],
  // ComfyUI-VOSR2: bundle folder models/vosr2/<model>/ (DiT + VAE + DINOv2).
  // The node downloads a missing bundle on first run, so its DiT gates here.
  VOSR2ModelLoader: [
    {
      input: "model",
      dirs: ["vosr2"],
      bundleFile: "checkpoints/ema_model.safetensors",
    },
  ],
};

export interface ModelRequirement {
  file: string;
  /** Primary models/<dir> (used in the user-facing hint). */
  dir: string;
  dirs: string[];
}

/**
 * Every weight file a graph's loader nodes reference (deduped, in order).
 * Optional nodes (`_meta.optional`, e.g. the opt-in 2K finish of character
 * swap) are skipped: their weights do not gate the tool, like their classes
 * do not in missingAgainstObjectInfo.
 */
export function workflowModelRequirements(
  workflow: Workflow,
): ModelRequirement[] {
  const seen = new Set<string>();
  const out: ModelRequirement[] = [];
  for (const node of Object.values(workflow)) {
    if (isOptionalNode(node)) continue;
    for (const spec of LOADERS[node.class_type] ?? []) {
      const value = node.inputs?.[spec.input];
      if (typeof value !== "string" || !value.trim()) continue;
      const name = value.replace(/\\/g, "/");
      const file = spec.bundleFile ? `${name}/${spec.bundleFile}` : name;
      const key = `${spec.dirs[0]}/${file.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, dir: spec.dirs[0], dirs: spec.dirs });
    }
  }
  return out;
}

/**
 * Requirements whose file is not in any of its model folders. Returns the
 * missing files as "<dir>/<file>" hints.
 */
export async function missingWorkflowModels(
  workflow: Workflow,
  comfyRoot: string,
): Promise<string[]> {
  const reqs = workflowModelRequirements(workflow);
  const dirs = new Set(reqs.flatMap((r) => r.dirs));
  const listings = new Map<string, Set<string>>();
  await Promise.all(
    [...dirs].map(async (d) => {
      listings.set(d, await listModelFiles(comfyRoot, d));
    }),
  );
  return reqs
    .filter(
      (r) =>
        !r.dirs.some((d) => listings.get(d)?.has(r.file.toLowerCase())),
    )
    .map((r) => `${r.dir}/${r.file}`);
}
