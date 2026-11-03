/**
 * Workflow Engine
 * Builds ImagineRuns from parsed prompts, calculates dimensions,
 * and injects parameters into ComfyUI workflow JSON.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  ImagineJob,
  ImagineRun,
  Workflow,
  WorkflowSlots,
  WorkflowNode,
  ParseResult,
  ImageAttachment,
} from "@/types";
import {
  discoverT2ISlots,
  discoverDetailerSlots,
  discoverI2ISlots,
  discoverInpaintSlots,
  discoverVideoSlots,
  discoverControlNetSlots,
  enrichSlotsWithCapabilities,
  findFirstNodeId,
} from "./discovery";
import {
  injectControlNet,
  applyControlNetParams,
  resolvePreprocessorClass,
  isLoraModelOnly,
} from "./adapters";
import type { ControlNetParams } from "@/types";
import { parseImagineInput } from "./parser";
import { expandDynamicPromptGrid } from "./dynamicPrompts";
import registry from "./registry.json";
import {
  addSeamHarmonize,
  SEAM_HARMONIZE_DEFAULTS,
  type SeamHarmonizeOptions,
  type SeamPlacement,
} from "./outpaintSeam";
import { EDIT_MODES, type EditModeId } from "@/lib/krea2/editModes";
import { displayParamKey, isDisplayableParam } from "@/lib/ui/displayParams";
import { applyH3ExtraLoras } from "./h3Video";
import { applyH3Speed } from "./h3Speed";
import {
  applyH3ImageGrid,
  H3_IMAGE_STEPS,
  isH3ImageGraph,
} from "./h3Image";
import { injectAudioDuration } from "./audioDuration";
import { applyLtx25Params } from "./ltx25";
import { applyMossImageOptions } from "./mossImage";
import { applyMossLayout } from "./mossLayout";
import { applyGraphControls } from "./graphControls";
import { applySpeedTier, requestedSpeedTier } from "./speedTier";
import { applyRegionalPrompts } from "./regionalPrompt";
import {
  addImagePasteBack,
  pasteBackFitFor,
  pasteBackRequest,
} from "./imagePasteBack";

const CHECKPOINT_INPUT_KEYS = ["ckpt_name", "model_name", "unet_name"];
const VAE_INPUT_KEYS = ["vae_name"];
/** X2-Detail: drop-in H3 *video* decode VAE with enhanced detail. */
export const X2_DETAIL_VAE = "MiniMax-H3-X2-Detail-v1.safetensors";
const H3_VIDEO_VAE_RE = /minimax[_-]?h3[_-]?video|h3[_-]?video[_-]?vae/i;
const LORA_NAME_KEYS = ["lora_name"];
const KREA2_PROFILE = [1, 1, 1, 1, 1, 1, 1, 2.5, 5, 1.1, 4, 1] as const;

const LEGACY_VIDEO_OUTPUT_CLASSES = new Set([
  "VHS_VideoCombine",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
]);

const VIDEO_FRAME_COUNT_INPUTS = ["length", "frames_number", "frame_count"];

function requestedVideoFrameCount(
  params: Record<string, unknown>,
): number | undefined {
  const explicit = numberParam(params.bs);
  if (explicit !== undefined) return explicit;

  if (params.motion === "low") return 49;
  if (params.motion === "high") return 97;

  return undefined;
}

function shouldApplyVideoParams(params: Record<string, unknown>): boolean {
  return (
    !!params.video ||
    params.motion !== undefined ||
    params.bs !== undefined ||
    params.end !== undefined ||
    params.loop !== undefined
  );
}

function applyVideoFrameCount(
  workflow: Workflow,
  latentDimsId: string,
  frameCount: number | undefined,
): void {
  const latentNode = workflow[latentDimsId];
  if (!latentNode) return;

  if (frameCount !== undefined) {
    for (const inputName of VIDEO_FRAME_COUNT_INPUTS) {
      if (hasNodeInput(workflow, latentDimsId, inputName)) {
        setNodeInput(workflow, latentDimsId, inputName, frameCount);
        return;
      }
    }

    if (hasNodeInput(workflow, latentDimsId, "batch_size")) {
      setNodeInput(workflow, latentDimsId, "batch_size", frameCount);
    }
    return;
  }

  if (
    latentNode.class_type === "EmptyLatentImage" &&
    hasNodeInput(workflow, latentDimsId, "batch_size")
  ) {
    setNodeInput(workflow, latentDimsId, "batch_size", 16);
  }
}

interface RegistryConfig {
  defaults: {
    width: number;
    height: number;
    batch: number;
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    denoise: number;
  };
  templates: Record<
    string,
    {
      file: string;
      kind: string;
      name: string;
      denoise?: number;
      /** Outpaint seam harmonize pass (see outpaintSeam.ts). */
      seamHarmonize?: {
        enabled: boolean;
        denoise?: number;
        bandPx?: number;
        featherPx?: number;
      };
    }
  >;
  actions: Record<
    string,
    {
      id: string;
      name: string;
      icon: string;
      template: string;
      requiresImage?: boolean;
      requiresPrompt?: boolean;
      requiresMask?: boolean;
      params?: Record<string, unknown>;
      group: string;
    }
  >;
  aspectPresets: Record<string, { width: number; height: number }>;
  models: Record<string, { name: string; type: string; baseRes: number }>;
  params: Record<
    string,
    {
      flags: string[];
      kind: string;
      min?: number;
      max?: number;
      default?: unknown;
      nodeMapping?: {
        node: string;
        param?: string;
        params?: string[];
        target?: string;
      };
      comfyMapping?: {
        type: string;
        formula?: string;
      };
    }
  >;
}

const config = registry as RegistryConfig;

/**
 * Calculate width and height from aspect ratio string
 * Maintains approximately 1 megapixel target, rounded to 64px
 */
export function calculateDims(
  aspectStr: string,
  modelKey = "sdxl",
): { width: number; height: number } {
  const preset = config.aspectPresets[aspectStr];
  if (preset) {
    return { width: preset.width, height: preset.height };
  }

  // Parse aspect ratio string (e.g., "16:9", "1.5", "3:2")
  let ratio: number;
  if (aspectStr.includes(":")) {
    const [w, h] = aspectStr.split(":").map(Number);
    if (isNaN(w) || isNaN(h) || h === 0) {
      return { width: config.defaults.width, height: config.defaults.height };
    }
    ratio = w / h;
  } else {
    ratio = parseFloat(aspectStr);
    if (isNaN(ratio) || ratio <= 0) {
      return { width: config.defaults.width, height: config.defaults.height };
    }
  }

  const model = config.models[modelKey] ?? config.models.sdxl;
  const baseRes = model.baseRes;
  const targetPixels = baseRes * baseRes; // ~1MP

  // Calculate dimensions maintaining aspect ratio
  // width * height = targetPixels
  // width / height = ratio
  // width = ratio * height
  // ratio * height * height = targetPixels
  // height = sqrt(targetPixels / ratio)
  const height = Math.sqrt(targetPixels / ratio);
  const width = height * ratio;

  // Round to nearest 64 (required by latent space)
  const roundTo64 = (n: number) => Math.round(n / 64) * 64;

  return {
    width: Math.max(64, roundTo64(width)),
    height: Math.max(64, roundTo64(height)),
  };
}

export function cloneWorkflow(workflow: Workflow): Workflow {
  return structuredClone(workflow);
}

export function setNodeInput(
  workflow: Workflow,
  nodeId: string,
  inputName: string,
  value: unknown,
): void {
  const node = workflow[nodeId];
  if (!node) {
    console.warn(`setNodeInput: Node ${nodeId} not found`);
    return;
  }
  if (!node.inputs) {
    node.inputs = {};
  }
  node.inputs[inputName] = value;
}

export function getNodeInput(
  workflow: Workflow,
  nodeId: string,
  inputName: string,
): unknown {
  return workflow[nodeId]?.inputs?.[inputName];
}

/**
 * Check whether a node already defines an input (used to gate optional writes)
 */
export function hasNodeInput(
  workflow: Workflow,
  nodeId: string,
  inputName: string,
): boolean {
  return workflow[nodeId]?.inputs?.[inputName] !== undefined;
}

/**
 * Set a field of an API partner node's `model` dynamic combo. ComfyUI V3
 * dynamic-combo inputs are flat, prefixed keys in API format: the combo choice
 * lives in `inputs.model`, nested fields in `inputs["model.<field>"]`
 * (collapsed server-side by build_nested_inputs). Pass field "" to set the
 * combo choice itself.
 */
export function setApiModelField(
  workflow: Workflow,
  nodeId: string,
  field: string,
  value: unknown,
): void {
  const node = workflow[nodeId];
  if (!node?.inputs) {
    console.warn(`setApiModelField: Node ${nodeId} not found`);
    return;
  }
  node.inputs[field ? `model.${field}` : "model"] = value;
}

// Aspect ratios accepted by the Krea 2 API node
const API_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:2",
  "16:9",
  "2.35:1",
  "4:5",
  "2:3",
  "9:16",
] as const;

/**
 * Map an arbitrary `--ar W:H` to the closest API-supported enum value
 */
export function closestApiAspect(ar: string): string {
  const parse = (s: string): number | null => {
    const m = s.split(":");
    if (m.length !== 2) return null;
    const w = parseFloat(m[0]);
    const h = parseFloat(m[1]);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    return w / h;
  };
  const target = parse(ar);
  if (target === null) return "1:1";
  let best: string = API_ASPECT_RATIOS[0];
  let bestDist = Infinity;
  for (const candidate of API_ASPECT_RATIOS) {
    const r = parse(candidate)!;
    const dist = Math.abs(Math.log(target / r));
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

// Krea 2 model-variant aliases accepted via `--model`
const KREA2_MODEL_ALIASES: Record<string, string> = {
  "krea-2-medium": "Krea 2 Medium",
  "krea-2-medium-turbo": "Krea 2 Medium Turbo",
  "krea-2-large": "Krea 2 Large",
  "krea 2 medium": "Krea 2 Medium",
  "krea 2 medium turbo": "Krea 2 Medium Turbo",
  "krea 2 large": "Krea 2 Large",
};

/** Resolve a user-supplied model string to a Krea 2 variant label, if any */
export function resolveKrea2Variant(model: string): string | undefined {
  return KREA2_MODEL_ALIASES[model.trim().toLowerCase()];
}

/**
 * Apply stylize parameter to cfg scale
 * stylize 0-1000 maps to CFG adjustments
 */
function applyStylize(stylize: number, baseCfg: number): number {
  // stylize 100 = default, lower = less stylized, higher = more
  // Map to CFG: stylize 0 -> cfg * 0.5, stylize 1000 -> cfg * 1.5
  const factor = 0.5 + stylize / 1000;
  return Math.round(baseCfg * factor * 10) / 10;
}

function setFirstExistingInput(
  workflow: Workflow,
  nodeId: string,
  inputNames: string[],
  value: unknown,
  fallbackInput?: string,
): boolean {
  const node = workflow[nodeId];
  if (!node) return false;

  for (const inputName of inputNames) {
    if (node.inputs && inputName in node.inputs) {
      setNodeInput(workflow, nodeId, inputName, value);
      return true;
    }
  }

  if (fallbackInput) {
    setNodeInput(workflow, nodeId, fallbackInput, value);
    return true;
  }

  return false;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundUpToMultipleOf16(value: number): number {
  return Math.ceil(Math.max(0, Math.round(value)) / 16) * 16;
}

function numericParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Zoom/direction action + source size -> outpaint pad amounts (per side, /16).
 *  Shared by v1 (pad-inpaint) and v2 (bbox reference) outpaint. */
function computeOutpaintPads(
  params: Record<string, unknown>,
  sourceWidth: number,
  sourceHeight: number,
): { left: number; top: number; right: number; bottom: number } {
  const zoom = numericParam(params.zoom);
  const pads = { left: 0, top: 0, right: 0, bottom: 0 };
  if (zoom !== undefined) {
    const horizontal = roundUpToMultipleOf16((sourceWidth * (zoom - 1)) / 2);
    const vertical = roundUpToMultipleOf16((sourceHeight * (zoom - 1)) / 2);
    pads.left = horizontal;
    pads.right = horizontal;
    pads.top = vertical;
    pads.bottom = vertical;
  } else {
    const direction =
      typeof params.direction === "string" ? params.direction : undefined;
    if (direction === "up") {
      pads.top = roundUpToMultipleOf16(0.5 * sourceHeight);
    } else if (direction === "down") {
      pads.bottom = roundUpToMultipleOf16(0.5 * sourceHeight);
    } else if (direction === "left") {
      pads.left = roundUpToMultipleOf16(0.5 * sourceWidth);
    } else if (direction === "right") {
      pads.right = roundUpToMultipleOf16(0.5 * sourceWidth);
    }
  }
  return pads;
}

function applyOutpaintPadding(
  workflow: Workflow,
  padNodeId: string,
  params: Record<string, unknown>,
  sourceRun: ImagineRun,
): SeamPlacement {
  const sourceWidth = numericParam(sourceRun.width) ?? 1024;
  const sourceHeight = numericParam(sourceRun.height) ?? 1024;
  const pads = computeOutpaintPads(params, sourceWidth, sourceHeight);
  setNodeInput(workflow, padNodeId, "left", pads.left);
  setNodeInput(workflow, padNodeId, "top", pads.top);
  setNodeInput(workflow, padNodeId, "right", pads.right);
  setNodeInput(workflow, padNodeId, "bottom", pads.bottom);
  // ImagePadForOutpaint grows the canvas by exactly the pads (no rounding).
  return {
    canvasWidth: sourceWidth + pads.left + pads.right,
    canvasHeight: sourceHeight + pads.top + pads.bottom,
    x0: pads.left,
    y0: pads.top,
    x1: pads.left + sourceWidth,
    y1: pads.top + sourceHeight,
  };
}

/** Registry seam-harmonize settings for an action's template (null = off).
 *  `params.seamHarmonize === false` turns it off for one run. */
export function seamHarmonizeOptionsFor(
  action: string,
  params: Record<string, unknown>,
): SeamHarmonizeOptions | null {
  if (params.seamHarmonize === false) return null;
  const templateKey = config.actions[action]?.template ?? action;
  const cfg = config.templates[templateKey]?.seamHarmonize;
  if (!cfg?.enabled) return null;
  return {
    denoise: cfg.denoise ?? SEAM_HARMONIZE_DEFAULTS.denoise,
    bandPx: cfg.bandPx ?? SEAM_HARMONIZE_DEFAULTS.bandPx,
    featherPx: cfg.featherPx ?? SEAM_HARMONIZE_DEFAULTS.featherPx,
  };
}

/** v2 outpaint (krea2_outpaint LoRA): the source keeps its size and is registered
 *  at a bbox in a larger canvas. canvas = source + pads; bbox = source placed
 *  after the top/left pads. Injects canvas+bbox into the TextEncodeKrea2Outpaint,
 *  EmptySD3LatentImage, and Krea2OutpaintComposite nodes. */
function applyOutpaintV2Placement(
  workflow: Workflow,
  params: Record<string, unknown>,
  sourceRun: ImagineRun,
): SeamPlacement {
  const sw = numericParam(sourceRun.width) ?? 1024;
  const sh = numericParam(sourceRun.height) ?? 1024;
  const pads = computeOutpaintPads(params, sw, sh);
  const canvasW = roundUpToMultipleOf16(sw + pads.left + pads.right);
  const canvasH = roundUpToMultipleOf16(sh + pads.top + pads.bottom);
  const x0 = pads.left;
  const y0 = pads.top;
  const x1 = Math.min(x0 + sw, canvasW);
  const y1 = Math.min(y0 + sh, canvasH);

  const encId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "TextEncodeKrea2Outpaint",
  );
  const compId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "Krea2OutpaintComposite",
  );
  const latId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "EmptySD3LatentImage",
  );
  for (const id of [encId, compId]) {
    if (!id) continue;
    setNodeInput(workflow, id, "canvas_width", canvasW);
    setNodeInput(workflow, id, "canvas_height", canvasH);
    setNodeInput(workflow, id, "bbox_x0", x0);
    setNodeInput(workflow, id, "bbox_y0", y0);
    setNodeInput(workflow, id, "bbox_x1", x1);
    setNodeInput(workflow, id, "bbox_y1", y1);
  }
  if (latId) {
    setNodeInput(workflow, latId, "width", canvasW);
    setNodeInput(workflow, latId, "height", canvasH);
  }
  return { canvasWidth: canvasW, canvasHeight: canvasH, x0, y0, x1, y1 };
}

/** Inject a Krea 2 edit "mode" (skill) into a v1.2 edit workflow: the grounding_px
 *  + ref_boost dials, and the raw-model/steps override for clean removals. The
 *  prompt template and 2nd reference image are applied by the caller (they need the
 *  user's instruction / the second upload). No-op if `editMode` isn't a known mode. */
export function applyEditModeParams(
  workflow: Workflow,
  params: Record<string, unknown>,
): void {
  const modeId =
    typeof params.editMode === "string"
      ? (params.editMode as EditModeId)
      : undefined;
  const mode = modeId ? EDIT_MODES[modeId] : undefined;
  if (!mode) return;

  for (const [id, node] of Object.entries(workflow)) {
    if (node.class_type === "Krea2EditGroundedEncode") {
      setNodeInput(workflow, id, "grounding_px", mode.groundingPx);
    }
  }
  const patchId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "Krea2EditModelPatch",
  );
  if (patchId) {
    setNodeInput(workflow, patchId, "ref_boost", mode.refBoost);
    if (mode.refBoostA !== undefined) {
      setNodeInput(workflow, patchId, "ref_boost_a", mode.refBoostA);
    }
  }
  // Clean removals need Raw + more steps + real CFG (Turbo/8-step smears them).
  if (mode.id === "remove") {
    const unetId = findFirstNodeId(
      workflow,
      (n) => n.class_type === "UNETLoader",
    );
    if (unetId) {
      setNodeInput(workflow, unetId, "unet_name", "krea2_raw_bf16.safetensors");
    }
    const ksId = findFirstNodeId(workflow, (n) => n.class_type === "KSampler");
    if (ksId) {
      setNodeInput(workflow, ksId, "steps", 20);
      setNodeInput(workflow, ksId, "cfg", 3);
    }
  }
}

function krea2Stylization(params: Record<string, unknown>): number | undefined {
  const explicit = numberParam(params.stylization);
  if (explicit !== undefined) return clamp(explicit, 0, 1.5);
  const stylize = numberParam(params.stylize);
  if (stylize !== undefined) return clamp(stylize / 1000, 0, 1.5);
  return undefined;
}

export function krea2PerLayerWeights(
  stylization = 0,
  minimalismMaximalism = 0,
): string {
  const style = clamp(stylization, 0, 1.5);
  const tilt = clamp(minimalismMaximalism, -1, 1);
  const last = KREA2_PROFILE.length - 1;
  const weights = KREA2_PROFILE.map((profile, index) => {
    const base = 1 + style * (profile - 1);
    const position = index / last;
    const tiltFactor =
      tilt >= 0 ? 1 + tilt * position : 1 + -tilt * (1 - position);
    return Math.round(base * tiltFactor * 1000) / 1000;
  });
  return weights.map((value) => value.toFixed(3)).join(",");
}

function applyKrea2Params(
  workflow: Workflow,
  params: Record<string, unknown>,
): void {
  const stylization = krea2Stylization(params);
  const minimalismMaximalism =
    numberParam(params.minimalism_maximalism) ?? undefined;

  if (
    stylization === undefined &&
    minimalismMaximalism === undefined
  ) {
    return;
  }

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "ComfyUI-Krea2T-Enhancer") {
      if (stylization !== undefined) {
        setNodeInput(workflow, nodeId, "strength", stylization);
      }
    } else if (node.class_type === "ConditioningKrea2Rebalance") {
      setNodeInput(
        workflow,
        nodeId,
        "per_layer_weights",
        krea2PerLayerWeights(stylization ?? 0, minimalismMaximalism ?? 0),
      );
    }
  }
}

function isKrea2Workflow(workflow: Workflow): boolean {
  return Object.values(workflow).some(
    (node) =>
      node.class_type === "ComfyUI-Krea2T-Enhancer" ||
      node.class_type === "ConditioningKrea2Rebalance" ||
      node.class_type === "ApplyKrea2NegPiP",
  );
}

interface Krea2Native {
  unetNodeId: string;
  variant: "turbo" | "raw";
}

/**
 * Detect a NATIVE Krea2 workflow (plain ComfyUI UNETLoader, no custom nodes).
 */
export function detectKrea2Native(workflow: Workflow): Krea2Native | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type !== "UNETLoader") continue;
    const name = String(
      (node.inputs as Record<string, unknown> | undefined)?.unet_name ?? "",
    );
    if (/krea2/i.test(name)) {
      return {
        unetNodeId: nodeId,
        variant: /turbo/i.test(name) ? "turbo" : "raw",
      };
    }
  }
  return null;
}

// The Ostris image style-reference LoRA (--sv2). Rides a LoraLoaderModelOnly in
// the sref_image.json graph; must be protected from generic --lora clobbering.
const OSTRIS_STYLE_REF_LORA = "krea2_style_reference.safetensors";

/** --sv 2 (or "ostris" / "image") selects the Ostris image style-reference LoRA. */
export function resolveSvEngine(sv: unknown): 1 | 2 {
  if (sv === 2) return 2;
  const s = typeof sv === "string" ? sv.trim().toLowerCase() : "";
  return s === "2" || s === "ostris" || s === "image" ? 2 : 1;
}

/**
 * prompt-parameter semantics for NATIVE Krea2 workflows. Runs after the generic
 * injection so it can correct settings that are wrong for this family:
 * turbo is guidance-distilled (cfg must stay 1, "simple" scheduler), raw wants
 * real CFG and more steps. `--raw`/`--turbo` swap between the two checkpoints.
 */
function applyKrea2NativeParams(
  workflow: Workflow,
  slots: WorkflowSlots,
  params: Record<string, unknown>,
): void {
  const native = detectKrea2Native(workflow);
  if (!native) return;

  const cs = slots.customSampling;
  const stepsTargetId = cs?.sigmasId ?? slots.ksamplerId;
  const cfgTargetId = cs?.guiderId ?? slots.ksamplerId;
  const unetId = native.unetNodeId;
  const unetName = String(getNodeInput(workflow, unetId, "unet_name") ?? "");
  let variant = native.variant;

  // --version raw|turbo (and k2/k2t shorthands) are aliases for the flags.
  const versionValue = String(params.version ?? "").toLowerCase();
  const wantsRaw =
    Boolean(params.raw) || versionValue === "raw" || versionValue === "k2";
  const wantsTurbo =
    Boolean(params.turbo) || versionValue === "turbo" || versionValue === "k2t";

  // --raw on a turbo workflow: swap to the undistilled base (semantic:
  // literal, less opinionated) with its sampling regime.
  if (wantsRaw && variant === "turbo") {
    setNodeInput(
      workflow,
      unetId,
      "unet_name",
      unetName.replace(/turbo/gi, "raw"),
    );
    variant = "raw";
    if (params.steps === undefined) {
      setNodeInput(workflow, stepsTargetId, "steps", 28);
    }
    if (params.cfg === undefined) {
      setNodeInput(workflow, cfgTargetId, "cfg", 3.5);
    }
  } else if (wantsTurbo && variant === "raw") {
    // --turbo on a raw workflow: swap to the 8-step distilled checkpoint.
    setNodeInput(
      workflow,
      unetId,
      "unet_name",
      unetName.replace(/raw/gi, "turbo"),
    );
    variant = "turbo";
    if (params.steps === undefined) {
      setNodeInput(workflow, stepsTargetId, "steps", 8);
    }
  }

  if (variant === "turbo") {
    // Guidance-distilled: cfg>1 burns the image; undo generic stylize/turbo
    // handling unless the user explicitly forced a cfg/scheduler.
    if (params.cfg === undefined) {
      setNodeInput(workflow, cfgTargetId, "cfg", 1);
    }
    if (params.scheduler === undefined && !cs) {
      setNodeInput(workflow, slots.ksamplerId, "scheduler", "simple");
    }
  }

  // --draft: optionally route to a faster checkpoint (e.g. the depth-pruned
  // healed keep22) via env; generic step-halving already applied upstream.
  if (params.draft) {
    const draftUnet = process.env.COMFY_KREA2_DRAFT_UNET?.trim();
    if (draftUnet) {
      setNodeInput(workflow, unetId, "unet_name", draftUnet);
      if (params.steps === undefined) {
        // draft checkpoints are turbo-derived: keep the full 8 steps
        setNodeInput(workflow, stepsTargetId, "steps", 8);
      }
    }
  }

  // --hd: larger render. Krea2 trained up to ~1280-class; scale the
  // latent dims 1024->1280 keeping aspect. --sd is the default size (no-op).
  if (params.hd && slots.latentDimsId) {
    const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16);
    const w = Number(
      getNodeInput(workflow, slots.latentDimsId, "width") ?? 1024,
    );
    const h = Number(
      getNodeInput(workflow, slots.latentDimsId, "height") ?? 1024,
    );
    setNodeInput(
      workflow,
      slots.latentDimsId,
      "width",
      round16((w * 1280) / 1024),
    );
    setNodeInput(
      workflow,
      slots.latentDimsId,
      "height",
      round16((h * 1280) / 1024),
    );
  }

  // --sv2: Ostris image style-reference engine. The style LoRA rides a
  // LoraLoaderModelOnly (lora_name == krea2_style_reference.safetensors) in the
  // sref_image graph; drive its strength from --sw (0-1000 -> 0-2, default 1.0).
  // (The generic --lora handler already refuses to overwrite this node, so an
  // extra --lora stacks on the dedicated slot instead of the style reference.)
  const styleRefLoraId = findFirstNodeId(
    workflow,
    (n) =>
      isLoraModelOnly(n.class_type) &&
      typeof n.inputs?.lora_name === "string" &&
      n.inputs.lora_name === OSTRIS_STYLE_REF_LORA,
  );
  if (styleRefLoraId) {
    const swVal = numberParam(params.sw);
    if (swVal !== undefined) {
      const strength = Math.round(clamp(swVal / 100, 0, 2) * 100) / 100;
      setNodeInput(workflow, styleRefLoraId, "strength_model", strength);
    }
  }

  // --pa: prompt adherence via txtfusion-projector gain (Krea2ProjectorTuner
  // node). 100 = neutral. Turbo-safe CFG alternative — the projector's 12
  // constants come from the Krea-2-Turbo checkpoint (via Beinsezii's
  // projector-scale LoRA, which is those weights x100).
  const pa = numberParam(params.pa);
  if (
    pa !== undefined &&
    pa !== 100 &&
    hasNodeInput(workflow, slots.ksamplerId, "model")
  ) {
    const gain = clamp(pa, 0, 300) / 100 - 1; // knob multiplier over base proj
    const KREA2_TURBO_PROJ = [
      -0.05444, -0.16113, 0.37109, 0.50391, 0.70703, 0.39453, 0.39844, -1.4375,
      -0.51172, -0.89062, -0.60938, 0.11279,
    ];
    const tunerId = "krea2_projector_pa";
    const modelSource = getNodeInput(workflow, slots.ksamplerId, "model");
    // preset MUST be "custom" — any unknown preset name silently falls back
    // to the node's default preset instead of the knobs.
    const knobInputs: Record<string, unknown> = {
      model: modelSource,
      preset: "custom",
    };
    KREA2_TURBO_PROJ.forEach((v, i) => {
      knobInputs[`knob_${i}`] = Math.round(v * gain * 1e5) / 1e5;
    });
    workflow[tunerId] = {
      class_type: "Krea2ProjectorTuner",
      inputs: knobInputs,
    };
    setNodeInput(workflow, slots.ksamplerId, "model", [tunerId, 0]);
  }

  // --iw: image weight -> denoise for i2i (more weight = keep more of the image)
  if (
    params.iw !== undefined &&
    params.denoise === undefined &&
    hasNodeInput(workflow, slots.ksamplerId, "denoise") &&
    Object.values(workflow).some((n) => n.class_type === "LoadImage")
  ) {
    const iw = clamp(Number(params.iw), 0, 3);
    const denoise = Math.round(clamp(1 - 0.25 * iw, 0.2, 1) * 100) / 100;
    setNodeInput(workflow, slots.ksamplerId, "denoise", denoise);
  }
}

/**
 * Lock the official LTXV 0.9.8 2B distilled sampling recipe after generic
 * injection. The generic --turbo branch otherwise changes custom samplers to
 * 12 steps, which is wrong for this checkpoint's published 7-step first pass.
 */
function applyLtxvDistilledParams(
  workflow: Workflow,
  slots: WorkflowSlots,
  params: Record<string, unknown>,
): void {
  if (!params.turbo) return;
  const isDistilled = Object.values(workflow).some(
    (node) =>
      node.class_type === "CheckpointLoaderSimple" &&
      String((node.inputs as Record<string, unknown>).ckpt_name ?? "") ===
        "ltxv-2b-0.9.8-distilled.safetensors",
  );
  if (!isDistilled) return;

  const cs = slots.customSampling;
  if (cs?.sigmasId) setNodeInput(workflow, cs.sigmasId, "steps", 7);
  if (cs?.guiderId) setNodeInput(workflow, cs.guiderId, "cfg", 1);
}

const MODEL_LOADER_CLASSES = new Set([
  "UNETLoader",
  "UnetLoaderGGUF",
  "CheckpointLoaderSimple",
]);

// Insert `count` chained LoraLoaderModelOnly nodes right after the graph's only
// model loader, rewiring every consumer of its MODEL output. Returns the new
// node ids (empty when the graph has zero or several model loaders).
export function insertModelLoraChain(
  workflow: Workflow,
  count: number,
): string[] {
  const loaders = Object.entries(workflow).filter(([, n]) =>
    MODEL_LOADER_CLASSES.has(n.class_type),
  );
  if (loaders.length !== 1 || count < 1) return [];
  const srcId = loaders[0][0];
  const numericIds = Object.keys(workflow)
    .map((k) => Number(k))
    .filter(Number.isFinite);
  let next = Math.max(0, ...numericIds) + 1;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(String(next++));
  for (const node of Object.values(workflow)) {
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (Array.isArray(v) && v.length === 2 && v[0] === srcId && v[1] === 0) {
        inputs[k] = [ids[ids.length - 1], 0];
      }
    }
  }
  ids.forEach((id, i) => {
    workflow[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [i === 0 ? srcId : ids[i - 1], 0],
        lora_name: "",
        strength_model: 0,
      },
      _meta: { title: `--lora ${i + 1}` },
    } as Workflow[string];
  });
  return ids;
}

/**
 * MiniMax H3 canvas cap: the model's native maximum is a 768px short edge
 * capped at 768*1344 total pixels, per-axis rounded to /32 (mirrors
 * adapt_canvas() in ComfyUI's nodes_minimax_h3.py, which the node itself
 * only applies to reference media, not the t2v/i2v latent). This must never
 * upscale a smaller MPS-friendly request such as 864x480.
 */
function applyMiniMaxCanvas(workflow: Workflow, slots: WorkflowSlots): void {
  const latent = workflow[slots.latentDimsId];
  if (
    latent?.class_type !== "MiniMaxH3ImageToVideo" &&
    latent?.class_type !== "EmptyMiniMaxH3LatentAV"
  ) {
    return;
  }
  const inputs = latent.inputs as Record<string, unknown>;
  const w = Number(inputs.width);
  const h = Number(inputs.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

  const SHORT = 768;
  const MAX_PIXELS = 768 * 1344;
  const MULT = 32;
  const scale = Math.min(
    1,
    SHORT / Math.min(w, h),
    Math.sqrt(MAX_PIXELS / (w * h)),
  );
  const nw = w * scale;
  const nh = h * scale;
  setNodeInput(
    workflow,
    slots.latentDimsId,
    "width",
    Math.max(MULT, Math.round(nw / MULT) * MULT),
  );
  setNodeInput(
    workflow,
    slots.latentDimsId,
    "height",
    Math.max(MULT, Math.round(nh / MULT) * MULT),
  );
}

/** Draft-tier H3 clip: 22 frames (~0.9 s) on the 17k+5 grid. */
export const H3_DRAFT_LENGTH = 22;

/**
 * H3 clip length: the packs default to 73 frames (~3 s at 24 fps). The Draft
 * speed tier (`--tier draft`) keeps the 22-frame preview unless the
 * prompt set a length itself (--bs / --motion).
 */
function applyH3DraftLength(
  workflow: Workflow,
  slots: WorkflowSlots,
  params: Record<string, unknown>,
): void {
  const latent = workflow[slots.latentDimsId];
  if (
    latent?.class_type !== "MiniMaxH3ImageToVideo" &&
    latent?.class_type !== "MiniMaxH3ReferenceToVideo"
  ) {
    return;
  }
  if (requestedVideoFrameCount(params) !== undefined) return;
  if (requestedSpeedTier(params) !== "draft") return;
  if (!hasNodeInput(workflow, slots.latentDimsId, "length")) return;
  setNodeInput(workflow, slots.latentDimsId, "length", H3_DRAFT_LENGTH);
}

export function injectParams(
  workflow: Workflow,
  slots: WorkflowSlots,
  params: Record<string, unknown>,
  prompt: string,
  negativePrompt: string,
  seed: number,
): void {
  // Custom-sampling graphs (SamplerCustomAdvanced) split seed/steps/cfg/sampler
  // across dedicated nodes; ordinary workflows keep everything on the KSampler.
  const cs = slots.customSampling;
  const seedTargetId = cs?.noiseId ?? slots.ksamplerId;
  const seedInputName = cs ? "noise_seed" : "seed";
  const stepsTargetId = cs?.sigmasId ?? slots.ksamplerId;
  const cfgTargetId = cs?.guiderId ?? slots.ksamplerId;
  const samplerTargetId = cs?.samplerSelectId ?? slots.ksamplerId;
  const apiNodeId = slots.apiPromptNodeId;

  setNodeInput(
    workflow,
    slots.posTextId,
    slots.posTextInputName ?? "text",
    prompt,
  );

  // Inject negative prompt. Skip when positive/negative share one encoder
  // (e.g. Ideogram 4 derives the negative via ConditioningZeroOut).
  if (negativePrompt && slots.negTextInputName) {
    // One node carries both texts on distinct inputs (TextEncodeQwenImage21).
    setNodeInput(
      workflow,
      slots.negTextId,
      slots.negTextInputName,
      negativePrompt,
    );
  } else if (negativePrompt && slots.negTextId !== slots.posTextId) {
    setNodeInput(workflow, slots.negTextId, "text", negativePrompt);
  }

  setNodeInput(workflow, seedTargetId, seedInputName, seed);

  if (params.ar) {
    if (apiNodeId && hasNodeInput(workflow, apiNodeId, "width")) {
      // Self-contained generator nodes (SeFiGenerate) take real dims
      const dims = calculateDims(params.ar as string);
      const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16);
      setNodeInput(workflow, apiNodeId, "width", round16(dims.width));
      setNodeInput(workflow, apiNodeId, "height", round16(dims.height));
    } else if (apiNodeId) {
      // API partner nodes take an aspect-ratio enum nested in the model combo
      setApiModelField(
        workflow,
        apiNodeId,
        "aspect_ratio",
        closestApiAspect(params.ar as string),
      );
    } else {
      const dims = calculateDims(params.ar as string);
      setNodeInput(workflow, slots.latentDimsId, "width", dims.width);
      setNodeInput(workflow, slots.latentDimsId, "height", dims.height);
      // Resolution-aware schedulers (Ideogram4Scheduler) need the dims too
      if (cs?.sigmasId && hasNodeInput(workflow, cs.sigmasId, "width")) {
        setNodeInput(workflow, cs.sigmasId, "width", dims.width);
        setNodeInput(workflow, cs.sigmasId, "height", dims.height);
      }
    }
  }

  // Self-contained generator nodes (SeFiGenerate) expose real steps/guidance
  // inputs — inject when present. Remote API partner nodes own them
  // server-side and expose neither.
  if (apiNodeId) {
    if (
      params.steps !== undefined &&
      hasNodeInput(workflow, apiNodeId, "steps")
    ) {
      setNodeInput(workflow, apiNodeId, "steps", params.steps);
    }
    if (
      params.cfg !== undefined &&
      hasNodeInput(workflow, apiNodeId, "guidance")
    ) {
      setNodeInput(workflow, apiNodeId, "guidance", params.cfg);
    }
  }
  if (!apiNodeId) {
    if (params.steps !== undefined) {
      setNodeInput(workflow, stepsTargetId, "steps", params.steps);
    }

    let cfg =
      (params.cfg as number | undefined) ??
      (getNodeInput(workflow, cfgTargetId, "cfg") as number | undefined) ??
      config.defaults.cfg;
    // Skip stylize->cfg for custom-node Krea2 (enhancer handles it) and for
    // native Krea2 TURBO (guidance-distilled; cfg must stay at 1).
    if (
      params.stylize !== undefined &&
      !isKrea2Workflow(workflow) &&
      detectKrea2Native(workflow)?.variant !== "turbo"
    ) {
      cfg = applyStylize(params.stylize as number, cfg);
    }
    setNodeInput(workflow, cfgTargetId, "cfg", cfg);

    // Speed tier (--tier draft|quality): per-engine steps / distilled variant.
    // Explicit --steps / --draft / --turbo win (speedTier.ts).
    applySpeedTier(workflow, { stepsTargetId, cfgTargetId }, params);

    if (params.quality !== undefined) {
      const q = params.quality as number;
      // H3 Image scales its pinned Turbo 8 steps, not the registry default.
      const baseSteps =
        (params.steps as number) ??
        (isH3ImageGraph(workflow) ? H3_IMAGE_STEPS : config.defaults.steps);
      // Quality 0.25 = quarter steps, 0.5 = half, 1 = full, 2 = double
      const adjustedSteps = Math.round(baseSteps * q);
      setNodeInput(
        workflow,
        stepsTargetId,
        "steps",
        Math.max(1, adjustedSteps),
      );
    }

    // Handle draft mode (reduced steps + reduced resolution for
    // draft-then-upscale pipeline). Resolution reduction is applied here;
    // the caller (imagine route) is responsible for setting draftUpscale on
    // the ImagineRun and auto-queuing the refine pass on completion.
    if (params.draft) {
      const currentSteps =
        (getNodeInput(workflow, stepsTargetId, "steps") as number) ??
        config.defaults.steps;
      setNodeInput(
        workflow,
        stepsTargetId,
        "steps",
        Math.max(4, Math.round(currentSteps * 0.5)),
      );

      // Reduce latent dimensions by ~50% each axis (factor configurable via
      // --draft_scale, default 0.5). This cuts pixel count to ~25%, giving a
      // significant speed boost for the draft pass.
      const scale =
        typeof params.draft_scale === "number"
          ? Math.max(0.25, Math.min(1, params.draft_scale))
          : 0.5;
      if (scale < 1 && slots.latentDimsId) {
        const curW =
          (getNodeInput(workflow, slots.latentDimsId, "width") as number) ??
          1024;
        const curH =
          (getNodeInput(workflow, slots.latentDimsId, "height") as number) ??
          1024;
        const round8 = (n: number) => Math.max(256, Math.round(n / 8) * 8);
        setNodeInput(
          workflow,
          slots.latentDimsId,
          "width",
          round8(curW * scale),
        );
        setNodeInput(
          workflow,
          slots.latentDimsId,
          "height",
          round8(curH * scale),
        );
      }
    }

    // Handle turbo mode (reduced steps, different scheduler).
    // Custom-sampling graphs keep their dedicated sigma scheduler.
    if (params.turbo) {
      setNodeInput(workflow, stepsTargetId, "steps", cs ? 12 : 8);
      if (!cs) {
        setNodeInput(workflow, slots.ksamplerId, "scheduler", "sgm_uniform");
      }
    }

    // Handle denoise (for img2img workflows)
    if (params.denoise !== undefined) {
      setNodeInput(workflow, slots.ksamplerId, "denoise", params.denoise);
    }

    // Handle stop parameter (early stopping)
    if (params.stop !== undefined) {
      const stop = params.stop as number;
      const currentSteps =
        (getNodeInput(workflow, stepsTargetId, "steps") as number) ??
        config.defaults.steps;
      // Stop at percentage of total steps
      const actualSteps = Math.round(currentSteps * (stop / 100));
      setNodeInput(workflow, stepsTargetId, "steps", Math.max(1, actualSteps));
    }

    if (params.sampler) {
      setNodeInput(workflow, samplerTargetId, "sampler_name", params.sampler);
    }

    // Handle scheduler override (custom-sampling sigma nodes are the scheduler)
    if (params.scheduler && !cs) {
      setNodeInput(workflow, slots.ksamplerId, "scheduler", params.scheduler);
    }
  }


  if (params.model && apiNodeId) {
    const variant = resolveKrea2Variant(String(params.model));
    if (variant) {
      setApiModelField(workflow, apiNodeId, "", variant);
    }
  } else if (params.model) {
    let modelApplied = false;
    if (slots.checkpointLoaderId) {
      modelApplied = setFirstExistingInput(
        workflow,
        slots.checkpointLoaderId,
        CHECKPOINT_INPUT_KEYS,
        params.model,
        "ckpt_name",
      );
    }

    if (!modelApplied) {
      for (const [nodeId, node] of Object.entries(workflow)) {
        if (
          [
            "CheckpointLoaderSimple",
            "CheckpointLoader",
            "UNETLoader",
            "UNETLoaderSDXL",
            "UNETLoaderFlux",
            "ModelSamplingAuraFlow",
          ].includes(node.class_type)
        ) {
          if (
            setFirstExistingInput(
              workflow,
              nodeId,
              CHECKPOINT_INPUT_KEYS,
              params.model,
              "ckpt_name",
            )
          ) {
            modelApplied = true;
          }
        }
      }
    }
  }

  if (params.vae) {
    let vaeApplied = false;
    if (slots.vaeLoaderId) {
      vaeApplied = setFirstExistingInput(
        workflow,
        slots.vaeLoaderId,
        VAE_INPUT_KEYS,
        params.vae,
        "vae_name",
      );
    }

    if (!vaeApplied) {
      for (const [nodeId, node] of Object.entries(workflow)) {
        if (
          ["VAELoader", "CheckpointLoaderSimple", "CheckpointLoader"].includes(
            node.class_type,
          )
        ) {
          // H3 workflows carry a second VAELoader for the stereo audio
          // track — a generic --vae override must never clobber it.
          const currentName = (
            node.inputs as Record<string, unknown> | undefined
          )?.vae_name;
          if (typeof currentName === "string" && /audio/i.test(currentName)) {
            continue;
          }
          if (
            setFirstExistingInput(workflow, nodeId, VAE_INPUT_KEYS, params.vae)
          ) {
            vaeApplied = true;
          }
        }
      }
    }
  }

  // --refiner x2_detail: swap the H3 *video* decode VAE for the X2-Detail
  // variant at generation time. Post-hoc refinement is impossible here (the
  // latent is gone once the video is decoded), so this is the real wiring.
  // Only VAELoaders currently pointing at an H3 video VAE are touched; the
  // audio VAE and non-H3 workflows are untouched (no-op elsewhere).
  if (params.refiner === "x2_detail") {
    for (const node of Object.values(workflow)) {
      if (node.class_type !== "VAELoader") continue;
      const inputs = node.inputs as Record<string, unknown> | undefined;
      if (
        typeof inputs?.vae_name === "string" &&
        H3_VIDEO_VAE_RE.test(inputs.vae_name)
      ) {
        inputs.vae_name = X2_DETAIL_VAE;
      }
    }
  }

  // Handle LoRA injection (may be array from multi flag)
  // When updating existing LoRA nodes, skip strength_clip for model-only loaders.
  // Never overwrite the Ostris style-reference LoRA (--sv2 owns it): protect the
  // FIRST style-ref loader (the active adapter) so an extra --lora rides the next
  // loader (the stack slot) instead of clobbering the style reference.
  const styleRefHeadId = slots.loraLoaderIds?.find(
    (id) =>
      (workflow[id]?.inputs as Record<string, unknown> | undefined)
        ?.lora_name === OSTRIS_STYLE_REF_LORA,
  );
  let loraTargetIds = slots.loraLoaderIds?.filter(
    (id) => id !== styleRefHeadId,
  );
  // Graphs with no LoRA slot (e.g. the public Krea 2 t2i/draft graphs):
  // splice model-only loaders after the single model
  // loader; ambiguous graphs (0 or 2+ model loaders) stay untouched.
  if (params.lora && (!loraTargetIds || loraTargetIds.length === 0)) {
    const count = Array.isArray(params.lora) ? params.lora.length : 1;
    loraTargetIds = insertModelLoraChain(workflow, count);
  }
  if (params.lora && loraTargetIds && loraTargetIds.length > 0) {
    const loraParams = Array.isArray(params.lora) ? params.lora : [params.lora];

    for (let i = 0; i < loraParams.length && i < loraTargetIds.length; i++) {
      const loraStr = String(loraParams[i]);
      const [name, strengthStr] = loraStr.split("::");
      const strength = strengthStr ? parseFloat(strengthStr) : 1.0;

      if (name) {
        const loraNodeId = loraTargetIds[i];
        const loraNode = workflow[loraNodeId];
        const isModelOnly = loraNode
          ? isLoraModelOnly(loraNode.class_type)
          : false;

        setFirstExistingInput(
          workflow,
          loraNodeId,
          LORA_NAME_KEYS,
          name,
          "lora_name",
        );
        setNodeInput(workflow, loraNodeId, "strength_model", strength);
        // Only set strength_clip for full LoRA loaders that have CLIP output
        // LoraLoaderModelOnly does not have a strength_clip input
        if (!isModelOnly) {
          setNodeInput(workflow, loraNodeId, "strength_clip", strength);
        }
      }
    }
  }

  // Handle video parameters. Native video latents use `length` for frame count;
  // legacy VHS-style still-image graphs used EmptyLatentImage.batch_size.
  if (shouldApplyVideoParams(params)) {
    applyVideoFrameCount(
      workflow,
      slots.latentDimsId,
      requestedVideoFrameCount(params),
    );

    for (const [nodeId, node] of Object.entries(workflow)) {
      if (params.end !== undefined) {
        if (hasNodeInput(workflow, nodeId, "frame_rate")) {
          setNodeInput(workflow, nodeId, "frame_rate", params.end);
        }
        if (hasNodeInput(workflow, nodeId, "fps")) {
          setNodeInput(workflow, nodeId, "fps", params.end);
        }
      }

      if (LEGACY_VIDEO_OUTPUT_CLASSES.has(node.class_type)) {
        if (params.loop !== undefined) {
          setNodeInput(workflow, nodeId, "loop_count", params.loop);
        }
      }
    }
  }

  // Handle ControlNet injection
  // If controlnet param is present, either apply to existing ControlNet slots
  // or inject new ControlNet nodes into the workflow.
  if (params.controlnet) {
    const cnParams: ControlNetParams = {
      model: String(params.controlnet),
      preprocessor: resolvePreprocessorClass(
        String(params["cn-preprocessor"] ?? params.controlnet),
      ),
      strength: (params["cn-strength"] as number) ?? 1.0,
      startPercent: params["cn-start"] as number | undefined,
      endPercent: params["cn-end"] as number | undefined,
    };
    if (params["cn-image"]) {
      cnParams.sourceImage = String(params["cn-image"]);
    }

    const existingCnSlots = discoverControlNetSlots(workflow);
    if (existingCnSlots.length > 0) {
      const cnResult = applyControlNetParams(
        workflow,
        existingCnSlots,
        cnParams,
      );
      // cnResult.workflow is a clone, but we're already working on a clone in injectParams
      // so we apply the same changes directly
      for (const nodeId of cnResult.injectedNodeIds) {
        if (cnResult.workflow[nodeId]) {
          workflow[nodeId] = cnResult.workflow[nodeId];
        }
      }
    }
    // For injection of new ControlNet nodes, that happens at the extractWorkflowsFromRuns
    // level because it changes the node graph. The slots enrichment handles capability detection.
  }

  applyKrea2Params(workflow, params);
  applyKrea2NativeParams(workflow, slots, params);
  applyLtxvDistilledParams(workflow, slots, params);
  applyMiniMaxCanvas(workflow, slots);
  applyH3ImageGrid(workflow);
  applyH3DraftLength(workflow, slots, params);
  applyLtx25Params(workflow, params);
  // Optional LoRA toggles: H3 motion repair / handheld + Turbo speed (after
  // the extras so SigmaShift stays the tail), MOSS speed / deband.
  applyH3ExtraLoras(workflow, params);
  applyH3Speed(workflow, params);
  applyMossImageOptions(workflow, params);
  // MOSS-Image layout boxes: positive prompt becomes the layout JSON caption.
  applyMossLayout(workflow, slots, params, prompt);
  // --region: per-box CLIPTextEncode -> ConditioningSetAreaPercentage ->
  // ConditioningCombine with the base positive (before clip-skip rewiring).
  applyRegionalPrompts(workflow, slots, params);
  // --clipskip (SD1.5/SDXL only) + tiled VAE decode (manual/auto/low-VRAM).
  // Runs after every dims-changing step (--hd/--draft/--ar, MiniMax cap).
  applyGraphControls(workflow, params, { apiNode: Boolean(apiNodeId) });

  // Handle 3D parameters — inject resolution into TripoSRSampler if provided
  if (params["3d"]) {
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (node.class_type === "TripoSRSampler") {
        if (params.ar !== undefined) {
          const res = parseInt(String(params.ar), 10);
          if (!isNaN(res)) {
            setNodeInput(workflow, nodeId, "resolution", res);
          }
        }
      }
    }
  }

  // Handle audio parameters — Stable Audio length lives on EmptyLatentAudio
  if (params.audio) {
    injectAudioDuration(workflow, params.duration ?? 10);
  }
}

/**
 * Build negative prompt from --no parameters
 */
export function buildNegativePrompt(
  baseNegative: string,
  noParams: string[] | string | undefined,
): string {
  if (!noParams) return baseNegative;

  const noArray = Array.isArray(noParams) ? noParams : [noParams];
  const combined = [baseNegative, ...noArray].filter(Boolean).join(", ");
  return combined;
}

/**
 * Get the denoise value for an action from the registry.
 * Resolves via action -> template -> denoise, returning undefined
 * if no registry denoise is defined for this action's template.
 */
export function getActionDenoise(action: string): number | undefined {
  const actionConfig = config.actions[action];
  const templateKey = actionConfig?.template ?? action;
  const templateConfig = config.templates[templateKey];
  return templateConfig?.denoise;
}

/**
 * Generate seeds for a batch of images
 * Supports chaos parameter for seed variation
 */
export function generateBatchSeeds(
  baseSeed: number | undefined,
  count: number,
  chaos = 0,
): number[] {
  const seeds: number[] = [];
  const base = baseSeed ?? Math.floor(Math.random() * 2147483647);

  for (let i = 0; i < count; i++) {
    if (i === 0) {
      seeds.push(base);
    } else if (chaos > 0) {
      // With chaos, vary seeds more dramatically
      const variation = Math.floor(Math.random() * (chaos * 10000));
      seeds.push((base + variation) % 2147483647);
    } else {
      // Without chaos, sequential seeds
      seeds.push((base + i) % 2147483647);
    }
  }

  return seeds;
}

/** Most video variants one run may queue (`--vb`). */
export const VIDEO_BATCH_MAX = 4;

/**
 * Jobs per run for a `--video` prompt. Only `--vb` raises it: the image
 * batch size never applies to video (an image batch of 8 would otherwise
 * queue 8 renders). Each variant is its own ComfyUI prompt, so they render
 * one after another instead of as one batched latent that would OOM.
 */
export function videoBatchCount(vb: unknown): number {
  const n = typeof vb === "number" ? vb : Number(vb);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(VIDEO_BATCH_MAX, Math.round(n)));
}

/**
 * Build ImagineRun objects from a parsed prompt
 * Each run can produce multiple images (jobs)
 */
export function buildImagineRuns(
  parseResult: ParseResult,
  workflow: Workflow,
  options: {
    batchSize?: number;
    repeat?: number;
    baseNegative?: string;
    action?: string;
    sourceImage?: string;
    sourceImages?: ImageAttachment[];
  } = {},
): ImagineRun[] {
  const {
    batchSize = config.defaults.batch,
    repeat = 1,
    baseNegative = "",
    action,
    sourceImage,
    sourceImages,
  } = options;

  const { prompt, params } = parseResult;

  const aspectStr = (params.ar as string) ?? "1:1";
  const dims = calculateDims(aspectStr);

  // Build negative prompt (--raw clears base negative)
  const effectiveBaseNegative = params.raw ? "" : baseNegative;
  const negativePrompt = buildNegativePrompt(
    effectiveBaseNegative,
    params.no as string[] | undefined,
  );

  // Native krea2 TURBO zeroes the negative conditioning (ConditioningZeroOut),
  // so --no would silently do nothing there — fold it into the prompt instead
  // (qwen3-vl follows "without X" reliably).
  let effectivePrompt = prompt;
  const noTerms = params.no as string[] | undefined;
  if (
    noTerms?.length &&
    detectKrea2Native(workflow)?.variant === "turbo" &&
    !params.raw
  ) {
    effectivePrompt = `${prompt}. Without ${noTerms.join(", ")}.`;
  }

  const baseSeed = params.seed as number | undefined;
  const chaos = (params.chaos as number) ?? 0;

  const repeatCount = (params.repeat as number) ?? repeat;
  // Video: `--vb` variants (default 1), never the image batch size.
  const jobsPerRun = params.video ? videoBatchCount(params.vb) : batchSize;

  const runs: ImagineRun[] = [];

  // XYZ-plot / grid mode: `--grid` renders one image per `{a|b|c}` wildcard
  // combination (the cartesian product) instead of a random-pick batch. Each
  // grid cell is a job with its own promptOverride; the seed is held fixed
  // across cells so only the varied text differs.
  const gridCells = params.grid
    ? expandDynamicPromptGrid(effectivePrompt)
    : null;

  if (gridCells && gridCells.length > 1) {
    const runId = uuidv4();
    const [cellSeed] = generateBatchSeeds(baseSeed, 1, 0);
    const jobs: ImagineJob[] = gridCells.map((cell, index) => ({
      seed: cellSeed,
      index,
      status: "queued" as const,
      progress: 0,
      images: [],
      promptOverride: cell,
      label: cell,
    }));

    runs.push({
      run_id: runId,
      prompt: parseResult.prompt,
      parsedPrompt: effectivePrompt,
      width: dims.width,
      height: dims.height,
      jobs,
      createdAt: new Date().toISOString(),
      status: "queued",
      params: { ...params, negativePrompt },
      sourceImage,
      sourceImages,
      action,
    });
    return runs;
  }

  // Draft-then-upscale metadata: when --draft is set, record the original
  // target dimensions and the refiner slot so the client can auto-fire
  // an upscale action when the draft pass completes.
  const isDraft = Boolean(params.draft);
  const draftFields = isDraft
    ? {
        draftUpscale: true as const,
        draftTargetWidth: dims.width,
        draftTargetHeight: dims.height,
        // Only registry actions are valid auto-upscale slots. Generation-time
        // refiners (x2_detail) and off-box ones (sol_refiner) fall back to
        // the default so the client never fires a nonexistent action.
        refinerSlot:
          typeof params.refiner === "string" &&
          params.refiner in
            ((registry as { actions?: Record<string, unknown> }).actions ?? {})
            ? params.refiner
            : "upscale_subtle",
      }
    : {};

  for (let r = 0; r < repeatCount; r++) {
    const runId = uuidv4();
    const seeds = generateBatchSeeds(
      baseSeed !== undefined ? baseSeed + r * jobsPerRun : undefined,
      jobsPerRun,
      chaos,
    );

    const jobs: ImagineJob[] = seeds.map((seed, index) => ({
      seed,
      index,
      status: "queued" as const,
      progress: 0,
      images: [],
    }));

    runs.push({
      run_id: runId,
      prompt: parseResult.prompt,
      parsedPrompt: effectivePrompt,
      width: dims.width,
      height: dims.height,
      jobs,
      createdAt: new Date().toISOString(),
      status: "queued",
      params: { ...params, negativePrompt },
      sourceImage,
      sourceImages,
      action,
      ...draftFields,
    });
  }

  return runs;
}

/**
 * Extract individual workflow JSONs from runs
 * Each job gets its own workflow copy with injected parameters
 */
export function extractWorkflowsFromRuns(
  runs: ImagineRun[],
  baseWorkflow: Workflow,
  discoverSlots: (wf: Workflow) => WorkflowSlots = discoverT2ISlots,
): Array<{
  runId: string;
  jobIndex: number;
  workflow: Workflow;
  seed: number;
}> {
  const results: Array<{
    runId: string;
    jobIndex: number;
    workflow: Workflow;
    seed: number;
  }> = [];
  const slots = discoverSlots(baseWorkflow);

  for (const run of runs) {
    const negativePrompt = (run.params.negativePrompt as string) ?? "";

    for (const job of run.jobs) {
      const workflow = cloneWorkflow(baseWorkflow);

      // Inject all parameters. In grid mode each job carries its own
      // promptOverride (one XYZ cell); otherwise the run's shared prompt is used.
      injectParams(
        workflow,
        slots,
        run.params,
        job.promptOverride ?? run.parsedPrompt,
        negativePrompt,
        job.seed,
      );

      results.push({
        runId: run.run_id,
        jobIndex: job.index,
        workflow,
        seed: job.seed,
      });
    }
  }

  return results;
}

const VIEW_REF_TYPES: ReadonlySet<string> = new Set([
  "output",
  "input",
  "temp",
]);

/**
 * Validate the parts of a /view reference before they go into a graph
 * (LoadImage / LoadVideo resolve "subfolder/filename [type]" on the server):
 * type must be output|input|temp; no absolute paths, "." / ".." segments,
 * backslashes, control characters, or brackets in the filename (they would
 * break the " [type]" annotation). Returns the clean ref or null.
 */
export function validateViewRef(
  filename: string,
  subfolder: string,
  type: string,
): string | null {
  if (!VIEW_REF_TYPES.has(type)) return null;
  if (!filename || filename.length > 255 || /[[\]]/.test(filename)) return null;
  const sub = subfolder.replace(/\/+$/, "");
  const path = sub ? `${sub}/${filename}` : filename;
  if (path.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(path)) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  for (const seg of path.split("/")) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  return `${path} [${type}]`;
}

/**
 * Convert a ComfyUI /view URL (as stored in job.images) into the annotated
 * path LoadImage understands: "subfolder/filename [type]". Returns null for
 * anything that isn't a /view URL or fails validateViewRef.
 */
export function comfyImageRefFromViewUrl(
  viewUrl: string | undefined,
): string | null {
  if (!viewUrl) return null;
  try {
    const url = new URL(viewUrl, "http://localhost");
    if (!url.pathname.endsWith("/view")) return null;
    const filename = url.searchParams.get("filename");
    if (!filename) return null;
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") || "output";
    return validateViewRef(filename, subfolder, type);
  } catch {
    return null;
  }
}

/** Image-in/image-out actions with no sampler (see buildActionWorkflow). */
export const UTILITY_IMAGE_ACTIONS: ReadonlySet<string> = new Set([
  "bg_remove",
]);

export function buildActionWorkflow(
  baseWorkflow: Workflow,
  action: string,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  newParams: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);

  // Utility graphs (background removal) have no sampler, prompt or seed:
  // point the LoadImage at the source output and queue the graph untouched.
  if (UTILITY_IMAGE_ACTIONS.has(action)) {
    const imageInputId = findFirstNodeId(
      workflow,
      (n) => n.class_type === "LoadImage",
    );
    if (!imageInputId) {
      throw new Error(`${action}: workflow has no LoadImage node`);
    }
    const ref = comfyImageRefFromViewUrl(
      sourceRun.jobs[sourceJobIndex]?.images?.[0],
    );
    if (ref) setNodeInput(workflow, imageInputId, "image", ref);
    return {
      workflow,
      slots: {
        ksamplerId: "",
        posTextId: "",
        negTextId: "",
        latentDimsId: "",
        imageInputId,
      },
      seed: sourceRun.jobs[sourceJobIndex]?.seed ?? 0,
    };
  }

  // Determine slot discovery based on action type. Keep this aligned with
  // workflowAssignments recommended kinds: outpaint/zoom/pan actions need a
  // source image, and video actions need video-output discovery rather than the
  // generic t2i path.
  let slots: WorkflowSlots;
  if (action.startsWith("adetailer")) {
    // FaceDetailer graphs have no KSampler/EmptyLatentImage.
    slots = discoverDetailerSlots(workflow);
  } else if (
    (action.includes("inpaint") && !action.startsWith("edit_")) ||
    action === "edit"
  ) {
    // (edit_inpaint is a Krea 2 edit graph: it takes the edit_ branch below so
    // its fixed inpaint LoRA at node "2" is protected from a stray --lora.)
    slots = discoverInpaintSlots(workflow);
  } else if (action.startsWith("edit_")) {
    // Krea 2 instruct-edit: a noise target (t2i-style sampler/pos/neg/latent)
    // plus a source LoadImage that feeds the edit patch, grounded encode, and
    // (structural) depth-control. Discover the t2i slots, then point the
    // source-image injection at the LoadImage node.
    slots = discoverT2ISlots(workflow);
    const loadImageId = findFirstNodeId(
      workflow,
      (n) => n.class_type === "LoadImage",
    );
    if (loadImageId) {
      (slots as { imageInputId?: string }).imageInputId = loadImageId;
    }
    // Edit graphs reserve node "2" for the edit LoRA (dropdown-owned) and may
    // carry other fixed pipeline LoRAs (e.g. Qwen's 4-step Lightning at "3").
    // Every edit graph exposes a dedicated stack slot at node "30", so route an
    // extra `--lora` there exclusively; only if a graph lacks it do we fall back
    // to "any loader that isn't the edit LoRA".
    if (slots.loraLoaderIds) {
      const stack = slots.loraLoaderIds.filter((id) => id === "30");
      slots.loraLoaderIds = stack.length
        ? stack
        : slots.loraLoaderIds.filter((id) => id !== "2");
    }
  } else if (
    action.startsWith("animate_") ||
    action.includes("video") ||
    action.includes("i2v") ||
    action.includes("t2v")
  ) {
    slots = discoverVideoSlots(workflow);
  } else if (
    action.includes("vary") ||
    action.includes("remix") ||
    action.includes("upscale") ||
    action.includes("outpaint") ||
    // detail / upscale_detail / adetailer(_auto) all consume a source image
    action.includes("detail") ||
    action.startsWith("pan_") ||
    action.startsWith("zoom_")
  ) {
    slots = discoverI2ISlots(workflow) as WorkflowSlots;
  } else {
    slots = discoverT2ISlots(workflow);
  }

  // A remix passes an edited prompt via newParams.prompt. Parse it so any
  // trailing prompt flags become real params (not literal text in the CLIP prompt)
  // and its edited text actually drives generation.
  let promptForInjection = sourceRun.parsedPrompt;
  let editedPromptParams: Record<string, unknown> = {};
  if (typeof newParams.prompt === "string" && newParams.prompt.trim()) {
    const parsedEdit = parseImagineInput(newParams.prompt);
    promptForInjection = parsedEdit.prompt;
    editedPromptParams = parsedEdit.params;
  }

  const registryActionParams = config.actions[action]?.params ?? {};

  // Merge source params, registry action params, params parsed from an edited
  // prompt, then explicit caller params (highest precedence).
  const mergedParams = {
    ...sourceRun.params,
    ...registryActionParams,
    ...editedPromptParams,
    ...newParams,
  };

  const outpaintV2Id = findFirstNodeId(
    workflow,
    (n) => n.class_type === "TextEncodeKrea2Outpaint",
  );
  const padNodeId = (slots as { padNodeId?: string }).padNodeId;
  let seamPlacement: SeamPlacement | null = null;
  if (outpaintV2Id) {
    // v2 (krea2_outpaint LoRA): bbox reference placement + seamless composite
    seamPlacement = applyOutpaintV2Placement(workflow, mergedParams, sourceRun);
  } else if (padNodeId) {
    seamPlacement = applyOutpaintPadding(
      workflow,
      padNodeId,
      mergedParams,
      sourceRun,
    );
  }

  // Krea 2 edit "mode" (skill) dials: grounding_px / ref_boost / removal override.
  applyEditModeParams(workflow, mergedParams);

  // Get source job seed for variations
  const sourceJob = sourceRun.jobs[sourceJobIndex];

  // Point the workflow's image input at the source job's output. job.images
  // hold ComfyUI /view URLs; LoadImage wants the annotated form
  // "subfolder/filename [type]".
  const imageInputId = (slots as { imageInputId?: string }).imageInputId;
  const sourceImageRef = comfyImageRefFromViewUrl(sourceJob.images[0]);
  if (imageInputId && sourceImageRef) {
    setNodeInput(workflow, imageInputId, "image", sourceImageRef);
  }

  // Dual-reference edit modes (insert / try-on / swap): the 2nd reference is a
  // pre-uploaded annotated ComfyUI ref (from /api/comfy/upload). Inject it into
  // the SECOND LoadImage node (the one that isn't the source input).
  const secondRef = mergedParams.secondRefImage;
  if (typeof secondRef === "string" && secondRef.trim()) {
    for (const [id, node] of Object.entries(workflow)) {
      if (node.class_type === "LoadImage" && id !== imageInputId) {
        setNodeInput(workflow, id, "image", secondRef.trim());
        break;
      }
    }
  }
  const newSeed =
    (newParams.seed as number) ??
    (action.includes("vary")
      ? sourceJob.seed
      : Math.floor(Math.random() * 2147483647));

  // Inject parameters. A latent whose width/height are wired to another node
  // (pose_character sizes the canvas from the pose photo) keeps its links:
  // --ar / a chained run's ar must not replace them with numbers.
  const linkedDims = snapshotLinkedLatentDims(workflow, slots.latentDimsId);
  injectParams(
    workflow,
    slots,
    mergedParams,
    promptForInjection,
    (mergedParams.negativePrompt as string) ?? "",
    newSeed,
  );
  restoreLinkedLatentDims(workflow, slots.latentDimsId, linkedDims);

  applyOstrisEditKvCache(workflow, mergedParams.editLoraKvCache === true);
  if (action.startsWith("edit_") && imageInputId)
    fitEditLatentToSource(
      workflow,
      slots.latentDimsId,
      mergedParams.ar,
      sourceRun,
    );
  lockLatentToCropTarget(workflow, slots.latentDimsId);

  // Handle action-specific denoise values — registry-driven with fallback
  // The registry defines denoise values per template (e.g. vary_subtle: 0.25, remix_strong: 0.75),
  // and each action maps to a template. If the registry provides a denoise value, prefer it;
  // otherwise fall back to legacy hardcoded defaults for backward compatibility.
  const registryDenoise = getActionDenoise(action);

  if (registryDenoise !== undefined) {
    setNodeInput(workflow, slots.ksamplerId, "denoise", registryDenoise);
  }

  // Outpaint seam harmonize: low-denoise masked img2img over a feathered band
  // straddling the source edge, composited back (registry template toggle).
  // Runs after prompt/seed/sampler injection so the pass copies final values.
  if (seamPlacement) {
    const seamOpts = seamHarmonizeOptionsFor(action, mergedParams);
    if (seamOpts) {
      addSeamHarmonize(workflow, seamPlacement, seamOpts, slots.ksamplerId);
    }
  }

  // Optional full-res paste-back (CJImagePasteBack) for instruction edits.
  // Reads ONLY the caller's newParams: mergedParams carries the source run's
  // params, and a paste-back request must not leak into chained actions.
  if (action.startsWith("edit_") && imageInputId) {
    const pb = pasteBackRequest(newParams, false);
    if (pb.enabled)
      addImagePasteBack(workflow, {
        ...pb,
        originalId: imageInputId,
        fit: pasteBackFitFor(action),
      });
  }

  return { workflow, slots, seed: newSeed };
}

/**
 * CropAndStitch graphs (InpaintCropImproved with output_resize_to_target_size)
 * sample at the crop's fixed target size, not the source aspect: --ar / the
 * source run's dims must not resize the noise latent away from the crop
 * (the edit patch's source_latent comes from that crop).
 */
/** Linked (node-wired) width/height inputs of the latent, if any. */
export function snapshotLinkedLatentDims(
  workflow: Workflow,
  latentDimsId: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const inputs = latentDimsId ? workflow[latentDimsId]?.inputs : undefined;
  if (!inputs) return out;
  for (const key of ["width", "height"]) {
    if (Array.isArray(inputs[key])) out[key] = [...(inputs[key] as unknown[])];
  }
  return out;
}

/** Put back the links captured by snapshotLinkedLatentDims. */
export function restoreLinkedLatentDims(
  workflow: Workflow,
  latentDimsId: string | undefined,
  linked: Record<string, unknown>,
): void {
  const inputs = latentDimsId ? workflow[latentDimsId]?.inputs : undefined;
  if (!inputs) return;
  for (const [key, link] of Object.entries(linked)) inputs[key] = link;
}

/**
 * Instruction-edit graphs with a fixed 1024x1024 noise latent (Krea 2 edit,
 * Qwen-Image-Edit 2511, Ostris edit) render a square for any source: a
 * portrait came back centre-cropped (Krea 2) or squashed (Qwen). With no
 * --ar, size the latent to ~1 MP at the SOURCE's aspect (multiples of 16),
 * as the tools route does (fitLatentDims). Linked dims are left alone.
 */
export function fitEditLatentToSource(
  workflow: Workflow,
  latentDimsId: string | undefined,
  ar: unknown,
  sourceRun: Pick<ImagineRun, "width" | "height">,
): void {
  if (ar !== undefined && ar !== null && ar !== "") return;
  if (!latentDimsId || !workflow[latentDimsId]) return;
  const inputs = workflow[latentDimsId].inputs;
  if (typeof inputs.width !== "number" || typeof inputs.height !== "number")
    return;
  const w = Number(sourceRun.width);
  const h = Number(sourceRun.height);
  if (!(w > 0 && h > 0)) return;
  const scale = Math.sqrt((1024 * 1024) / (w * h));
  const snap = (n: number) => Math.max(256, Math.round((n * scale) / 16) * 16);
  inputs.width = snap(w);
  inputs.height = snap(h);
}

export function lockLatentToCropTarget(
  workflow: Workflow,
  latentDimsId: string | undefined,
): void {
  if (!latentDimsId || !workflow[latentDimsId]) return;
  const cropId = findFirstNodeId(
    workflow,
    (n) =>
      n.class_type === "InpaintCropImproved" &&
      n.inputs?.output_resize_to_target_size === true,
  );
  if (!cropId) return;
  const { output_target_width: w, output_target_height: h } =
    workflow[cropId].inputs;
  if (typeof w !== "number" || typeof h !== "number" || w <= 1 || h <= 1) {
    return;
  }
  if (hasNodeInput(workflow, latentDimsId, "width")) {
    setNodeInput(workflow, latentDimsId, "width", w);
    setNodeInput(workflow, latentDimsId, "height", h);
  }
}

/**
 * Enable the Ostris edit node's K/V cache only for a LoRA explicitly marked
 * as having been trained with ai-toolkit's `model_kwargs.kv_cache` option.
 * Leaving the flag absent keeps pre-toggle workflow JSON byte-for-byte intact.
 */
export function applyOstrisEditKvCache(
  workflow: Workflow,
  enabled: boolean,
): void {
  if (!enabled) return;

  for (const node of Object.values(workflow)) {
    if (node.class_type === "Krea2OstrisEditModelPatch") {
      node.inputs.kv_cache = true;
    }
  }
}

/**
 * Format parameters for display as chips/tags
 */
export function formatParamsForDisplay(
  params: Record<string, unknown>,
): string[] {
  const chips: string[] = [];

  const displayOrder = [
    "ar",
    "chaos",
    "stylize",
    "weird",
    "seed",
    "steps",
    "cfg",
    "quality",
  ];

  for (const key of displayOrder) {
    if (params[key] !== undefined && params[key] !== null) {
      const value = params[key];
      if (key === "ar") {
        chips.push(`${value}`);
      } else if (typeof value === "boolean") {
        if (value) chips.push(key);
      } else {
        chips.push(`${key} ${value}`);
      }
    }
  }

  // Add any remaining user-facing params not in display order (internal
  // bookkeeping like action_* / workflow paths / packId is filtered out).
  for (const [key, value] of Object.entries(params)) {
    if (!displayOrder.includes(key) && isDisplayableParam(key, value)) {
      const label = displayParamKey(key);
      if (typeof value === "boolean") {
        if (value) chips.push(label);
      } else if (Array.isArray(value)) {
        chips.push(`${label} ${value.join(", ")}`);
      } else {
        chips.push(`${label} ${value}`);
      }
    }
  }

  return chips;
}
