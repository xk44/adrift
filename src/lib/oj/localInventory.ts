/**
 * Local Inventory — API-side helpers for constructing the file-inventory
 * payload from ComfyUI's object_info response and for building the
 * combined LocalInventory objects used by workflow control pickers.
 *
 * This module is a pure-function helper layer; it has no React or Zustand
 * imports and is safe to call from API routes, stores, and tests alike.
 */

import { comboOptions } from "@/lib/comfy/validatePrompt";
import type {
  EnumOptionsInventory,
  FileInventory,
  FileInventoryKey,
  LocalInventory,
  ModelInventory,
} from "./workflowControlSchema";

// API-side extraction — input file lists from object_info

/**
 * Shape of the ComfyUI object_info response (subset we care about).
 * Each node type maps to an object with an optional `input.required`
 * dict whose values are `[allowedValues | type, options]` tuples.
 */
export interface ObjectInfoResponse {
  [nodeType: string]: {
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
  };
}

/**
 * Extract a list of allowed values for a node input from object_info.
 * ComfyUI encodes enum-like inputs as `[string[] | string, ...options]`.
 */
export function extractInputList(
  data: ObjectInfoResponse,
  nodeType: string,
  inputName: string,
): string[] {
  const inputs = data[nodeType]?.input;
  const spec = inputs?.required?.[inputName] ?? inputs?.optional?.[inputName];
  return comboStrings(spec);
}

/**
 * String options of one input spec. Handles the legacy `[[...options]]`
 * form and ComfyUI 0.4x `["COMBO", { options }]` (via validatePrompt's
 * comboOptions, so inventory and prompt validation agree).
 */
export function comboStrings(spec: unknown): string[] {
  if (!Array.isArray(spec)) return [];
  const values = comboOptions(spec);
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * Try the given (nodeType, inputName) pairs in order and return
 * the first list that has entries, or [] if none yield results.
 */
export function extractFirstInputList(
  data: ObjectInfoResponse,
  candidates: Array<[nodeType: string, inputName: string]>,
): string[] {
  for (const [nodeType, inputName] of candidates) {
    const values = extractInputList(data, nodeType, inputName);
    if (values.length > 0) return values;
  }
  return [];
}

// Input-file inventory extraction from ComfyUI object_info

/**
 * Well-known ComfyUI node inputs that enumerate input files.
 * ComfyUI populates these from the `input/` directory at runtime,
 * so they are the cheapest source of truth for available images,
 * videos, and audio.
 */
export const INPUT_FILE_EXTRACTORS: Record<FileInventoryKey, Array<[nodeType: string, inputName: string]>> = {
  input_images: [
    ["LoadImage", "image"],
    ["LoadImageMask", "image"],
  ],
  input_videos: [
    ["VHS_LoadVideo", "video"],
    ["VHS_LoadVideoPath", "video"],
  ],
  input_audios: [
    ["VHS_LoadAudio", "audio"],
    ["VHS_LoadAudioPath", "audio"],
  ],
};

/**
 * Build a FileInventory from a ComfyUI object_info response by
 * extracting input file lists from well-known node inputs.
 */
export function extractFileInventory(data: ObjectInfoResponse): FileInventory {
  const result: FileInventory = {};

  for (const [key, candidates] of Object.entries(INPUT_FILE_EXTRACTORS) as Array<[FileInventoryKey, Array<[string, string]>]>) {
    const files = extractFirstInputList(data, candidates);
    if (files.length > 0) {
      result[key] = files;
    }
  }

  return result;
}

/**
 * Extract every enum-like allowed-value list from ComfyUI object_info.
 * The result lets workflow controls use live custom-node enum options instead
 * of relying only on static known enums.
 */
export function extractEnumOptionsInventory(data: ObjectInfoResponse): EnumOptionsInventory {
  const result: EnumOptionsInventory = {};

  for (const [nodeType, nodeInfo] of Object.entries(data)) {
    const buckets = [nodeInfo.input?.required, nodeInfo.input?.optional];
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const [inputName, spec] of Object.entries(bucket)) {
        const options = comboStrings(spec);
        if (options.length === 0) continue;
        result[nodeType] = result[nodeType] ?? {};
        result[nodeType][inputName] = options;
      }
    }
  }

  return result;
}

// Store-side — combine model + file inventory

/**
 * Build a LocalInventory by merging a ModelInventory with an optional
 * FileInventory. This is the shape consumed by workflow control pickers.
 */
export function buildLocalInventory(
  models: ModelInventory,
  files?: FileInventory,
): LocalInventory {
  return {
    ...models,
    ...files,
  };
}

/**
 * The default empty LocalInventory — all fields [].
 * Useful as a fallback when the store hasn't loaded yet.
 */
export const EMPTY_LOCAL_INVENTORY: LocalInventory = {
  checkpoints: [],
  loras: [],
  vaes: [],
  controlnet: [],
  upscale_models: [],
  clip: [],
  unet: [],
  ipadapter: [],
  embeddings: [],
  gligen: [],
  hypernetworks: [],
  diffusers: [],
  animatediff_models: [],
  video_models: [],
  style_models: [],
  samplers: [],
  schedulers: [],
  enumOptions: {},
  input_images: [],
  input_videos: [],
  input_audios: [],
};