/**
 * Injectable Adapters
 * Model-aware adapter configuration for LoRA, SREF/IPAdapter, and ControlNet.
 *
 * Provides:
 * - Default adapter packs (SDXL, Flux) that define which node classes to use
 *   for each injectable type
 * - ControlNet injection (apply ControlNet params to a workflow)
 * - Adapter resolution: given a model family, pick the right adapter config
 *
 * Packs do not auto-resolve from checkpoint names.
 */

import type {
  Workflow,
  WorkflowSlots,
  ControlNetSlot,
  ControlNetParams,
  AdapterConfig,
  AdapterPack,
  WorkflowNode,
} from "@/types";
import { setNodeInput, cloneWorkflow } from "./engine";
import {
  discoverControlNetSlots,
  enrichSlotsWithCapabilities,
} from "./discovery";

// Default Adapter Packs

export const SDXL_DEFAULT_PACK: AdapterPack = {
  id: "sdxl-default",
  name: "SDXL Default",
  modelFamily: "sdxl",
  description: "Default adapter pack for SDXL checkpoints (SDXL Base, SDXL Turbo, etc.)",
  tags: ["sdxl", "stable-diffusion-xl", "sdxl-turbo"],
  adapters: [
    {
      type: "lora",
      loaderClass: "LoraLoader",
      applyClass: "LoraLoader", // self-contained loader+apply
      strengthParamName: "strength_model",
      modelParamName: "lora_name",
      label: "LoRA (SDXL)",
      description: "Low-Rank Adaptation for SDXL — modifies both model and CLIP",
      hasSeparateLoader: false,
      hasModelOutput: true,
      requiresClip: true,
      requiresImage: false,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "sref",
      loaderClass: "SREFStyleEncode",
      applyClass: "StyleApplyIPAdapter",
      strengthParamName: "strength",
      modelParamName: "image_url",
      label: "Style Reference",
      description: "Style reference via SREF encoding — applies style from a reference image",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "controlnet",
      loaderClass: "ControlNetLoader",
      applyClass: "ControlNetApplyAdvanced",
      preprocessorClass: "CannyEdgePreprocessor",
      strengthParamName: "strength",
      modelParamName: "control_net_name",
      label: "ControlNet (SDXL)",
      description: "ControlNet conditioning for SDXL — supports start/end percent",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "ipadapter",
      loaderClass: "IPAdapterModelLoader",
      applyClass: "IPAdapterAdvanced",
      strengthParamName: "weight",
      modelParamName: "ipadapter_file",
      label: "IPAdapter Advanced",
      description: "Advanced IPAdapter for SDXL — image prompting with weight control",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
  ],
};

export const FLUX_DEFAULT_PACK: AdapterPack = {
  id: "flux-default",
  name: "Flux Default",
  modelFamily: "flux",
  description: "Default adapter pack for Flux models (Flux.1 Dev, Flux.1 Schnell, etc.)",
  tags: ["flux", "flux-dev", "flux-schnell"],
  adapters: [
    {
      type: "lora",
      loaderClass: "LoraLoaderModelOnly", // Flux uses model-only LoRA by default
      applyClass: "LoraLoaderModelOnly",
      strengthParamName: "strength_model",
      modelParamName: "lora_name",
      label: "LoRA (Flux)",
      description: "Model-only LoRA for Flux — no CLIP output, chains into model pipeline",
      hasSeparateLoader: false,
      hasModelOutput: true,
      requiresClip: false,
      requiresImage: false,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "sref",
      loaderClass: "SREFStyleEncode",
      applyClass: "StyleApplyIPAdapter",
      strengthParamName: "strength",
      modelParamName: "image_url",
      label: "Style Reference (Flux)",
      description: "Style reference via SREF encoding for Flux — applies style from a reference image",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "controlnet",
      loaderClass: "ControlNetLoader",
      applyClass: "ControlNetApplyAdvanced",
      preprocessorClass: "CannyEdgePreprocessor",
      strengthParamName: "strength",
      modelParamName: "control_net_name",
      label: "ControlNet (Flux)",
      description: "ControlNet conditioning for Flux — supports start/end percent",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "ipadapter",
      loaderClass: "IPAdapterModelLoader",
      applyClass: "IPAdapterFull",
      strengthParamName: "weight",
      modelParamName: "ipadapter_file",
      label: "IPAdapter Full (Flux)",
      description: "Full IPAdapter for Flux — image prompting with weight control",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
  ],
};

export const SD15_DEFAULT_PACK: AdapterPack = {
  id: "sd15-default",
  name: "SD 1.5 Default",
  modelFamily: "sd15",
  description: "Default adapter pack for Stable Diffusion 1.5 checkpoints",
  tags: ["sd15", "stable-diffusion", "sd-1.5"],
  adapters: [
    {
      type: "lora",
      loaderClass: "LoraLoader",
      applyClass: "LoraLoader",
      strengthParamName: "strength_model",
      modelParamName: "lora_name",
      label: "LoRA (SD 1.5)",
      description: "Low-Rank Adaptation for SD 1.5 — modifies both model and CLIP",
      hasSeparateLoader: false,
      hasModelOutput: true,
      requiresClip: true,
      requiresImage: false,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "sref",
      loaderClass: "SREFStyleEncode",
      applyClass: "StyleApplyIPAdapter",
      strengthParamName: "strength",
      modelParamName: "image_url",
      label: "Style Reference (SD 1.5)",
      description: "Style reference for SD 1.5 via SREF encoding",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
    {
      type: "controlnet",
      loaderClass: "ControlNetLoader",
      applyClass: "ControlNetApply",
      preprocessorClass: "CannyEdgePreprocessor",
      strengthParamName: "strength",
      modelParamName: "control_net_name",
      label: "ControlNet (SD 1.5)",
      description: "ControlNet conditioning for SD 1.5 — basic apply without start/end percent",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 1.0,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: false, // ControlNetApply doesn't support stacking as cleanly
    },
    {
      type: "ipadapter",
      loaderClass: "IPAdapterModelLoader",
      applyClass: "IPAdapterAdvanced",
      strengthParamName: "weight",
      modelParamName: "ipadapter_file",
      label: "IPAdapter Advanced (SD 1.5)",
      description: "Advanced IPAdapter for SD 1.5 — image prompting with weight control",
      hasSeparateLoader: true,
      hasModelOutput: false,
      requiresClip: false,
      requiresImage: true,
      defaultStrength: 0.8,
      minStrength: 0,
      maxStrength: 2.0,
      supportsStacking: true,
    },
  ],
};

// Pack registry
const PACK_REGISTRY: Map<string, AdapterPack> = new Map([
  ["sdxl-default", SDXL_DEFAULT_PACK],
  ["flux-default", FLUX_DEFAULT_PACK],
  ["sd15-default", SD15_DEFAULT_PACK],
]);

/**
 * Register an adapter pack (for extensibility / future pack.json loading).
 */
export function registerAdapterPack(pack: AdapterPack): void {
  PACK_REGISTRY.set(pack.id, pack);
}

export function getAdapterPack(packId: string): AdapterPack | undefined {
  return PACK_REGISTRY.get(packId);
}

export function getAllAdapterPacks(): AdapterPack[] {
  return Array.from(PACK_REGISTRY.values());
}

/**
 * Resolve the best adapter pack for a given model family.
 * Falls back to SDXL if the model family has no registered pack.
 */
export function resolveAdapterPack(modelFamily: string): AdapterPack {
  for (const pack of PACK_REGISTRY.values()) {
    if (pack.modelFamily === modelFamily) return pack;
  }
  // Try partial match (e.g. "sdxl" in "SDXL 1.0")
  const lowerFamily = modelFamily.toLowerCase();
  for (const pack of PACK_REGISTRY.values()) {
    if (lowerFamily.includes(pack.modelFamily)) return pack;
  }
  return SDXL_DEFAULT_PACK;
}

export function getAdapterConfig(
  pack: AdapterPack,
  type: "lora" | "sref" | "controlnet" | "ipadapter",
): AdapterConfig | undefined {
  return pack.adapters.find((a) => a.type === type);
}

// ControlNet Injection

/**
 * ControlNet preprocessor mapping — shorthand names to ComfyUI class types.
 */
export const CONTROLNET_PREPROCESSOR_MAP: Record<string, string> = {
  canny: "CannyEdgePreprocessor",
  depth: "DepthAnythingPreprocessor",
  depth_anything: "DepthAnythingPreprocessor",
  midas: "MiDaSDepthMapPreprocessor",
  openpose: "OpenposePreprocessor",
  dwpose: "DWPosePreprocessor",
  lineart: "LineartPreprocessor",
  line_art: "LineartPreprocessor",
  hed: "HEDPreprocessor",
  scribble: "ScribblePreprocessor",
  inpaint: "InpaintPreprocessor",
  manga: "MangaLinePreprocessor",
  mlsd: "MLSDPreprocessor",
  normal: "BAE-NormalMapPreprocessor",
  binary: "BinaryPreprocessor",
  color: "ColorPreprocessor",
  tile: "TilePreprocessor",
};

/**
 * Resolve a preprocessor shorthand (e.g. "canny") to its ComfyUI class type.
 * Returns the input unchanged if it's already a full class name.
 */
export function resolvePreprocessorClass(shorthand: string): string {
  return CONTROLNET_PREPROCESSOR_MAP[shorthand.toLowerCase()] ?? shorthand;
}

export interface ControlNetInjectionResult {
  workflow: Workflow;
  injectedNodeIds: string[];
  errors: string[];
}

/**
 * Apply ControlNet parameters to a workflow that already has ControlNet nodes.
 * This modifies an existing ControlNet chain — it does NOT add new nodes.
 * For workflows without ControlNet nodes, use `injectControlNet` instead.
 */
export function applyControlNetParams(
  workflow: Workflow,
  slots: ControlNetSlot[],
  params: ControlNetParams,
): ControlNetInjectionResult {
  const result: ControlNetInjectionResult = {
    workflow: cloneWorkflow(workflow),
    injectedNodeIds: [],
    errors: [],
  };

  if (slots.length === 0) {
    result.errors.push("No ControlNet slots found in workflow");
    return result;
  }

  // Apply to the first available ControlNet slot
  const slot = slots[0];

  if (slot.loaderId && params.model) {
    setNodeInput(result.workflow, slot.loaderId, "control_net_name", params.model);
    result.injectedNodeIds.push(slot.loaderId);
  }

  if (slot.applyId && params.strength !== undefined) {
    setNodeInput(result.workflow, slot.applyId, "strength", params.strength);
    result.injectedNodeIds.push(slot.applyId);
  }

  if (slot.applyId) {
    const applyNode = result.workflow[slot.applyId];
    if (applyNode?.class_type === "ControlNetApplyAdvanced") {
      if (params.startPercent !== undefined) {
        setNodeInput(result.workflow, slot.applyId, "start_percent", params.startPercent);
      }
      if (params.endPercent !== undefined) {
        setNodeInput(result.workflow, slot.applyId, "end_percent", params.endPercent);
      }
    }
  }

  if (params.sourceImage && slot.imageInputId) {
    setNodeInput(result.workflow, slot.imageInputId, "image", params.sourceImage);
    result.injectedNodeIds.push(slot.imageInputId);
  }

  return result;
}

/**
 * Inject ControlNet nodes into a workflow that does NOT already have them.
 * Creates a minimal ControlNet chain: LoadImage -> Preprocessor -> ControlNetLoader -> ControlNetApply.
 * The ControlNetApply node is inserted between the positive conditioning and the KSampler.
 */
export function injectControlNet(
  workflow: Workflow,
  baseSlots: WorkflowSlots,
  params: ControlNetParams,
): ControlNetInjectionResult {
  const result: ControlNetInjectionResult = {
    workflow: cloneWorkflow(workflow),
    injectedNodeIds: [],
    errors: [],
  };

  const existingSlots = discoverControlNetSlots(result.workflow);
  if (existingSlots.length > 0) {
    return applyControlNetParams(result.workflow, existingSlots, params);
  }

  // Need a sampler to wire into
  if (!baseSlots.ksamplerId || !result.workflow[baseSlots.ksamplerId]) {
    result.errors.push("No KSampler found — cannot inject ControlNet");
    return result;
  }

  // Generate node IDs (use high numbers to avoid collisions)
  const maxId = Math.max(
    ...Object.keys(result.workflow).map((id) => parseInt(id, 10) || 0),
  );
  let nextId = maxId + 1;
  const nid = () => String(nextId++);

  // 1. LoadImage node for the control image
  const imageNodeId = nid();
  result.workflow[imageNodeId] = {
    class_type: "LoadImage",
    inputs: {
      image: params.sourceImage || "input.png",
      upload: "image",
    },
  };
  result.injectedNodeIds.push(imageNodeId);

  // 2. Preprocessor node
  const preprocessorClass = resolvePreprocessorClass(params.preprocessor);
  const preprocessorNodeId = nid();
  result.workflow[preprocessorNodeId] = {
    class_type: preprocessorClass,
    inputs: {
      image: [imageNodeId, 0],
    },
  };
  if (preprocessorClass === "CannyEdgePreprocessor") {
    result.workflow[preprocessorNodeId].inputs.low_threshold = 100;
    result.workflow[preprocessorNodeId].inputs.high_threshold = 200;
    result.workflow[preprocessorNodeId].inputs.resolution = 1024;
  }
  result.injectedNodeIds.push(preprocessorNodeId);

  // 3. ControlNetLoader node
  const loaderNodeId = nid();
  result.workflow[loaderNodeId] = {
    class_type: "ControlNetLoader",
    inputs: {
      control_net_name: params.model || "control_v11p_sd15_canny.pth",
    },
  };
  result.injectedNodeIds.push(loaderNodeId);

  // 4. ControlNetApply node — insert into conditioning chain
  const applyNodeId = nid();
  const applyClass = "ControlNetApplyAdvanced";
  const applyInputs: Record<string, unknown> = {
    conditioning: [baseSlots.posTextId, 0], // positive conditioning
    control_net: [loaderNodeId, 0],
    image: [preprocessorNodeId, 0],
    strength: params.strength ?? 1.0,
  };

  // ControlNetApplyAdvanced supports start/end percent
  if (applyClass === "ControlNetApplyAdvanced") {
    if (params.startPercent !== undefined) {
      applyInputs.start_percent = params.startPercent;
    }
    if (params.endPercent !== undefined) {
      applyInputs.end_percent = params.endPercent;
    }
  }

  result.workflow[applyNodeId] = {
    class_type: applyClass,
    inputs: applyInputs,
  };
  result.injectedNodeIds.push(applyNodeId);

  // 5. Rewire KSampler's positive conditioning to come from ControlNetApply
  setNodeInput(
    result.workflow,
    baseSlots.ksamplerId,
    "positive",
    [applyNodeId, 0],
  );

  return result;
}

// Model-aware injectable adapter helpers

/**
 * Adapter type identifiers used for injection resolution.
 */
export type InjectableType = "lora" | "sref" | "controlnet" | "ipadapter";

/**
 * Resolve the AdapterConfig for a given injectable type + model family.
 * Falls back through the adapter pack registry, then to SDXL defaults.
 *
 * This is the primary bridge between the pack system and the injection system:
 *   - For LoRA: SDXL → LoraLoader (model+clip), Flux → LoraLoaderModelOnly (model-only)
 *   - For IPAdapter: SDXL → IPAdapterAdvanced, Flux → IPAdapterFull
 *   - For SREF: both → SREFStyleEncode + StyleApplyIPAdapter (first pass)
 *   - For ControlNet: both → ControlNetLoader + ControlNetApplyAdvanced
 */
export function resolveAdapter(
  type: InjectableType,
  modelFamily: string = "sdxl",
): AdapterConfig {
  const pack = resolveAdapterPack(modelFamily);
  const config = getAdapterConfig(pack, type);
  if (config) return config;

  const sdxl = getAdapterConfig(SDXL_DEFAULT_PACK, type);
  if (sdxl) return sdxl;

  // Ultra-fallback: invent a reasonable default per type
  const ULTRA_FALLBACKS: Record<InjectableType, AdapterConfig> = {
    lora: {
      type: "lora",
      loaderClass: "LoraLoader",
      applyClass: "LoraLoader",
      strengthParamName: "strength_model",
      modelParamName: "lora_name",
    },
    sref: {
      type: "sref",
      loaderClass: "SREFStyleEncode",
      applyClass: "StyleApplyIPAdapter",
      strengthParamName: "strength",
      modelParamName: "image_url",
    },
    controlnet: {
      type: "controlnet",
      loaderClass: "ControlNetLoader",
      applyClass: "ControlNetApplyAdvanced",
      preprocessorClass: "CannyEdgePreprocessor",
      strengthParamName: "strength",
      modelParamName: "control_net_name",
    },
    ipadapter: {
      type: "ipadapter",
      loaderClass: "IPAdapterModelLoader",
      applyClass: "IPAdapterAdvanced",
      strengthParamName: "weight",
      modelParamName: "ipadapter_file",
    },
  };
  return ULTRA_FALLBACKS[type];
}

/**
 * Check whether a given LoRA loader class is model-only (no CLIP output).
 * Used to decide whether to wire CLIP connections and set strength_clip.
 */
export function isLoraModelOnly(loaderClass: string): boolean {
  return loaderClass === "LoraLoaderModelOnly";
}

/**
 * Create a LoRA loader node that is model-family-aware.
 *
 * For SDXL/workflows with CLIP: creates LoraLoader with model+clip inputs.
 * For Flux/workflows without CLIP: creates LoraLoaderModelOnly with model-only input.
 *
 * Returns the node along with output info for chaining.
 */
export function createModelAwareLoraNode(
  loraName: string,
  modelSourceNodeId: string,
  clipSourceNodeId: string | null,
  strengthModel: number = 1.0,
  strengthClip: number = 1.0,
  modelFamily: string = "sdxl",
): {
  nodeId: string;
  node: WorkflowNode;
  outputs: { model: [string, number]; clip: [string, number] | null };
} {
  const adapter = resolveAdapter("lora", modelFamily);
  const loaderClass = adapter.loaderClass;
  const modelOnly = isLoraModelOnly(loaderClass);

  const nodeId = `__lora_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const inputs: Record<string, unknown> = {
    lora_name: loraName,
    strength_model: strengthModel,
  };

  inputs.model = [modelSourceNodeId, 0];

  if (!modelOnly) {
    // SDXL-style: LoraLoader needs both model and clip
    inputs.strength_clip = strengthClip;
    inputs.clip = [clipSourceNodeId ?? modelSourceNodeId, 1];
    return {
      nodeId,
      node: { class_type: loaderClass, inputs },
      outputs: {
        model: [nodeId, 0],
        clip: [nodeId, 1],
      },
    };
  } else {
    // Flux-style: LoraLoaderModelOnly only has model output
    return {
      nodeId,
      node: { class_type: loaderClass, inputs },
      outputs: {
        model: [nodeId, 0],
        clip: null, // No CLIP output for model-only LoRA
      },
    };
  }
}

/**
 * Resolve the IPAdapter apply class for a given model family.
 * Returns the appropriate class name for style application.
 *
 * SDXL → IPAdapterAdvanced
 * Flux  → IPAdapterFull (first-pass: still uses StyleApplyIPAdapter for SREF)
 * Fallback → IPAdapterAdvanced
 */
export function resolveIPAdapterApplyClass(modelFamily: string = "sdxl"): string {
  const adapter = resolveAdapter("ipadapter", modelFamily);
  return adapter.applyClass;
}

/**
 * Resolve the SREF apply class for a given model family.
 * SREF always uses StyleApplyIPAdapter; the resolution path allows
 * model-specific overrides.
 */
export function resolveSrefApplyClass(modelFamily: string = "sdxl"): string {
  const adapter = resolveAdapter("sref", modelFamily);
  return adapter.applyClass;
}

export default {
  SDXL_DEFAULT_PACK,
  FLUX_DEFAULT_PACK,
  SD15_DEFAULT_PACK,
  registerAdapterPack,
  getAdapterPack,
  getAllAdapterPacks,
  resolveAdapterPack,
  getAdapterConfig,
  resolvePreprocessorClass,
  applyControlNetParams,
  injectControlNet,
  CONTROLNET_PREPROCESSOR_MAP,
  resolveAdapter,
  isLoraModelOnly,
  createModelAwareLoraNode,
  resolveIPAdapterApplyClass,
  resolveSrefApplyClass,
};