/**
 * Model inventory extraction from a ComfyUI object_info payload.
 *
 * Shared by GET /api/comfy/models (web model store) and GET /api/oj/packs
 * (native pack browser) so both resolve the same option lists.
 */

import {
  extractEnumOptionsInventory,
  extractFileInventory,
  extractInputList,
  type ObjectInfoResponse,
} from "@/lib/oj/localInventory";

// Legacy `[[...]]` and ComfyUI 0.4x `["COMBO", {options}]` specs both parse.
const extractList = extractInputList;

function extractFirstAvailable(
  data: ObjectInfoResponse,
  candidates: Array<[nodeType: string, inputName: string]>,
): string[] {
  for (const [nodeType, inputName] of candidates) {
    const values = extractList(data, nodeType, inputName);
    if (values.length > 0) return values;
  }
  return [];
}

export function buildModelInventory(data: ObjectInfoResponse) {
  const fileInventory = extractFileInventory(data);
  return {
    checkpoints: extractList(data, "CheckpointLoaderSimple", "ckpt_name"),
    // LoRAs from loaders used by SDXL and Krea/Flux-style workflows.
    loras: Array.from(
      new Set([
        ...extractList(data, "LoraLoader", "lora_name"),
        ...extractList(data, "LoraLoaderModelOnly", "lora_name"),
        ...extractList(data, "Power Lora Loader (rgthree)", "lora_name"),
      ]),
    ),
    vaes: extractList(data, "VAELoader", "vae_name"),
    controlnet: extractFirstAvailable(data, [
      ["ControlNetLoader", "control_net_name"],
      ["ControlNetLoadFromDiffusers", "control_net_name"],
    ]),
    upscale_models: extractFirstAvailable(data, [
      ["UpscaleModelLoader", "model_name"],
      ["LoadUpscaleModel", "model_name"],
    ]),
    clip: extractFirstAvailable(data, [
      ["CLIPLoader", "clip_name"],
      ["DualCLIPLoader", "clip_name1"],
    ]),
    unet: extractFirstAvailable(data, [
      ["UNETLoader", "unet_name"],
      ["UNETLoaderFlux", "unet_name"],
      ["UNETLoaderSDXL", "unet_name"],
    ]),
    ipadapter: extractFirstAvailable(data, [
      ["IPAdapterModelLoader", "ipadapter_file"],
      ["IPAdapterLoad", "ipadapter_file"],
      ["IPAdapterUnifiedLoader", "preset"],
    ]),
    // Core ComfyUI has no embeddings loader node; the models route fills
    // this from GET /models/embeddings (see listComfyModelFolder).
    embeddings: extractFirstAvailable(data, [
      ["CLIPTextEncodeWithWeight", "embed_name"],
    ]),
    latent_upscale_models: extractFirstAvailable(data, [
      ["LatentUpscaleModelLoader", "model_name"],
    ]),
    text_encoders: extractFirstAvailable(data, [
      ["CLIPLoader", "clip_name"],
      ["TripleCLIPLoader", "clip_name1"],
      ["DualCLIPLoader", "clip_name1"],
    ]),
    clip_vision: extractFirstAvailable(data, [
      ["CLIPVisionLoader", "clip_name"],
    ]),
    gligen: extractFirstAvailable(data, [["GLIGENLoader", "gligen_name"]]),
    hypernetworks: extractFirstAvailable(data, [
      ["HypernetworkLoader", "hypernetwork_name"],
    ]),
    animatediff_models: extractFirstAvailable(data, [
      ["AnimateDiffLoaderWithContext", "model_path"],
      ["AnimateDiffModelLoader", "model_path"],
      ["AnimateDiffUnifiedLoader", "model_path"],
    ]),
    diffusers: extractFirstAvailable(data, [
      ["CheckpointLoaderDiffusers", "diffusers_model"],
      ["DiffusersLoader", "diffusers_model"],
    ]),
    style_models: extractFirstAvailable(data, [
      ["StyleModelLoader", "style_model_name"],
    ]),
    video_models: extractFirstAvailable(data, [
      ["VHS_LoadVideo", "video_path"],
    ]),
    samplers: extractList(data, "KSampler", "sampler_name"),
    schedulers: extractList(data, "KSampler", "scheduler"),
    enumOptions: extractEnumOptionsInventory(data),
    input_images: fileInventory.input_images ?? [],
    input_videos: fileInventory.input_videos ?? [],
    input_audios: fileInventory.input_audios ?? [],
  };
}

export type ModelInventoryPayload = ReturnType<typeof buildModelInventory>;
