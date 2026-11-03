/**
 * Workflow Analysis Utilities
 * Analyzes workflows for type detection, required inputs, and API validation.
 */

import type { Workflow, WorkflowNode } from "@/types";

export type { Workflow } from "@/types";

// Workflow Type Detection

export type WorkflowType =
  | "t2i"
  | "i2i"
  | "upscale"
  | "inpaint"
  | "outpaint"
  | "controlnet"
  | "t2v"
  | "i2v"
  | "r2v"
  | "t23d"
  | "i23d"
  | "t2a"
  | "unknown";

// Canonical class-type sets — single source of truth for workflow detection.
// Exported so discovery.ts and tests can import instead of duplicating.

export const WORKFLOW_KSAMPLER_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "KSamplerSelect",
  "FluxSampler",
]);

export const WORKFLOW_VIDEO_OUTPUT_CLASSES = new Set([
  "VHS_VideoCombine",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "CreateVideo",
  "SaveVideo",
  "SaveWEBM",
]);

export const WORKFLOW_MESH_OUTPUT_CLASSES = new Set([
  "SaveGLB",
  "Save3DModel",
  "SaveOBJ",
  "SavePLY",
  "TripoSRSampler",
]);

export const WORKFLOW_AUDIO_OUTPUT_CLASSES = new Set([
  "SaveAudio",
  "PreviewAudio",
]);

export const WORKFLOW_IMAGE_LOADER_CLASSES = new Set([
  "LoadImage",
  "LoadImageMask",
  "LoadImageFromUrl",
]);

export const WORKFLOW_MASK_CLASSES = new Set([
  "LoadImageMask",
  "VAEEncodeForInpaint",
]);

/** Outpaint-specific node classes (distinct from inpaint). */
export const WORKFLOW_OUTPAINT_CLASSES = new Set([
  "OutpaintExpand",
  "PrepImageForOutpaint",
  "PadImageForOutpaint",
]);

export const WORKFLOW_INPAINT_CLASSES = new Set([
  "InpaintWorkflow",
  "InpaintPreprocessor",
  "InpaintCrop",
  "InpaintCropImproved",
  "InpaintExpand",
]);

export const WORKFLOW_UPSCALE_CLASSES = new Set([
  "ImageUpscaleWithModel",
  "UpscaleNode",
  "LoadAndResampleWorkflow",
]);

/** Checkpoint/model-loader classes that strongly imply a t2i backbone. */
export const WORKFLOW_CHECKPOINT_CLASSES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "unCLIPCheckpointLoader",
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
  "ModelSamplingAuraFlow",
  "ModelSamplingLTXV",
  "ModelSamplingSD3",
]);

// Local aliases

const TEXT_TO_IMAGE_CLASSES = WORKFLOW_CHECKPOINT_CLASSES;
const IMAGE_LOADER_CLASSES = WORKFLOW_IMAGE_LOADER_CLASSES;
const MASK_CLASSES = WORKFLOW_MASK_CLASSES;
const UPSCALE_CLASSES = WORKFLOW_UPSCALE_CLASSES;
const INPAINT_CLASSES = WORKFLOW_INPAINT_CLASSES;
const VIDEO_OUTPUT_CLASSES = WORKFLOW_VIDEO_OUTPUT_CLASSES;
const MESH_OUTPUT_CLASSES = WORKFLOW_MESH_OUTPUT_CLASSES;
const AUDIO_OUTPUT_CLASSES = WORKFLOW_AUDIO_OUTPUT_CLASSES;

/**
 * Detect workflow type based on node class types present
 */
export function detectWorkflowType(workflow: Workflow): WorkflowType {
  const classTypes = Object.values(workflow).map((n) => n.class_type);

  // Check for 3D output nodes first (highest priority)
  const hasMeshOutput = classTypes.some((ct) => MESH_OUTPUT_CLASSES.has(ct));
  if (hasMeshOutput) {
    const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
    return hasImageInput ? "i23d" : "t23d";
  }

  const hasAudioOutput = classTypes.some((ct) => AUDIO_OUTPUT_CLASSES.has(ct));
  if (hasAudioOutput) {
    return "t2a";
  }

  const hasVideoOutput = classTypes.some((ct) => VIDEO_OUTPUT_CLASSES.has(ct));
  if (hasVideoOutput) {
    const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
    return hasImageInput ? "i2v" : "t2v";
  }

  // Check for inpaint-specific nodes (before outpaint — inpaint takes priority)
  const hasInpaintNodes = classTypes.some(
    (ct) =>
      INPAINT_CLASSES.has(ct) ||
      ct.includes("Inpaint") ||
      ct.includes("inpaint"),
  );
  const hasMaskNodes = classTypes.some((ct) => MASK_CLASSES.has(ct));
  if (hasInpaintNodes || hasMaskNodes) {
    return "inpaint";
  }

  const hasOutpaintNodes = classTypes.some(
    (ct) =>
      WORKFLOW_OUTPAINT_CLASSES.has(ct) ||
      ct.includes("Outpaint") ||
      ct.includes("outpaint"),
  );
  if (hasOutpaintNodes) {
    return "outpaint";
  }

  // Check for upscale nodes (no sampler)
  const hasUpscaleNodes = classTypes.some(
    (ct) =>
      UPSCALE_CLASSES.has(ct) ||
      ct.includes("Upscale") ||
      ct.includes("ESRGAN") ||
      ct.includes("RealESRGAN"),
  );
  const hasKSampler = classTypes.some((ct) =>
    WORKFLOW_KSAMPLER_CLASSES.has(ct),
  );
  if (hasUpscaleNodes && !hasKSampler) {
    return "upscale";
  }

  // Check for ControlNet workflows (before generic i2i)
  const hasControlNet = classTypes.some(
    (ct) => ct === "ControlNetApply" || ct === "ControlNetApplyAdvanced",
  );
  if (hasControlNet) {
    return "controlnet";
  }

  // Check for image input (img2img)
  const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
  if (hasImageInput) {
    return "i2i";
  }

  // Check for text-to-image (has checkpoint loader + sampler)
  const hasCheckpointLoader = classTypes.some((ct) =>
    TEXT_TO_IMAGE_CLASSES.has(ct),
  );
  if (hasCheckpointLoader || hasKSampler) {
    return "t2i";
  }

  return "unknown";
}

// Required Inputs Detection

export interface RequiredInput {
  name: string;
  type: "model" | "image" | "mask" | "text" | "number" | "string" | "latent";
  optional?: boolean;
  description?: string;
  nodeClass: string;
  nodeId?: string;
}

const MODEL_INPUT_CLASSES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
  "ModelSamplingAuraFlow",
  "CLIPLoader",
  "CLIPLoaderSDXL",
  "CLIPLoaderFlux",
  "ModelSamplingLTXV",
  "ModelSamplingSD3",
  "VAELoader",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "LoadCheckpoint",
]);

const IMAGE_INPUT_CLASSES = new Set([
  "LoadImage",
  "LoadImageMask",
  "LoadImageFromUrl",
  "VAEEncode",
  "VAEEncodeForInpaint",
  "ImageScale",
  "ImagePad",
]);

const TEXT_INPUT_CLASSES = new Set([
  "CLIPTextEncode",
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeSDXLRefiner",
  "CLIPTextEncodeFlux",
  "BNK_CLIPTextEncodeAdvanced",
  "ConditioningCombine",
  "ConditioningSetArea",
  "ConditioningSetMask",
]);

const LATENT_INPUT_CLASSES = new Set([
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "EmptySDXLLatentImage",
  "EmptyLatentImageFlux",
  "EmptyLTXVLatentVideo",
  "LTXVImgToVideo",
  "WanImageToVideo",
  "Wan22ImageToVideoLatent",
  "EmptyHunyuanLatentVideo",
  "EmptyHunyuanVideo15Latent",
]);

const NUMBER_INPUT_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);

export function detectRequiredInputs(workflow: Workflow): RequiredInput[] {
  const inputs: RequiredInput[] = [];
  const seenInputs = new Set<string>();

  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = node.class_type;

    if (MODEL_INPUT_CLASSES.has(classType)) {
      const modelType = inferModelType(classType);
      const key = `model:${modelType}`;
      if (!seenInputs.has(key)) {
        seenInputs.add(key);
        inputs.push({
          name:
            modelType === "clip"
              ? "CLIP Model"
              : modelType === "vae"
                ? "VAE"
                : "Checkpoint/Model",
          type: "model",
          description: `Required ${modelType} for ${classType}`,
          nodeClass: classType,
          nodeId,
        });
      }
    }

    if (IMAGE_INPUT_CLASSES.has(classType)) {
      const isMask = classType === "LoadImageMask";
      const key = isMask ? "mask:image" : "image:input";
      if (!seenInputs.has(key)) {
        seenInputs.add(key);
        inputs.push({
          name: isMask ? "Mask Image" : "Input Image",
          type: isMask ? "mask" : "image",
          optional: classType !== "LoadImage",
          description: `${isMask ? "Mask" : "Image"} input for ${classType}`,
          nodeClass: classType,
          nodeId,
        });
      }
    }

    if (TEXT_INPUT_CLASSES.has(classType) && classType.includes("TextEncode")) {
      const key = "text:prompt";
      if (!seenInputs.has(key)) {
        seenInputs.add(key);
        inputs.push({
          name: "Positive Prompt",
          type: "text",
          description: "Main text prompt for generation",
          nodeClass: classType,
          nodeId,
        });
      }
    }

    if (LATENT_INPUT_CLASSES.has(classType)) {
      const key = "latent:dimensions";
      if (!seenInputs.has(key)) {
        seenInputs.add(key);
        inputs.push({
          name: "Latent Dimensions",
          type: "latent",
          description: "Output size settings",
          nodeClass: classType,
          nodeId,
        });
      }
    }

    if (NUMBER_INPUT_CLASSES.has(classType)) {
      const key = "number:steps";
      if (!seenInputs.has(key)) {
        seenInputs.add(key);
        inputs.push({
          name: "Sampler Settings",
          type: "number",
          description: "Steps, CFG, sampler, scheduler",
          nodeClass: classType,
          nodeId,
        });
      }
    }
  }

  return inputs;
}

function inferModelType(classType: string): string {
  if (classType.includes("CLIP")) return "clip";
  if (classType.includes("VAE")) return "vae";
  if (classType.includes("Lora")) return "lora";
  return "model";
}

// Node Structure Overview

export interface NodeInfo {
  id: string;
  type: string;
  inputs: string[];
  hasRequiredInputs: boolean;
}

export interface WorkflowStructure {
  nodeCount: number;
  nodeTypes: string[];
  nodes: NodeInfo[];
  connections: number;
}

/**
 * Analyze workflow structure (node types, connections)
 */
export function analyzeWorkflowStructure(
  workflow: Workflow,
): WorkflowStructure {
  const nodes: NodeInfo[] = [];
  const nodeTypesSet = new Set<string>();
  let connections = 0;

  for (const [id, node] of Object.entries(workflow)) {
    const inputNames = Object.keys(node.inputs || {});
    const hasRequiredInputs = inputNames.length > 0;

    nodes.push({
      id,
      type: node.class_type,
      inputs: inputNames,
      hasRequiredInputs,
    });
    nodeTypesSet.add(node.class_type);

    // Count connections (inputs that reference other nodes)
    for (const value of Object.values(node.inputs || {})) {
      if (isNodeRef(value)) {
        connections++;
      }
    }
  }

  return {
    nodeCount: Object.keys(workflow).length,
    nodeTypes: Array.from(nodeTypesSet).sort(),
    nodes,
    connections,
  };
}

function isNodeRef(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

// Workflow Validation (API-runnable check)

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  nodeType?: string;
}

export interface WorkflowValidation {
  isRunnable: boolean;
  isApiRunnable: boolean;
  issues: ValidationIssue[];
  hasPromptInjection: boolean;
  hasImageInput: boolean;
  hasOutput: boolean;
}

const UNSUPPORTED_NODE_PATTERNS = [
  /^pysssss\/.*/, // ComfyUI-Manager custom nodes
  /^ImpactPack\/.*/, // Impact Pack (often has issues)
  /^cg\.([^/]+)\//, // CG nodes
  /^Davemane\/.*/,
  /^SmilingGoblin\/.*/,
];

const REQUIRED_NODE_TYPES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "FluxSampler",
]);

const OUTPUT_NODE_TYPES = new Set([
  "SaveImage",
  "PreviewImage",
  "ImageOutput",
  "VHS_VideoCombine",
]);

/**
 * Validate if a workflow is API-runnable
 */
export function validateWorkflowForApi(workflow: Workflow): WorkflowValidation {
  const issues: ValidationIssue[] = [];
  const classTypes = Object.values(workflow).map((n) => n.class_type);

  const hasSampler = classTypes.some((ct) => REQUIRED_NODE_TYPES.has(ct));
  if (!hasSampler) {
    issues.push({
      severity: "error",
      message: "No sampling node (KSampler/KSamplerAdvanced) found",
    });
  }

  const hasOutput = classTypes.some((ct) => OUTPUT_NODE_TYPES.has(ct));
  if (!hasOutput) {
    issues.push({
      severity: "warning",
      message: "No output node (SaveImage/PreviewImage) found",
    });
  }

  for (const [id, node] of Object.entries(workflow)) {
    for (const pattern of UNSUPPORTED_NODE_PATTERNS) {
      if (pattern.test(node.class_type)) {
        issues.push({
          severity: "warning",
          message: `Potentially unsupported custom node: ${node.class_type}`,
          nodeId: id,
          nodeType: node.class_type,
        });
      }
    }
  }

  // Check for image input (affects how prompt is used)
  const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));

  // Check for text encoder (prompt injection point)
  const hasPromptInjection = classTypes.some((ct) =>
    TEXT_INPUT_CLASSES.has(ct),
  );

  // Check for missing required model inputs (widget defaults)
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (MODEL_INPUT_CLASSES.has(node.class_type)) {
      const hasModelConnection = Object.values(node.inputs || {}).some((v) =>
        isNodeRef(v),
      );
      const hasWidgetDefault =
        node.inputs?.ckpt_name ||
        node.inputs?.model_name ||
        node.inputs?.clip_name ||
        node.inputs?.vae_name;
      if (!hasModelConnection && !hasWidgetDefault) {
        issues.push({
          severity: "warning",
          message: `Model loader ${node.class_type} may be missing model input`,
          nodeId,
          nodeType: node.class_type,
        });
      }
    }
  }

  return {
    isRunnable: issues.filter((i) => i.severity === "error").length === 0,
    isApiRunnable:
      issues.filter((i) => i.severity === "error").length === 0 && hasSampler,
    issues,
    hasPromptInjection,
    hasImageInput,
    hasOutput,
  };
}

// Workflow Name Formatting

/**
 * Clean up workflow filename for display
 */
export function formatWorkflowName(filename: string): string {
  return (
    filename
      .replace(/\.json$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      // Fix common patterns
      .replace(/\bPng\b/g, "PNG")
      .replace(/\bJpg\b/g, "JPG")
      .replace(/\bApi\b/g, "API")
      .replace(/\bT2i\b/gi, "Text-to-Image")
      .replace(/\bI2i\b|I2img\b|I2I\b/gi, "Image-to-Image")
      .trim()
  );
}

// Node Label Mapping (for live progress display)

export const NODE_LABELS: Record<string, string> = {
  // Samplers
  KSampler: "Sampling",
  KSamplerAdvanced: "Sampling",
  SamplerCustom: "Sampling",
  SamplerCustomAdvanced: "Sampling",
  KSamplerSelect: "Sampling",
  FluxSampler: "Sampling",
  // Decode/Encode
  VAEDecode: "Decoding",
  VAEDecodeTiled: "Decoding",
  VAEEncode: "Encoding image",
  VAEEncodeTiled: "Encoding image",
  VAEEncodeForInpaint: "Encoding for inpaint",
  // Output
  SaveImage: "Saving",
  PreviewImage: "Previewing",
  ImageOutput: "Saving",
  VHS_VideoCombine: "Combining video",
  SaveAnimatedWEBP: "Saving video",
  SaveAnimatedPNG: "Saving video",
  SaveAudio: "Saving audio",
  PreviewAudio: "Previewing audio",
  SaveGLB: "Saving 3D model",
  // Text/conditioning
  CLIPTextEncode: "Encoding prompt",
  CLIPTextEncodeSDXL: "Encoding prompt",
  CLIPTextEncodeSDXLRefiner: "Encoding prompt",
  CLIPTextEncodeFlux: "Encoding prompt",
  BNK_CLIPTextEncodeAdvanced: "Encoding prompt",
  ConditioningCombine: "Combining conditions",
  ConditioningSetArea: "Setting condition area",
  ConditioningSetMask: "Applying mask condition",
  // Model loaders
  CheckpointLoaderSimple: "Loading model",
  CheckpointLoader: "Loading model",
  unCLIPCheckpointLoader: "Loading model",
  UNETLoader: "Loading model",
  UNETLoaderSDXL: "Loading model",
  UNETLoaderFlux: "Loading model",
  CLIPLoader: "Loading CLIP",
  CLIPLoaderSDXL: "Loading CLIP",
  VAELoader: "Loading VAE",
  LoraLoader: "Loading LoRA",
  LoraLoaderModelOnly: "Loading LoRA",
  // Image/latent
  EmptyLatentImage: "Creating latent",
  EmptySD3LatentImage: "Creating latent",
  EmptySDXLLatentImage: "Creating latent",
  EmptyLatentImageFlux: "Creating latent",
  LoadImage: "Loading image",
  LoadImageMask: "Loading mask",
  LoadImageFromUrl: "Loading image",
  // ControlNet
  ControlNetLoader: "Loading ControlNet",
  ControlNetApply: "Applying ControlNet",
  ControlNetApplyAdvanced: "Applying ControlNet",
  CannyEdgePreprocessor: "Preprocessing canny edges",
  DepthPreprocessor: "Preprocessing depth",
  // Upscale
  ImageUpscaleWithModel: "Upscaling",
  UpscaleModelLoader: "Loading upscaler",
  // Image ops
  ImageScale: "Scaling image",
  ImagePad: "Padding image",
  ImageCrop: "Cropping image",
  InpaintCrop: "Cropping for inpaint",
  InpaintCropImproved: "Cropping for inpaint",
  InpaintExpand: "Expanding inpaint",
  PrepImageForOutpaint: "Preparing outpaint",
  PadImageForOutpaint: "Padding for outpaint",
};

/**
 * Get a human-readable label for a ComfyUI node class type.
 * Falls back to a cleaned-up version of the class name.
 */
export function getNodeLabel(classType: string): string {
  if (NODE_LABELS[classType]) return NODE_LABELS[classType];
  // Fallback: split on capital letters, e.g. "SomeCustomNode" → "Some Custom Node"
  return classType
    .replace(/([A-Z])/g, " $1")
    .replace(/^[\s_]+/, "")
    .replace(/[_]+/g, " ")
    .trim();
}

// Type Label Formatting

const TYPE_LABELS: Record<WorkflowType, string> = {
  t2i: "Text-to-Image",
  i2i: "Image-to-Image",
  upscale: "Upscale",
  inpaint: "Inpaint",
  outpaint: "Outpaint",
  controlnet: "ControlNet",
  t2v: "Text-to-Video",
  i2v: "Image-to-Video",
  r2v: "Reference-to-Video",
  t23d: "Text-to-3D",
  i23d: "Image-to-3D",
  t2a: "Text-to-Audio",
  unknown: "Unknown",
};

const TYPE_COLORS: Record<WorkflowType, string> = {
  t2i: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  i2i: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  upscale: "bg-green-500/20 text-green-400 border-green-500/30",
  inpaint: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  outpaint: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  controlnet: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  t2v: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  i2v: "bg-teal-500/20 text-teal-400 border-teal-500/30",
  r2v: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  t23d: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  i23d: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  t2a: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  unknown:
    "bg-light-400/20 text-light-400 dark:text-dark-500 border-light-400/30",
};

export function getTypeLabel(type: WorkflowType): string {
  return TYPE_LABELS[type] ?? TYPE_LABELS.unknown;
}

export function getTypeColorClasses(type: WorkflowType): string {
  return TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
}
