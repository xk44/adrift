/**
 * Civitai model-search enums — ground truth pulled from the live
 * civitai.com /api/v1 zod validation errors + a 200-probe of every sort.
 * Shared by the server route (whitelisting) and the
 * Explore / Workflows filter bar (pickers + base-model families).
 *
 * Multi-value params (types, baseModels) must be sent REPEATED
 * (`types=LORA&types=DoRA`) — the comma form fails Civitai's validation.
 */

export const CIVITAI_MODEL_SORTS = [
  "Highest Rated",
  "Most Downloaded",
  "Most Liked",
  "Most Discussed",
  "Most Collected",
  "Most Images",
  "Newest",
  "Oldest",
] as const;
export type CivitaiModelSort = (typeof CIVITAI_MODEL_SORTS)[number];

export const CIVITAI_IMAGE_SORTS = [
  "Most Reactions",
  "Most Comments",
  "Most Collected",
  "Newest",
  "Oldest",
] as const;
export type CivitaiImageSort = (typeof CIVITAI_IMAGE_SORTS)[number];

export const CIVITAI_PERIODS = [
  "Day",
  "Week",
  "Month",
  "Year",
  "AllTime",
] as const;
export type CivitaiPeriod = (typeof CIVITAI_PERIODS)[number];

export const CIVITAI_PERIOD_LABELS: Record<CivitaiPeriod, string> = {
  Day: "Day",
  Week: "Week",
  Month: "Month",
  Year: "Year",
  AllTime: "All Time",
};

export const CIVITAI_MODEL_TYPES = [
  "Checkpoint",
  "TextualInversion",
  "Hypernetwork",
  "AestheticGradient",
  "LORA",
  "LoCon",
  "DoRA",
  "Controlnet",
  "Upscaler",
  "MotionModule",
  "VAE",
  "TextEncoder",
  "UNet",
  "CLIPVision",
  "Poses",
  "Wildcards",
  "Workflows",
  "ComfyWorkflows",
  "Detection",
  "VisionLanguage",
  "CLIP",
  "LLM",
  "Other",
] as const;
export type CivitaiModelType = (typeof CIVITAI_MODEL_TYPES)[number];

/** Types the LoRAs tab is scoped to (Civitai's own "LoRA" bucket). */
export const CIVITAI_LORA_TYPES: readonly CivitaiModelType[] = [
  "LORA",
  "LoCon",
  "DoRA",
];

export const CIVITAI_MODEL_TYPE_LABELS: Partial<
  Record<CivitaiModelType, string>
> = {
  TextualInversion: "Embedding",
  AestheticGradient: "Aesthetic Gradient",
  LORA: "LoRA",
  Controlnet: "ControlNet",
  MotionModule: "Motion",
  TextEncoder: "Text Encoder",
  CLIPVision: "CLIP Vision",
  ComfyWorkflows: "Comfy Workflows",
  VisionLanguage: "Vision-Language",
};

export function civitaiTypeLabel(type: string): string {
  return CIVITAI_MODEL_TYPE_LABELS[type as CivitaiModelType] ?? type;
}

export const CIVITAI_CHECKPOINT_TYPES = ["Trained", "Merge"] as const;
export type CivitaiCheckpointType = (typeof CIVITAI_CHECKPOINT_TYPES)[number];

export const CIVITAI_IMAGE_NSFW_LEVELS = [
  "None",
  "Soft",
  "Mature",
  "X",
  "Blocked",
] as const;
export type CivitaiImageNsfwLevel = (typeof CIVITAI_IMAGE_NSFW_LEVELS)[number];

export const CIVITAI_BASE_MODELS = [
  "Anima",
  "AuraFlow",
  "Chroma",
  "CogVideoX",
  "Ernie",
  "Flux.1 S",
  "Flux.1 D",
  "Flux.1 Krea",
  "Flux.1 Kontext",
  "Flux.2 D",
  "Flux.2 Klein 9B",
  "Flux.2 Klein 9B-base",
  "Flux.2 Klein 4B",
  "Flux.2 Klein 4B-base",
  "Flux.3",
  "Flux.3 Klein",
  "Flux.3 Klein-base",
  "MOSS Image",
  "Flux 3 Video",
  "Grok",
  "HappyHorse",
  "HiDream",
  "HiDream-O1",
  "Hunyuan 1",
  "Hunyuan Video",
  "Ideogram 4.0",
  "Ideogram 4.5",
  "Boogu",
  "Illustrious",
  "Imagen4",
  "Kolors",
  "Krea 2",
  "Krea 2 Turbo",
  "Krea 3",
  "LTXV",
  "LTXV2",
  "LTXV 2.3",
  "LTXV 2.5",
  "Lens",
  "Lumina",
  "MageFlow",
  "MAI",
  "Mochi",
  "Nano Banana",
  "NoobAI",
  "ODOR",
  "OpenAI",
  "Upscaler",
  "Other",
  "PixArt a",
  "PixArt E",
  "Playground v2",
  "Pony",
  "Pony V7",
  "Qwen",
  "Qwen 2",
  "Qwen 2.1",
  "Qwen 3",
  "Stable Cascade",
  "SD 1.4",
  "SD 1.5",
  "SD 1.5 LCM",
  "SD 1.5 Hyper",
  "SD 2.0",
  "SD 2.0 768",
  "SD 2.1",
  "SD 2.1 768",
  "SD 2.1 Unclip",
  "SD 3",
  "SD 3.5",
  "SD 3.5 Large",
  "SD 3.5 Large Turbo",
  "SD 3.5 Medium",
  "SDXL 0.9",
  "SDXL 1.0",
  "SDXL 1.0 LCM",
  "SDXL Lightning",
  "SDXL Hyper",
  "SDXL Turbo",
  "SDXL Distilled",
  "Reve",
  "Muse Image",
  "Seedream",
  "SVD",
  "SVD XT",
  "Sora 2",
  "Veo 3",
  "Wan Video",
  "Wan Video 1.3B t2v",
  "Wan Video 14B t2v",
  "Wan Video 14B i2v 480p",
  "Wan Video 14B i2v 720p",
  "Wan Video 2.2 TI2V-5B",
  "Wan Video 2.2 I2V-A14B",
  "Wan Video 2.2 T2V-A14B",
  "Wan Video 2.5 T2V",
  "Wan Video 2.5 I2V",
  "Wan Image 2.7",
  "Wan Video 2.7",
  "Wan Video 3.0",
  "ZImageTurbo",
  "ZImageBase",
  "Ming Image Design 0.1",
  "Ming Image Design Layer 0.1",
  "Vidu Q1",
  "MiniMax H3",
  "Kling",
  "Seedance",
  "ACE Audio",
  "MiniMax Music 3",
  "YuE2",
  "Sonilo",
  "PolyGen",
  "Tripo",
  "Hunyuan3D",
  "Pixal3D",
  "Trellis.2",
] as const;
export type CivitaiBaseModel = (typeof CIVITAI_BASE_MODELS)[number];

// Base-model families (UI grouping so the picker isn't a 117-item wall)

export const BASE_MODEL_FAMILIES = [
  "Flux",
  "SDXL",
  "SD1.x",
  "SD2 / SD3",
  "Wan",
  "LTX",
  "Qwen",
  "Krea",
  "Pony / Illustrious / Noob",
  "Video",
  "Audio",
  "3D",
  "Other",
] as const;
export type BaseModelFamily = (typeof BASE_MODEL_FAMILIES)[number];

const VIDEO_BASES = new Set<string>([
  "CogVideoX",
  "Flux 3 Video",
  "Hunyuan Video",
  "Mochi",
  "SVD",
  "SVD XT",
  "Sora 2",
  "Veo 3",
  "Vidu Q1",
  "MiniMax H3",
  "Kling",
  "Seedance",
]);
const AUDIO_BASES = new Set<string>([
  "ACE Audio",
  "MiniMax Music 3",
  "YuE2",
  "Sonilo",
]);
const THREE_D_BASES = new Set<string>([
  "PolyGen",
  "Tripo",
  "Hunyuan3D",
  "Pixal3D",
  "Trellis.2",
]);
const ANIME_BASES = new Set<string>([
  "Pony",
  "Pony V7",
  "Illustrious",
  "NoobAI",
]);

/** Family for a base model name. Unknown/new names land in "Other". */
export function baseModelFamily(name: string): BaseModelFamily {
  // Video bases first: "Flux 3 Video" is a video model, not a Flux image base.
  if (VIDEO_BASES.has(name)) return "Video";
  if (/^Flux/i.test(name)) return "Flux";
  if (/^SDXL/.test(name)) return "SDXL";
  if (/^SD 1\./.test(name)) return "SD1.x";
  if (/^SD [23]/.test(name) || name === "Stable Cascade") return "SD2 / SD3";
  if (/^Wan /.test(name)) return "Wan";
  if (/^LTXV/.test(name)) return "LTX";
  if (/^Qwen/.test(name)) return "Qwen";
  if (/^Krea /.test(name)) return "Krea";
  if (ANIME_BASES.has(name)) return "Pony / Illustrious / Noob";
  if (AUDIO_BASES.has(name)) return "Audio";
  if (THREE_D_BASES.has(name)) return "3D";
  return "Other";
}

export interface BaseModelGroup {
  family: BaseModelFamily;
  models: CivitaiBaseModel[];
}

/** All base models grouped by family, families in display order. */
export const BASE_MODEL_GROUPS: BaseModelGroup[] = BASE_MODEL_FAMILIES.map(
  (family) => ({
    family,
    models: CIVITAI_BASE_MODELS.filter((m) => baseModelFamily(m) === family),
  }),
).filter((g) => g.models.length > 0);

/** Groups filtered by a case-insensitive search across model + family name. */
export function searchBaseModelGroups(query: string): BaseModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return BASE_MODEL_GROUPS;
  return BASE_MODEL_GROUPS.map((g) =>
    g.family.toLowerCase().includes(q)
      ? g
      : { ...g, models: g.models.filter((m) => m.toLowerCase().includes(q)) },
  ).filter((g) => g.models.length > 0);
}

// Guards

const SORT_SET = new Set<string>(CIVITAI_MODEL_SORTS);
const PERIOD_SET = new Set<string>(CIVITAI_PERIODS);
const TYPE_SET = new Set<string>(CIVITAI_MODEL_TYPES);
const BASE_SET = new Set<string>(CIVITAI_BASE_MODELS);
const CKPT_SET = new Set<string>(CIVITAI_CHECKPOINT_TYPES);

export const isCivitaiModelSort = (v: unknown): v is CivitaiModelSort =>
  typeof v === "string" && SORT_SET.has(v);
export const isCivitaiPeriod = (v: unknown): v is CivitaiPeriod =>
  typeof v === "string" && PERIOD_SET.has(v);
export const isCivitaiModelType = (v: unknown): v is CivitaiModelType =>
  typeof v === "string" && TYPE_SET.has(v);
export const isCivitaiBaseModel = (v: unknown): v is CivitaiBaseModel =>
  typeof v === "string" && BASE_SET.has(v);
export const isCivitaiCheckpointType = (
  v: unknown,
): v is CivitaiCheckpointType => typeof v === "string" && CKPT_SET.has(v);

/** Civitai usernames: letters, digits, `_`, `-`, `.` (max 64). */
export const CIVITAI_USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Civitai model cursors look like `778|7433|1349631`. */
export const CIVITAI_CURSOR_RE = /^[A-Za-z0-9|_.:-]{1,128}$/;
