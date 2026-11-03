/**
 * Pure helpers shared by WorkflowControlPanel and its editor components.
 */
import type { LocalInventory } from "@/lib/oj/workflowControlSchema";

// Recently used models (localStorage)

const LS_RECENT_MODELS_KEY = "cj-recent-models";
const MAX_RECENT_MODELS = 5;

export function readRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT_MODELS_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    /* ignore */
  }
  return [];
}

export function writeRecentModels(models: string[]): void {
  try {
    localStorage.setItem(LS_RECENT_MODELS_KEY, JSON.stringify(models));
  } catch {
    /* ignore */
  }
}

export function pushRecentModel(model: string): void {
  const current = readRecentModels().filter((m) => m !== model);
  current.unshift(model);
  writeRecentModels(current.slice(0, MAX_RECENT_MODELS));
}

// Base model detection from filename

export type BaseModelType = "Flux" | "SDXL" | "SD3" | "SD1.5" | "Other";

export function detectBaseModel(filename: string): BaseModelType {
  const lower = filename.toLowerCase();
  if (lower.includes("flux") || lower.includes("f1-")) return "Flux";
  if (
    lower.includes("sdxl") ||
    lower.includes("xl") ||
    lower.includes("juggernaut") ||
    lower.includes("realvisxl") ||
    lower.includes("albedobase")
  )
    return "SDXL";
  if (lower.includes("sd3") || lower.includes("stable-diffusion-3"))
    return "SD3";
  if (
    lower.includes("sd15") ||
    lower.includes("sd1.5") ||
    lower.includes("v1-5") ||
    lower.includes("realisticvision") ||
    lower.includes("dreamshaper") ||
    lower.includes("deliberate") ||
    lower.includes("epicrealism")
  )
    return "SD1.5";
  return "Other";
}

export const BASE_MODEL_BADGE: Record<BaseModelType, string> = {
  Flux: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  SDXL: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  SD3: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20",
  "SD1.5": "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  Other: "bg-dark-700/60 text-dark-400 border-dark-600",
};

/**
 * Group model filenames by base architecture for picker UX.
 * Returns groups in canonical order plus an optional "Other" bucket.
 */
export function groupModelsByBase(
  options: string[],
): Array<{ type: BaseModelType; models: string[] }> {
  const groups: Record<BaseModelType, string[]> = {
    Flux: [],
    SDXL: [],
    SD3: [],
    "SD1.5": [],
    Other: [],
  };
  for (const m of options) {
    groups[detectBaseModel(m)].push(m);
  }
  const ORDER: BaseModelType[] = ["Flux", "SDXL", "SD3", "SD1.5", "Other"];
  return ORDER.map((t) => ({ type: t, models: groups[t] })).filter(
    (g) => g.models.length > 0,
  );
}

// Snap values for common 0-1 range controls (denoise, strength, weight, etc.)

const SNAP_KEYS = new Set([
  "denoise",
  "strength",
  "strength_model",
  "strength_clip",
  "weight",
  "start_percent",
  "end_percent",
  "start_at",
  "end_at",
  "cfg_scale",
]);
const SNAP_VALUES = [0.0, 0.25, 0.5, 0.75, 1.0];
const SNAP_THRESHOLD = 0.04; // snap within this distance

export function snapToCommon(value: number, inputKey: string): number {
  if (!SNAP_KEYS.has(inputKey)) return value;
  for (const sv of SNAP_VALUES) {
    if (Math.abs(value - sv) < SNAP_THRESHOLD) return sv;
  }
  return value;
}

/**
 * Returns true for string inputs that are likely long-form prompts and
 * should render as a textarea rather than a single-line input.
 */
export function isPromptLike(inputKey: string): boolean {
  const promptKeys = new Set([
    "text",
    "prompt",
    "positive",
    "negative",
    "positive_prompt",
    "negative_prompt",
    "caption",
    "description",
  ]);
  if (promptKeys.has(inputKey)) return true;
  return /\bprompt\b|\bcaption\b|\bdescription\b/i.test(inputKey);
}

// Build a ModelInventory from useModelStore's available shape

export function buildInventoryFromModelStore(storeAvailable: {
  checkpoints: string[];
  loras: string[];
  vaes: string[];
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
  samplers: string[];
  schedulers: string[];
  enumOptions?: Record<string, Record<string, string[]>>;
  input_images?: string[];
  input_videos?: string[];
  input_audios?: string[];
}): LocalInventory {
  return {
    checkpoints: storeAvailable.checkpoints,
    loras: storeAvailable.loras,
    vaes: storeAvailable.vaes,
    controlnet: storeAvailable.controlnet ?? [],
    upscale_models: storeAvailable.upscale_models ?? [],
    clip: storeAvailable.clip ?? [],
    unet: storeAvailable.unet ?? [],
    ipadapter: storeAvailable.ipadapter ?? [],
    embeddings: storeAvailable.embeddings ?? [],
    gligen: storeAvailable.gligen ?? [],
    hypernetworks: storeAvailable.hypernetworks ?? [],
    diffusers: storeAvailable.diffusers ?? [],
    animatediff_models: storeAvailable.animatediff_models ?? [],
    video_models: storeAvailable.video_models ?? [],
    style_models: storeAvailable.style_models ?? [],
    samplers: storeAvailable.samplers,
    schedulers: storeAvailable.schedulers,
    enumOptions: storeAvailable.enumOptions ?? {},
    input_images: storeAvailable.input_images ?? [],
    input_videos: storeAvailable.input_videos ?? [],
    input_audios: storeAvailable.input_audios ?? [],
  };
}

// Kind-specific styling

export const KIND_DOT_COLORS: Record<string, string> = {
  number: "bg-blue-400",
  seed: "bg-violet-400",
  string: "bg-emerald-400",
  enum: "bg-amber-400",
  boolean: "bg-cyan-400",
  image: "bg-pink-400",
  model: "bg-purple-400",
  file: "bg-orange-400",
};
