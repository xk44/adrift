/**
 * Parse and normalize prompt-bar parameters for SREF, IPAdapter, and ControlNet
 * into model-family-aware structures ready for injection.
 *
 * Handles:
 *   - SREF parameters: --sref <url>, --sw <weight>
 *   - IPAdapter parameters: --ip <url>, --ip-weight <weight>
 *   - ControlNet parameters: --controlnet <type>, --cn-strength, --cn-image, --cn-start, --cn-end
 *   - Normalization across model families (e.g. weight vs strength naming)
 */

import type { AdapterConfig } from "@/types";
import { resolveAdapter, CONTROLNET_PREPROCESSOR_MAP } from "./adapters";

export interface NormalizedSrefParams {
  /** Image URL or path for style reference */
  imageUrl: string;
  /** Strength/weight for the style application (0-2) */
  weight: number;
  /** The resolved apply class (model-family-aware) */
  applyClass: string;
  /** The resolved strength parameter name for the apply class */
  strengthParamName: string;
  /** Whether the injection needs an image input */
  requiresImage: boolean;
}

export interface NormalizedIPAdapterParams {
  /** Image URL or path for the IPAdapter reference */
  imageUrl: string;
  /** Weight for the IPAdapter application (0-2) */
  weight: number;
  /** The resolved apply class (IPAdapterAdvanced, IPAdapterFull, etc.) */
  applyClass: string;
  /** The resolved strength/weight parameter name */
  strengthParamName: string;
  modelParamName: string;
  /** The loader class (IPAdapterModelLoader, etc.) */
  loaderClass: string;
  /** Whether the injection needs an image input */
  requiresImage: boolean;
  /** Whether multiple IPAdapter instances can stack */
  supportsStacking: boolean;
}

/**
 * Normalized ControlNet parameters ready for injection.
 * Extends the base ControlNetParams with model-family awareness.
 */
export interface NormalizedControlNetParams {
  /** ControlNet model name or shorthand */
  model: string;
  /** Preprocessor type resolved to a full class name */
  preprocessorClass: string;
  /** Shorthand name for display (derived from preprocessor shorthand) */
  preprocessorShorthand: string;
  /** Strength 0-2 */
  strength: number;
  sourceImage?: string;
  /** Start percentile */
  startPercent?: number;
  /** End percentile */
  endPercent?: number;
  /** Whether startPercent/endPercent are supported by this apply class */
  supportsPercentRange: boolean;
  /** The resolved apply class (ControlNetApplyAdvanced, ControlNetApply, etc.) */
  applyClass: string;
  /** The resolved strength parameter name */
  strengthParamName: string;
  /** Conditioning target: positive or negative */
  conditioningTarget: "positive" | "negative";
  /** Whether this CN variant supports stacking */
  supportsStacking: boolean;
}

/**
 * Normalize SREF parameters for a given model family.
 * Takes raw prompt-bar inputs and resolves them against the adapter pack.
 */
export function normalizeSrefParams(
  imageUrl: string,
  weight: number,
  modelFamily: string = "sdxl",
): NormalizedSrefParams {
  const adapter = resolveAdapter("sref", modelFamily);

  return {
    imageUrl,
    weight: clampStrength(weight, adapter),
    applyClass: adapter.applyClass,
    strengthParamName: adapter.strengthParamName,
    requiresImage: adapter.requiresImage ?? true,
  };
}

/**
 * Normalize IPAdapter parameters for a given model family.
 * Takes raw prompt-bar inputs and resolves them against the adapter pack.
 */
export function normalizeIPAdapterParams(
  imageUrl: string,
  weight: number,
  modelFamily: string = "sdxl",
): NormalizedIPAdapterParams {
  const adapter = resolveAdapter("ipadapter", modelFamily);

  return {
    imageUrl,
    weight: clampStrength(weight, adapter),
    applyClass: adapter.applyClass,
    strengthParamName: adapter.strengthParamName,
    modelParamName: adapter.modelParamName,
    loaderClass: adapter.loaderClass,
    requiresImage: adapter.requiresImage ?? true,
    supportsStacking: adapter.supportsStacking ?? true,
  };
}

/**
 * Reverse-lookup: given a full preprocessor class name, find the shorthand.
 */
export function preprocessorClassToShorthand(className: string): string {
  for (const [shorthand, full] of Object.entries(CONTROLNET_PREPROCESSOR_MAP)) {
    if (full === className) return shorthand;
  }
  return className;
}

/**
 * Normalize ControlNet parameters for a given model family.
 * Resolves preprocessor shorthand to full class names, determines whether
 * start/end percent is supported, and picks the right apply class.
 */
export function normalizeControlNetParams(
  model: string,
  preprocessor: string,
  strength: number,
  options?: {
    sourceImage?: string;
    startPercent?: number;
    endPercent?: number;
    conditioningTarget?: "positive" | "negative";
  },
  modelFamily: string = "sdxl",
): NormalizedControlNetParams {
  const adapter = resolveAdapter("controlnet", modelFamily);
  const preprocessorClass = resolvePreprocessorFull(preprocessor);
  const applyClass = adapter.applyClass;

  // ControlNetApplyAdvanced supports start/end percent, ControlNetApply does not
  const supportsPercentRange = applyClass === "ControlNetApplyAdvanced";

  return {
    model,
    preprocessorClass,
    preprocessorShorthand: preprocessor,
    strength: clampStrength(strength, adapter),
    sourceImage: options?.sourceImage,
    startPercent: options?.startPercent,
    endPercent: options?.endPercent,
    supportsPercentRange,
    applyClass,
    strengthParamName: adapter.strengthParamName,
    conditioningTarget: options?.conditioningTarget ?? "positive",
    supportsStacking: adapter.supportsStacking ?? true,
  };
}

/**
 * Normalize all adapter parameters at once for a given model family.
 * Takes the raw params map (as parsed from the prompt bar) and produces
 * normalized, model-family-aware structures for each adapter type.
 */
export interface RawAdapterParams {
  sref?: { imageUrl: string; weight: number };
  ipadapter?: { imageUrl: string; weight: number };
  controlnet?: {
    model: string;
    preprocessor: string;
    strength: number;
    sourceImage?: string;
    startPercent?: number;
    endPercent?: number;
  };
}

export interface NormalizedAdapterParams {
  sref?: NormalizedSrefParams;
  ipadapter?: NormalizedIPAdapterParams;
  controlnet?: NormalizedControlNetParams;
}

export function normalizeAllAdapterParams(
  params: RawAdapterParams,
  modelFamily: string = "sdxl",
): NormalizedAdapterParams {
  const result: NormalizedAdapterParams = {};

  if (params.sref) {
    result.sref = normalizeSrefParams(
      params.sref.imageUrl,
      params.sref.weight,
      modelFamily,
    );
  }

  if (params.ipadapter) {
    result.ipadapter = normalizeIPAdapterParams(
      params.ipadapter.imageUrl,
      params.ipadapter.weight,
      modelFamily,
    );
  }

  if (params.controlnet) {
    result.controlnet = normalizeControlNetParams(
      params.controlnet.model,
      params.controlnet.preprocessor,
      params.controlnet.strength,
      {
        sourceImage: params.controlnet.sourceImage,
        startPercent: params.controlnet.startPercent,
        endPercent: params.controlnet.endPercent,
      },
      modelFamily,
    );
  }

  return result;
}

/**
 * Clamp a strength/weight value to the adapter's allowed range.
 */
function clampStrength(value: number, adapter: AdapterConfig): number {
  const min = adapter.minStrength ?? 0;
  const max = adapter.maxStrength ?? 2.0;
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve a preprocessor shorthand to a full class name.
 */
function resolvePreprocessorFull(shorthand: string): string {
  // Re-export logic from adapters — direct use avoids circular deps
  return CONTROLNET_PREPROCESSOR_MAP[shorthand.toLowerCase()] ?? shorthand;
}