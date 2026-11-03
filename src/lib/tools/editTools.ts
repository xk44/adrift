/**
 * LoRA edit-tool catalog
 * A "tool" = one edit LoRA (or two) + the base pack workflow it rides on +
 * prompt/option metadata. The catalog (editToolRegistry.json) is served to
 * clients by GET /api/tools; POST /api/jobs/tool builds the ComfyUI graph with
 * `buildToolWorkflow` below and queues it. See docs/tools-api.md.
 *
 * Everything in here is pure/sync except the filesystem helpers at the bottom.
 */

import fs from "fs/promises";
import path from "path";
import registryJson from "./editToolRegistry.json";
import type { Workflow } from "@/types";
import { applyMossSpeedRecipe } from "@/lib/oj/mossImage";
import { findMissingClassTypes } from "@/lib/comfy/validatePrompt";
import { bypassMissingOptionalNodes } from "@/lib/comfy/optionalNodes";
import {
  loraFilesFromInfo,
  missingAgainstObjectInfo,
} from "@/lib/comfy/backendModels";
import { swapModelVariants } from "@/lib/comfy/modelVariants";
import {
  parseAspect,
  type OutpaintAnchor,
  type OutpaintSides,
  type Krea2OutpaintPass,
  type Krea2OutpaintPlacement,
  type AnyPaintPlacement,
  type OutpaintSpec,
} from "./outpaint";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

// Types

export type ToolBase = "qwen21" | "qwen2511" | "krea2" | "flux3" | "moss";
export type ToolGraphFamily =
  | "qwen21"
  | "qwen2511"
  | "flux3"
  | "krea2edit"
  | "ostris"
  /** MOSS-Image t2i + MOSSImageControl depth map from the source image. */
  | "moss"
  /** Krea 2 Turbo t2i + Krea2DualControlApply (CJ node) depth map from the source image. */
  | "krea2control"
  /**
   * Krea 2 Turbo + outpaint LoRA: the unpadded source is registered at a
   * canvas bbox (TextEncodeKrea2Outpaint) and blended back
   * (Krea2OutpaintComposite); needs BuildToolWorkflowInput.placement.
   */
  | "krea2outpaint"
  /**
   * Krea 2 Turbo + AnyPaint LoRA (comfyui-krea2-anypaint): arbitrary-mask
   * inpaint, optionally on a larger canvas; needs
   * BuildToolWorkflowInput.anypaint + maskRef.
   */
  | "krea2anypaint"
  /**
   * MOSS-Image Base + an Ostris edit LoRA (ComfyUI-MOSS-Image-Ostris-Edit):
   * the reference is VAE-encoded into TextEncodeMOSSImageOstrisEdit and the
   * MODEL is patched by MOSSImageOstrisEditModelPatch. Output size follows
   * the (FluxKontextImageScale'd) reference.
   */
  | "mossostris"
  /**
   * MOSS Toolkit i2i (sorryhyun, on OpenMOSS's moss-image loader): the LoRA is
   * loaded by MOSSi2iReference itself (not a LoraLoader chain) and the page
   * rides in as a clean VAE reference latent + through the vision tower.
   */
  | "mossi2i";
export type PromptMode = "none" | "optional" | "required";
/**
 * Server-side image prep. maskfill/redbox/scribble all consume the request
 * `mask` (tool.needsMask): maskfill blacks the region out, redbox outlines the
 * mask bounding box(es) in red, scribble paints the mask magenta.
 */
export type ToolPrep =
  | "none"
  | "outpaint"
  | "maskfill"
  | "redbox"
  | "scribble"
  /** Fit inside tool.letterbox (no crop) and pad gray to exactly that size. */
  | "letterbox"
  /**
   * AnyPaint: the original source + a source-sized binary mask (white =
   * generate) go to the nodes, which build the canvas; the `expand` enum
   * option (an outpaint preset id, or "none") grows the canvas. The mask may
   * be omitted only when expanding.
   */
  | "anypaint";

/** Preps that take a request `mask`. */
export const MASK_PREPS: readonly ToolPrep[] = [
  "maskfill",
  "redbox",
  "scribble",
  "anypaint",
];

/** AnyPaint enum option id whose value is an outpaint preset id or "none". */
export const ANYPAINT_EXPAND_OPTION = "expand";

export interface ToolLoraRef {
  /** ComfyUI lora name, e.g. "edit_tools/foo.safetensors". */
  file: string;
  strength: number;
}

export interface ToolLicense {
  name: string;
  /**
   * true = commercial OK, false = non-commercial, null = conditional: see
   * `badge` ("cap" = revenue-capped community license, "check" = the author
   * states no license).
   */
  commercial: boolean | null;
  note: string;
  badge?: "cap" | "check";
  /** Where the license was read (model card / LICENSE file). */
  source?: string;
}

export interface ToolOptionValue {
  id: string;
  label: string;
  /** Text spliced into the prompt template. */
  text: string;
  /** fixedLatent tools: this choice overrides the latent size. */
  latent?: { width: number; height: number };
  /** cameraAngle tools: CameraAngle node inputs this choice sets. */
  camera?: Partial<CameraAngleInputs>;
}

/** Inputs of the core ComfyUI CameraAngle node (comfy_extras/nodes_camera_angle.py). */
export interface CameraAngleInputs {
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
}

export interface ToolEnumOption {
  id: string;
  label: string;
  type: "enum";
  default: string;
  values: ToolOptionValue[];
}

export interface OutpaintPreset {
  id: string;
  label: string;
  sides?: OutpaintSides;
  aspect?: string;
  anchor?: OutpaintAnchor;
}

export interface EditToolDef {
  id: string;
  label: string;
  category: string;
  base: ToolBase;
  description: string;
  pack: string;
  packAction: string;
  graphFamily?: ToolGraphFamily;
  loras: ToolLoraRef[];
  extras: { keepFraming?: { default: boolean } };
  speed: { supported: boolean; default: boolean };
  defaults: { steps: number; cfg: number };
  refCount: 1 | 2;
  refLabels: string[];
  needsMask: boolean;
  /** Short UI hint for the mask painter (needsMask tools). */
  maskHint?: string;
  prep: ToolPrep;
  kvCache?: boolean;
  outpaint: { default: string; fill: string; maxSide: number } | null;
  /** prep "letterbox": exact canvas the source is fit + gray-padded into. */
  letterbox?: { width: number; height: number };
  /** TextEncodeQwenImage21.resolution override (0 = the image's own size). */
  encoderResolution?: number;
  /** qwen21: sample from an empty latent of this size, not the encoder's. */
  fixedLatent?: { width: number; height: number };
  /**
   * The camera option texts in the rendered prompt come from a core
   * CameraAngle node (driven by the options' `camera` inputs) instead of
   * literal text, as in the official qwen multiangle template.
   */
  cameraAngle?: boolean;
  promptMode: PromptMode;
  promptTemplate: string;
  promptHint: string;
  options: ToolEnumOption[];
  requiresNodes?: string;
  license?: ToolLicense;
  sourceUrl: string;
}

interface ToolRegistry {
  version: number;
  bases: Record<
    string,
    {
      label: string;
      pack: string;
      graph?: ToolGraphFamily;
      license: ToolLicense;
    }
  >;
  speedLoras: Record<
    string,
    {
      file: string;
      strength: number;
      steps: number;
      cfg: number;
      /** Short UI name of the speed LoRA ("Lightning", "4-step distill"). */
      label?: string;
    }
  >;
  extraLoras: Record<
    string,
    {
      label: string;
      description: string;
      /** Default LoRA (used for any base without an entry in `bases`). */
      lora: ToolLoraRef;
      /** Per-base override: description + LoRA file. */
      bases?: Record<string, { description?: string; lora: ToolLoraRef }>;
    }
  >;
  outpaintPresets: OutpaintPreset[];
  tools: EditToolDef[];
}

const REGISTRY = registryJson as unknown as ToolRegistry;

export class ToolRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

// Catalog accessors

export function getEditTools(): EditToolDef[] {
  return REGISTRY.tools;
}

export function getEditTool(id: unknown): EditToolDef | undefined {
  return typeof id === "string"
    ? REGISTRY.tools.find((t) => t.id === id)
    : undefined;
}

export function getOutpaintPresets(): OutpaintPreset[] {
  return REGISTRY.outpaintPresets;
}

export function getSpeedLora(base: ToolBase) {
  return REGISTRY.speedLoras[base];
}

export function getKeepFramingLora(base: ToolBase = "qwen21"): ToolLoraRef {
  const extra = REGISTRY.extraLoras.keepFraming;
  return extra.bases?.[base]?.lora ?? extra.lora;
}

function keepFramingDescription(base: ToolBase): string {
  const extra = REGISTRY.extraLoras.keepFraming;
  return extra.bases?.[base]?.description ?? extra.description;
}

export function toolGraphFamily(tool: EditToolDef): ToolGraphFamily {
  const family = tool.graphFamily ?? REGISTRY.bases[tool.base]?.graph;
  if (!family) throw new Error(`Tool ${tool.id} has no graph family`);
  return family;
}

export function toolLicense(tool: EditToolDef): ToolLicense {
  return tool.license ?? REGISTRY.bases[tool.base].license;
}

/** Every LoRA file any option of the tool can reference. */
export function allToolLoraFiles(tool: EditToolDef): string[] {
  const files = tool.loras.map((l) => l.file);
  if (tool.extras.keepFraming) files.push(getKeepFramingLora(tool.base).file);
  if (tool.speed.supported) {
    const speed = getSpeedLora(tool.base);
    if (speed) files.push(speed.file);
  }
  return files;
}

// Client-safe projection

export interface ToolAvailability {
  /** All of the tool's own LoRA files exist under COMFY_ROOT/models/loras. */
  installed: boolean;
  keepFramingInstalled: boolean;
  speedInstalled: boolean;
  /** Base workflow file exists, its UNET weight is on disk, and (when
   *  object_info was given) ComfyUI has every node class it uses. */
  packAvailable: boolean;
  /** Node classes the base graph needs that ComfyUI lacks (custom nodes). */
  missingNodes?: string[];
  /** Base weights ("<dir>/<file>") the GPU backend does not list, after the
   *  precision-variant fallback (object_info only). */
  missingModels?: string[];
}

export function toPublicTool(tool: EditToolDef, avail: ToolAvailability) {
  const speedLora = tool.speed.supported ? getSpeedLora(tool.base) : undefined;
  const keepFraming = tool.extras.keepFraming
    ? {
        label: REGISTRY.extraLoras.keepFraming.label,
        description: keepFramingDescription(tool.base),
        default: tool.extras.keepFraming.default,
        available: avail.keepFramingInstalled,
      }
    : null;
  return {
    id: tool.id,
    label: tool.label,
    category: tool.category,
    base: tool.base,
    baseLabel: REGISTRY.bases[tool.base].label,
    description: tool.description,
    loras: tool.loras,
    extras: { keepFraming },
    speed:
      speedLora && tool.speed.supported
        ? {
            supported: true,
            default: tool.speed.default,
            available: avail.speedInstalled,
            steps: speedLora.steps,
            cfg: speedLora.cfg,
            label: speedLora.label ?? "Speed LoRA",
          }
        : { supported: false },
    defaults: tool.defaults,
    refCount: tool.refCount,
    refLabels: tool.refLabels,
    needsMask: tool.needsMask,
    maskHint: tool.maskHint ?? null,
    outpaint: tool.outpaint
      ? {
          default: tool.outpaint.default,
          fill: tool.outpaint.fill,
          maxSide: tool.outpaint.maxSide,
          presets: REGISTRY.outpaintPresets,
        }
      : null,
    promptMode: tool.promptMode,
    promptTemplate: tool.promptTemplate,
    promptHint: tool.promptHint,
    options: tool.options,
    requiresNodes: tool.requiresNodes ?? null,
    license: toolLicense(tool),
    sourceUrl: tool.sourceUrl,
    installed: avail.installed,
    packAvailable: avail.packAvailable,
    missingNodes: avail.missingNodes ?? [],
    missingModels: avail.missingModels ?? [],
    available: avail.installed && avail.packAvailable,
  };
}

// Option resolution + prompt rendering

export interface ResolvedToolOptions {
  fast: boolean;
  keepFraming: boolean;
  steps: number;
  cfg: number;
  seed?: number;
  /** enum option id -> chosen value id (camera: azimuth/elevation/distance). */
  choices: Record<string, string>;
  /** Outpaint tools only. */
  outpaint?: { presetId?: string; spec: OutpaintSpec };
}

const GENERIC_OPTION_KEYS = new Set([
  "fast",
  "keepFraming",
  "steps",
  "cfg",
  "seed",
  "outpaint",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function fail(message: string, code = "invalid_options"): never {
  throw new ToolRequestError(message, code, 400);
}

function presetSpec(p: OutpaintPreset): OutpaintSpec {
  if (p.sides) return { kind: "sides", sides: p.sides };
  const aspect = parseAspect(p.aspect);
  if (aspect === null) fail(`Preset ${p.id} has an invalid aspect`);
  return { kind: "aspect", aspect, anchor: p.anchor ?? "center" };
}

/**
 * AnyPaint canvas growth from the `expand` enum choice: an outpaint preset
 * id, or undefined for "none" (same-canvas inpaint).
 */
export function anyPaintExpandSpec(
  tool: EditToolDef,
  choices: Record<string, string>,
): OutpaintSpec | undefined {
  if (tool.prep !== "anypaint") return undefined;
  const id = choices[ANYPAINT_EXPAND_OPTION];
  if (id === undefined || id === "none") return undefined;
  const preset = REGISTRY.outpaintPresets.find((p) => p.id === id);
  if (!preset) fail(`Unknown ${ANYPAINT_EXPAND_OPTION} preset "${id}"`);
  return presetSpec(preset);
}

function resolveOutpaint(
  tool: EditToolDef,
  raw: unknown,
): { presetId?: string; spec: OutpaintSpec } {
  const cfg = tool.outpaint;
  if (!cfg) fail(`options.outpaint is not supported by ${tool.id}`);
  const value = raw === undefined ? cfg.default : raw;

  if (typeof value === "string") {
    const preset = REGISTRY.outpaintPresets.find((p) => p.id === value);
    if (!preset) {
      fail(
        `Unknown outpaint preset "${value}". Valid: ${REGISTRY.outpaintPresets
          .map((p) => p.id)
          .join(", ")}`,
      );
    }
    return { presetId: preset.id, spec: presetSpec(preset) };
  }
  if (!isPlainObject(value)) {
    fail("options.outpaint must be a preset id string or an object");
  }
  if (typeof value.preset === "string") {
    return resolveOutpaint(tool, value.preset);
  }
  if (value.aspect !== undefined) {
    const aspect = parseAspect(value.aspect);
    if (aspect === null) {
      fail('options.outpaint.aspect must look like "16:9" (ratio 1:4 to 4:1)');
    }
    const anchor = value.anchor ?? "center";
    if (
      typeof anchor !== "string" ||
      !["center", "left", "right", "top", "bottom"].includes(anchor)
    ) {
      fail("options.outpaint.anchor must be center|left|right|top|bottom");
    }
    return {
      spec: { kind: "aspect", aspect, anchor: anchor as OutpaintAnchor },
    };
  }
  const sides: OutpaintSides = { left: 0, right: 0, top: 0, bottom: 0 };
  let any = false;
  for (const key of Object.keys(value)) {
    if (!(key in sides)) {
      fail(`Unknown options.outpaint field "${key}"`);
    }
    const n = value[key];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > cfg.maxSide
    ) {
      fail(
        `options.outpaint.${key} must be a number between 0 and ${cfg.maxSide} (fraction of the image side)`,
      );
    }
    sides[key as keyof OutpaintSides] = n;
    if (n > 0) any = true;
  }
  if (!any) fail("options.outpaint must add padding on at least one side");
  return { spec: { kind: "sides", sides } };
}

/** Validate + normalize client `options`. Throws ToolRequestError (400). */
export function resolveToolOptions(
  tool: EditToolDef,
  rawOptions: unknown,
): ResolvedToolOptions {
  if (
    rawOptions !== undefined &&
    rawOptions !== null &&
    !isPlainObject(rawOptions)
  ) {
    fail("options must be an object");
  }
  const raw = (rawOptions ?? {}) as Record<string, unknown>;
  const optionIds = new Set(tool.options.map((o) => o.id));
  for (const key of Object.keys(raw)) {
    if (!GENERIC_OPTION_KEYS.has(key) && !optionIds.has(key)) {
      fail(`Unknown option "${key}" for tool ${tool.id}`);
    }
  }

  // fast (speed LoRA)
  let fast = tool.speed.default;
  if (raw.fast !== undefined) {
    if (typeof raw.fast !== "boolean") fail("options.fast must be a boolean");
    if (raw.fast && !tool.speed.supported) {
      fail(`options.fast is not supported by ${tool.id}`);
    }
    fast = raw.fast;
  }
  if (fast && !getSpeedLora(tool.base)) {
    fail(`No speed LoRA configured for base ${tool.base}`);
  }

  // keepFraming (consistency LoRA)
  let keepFraming = tool.extras.keepFraming?.default ?? false;
  if (raw.keepFraming !== undefined) {
    if (typeof raw.keepFraming !== "boolean") {
      fail("options.keepFraming must be a boolean");
    }
    if (raw.keepFraming && !tool.extras.keepFraming) {
      fail(`options.keepFraming is not supported by ${tool.id}`);
    }
    keepFraming = raw.keepFraming;
  }

  // steps / cfg / seed
  const speed = fast ? getSpeedLora(tool.base) : undefined;
  let steps = speed ? speed.steps : tool.defaults.steps;
  let cfg = speed ? speed.cfg : tool.defaults.cfg;
  if (raw.steps !== undefined) {
    if (
      typeof raw.steps !== "number" ||
      !Number.isInteger(raw.steps) ||
      raw.steps < 1 ||
      raw.steps > 100
    ) {
      fail("options.steps must be an integer between 1 and 100");
    }
    steps = raw.steps;
  }
  if (raw.cfg !== undefined) {
    if (typeof raw.cfg !== "number" || !(raw.cfg >= 0 && raw.cfg <= 20)) {
      fail("options.cfg must be a number between 0 and 20");
    }
    cfg = raw.cfg;
  }
  let seed: number | undefined;
  if (raw.seed !== undefined) {
    if (
      typeof raw.seed !== "number" ||
      !Number.isInteger(raw.seed) ||
      raw.seed < 0 ||
      raw.seed > 2147483647
    ) {
      fail("options.seed must be an integer between 0 and 2147483647");
    }
    seed = raw.seed;
  }

  // tool-specific enums
  const choices: Record<string, string> = {};
  for (const opt of tool.options) {
    const chosen = raw[opt.id] ?? opt.default;
    if (
      typeof chosen !== "string" ||
      !opt.values.some((v) => v.id === chosen)
    ) {
      fail(
        `options.${opt.id} must be one of: ${opt.values.map((v) => v.id).join(", ")}`,
      );
    }
    choices[opt.id] = chosen;
  }

  // outpaint
  let outpaint: ResolvedToolOptions["outpaint"];
  if (tool.prep === "outpaint") {
    outpaint = resolveOutpaint(tool, raw.outpaint);
  } else if (raw.outpaint !== undefined) {
    fail(`options.outpaint is not supported by ${tool.id}`);
  }

  return { fast, keepFraming, steps, cfg, seed, choices, outpaint };
}

export const TOOL_PROMPT_MAX = 2000;

/** Strip control chars / trim. */
export function cleanToolPrompt(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").trim();
}

/**
 * Render the final prompt. `{prompt}` = user text; `{<optionId>}` = chosen
 * enum value text. `none` mode ignores user text.
 */
export function renderToolPrompt(
  tool: EditToolDef,
  userPrompt: string | undefined,
  choices: Record<string, string>,
): string {
  const text =
    tool.promptMode === "none" ? "" : cleanToolPrompt(userPrompt ?? "");
  if (tool.promptMode === "required" && !text) {
    throw new ToolRequestError(
      `prompt is required for ${tool.id}: ${tool.promptHint}`,
      "prompt_required",
      400,
    );
  }
  let out = tool.promptTemplate.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === "prompt") return text;
    const opt = tool.options.find((o) => o.id === key);
    if (!opt) return "";
    return opt.values.find((v) => v.id === choices[key])?.text ?? "";
  });
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** The ordered LoRA chain for a resolved request. */
export function resolveToolLoras(
  tool: EditToolDef,
  opts: Pick<ResolvedToolOptions, "fast" | "keepFraming">,
): ToolLoraRef[] {
  const chain: ToolLoraRef[] = tool.loras.map((l) => ({ ...l }));
  if (opts.keepFraming) chain.push({ ...getKeepFramingLora(tool.base) });
  if (opts.fast) {
    const speed = getSpeedLora(tool.base);
    if (speed) chain.push({ file: speed.file, strength: speed.strength });
  }
  return chain;
}

// Graph building

type Link = [string, number];

function isLink(v: unknown): v is [string | number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[1] === "number";
}

/** Drop pack metadata keys ("_comment", "_meta") — only real nodes remain. */
export function stripNonNodes(workflow: Record<string, unknown>): Workflow {
  const out: Workflow = {};
  for (const [id, node] of Object.entries(workflow)) {
    const n = node as { class_type?: unknown } | undefined;
    if (n && typeof n === "object" && typeof n.class_type === "string") {
      out[id] = n as Workflow[string];
    }
  }
  return out;
}

function nextNodeId(wf: Workflow): number {
  let max = 0;
  for (const id of Object.keys(wf)) {
    const n = Number(id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

function findNodes(wf: Workflow, classType: string): string[] {
  return Object.entries(wf)
    .filter(([, n]) => n.class_type === classType)
    .map(([id]) => id);
}

/**
 * Remove every LoraLoaderModelOnly (re-pointing consumers at its model input),
 * then chain `loras` after the diffusion-model loader and point everything that
 * used the raw model at the chain tail.
 */
export function insertLoraChain(wf: Workflow, loras: ToolLoraRef[]): string[] {
  const unetIds = findNodes(wf, "UNETLoader");
  if (unetIds.length !== 1) {
    throw new Error(
      `Expected exactly one UNETLoader in the base graph, found ${unetIds.length}`,
    );
  }
  const unetId = unetIds[0];

  // 1. strip existing lora loaders
  for (const loaderId of findNodes(wf, "LoraLoaderModelOnly")) {
    const upstream = wf[loaderId].inputs.model;
    delete wf[loaderId];
    for (const node of Object.values(wf)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (isLink(v) && String(v[0]) === loaderId) node.inputs[k] = upstream;
      }
    }
  }

  // 2. consumers of the raw model, before we add chain nodes
  const consumers: Array<[Workflow[string], string]> = [];
  for (const node of Object.values(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (isLink(v) && String(v[0]) === unetId && v[1] === 0) {
        consumers.push([node, k]);
      }
    }
  }

  // 3. chain
  let prev: Link = [unetId, 0];
  let id = nextNodeId(wf);
  const added: string[] = [];
  for (const lora of loras) {
    const nodeId = String(id++);
    wf[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: prev,
        lora_name: lora.file,
        strength_model: lora.strength,
      },
      _meta: { title: `Tool LoRA ${lora.file}` },
    };
    prev = [nodeId, 0];
    added.push(nodeId);
  }
  for (const [node, key] of consumers) node.inputs[key] = prev;
  return added;
}

function findPositivePromptNode(
  wf: Workflow,
  samplerId: string,
): { node: Workflow[string]; key: "prompt" | "text" } {
  let ref: unknown = wf[samplerId].inputs.positive;
  for (let hop = 0; hop < 8 && isLink(ref); hop++) {
    const node = wf[String(ref[0])];
    if (!node) break;
    if ("prompt" in node.inputs) return { node, key: "prompt" };
    if ("text" in node.inputs) return { node, key: "text" };
    ref = node.inputs.positive ?? node.inputs.conditioning;
  }
  throw new Error("Could not find the positive prompt node in the base graph");
}

export interface BuildToolWorkflowInput {
  /** Parsed base pack workflow (not mutated). */
  workflow: Workflow;
  tool: EditToolDef;
  prompt: string;
  loras: ToolLoraRef[];
  steps: number;
  cfg: number;
  seed: number;
  /** Annotated ComfyUI refs ("name.png [input]"), refCount long. */
  imageRefs: string[];
  /** Latent size override for graphs with an EmptySD3LatentImage. */
  latent?: { width: number; height: number };
  /** Resolved enum option choices (moss family reads structure / depth). */
  choices?: Record<string, string>;
  /** krea2outpaint family: canvas size + where the source sits on it. */
  placement?: Krea2OutpaintPlacement;
  /** krea2anypaint family: canvas + integer source bbox (single pass). */
  anypaint?: AnyPaintPlacement;
  /** krea2anypaint family: annotated ComfyUI ref of the source-sized mask. */
  maskRef?: string;
}

/** krea2anypaint: canvas/bbox on Krea2AnyPaintPrepare, mask on LoadImageMask. */
function applyKrea2AnyPaintGraph(
  wf: Workflow,
  input: BuildToolWorkflowInput,
): void {
  const p = input.anypaint;
  if (!p) throw new Error(`${input.tool.id} needs an AnyPaint placement`);
  if (!input.maskRef) throw new Error(`${input.tool.id} needs a mask image ref`);
  const prep = findNodes(wf, "Krea2AnyPaintPrepare");
  const masks = findNodes(wf, "LoadImageMask");
  if (prep.length !== 1 || masks.length !== 1) {
    throw new Error(
      `AnyPaint base graph needs exactly one Krea2AnyPaintPrepare and one LoadImageMask (found ${prep.length}, ${masks.length})`,
    );
  }
  Object.assign(wf[prep[0]].inputs, {
    canvas_width: p.canvasWidth,
    canvas_height: p.canvasHeight,
    bbox_x0: p.x0,
    bbox_y0: p.y0,
    bbox_x1: p.x1,
    bbox_y1: p.y1,
  });
  wf[masks[0]].inputs.image = input.maskRef;
}

/**
 * krea2outpaint: canvas/bbox on the encoder + composite, latent = canvas.
 * A two-pass placement clones encoder -> latent -> sampler -> decode ->
 * composite for pass 2, fed by pass 1's composite, and saves pass 2.
 */
function applyKrea2OutpaintGraph(
  wf: Workflow,
  input: BuildToolWorkflowInput,
): void {
  const passes = input.placement?.passes ?? [];
  if (passes.length < 1 || passes.length > 2) {
    throw new Error(`${input.tool.id} needs a 1- or 2-pass outpaint placement`);
  }
  const one = (cls: string) => {
    const ids = findNodes(wf, cls);
    if (ids.length !== 1) {
      throw new Error(`Outpaint base graph needs exactly one ${cls}, found ${ids.length}`);
    }
    return ids[0];
  };
  const ids = {
    encoder: one("TextEncodeKrea2Outpaint"),
    latent: one("EmptySD3LatentImage"),
    sampler: one("KSampler"),
    decode: one("VAEDecode"),
    composite: one("Krea2OutpaintComposite"),
  };
  const setPass = (
    n: { encoder: string; latent: string; composite: string },
    p: Krea2OutpaintPass,
  ) => {
    const geometry = {
      canvas_width: p.canvasWidth,
      canvas_height: p.canvasHeight,
      bbox_x0: p.x0,
      bbox_y0: p.y0,
      bbox_x1: p.x1,
      bbox_y1: p.y1,
    };
    Object.assign(wf[n.encoder].inputs, geometry);
    Object.assign(wf[n.composite].inputs, geometry);
    wf[n.latent].inputs.width = p.canvasWidth;
    wf[n.latent].inputs.height = p.canvasHeight;
  };
  setPass(ids, passes[0]);
  if (passes.length === 1) return;

  const stage1 = ids.composite;
  let next = nextNodeId(wf);
  const clone = (id: string, title: string) => {
    const newId = String(next++);
    wf[newId] = structuredClone(wf[id]);
    wf[newId]._meta = { title };
    return newId;
  };
  const enc2 = clone(ids.encoder, "Outpaint encode (pass 2)");
  const lat2 = clone(ids.latent, "Canvas (pass 2)");
  const ks2 = clone(ids.sampler, "KSampler (pass 2)");
  const dec2 = clone(ids.decode, "Decode (pass 2)");
  const comp2 = clone(ids.composite, "Composite (pass 2)");
  wf[enc2].inputs.image = [stage1, 0];
  Object.assign(wf[ks2].inputs, { positive: [enc2, 0], latent_image: [lat2, 0] });
  wf[dec2].inputs.samples = [ks2, 0];
  Object.assign(wf[comp2].inputs, { generated: [dec2, 0], source: [stage1, 0] });
  setPass({ encoder: enc2, latent: lat2, composite: comp2 }, passes[1]);
  for (const id of findNodes(wf, "SaveImage")) {
    wf[id].inputs.images = [comp2, 0];
  }
}

/** MOSS depth-control knobs, keyed by the tool's enum option value ids. */
export const MOSS_STRUCTURE_END: Record<string, number> = {
  strict: 1.0,
  loose: 0.5,
};
export const MOSS_DEPTH_MODELS: Record<string, string> = {
  base: "depth_anything_3_base.safetensors",
  large: "depth_anything_3_mono_large.safetensors",
};
/**
 * Krea 2 depth control: `depth_end` per structure choice. Loose = the model
 * card's "early control" depth end (0.6 of the steps).
 */
export const KREA2_STRUCTURE_END: Record<string, number> = {
  strict: 1.0,
  loose: 0.6,
};
/**
 * Krea 2 edit `ref_boost` (attention pull toward the last reference, i.e. the
 * head/person in swap graphs). Strong = 4.0, the BFS workflow's recommended
 * preset; past ~10 the model over-copies and replacements fail.
 */
export const KREA2_LIKENESS_BOOST: Record<string, number> = {
  classic: 1.0,
  strong: 4.0,
};
/** Region-map (color slot) end fractions; loose = the model card's "early control" 0.4. */
export const KREA2_LAYOUT_END: Record<string, number> = {
  strict: 1.0,
  loose: 0.4,
};

function setDepthModel(wf: Workflow, input: BuildToolWorkflowInput): void {
  const depthFile = MOSS_DEPTH_MODELS[input.choices?.depth ?? "base"];
  if (!depthFile) return;
  for (const id of findNodes(wf, "LoadDA3Model")) {
    wf[id].inputs.model_name = depthFile;
  }
}

/**
 * krea2control family: end fractions for whichever control slots the graph
 * wires (depth <- `structure`, region map <- `layout`) + depth model choice.
 */
function applyKrea2ControlGraph(
  wf: Workflow,
  input: BuildToolWorkflowInput,
): void {
  const control = findNodes(wf, "Krea2DualControlApply")[0];
  if (!control) throw new Error("Base graph has no Krea2DualControlApply");
  const inputs = wf[control].inputs;
  if (inputs.depth_image !== undefined) {
    const end = KREA2_STRUCTURE_END[input.choices?.structure ?? "strict"];
    if (end !== undefined) inputs.depth_end = end;
  }
  if (inputs.color_image !== undefined) {
    const end = KREA2_LAYOUT_END[input.choices?.layout ?? "strict"];
    if (end !== undefined) inputs.color_end = end;
  }
  setDepthModel(wf, input);
}

/**
 * moss family: depth model + control end_percent from the enum choices, the
 * DeBand speed recipe when the speed LoRA is in the chain, and the depth map
 * resized to the latent so MOSSImageControl's concat latent matches.
 */
function applyMossToolGraph(wf: Workflow, input: BuildToolWorkflowInput): void {
  const control = findNodes(wf, "MOSSImageControl")[0];
  if (!control) throw new Error("Base graph has no MOSSImageControl");
  const end = MOSS_STRUCTURE_END[input.choices?.structure ?? "strict"];
  if (end !== undefined) wf[control].inputs.end_percent = end;
  setDepthModel(wf, input);
  const speed = getSpeedLora("moss");
  if (speed && input.loras.some((l) => l.file === speed.file)) {
    applyMossSpeedRecipe(wf);
  }
}

/**
 * mossi2i family: MOSSi2iReference loads the i2i LoRA itself (it reads the
 * ref settings from the LoRA metadata), so the tool's single LoRA goes there.
 */
function applyMossI2iLora(wf: Workflow, loras: ToolLoraRef[]): void {
  const refs = findNodes(wf, "MOSSi2iReference");
  if (refs.length !== 1) {
    throw new Error(`Expected one MOSSi2iReference, found ${refs.length}`);
  }
  if (loras.length !== 1) {
    throw new Error(`mossi2i tools take exactly one LoRA, got ${loras.length}`);
  }
  wf[refs[0]].inputs.lora_name = loras[0].file;
  wf[refs[0]].inputs.strength = loras[0].strength;
}

const CAMERA_ANGLE_DEFAULTS: CameraAngleInputs = {
  horizontal_angle: 0,
  vertical_angle: 0,
  zoom: 5,
};

/** CameraAngle inputs for the chosen camera option values. */
export function toolCameraAngleInputs(
  tool: EditToolDef,
  choices: Record<string, string>,
): CameraAngleInputs {
  const out = { ...CAMERA_ANGLE_DEFAULTS };
  for (const opt of tool.options) {
    const value = opt.values.find((v) => v.id === (choices[opt.id] ?? opt.default));
    if (value?.camera) Object.assign(out, value.camera);
  }
  return out;
}

/**
 * Replace the camera span of the rendered prompt with a CameraAngle node's
 * STRING output, joined to the surrounding text with StringConcatenate.
 */
function applyCameraAngle(
  wf: Workflow,
  tool: EditToolDef,
  choices: Record<string, string>,
  promptNode: Workflow[string],
  key: "prompt" | "text",
  prompt: string,
): void {
  const span = tool.options
    .map((opt) => {
      const value = opt.values.find((v) => v.id === (choices[opt.id] ?? opt.default));
      return value?.camera ? value.text : "";
    })
    .filter(Boolean)
    .join(" ");
  const at = span ? prompt.indexOf(span) : -1;
  if (at < 0) {
    throw new Error(`cameraAngle prompt has no camera span (${tool.id})`);
  }
  const before = prompt.slice(0, at).trim();
  const after = prompt.slice(at + span.length).trim();

  const cameraId = String(nextNodeId(wf));
  wf[cameraId] = {
    class_type: "CameraAngle",
    inputs: { ...toolCameraAngleInputs(tool, choices) },
    _meta: { title: "Camera angle" },
  };
  let ref: [string, number] = [cameraId, 1];
  if (before) {
    const id = String(nextNodeId(wf));
    wf[id] = {
      class_type: "StringConcatenate",
      inputs: { string_a: before, string_b: ref, delimiter: " " },
      _meta: { title: "Camera prompt prefix" },
    };
    ref = [id, 0];
  }
  if (after) {
    const id = String(nextNodeId(wf));
    wf[id] = {
      class_type: "StringConcatenate",
      inputs: { string_a: ref, string_b: after, delimiter: " " },
      _meta: { title: "Camera prompt suffix" },
    };
    ref = [id, 0];
  }
  promptNode.inputs[key] = ref;
}

export function buildToolWorkflow(input: BuildToolWorkflowInput): Workflow {
  const { tool } = input;
  if (input.imageRefs.length !== tool.refCount) {
    throw new Error(
      `${tool.id} needs ${tool.refCount} image ref(s), got ${input.imageRefs.length}`,
    );
  }
  const wf: Workflow = structuredClone(stripNonNodes(input.workflow));
  const family = toolGraphFamily(tool);

  if (family === "mossi2i") applyMossI2iLora(wf, input.loras);
  else insertLoraChain(wf, input.loras);

  const samplerIds = findNodes(wf, "KSampler");
  if (samplerIds.length !== 1) {
    throw new Error(`Expected one KSampler, found ${samplerIds.length}`);
  }
  const samplerId = samplerIds[0];
  Object.assign(wf[samplerId].inputs, {
    steps: input.steps,
    cfg: input.cfg,
    seed: input.seed,
  });

  if (
    family === "qwen2511" &&
    findNodes(wf, "TextEncodeQwenImageEditPlus").length === 0
  ) {
    throw new Error("Base graph has no TextEncodeQwenImageEditPlus");
  }

  const { node: promptNode, key } = findPositivePromptNode(wf, samplerId);
  promptNode.inputs[key] = input.prompt;
  if (tool.cameraAngle) {
    applyCameraAngle(wf, tool, input.choices ?? {}, promptNode, key, input.prompt);
  }

  // images: first LoadImage = primary ref
  const loaders = findNodes(wf, "LoadImage").sort(
    (a, b) => Number(a) - Number(b),
  );
  if (loaders.length === 0) throw new Error("Base graph has no LoadImage node");
  wf[loaders[0]].inputs.image = input.imageRefs[0];

  if (tool.refCount === 2 && family === "krea2edit") {
    // the swap graphs already wire image 2 into the patch and both encoders
    if (loaders.length < 2) {
      throw new Error(`Base graph has no second LoadImage (${tool.id})`);
    }
    wf[loaders[1]].inputs.image = input.imageRefs[1];
  } else if (tool.refCount === 2) {
    if (family !== "qwen21") {
      throw new Error(
        `Two-reference tools are only wired for qwen21 and krea2edit (${tool.id})`,
      );
    }
    const encoderId = findNodes(wf, "TextEncodeQwenImage21")[0];
    if (!encoderId) throw new Error("Base graph has no TextEncodeQwenImage21");
    const newId = String(nextNodeId(wf));
    wf[newId] = {
      class_type: "LoadImage",
      inputs: { image: input.imageRefs[1], upload: "image" },
      _meta: { title: "Reference 2" },
    };
    wf[encoderId].inputs["images.image_2"] = [newId, 0];
  }

  if (tool.encoderResolution !== undefined) {
    const encoders = findNodes(wf, "TextEncodeQwenImage21");
    if (encoders.length === 0) {
      throw new Error(`encoderResolution needs a TextEncodeQwenImage21 (${tool.id})`);
    }
    for (const id of encoders) wf[id].inputs.resolution = tool.encoderResolution;
  }

  const fixedLatent = toolFixedLatent(tool, input.choices ?? {});
  if (fixedLatent) {
    if (family !== "qwen21") {
      throw new Error(`fixedLatent is only wired for qwen21 (${tool.id})`);
    }
    const latentId = String(nextNodeId(wf));
    wf[latentId] = {
      class_type: "EmptySD3LatentImage",
      inputs: { ...fixedLatent, batch_size: 1 },
      _meta: { title: "Fixed latent" },
    };
    wf[samplerId].inputs.latent_image = [latentId, 0];
  }

  if (input.latent) {
    for (const cls of [
      "EmptySD3LatentImage",
      "EmptyFlux2LatentImage",
      // moss / krea2control: the depth map must match the latent size
      "ImageScale",
    ]) {
      for (const id of findNodes(wf, cls)) {
        wf[id].inputs.width = input.latent.width;
        wf[id].inputs.height = input.latent.height;
      }
    }
  }

  if (family === "moss") applyMossToolGraph(wf, input);
  if (family === "krea2control") applyKrea2ControlGraph(wf, input);
  if (family === "krea2outpaint") applyKrea2OutpaintGraph(wf, input);
  if (family === "krea2anypaint") applyKrea2AnyPaintGraph(wf, input);
  if (family === "krea2edit" && input.choices?.likeness) {
    const boost = KREA2_LIKENESS_BOOST[input.choices.likeness];
    if (boost === undefined) throw new Error(`Unknown likeness ${input.choices.likeness}`);
    for (const id of findNodes(wf, "Krea2EditModelPatch")) {
      wf[id].inputs.ref_boost = boost;
    }
  }

  if (tool.kvCache) {
    for (const cls of ["Krea2OstrisEditModelPatch", "MOSSImageOstrisEditModelPatch"]) {
      for (const id of findNodes(wf, cls)) wf[id].inputs.kv_cache = true;
    }
  }

  for (const id of findNodes(wf, "SaveImage")) {
    wf[id].inputs.filename_prefix = `Adrift_${tool.id}`;
  }
  return wf;
}

/** Output size of a fixedLatent tool: a chosen option value's latent wins. */
export function toolFixedLatent(
  tool: EditToolDef,
  choices: Record<string, string>,
): { width: number; height: number } | undefined {
  if (!tool.fixedLatent) return undefined;
  for (const o of tool.options) {
    const v = o.values.find((x) => x.id === choices[o.id]);
    if (v?.latent) return { ...v.latent };
  }
  return { ...tool.fixedLatent };
}

/**
 * Graphs with a fixed 1024x1024 EmptySD3LatentImage (Krea 2 instruct edit,
 * Qwen-Image-Edit 2511) need the latent resized to the source aspect.
 */
export function toolNeedsLatentFit(tool: EditToolDef): boolean {
  if (tool.prep === "maskfill") return false; // sizes its own latent
  if (tool.prep === "outpaint") return false; // canvas comes from the plan
  if (tool.prep === "anypaint") return false; // canvas comes from planAnyPaint
  const family = toolGraphFamily(tool);
  return (
    family === "qwen2511" ||
    family === "moss" ||
    family === "krea2control" ||
    tool.base === "krea2"
  );
}

/** ~`megapixels` MP latent size matching the aspect of w x h, multiples of 16. */
export function fitLatentDims(
  width: number,
  height: number,
  megapixels = 1,
): { width: number; height: number } {
  const target = megapixels * 1024 * 1024;
  const scale = Math.sqrt(target / (width * height));
  const snap = (n: number) => Math.max(256, Math.round((n * scale) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

// ComfyUI image references

const REF_SEGMENT = /^[A-Za-z0-9._ -]+$/;
const REF_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export interface ComfyRef {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
}

/** "sub/name.png [input|output|temp]" -> parts (no traversal). */
export function parseComfyRef(raw: unknown): ComfyRef | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  const m = /^(.+) \[(input|output|temp)\]$/.exec(raw.trim());
  if (!m) return null;
  const segments = m[1].split("/");
  const name = segments[segments.length - 1];
  if (
    segments.some((s) => !REF_SEGMENT.test(s) || s === "." || s === "..") ||
    !REF_IMAGE_EXT.test(name)
  ) {
    return null;
  }
  return {
    filename: name,
    subfolder: segments.slice(0, -1).join("/"),
    type: m[2] as ComfyRef["type"],
  };
}

export function formatComfyRef(ref: ComfyRef): string {
  return `${ref.subfolder ? `${ref.subfolder}/` : ""}${ref.filename} [${ref.type}]`;
}

// Filesystem: installed LoRAs + pack availability

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i;

async function walk(
  dir: string,
  rel: string,
  out: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(path.join(dir, e.name), relPath, out, depth + 1);
    } else if (e.isFile() || e.isSymbolicLink()) {
      if (MODEL_EXT.test(e.name)) out.add(relPath.toLowerCase());
    }
  }
}

/**
 * Recursive listing of COMFY_ROOT/models/<subdir>: lowercase, "/"-separated
 * relative paths (the same names ComfyUI's loaders use).
 */
export async function listModelFiles(
  comfyRoot: string,
  subdir: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  await walk(comfyModelsPath(comfyRoot, subdir), "", out, 0);
  return out;
}

export function listInstalledLoras(comfyRoot: string): Promise<Set<string>> {
  return listModelFiles(comfyRoot, "loras");
}

/**
 * Installed LoRAs as the GPU backend sees them: its object_info LoRA list when
 * reachable (the web host's COMFY_ROOT may be another machine's disk), else the
 * local disk walk.
 */
export async function installedLorasFor(
  comfyRoot: string,
  objectInfo: Record<string, unknown> | null | undefined,
): Promise<Set<string>> {
  return loraFilesFromInfo(objectInfo) ?? listInstalledLoras(comfyRoot);
}

export function isLoraInstalled(installed: Set<string>, file: string): boolean {
  return installed.has(file.replace(/\\/g, "/").toLowerCase());
}

const WORKFLOWS_DIR = () => path.join(process.cwd(), "public", "workflows");

/** Load a pack workflow ("packs/qwen-image-21/edit.json") as a node graph. */
export async function loadPackWorkflow(rel: string): Promise<Workflow> {
  const raw = await fs.readFile(path.join(WORKFLOWS_DIR(), rel), "utf8");
  return stripNonNodes(JSON.parse(raw));
}

/**
 * Resolve the tool's base workflow path through the pack registry. Passed in by
 * the caller (packs.ts is env-gated for qwen21/flux3, so the route falls back
 * to a static map).
 */
export function toolWorkflowPath(
  tool: EditToolDef,
  packWorkflows: Partial<Record<string, string>> | undefined,
): string {
  const rel =
    packWorkflows?.[tool.packAction] ?? STATIC_WORKFLOWS[tool.packAction];
  if (!rel) {
    throw new Error(
      `No workflow for pack ${tool.pack} action ${tool.packAction}`,
    );
  }
  return rel;
}

/** Mirror of the packs.ts action -> file map (used when a pack is env-gated off). */
export const STATIC_WORKFLOWS: Record<string, string> = {
  edit_qwen21: "packs/qwen-image-21/edit.json",
  edit_flux3_fast: "packs/flux3/edit_fast.json",
  edit_qwen: "packs/qwen-image-edit/edit.json",
  edit_flux3: "packs/flux3/edit.json",
  edit_fibo: "packs/fibo2/edit.json",
  edit_fibo_dev: "packs/fibo2/edit_dev.json",
  edit_instruct: "packs/krea2-edit/edit_v2.json",
  edit_ostris: "packs/krea2-edit/edit_ostris.json",
  swap_head: "packs/krea2-edit/swap_head.json",
  swap_body: "packs/krea2-edit/swap_body.json",
  restyle_depth: "packs/moss-image/restyle_depth.json",
  moss_charref: "packs/moss-image/charref.json",
  moss_colorize: "packs/moss-image/colorize.json",
  control_depth: "packs/krea2/control_depth.json",
  control_regions: "packs/krea2/control_regions.json",
  outpaint_bbox: "packs/krea2/outpaintv2.json",
  anypaint: "packs/krea2/anypaint.json",
};

export async function computeAvailability(
  tool: EditToolDef,
  comfyRoot: string,
  installedLoras: Set<string>,
  packWorkflows?: Partial<Record<string, string>>,
  /** Live /object_info; null/undefined = unknown, node classes not checked. */
  objectInfo?: Record<string, unknown> | null,
): Promise<ToolAvailability> {
  let installed = tool.loras.every((l) =>
    isLoraInstalled(installedLoras, l.file),
  );
  const keepFramingInstalled = isLoraInstalled(
    installedLoras,
    getKeepFramingLora(tool.base).file,
  );
  const speed = getSpeedLora(tool.base);
  const speedInstalled = !!speed && isLoraInstalled(installedLoras, speed.file);

  let packAvailable = false;
  let missingNodes: string[] | undefined;
  let missingModels: string[] | undefined;
  try {
    const wf = await loadPackWorkflow(toolWorkflowPath(tool, packWorkflows));
    // DiT weights: UNETLoader files + the MOSS Toolkit loader's single-file DiT
    const unets = Object.values(wf).flatMap((n) =>
      n.class_type === "UNETLoader"
        ? [String(n.inputs.unet_name ?? "")]
        : n.class_type === "MOSSImageLoader"
          ? [String(n.inputs.dit ?? "")]
          : [],
    );
    // Disk check = offline fallback only: the web host's COMFY_ROOT is not
    // the GPU backend's disk, so a reachable /object_info decides below.
    if (unets.length > 0 && !objectInfo) {
      const [a, b] = await Promise.all([
        listModelFiles(comfyRoot, "diffusion_models"),
        listModelFiles(comfyRoot, "unet"),
      ]);
      packAvailable = unets.every(
        (u) => isLoraInstalled(a, u) || isLoraInstalled(b, u),
      );
    }
    // depth estimator weights (moss restyle): every model an option can pick
    const da3 = Object.values(wf).filter(
      (n) => n.class_type === "LoadDA3Model",
    );
    if (unets.length > 0 && objectInfo) packAvailable = true;
    if (packAvailable && da3.length > 0 && !objectInfo) {
      const geo = await listModelFiles(comfyRoot, "geometry_estimation");
      const needed = new Set(
        da3.map((n) => String(n.inputs.model_name ?? "")),
      );
      const fam = toolGraphFamily(tool);
      if (fam === "moss" || fam === "krea2control") {
        const depthOpt = tool.options.find((o) => o.id === "depth");
        for (const v of depthOpt?.values ?? []) {
          const f = MOSS_DEPTH_MODELS[v.id];
          if (f) needed.add(f);
        }
      }
      packAvailable = [...needed].every((f) => isLoraInstalled(geo, f));
    }
    // control adapters loaded by a custom node (not the LoRA chain) are the tool's own weights
    const adapters = Object.values(wf)
      .filter((n) => n.class_type === "Krea2DualControlApply")
      .map((n) => String(n.inputs.adapter_name ?? ""));
    if (adapters.length > 0) {
      installed =
        installed && adapters.every((f) => isLoraInstalled(installedLoras, f));
    }
    if (objectInfo) {
      // Custom nodes the graph needs (after the optional-node bypass).
      const { prompt } = bypassMissingOptionalNodes(wf, objectInfo);
      const missingClasses = findMissingClassTypes(prompt, objectInfo);
      // nodes buildToolWorkflow adds on top of the pack graph
      if (tool.cameraAngle) {
        for (const cls of ["CameraAngle", "StringConcatenate"]) {
          if (!(cls in objectInfo) && !missingClasses.includes(cls)) missingClasses.push(cls);
        }
      }
      if (missingClasses.length > 0) {
        packAvailable = false;
        missingNodes = missingClasses;
      }
      // Base weights as the backend lists them (extra_model_paths and all),
      // after the precision fallback queuePrompt applies. LoRAs are the
      // `installed` check's job (pack graphs carry placeholder LoRA names).
      const swapped = swapModelVariants(prompt, objectInfo).prompt;
      const files = missingAgainstObjectInfo(swapped, objectInfo).filter(
        (m) => !m.startsWith("node:") && !m.startsWith("loras/"),
      );
      if (files.length > 0) {
        packAvailable = false;
        missingModels = files;
      }
    }
  } catch {
    packAvailable = false;
    if (toolGraphFamily(tool) === "krea2control") installed = false;
  }
  return {
    installed,
    keepFramingInstalled,
    speedInstalled,
    packAvailable,
    ...(missingNodes ? { missingNodes } : {}),
    ...(missingModels ? { missingModels } : {}),
  };
}
