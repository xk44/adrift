/**
 * Workflow Packs & Model-Family Resolution
 *
 * A "pack" is a collection of workflow templates and adapter config tailored
 * to a specific model family (SDXL, Flux, etc.). Packs allow the engine to:
 *
 *   1. Pick model-appropriate workflow files for each action/template
 *   2. Use model-aware injector logic (e.g. LoraLoaderModelOnly for Flux)
 *   3. Apply model-specific default overrides (cfg, steps, sampler)
 *
 * Resolution chain (highest priority first):
 *   user override → model-specific pack workflow → registry default → generic fallback
 */

import type { WorkflowKind } from "@/types";
import registry from "./registry.json";
import { resolveDefaultPackId } from "./defaultPack";

// ---------------------------------------------------------------------------
// Pack types
// ---------------------------------------------------------------------------

export interface AdapterConfig {
  /** ComfyUI class_type used to load LoRA weights in this model family */
  loraLoaderClass: string;
  /** ComfyUI class_type used to load IP-Adapter weights */
  ipAdapterLoaderClass: string;
  /** ComfyUI class_type for the main sampler node */
  samplerClass: string;
  /** ComfyUI class_type for the empty-latent node */
  latentClass: string;
  /** ComfyUI class_type for the main text-encoder node */
  textEncoderClass: string;
  /** Whether this family uses a separate negative-prompt branch */
  supportsNegativePrompt: boolean;
  /** Whether this family supports cfg guidance scale */
  supportsCfgScale: boolean;
  /** Defaults for this family */
  defaultSampler: string;
  defaultScheduler: string;
}

export interface PackDefaultOverrides {
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  negative?: string;
}

export interface WorkflowPack {
  /** Unique pack identifier (e.g. "sdxl", "flux") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Schema version */
  version: string;
  /** Model family this pack targets — matches registry.models key */
  modelFamily: string;
  /** Whether this pack is shipped as the app default */
  isDefault: boolean;
  /** Regex patterns matched against checkpoint names to auto-detect this family */
  modelPatterns: string[];
  /** Base pixel resolution (square root of megapixel target) */
  baseResolution: number;
  /** Adapter/injector config for this model family */
  adapterConfig: AdapterConfig;
  /** Mapping from template kind/action to workflow filename
   *  Relative to public/workflows/ unless prefixed with packs/<id>/ */
  workflows: Partial<Record<WorkflowKind | string, string>>;
  /** Model-family-level default overrides applied on top of registry defaults */
  defaultOverrides: PackDefaultOverrides;
}

// ---------------------------------------------------------------------------
// Built-in packs (synced from public/workflows/packs/*/pack.json)
// ---------------------------------------------------------------------------

const SDXL_PACK: WorkflowPack = {
  id: "sdxl",
  name: "Stable Diffusion XL",
  description:
    "Default workflow pack for SDXL-based models. Covers the standard SDXL generation pipeline with checkpoint, VAE, and LoraLoader nodes.",
  version: "1.0.0",
  modelFamily: "sdxl",
  isDefault: false,
  modelPatterns: ["sdxl", "stable.*xl", "sd.*xl"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoader",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySDXLLatentImage",
    textEncoderClass: "CLIPTextEncodeSDXL",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "normal",
  },
  workflows: {
    t2i: "t2i.json",
    i2i: "i2i.json",
    vary_subtle: "vary_subtle.json",
    vary_strong: "vary_strong.json",
    upscale_subtle: "upscale_subtle.json",
    upscale_creative: "upscale_creative.json",
    inpaint: "inpaint.json",
    outpaint: "outpaint.json",
    remix_subtle: "remix_subtle.json",
    remix_strong: "remix_strong.json",
    // No t2v/i2v: video resolves to the LTX-2.5 pack (defaultEngines.ts);
    // the root LTX-Video 0.9.5 graphs need a checkpoint few installs have.
    t23d: "t23d.json",
    i23d: "i23d.json",
    t2a: "t2a.json",
    controlnet: "controlnet.json",
  },
  defaultOverrides: {
    steps: 25,
    cfg: 7.0,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0,
  },
};

const FLUX_PACK: WorkflowPack = {
  id: "flux",
  name: "Flux",
  description:
    "Workflow pack for Flux-family models (Flux.1 Dev, Flux.1 Schnell). Uses UNETLoader, LoraLoaderModelOnly, and FluxSampler instead of CheckpointLoaderSimple and KSampler.",
  version: "1.0.0",
  modelFamily: "flux",
  isDefault: false,
  // Negative lookahead: FLUX.3 checkpoints belong to the flux3 pack.
  modelPatterns: ["flux(?![._-]?3)", "flux1", "flux\\.1"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterFlux",
    samplerClass: "FluxSampler",
    latentClass: "EmptyLatentImageFlux",
    textEncoderClass: "CLIPTextEncodeFlux",
    supportsNegativePrompt: false,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "normal",
  },
  workflows: {
    t2i: "t2i.json",
  },
  defaultOverrides: {
    steps: 20,
    cfg: 3.5,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0,
  },
};

const IDEOGRAM4_PACK: WorkflowPack = {
  id: "ideogram4",
  name: "Ideogram 4",
  description:
    "Workflow pack for Ideogram 4 (9.3B open-weights DiT, native in ComfyUI 0.24+). Uses dual UNETLoader (conditional + unconditional) with DualModelGuider, Ideogram4Scheduler sigmas, and SamplerCustomAdvanced over the Flux2 latent space.",
  version: "1.0.0",
  modelFamily: "ideogram4",
  isDefault: false,
  modelPatterns: ["ideogram.?4", "ideogram"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SamplerCustomAdvanced",
    latentClass: "EmptyFlux2LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: false,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "normal",
  },
  workflows: {
    t2i: "ideogram4_t2i.json",
  },
  defaultOverrides: {
    steps: 20,
    cfg: 7.0,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0,
  },
};

const KREA2_PACK: WorkflowPack = {
  id: "krea2",
  name: "Krea 2",
  description:
    "Workflow pack for the local open-weight Krea 2 Turbo graph in ComfyUI. Uses UNETLoader, Qwen3-VL CLIPLoader, Krea2T enhancer, ConditioningKrea2Rebalance, KSampler, and Qwen Image VAE.",
  version: "1.0.0",
  modelFamily: "krea2",
  isDefault: true,
  modelPatterns: ["krea.?2", "krea"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "normal",
  },
  workflows: {
    t2i: "packs/krea2/t2i.json",
    i2i: "packs/krea2/i2i.json",
    vary_subtle: "packs/krea2/i2i.json",
    vary_strong: "packs/krea2/i2i.json",
    remix_subtle: "packs/krea2/i2i.json",
    remix_strong: "packs/krea2/i2i.json",
    outpaint: "packs/krea2/outpaintv2.json",
    inpaint: "packs/krea2/outpaint.json",
    pan_up: "packs/krea2/outpaintv2.json",
    pan_down: "packs/krea2/outpaintv2.json",
    pan_left: "packs/krea2/outpaintv2.json",
    pan_right: "packs/krea2/outpaintv2.json",
    zoom_1_5x: "packs/krea2/outpaintv2.json",
    zoom_2x: "packs/krea2/outpaintv2.json",
    upscale_subtle: "upscale_subtle.json",
    upscale_creative: "packs/krea2/upscale_creative.json",
    controlnet: "packs/krea2/controlnet.json",
    control_depth: "packs/krea2/control_depth.json",
    control_regions: "packs/krea2/control_regions.json",
    outpaint_bbox: "packs/krea2/outpaintv2.json",
    anypaint: "packs/krea2/anypaint.json",
    detail: "packs/krea2/detail_edit.json",
    upscale_detail: "packs/krea2/upscale_detail.json",
    adetailer: "packs/krea2/adetailer.json",
    adetailer_auto: "packs/krea2/adetailer.json",
    realism_lite: "packs/krea2/realism_enhance.json",
    realism_pro: "packs/krea2/realism_enhance_pro.json",
  },
  defaultOverrides: {
    steps: 8,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const KREA2_RAW_PACK: WorkflowPack = {
  id: "krea2-raw",
  name: "Krea 2 Raw (turbo-distill)",
  description:
    "Krea 2 Raw base run at Turbo speed via the turbo-distill LoRA (TheDivergentAI/krea2-turbo-distill-lora, r128). Raw's fidelity in 8 steps at CFG 0 — UNETLoader(krea2_raw_bf16) + LoraLoaderModelOnly(krea2_turbo_distill_r128) into the same Qwen3-VL CLIPLoader, Krea2T enhancer, ConditioningKrea2Rebalance, KSampler, and Qwen Image VAE as the Turbo pack.",
  version: "1.0.0",
  modelFamily: "krea2-raw",
  isDefault: false,
  modelPatterns: ["krea.?2.?raw"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2i: "packs/krea2-raw/t2i.json",
    i2i: "packs/krea2/i2i.json",
    vary_subtle: "packs/krea2/i2i.json",
    vary_strong: "packs/krea2/i2i.json",
    remix_subtle: "packs/krea2/i2i.json",
    remix_strong: "packs/krea2/i2i.json",
    upscale_subtle: "upscale_subtle.json",
    upscale_creative: "packs/krea2/upscale_creative.json",
    controlnet: "packs/krea2/controlnet.json",
  },
  defaultOverrides: {
    steps: 8,
    cfg: 0,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const KREA2_EDIT_PACK: WorkflowPack = {
  id: "krea2-edit",
  name: "Krea 2 Instruct-Edit",
  description:
    "Instruction-based, identity-preserving image editing for Krea 2. Krea-2-Raw + the krea2-identity-edit LoRA, with the comfyui-krea2edit nodes: Krea2EditModelPatch prepends the VAE-encoded source as clean in-context tokens (RoPE frame 1); dual Krea2EditGroundedEncode (positive instruction + grounded negative) fuse the Qwen3-VL grounding. Reference image + text instruction in, edited image out. Validated recipe: 40 steps, CFG 3. The `edit_structural` action additionally stacks the krea2 depth-control LoRA (comfyui-krea2-controlnet), locking every shape and subject position to the source while the style/scene changes. The `edit_pose` action (Pose character) renders the character photo in the pose of the second (pose) photo: core Depth Anything 3 extracts the pose photo's depth, which drives the depth-control LoRA while the identity edit keeps the character. REQUIRES: `custom_nodes/comfyui-krea2edit` (+ `comfyui-krea2-controlnet` for edit_structural and edit_pose) and `krea2_identity_edit_v1.safetensors` in models/loras.",
  version: "1.0.0",
  modelFamily: "krea2-edit",
  isDefault: false,
  modelPatterns: ["krea.?2.?edit"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "Krea2EditGroundedEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    edit: "packs/krea2-edit/edit_v2.json",
    edit_instruct: "packs/krea2-edit/edit_v2.json",
    // v1.2 dual-reference edit (insert / try-on / swap): scene = ref A, subject = ref B
    edit_instruct_dual: "packs/krea2-edit/edit_v2_dual.json",
    edit_structural: "packs/krea2-edit/edit_depth.json",
    // Pose character: character = ref A, pose photo = ref B (DA3 depth -> control LoRA)
    edit_pose: "packs/krea2-edit/pose_character.json",
    edit_ostris: "packs/krea2-edit/edit_ostris.json",
    swap_head: "packs/krea2-edit/swap_head.json",
    swap_body: "packs/krea2-edit/swap_body.json",
    edit_inpaint: "packs/krea2-edit/edit_inpaint.json",
  },
  defaultOverrides: {
    steps: 40,
    cfg: 3,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const QWEN_EDIT_PACK: WorkflowPack = {
  id: "qwen-image-edit",
  name: "Qwen-Image-Edit 2511",
  description:
    "Instruction-based image editing with Qwen-Image-Edit-2511, ComfyUI-native. UNETLoader (qwen_image_edit_2511_bf16) → edit LoRA (dropdown) → 4-step Lightning LoRA → --lora stack slot → ModelSamplingAuraFlow (shift 3) → CFGNorm; dual TextEncodeQwenImageEditPlus (positive instruction + reference image, empty negative) with the qwen2.5-vl 7B encoder + Qwen Image VAE. Fast recipe: 4 steps, CFG 2 (Lightning). The bundled Multi-Angle LoRA rotates the camera around the subject while preserving identity. Two-image edits (edit_instruct_dual: Picture 1 = target, Picture 2 = subject, e.g. replace person / try-on / insert) use edit_dual.json, which feeds both refs to the positive encoder and leaves the edit LoRA off unless the dropdown sets it. Verified end-to-end on Apple Silicon MPS (~55s/edit, bf16). REQUIRES (large): `qwen_image_edit_2511_bf16.safetensors` (Comfy-Org/Qwen-Image-Edit_ComfyUI) in models/diffusion_models, `qwen_2.5_vl_7b_fp8_scaled.safetensors` (Comfy-Org/Qwen-Image_ComfyUI) in models/text_encoders, plus `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` (lightx2v/Qwen-Image-Edit-2511-Lightning) and `qwen-image-edit-2511-multiple-angles-lora.safetensors` (fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA) in models/loras. VAE shared with Krea 2. NOTE: use the bf16 UNET on Apple Silicon — fp8 (Float8_e4m3fn / fp8mixed) is unsupported by the MPS backend and only loads on CUDA.",
  version: "1.0.0",
  modelFamily: "qwen-image-edit",
  isDefault: false,
  modelPatterns: ["qwen.?image.?edit"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "TextEncodeQwenImageEditPlus",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    edit: "packs/qwen-image-edit/edit.json",
    edit_qwen: "packs/qwen-image-edit/edit.json",
    // Two-image edit (swap / try-on / insert): native TextEncodeQwenImageEditPlus
    // image1 = target (source run), image2 = subject (params.secondRefImage).
    edit_instruct_dual: "packs/qwen-image-edit/edit_dual.json",
  },
  defaultOverrides: {
    steps: 4,
    cfg: 2,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const KREA2_DRAFT_PACK: WorkflowPack = {
  id: "krea2-draft",
  name: "Krea 2 — Draft (GGUF)",
  description:
    "Low-VRAM draft mode: the Krea 2 Turbo graph with a GGUF-quantized UNET (UnetLoaderGGUF, Krea-2-Turbo-Q4_K_M.gguf) for fast generation on modest GPUs. Same Qwen3-VL CLIPLoader, Krea2T enhancer, ConditioningKrea2Rebalance, and Qwen Image VAE as the full pack.",
  version: "1.0.0",
  modelFamily: "krea2",
  isDefault: false,
  modelPatterns: ["krea.?2.?draft", "krea.?2.?gguf"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2i: "krea2_draft.json",
  },
  defaultOverrides: {
    steps: 8,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

// LTX-2.5 22B distilled (open weights, LTX-2 Community License): official
// two-stage t2v/i2v (8-step half-res pass + x2 latent upscaler + 3-step
// refine) and single-stage first/last-frame, all with generated sound.
// Sampling is fixed by ManualSigmas + LTXVDualCFGGuider at cfg 1 (see
// src/lib/oj/ltx25.ts). Registered BEFORE LTXV: that pack's "ltx" pattern
// would otherwise claim ltx-2.5 file names.
const LTX25_PACK: WorkflowPack = {
  id: "ltx25",
  name: "LTX-2.5",
  description:
    "LTX-2.5 22B distilled video+audio (int8 DiT, Gemma 4 12B encoder). " +
    "t2v/i2v: 8-step pass at half size, x2 latent upscaler, 3-step refine; " +
    "flf2v: one 8-step pass guided by first and last frames. 24 fps, 8n+1 frames, cfg 1.",
  version: "1.0.0",
  modelFamily: "ltx25",
  isDefault: false,
  modelPatterns: ["ltx-?2[._]5"],
  baseResolution: 1280,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SamplerCustomAdvanced",
    latentClass: "EmptyLTXVLatentVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: false,
    defaultSampler: "euler_ancestral",
    defaultScheduler: "simple",
  },
  workflows: {
    t2v: "packs/ltx25/t2v.json",
    i2v: "packs/ltx25/i2v.json",
    transition: "packs/ltx25/flf2v.json",
    ltx25_animate: "packs/ltx25/i2v.json",
    ltx25_transition: "packs/ltx25/flf2v.json",
  },
  defaultOverrides: {
    steps: 8,
    cfg: 1.0,
    sampler: "euler_ancestral",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const LTXV_PACK: WorkflowPack = {
  id: "ltxv",
  name: "LTX-Video",
  description:
    "Core ComfyUI LTX-Video workflow pack using the native LTXV latent, conditioning, scheduler, CreateVideo, and SaveVideo nodes.",
  version: "1.0.0",
  modelFamily: "ltxv",
  isDefault: false,
  modelPatterns: ["ltx", "ltxv", "ltx.?video"],
  baseResolution: 768,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SamplerCustomAdvanced",
    latentClass: "EmptyLTXVLatentVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler_cfg_pp",
    defaultScheduler: "ltxv",
  },
  workflows: {
    t2v: "packs/ltxv/t2v.json",
    i2v: "packs/ltxv/i2v.json",
    t2v_fast: "packs/ltxv/t2v_fast.json",
    i2v_fast: "packs/ltxv/i2v_fast.json",
  },
  defaultOverrides: {
    steps: 25,
    cfg: 3,
    sampler: "euler_cfg_pp",
    scheduler: "ltxv",
    denoise: 1.0,
  },
};

const WAN_PACK: WorkflowPack = {
  id: "wan",
  name: "Wan Video",
  description:
    "Core ComfyUI Wan 2.1/2.2 workflow pack using native Wan/Hunyuan latent nodes, UNETLoader, CLIPLoader(type=wan), CreateVideo, and SaveVideo.",
  version: "1.0.0",
  modelFamily: "wan",
  isDefault: false,
  modelPatterns: ["wan[_-]?2", "wan2"],
  baseResolution: 768,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptyHunyuanLatentVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2v: "packs/wan/t2v.json",
    i2v: "packs/wan/i2v.json",
  },
  defaultOverrides: {
    steps: 25,
    cfg: 3,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

// ---------------------------------------------------------------------------
// Pack registry
// ---------------------------------------------------------------------------

const PACKS = new Map<string, WorkflowPack>();
// NEXT_PUBLIC_ mirror (next.config.ts env) reaches the browser bundle, where
// CJ_DEFAULT_PACK itself is undefined.
const DEFAULT_PACK_ID = resolveDefaultPackId();

function registerPack(pack: WorkflowPack): void {
  PACKS.set(pack.id, pack);
}

// Register built-in packs
registerPack(SDXL_PACK);
registerPack(FLUX_PACK);
registerPack(IDEOGRAM4_PACK);
registerPack(KREA2_RAW_PACK);
registerPack(KREA2_PACK);

const SEFI_PACK: WorkflowPack = {
  id: "sefi",
  name: "SeFi-Image",
  description:
    "Workflow pack for SeFi-Image (semantic-first dual-stream t2i, 1B/2B/5B). Wraps the sefi python pipeline via SeFiPipelineLoader/SeFiGenerate custom nodes; the generate node owns prompt/steps/guidance/size/seed (turbo: steps 4|8|10, guidance fixed 1.0, dims %16).",
  version: "1.0.0",
  modelFamily: "sefi",
  isDefault: false,
  modelPatterns: ["sefi"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SeFiGenerate",
    latentClass: "EmptyLatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: false,
    supportsCfgScale: false,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2i: "packs/sefi/t2i.json",
  },
  defaultOverrides: {
    steps: 4,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const MINIMAX_PACK: WorkflowPack = {
  id: "minimax",
  name: "MiniMax H3",
  description:
    "MiniMax H3 33B omni-modal video+audio DiT (native stereo audio, 24fps, 17k+5 frame grid). " +
    "Uses core MiniMaxH3ImageToVideo (t2v when no frames, fl2v with first/last frames), " +
    "BasicGuider (no negative/CFG), res_multistep/simple @ 20 steps. " +
    "Defaults to 73 frames (~3 s); the Draft tier renders a 22-frame preview, --bs sets any length. " +
    "NOTE (Apple Silicon): only the pruned_bf16 DiT + bf16 Qwen3-VL encoder run on MPS — " +
    "int8_convrot needs torch._int_mm (CUDA-only) and fp8/nvfp4 don't load at all.",
  version: "1.0.0",
  modelFamily: "minimax",
  isDefault: false,
  modelPatterns: ["minimax[_-]?h3", "minimax"],
  baseResolution: 768,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SamplerCustomAdvanced",
    latentClass: "MiniMaxH3ImageToVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: false,
    supportsCfgScale: false,
    defaultSampler: "res_multistep",
    defaultScheduler: "simple",
  },
  workflows: {
    t2v: "packs/minimax/t2v.json",
    i2v: "packs/minimax/i2v.json",
    r2v: "packs/minimax/r2v.json",
    // Single-frame t2i on the fl2va DiT + pinned Turbo 8-step LoRA (h3Image.ts);
    // the Create "MiniMax H3 Image" engine.
    t2i: "packs/minimax/t2i.json",
    // Native-node character swap: <Video 1> + <Picture 1> through Ref2VA with
    // the fl2v Turbo 8-step + akatz h3_character_swap_v1.5 LoRA (see
    // src/lib/oj/characterSwap.ts). Clients gate it on that LoRA existing.
    character_swap: "packs/minimax/character_swap.json",
    // Native-node face swap: <Video 1> + <Picture 1> face through Ref2VA with
    // the fl2v Turbo 8-step + UntMods FaceSwap_H3_REF2VA LoRA (faceSwap.ts).
    face_swap: "packs/minimax/face_swap.json",
    // H3 Relay Person Remover V1: SAM 3.1 track + green mask + Person
    // Remover LoRA, Qwen-Image-Edit clean frame 0 (personRemove.ts).
    person_remove: "packs/minimax/person_remove.json",
    // Masked H3 edits after openjutsu (MIT, D3voz; h3MaskedEdit.ts): SAM 3.1
    // track -> grey mannequin / grey backdrop / grey box in the conditioning
    // clip -> Ref2VA renders the reference into the mask -> paste-back.
    // character_swap_masked also carries the Motion guide pose subgraph
    // (RT-DETR + SDPose of the masked person -> H3 Fun ControlNet 2.0).
    // and the opt-in 2K finish (nodes 80-95, Open-H3-Regenerate node pack +
    // core MiniMaxH3LatentUpscaleWithModel; removed by the builder when Off).
    character_swap_masked: "packs/minimax/character_swap_masked.json",
    cast_swap: "packs/minimax/cast_swap.json",
    video_bg_swap: "packs/minimax/video_bg_swap.json",
    video_object_add: "packs/minimax/video_object_add.json",
    // Image-in FL2VA tools with a baked-in LoRA (h3Video.ts / h3ImageVideo.ts):
    // the same image as first+last frame with the 360-orbit LoRA, and the
    // Camera Motion LoRA with a "camera motion, <preset>" prompt.
    orbit_360: "packs/minimax/orbit_360.json",
    camera_move: "packs/minimax/camera_move.json",
    transition: "packs/minimax/transition.json",
    // Reference to Video (h3RefVideo.ts): 1-3 reference photos -> a new shot
    // with sound, structured Ref2VA prompt presets, Turbo 8-step default.
    ref_video: "packs/minimax/r2v.json",
    // Multiframe Reference (h3MultiframeRef.ts): the official H3 multiframe
    // template — keyframe 1 on Ref2VA, keyframes 2-4 as MiniMaxH3AddGuide
    // anchors at chosen frames; same weights as r2v.
    multiframe_ref: "packs/minimax/multiframe_ref.json",
    // H3 Character sheet (h3CharSheet.ts): r2v without audio, 5 frames,
    // frame 0 saved as the still turnaround sheet; same weights as r2v.
    h3_charsheet: "packs/minimax/charsheet.json",
    // Music video (musicVideo.ts): one Ref2VA + Turbo 4-step job per
    // beat-cut segment (song slice frozen as audio guide, previous last
    // frame anchored), then a model-free assemble with the song; optional
    // CJAudioStems (cj_stems) drum/vocal split.
    music_video: "packs/minimax/music_video.json",
    music_video_assemble: "packs/minimax/music_video_assemble.json",
    music_video_stems: "packs/minimax/music_video_stems.json",
  },
  defaultOverrides: {
    steps: 20,
    cfg: 1.0,
    sampler: "res_multistep",
    scheduler: "simple",
    denoise: 1.0,
  },
};

const WAN_ANIMATE_PACK: WorkflowPack = {
  id: "wan-animate",
  name: "Wan Animate + InfiniteTalk",
  description:
    "Open-weights character tools on core ComfyUI nodes. wan_animate: Wan Animate 2 motion transfer " +
    "(WanAnimate2ToVideo + WanAnimate2Cache, distilled int8 checkpoint, LCM 10 steps, CFG 1; the clip's " +
    "frames are the pose video, the character photo the reference; replace mode composites a BiRefNet " +
    "matte over the source clip). lipsync: InfiniteTalk single-speaker patch on Wan 2.1 I2V 480p + " +
    "lightx2v (euler/normal 6 steps, CFG 1, 25 fps), speech via wav2vec2, chained 81-frame passes, " +
    "speech muxed into the mp4. video_lipsync: the same InfiniteTalk passes over an existing clip, " +
    "each sampling from the source frames with a SAM 3.1 face noise mask (only the face is regenerated, " +
    "lips follow only the new speech), full-res paste-back, new speech replaces the source audio. talking_avatar: Wan2.2-S2V 14B fp8 + Lightning 4-step LoRA (uni_pc " +
    "4 steps, CFG 1, 16 fps), speech or music via wav2vec2 large, chained 5 s S2V chunks, audio muxed.",
  version: "1.0.0",
  modelFamily: "wan-animate",
  isDefault: false,
  modelPatterns: ["wan[_-]?animate", "infinitetalk"],
  baseResolution: 480,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "SamplerCustom",
    latentClass: "WanAnimate2ToVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: false,
    supportsCfgScale: false,
    defaultSampler: "lcm",
    defaultScheduler: "simple",
  },
  workflows: {
    // Builders: src/lib/oj/wanAnimate.ts, src/lib/oj/lipsync.ts,
    // src/lib/oj/videoLipsync.ts,
    // src/lib/oj/talkingAvatar.ts.
    wan_animate: "packs/wan-animate/wan_animate.json",
    lipsync: "packs/wan-animate/lipsync.json",
    video_lipsync: "packs/wan-animate/video_lipsync.json",
    talking_avatar: "packs/wan-animate/talking_avatar.json",
  },
  defaultOverrides: {
    steps: 10,
    cfg: 1.0,
    sampler: "lcm",
    scheduler: "simple",
    denoise: 1.0,
  },
};

/**
 * Wan image-to-video tools (pc / video backend): motion-preset LoRAs on
 * Wan2.1 I2V 480p or Wan2.2 I2V, and Wan2.2 Fun Camera poses. Both graphs
 * run the 4-step lightx2v distills by default (see src/lib/oj/wanMotion.ts).
 * Model names are the pc layout (split_files/... for the VAE and encoder).
 */
const WAN22_PACK: WorkflowPack = {
  id: "wan22",
  name: "Wan 2.1 / 2.2 Image to Video",
  description:
    "Image-to-video effects on Wan 14B: 35 motion-preset LoRAs (Remade-AI on Wan2.1 I2V 480p + " +
    "lightx2v distill, ostris orbit on Wan2.2 I2V + lightx2v 1022) and Wan2.2 Fun Camera " +
    "pan/zoom/roll poses. 16 fps, 5 s at ~480p in about 30-60 s on a 4090.",
  version: "1.0.0",
  modelFamily: "wan",
  isDefault: false,
  modelPatterns: ["wan2\\.2[_-]fun[_-]camera"],
  baseResolution: 624,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSamplerAdvanced",
    latentClass: "WanImageToVideo",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    wan_motion: "packs/wan22/wan_motion.json",
    wan_camera: "packs/wan22/wan_camera.json",
    wan_move: "packs/wan22/wan_move.json",
  },
  defaultOverrides: {
    steps: 4,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

registerPack(KREA2_EDIT_PACK);
registerPack(QWEN_EDIT_PACK);
registerPack(KREA2_DRAFT_PACK);
registerPack(SEFI_PACK);
registerPack(LTX25_PACK);
registerPack(LTXV_PACK);
registerPack(WAN_PACK);
registerPack(MINIMAX_PACK);
registerPack(WAN_ANIMATE_PACK);

// ---------------------------------------------------------------------------
// Tool-only packs (Tools page actions; no t2i/t2v). Empty modelPatterns: they
// never claim a checkpoint's model family.
// ---------------------------------------------------------------------------

const NO_ADAPTER: AdapterConfig = {
  loraLoaderClass: "LoraLoaderModelOnly",
  ipAdapterLoaderClass: "IPAdapterAdvanced",
  samplerClass: "KSampler",
  latentClass: "EmptyLatentImage",
  textEncoderClass: "CLIPTextEncode",
  supportsNegativePrompt: false,
  supportsCfgScale: true,
  defaultSampler: "euler",
  defaultScheduler: "simple",
};

const TRELLIS2_PACK: WorkflowPack = {
  id: "trellis2",
  name: "TRELLIS.2 3D",
  description:
    "Image → textured GLB with core TRELLIS.2 nodes (Comfy-Org template " +
    "3d_pixal3d_trellis2_image_to_model): BiRefNet cut-out, DINOv3 " +
    "conditioning (Pixal3D + MoGe-2 FOV, or plain TRELLIS.2), structure / " +
    "shape / upsample / texture stages, remesh + decimate + PBR bake, SaveGLB " +
    "and a RenderMesh preview PNG (src/lib/oj/trellis3d.ts).",
  version: "1.0.0",
  modelFamily: "trellis2",
  isDefault: false,
  modelPatterns: [],
  baseResolution: 1024,
  adapterConfig: { ...NO_ADAPTER, latentClass: "EmptyTrellis2LatentStructure" },
  workflows: {
    make_3d_trellis: "packs/trellis2/make_3d_trellis.json",
  },
  defaultOverrides: {},
};

const TRIPOSPLAT_PACK: WorkflowPack = {
  id: "triposplat",
  name: "TripoSplat 3D",
  description:
    "Image → Gaussian splat with core TripoSplat nodes (Comfy-Org template): " +
    "BiRefNet cut-out, DINOv3 ViT-H + FLUX.2 VAE conditioning, KSampler, " +
    "VAEDecodeTripoSplat, SaveGLB (.ply / .spz), a RenderSplat turntable mp4 " +
    "and optional SplatToMesh .glb (src/lib/oj/imageToSplat.ts).",
  version: "1.0.0",
  modelFamily: "triposplat",
  isDefault: false,
  modelPatterns: [],
  baseResolution: 1024,
  adapterConfig: { ...NO_ADAPTER, latentClass: "TripoSplatConditioning" },
  workflows: {
    image_to_splat: "packs/triposplat/image_to_splat.json",
  },
  defaultOverrides: {},
};

const SAM3D_BODY_PACK: WorkflowPack = {
  id: "sam3d-body",
  name: "SAM 3D Body",
  description:
    "Photo or clip → fitted 3D human body with core SAM 3D Body nodes " +
    "(Comfy-Org template): RT-DETR v4 person boxes, SAM3DBody_Predict + face " +
    "expression + smoothing, SAM3DBody_Render overlay (mp4 / png) and " +
    "BuildPoseFile → SaveGLB (.glb / .bvh) (src/lib/oj/body3d.ts).",
  version: "1.0.0",
  modelFamily: "sam3d-body",
  isDefault: false,
  modelPatterns: [],
  baseResolution: 1024,
  adapterConfig: { ...NO_ADAPTER },
  workflows: {
    body_3d: "packs/sam3d-body/body_3d.json",
  },
  defaultOverrides: {},
};

const AUDIO_PACK: WorkflowPack = {
  id: "audio",
  name: "Audio",
  description:
    "Text-only audio generators (src/lib/oj/audioGen.ts): music with " +
    "ACE-Step 1.5 turbo (tags, lyrics, duration, bpm, key) and sound effects " +
    "with Stable Audio 3 small SFX. Outputs MP3 via SaveAudioMP3. " +
    "Voiceover (src/lib/oj/voiceSound.ts): VibeVoice-Realtime-0.5B with 25 " +
    "stock voices (default) or VibeVoice-1.5B cloning an uploaded voice " +
    "sample. Add sound: MMAudio large 44k v2 video-to-audio " +
    "muxed over a clip (CC-BY-NC-4.0 weights). Dub video " +
    "(src/lib/oj/dubVideo.ts): Whisper ASR (comfy_nodes/cj_whisper_asr), " +
    "VibeVoice-1.5B or Chatterbox multilingual (MIT) clone of the clip's " +
    "speaker, and an audio-only mux. Voice changer " +
    "(src/lib/oj/voiceChange.ts): Chatterbox VC re-voices speech or a " +
    "clip's soundtrack as a target speaker.",
  version: "1.0.0",
  modelFamily: "audio",
  isDefault: false,
  modelPatterns: [],
  baseResolution: 1024,
  adapterConfig: { ...NO_ADAPTER, latentClass: "EmptyLatentAudio" },
  workflows: {
    music: "packs/audio/music.json",
    sfx: "packs/audio/sfx.json",
    sa3_t2a: "packs/audio/sa3_t2a.json",
    sa3_a2a: "packs/audio/sa3_a2a.json",
    sa3_inpaint: "packs/audio/sa3_inpaint.json",
    sa3_extend: "packs/audio/sa3_extend.json",
    voiceover: "packs/audio/voiceover.json",
    add_sound: "packs/audio/add_sound.json",
    dub_transcribe: "packs/audio/dub_transcribe.json",
    dub_transcribe_speakers: "packs/audio/dub_transcribe_speakers.json",
    dub_voice: "packs/audio/dub_voice.json",
    dub_mux: "packs/audio/dub_mux.json",
    dub_voice_chatterbox: "packs/audio/dub_voice_chatterbox.json",
    voice_change: "packs/audio/voice_change.json",
    voice_change_video: "packs/audio/voice_change_video.json",
  },
  defaultOverrides: {},
};

const FIBO2_PACK: WorkflowPack = {
  id: "fibo2",
  name: "FIBO 2.0 Edit",
  description:
    "Bria FIBO 2.0 instruction edit (src/lib/oj/fiboEdit.ts), tool-only: " +
    "Edit Turbo (4 steps, CFG 1) or Dev (30 steps, CFG 5) via TextEncodeFibo2 " +
    "(source-grounded, ~1 MP), then CJImagePasteBack (cj_h3_tools) pastes the " +
    "edit onto the original at full resolution using SAM3 region / face-protect / " +
    "pose masks. REQUIRES: fibo2_edit_turbo_bf16 / fibo2_dev_bf16 " +
    "(diffusion_models), qwen3vl_4b_bf16 (CLIP type fibo2), flux2-vae, " +
    "sam3.1_multiplex_fp16 (checkpoints). License: CC-BY-NC-4.0 (non-commercial).",
  version: "1.0.0",
  modelFamily: "fibo2",
  isDefault: false,
  modelPatterns: [],
  baseResolution: 1024,
  adapterConfig: { ...NO_ADAPTER, latentClass: "TextEncodeFibo2" },
  workflows: {
    edit_fibo: "packs/fibo2/edit.json",
    edit_fibo_dev: "packs/fibo2/edit_dev.json",
  },
  defaultOverrides: {},
};

registerPack(TRELLIS2_PACK);
registerPack(TRIPOSPLAT_PACK);
registerPack(SAM3D_BODY_PACK);
registerPack(AUDIO_PACK);
registerPack(FIBO2_PACK);
registerPack(WAN22_PACK);

// ---------------------------------------------------------------------------
// Qwen-Image-2.1 — gated behind CJ_QWEN_IMAGE_21 until weights approved
// ---------------------------------------------------------------------------

const QWEN_IMAGE_21_PACK: WorkflowPack = {
  id: "qwen-image-21",
  name: "Qwen-Image 2.1",
  description:
    "Qwen-Image-2.1 7B open-weight t2i/i2i: 2K output, native transparency. Qwen Research License: non-commercial use only. " +
    "Base recipe: CFG 3-4, 40-50 steps (or Viggle turbo LoRA for 4 steps, CFG 1). " +
    "Verified end-to-end on Apple Silicon MPS 2026-10-04 (turbo ~76s @ 1024, bf16; fp8 is CUDA-only). " +
    "REQUIRES: `qwen_image_2.1_bf16.safetensors` (diffusion_models) + `qwen3vl_8b_bf16.safetensors` " +
    "(text_encoders, CLIP type qwen_image) + `qwen_image_2.1_vae_bf16.safetensors` (vae), all from " +
    "Comfy-Org/Qwen-Image-2.1. Turbo: `Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors` (loras). " +
    "Optional controlnet: qwen_image_2.1_fun_controlnet_union_bf16 (model_patches, via ModelPatchLoader).",
  version: "1.0.0",
  modelFamily: "qwen-image-21",
  isDefault: false,
  modelPatterns: ["qwen.?image.?2\\.?1", "qwen.?image.?21"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptySD3LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2i: "packs/qwen-image-21/t2i.json",
    i2i: "packs/qwen-image-21/i2i.json",
    vary_subtle: "packs/qwen-image-21/i2i.json",
    vary_strong: "packs/qwen-image-21/i2i.json",
    remix_subtle: "packs/qwen-image-21/i2i.json",
    remix_strong: "packs/qwen-image-21/i2i.json",
    t2i_fast: "packs/qwen-image-21/t2i_turbo.json",
    // Native multi-reference instruction edit (TextEncodeQwenImage21).
    edit: "packs/qwen-image-21/edit.json",
    edit_qwen21: "packs/qwen-image-21/edit.json",
    edit_qwen21_fast: "packs/qwen-image-21/edit_turbo.json",
  },
  defaultOverrides: {
    steps: 40,
    cfg: 3.5,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

if (process.env.CJ_QWEN_IMAGE_21) {
  registerPack(QWEN_IMAGE_21_PACK);
}

// ---------------------------------------------------------------------------
// FLUX.3 Klein — on by default (weights are in the onboarding download list).
// Set CJ_FLUX3=0 to hide the engine.
// ---------------------------------------------------------------------------

const FLUX3_PACK: WorkflowPack = {
  id: "flux3",
  name: "FLUX.3 Klein",
  description:
    "FLUX.3 [klein] t2i + instruction edit, ComfyUI-native, official template settings. " +
    "Base: t2i 50 steps CFG 3.5, edit 50 steps CFG 1, euler/simple. Step-distilled: 16 steps, CFG 1. " +
    "Edit grounds the source image via ReferenceMultiLatent (VAE reference latents, latent sized to the source). " +
    "img2img (VAEEncode + denoise) is our own path, not an official template. " +
    "The official templates run the Qwen3.5 9B prompt upsampler first; these graphs skip it. " +
    "REQUIRES (gated — accept the BFL license on HF first): black-forest-labs/flux-3-image-klein-comfy → " +
    "`diffusion_models/flux3-image-klein-base-bf16.safetensors` (base, saved as `flux3_image_klein_bf16.safetensors`) " +
    "and/or `diffusion_models/flux3-image-klein-bf16.safetensors` (step-distilled, saved as `flux3_image_klein_sd_bf16.safetensors`), " +
    "`qwen3vl_4b_bf16.safetensors` (text_encoders, CLIP type flux3), `flux2-vae.safetensors` (vae). " +
    "Use bf16 on Apple Silicon; int8_convrot / nvfp4 are CUDA paths.",
  version: "1.0.0",
  modelFamily: "flux3",
  isDefault: false,
  modelPatterns: ["flux[._-]?3"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptyFlux2LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "simple",
  },
  workflows: {
    t2i: "packs/flux3/t2i.json",
    i2i: "packs/flux3/i2i.json",
    vary_subtle: "packs/flux3/i2i.json",
    vary_strong: "packs/flux3/i2i.json",
    remix_subtle: "packs/flux3/i2i.json",
    remix_strong: "packs/flux3/i2i.json",
    t2i_fast: "packs/flux3/t2i_fast.json",
    edit: "packs/flux3/edit.json",
    edit_flux3: "packs/flux3/edit.json",
    edit_flux3_fast: "packs/flux3/edit_fast.json",
  },
  defaultOverrides: {
    steps: 50,
    cfg: 3.5,
    sampler: "euler",
    scheduler: "simple",
    denoise: 1.0,
  },
};

if (!/^(0|false|off|no)$/i.test((process.env.CJ_FLUX3 ?? "").trim())) {
  registerPack(FLUX3_PACK);
}

// ---------------------------------------------------------------------------
// MOSS-Image (OpenMOSS) — gated behind CJ_MOSS_IMAGE until the Comfy-Org
// repack weights are on disk. Recipe is UNTESTED (no weights downloaded yet).
// ---------------------------------------------------------------------------

const MOSS_IMAGE_PACK: WorkflowPack = {
  id: "moss-image",
  name: "MOSS-Image",
  description:
    "MOSS-Image SFT t2i + i2i/vary/remix, ComfyUI-native (v0.42+). 50 steps, CFG 3, euler/sgm_uniform, ModelSamplingAuraFlow shift 5 (NOT SD3: multiplier 1000 = pure noise, ComfyUI #17119), " +
    "SkipLayerGuidanceDiTSimple on single layer 22 (negative branch). Flux2 VAE/latent. " +
    "REQUIRES (Comfy-Org repack): `moss_image_sft_bf16.safetensors` (diffusion_models), " +
    "`qwen3.5_9b_bf16.safetensors` (text_encoders, CLIP type moss_image), `flux2-vae.safetensors` (vae). " +
    "bf16 only on Apple Silicon. Options: `--speed balanced|fast|fast4` (SFT speed LoRAs + deband), " +
    "`--speed turbo` (`moss_image_base_bf16` + lodestones `moss_image_base_8step_dmd` LoRA, 8 steps CFG 1), " +
    "`--photoreal` (Civitai MOSS Photographic Realism LoRA `mossPhotographic_sftInt810_3331776`, SFT presets only), " +
    "`--krea2look` (WAS Krea 2 graft LoRA `moss_image_sft_krea2_graft_r64`, SFT presets only; Krea 2 Community License).",
  version: "1.0.0",
  modelFamily: "moss_image",
  isDefault: false,
  modelPatterns: ["moss[._-]?image"],
  baseResolution: 1024,
  adapterConfig: {
    loraLoaderClass: "LoraLoaderModelOnly",
    ipAdapterLoaderClass: "IPAdapterAdvanced",
    samplerClass: "KSampler",
    latentClass: "EmptyFlux2LatentImage",
    textEncoderClass: "CLIPTextEncode",
    supportsNegativePrompt: true,
    supportsCfgScale: true,
    defaultSampler: "euler",
    defaultScheduler: "sgm_uniform",
  },
  workflows: {
    t2i: "packs/moss-image/t2i.json",
    i2i: "packs/moss-image/i2i.json",
    vary_subtle: "packs/moss-image/i2i.json",
    vary_strong: "packs/moss-image/i2i.json",
    remix_subtle: "packs/moss-image/i2i.json",
    remix_strong: "packs/moss-image/i2i.json",
    // Edit tool "moss-restyle-depth" (src/lib/tools/editToolRegistry.json)
    restyle_depth: "packs/moss-image/restyle_depth.json",
    // Edit tools "moss-charref" (Ostris edit node) + "moss-colorize" (MOSS Toolkit i2i)
    moss_charref: "packs/moss-image/charref.json",
    moss_colorize: "packs/moss-image/colorize.json",
  },
  defaultOverrides: {
    steps: 50,
    cfg: 3.0,
    sampler: "euler",
    scheduler: "sgm_uniform",
    denoise: 1.0,
  },
};

if (process.env.CJ_MOSS_IMAGE) {
  registerPack(MOSS_IMAGE_PACK);
}

/**
 * Get a pack by id. Returns undefined if not found.
 */
export function getPack(packId: string): WorkflowPack | undefined {
  return PACKS.get(packId);
}

/**
 * Get the default (app-level) pack.
 */
export function getDefaultPack(): WorkflowPack {
  const pack = PACKS.get(DEFAULT_PACK_ID);
  if (!pack)
    throw new Error(`Default pack "${DEFAULT_PACK_ID}" not registered`);
  return pack;
}

/**
 * List all registered packs.
 */
export function getAllPacks(): WorkflowPack[] {
  return Array.from(PACKS.values());
}

/**
 * Packs that are only registered behind an env flag. Their modelPatterns are
 * still consulted for family detection so e.g. a FLUX.3 / Qwen-Image 2.1 /
 * MOSS-Image file is never misread as flux/sdxl when its pack is gated off.
 */
const GATED_PACKS: readonly WorkflowPack[] = [
  QWEN_IMAGE_21_PACK,
  FLUX3_PACK,
  MOSS_IMAGE_PACK,
];

function matchPackFamily(
  lower: string,
  packs: Iterable<WorkflowPack>,
): string | null {
  for (const pack of packs) {
    for (const pattern of pack.modelPatterns) {
      try {
        if (new RegExp(pattern, "i").test(lower)) return pack.modelFamily;
      } catch {
        // Invalid regex — skip
      }
    }
  }
  return null;
}

/**
 * Detect a model file's family without guessing: registered packs, then
 * gated (unregistered) packs, then registry.models; "unknown" when nothing
 * matches (including ""). Use this where a wrong guess is worse than none
 * (LoRA base-mismatch warnings, capability gating).
 */
export function detectModelFamilyStrict(checkpointName: string): string {
  if (!checkpointName) return "unknown";
  const lower = checkpointName.toLowerCase();
  const registered = matchPackFamily(lower, PACKS.values());
  if (registered) return registered;
  const gated = matchPackFamily(
    lower,
    GATED_PACKS.filter((p) => !PACKS.has(p.id)),
  );
  if (gated) return gated;
  // Fall back to registry.models entries
  for (const [key, model] of Object.entries(registry.models)) {
    if (lower.includes(key)) {
      return key;
    }
    const modelObj = model as { name: string; type: string };
    if (
      lower.includes(modelObj.type.toLowerCase()) ||
      lower.includes(modelObj.name.toLowerCase())
    ) {
      return key;
    }
  }
  return detectSdDerivedFamily(lower) ?? "unknown";
}

/**
 * Architectures whose files carry no pack pattern but are definitely NOT a
 * CLIP-L/G Stable Diffusion checkpoint. An unrecognised name with one of these
 * hints is never guessed as SD (it keeps the old default-pack routing).
 */
const NON_SD_ARCH_HINT =
  /qwen|hi[._-]?dream|(^|[^a-z])chroma(?!tic)|sd[._-]?3|stable[._-]?diffusion[._-]?3|lumina|hunyuan|aura[._-]?flow|pixart|stable[._-]?cascade|kolors|z[._-]?image|omnigen|cogview|cogvideo|mochi|(^|[^a-z])sana(?![a-z])/;

/**
 * Civitai SDXL derivatives that never say "sdxl" in the filename:
 * Illustrious / NoobAI (eps or v-pred — ComfyUI reads the v_pred key itself)
 * and "...XL" merges (juggernautXL_v9, realvisxlV40, animagineXL31).
 * "pony" / "illustrious" spelled out are already caught by registry.models.
 * Runs after every pack pattern, so flux/krea/ltx/qwen names never get here.
 */
function detectSdDerivedFamily(lower: string): string | null {
  if (NON_SD_ARCH_HINT.test(lower)) return null;
  if (/illustrious|(^|[^a-z])il[._-]?xl|noob/.test(lower)) return "illustrious";
  if (/xl(?=$|[^a-z]|v\d)/.test(lower)) return "sdxl";
  return null;
}

/**
 * Family for a named model file that matched nothing: an unrecognised name is
 * almost always a Civitai SD merge (an all-in-one checkpoint), so it is SDXL —
 * NOT the CJ_DEFAULT_PACK, which only says which model to use when none is
 * chosen. Names hinting at another architecture keep the default pack.
 */
const SD_CHECKPOINT_FAMILY = "sdxl";

export function isNonSdArchitectureName(checkpointName: string): boolean {
  return NON_SD_ARCH_HINT.test(checkpointName.toLowerCase());
}

/**
 * Detect which model family a checkpoint name belongs to (for pack routing).
 * Same as detectModelFamilyStrict, but an unmatched named file is an SD
 * checkpoint ("sdxl"; see SD_CHECKPOINT_FAMILY) unless its name hints at
 * another architecture. Only an empty name (no model chosen) or a non-SD hint
 * falls back to the default pack family ("krea2" unless CJ_DEFAULT_PACK).
 */
export function detectModelFamily(checkpointName: string): string {
  const family = detectModelFamilyStrict(checkpointName);
  if (family !== "unknown") return family;
  if (!checkpointName.trim() || isNonSdArchitectureName(checkpointName))
    return DEFAULT_PACK_ID;
  return SD_CHECKPOINT_FAMILY;
}

/**
 * SD-architecture families without a pack of their own: they load through
 * CheckpointLoaderSimple + CLIP-L/G like SDXL, so they use the sdxl pack's
 * graphs, LoRA loader and defaults.
 */
const FAMILY_PACK_ALIASES: Readonly<Record<string, string>> = {
  illustrious: "sdxl",
  pony: "sdxl",
  sd15: "sdxl",
};

/**
 * Get the pack for a model family. Falls back to default pack.
 */
export function getPackForModelFamily(modelFamily: string): WorkflowPack {
  for (const pack of PACKS.values()) {
    if (pack.modelFamily === modelFamily) return pack;
  }
  const alias = FAMILY_PACK_ALIASES[modelFamily];
  const aliased = alias ? PACKS.get(alias) : undefined;
  if (aliased) return aliased;
  return getDefaultPack();
}

/**
 * Detect pack from checkpoint name.
 */
export function getPackForCheckpoint(checkpointName: string): WorkflowPack {
  const family = detectModelFamily(checkpointName);
  return getPackForModelFamily(family);
}

// ---------------------------------------------------------------------------
// Model-aware workflow resolution
// ---------------------------------------------------------------------------

export interface ResolveWorkflowOptions {
  /** Template kind or action id (e.g. "t2i", "vary_subtle") */
  templateOrAction: string;
  /** Checkpoint/model name to detect model family from */
  checkpointName?: string;
  /** Explicit model family override (skips detection) */
  modelFamily?: string;
  /** Explicit pack id override (skips detection and family) */
  packId?: string;
  /** User-specified workflow path (highest priority) */
  userWorkflowPath?: string;
  /** Selected/default workflow path from UI workflow picker */
  selectedWorkflowPath?: string;
  /** Prefer a pack's accelerator-specific graph when one is available. */
  turbo?: boolean;
}

export interface ResolvedWorkflow {
  /** Resolved file path (relative to public/workflows/ or absolute) */
  workflowPath: string;
  /** The pack that was used for resolution (or undefined if no pack matched) */
  pack: WorkflowPack | undefined;
  /** Where the resolution came from */
  source:
    | "user_override"
    | "selected_workflow"
    | "pack_workflow"
    | "registry_default"
    | "generic_fallback";
}

/**
 * Resolve a workflow path through the model-aware resolution chain:
 *
 *   1. user override path (if provided)
 *   2. selected workflow path (from UI picker)
 *   3. model-specific pack workflow for the template/action
 *   4. registry default (template file from registry.json)
 *   5. generic fallback (t2i.json)
 */
export function resolveWorkflow(
  opts: ResolveWorkflowOptions,
): ResolvedWorkflow {
  // 1. User override — highest priority, pass through directly
  if (opts.userWorkflowPath) {
    return {
      workflowPath: opts.userWorkflowPath,
      pack: undefined,
      source: "user_override",
    };
  }

  // 2. Selected workflow from UI
  if (opts.selectedWorkflowPath) {
    return {
      workflowPath: opts.selectedWorkflowPath,
      pack: undefined,
      source: "selected_workflow",
    };
  }

  // Determine which pack to use. Bare requests (no pack/model/checkpoint
  // hints) resolve through the default pack so its workflows — with their
  // model loaders intact — win over generic templates whose empty ckpt_name
  // gets backfilled with whatever checkpoint ComfyUI lists first.
  const pack =
    (opts.packId
      ? PACKS.get(opts.packId)
      : opts.modelFamily
        ? getPackForModelFamily(opts.modelFamily)
        : opts.checkpointName
          ? getPackForCheckpoint(opts.checkpointName)
          : undefined) ?? getDefaultPack();

  // 3. Pack-specific workflow
  if (pack) {
    // A turbo graph is opt-in and only selected when the pack explicitly
    // provides one. This keeps --turbo from silently changing unsupported
    // model families (notably Wan 2.2 TI2V 5B on MPS).
    const fastTemplate = `${opts.templateOrAction}_fast`;
    const packWorkflow =
      (opts.turbo ? pack.workflows[fastTemplate] : undefined) ??
      pack.workflows[opts.templateOrAction];
    if (packWorkflow) {
      // Pack manifests store workflow paths relative to public/workflows.
      // Pack-specific files should be explicit, e.g. "packs/flux/t2i.json".
      return {
        workflowPath: packWorkflow,
        pack,
        source: "pack_workflow",
      };
    }
  }

  // 4. Registry default — template file from registry.json
  const templateEntry = (
    registry.templates as Record<string, { file: string }>
  )[opts.templateOrAction];
  if (templateEntry?.file) {
    return {
      workflowPath: templateEntry.file,
      pack: pack ?? getDefaultPack(),
      source: "registry_default",
    };
  }

  // 5. Generic fallback — always t2i.json
  return {
    workflowPath: "t2i.json",
    pack: pack ?? getDefaultPack(),
    source: "generic_fallback",
  };
}

/**
 * Action-id resolution with a template fallback. Packs key some graphs by
 * action id (vary_subtle, pan_up ...) and others only by template (i2v,
 * inpaint); an action whose id no pack maps used to land on the generic
 * t2i.json (Animate on a krea2 default pack -> an image graph -> "Video slot
 * discovery failed"). When the action id only reaches the generic fallback,
 * resolve its registry template instead; when the hinted (or default) pack
 * lacks that template, the first of `fallbackPackIds` that provides it wins
 * (video packs for i2v/t2v).
 */
export function resolveActionWorkflow(
  opts: ResolveWorkflowOptions & { template?: string },
  fallbackPackIds: ReadonlyArray<string | undefined> = [],
): ResolvedWorkflow {
  const { template, ...base } = opts;
  const byAction = resolveWorkflow(base);
  if (
    byAction.source !== "generic_fallback" ||
    !template ||
    template === base.templateOrAction
  ) {
    return byAction;
  }
  const byTemplate = resolveWorkflow({ ...base, templateOrAction: template });
  // A checkpoint/family hint whose pack lacks the template (an SDXL image
  // checkpoint animating) still takes the fallback packs, so the video model
  // the user picked wins over the bare registry file.
  if (byTemplate.source === "pack_workflow") return byTemplate;
  for (const id of fallbackPackIds) {
    if (id && getPack(id)?.workflows[template]) {
      return resolveWorkflow({ ...base, templateOrAction: template, packId: id });
    }
  }
  return byTemplate;
}

/**
 * Get the effective default overrides for a model family.
 * Merges registry defaults → pack defaults → explicit overrides.
 */
export function getEffectiveDefaults(
  modelFamily?: string,
  explicitOverrides?: PackDefaultOverrides,
): PackDefaultOverrides & {
  width: number;
  height: number;
  batch: number;
  negative: string;
} {
  const pack = modelFamily
    ? getPackForModelFamily(modelFamily)
    : getDefaultPack();

  const registryDefaults = {
    width: registry.defaults.width,
    height: registry.defaults.height,
    batch: registry.defaults.batch,
    steps: registry.defaults.steps,
    cfg: registry.defaults.cfg,
    sampler: registry.defaults.sampler,
    scheduler: registry.defaults.scheduler,
    denoise: registry.defaults.denoise,
    negative: registry.defaults.negative,
  };

  const merged = {
    ...registryDefaults,
    ...pack.defaultOverrides,
    ...explicitOverrides,
  };

  return merged;
}

/**
 * Get the adapter config for a model family.
 */
export function getAdapterConfig(modelFamily?: string): AdapterConfig {
  const pack = modelFamily
    ? getPackForModelFamily(modelFamily)
    : getDefaultPack();
  return pack.adapterConfig;
}

/**
 * Resolve which LoRA loader class to use for a model family.
 */
export function getLoraLoaderClass(modelFamily?: string): string {
  return getAdapterConfig(modelFamily).loraLoaderClass;
}
