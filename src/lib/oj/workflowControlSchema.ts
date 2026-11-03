/**
 * Workflow Control Schema
 * Reusable dynamic workflow control schema/mapping foundation for arbitrary
 * node inputs. Turns discovered workflow node inputs into UI-ready control
 * schemas with safe labels, paths, default values, node IDs/class_types,
 * and optional persistence-ready keys.
 *
 * This module is the single source of truth for "what controls does this
 * workflow expose, and how should the UI render them?" It is consumed by
 * PackBrowser detail view, prompt-bar parameter injection, and any future
 * settings panels.
 *
 * Design goals:
 *   - Pure function, stateless — given a Workflow, produce ControlSchema[]
 *   - Deterministic ordering by node ID then input key
 *   - Every schema carries a persistence-ready key: `${nodeId}.${inputKey}`
 *   - Heuristic type detection from JS runtime types + ComfyUI naming conventions
 *   - Extensible: callers can filter/override/extend the generated schemas
 */

import type { Workflow, WorkflowNode } from "@/types";
import {
  DYNAMIC_COMBO_TYPE,
  dynamicComboChildren,
  resolveInputSpec,
  type InputSpecMeta,
  type ObjectInfoIndex,
} from "@/lib/oj/inputSpec";

// Core types

/**
 * The UI rendering hint for a control. Determines which component the UI
 * should use to present the control.
 */
export type ControlKind =
  | "number"    // numeric input — may include slider for bounded values
  | "string"    // free-form text input
  | "enum"      // fixed set of named options (sampler_name, scheduler, etc.)
  | "boolean"   // on/off toggle
  | "image"     // image input — shows file picker / drag-drop
  | "model"     // model file selector (checkpoints, loras, vaes, etc.)
  | "link"      // ComfyUI node-link input (references another node output)
  | "seed"      // special seed control (number with randomize button)
  | "file"      // generic file-like input (video, audio, animdiff, etc.)
  | "hidden";   // internal value, not shown in the UI

/**
 * Describes a single input on a single node that is surfaced as a UI control.
 */
export interface ControlSchema {
  /** Persistence-ready dot-path: `${nodeId}.${inputKey}` */
  key: string;
  /** Which node this control lives on */
  nodeId: string;
  /** The input field name on the node */
  inputKey: string;
  /** node's class_type */
  classType: string;
  /** UI rendering hint */
  kind: ControlKind;
  /** Safe human-readable label (derived from inputKey) */
  label: string;
  /** Optional group label (e.g. "Sampling", "Prompt", "Model Loading") */
  group: string;
  /** Current/default value from the workflow */
  defaultValue: unknown;
  /** For number/seed: minimum value if known */
  min?: number;
  /** For number/seed: maximum value if known */
  max?: number;
  /** For number: step size if known (integer = 1, float = 0.01, etc.) */
  step?: number;
  /** For enum: the list of allowed option values */
  options?: string[];
  /** For model: the model category hint */
  modelCategory?: ModelCategory;
  /** Whether the control should be shown to the user by default */
  visible: boolean;
  /** Numeric sort weight — lower values appear first in the UI */
  order: number;

  // Fields below are filled from ComfyUI /object_info by applyInputSpecs

  /** Raw object_info type (INT, FLOAT, COMBO, COMFY_DYNAMICCOMBO_V3, …) */
  specType?: string;
  /** Node-declared help text (`tooltip`) */
  tooltip?: string;
  /** `advanced` / `hidden` inputs collapse under an "Advanced" disclosure */
  advanced?: boolean;
  /** FLOAT precision unit (`round`); false disables rounding */
  round?: number | false;
  /** INT widget with `control_after_generate` (seed-like) */
  controlAfterGenerate?: boolean;
  /** Upload control to render (`image_upload` / `video_upload` / …) */
  upload?: "image" | "video" | "audio" | "file";
  /** Folder an upload combo lists (`image_folder`, default input) */
  uploadFolder?: string;
  /** STRING `multiline` */
  multiline?: boolean;
  /** STRING `dynamicPrompts` — `{a|b}` expanded per run */
  dynamicPrompts?: boolean;
  /** STRING `placeholder` */
  placeholder?: string;
  /** BOOLEAN on/off labels */
  labelOn?: string;
  labelOff?: string;
  /** Remote combo: options fetched from a ComfyUI route */
  remote?: {
    route: string;
    refreshButton: boolean;
    controlAfterRefresh?: "first" | "last";
  };
  /** COMFY_DYNAMICCOMBO_V3 parent: selecting an option swaps child inputs */
  dynamicCombo?: boolean;
  /** For a dynamic-combo child: the parent's inputKey and owning option */
  dynamicParent?: string;
  dynamicOption?: string;
  /** Child of an autogrow / dynamic group container */
  container?: { key: string; kind: "autogrow" | "dynamic_group"; slot: string };
  /** object_info type the panel doesn't understand — degraded editor */
  unknownType?: boolean;
  /** Control created from object_info (not present in the saved workflow) */
  synthesized?: boolean;
}

/**
 * Model categories that map to well-known ComfyUI loader node types.
 */
export type ModelCategory =
  | "checkpoint"
  | "lora"
  | "vae"
  | "controlnet"
  | "upscale"
  | "clip"
  | "unet"
  | "ipadapter"
  | "embedding"
  | "gligen"
  | "hypernetwork"
  | "diffusers"
  | "animatediff"
  | "video"
  | "style";

/**
 * Maps a ModelCategory to the key used in the ComfyUI model inventory.
 * The inventory comes from useModelStore().available via /api/comfy/models.
 */
export const MODEL_CATEGORY_TO_INVENTORY_KEY: Record<ModelCategory, string> = {
  checkpoint: "checkpoints",
  lora: "loras",
  vae: "vaes",
  controlnet: "controlnet",
  upscale: "upscale_models",
  clip: "clip",
  unet: "unet",
  ipadapter: "ipadapter",
  embedding: "embeddings",
  gligen: "gligen",
  hypernetwork: "hypernetworks",
  diffusers: "diffusers",
  animatediff: "animatediff_models",
  video: "video_models",
  style: "style_models",
};

/**
 * Model inventory type — matches the shape from useModelStore().available
 * augmented with per-category model lists for categories beyond checkpoints/loras/vaes.
 */
export type EnumOptionsInventory = Record<string, Record<string, string[]>>;

export interface ModelInventory {
  checkpoints?: string[];
  loras?: string[];
  vaes?: string[];
  controlnet?: string[];
  upscale_models?: string[];
  clip?: string[];
  unet?: string[];
  ipadapter?: string[];
  embeddings?: string[];
  gligen?: string[];
  hypernetworks?: string[];
  diffusers?: string[];
  animatediff_models?: string[];
  video_models?: string[];
  style_models?: string[];
  samplers?: string[];
  schedulers?: string[];
  /** Runtime enum options from ComfyUI object_info, keyed by class_type then input name. */
  enumOptions?: EnumOptionsInventory;
}

/**
 * Validation result for a model control against available inventory.
 */
export interface ModelValidationResult {
  /** Whether the current value is available in local inventory */
  isValid: boolean;
  /** Whether we have inventory data at all for this category */
  hasInventory: boolean;
  /** Available choices for this model category, if known */
  options: string[];
  /** The current/default value */
  currentValue: string;
}

/**
 * Full schema result: all controls for a workflow, plus summary metadata.
 */
export interface WorkflowControlSchemaResult {
  /** All discovered controls, sorted by order then key */
  controls: ControlSchema[];
  /** Summary of control counts by kind */
  countsByKind: Record<ControlKind, number>;
  /** The total number of nodes in the workflow */
  nodeCount: number;
  /** The total number of distinct node class_types */
  nodeTypeCount: number;
  /** Unique class_types discovered */
  classTypes: string[];
}

// Heuristic — known enum inputs

/**
 * Mapping from inputKey to the list of valid option values.
 * Populated from well-known ComfyUI node inputs. External callers can
 * extend this by mutating the map before calling buildControlSchema().
 */
export const KNOWN_ENUM_OPTIONS: Record<string, string[]> = {
  sampler_name: [
    "euler", "euler_ancestral", "heun", "heunpp2",
    "dpm_2", "dpm_2_ancestral", "lms", "dpmpp_2s_ancestral",
    "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_sde",
    "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu",
    "ddpm", "lcm", "ddim", "uni_pc", "uni_pc_bh2",
  ],
  scheduler: [
    "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta",
  ],
  // Flux / advanced samplers
  flux_sampler_name: ["euler", "euler_ancestral", "heun"],
  flux_scheduler: ["normal", "karras", "simple"],
  // Upscale methods (common in ImageUpscaleWithModel / ImageScale nodes)
  upscale_method: [
    "nearest", "bilinear", "bicubic", "area",
    "nearest-exact", "lanczos",
  ],
  // ControlNet / IP-Adapter apply methods
  control_net_apply: ["apply", "apply_advanced"],
  // AnimateDiff interpolation
  interpolate_mult: ["linear", "ease_in", "ease_out", "ease_in_out"],
  // Common video frame interpolation
  frame_interpolation: ["linear", "optical_flow"],
  weight_dtype: ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"],
  // LoadImage format hints
  format: ["png", "jpg", "webp", "bmp", "gif"],
  // Common boolean-ish enums
  crop: ["disabled", "center"],
  // CLIP type selectors
  type: ["sd1", "sd2", "sdxl", "flux", "krea2"],
  faceid_mode: ["orthogonal", "concat"],
  ipadapter_weight_type: ["standard", "prompt is more important", "prompt is less important"],
  // AnimateDiff beta schedule
  beta_schedule: ["autoselect", "sqrt_linear (AnimateDiff)", "sqrt (AnimateDiff)", "linear (AnimateDiff)"],
  keep_mask: ["keep", "replace"],
};

/**
 * Mapping from inputKey to the known ControlKind override.
 * These inputs have a known kind that supersedes the heuristic detection.
 */
export const KNOWN_KIND_OVERRIDES: Record<string, ControlKind> = {
  seed: "seed",
  noise_seed: "seed",
  steps: "number",
  cfg: "number",
  denoise: "number",
  width: "number",
  height: "number",
  sampler_name: "enum",
  scheduler: "enum",
  text: "string",
  prompt: "string",
  positive: "string",
  negative: "string",
  ckpt_name: "model",
  checkpoint_name: "model",
  model_name: "model",
  lora_name: "model",
  vae_name: "model",
  control_net_name: "model",
  unet_name: "model",
  clip_name: "model",
  ipadapter_file: "model",
  image: "image",
  mask: "image",
  filename_prefix: "string",
  add_noise: "boolean",
  start_with_step: "number",
  end_with_step: "number",
  return_with_leftover: "boolean",
  // Custom node / AnimateDiff
  model_path: "model",
  clip_name1: "model",
  clip_name2: "model",
  clip_name3: "model",
  // Upscale / Image processing
  upscale_model: "model",
  upscale_method: "enum",
  // ControlNet / IP-Adapter
  control_net: "link",
  // IPAdapter inputs
  image_emb: "image",
  start_at: "number",
  end_at: "number",
  // Embedding / Textual Inversion
  embed_name: "model",
  // AnimateDiff
  beta_schedule: "enum",
  // Video
  video_path: "file",
  audio_path: "file",
  // FaceID / IP-Adapter extended
  faceid_mode: "enum",
  ipadapter_weight_type: "enum",
  lora_stack: "link",
  gligen_name: "model",
  hypernetwork_name: "model",
  style_model_name: "model",
  diffusers_model: "model",
  weight_dtype: "enum",
  // Misc common file-like
  filename: "string",
  output_dir: "string",
  // Video/AnimateDiff model inputs
  motion_model: "model",
  animdiff_model: "model",
  keep_mask: "enum",
  frame_interpolation: "enum",
};

/**
 * Mapping from inputKey pattern to group name.
 */
const INPUT_GROUP_RULES: Array<{ pattern: RegExp | string; group: string }> = [
  { pattern: /^(seed|noise_seed|add_noise|start_with_step|end_with_step|return_with_leftover|steps|cfg|denoise|sampler_name|scheduler)$/i, group: "Sampling" },
  { pattern: /^(text|prompt|positive|negative)$/i, group: "Prompt" },
  { pattern: /^(width|height|batch_size)$/i, group: "Dimensions" },
  { pattern: /^(ckpt_name|checkpoint_name|model_name|unet_name|clip_name|lora_name|vae_name|control_net_name|ipadapter_file)$/i, group: "Model Loading" },
  { pattern: /^(image|mask|source_image)$/i, group: "Image Input" },
  { pattern: /^(strength_model|strength_clip|weight|start_percent|end_percent)$/i, group: "Strength / Blending" },
  { pattern: /^(upscale_method|factor|crop)$/i, group: "Upscaling" },
  // AnimateDiff
  { pattern: /^(model_path|motion_model|animdiff_model|beta_schedule)$/i, group: "AnimateDiff" },
  // Video
  { pattern: /^(video_path|audio_path|frame_rate|frame_interpolation)$/i, group: "Video" },
  // IP-Adapter extended
  { pattern: /^(faceid_mode|ipadapter_weight_type|start_at|end_at|embed_name)$/i, group: "IP-Adapter" },
  // Embedding
  { pattern: /^(embed_name|embed_weight)$/i, group: "Embeddings" },
  // Gligen / Hypernetwork / Style
  { pattern: /^(gligen_name|gligen_|hypernetwork_name|hypernetwork_|style_model_name)$/i, group: "Conditioning" },
  // Diffusers
  { pattern: /^(diffusers_model|diffusers_|weight_dtype)$/i, group: "Model Loading" },
  // Clip multi-loader
  { pattern: /^(clip_name1|clip_name2|clip_name3)$/i, group: "Model Loading" },
];

// Heuristic — model category mapping from class_type

/**
 * Mapping from class_type → model category for loader nodes.
 */
export const CLASS_TYPE_TO_MODEL_CATEGORY: Record<string, ModelCategory> = {
  CheckpointLoader: "checkpoint",
  CheckpointLoaderSimple: "checkpoint",
  unCLIPCheckpointLoader: "checkpoint",
  UNETLoader: "unet",
  UNETLoaderSDXL: "unet",
  UNETLoaderFlux: "unet",
  LoraLoader: "lora",
  LoraLoaderModelOnly: "lora",
  VAELoader: "vae",
  ControlNetLoader: "controlnet",
  ControlNetLoadFromDiffusers: "controlnet",
  UpscaleModelLoader: "upscale",
  LoadUpscaleModel: "upscale",
  CLIPLoader: "clip",
  CLIPLoaderSDXL: "clip",
  CLIPLoaderFlux: "clip",
  DualCLIPLoader: "clip",
  IPAdapterModelLoader: "ipadapter",
  IPAdapterLoad: "ipadapter",
  // AnimateDiff
  AnimateDiffLoaderWithContext: "animatediff",
  AnimateDiffModelLoader: "animatediff",
  AnimateDiffLoader_v3: "animatediff",
  AnimateDiffUnifiedLoader: "animatediff",
  AnimateDiffUnifiedLoader_v2: "animatediff",
  // Video
  VHS_VideoCombine: "video",
  VHS_LoadVideo: "video",
  VHS_LoadAudio: "video",
  SVD_img2vid_Conditioning: "video",
  FrameInterpolation: "video",
  // Embedding
  CLIPTextEncodeWithWeight: "embedding",
  // Gligen
  GLIGENLoader: "gligen",
  // Hypernetwork
  HypernetworkLoader: "hypernetwork",
  // Style model
  StyleModelLoader: "style",
  // Diffusers
  CheckpointLoaderDiffusers: "diffusers",
  DiffusersLoader: "diffusers",
};

// Heuristic — class_type to group

const CLASS_TYPE_GROUPS: Record<string, string> = {
  KSampler: "Sampling",
  KSamplerAdvanced: "Sampling",
  SamplerCustom: "Sampling",
  SamplerCustomAdvanced: "Sampling",
  KSamplerSelect: "Sampling",
  FluxSampler: "Sampling",
  CLIPTextEncode: "Prompt",
  CLIPTextEncodeSDXL: "Prompt",
  CLIPTextEncodeSDXLRefiner: "Prompt",
  CLIPTextEncodeFlux: "Prompt",
  BNK_CLIPTextEncodeAdvanced: "Prompt",
  CheckpointLoaderSimple: "Model Loading",
  CheckpointLoader: "Model Loading",
  unCLIPCheckpointLoader: "Model Loading",
  UNETLoader: "Model Loading",
  UNETLoaderSDXL: "Model Loading",
  UNETLoaderFlux: "Model Loading",
  LoraLoader: "LoRA",
  LoraLoaderModelOnly: "LoRA",
  VAELoader: "Model Loading",
  VAEDecode: "Decoding",
  VAEEncode: "Encoding",
  VAEEncodeForInpaint: "Encoding",
  EmptyLatentImage: "Dimensions",
  EmptySDXLLatentImage: "Dimensions",
  EmptyLatentImageFlux: "Dimensions",
  EmptySD3LatentImage: "Dimensions",
  SaveImage: "Output",
  PreviewImage: "Output",
  LoadImage: "Image Input",
  LoadImageMask: "Image Input",
  ControlNetLoader: "ControlNet",
  ControlNetApply: "ControlNet",
  ControlNetApplyAdvanced: "ControlNet",
  SetUnionControlNetType: "ControlNet",
  IPAdapterAdvanced: "IP-Adapter",
  IPAdapterModelLoader: "IP-Adapter",
  IPAdapterApply: "IP-Adapter",
  IPAdapterApplyFaceID: "IP-Adapter",
  IPAdapterApplyEncoded: "IP-Adapter",
  UpscaleModelLoader: "Upscaling",
  LoadUpscaleModel: "Upscaling",
  ImageUpscaleWithModel: "Upscaling",
  ImageScale: "Upscaling",
  ImageScaleBy: "Upscaling",
  PrimitiveNode: "Primitives",
  // AnimateDiff
  AnimateDiffLoaderWithContext: "AnimateDiff",
  AnimateDiffModelLoader: "AnimateDiff",
  AnimateDiffLoader_v3: "AnimateDiff",
  AnimateDiffUnifiedLoader: "AnimateDiff",
  AnimateDiffUnifiedLoader_v2: "AnimateDiff",
  AnimateDiffCombine: "AnimateDiff",
  AnimateDiffSampling: "AnimateDiff",
  // Video
  VHS_VideoCombine: "Video",
  VHS_LoadVideo: "Video",
  VHS_LoadAudio: "Video",
  VHS_Split: "Video",
  SVD_img2vid_Conditioning: "Video",
  FrameInterpolation: "Video",
  // Embedding
  CLIPTextEncodeWithWeight: "Prompt",
  // Gligen
  GLIGENLoader: "Gligen",
  GLIGENTextBoxApply: "Gligen",
  // Hypernetwork
  HypernetworkLoader: "Hypernetwork",
  // Style model
  StyleModelLoader: "Style Model",
  // Diffusers
  CheckpointLoaderDiffusers: "Model Loading",
  DiffusersLoader: "Model Loading",
  "ComfyUI-Krea2T-Enhancer": "Krea 2",
  ConditioningKrea2Rebalance: "Krea 2",
  ApplyKrea2NegPiP: "Krea 2",
};

// Heuristic — known bounds for numeric inputs

const KNOWN_NUMERIC_BOUNDS: Record<string, { min?: number; max?: number; step?: number }> = {
  steps: { min: 1, max: 150, step: 1 },
  cfg: { min: 0, max: 30, step: 0.5 },
  denoise: { min: 0, max: 1, step: 0.01 },
  width: { min: 64, max: 8192, step: 8 },
  height: { min: 64, max: 8192, step: 8 },
  seed: { min: 0, max: 0xffffffff, step: 1 },
  noise_seed: { min: 0, max: 0xffffffff, step: 1 },
  strength_model: { min: -2, max: 2, step: 0.01 },
  strength_clip: { min: -2, max: 2, step: 0.01 },
  strength: { min: 0, max: 1.5, step: 0.01 },
  multiplier: { min: 0, max: 12, step: 0.1 },
  value_strength: { min: 0, max: 2, step: 0.01 },
  weight: { min: 0, max: 2, step: 0.01 },
  start_percent: { min: 0, max: 1, step: 0.01 },
  end_percent: { min: 0, max: 1, step: 0.01 },
  scale: { min: 0, max: 10, step: 0.01 },
  factor: { min: 1, max: 8, step: 0.5 },
  batch_size: { min: 1, max: 64, step: 1 },
  start_with_step: { min: 0, max: 10000, step: 1 },
  end_with_step: { min: -1, max: 10000, step: 1 },
  // IP-Adapter / ControlNet
  start_at: { min: 0, max: 1, step: 0.01 },
  end_at: { min: 0, max: 1, step: 0.01 },
  // AnimateDiff
  frame_rate: { min: 1, max: 120, step: 1 },
  // Video length
  video_length: { min: 1, max: 300, step: 1 },
  // Upscale
  upscale_factor: { min: 1, max: 8, step: 0.5 },
};

// Input key → label

const KNOWN_LABELS: Record<string, string> = {
  seed: "Seed",
  noise_seed: "Noise Seed",
  steps: "Steps",
  cfg: "CFG Scale",
  sampler_name: "Sampler",
  scheduler: "Scheduler",
  denoise: "Denoise",
  width: "Width",
  height: "Height",
  text: "Prompt",
  prompt: "Prompt",
  positive: "Positive Prompt",
  negative: "Negative Prompt",
  ckpt_name: "Checkpoint",
  checkpoint_name: "Checkpoint",
  model_name: "Model",
  lora_name: "LoRA",
  vae_name: "VAE",
  control_net_name: "ControlNet Model",
  unet_name: "UNET Model",
  clip_name: "CLIP Model",
  ipadapter_file: "IP-Adapter Model",
  image: "Image",
  mask: "Mask",
  strength_model: "Model Strength",
  strength_clip: "CLIP Strength",
  strength: "Stylization",
  multiplier: "Rebalance Multiplier",
  per_layer_weights: "Minimalism / Maximalism Weights",
  value_strength: "NegPiP Strength",
  patch_txtfusion_refiners: "Patch TxtFusion Refiners",
  debug: "Debug",
  weight: "Weight",
  start_percent: "Start %",
  end_percent: "End %",
  filename_prefix: "Filename Prefix",
  add_noise: "Add Noise",
  start_with_step: "Start Step",
  end_with_step: "End Step",
  return_with_leftover: "Return with Leftover",
  scale: "Scale",
  factor: "Upscale Factor",
  batch_size: "Batch Size",
  upscale_method: "Upscale Method",
  crop: "Crop",
  // Multi-CLIP loaders
  clip_name1: "CLIP Model 1",
  clip_name2: "CLIP Model 2",
  clip_name3: "CLIP Model 3",
  // IP-Adapter
  start_at: "Start At",
  end_at: "End At",
  faceid_mode: "FaceID Mode",
  ipadapter_weight_type: "Weight Type",
  embed_name: "Embedding",
  // Upscale
  upscale_model: "Upscale Model",
  upscale_factor: "Upscale Factor",
  // AnimateDiff
  model_path: "Motion Model",
  motion_model: "Motion Model",
  animdiff_model: "AnimateDiff Model",
  beta_schedule: "Beta Schedule",
  // Video
  video_path: "Video File",
  audio_path: "Audio File",
  frame_rate: "Frame Rate",
  frame_interpolation: "Frame Interpolation",
  video_length: "Video Length",
  weight_dtype: "Weight Dtype",
  embed_weight: "Embedding Weight",
  gligen_name: "GLIGEN Model",
  hypernetwork_name: "Hypernetwork",
  style_model_name: "Style Model",
  diffusers_model: "Diffusers Model",
  // Misc
  filename: "Filename",
  output_dir: "Output Dir",
  keep_mask: "Keep Mask",
};

/**
 * Derive a safe human-readable label from an inputKey.
 * Uses the known label map first, then falls back to titleCase.
 */
export function deriveLabel(inputKey: string): string {
  if (KNOWN_LABELS[inputKey]) return KNOWN_LABELS[inputKey];
  // Fallback: convert snake_case / camelCase to Title Case
  let label = inputKey
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return label;
}

// Link detection

/**
 * Check if a value is a ComfyUI node-link reference [nodeId, outputIndex].
 */
export function isNodeLinkRef(value: unknown): value is [string | number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    typeof value[1] === "number"
  );
}

// Control kind detection

/**
 * Detect the ControlKind for a given input on a node.
 * Uses known overrides first, then model category detection,
 * then value-based heuristics, then falls back to "string".
 */
export function detectControlKind(
  inputKey: string,
  value: unknown,
  classType: string,
): ControlKind {
  // 1. Node-link → "link" (always wins over overrides for wiring inputs)
  if (isNodeLinkRef(value)) {
    return "link";
  }

  // 2. Known override (for non-link values)
  if (KNOWN_KIND_OVERRIDES[inputKey]) {
    return KNOWN_KIND_OVERRIDES[inputKey];
  }

  // 3. Model-category detection based on class_type + input_key
  if (CLASS_TYPE_TO_MODEL_CATEGORY[classType] && isModelSelectorInput(inputKey)) {
    return "model";
  }

  // 4. Boolean detection
  if (typeof value === "boolean") {
    return "boolean";
  }

  // 5. Numeric detection
  if (typeof value === "number") {
    // Special seed detection by key name
    if (inputKey === "seed" || inputKey === "noise_seed") {
      return "seed";
    }
    return "number";
  }

  // 6. String detection — check for known enum patterns
  if (typeof value === "string") {
    if (KNOWN_ENUM_OPTIONS[inputKey]) {
      return "enum";
    }
    // Image-like keys (broadened for custom nodes)
    if (isImageLikeInput(inputKey)) {
      return "image";
    }
    // Model-like keys by name pattern
    if (isModelSelectorInput(inputKey)) {
      return "model";
    }
    // File-like keys (video, audio, animation files)
    if (isFileLikeInput(inputKey, value)) {
      return "file";
    }
  }

  // 7. Null / undefined → hidden
  if (value === null || value === undefined) {
    return "hidden";
  }

  // Default: string
  return "string";
}

/**
 * Check if an input key looks like an image-like input.
 * Covers LoadImage, LoadImageMask, IPAdapter image inputs, etc.
 */
function isImageLikeInput(inputKey: string): boolean {
  const exact = new Set([
    "image", "mask", "source_image", "image_emb",
    "original_image", "target_image", "reference_image",
    "input_image", "input_mask",
  ]);
  if (exact.has(inputKey)) return true;
  // Pattern: keys ending in _image or _img or _mask
  if (/(?:_image|_img|_mask)$/.test(inputKey)) return true;
  // Pattern: starts with "image_" (e.g. image1, image2 for batch nodes)
  if (/^image_\w+$/.test(inputKey)) return true;
  return false;
}

/**
 * Check if an input key + value looks like a file-like (non-model, non-image) input.
 * Covers video_path, audio_path, and other file inputs from custom nodes.
 */
function isFileLikeInput(inputKey: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const fileKeyPatterns = [
    "_path$",      // video_path, audio_path, model_path (though model_path handled earlier)
    "^video",
    "^audio",
    "^clip_",
    "^file",
  ];
  for (const pat of fileKeyPatterns) {
    if (new RegExp(pat).test(inputKey)) return true;
  }
  // File extension heuristic: if the value looks like a file path with a media extension
  const mediaExtensions = /\.(mp4|avi|mov|mkv|webm|gif|mp3|wav|flac|ogg|json|csv|safetensors|ckpt|pt|pth|bin)$/i;
  if (mediaExtensions.test(String(value)) && !isModelSelectorInput(inputKey) && !isImageLikeInput(inputKey)) {
    return true;
  }
  return false;
}

/**
 * Check if an input key looks like a model/selector type input.
 * Covers built-in ComfyUI names plus common custom node patterns.
 */
function isModelSelectorInput(inputKey: string): boolean {
  const exact = [
    "ckpt_name", "checkpoint_name", "model_name", "lora_name",
    "vae_name", "control_net_name", "unet_name", "clip_name",
    "ipadapter_file", "upscale_model",
    // Multi-clip loaders
    "clip_name1", "clip_name2", "clip_name3",
    // AnimateDiff
    "model_path", "motion_model", "animdiff_model",
    // Embeddings / Textual Inversion
    "embed_name",
    // Gligen / Hypernetwork / Style
    "gligen_name", "hypernetwork_name", "style_model_name",
    // Diffusers
    "diffusers_model",
  ];
  if (exact.includes(inputKey)) return true;
  // Pattern: anything ending in _name that looks like a model selector
  if (/_name$/.test(inputKey) && !/^(text|prompt|filename|folder)$/.test(inputKey)) return true;
  // Pattern: anything ending in _model that is NOT a known strength/blend suffix
  // (exclude: strength_model, strength_clip, etc.)
  if (/_model$/.test(inputKey) && !/^(strength_model)$/.test(inputKey)) return true;
  // Pattern: anything ending in _path that's likely a model file
  if (/_path$/.test(inputKey)) return true;
  return false;
}

// Visibility heuristics

/**
 * Inputs that should be hidden from the user by default because they
 * are wiring/infrastructure, not user-facing parameters.
 */
const HIDDEN_INPUT_KEYS = new Set([
  "positive",   // wiring — points to conditioning output
  "negative",   // wiring
  "latent_image", // wiring
  "model",      // wiring — model output reference
  "clip",       // wiring
  "vae",        // wiring
  "cond",       // wiring
  "control_net", // wiring
  "image_output", // wiring
  "latent",     // wiring
  "samples",    // wiring
  // PrimitiveNode pass-through inputs
  "output",     // output type
  "linked_to",  // internal
  // Additional custom-node wiring
  "images",     // wiring — image batch output
  "batch",      // wiring — latent batch
  "latent_batch", // wiring
  "gligen_box", // wiring — GLIGEN box input
  "gligen_text",  // wiring — GLIGEN text conditioning
  "conditioning", // wiring — conditioning input
  "t5xxl",      // wiring — DualCLIPLoader output
  "clip_l",      // wiring
  "clip_g",      // wiring
  "noise",       // wiring — noise input
  "guiguidance",  // wiring
  "sigmas",      // wiring
  "latent_out",  // wiring
  "image_out",   // wiring
  "model_out",   // wiring
  "clip_out",    // wiring
  "vae_out",     // wiring
]);

/**
 * Determine whether a control should be visible in the UI by default.
 * Hidden by default: link-type inputs, internal wiring inputs, null values,
 * and inputs that are clearly not user-settable.
 */
export function determineVisibility(
  inputKey: string,
  kind: ControlKind,
  value: unknown,
  classType: string,
): boolean {
  // Link inputs are never shown directly
  if (kind === "link") return false;
  if (kind === "hidden") return false;
  // Well-known hidden inputs
  if (HIDDEN_INPUT_KEYS.has(inputKey)) return false;
  // PrimitiveNode value is shown, but "type" output is internal
  if (classType === "PrimitiveNode" && inputKey === "output") return false;
  // File-like inputs are visible so users can set media paths
  if (kind === "file") return true;
  return true;
}

// Group detection

/**
 * Determine the UI group label for a control.
 */
export function determineGroup(
  inputKey: string,
  classType: string,
): string {
  // 1. Check class_type → group mapping
  if (CLASS_TYPE_GROUPS[classType]) {
    const ctGroup = CLASS_TYPE_GROUPS[classType];
    // Only use class_type group if the input key matches its expected group
    // Otherwise fall through to input-key rules
    const inputGroup = findInputGroup(inputKey);
    if (inputGroup) return inputGroup;
    return ctGroup;
  }

  // 2. Input key → group rules
  const inputGroup = findInputGroup(inputKey);
  if (inputGroup) return inputGroup;

  // 3. Default: class_type as group
  return humanizeClassType(classType);
}

function findInputGroup(inputKey: string): string | null {
  for (const rule of INPUT_GROUP_RULES) {
    if (typeof rule.pattern === "string") {
      if (inputKey === rule.pattern) return rule.group;
    } else {
      if (rule.pattern.test(inputKey)) return rule.group;
    }
  }
  return null;
}

function humanizeClassType(ct: string): string {
  // Convert PascalCase / camelCase to spaced words
  return ct
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

// Sort ordering

/**
 * Base order for groups. Lower = shown first.
 */
const GROUP_ORDER: Record<string, number> = {
  "Sampling": 100,
  "Prompt": 200,
  "Dimensions": 300,
  "Model Loading": 400,
  "LoRA": 410,
  "ControlNet": 500,
  "IP-Adapter": 510,
  "AnimateDiff": 520,
  "Video": 530,
  "Embeddings": 540,
  "Conditioning": 545,
  "Gligen": 550,
  "Hypernetwork": 560,
  "Style Model": 570,
  "Image Input": 600,
  "Strength / Blending": 700,
  "Upscaling": 800,
  "Output": 900,
  "Decoding": 1000,
  "Encoding": 1100,
  "Primitives": 1200,
};

/**
 * Base order for specific input keys within a group.
 */
const INPUT_ORDER: Record<string, number> = {
  seed: 10,
  noise_seed: 11,
  steps: 20,
  cfg: 30,
  sampler_name: 40,
  scheduler: 50,
  denoise: 60,
  width: 10,
  height: 20,
  text: 10,
  prompt: 11,
  positive: 12,
  negative: 13,
};

/**
 * Compute the sort order for a control.
 */
export function computeOrder(group: string, inputKey: string): number {
  const groupBase = GROUP_ORDER[group] ?? 2000;
  const inputOffset = INPUT_ORDER[inputKey] ?? 100;
  // Stable per-key offset to maintain deterministic order even for unknown keys
  const keyHash = simpleHash(inputKey) % 100;
  return groupBase + inputOffset + keyHash;
}

/** Simple deterministic hash for consistent ordering */
function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// The main schema builder

/**
 * Options for building the control schema.
 */
export interface BuildControlSchemaOptions {
  /**
   * Whether to include hidden/link controls in the output.
   * Default: false (only visible controls).
   */
  includeHidden?: boolean;
  /**
   * Whether to include link-type controls.
   * Default: false.
   */
  includeLinks?: boolean;
  /**
   * Specific node IDs to restrict to. If empty/unset, all nodes are scanned.
   */
  filterNodeIds?: string[];
  /**
   * Specific class_types to restrict to. If empty/unset, all class_types are scanned.
   */
  filterClassTypes?: string[];
  /**
   * Whether to include PrimitiveNode nodes (often just wires).
   * Default: false.
   */
  includePrimitives?: boolean;
}

/**
 * Build a full control schema for every discoverable input in a workflow.
 *
 * This is the primary entry point. Given a ComfyUI workflow JSON, it walks
 * every node, inspects every input, and produces a `ControlSchema[]`
 * describing each user-facing control.
 *
 * @param workflow  The ComfyUI workflow object (Record<string, WorkflowNode>)
 * @param options   Optional filters and flags
 * @returns         A structured result with controls, summaries, and counts
 */
export function buildControlSchema(
  workflow: Workflow,
  options: BuildControlSchemaOptions = {},
): WorkflowControlSchemaResult {
  const {
    includeHidden = false,
    includeLinks = false,
    filterNodeIds,
    filterClassTypes,
    includePrimitives = false,
  } = options;

  const controls: ControlSchema[] = [];
  const classTypes = new Set<string>();

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node) continue;

    const ct = node.class_type;
    const inputs = node.inputs ?? {};

    classTypes.add(ct);

    // Apply filters
    if (filterNodeIds && filterNodeIds.length > 0 && !filterNodeIds.includes(nodeId)) {
      continue;
    }
    if (filterClassTypes && filterClassTypes.length > 0 && !filterClassTypes.includes(ct)) {
      continue;
    }
    if (!includePrimitives && ct === "PrimitiveNode") {
      continue;
    }

    for (const [inputKey, rawValue] of Object.entries(inputs)) {
      const value = isNodeLinkRef(rawValue) ? rawValue : rawValue;

      const kind = detectControlKind(inputKey, rawValue, ct);

      const visible = determineVisibility(inputKey, kind, rawValue, ct);

      // Apply filters
      if (!includeHidden && !visible && kind !== "link") continue;
      if (!includeLinks && kind === "link") continue;

      // Resolve display value (links → null for display; actual value otherwise)
      const defaultValue = kind === "link" ? null : value;

      const group = determineGroup(inputKey, ct);

      const label = deriveLabel(inputKey);

      const modelCategory = kind === "model"
        ? (CLASS_TYPE_TO_MODEL_CATEGORY[ct] ?? inferModelCategoryFromInputKey(inputKey))
        : undefined;

      // Bounds for number/seed
      const bounds = kind === "number" || kind === "seed"
        ? KNOWN_NUMERIC_BOUNDS[inputKey]
        : undefined;

      const enumOptions = kind === "enum"
        ? (KNOWN_ENUM_OPTIONS[inputKey] ?? (Array.isArray(value) ? undefined : undefined))
        : undefined;

      controls.push({
        key: `${nodeId}.${inputKey}`,
        nodeId,
        inputKey,
        classType: ct,
        kind,
        label,
        group,
        defaultValue,
        min: bounds?.min,
        max: bounds?.max,
        step: bounds?.step,
        options: enumOptions,
        modelCategory,
        visible,
        order: computeOrder(group, inputKey),
      });
    }
  }

  // Sort by order then key for deterministic output
  controls.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });

  const countsByKind = controls.reduce(
    (acc, c) => {
      acc[c.kind] = (acc[c.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<ControlKind, number>,
  );

  return {
    controls,
    countsByKind,
    nodeCount: Object.keys(workflow).length,
    nodeTypeCount: classTypes.size,
    classTypes: Array.from(classTypes).sort(),
  };
}

// Convenience — get visible controls only

/**
 * Get only the visible (user-facing) controls for a workflow.
 * Shorthand for `buildControlSchema(workflow).controls.filter(c => c.visible)`.
 */
export function getVisibleControls(
  workflow: Workflow,
  options?: Omit<BuildControlSchemaOptions, "includeHidden">,
): ControlSchema[] {
  return buildControlSchema(workflow, { ...options, includeHidden: false, includeLinks: false })
    .controls
    .filter((c) => c.visible);
}

// Convenience — group controls

/**
 * Group controls by their `group` field.
 * Returns an object mapping group names to their controls.
 */
export function groupControls(controls: ControlSchema[]): Record<string, ControlSchema[]> {
  const groups: Record<string, ControlSchema[]> = {};
  for (const c of controls) {
    if (!groups[c.group]) groups[c.group] = [];
    groups[c.group].push(c);
  }
  return groups;
}

// Convenience — persistence helpers

/**
 * Build a flat key-value map of all visible control default values,
 * suitable for persisting user overrides.
 * Key format: `${nodeId}.${inputKey}` → value
 */
export function buildDefaultsMap(
  workflow: Workflow,
  options?: BuildControlSchemaOptions,
): Record<string, unknown> {
  const result = buildControlSchema(workflow, options);
  const map: Record<string, unknown> = {};
  for (const c of result.controls) {
    if (c.visible && c.kind !== "link") {
      map[c.key] = c.defaultValue;
    }
  }
  return map;
}

/**
 * Apply user overrides to a workflow.
 * Takes a workflow and a map of `${nodeId}.${inputKey}` → value,
 * and returns a new workflow with the overrides applied.
 * This is the persistence round-trip: store overrides, then apply them
 * before submission.
 */
export function applyControlOverrides(
  workflow: Workflow,
  overrides: Record<string, unknown>,
): Workflow {
  const result: Workflow = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node) {
      result[nodeId] = node;
      continue;
    }
    const original = node.inputs ?? {};
    const newInputs = { ...original };
    const touched = new Set<string>();
    for (const [key, value] of Object.entries(overrides)) {
      if (key.startsWith(`${nodeId}.`)) {
        const inputKey = key.slice(nodeId.length + 1);
        if (inputKey in newInputs) {
          newInputs[inputKey] = value;
          touched.add(inputKey);
        } else if (
          inputKey.includes(".") &&
          inputKey.split(".")[0] in original
        ) {
          // V3 dynamic-combo / autogrow / dynamic-group child that the
          // selected option needs but the saved workflow didn't carry.
          newInputs[inputKey] = value;
          touched.add(inputKey);
        }
      }
    }
    // A dynamic-combo parent switched to another option: drop the old
    // option's children (`parent.*`) the caller didn't re-send, otherwise
    // ComfyUI receives inputs for an option that isn't selected.
    for (const inputKey of touched) {
      const before = original[inputKey];
      if (typeof before !== "string" || before === newInputs[inputKey]) continue;
      const prefix = `${inputKey}.`;
      for (const k of Object.keys(newInputs)) {
        if (k.startsWith(prefix) && !touched.has(k)) delete newInputs[k];
      }
    }
    result[nodeId] = { ...node, inputs: newInputs };
  }
  return result;
}

// Internal helpers

/**
 * Infer model category from input key when class_type is ambiguous.
 */
function inferModelCategoryFromInputKey(inputKey: string): ModelCategory | undefined {
  const mapping: Record<string, ModelCategory> = {
    ckpt_name: "checkpoint",
    checkpoint_name: "checkpoint",
    lora_name: "lora",
    vae_name: "vae",
    control_net_name: "controlnet",
    unet_name: "unet",
    clip_name: "checkpoint", // default assumption
    clip_name1: "clip",
    clip_name2: "clip",
    clip_name3: "clip",
    ipadapter_file: "ipadapter",
    upscale_model: "upscale",
    model_path: "animatediff",
    motion_model: "animatediff",
    animdiff_model: "animatediff",
    embed_name: "embedding",
    gligen_name: "gligen",
    hypernetwork_name: "hypernetwork",
    style_model_name: "style",
    diffusers_model: "diffusers",
    video_path: "video",
  };
  return mapping[inputKey];
}

// Model inventory validation

/**
 * Validate a model control's current/default value against the local ComfyUI
 * model inventory. Returns whether the value is valid, the available options,
 * and whether we have inventory data at all.
 *
 * This function is pure and stateless — it takes an explicit inventory rather
 * than reaching into a store, making it easy to test.
 */
export function validateModelChoice(
  control: ControlSchema,
  inventory: ModelInventory,
): ModelValidationResult {
  if (control.kind !== "model" || !control.modelCategory) {
    return {
      isValid: true, // not a model control, nothing to validate
      hasInventory: false,
      options: [],
      currentValue: String(control.defaultValue ?? ""),
    };
  }

  const inventoryKey = MODEL_CATEGORY_TO_INVENTORY_KEY[control.modelCategory];
  const options: string[] = (inventory as Record<string, string[] | undefined>)[inventoryKey] ?? [];
  const hasInventory = options.length > 0;
  const currentValue = String(control.defaultValue ?? "");

  return {
    // If we have no inventory, we can't validate — assume valid
    isValid: hasInventory ? options.includes(currentValue) : true,
    hasInventory,
    options,
    currentValue,
  };
}

/**
 * Obtain the available model options (as strings) for a model control,
 * given the local ComfyUI inventory. Returns an empty array if the
 * category is unknown or inventory is unavailable.
 */
export function getModelOptionsForControl(
  control: ControlSchema,
  inventory: ModelInventory,
): string[] {
  if (control.kind !== "model" || !control.modelCategory) return [];
  const inventoryKey = MODEL_CATEGORY_TO_INVENTORY_KEY[control.modelCategory];
  return (inventory as Record<string, string[] | undefined>)[inventoryKey] ?? [];
}

// File inventory — input file categories for image/video/audio pickers

/**
 * Inventory keys for input file categories (non-model).
 * These correspond to file lists retrieved from ComfyUI's object_info
 * for image/video/audio inputs on loader nodes. Stored alongside model
 * inventory in the combined LocalInventory.
 */
export type FileInventoryKey =
  | "input_images"
  | "input_videos"
  | "input_audios";

/**
 * File inventory — lists of files available in ComfyUI's input folder,
 * organized by media type. Populated from ComfyUI's object_info which
 * enumerates allowed values for image/video/audio inputs.
 */
export interface FileInventory {
  /** Image files available in ComfyUI's input folder (from LoadImage, etc.) */
  input_images?: string[];
  /** Video files available in ComfyUI's input folder */
  input_videos?: string[];
  /** Audio files available in ComfyUI's input folder */
  input_audios?: string[];
}

/**
 * Combined local inventory — model files plus input files.
 * Passed to workflow control enrichment / validation functions so
 * pickers can suggest available filenames for image/video/audio controls.
 */
export interface LocalInventory extends ModelInventory, FileInventory {}

/**
 * Maps a ControlSubtype to the FileInventoryKey used to look up
 * available filenames. Image-like subtypes share the input_images bucket;
 * video and audio have their own. Subtypes backed by model inventory
 * (animation, model-file) are not included here — they use
 * MODEL_CATEGORY_TO_INVENTORY_KEY instead.
 */
export const SUBTYPE_TO_FILE_INVENTORY_KEY: Partial<Record<ControlSubtype, FileInventoryKey>> = {
  image: "input_images",
  mask: "input_images",
  reference: "input_images",
  video: "input_videos",
  audio: "input_audios",
};

/**
 * Maps a ControlSubtype to the model-category inventory key for subtypes
 * that are backed by model inventory rather than file inventory.
 * These subtypes were already handled by model pickers; the file picker
 * falls through to them when the subtype is "animation" or "model-file".
 */
export const SUBTYPE_TO_MODEL_INVENTORY_KEY: Partial<Record<ControlSubtype, string>> = {
  animation: "animatediff_models",
};

/**
 * Human-readable labels for file inventory categories.
 */
export const FILE_INVENTORY_LABELS: Record<FileInventoryKey, string> = {
  input_images: "Input Images",
  input_videos: "Input Videos",
  input_audios: "Input Audio",
};

// Image / File option resolution

/**
 * Obtain the available image filenames for an image input control,
 * given the local ComfyUI file inventory. Uses the control's subtype
 * to determine which inventory bucket to query.
 */
export function getImageOptionsForControl(
  control: ControlSchema,
  inventory: LocalInventory,
): string[] {
  if (control.kind !== "image") return [];

  const subtype = deriveControlSubtype(control);
  const key = SUBTYPE_TO_FILE_INVENTORY_KEY[subtype];
  if (!key) return [];

  return (inventory as Record<string, string[] | undefined>)[key] ?? [];
}

/**
 * Obtain the available file options for a file-type control.
 * For animation/model-file subtypes, delegates to model inventory;
 * for video/audio subtypes, queries file inventory.
 */
export function getFileOptionsForControl(
  control: ControlSchema,
  inventory: LocalInventory,
): string[] {
  if (control.kind !== "file") return [];

  const subtype = deriveControlSubtype(control);

  // Animation subtypes use model inventory
  if (subtype === "animation") {
    const modelKey = "animatediff_models";
    return (inventory as Record<string, string[] | undefined>)[modelKey] ?? [];
  }

  // File inventory lookups for video/audio
  const key = SUBTYPE_TO_FILE_INVENTORY_KEY[subtype];
  if (key) {
    return (inventory as Record<string, string[] | undefined>)[key] ?? [];
  }

  return [];
}

// File / image validation — extends validation to image/file controls

/**
 * Validation result for a file/image control against available inventory.
 */
export interface FileValidationResult {
  /** Whether the current value is available in local inventory */
  isValid: boolean;
  /** Whether we have inventory data at all for this category */
  hasInventory: boolean;
  /** Available choices for this file/image category */
  options: string[];
  /** The current/default value */
  currentValue: string;
  /** Human-readable label for the inventory category */
  categoryLabel: string;
}

/**
 * Validate an image control's current value against available image inventory.
 * Returns validation result with available options list.
 */
export function validateImageChoice(
  control: ControlSchema,
  inventory: LocalInventory,
): FileValidationResult {
  if (control.kind !== "image") {
    return { isValid: true, hasInventory: false, options: [], currentValue: String(control.defaultValue ?? ""), categoryLabel: "Images" };
  }

  const subtype = deriveControlSubtype(control);
  const key = SUBTYPE_TO_FILE_INVENTORY_KEY[subtype];
  const categoryLabel = key ? FILE_INVENTORY_LABELS[key] ?? "Images" : "Images";
  const options: string[] = key
    ? (inventory as Record<string, string[] | undefined>)[key] ?? []
    : [];

  const hasInventory = options.length > 0;
  const currentValue = String(control.defaultValue ?? "");

  return {
    isValid: hasInventory ? options.includes(currentValue) : true,
    hasInventory,
    options,
    currentValue,
    categoryLabel,
  };
}

/**
 * Validate a file control's current value against available inventory.
 * For animation subtypes, validates against model inventory;
 * for video/audio, validates against file inventory.
 */
export function validateFileChoice(
  control: ControlSchema,
  inventory: LocalInventory,
): FileValidationResult {
  if (control.kind !== "file") {
    return { isValid: true, hasInventory: false, options: [], currentValue: String(control.defaultValue ?? ""), categoryLabel: "Files" };
  }

  const subtype = deriveControlSubtype(control);

  // Animation subtypes delegate to model inventory
  if (subtype === "animation") {
    const options = inventory.animatediff_models ?? [];
    const hasInventory = options.length > 0;
    const currentValue = String(control.defaultValue ?? "");
    return {
      isValid: hasInventory ? options.includes(currentValue) : true,
      hasInventory,
      options,
      currentValue,
      categoryLabel: "AnimateDiff Models",
    };
  }

  const key = SUBTYPE_TO_FILE_INVENTORY_KEY[subtype];
  const categoryLabel = key ? FILE_INVENTORY_LABELS[key] ?? "Files" : "Files";
  const options: string[] = key
    ? (inventory as Record<string, string[] | undefined>)[key] ?? []
    : [];

  const hasInventory = options.length > 0;
  const currentValue = String(control.defaultValue ?? "");

  return {
    isValid: hasInventory ? options.includes(currentValue) : true,
    hasInventory,
    options,
    currentValue,
    categoryLabel,
  };
}

/**
 * Filter a list of filenames by the expected extensions for a subtype.
 * Returns the list unchanged if the subtype has no extension filter
 * (e.g., generic) or if the list is empty.
 */
export function filterBySubtypeExtensions(
  filenames: string[],
  subtype: ControlSubtype,
): string[] {
  const exts = SUBTYPE_EXTENSIONS[subtype];
  if (!exts || exts.length === 0) return filenames;

  const lowerExts = exts.map((e) => e.toLowerCase());
  return filenames.filter((f) => {
    const dot = f.lastIndexOf(".");
    if (dot === -1) return true; // no extension, include it
    return lowerExts.includes(f.slice(dot).toLowerCase());
  });
}

/**
 * Get the human-readable label for a file inventory category key.
 */
export function getFileInventoryLabel(key: FileInventoryKey): string {
  return FILE_INVENTORY_LABELS[key] ?? key;
}

// Enum options enrichment from inventory

/**
 * Enrich enum control options with runtime values from the model inventory.
 * Samplers and schedulers are available from the ComfyUI object_info response
 * but stored in ModelInventory alongside model lists. This function merges
 * runtime inventory values into enum options when appropriate, avoiding
 * duplicates with the static KNOWN_ENUM_OPTIONS.
 */
function mergeUniqueOptions(primary: string[], fallback: string[]): string[] {
  const merged = [...primary];
  for (const option of fallback) {
    if (!merged.includes(option)) merged.push(option);
  }
  return merged;
}

/**
 * Return runtime enum choices for a workflow control when ComfyUI object_info
 * exposes an allowed-value list for that exact class_type + input pair.
 */
export function getRuntimeEnumOptions(
  control: ControlSchema,
  inventory: ModelInventory,
): string[] {
  if (control.kind !== "enum") return [];
  return inventory.enumOptions?.[control.classType]?.[control.inputKey] ?? [];
}

export function enrichEnumOptions(
  control: ControlSchema,
  inventory: ModelInventory,
): string[] {
  if (control.kind !== "enum" || !control.options) return [];

  const runtimeOptions = getRuntimeEnumOptions(control, inventory);

  // ComfyUI object_info is the live source of truth for arbitrary/custom-node
  // enums. Keep static options as fallback extras for offline/stale runtimes.
  if (runtimeOptions.length > 0) {
    return mergeUniqueOptions(runtimeOptions, control.options);
  }

  const base = [...control.options];

  if (control.inputKey === "sampler_name" && inventory.samplers) {
    return mergeUniqueOptions(base, inventory.samplers);
  }

  if (control.inputKey === "scheduler" && inventory.schedulers) {
    return mergeUniqueOptions(base, inventory.schedulers);
  }

  return base;
}

// Model category labels

/**
 * Human-readable labels for model categories, used in UI pickers
 * to display "Checkpoints" instead of "checkpoints".
 */
export const MODEL_CATEGORY_LABELS: Record<ModelCategory, string> = {
  checkpoint: "Checkpoints",
  lora: "LoRAs",
  vae: "VAEs",
  controlnet: "ControlNets",
  upscale: "Upscale Models",
  clip: "CLIP Models",
  unet: "UNETs",
  ipadapter: "IP-Adapters",
  embedding: "Embeddings",
  gligen: "GLIGEN Models",
  hypernetwork: "Hypernetworks",
  diffusers: "Diffusers Models",
  animatediff: "AnimateDiff Models",
  video: "Video Models",
  style: "Style Models",
};

/**
 * Get the human-readable label for a model category.
 * Falls back to title-casing the category key if no label is defined.
 */
export function getModelCategoryLabel(category: ModelCategory): string {
  return MODEL_CATEGORY_LABELS[category] ?? deriveLabel(category);
}

// Validation summary

/**
 * Result of validating a single control against inventory.
 */
export interface ControlValidationEntry {
  /** The control key (nodeId.inputKey) */
  key: string;
  /** The control kind */
  kind: ControlKind;
  /** Human-readable label */
  label: string;
  /** Whether the current value is valid */
  isValid: boolean;
  /** Whether we have inventory data to validate against */
  hasInventory: boolean;
  /** Current/default value (stringified) */
  currentValue: string;
  /** Model category, if applicable */
  modelCategory?: ModelCategory;
}

/**
 * Summary of validation across all controls in a workflow.
 */
export interface ValidationSummary {
  /** Total number of validated controls */
  total: number;
  /** Number of valid controls */
  valid: number;
  /** Number of invalid controls (value not in inventory) */
  invalid: number;
  /** Number of controls with no inventory data (assumed valid) */
  unknown: number;
  /** Per-control validation details for invalid/unknown entries */
  details: ControlValidationEntry[];
}

/**
 * Validate all model controls in a schema against the available model inventory.
 * Returns a summary with per-control details for any invalid or unknown entries.
 */
export function validateAllControls(
  controls: ControlSchema[],
  inventory: ModelInventory,
): ValidationSummary {
  let total = 0;
  let valid = 0;
  let invalid = 0;
  let unknown = 0;
  const details: ControlValidationEntry[] = [];

  for (const ctrl of controls) {
    if (ctrl.kind !== "model" || !ctrl.modelCategory) continue;
    total++;

    const result = validateModelChoice(ctrl, inventory);

    if (!result.hasInventory) {
      unknown++;
    } else if (result.isValid) {
      valid++;
    } else {
      invalid++;
    }

    // Include details for non-valid entries so the UI can surface them
    if (!result.isValid || !result.hasInventory) {
      details.push({
        key: ctrl.key,
        kind: ctrl.kind,
        label: ctrl.label,
        isValid: result.isValid,
        hasInventory: result.hasInventory,
        currentValue: result.currentValue,
        modelCategory: ctrl.modelCategory,
      });
    }
  }

  return { total, valid, invalid, unknown, details };
}

// Default value helpers

/**
 * Build a defaults map from a set of control schemas.
 * Useful for resetting overrides back to workflow defaults.
 * Key format: `${nodeId}.${inputKey}` → defaultValue
 */
export function buildDefaultsMapFromControls(
  controls: ControlSchema[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const ctrl of controls) {
    if (ctrl.kind !== "link" && ctrl.visible) {
      map[ctrl.key] = ctrl.defaultValue;
    }
  }
  return map;
}

// Default value reset

/**
 * Compute which overrides differ from defaults. Returns a map of
 * control keys that have been explicitly changed (useful for
 * reset-to-default affordances).
 */
export function computeOverrideDiff(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
): Record<string, { defaultValue: unknown; overrideValue: unknown }> {
  const diff: Record<string, { defaultValue: unknown; overrideValue: unknown }> = {};
  const defaultsMap = new Map<string, unknown>();
  for (const ctrl of controls) {
    defaultsMap.set(ctrl.key, ctrl.defaultValue);
  }
  for (const [key, value] of Object.entries(overrides)) {
    const defaultVal = defaultsMap.get(key);
    if (defaultVal !== undefined && value !== defaultVal) {
      diff[key] = { defaultValue: defaultVal, overrideValue: value };
    }
  }
  return diff;
}

// File/image control subtype hints

/**
 * Control subtype for richer picker UX. Indicates what type of content
 * a file, image, or mask control expects, so the UI can show appropriate
 * hints, accept extensions, or use specialized pickers.
 */
export type ControlSubtype =
  | "image"       // generic image
  | "mask"        // mask / alpha channel
  | "reference"   // reference / conditioning image
  | "video"       // video file
  | "audio"       // audio file
  | "animation"   // animation model (AnimateDiff)
  | "model-file"  // a model file path (non-standard loader)
  | "generic";    // generic file

/**
 * Derive a subtype hint for a control, indicating what kind of content
 * it expects. This helps the UI show category-specific labels, accept
 * button hints, and file extension filters.
 */
export function deriveControlSubtype(
  control: ControlSchema,
): ControlSubtype {
  const { inputKey, kind, classType } = control;

  if (kind === "image") {
    if (inputKey === "mask" || inputKey.endsWith("_mask")) return "mask";
    if (
      inputKey === "reference_image" ||
      inputKey === "image_emb" ||
      inputKey === "source_image" ||
      classType?.includes("IPAdapter")
    ) return "reference";
    return "image";
  }

  if (kind === "file") {
    if (inputKey === "video_path" || inputKey.startsWith("video")) return "video";
    if (inputKey === "audio_path" || inputKey.startsWith("audio")) return "audio";
    if (
      inputKey === "model_path" ||
      classType?.includes("AnimateDiff") ||
      classType?.includes("Motion")
    ) return "animation";
    if (inputKey.endsWith("_path") && kind === "file") return "model-file";
    return "generic";
  }

  return "generic";
}

/**
 * Get a human-readable hint string for a control subtype.
 */
export function getSubtypeHint(subtype: ControlSubtype): string {
  switch (subtype) {
    case "image": return "Image filename from ComfyUI input folder";
    case "mask": return "Mask filename from ComfyUI input folder";
    case "reference": return "Reference image filename from ComfyUI input folder";
    case "video": return "Video file from ComfyUI input folder";
    case "audio": return "Audio file from ComfyUI input folder";
    case "animation": return "AnimateDiff motion model file";
    case "model-file": return "Model file path";
    case "generic": return "File from ComfyUI input folder";
  }
}

/**
 * Suggested file extensions for each subtype for picker filtering.
 */
export const SUBTYPE_EXTENSIONS: Record<ControlSubtype, string[]> = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
  mask: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
  reference: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
  video: [".mp4", ".avi", ".mov", ".mkv", ".webm", ".gif"],
  audio: [".mp3", ".wav", ".flac", ".ogg", ".aac"],
  animation: [".safetensors", ".ckpt", ".pt", ".pth", ".bin"],
  "model-file": [".safetensors", ".ckpt", ".pt", ".pth", ".bin"],
  generic: [],
};

/**
 * Exported for test access.
 */
export { isImageLikeInput, isFileLikeInput };

// Grouped override summary — UX affordance for per-group reset/apply

/**
 * Summary of changes within a single group.
 */
export interface GroupOverrideSummary {
  /** Group name (e.g. "Sampling", "Model Loading") */
  group: string;
  /** Number of overridden controls in this group */
  overrideCount: number;
  /** Detail for each changed control in the group */
  changes: Array<{
    key: string;
    label: string;
    kind: ControlKind;
    defaultValue: unknown;
    overrideValue: unknown;
  }>;
}

/**
 * Compute a grouped summary of which controls are overridden, organized by
 * group. This enables per-group reset affordances and richer change summaries
 * in the UI.
 */
export function computeGroupedOverrideSummary(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
): GroupOverrideSummary[] {
  const keyMap = new Map<string, ControlSchema>();
  for (const ctrl of controls) {
    keyMap.set(ctrl.key, ctrl);
  }

  const groupMap = new Map<string, GroupOverrideSummary>();

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const ctrl = keyMap.get(key);
    if (!ctrl) continue; // skip stale overrides whose controls no longer exist
    const defaultValue = ctrl.defaultValue;
    if (overrideValue === defaultValue) continue; // not meaningfully overridden

    const group = ctrl.group;
    if (!groupMap.has(group)) {
      groupMap.set(group, { group, overrideCount: 0, changes: [] });
    }
    const entry = groupMap.get(group)!;
    entry.overrideCount++;
    entry.changes.push({
      key: ctrl.key,
      label: ctrl.label,
      kind: ctrl.kind,
      defaultValue,
      overrideValue,
    });
  }

  // Sort groups by the order of the first control in each group
  const GROUP_ORDER_MAP: Record<string, number> = {
    "Sampling": 100,
    "Prompt": 200,
    "Dimensions": 300,
    "Model Loading": 400,
    "LoRA": 410,
    "ControlNet": 500,
    "IP-Adapter": 510,
    "AnimateDiff": 520,
    "Video": 530,
    "Embeddings": 540,
    "Conditioning": 545,
    "Gligen": 550,
    "Hypernetwork": 560,
    "Style Model": 570,
    "Image Input": 600,
    "Strength / Blending": 700,
    "Upscaling": 800,
    "Output": 900,
    "Decoding": 1000,
    "Encoding": 1100,
    "Primitives": 1200,
  };

  const summaries = Array.from(groupMap.values());
  summaries.sort((a, b) => {
    const aOrder = GROUP_ORDER_MAP[a.group] ?? 2000;
    const bOrder = GROUP_ORDER_MAP[b.group] ?? 2000;
    return aOrder - bOrder;
  });

  return summaries;
}

/**
 * Collect the set of control keys belonging to a given group.
 * Used by the store's resetGroupOverrides action.
 */
export function collectGroupKeys(
  controls: ControlSchema[],
  groupName: string,
): Set<string> {
  const keys = new Set<string>();
  for (const ctrl of controls) {
    if (ctrl.group === groupName) {
      keys.add(ctrl.key);
    }
  }
  return keys;
}

// Extended validation — covers image/file controls too

/**
 * Validation entry for an image or file control.
 */
export interface FileControlValidationEntry {
  /** The control key */
  key: string;
  /** The control kind */
  kind: "image" | "file";
  /** Human-readable label */
  label: string;
  /** Whether the current value is valid */
  isValid: boolean;
  /** Whether we have inventory data to validate against */
  hasInventory: boolean;
  /** Current/default value */
  currentValue: string;
  /** File category label (e.g. "Input Images") */
  categoryLabel: string;
}

/**
 * Result of extended validation covering models AND image/file controls.
 */
export interface ExtendedValidationSummary {
  /** Model validation summary (same as validateAllControls) */
  modelValidation: ValidationSummary;
  /** Image/file validation entries */
  fileValidation: FileControlValidationEntry[];
  /** Total model controls checked */
  modelTotal: number;
  /** Total image/file controls checked */
  fileTotal: number;
  /** Total invalid (models + files) */
  totalInvalid: number;
  /** Total unknown (no inventory) */
  totalUnknown: number;
}

/**
 * Validate all controls — models, images, and files — against the available
 * local inventory. Returns a unified summary suitable for the UX to display
 * grouped warnings.
 */
export function validateAllControlsExtended(
  controls: ControlSchema[],
  inventory: LocalInventory,
): ExtendedValidationSummary {
  const modelValidation = validateAllControls(controls, inventory);

  const fileValidation: FileControlValidationEntry[] = [];
  let fileTotal = 0;

  for (const ctrl of controls) {
    if (ctrl.kind === "image") {
      const result = validateImageChoice(ctrl, inventory);
      if (result.hasInventory) {
        fileTotal++;
        if (!result.isValid) {
          fileValidation.push({
            key: ctrl.key,
            kind: "image",
            label: ctrl.label,
            isValid: false,
            hasInventory: true,
            currentValue: result.currentValue,
            categoryLabel: result.categoryLabel,
          });
        }
      }
    } else if (ctrl.kind === "file") {
      const result = validateFileChoice(ctrl, inventory);
      if (result.hasInventory) {
        fileTotal++;
        if (!result.isValid) {
          fileValidation.push({
            key: ctrl.key,
            kind: "file",
            label: ctrl.label,
            isValid: false,
            hasInventory: true,
            currentValue: result.currentValue,
            categoryLabel: result.categoryLabel,
          });
        }
      }
    }
  }

  const totalInvalid = modelValidation.invalid + fileValidation.length;
  const totalUnknown = modelValidation.unknown;

  return {
    modelValidation,
    fileValidation,
    modelTotal: modelValidation.total,
    fileTotal,
    totalInvalid,
    totalUnknown,
  };
}

// Invalid-control reset helpers — identify overridden controls whose effective
// values are not present in local inventory, for a "Reset invalid" affordance.

/**
 * Entry describing an invalid control grouped by its workflow group.
 * Used to present a per-group breakdown of invalid resources.
 */
export interface GroupInvalidSummary {
  /** Group name */
  group: string;
  /** Number of invalid controls in this group */
  invalidCount: number;
  /** Number of invalid controls that are currently overridden (resettably invalid) */
  overriddenInvalidCount: number;
  /** Detail per invalid control */
  items: Array<{
    key: string;
    label: string;
    kind: string;
    group: string;
    currentValue: string;
    isOverridden: boolean;
  }>;
}

/**
 * Compute a grouped summary of invalid controls (models, images, files)
 * whose effective values are not found in the local inventory.
 *
 * Takes overrides into account: if a user overridden a control to an invalid
 * value, the control appears with `isOverridden: true`. If the default itself
 * is invalid, it appears with `isOverridden: false` (can't auto-fix by resetting).
 *
 * Returns one entry per group that has at least one invalid control,
 * sorted by canonical group order.
 */
export function computeGroupedInvalidSummary(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
  inventory: LocalInventory,
): GroupInvalidSummary[] {
  const keyMap = new Map<string, ControlSchema>();
  for (const ctrl of controls) keyMap.set(ctrl.key, ctrl);

  // Validate each control against its effective value (override or default)
  const invalidEntries: Array<{
    key: string;
    label: string;
    kind: string;
    group: string;
    currentValue: string;
    isOverridden: boolean;
  }> = [];

  for (const ctrl of controls) {
    if (ctrl.kind !== "model" && ctrl.kind !== "image" && ctrl.kind !== "file") continue;

    const overrideValue = overrides[ctrl.key];
    const isOverridden = overrideValue !== undefined && overrideValue !== ctrl.defaultValue;
    const effectiveValue = isOverridden ? String(overrideValue) : String(ctrl.defaultValue);

    let isValid: boolean;
    let hasInventory: boolean;

    if (ctrl.kind === "model") {
      const opts = getModelOptionsForControl(ctrl, inventory);
      hasInventory = opts.length > 0;
      isValid = !hasInventory || opts.includes(effectiveValue);
    } else if (ctrl.kind === "image") {
      const imgs = inventory.input_images ?? [];
      hasInventory = imgs.length > 0;
      isValid = !hasInventory || imgs.includes(effectiveValue);
    } else {
      const files = getFileOptionsForControl(ctrl, inventory);
      hasInventory = files.length > 0;
      isValid = !hasInventory || files.includes(effectiveValue);
    }

    if (hasInventory && !isValid) {
      invalidEntries.push({
        key: ctrl.key,
        label: ctrl.label,
        kind: ctrl.kind,
        group: ctrl.group,
        currentValue: effectiveValue,
        isOverridden,
      });
    }
  }

  if (invalidEntries.length === 0) return [];

  const groupMap = new Map<string, GroupInvalidSummary>();
  const GROUP_ORDER_MAP: Record<string, number> = {
    Sampling: 100, Prompt: 200, Dimensions: 300, "Model Loading": 400,
    LoRA: 410, ControlNet: 500, "IP-Adapter": 510, AnimateDiff: 520,
    Video: 530, Embeddings: 540, Conditioning: 545, Gligen: 550,
    Hypernetwork: 560, "Style Model": 570, "Image Input": 600,
    "Strength / Blending": 700, Upscaling: 800, Output: 900,
    Decoding: 1000, Encoding: 1100, Primitives: 1200,
  };

  for (const entry of invalidEntries) {
    const group = entry.group;
    if (!groupMap.has(group)) {
      groupMap.set(group, { group, invalidCount: 0, overriddenInvalidCount: 0, items: [] });
    }
    const gs = groupMap.get(group)!;
    gs.invalidCount++;
    if (entry.isOverridden) gs.overriddenInvalidCount++;
    gs.items.push(entry);
  }

  const summaries = Array.from(groupMap.values());
  summaries.sort((a, b) => {
    const aOrder = GROUP_ORDER_MAP[a.group] ?? 2000;
    const bOrder = GROUP_ORDER_MAP[b.group] ?? 2000;
    return aOrder - bOrder;
  });

  return summaries;
}

/**
 * Collect the set of control keys that are both (a) overridden and
 * (b) invalid (not found in local inventory). These are the keys that
 * can be safely reset to default via `resetGroupOverrides` or
 * `resetOverride` — the user overrode a model/image/file to something
 * unavailable, and resetting will revert to the workflow default.
 *
 * If the default itself is invalid, resetting won't help, but the key
 * will NOT be included here (there's no point resetting to another
 * invalid default).
 */
export function collectInvalidOverrideKeys(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
  inventory: LocalInventory,
): Set<string> {
  const keyMap = new Map<string, ControlSchema>();
  for (const ctrl of controls) keyMap.set(ctrl.key, ctrl);

  const result = new Set<string>();

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const ctrl = keyMap.get(key);
    if (!ctrl) continue;
    if (ctrl.kind !== "model" && ctrl.kind !== "image" && ctrl.kind !== "file") continue;
    // Only consider meaningful overrides (override differs from default)
    if (overrideValue === undefined || overrideValue === ctrl.defaultValue) continue;

    const overrideStr = String(overrideValue);
    const defaultStr = String(ctrl.defaultValue);

    let overrideIsValid: boolean;
    let hasInventory: boolean;
    let defaultIsValid: boolean;

    if (ctrl.kind === "model") {
      const opts = getModelOptionsForControl(ctrl, inventory);
      hasInventory = opts.length > 0;
      overrideIsValid = !hasInventory || opts.includes(overrideStr);
      defaultIsValid = hasInventory && opts.includes(defaultStr);
    } else if (ctrl.kind === "image") {
      const imgs = inventory.input_images ?? [];
      hasInventory = imgs.length > 0;
      overrideIsValid = !hasInventory || imgs.includes(overrideStr);
      defaultIsValid = hasInventory && imgs.includes(defaultStr);
    } else {
      const files = getFileOptionsForControl(ctrl, inventory);
      hasInventory = files.length > 0;
      overrideIsValid = !hasInventory || files.includes(overrideStr);
      defaultIsValid = hasInventory && files.includes(defaultStr);
    }

    // Include if: override is invalid AND default is valid (resetting helps)
    if (hasInventory && !overrideIsValid && defaultIsValid) {
      result.add(key);
    }
  }

  return result;
}

// object_info-driven enrichment (ComfyUI V3 / modern input options)

/** Map a normalized spec onto a control's kind (null = keep heuristic kind). */
function kindFromSpec(meta: InputSpecMeta, current: ControlKind): ControlKind | null {
  if (meta.unknownType || meta.isLink) return null;
  switch (meta.type) {
    case "INT":
    case "FLOAT":
      if (meta.controlAfterGenerate || current === "seed") return "seed";
      return "number";
    case "BOOLEAN":
      return "boolean";
    case "STRING":
      return current === "image" || current === "file" ? current : "string";
    case "COMBO":
      if (meta.remote) return "enum";
      if (meta.upload === "image") return "image";
      if (meta.upload) return "file";
      if (current === "model") return "model";
      if (current === "image" || current === "file") return current;
      return "enum";
    case DYNAMIC_COMBO_TYPE:
      return "enum";
    default:
      return null;
  }
}

function applyMetaToControl(
  ctrl: ControlSchema,
  meta: InputSpecMeta,
  extra: {
    pathLabel?: string;
    dynamicParent?: string;
    dynamicOption?: string;
    container?: ControlSchema["container"];
  } = {},
): ControlSchema {
  const next: ControlSchema = { ...ctrl, specType: meta.type };
  const kind = kindFromSpec(meta, ctrl.kind);
  if (kind) next.kind = kind;
  if (meta.unknownType) next.unknownType = true;
  if (meta.tooltip) next.tooltip = meta.tooltip;
  if (meta.advanced || meta.hidden) next.advanced = true;
  if (meta.type === "INT" || meta.type === "FLOAT") {
    if (meta.min !== undefined) next.min = meta.min;
    if (meta.max !== undefined) next.max = meta.max;
    if (meta.step !== undefined) next.step = meta.step;
    else if (meta.type === "INT") next.step = 1;
    if (meta.round !== undefined) next.round = meta.round;
  }
  if (meta.controlAfterGenerate) next.controlAfterGenerate = true;
  if (meta.upload) next.upload = meta.upload;
  if (meta.imageFolder) next.uploadFolder = meta.imageFolder;
  if (meta.multiline) next.multiline = true;
  if (meta.dynamicPrompts) next.dynamicPrompts = true;
  if (meta.placeholder) next.placeholder = meta.placeholder;
  if (meta.labelOn) next.labelOn = meta.labelOn;
  if (meta.labelOff) next.labelOff = meta.labelOff;
  if (meta.remote) {
    next.remote = {
      route: meta.remote.route,
      refreshButton: meta.remote.refreshButton,
      controlAfterRefresh: meta.remote.controlAfterRefresh,
    };
  }
  if (meta.options && meta.options.length > 0 && next.kind !== "model") {
    next.options = meta.options;
  }
  if (meta.type === DYNAMIC_COMBO_TYPE) next.dynamicCombo = true;
  if (extra.dynamicParent) {
    next.dynamicParent = extra.dynamicParent;
    next.dynamicOption = extra.dynamicOption;
  }
  if (extra.container) next.container = extra.container;
  if (extra.pathLabel) next.label = extra.pathLabel;
  else if (meta.displayName && !ctrl.inputKey.includes(".")) next.label = meta.displayName;
  return next;
}

/** Per-node input values (defaults overlaid with overrides), keyed by inputKey. */
function nodeValueMap(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const c of controls) {
    let rec = map.get(c.nodeId);
    if (!rec) {
      rec = {};
      map.set(c.nodeId, rec);
    }
    rec[c.inputKey] = c.key in overrides ? overrides[c.key] : c.defaultValue;
  }
  return map;
}

/**
 * Enrich heuristic controls with ComfyUI's own input specs
 * (tooltip/advanced/round/step/control_after_generate/uploads/multiline/
 * dynamicPrompts/remote/V3 types). Controls whose class or input isn't in
 * `index` are returned unchanged — unknown nodes degrade to the heuristics.
 */
export function applyInputSpecs(
  controls: ControlSchema[],
  index: ObjectInfoIndex | null | undefined,
  overrides: Record<string, unknown> = {},
): ControlSchema[] {
  if (!index || Object.keys(index).length === 0) return controls;
  const values = nodeValueMap(controls, overrides);
  return controls.map((ctrl) => {
    const resolved = resolveInputSpec(
      index,
      ctrl.classType,
      ctrl.inputKey,
      values.get(ctrl.nodeId) ?? {},
    );
    if (!resolved) return ctrl;
    return applyMetaToControl(ctrl, resolved.meta, {
      pathLabel: resolved.pathLabel,
      dynamicParent: resolved.dynamicParent,
      dynamicOption: resolved.dynamicOption,
      container: resolved.container,
    });
  });
}

/**
 * Keep dynamic-combo children in step with the parent's current value:
 * children of non-selected options are dropped, and children of the
 * selected option missing from the workflow are synthesized from their
 * object_info defaults (`synthesized: true`). Runs to a fixed point so
 * nested dynamic combos (SaveVideo format → codec → encoding) resolve.
 */
export function syncDynamicComboControls(
  controls: ControlSchema[],
  index: ObjectInfoIndex | null | undefined,
  overrides: Record<string, unknown> = {},
): ControlSchema[] {
  if (!index) return controls;
  let current = controls;
  for (let pass = 0; pass < 8; pass++) {
    const values = nodeValueMap(current, overrides);
    const parents = current.filter((c) => c.dynamicCombo);
    const parentValue = (nodeId: string, inputKey: string) =>
      values.get(nodeId)?.[inputKey];
    const parentKeys = new Set(parents.map((p) => p.key));

    // Drop children whose parent is gone or set to a different option.
    let next = current.filter((c) => {
      if (!c.dynamicParent) return true;
      const parentKey = `${c.nodeId}.${c.dynamicParent}`;
      if (!parentKeys.has(parentKey)) return false;
      return parentValue(c.nodeId, c.dynamicParent) === c.dynamicOption;
    });

    const existing = new Set(next.map((c) => c.key));
    const added: ControlSchema[] = [];
    for (const p of parents) {
      if (!next.includes(p)) continue;
      const resolved = resolveInputSpec(index, p.classType, p.inputKey, values.get(p.nodeId) ?? {});
      if (!resolved) continue;
      const selected = parentValue(p.nodeId, p.inputKey);
      for (const [childKey, meta] of dynamicComboChildren(resolved.meta, p.inputKey, selected)) {
        const key = `${p.nodeId}.${childKey}`;
        if (existing.has(key) || meta.isLink || meta.unknownType) continue;
        const base: ControlSchema = {
          key,
          nodeId: p.nodeId,
          inputKey: childKey,
          classType: p.classType,
          kind: "string",
          label: deriveLabel(childKey.split(".").pop() ?? childKey),
          group: p.group,
          defaultValue: meta.defaultValue ?? (meta.options ? meta.options[0] : null),
          visible: true,
          order: p.order + 0.001 * (added.length + 1),
          synthesized: true,
        };
        added.push(
          applyMetaToControl(base, meta, {
            dynamicParent: p.inputKey,
            dynamicOption: String(selected),
            pathLabel: `${p.label} · ${deriveLabel(childKey.split(".").pop() ?? childKey)}`,
          }),
        );
        existing.add(key);
      }
    }
    next = [...next, ...added];
    if (next.length === current.length && added.length === 0) return next;
    current = next;
  }
  return current;
}

/**
 * Values the submit path needs beyond plain overrides: synthesized
 * dynamic-combo children (absent from the saved workflow) and every
 * active child of an overridden dynamic-combo parent (so
 * applyControlOverrides can prune the old option's children safely).
 */
export function collectDynamicSubmitValues(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const overriddenParents = new Set(
    controls
      .filter((c) => c.dynamicCombo && c.key in overrides && overrides[c.key] !== c.defaultValue)
      .map((c) => c.key),
  );
  for (const c of controls) {
    if (!c.dynamicParent) continue;
    const parentKey = `${c.nodeId}.${c.dynamicParent}`;
    if (c.synthesized || overriddenParents.has(parentKey)) {
      out[c.key] = c.key in overrides ? overrides[c.key] : c.defaultValue;
    }
  }
  return out;
}
