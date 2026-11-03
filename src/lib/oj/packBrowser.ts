/**
 * Pack Browser — exposes workflow-pack metadata, required-model/node
 * validation, and dynamic control-surfaces for Adrift's UI.
 *
 * This module bridges the static pack manifests (pack.json files) with
 * runtime model availability so the UI can show status chips for
 * missing models / custom nodes.
 */
import type { WorkflowKind, Workflow, WorkflowCapabilities } from "@/types";
import {
  getAllPacks,
  getPack,
  type WorkflowPack,
  type AdapterConfig,
} from "@/lib/oj/packs";
import {
  discoverCapabilities,
  detectWorkflowType,
  type WorkflowType,
} from "@/lib/oj/discovery";
import {
  buildControlSchema,
  groupControls,
  type ControlSchema,
  type WorkflowControlSchemaResult,
} from "@/lib/oj/workflowControlSchema";

// Types

/** A workflow-kind entry inside a pack, enriched for the UI. */
export interface PackWorkflowEntry {
  kind: string;
  file: string;
  label: string;
}

/** A model or node requirement extracted from a pack's workflows. */
export interface PackRequirement {
  /** Human-readable name ("SDXL Base", "4x-UltraSharp", etc.) */
  name: string;
  /** Category: checkpoint, lora, vae, controlnet, upscale, custom_node */
  category:
    "checkpoint" | "lora" | "vae" | "controlnet" | "upscale" | "custom_node";
  /** The concrete filename/identifier expected */
  identifier: string;
  /** Node class_type that loads this resource */
  loaderClassType: string;
  /** Whether this requirement was found locally (null if we can't check) */
  status: "available" | "missing" | "unknown";
}

/** A single workflow control schema entry (re-exported from workflowControlSchema). */
export type {
  ControlSchema,
  WorkflowControlSchemaResult,
} from "@/lib/oj/workflowControlSchema";

/** Dynamic controls discovered from a workflow's structure. */
export interface PackDynamicControls {
  /** Capabilities detected in the workflow */
  capabilities: WorkflowCapabilities;
  /** Default parameters extracted from the workflow */
  defaults: {
    steps?: number;
    cfg?: number;
    sampler?: string;
    scheduler?: string;
    denoise?: number;
    width?: number;
    height?: number;
  };
  workflowType: WorkflowType | "unknown";
  samplerClass: string;
  nodeCount: number;
  /** Number of distinct node class_types */
  nodeTypeCount: number;
  /** Full control schema for every discoverable input (visible-only by default). */
  controlSchema: ControlSchema[];
  /** Controls grouped by UI section for easier rendering. */
  controlGroups: Record<string, ControlSchema[]>;
  /** Counts of controls by kind. */
  controlCountsByKind: Record<string, number>;
}

/** A single pack enriched for browser card display. */
export interface PackBrowserEntry {
  pack: WorkflowPack;
  workflows: PackWorkflowEntry[];
  requirements: PackRequirement[];
  workflowCount: number;
}

// Kind-label mapping

const KIND_LABELS: Record<string, string> = {
  t2i: "Text → Image",
  i2i: "Image → Image",
  vary_subtle: "Vary (Subtle)",
  vary_strong: "Vary (Strong)",
  upscale_subtle: "Upscale (Subtle)",
  upscale_creative: "Upscale (Creative)",
  inpaint: "Inpaint",
  outpaint: "Outpaint",
  remix_subtle: "Remix (Subtle)",
  remix_strong: "Remix (Strong)",
  t2v: "Text → Video",
  i2v: "Image → Video",
  t23d: "Text → 3D",
  i23d: "Image → 3D",
  t2a: "Text → Audio",
  controlnet: "ControlNet",
  detail: "Detail (Edit LoRA)",
  upscale_detail: "Upscale + Detail",
  adetailer: "ADetailer",
  adetailer_auto: "Auto Refine",
  realism_lite: "Realism (Lite)",
  realism_pro: "Realism (Pro+)",
  edit_instruct_dual: "Edit (2 images)",
  character_swap: "Replace person in video",
  character_swap_masked: "Replace person in video (mannequin)",
  cast_swap: "Recast several people",
  video_bg_swap: "Swap video background",
  video_object_add: "Add object to video",
  wan_animate: "Animate character",
  lipsync: "Lipsync / talking photo",
  video_lipsync: "Lipsync onto video",
  talking_avatar: "Talking avatar",
  face_swap: "Swap face in video",
  orbit_360: "360 orbit video",
  camera_move: "Camera move video",
  wan_motion: "Motion presets video",
  wan_camera: "Camera control video",
  wan_move: "Trajectory motion video",
};

export function getKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

// Pack workflow entries

export function getPackWorkflowEntries(
  pack: WorkflowPack,
): PackWorkflowEntry[] {
  return Object.entries(pack.workflows).map(([kind, file]) => ({
    kind,
    file: file as string,
    label: getKindLabel(kind),
  }));
}

// Requirement extraction from workflow nodes

const CHECKPOINT_CLASS_TYPES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "unCLIPCheckpointLoader",
]);

const UNET_CLASS_TYPES = new Set([
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
]);

const LORA_CLASS_TYPES = new Set(["LoraLoader", "LoraLoaderModelOnly"]);

const VAE_CLASS_TYPES = new Set(["VAELoader"]);

const CONTROLNET_CLASS_TYPES = new Set([
  "ControlNetLoader",
  "ControlNetLoadFromDiffusers",
]);

const UPSCALE_CLASS_TYPES = new Set([
  "UpscaleModelLoader",
  "LoadUpscaleModel",
  "ImageUpscaleWithModel",
]);

const IPADAPTER_CLASS_TYPES = new Set([
  "IPAdapterModelLoader",
  "IPAdapterLoad",
]);

/**
 * Extract known model/node requirements from a workflow object.
 * Returns a list of requirements with status = "unknown" (runtime fills availability).
 */
export function extractRequirementsFromWorkflow(
  workflow: Workflow,
): PackRequirement[] {
  const reqs: PackRequirement[] = [];

  for (const node of Object.values(workflow)) {
    const ct = node.class_type;
    const inputs = node.inputs ?? {};

    if (CHECKPOINT_CLASS_TYPES.has(ct)) {
      const ckpt = inputs.ckpt_name ?? inputs.model_name;
      if (typeof ckpt === "string") {
        reqs.push({
          name: ckpt,
          category: "checkpoint",
          identifier: ckpt,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (UNET_CLASS_TYPES.has(ct)) {
      const unet = inputs.unet_name ?? inputs.model_name;
      if (typeof unet === "string") {
        reqs.push({
          name: unet,
          category: "checkpoint",
          identifier: unet,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (LORA_CLASS_TYPES.has(ct)) {
      const lora = inputs.lora_name;
      if (typeof lora === "string") {
        reqs.push({
          name: lora,
          category: "lora",
          identifier: lora,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (VAE_CLASS_TYPES.has(ct)) {
      const vae = inputs.vae_name;
      if (typeof vae === "string") {
        reqs.push({
          name: vae,
          category: "vae",
          identifier: vae,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (CONTROLNET_CLASS_TYPES.has(ct)) {
      const cn = inputs.control_net_name;
      if (typeof cn === "string") {
        reqs.push({
          name: cn,
          category: "controlnet",
          identifier: cn,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (UPSCALE_CLASS_TYPES.has(ct)) {
      const model = inputs.model_name ?? inputs.ckpt_name;
      if (typeof model === "string") {
        reqs.push({
          name: model,
          category: "upscale",
          identifier: model,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }

    if (IPADAPTER_CLASS_TYPES.has(ct)) {
      const ipa = inputs.ipadapter_file ?? inputs.model_name;
      if (typeof ipa === "string") {
        reqs.push({
          name: ipa,
          category: "lora", // IP-Adapters are model files like LoRAs
          identifier: ipa,
          loaderClassType: ct,
          status: "unknown",
        });
      }
    }
  }

  return reqs;
}

/**
 * Check a model identifier against a list of locally available filenames.
 * Returns "available" if found, "missing" if not, "unknown" if list is null.
 *
 * Matching strategy:
 *   1. Exact basename match (case-insensitive) — the identifier matches the
 *      filename portion after the last "/" or "\\".
 *   2. Substring match (case-insensitive) — falls back to the looser heuristic
 *      when the basename doesn't match, because some identifiers are partial
 *      (e.g. "sdxl_base" should still match "sdxl_base_1.0.safetensors").
 */
export function checkModelAvailability(
  identifier: string,
  availableFiles: string[] | null,
): "available" | "missing" | "unknown" {
  if (!availableFiles) return "unknown";
  const lower = identifier.toLowerCase();

  // 1. Try exact basename match first (most precise)
  const foundExact = availableFiles.some((f) => {
    const basename = f.split(/[/\\]/).pop()?.toLowerCase() ?? f.toLowerCase();
    return (
      basename === lower ||
      basename.replace(/\.[^.]+$/, "") === lower.replace(/\.[^.]+$/, "")
    );
  });
  if (foundExact) return "available";

  // 2. Fall back to substring match (catches partial identifiers)
  return availableFiles.some((f) => f.toLowerCase().includes(lower))
    ? "available"
    : "missing";
}

/**
 * Validate requirements against available local models.
 * Updates each requirement's status based on what we find locally.
 *
 * NOTE: controlnet and upscale categories currently fall back to the lora
 * file list because the model store does not yet expose separate lists for
 * those model types. When the store is extended, pass `controlnets` and
 * `upscales` to get accurate per-category checks instead of false positives.
 */
export function validateRequirements(
  requirements: PackRequirement[],
  available: {
    checkpoints?: string[];
    loras?: string[];
    vaes?: string[];
    controlnets?: string[];
    upscales?: string[];
  } | null,
): PackRequirement[] {
  if (!available) {
    return requirements.map((r) => ({ ...r, status: "unknown" as const }));
  }

  const categoryToFiles: Record<string, string[] | null> = {
    checkpoint: available.checkpoints ?? null,
    lora: available.loras ?? null,
    vae: available.vaes ?? null,
    controlnet: available.controlnets ?? available.loras ?? null,
    upscale: available.upscales ?? available.loras ?? null,
    custom_node: null, // can't validate without custom-node registry
  };

  return requirements.map((req) => {
    const files = categoryToFiles[req.category];
    return {
      ...req,
      status: checkModelAvailability(req.identifier, files),
    };
  });
}

// Custom-node detection (from workflow class_types)

/**
 * Known node class_types that ship with ComfyUI core.
 * Anything NOT in this set is treated as a custom node requirement.
 */
const CORE_CLASS_TYPES = new Set([
  // Samplers
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "KSamplerSelect",
  "FluxSampler",
  // Loaders
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "unCLIPCheckpointLoader",
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "VAELoader",
  "VAEDecode",
  "VAEEncode",
  "VAEEncodeForInpaint",
  "CLIPLoader",
  "CLIPLoaderSDXL",
  "CLIPLoaderFlux",
  "DualCLIPLoader",
  "CLIPTextEncode",
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeSDXLRefiner",
  "CLIPTextEncodeFlux",
  "BNK_CLIPTextEncodeAdvanced",
  "ConditioningCombine",
  // Latent
  "EmptyLatentImage",
  "EmptySDXLLatentImage",
  "EmptyLatentImageFlux",
  "EmptySD3LatentImage",
  // Image
  "SaveImage",
  "PreviewImage",
  "LoadImage",
  "LoadImageMask",
  "LoadImageFromUrl",
  "ImageScale",
  "ImageScaleBy",
  "ImageInvert",
  "ImageBatch",
  "ImageConcat",
  "ImagePadForOutpaint",
  // Conditioning
  "ConditioningSetArea",
  "ConditioningSetAreaPercentage",
  "ConditioningSetAreaStrength",
  // ControlNet
  "ControlNetLoader",
  "ControlNetLoadFromDiffusers",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  "SetUnionControlNetType",
  // Mask
  "ImageCompositeMasked",
  // Upscale
  "UpscaleModelLoader",
  "LoadUpscaleModel",
  "ImageUpscaleWithModel",
  // Math / Primitive
  "PrimitiveNode",
  // Model manipulation
  "ModelSamplingAuraFlow",
  // Note / Display
  "Note",
  "MarkdownNote",
  // Reroute
  "Reroute",
  // Video
  "VHS_VideoCombine",
  // 3D
  "SaveGLB",
  "TripoSRSampler",
]);

/**
 * Identify custom-node requirements from a workflow.
 * Returns a list of unique non-core class_types with "unknown" status.
 */
export function extractCustomNodeRequirements(
  workflow: Workflow,
): PackRequirement[] {
  const customTypes = new Set<string>();
  for (const node of Object.values(workflow)) {
    if (!CORE_CLASS_TYPES.has(node.class_type)) {
      customTypes.add(node.class_type);
    }
  }

  return Array.from(customTypes).map((ct) => ({
    name: ct,
    category: "custom_node" as const,
    identifier: ct,
    loaderClassType: ct,
    status: "unknown" as const,
  }));
}

// Dynamic controls discovery

const KSAMPLER_DETECT_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "KSamplerSelect",
  "FluxSampler",
]);

/**
 * Analyze a workflow to extract its dynamic control surface:
 * capabilities, default params, type, node stats.
 */
export function discoverDynamicControls(
  workflow: Workflow,
): PackDynamicControls {
  const workflowType = detectWorkflowType(workflow);

  const capabilities = discoverCapabilities(workflow);

  // Extract defaults from sampler and latent nodes
  const defaults: PackDynamicControls["defaults"] = {};
  for (const node of Object.values(workflow)) {
    const inputs = node.inputs ?? {};
    if (typeof inputs.steps === "number")
      defaults.steps = inputs.steps as number;
    if (typeof inputs.cfg === "number") defaults.cfg = inputs.cfg as number;
    if (typeof inputs.sampler_name === "string")
      defaults.sampler = inputs.sampler_name as string;
    if (typeof inputs.scheduler === "string")
      defaults.scheduler = inputs.scheduler as string;
    if (typeof inputs.denoise === "number")
      defaults.denoise = inputs.denoise as number;
    if (typeof inputs.width === "number")
      defaults.width = inputs.width as number;
    if (typeof inputs.height === "number")
      defaults.height = inputs.height as number;
  }

  let samplerClass = "";
  for (const node of Object.values(workflow)) {
    if (KSAMPLER_DETECT_CLASSES.has(node.class_type)) {
      samplerClass = node.class_type;
      break;
    }
  }

  const nodeArray = Object.values(workflow);
  const classTypes = new Set(nodeArray.map((n) => n.class_type));

  // Build full control schema for the workflow (visible controls only by default)
  const schemaResult = buildControlSchema(workflow);
  const controlSchema = schemaResult.controls.filter((c) => c.visible);
  const controlGroups = groupControls(controlSchema);
  const controlCountsByKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(schemaResult.countsByKind)) {
    controlCountsByKind[kind] = count;
  }

  return {
    capabilities,
    defaults,
    workflowType: workflowType ?? "unknown",
    samplerClass,
    nodeCount: nodeArray.length,
    nodeTypeCount: classTypes.size,
    controlSchema,
    controlGroups,
    controlCountsByKind,
  };
}

// Pack browser entry assembly

/**
 * Build all pack browser entries from registered packs.
 * Requirements are left empty here and filled on-demand when workflows
 * are loaded (see PackBrowser component's handleExpandWorkflow).
 */
export function buildPackBrowserEntries(): PackBrowserEntry[] {
  const packs = getAllPacks();

  return packs.map((pack) => {
    const workflows = getPackWorkflowEntries(pack);

    return {
      pack,
      workflows,
      requirements: [], // filled on-demand when workflows are loaded
      workflowCount: Object.keys(pack.workflows).length,
    };
  });
}

/**
 * Validate a single pack's requirements against available local models.
 * This is used by the API route to fill in status for browser cards.
 */
export function validatePackRequirements(
  packId: string,
  workflowRequirements: PackRequirement[],
  customNodeRequirements: PackRequirement[],
  available: {
    checkpoints?: string[];
    loras?: string[];
    vaes?: string[];
  } | null,
): { requirements: PackRequirement[]; customNodes: PackRequirement[] } {
  return {
    requirements: validateRequirements(workflowRequirements, available),
    customNodes: customNodeRequirements, // custom nodes can't be validated locally easily
  };
}

// Pack summary — compact "card" view for the UI

export interface PackCardSummary {
  id: string;
  name: string;
  description: string;
  modelFamily: string;
  isDefault: boolean;
  baseResolution: number;
  adapterHighlights: string[];
  workflowKinds: { kind: string; label: string }[];
  workflowCount: number;
  supportsNegativePrompt: boolean;
  supportsCfgScale: boolean;
}

export function getPackCardSummary(pack: WorkflowPack): PackCardSummary {
  const workflowKinds = Object.keys(pack.workflows).map((kind) => ({
    kind,
    label: getKindLabel(kind),
  }));

  // Highlight key adapter differences
  const adapterHighlights: string[] = [];
  if (pack.adapterConfig.samplerClass !== "KSampler") {
    adapterHighlights.push(`${pack.adapterConfig.samplerClass}`);
  }
  if (pack.adapterConfig.loraLoaderClass !== "LoraLoader") {
    adapterHighlights.push(`LoRA: ${pack.adapterConfig.loraLoaderClass}`);
  }
  if (
    pack.adapterConfig.latentClass !== "EmptyLatentImage" &&
    pack.adapterConfig.latentClass !== "EmptySDXLLatentImage"
  ) {
    adapterHighlights.push(`Latent: ${pack.adapterConfig.latentClass}`);
  }
  if (!pack.adapterConfig.supportsNegativePrompt) {
    adapterHighlights.push("No negative prompt");
  }

  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    modelFamily: pack.modelFamily,
    isDefault: pack.isDefault,
    baseResolution: pack.baseResolution,
    adapterHighlights,
    workflowKinds,
    workflowCount: Object.keys(pack.workflows).length,
    supportsNegativePrompt: pack.adapterConfig.supportsNegativePrompt,
    supportsCfgScale: pack.adapterConfig.supportsCfgScale,
  };
}

export function getAllPackCardSummaries(): PackCardSummary[] {
  return getAllPacks().map(getPackCardSummary);
}
