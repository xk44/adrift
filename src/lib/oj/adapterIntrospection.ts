/**
 * Adapter Introspection
 * Combines adapter pack registry + workflow discovery to produce UI-ready
 * metadata about which adapters are available, which are already in the
 * workflow, and which could be injected.
 *
 * This is the foundation for dynamic control-surface rendering:
 *   - UI can query getAdapterReport() to know which adapter sections to show
 *   - Each adapter comes with human-readable labels, descriptions, and
 *     constraint metadata (requires image, supports stacking, etc.)
 *   - The report distinguishes "present in workflow" vs "injectable" vs
 *     "unavailable" for each adapter type per model family
 */

import type {
  AdapterConfig,
  AdapterPack,
  Workflow,
  WorkflowCapabilities,
} from "@/types";
import {
  resolveAdapterPack,
  resolveAdapter,
  getAdapterConfig,
  getAllAdapterPacks,
  InjectableType,
} from "./adapters";
import { discoverCapabilities } from "./discovery";

// Types

/**
 * Status of an adapter type within a specific workflow context.
 *   - "present"  : Adapter nodes already exist in the workflow
 *   - "injectable": No adapter nodes exist, but the adapter pack defines how to inject
 *   - "unavailable": Neither present nor injectable (no pack support)
 */
export type AdapterAvailability = "present" | "injectable" | "unavailable";

/**
 * A single adapter's introspection result — everything the UI needs
 * to decide whether to show a control surface, what labels to display,
 * and what constraints apply.
 */
export interface AdapterCapabilityReport {
  type: InjectableType;
  /** Whether this adapter is present, injectable, or unavailable */
  availability: AdapterAvailability;
  /** Human-readable label from the pack config */
  label: string;
  /** Human-readable description from the pack config */
  description: string;
  /** ComfyUI loader class name for this adapter */
  loaderClass: string;
  /** ComfyUI apply class name for this adapter */
  applyClass: string;
  /** Strength parameter name on the apply node */
  strengthParamName: string;
  /** Model parameter name on the loader node */
  modelParamName: string;
  /** Whether this adapter has a separate loader node (vs self-contained) */
  hasSeparateLoader: boolean;
  /** Whether the adapter produces a model output for chaining */
  hasModelOutput: boolean;
  /** Whether the adapter requires a CLIP connection */
  requiresClip: boolean;
  /** Whether the adapter requires an image input */
  requiresImage: boolean;
  /** Default strength for UI sliders */
  defaultStrength: number;
  minStrength: number;
  maxStrength: number;
  /** Whether multiple instances can be stacked */
  supportsStacking: boolean;
  /** Preprocessor class (ControlNet only) */
  preprocessorClass?: string;
  /** Model family this adapter is resolved for */
  modelFamily: string;
  /** Pack ID that provided this adapter */
  packId: string;
}

/**
 * Full introspection report for a workflow + model family combination.
 * Combines workflow-level discovery with pack-level adapter configs.
 */
export interface AdapterReport {
  /** The model family used for resolution */
  modelFamily: string;
  /** The resolved adapter pack */
  packId: string;
  /** Per-adapter-type capability reports */
  adapters: Record<InjectableType, AdapterCapabilityReport>;
  /** Workflow-level capabilities (what already exists in the graph) */
  workflowCapabilities: WorkflowCapabilities;
}

// Introspection functions

/**
 * Build a per-adapter capability report by combining the resolved adapter
 * pack (for node-class and constraint info) with workflow discovery
 * (for present/unavailable status).
 *
 * This is the primary entry point for UI components that need to decide
 * what control surfaces to render.
 */
export function getAdapterReport(
  workflow: Workflow,
  modelFamily: string = "sdxl",
): AdapterReport {
  const pack = resolveAdapterPack(modelFamily);
  const capabilities = discoverCapabilities(workflow);

  const adapters = {} as Record<InjectableType, AdapterCapabilityReport>;

  const types: InjectableType[] = ["lora", "sref", "controlnet", "ipadapter"];

  for (const type of types) {
    const config = resolveAdapter(type, modelFamily);
    const isPresent = isAdapterPresentInWorkflow(workflow, type, config);

    let availability: AdapterAvailability;
    if (isPresent) {
      availability = "present";
    } else {
      // Adapter pack provides a config for this type → injectable
      availability = "injectable";
    }

    adapters[type] = buildCapabilityReport(config, pack, modelFamily, availability);
  }

  return {
    modelFamily,
    packId: pack.id,
    adapters,
    workflowCapabilities: capabilities,
  };
}

/**
 * Get capability reports only for adapters that are currently present
 * in the workflow. Useful for showing "active adapters" in the UI.
 */
export function getPresentAdapters(
  workflow: Workflow,
  modelFamily: string = "sdxl",
): AdapterCapabilityReport[] {
  const report = getAdapterReport(workflow, modelFamily);
  return Object.values(report.adapters).filter(
    (a) => a.availability === "present",
  );
}

/**
 * Get capability reports only for adapters that can be injected
 * (not yet present). Useful for showing "add adapter" options in the UI.
 */
export function getInjectableAdapters(
  workflow: Workflow,
  modelFamily: string = "sdxl",
): AdapterCapabilityReport[] {
  const report = getAdapterReport(workflow, modelFamily);
  return Object.values(report.adapters).filter(
    (a) => a.availability === "injectable",
  );
}

/**
 * Get a simplified availability map for quick checks.
 * Returns a record mapping each adapter type to its availability.
 */
export function getAdapterAvailability(
  workflow: Workflow,
  modelFamily: string = "sdxl",
): Record<InjectableType, AdapterAvailability> {
  const report = getAdapterReport(workflow, modelFamily);
  const result = {} as Record<InjectableType, AdapterAvailability>;
  for (const type of Object.keys(report.adapters) as InjectableType[]) {
    result[type] = report.adapters[type].availability;
  }
  return result;
}

/**
 * Resolve the adapter packs that are available for a given model family
 * (including any registered custom packs).
 */
export function getAvailablePacks(modelFamily?: string): AdapterPack[] {
  const allPacks = getAllAdapterPacks();
  if (!modelFamily) return allPacks;
  return allPacks.filter(
    (p) => p.modelFamily === modelFamily || modelFamily.includes(p.modelFamily),
  );
}

/**
 * Check whether a workflow supports a specific adapter type,
 * either because it already has relevant nodes or because the pack
 * defines an injection path.
 */
export function isAdapterTypeAvailable(
  workflow: Workflow,
  type: InjectableType,
  modelFamily: string = "sdxl",
): boolean {
  const report = getAdapterReport(workflow, modelFamily);
  return report.adapters[type].availability !== "unavailable";
}

/**
 * Get the label for an adapter type resolved for a specific model family.
 * Falls back to the type name itself if the pack doesn't provide a label.
 */
export function getAdapterLabel(
  type: InjectableType,
  modelFamily: string = "sdxl",
): string {
  const config = resolveAdapter(type, modelFamily);
  return config.label ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export function getAdapterDescription(
  type: InjectableType,
  modelFamily: string = "sdxl",
): string {
  const config = resolveAdapter(type, modelFamily);
  return config.description ?? "";
}

// Internal helpers

/**
 * Check if an adapter type is already present in the workflow.
 * Uses class_type matching based on the adapter config.
 */
function isAdapterPresentInWorkflow(
  workflow: Workflow,
  type: InjectableType,
  config: AdapterConfig,
): boolean {
  const classTypes = new Set<string>();
  for (const val of Object.values(workflow)) {
    const node = val as { class_type?: string } | null | undefined;
    if (node && node.class_type) {
      classTypes.add(node.class_type);
    }
  }

  switch (type) {
    case "lora":
      return classTypes.has("LoraLoader") || classTypes.has("LoraLoaderModelOnly");
    case "sref":
      return classTypes.has("SREFStyleEncode") || classTypes.has("StyleApplyIPAdapter");
    case "controlnet":
      return (
        classTypes.has("ControlNetLoader") ||
        classTypes.has("ControlNetLoadFromDiffusers") ||
        classTypes.has("ControlNetApply") ||
        classTypes.has("ControlNetApplyAdvanced")
      );
    case "ipadapter": {
      const ipClasses = [
        "IPAdapterAdvanced",
        "IPAdapter",
        "IPAdapterXXL",
        "IPAdapterPlus",
        "IPAdapterFull",
        "IPAdapterStyle",
        "IPAdapterPrompt",
        "IPAdapterModelLoader",
      ];
      return ipClasses.some((cls) => classTypes.has(cls));
    }
    default:
      return false;
  }
}

function buildCapabilityReport(
  config: AdapterConfig,
  pack: AdapterPack,
  modelFamily: string,
  availability: AdapterAvailability,
): AdapterCapabilityReport {
  return {
    type: config.type,
    availability,
    label: config.label ?? config.type.charAt(0).toUpperCase() + config.type.slice(1),
    description: config.description ?? "",
    loaderClass: config.loaderClass,
    applyClass: config.applyClass,
    strengthParamName: config.strengthParamName,
    modelParamName: config.modelParamName,
    hasSeparateLoader: config.hasSeparateLoader ?? (config.loaderClass !== config.applyClass),
    hasModelOutput: config.hasModelOutput ?? false,
    requiresClip: config.requiresClip ?? false,
    requiresImage: config.requiresImage ?? false,
    defaultStrength: config.defaultStrength ?? 1.0,
    minStrength: config.minStrength ?? 0,
    maxStrength: config.maxStrength ?? 2.0,
    supportsStacking: config.supportsStacking ?? true,
    preprocessorClass: config.preprocessorClass,
    modelFamily,
    packId: pack.id,
  };
}