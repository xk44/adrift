/**
 * Upscale model choice (shared by the Upscale tool, Lightbox, Gallery and
 * Quick edit) and the Faithful / Creative knobs. Pure: safe on client and
 * server.
 *
 *   Faithful (upscale_subtle):  model upscale only — no diffusion, so nothing
 *                               is invented. Size follows the model (2x/4x…).
 *   Creative (upscale_creative): model upscale → 2x → tiled low-denoise
 *                               re-render that adds fine detail; `creativity`
 *                               (0–100) sets the denoise.
 *   Re-detail (upscale_redetail): UltimateSDUpscale on the current image
 *                               model's img2img graph at 1.5–4x, 15–45 %
 *                               denoise.
 *   Faithful takes an exact `size`; any image mode takes a 1x `cleanup`
 *   pre-pass. video_upscale is the per-frame clip variant.
 *
 * Options come from UpscaleModelLoader.model_name in /object_info, read via
 * comboOptions so both the legacy `[[...]]` and the ComfyUI 0.4x
 * `["COMBO", {options}]` formats work.
 */
import { comboOptions } from "@/lib/comfy/validatePrompt";
import { upscaleFinishParams } from "./upscaleFinish";
import {
  describeUpscaler,
  type UpscalerCategory,
  type UpscalerTag,
} from "./upscalerCatalog";

export const UPSCALE_SUBTLE_ACTION = "upscale_subtle";
export const UPSCALE_CREATIVE_ACTION = "upscale_creative";
export const UPSCALE_REDETAIL_ACTION = "upscale_redetail";
/** Per-frame model upscale of a clip (lib/oj/videoUpscale). */
export const VIDEO_UPSCALE_ACTION = "video_upscale";
export const IMAGE_UPSCALE_ACTIONS: ReadonlySet<string> = new Set([
  UPSCALE_SUBTLE_ACTION,
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_REDETAIL_ACTION,
]);
export const UPSCALE_ACTIONS: ReadonlySet<string> = new Set([
  ...IMAGE_UPSCALE_ACTIONS,
  VIDEO_UPSCALE_ACTION,
]);

/** /api/jobs/action params keys. */
export const UPSCALE_MODEL_PARAM = "upscale_model";
export const UPSCALE_CREATIVITY_PARAM = "creativity";
/** Output size (UPSCALE_SIZES id; video: VIDEO_UPSCALE_SCALES id). */
export const UPSCALE_SIZE_PARAM = "size";
/** 1x clean-up pass before the upscale (CLEANUP_MODELS key). */
export const UPSCALE_CLEANUP_PARAM = "cleanup";
/** Re-detail strength, percent (REDETAIL_MIN–REDETAIL_MAX). */
export const UPSCALE_REDETAIL_PARAM = "redetail";

/** Creativity slider (0–100) → KSampler denoise. */
export const CREATIVITY_MIN = 0;
export const CREATIVITY_MAX = 100;
export const CREATIVITY_DEFAULT = 35;
/**
 * Piecewise-linear: 0 → 0.10, default (35) → 0.20, 100 → 0.50. The default
 * sits low because GPU sweeps (2026-10-31, krea2 turbo) showed face drift and
 * invented details growing fast above ~0.2; the top half of the slider is
 * there for people who want that.
 */
const DENOISE_AT_MIN = 0.1;
const DENOISE_AT_DEFAULT = 0.2;
const DENOISE_AT_MAX = 0.5;

/** Creative always lands at 2x the source, whatever the model's factor. */
export const CREATIVE_TARGET_SCALE = 2;
/** Factor assumed when a file name does not say (most upscalers are 4x). */
export const DEFAULT_MODEL_SCALE = 4;

export const UPSCALE_MODE_HINTS: Record<string, string> = {
  [UPSCALE_SUBTLE_ACTION]:
    "Faithful keeps every pixel honest: a bigger, sharper copy with nothing added. Size follows the model (most are 4×).",
  [UPSCALE_CREATIVE_ACTION]:
    "Creative invents fine detail (skin, fabric, foliage) while doubling the size. More creativity adds more new detail and drifts further from the original.",
  [UPSCALE_REDETAIL_ACTION]:
    "Re-detail redraws the picture tile by tile with your current image model at low strength: crisp new micro-detail at any size, close to the original.",
  [VIDEO_UPSCALE_ACTION]:
    "Upscales every frame of the clip with your video upscaler (fast, no new detail invented).",
};

/** Output size choices for Faithful (id → exact factor or long edge in px). */
export type UpscaleSize =
  | { kind: "model" }
  | { kind: "factor"; factor: number }
  | { kind: "long"; px: number };

export const UPSCALE_SIZES: { id: string; label: string; size: UpscaleSize }[] =
  [
    { id: "model", label: "Model", size: { kind: "model" } },
    { id: "1.5x", label: "1.5×", size: { kind: "factor", factor: 1.5 } },
    { id: "2x", label: "2×", size: { kind: "factor", factor: 2 } },
    { id: "3x", label: "3×", size: { kind: "factor", factor: 3 } },
    { id: "4x", label: "4×", size: { kind: "factor", factor: 4 } },
    { id: "2048", label: "2048 px", size: { kind: "long", px: 2048 } },
    { id: "3840", label: "4K (3840 px)", size: { kind: "long", px: 3840 } },
  ];

export function upscaleSize(value: unknown): UpscaleSize {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UPSCALE_SIZES.find((s) => s.id === v)?.size ?? { kind: "model" };
}

/** Re-detail sizes: a tiled re-render needs a plain factor. */
export const REDETAIL_SIZES = UPSCALE_SIZES.filter(
  (s) => s.size.kind === "factor",
);
export const REDETAIL_DEFAULT_SIZE = "2x";

export function redetailFactor(value: unknown): number {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  const hit = REDETAIL_SIZES.find((s) => s.id === v)?.size;
  return hit?.kind === "factor" ? hit.factor : 2;
}

/** 1x restoration models for "Clean up first" (all on the GPU box). */
export const CLEANUP_MODELS: Record<string, { file: string; label: string }> = {
  dejpeg: { file: "1x-Kim2091-DeJpeg-v0.pth", label: "JPEG artifacts" },
  gainres: { file: "1x_GainRESV3_Natural.pth", label: "Noise / blur" },
};

export function cleanupModel(value: unknown): string | undefined {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(CLEANUP_MODELS, key)
    ? CLEANUP_MODELS[key].file
    : undefined;
}

/** Re-detail slider: percent of denoise per tile. */
export const REDETAIL_MIN = 10;
export const REDETAIL_MAX = 40;
export const REDETAIL_DEFAULT = 20;

export function redetailDenoise(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  const pct = Number.isFinite(n)
    ? Math.min(REDETAIL_MAX, Math.max(REDETAIL_MIN, n))
    : REDETAIL_DEFAULT;
  return Math.round(pct) / 100;
}

/** Video target: 2x the source, or the shorter side at 1080 / longer at 3840. */
export const VIDEO_UPSCALE_SCALES = ["2x", "1080p", "4k"] as const;
export type VideoUpscaleScale = (typeof VIDEO_UPSCALE_SCALES)[number];

export function videoUpscaleScale(value: unknown): VideoUpscaleScale {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (VIDEO_UPSCALE_SCALES as readonly string[]).includes(v)
    ? (v as VideoUpscaleScale)
    : "2x";
}

/** Files in models/upscale_models that are not image upscalers (face restore / detection). */
const NOT_AN_UPSCALER =
  /gfpgan|codeformer|restoreformer|detection_|parsing_|parsenet|retinaface/i;
const MODEL_EXT = /\.(pth|pt|safetensors|ckpt|bin)$/i;

export interface UpscaleModelOption {
  /** Exact value for UpscaleModelLoader.model_name. */
  file: string;
  /** Upscale factor read from the name (null = unknown). */
  scale: number | null;
  /** Short display label ("4x-UltraSharp · 4×"). */
  label: string;
  /** Human name ("UltraSharp"), picker group and character tags. */
  name: string;
  category: UpscalerCategory;
  tags: UpscalerTag[];
}

/** Upscale factor from a model file name ("4x-UltraSharp", "RealESRGAN_x2plus"). */
export function upscaleModelScale(file: string): number | null {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  // "4x-UltraSharp", "2x_Foo" first; then "x2plus", "SRx4".
  const m =
    /(?:^|[^a-z0-9])([1-8])x/i.exec(base) ?? /x([1-8])(?![0-9])/i.exec(base);
  return m ? Number(m[1]) : null;
}

export function isImageUpscaler(file: string): boolean {
  return MODEL_EXT.test(file) && !NOT_AN_UPSCALER.test(file);
}

export function upscaleModelLabel(file: string): string {
  const base = (file.replace(/\\/g, "/").split("/").pop() ?? file).replace(
    MODEL_EXT,
    "",
  );
  const scale = upscaleModelScale(file);
  return scale ? `${base} · ${scale}×` : base;
}

/** Sorted, filtered picker options from raw model_name values. */
export function toUpscaleModelOptions(
  files: readonly unknown[],
): UpscaleModelOption[] {
  const seen = new Set<string>();
  const out: UpscaleModelOption[] = [];
  for (const f of files) {
    if (typeof f !== "string" || !isImageUpscaler(f) || seen.has(f)) continue;
    seen.add(f);
    const info = describeUpscaler(f, upscaleModelScale(f));
    out.push({
      file: f,
      scale: info.scale,
      label: upscaleModelLabel(f),
      name: info.name,
      category: info.category,
      tags: info.tags,
    });
  }
  return out.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

/**
 * UpscaleModelLoader.model_name options from an /object_info dump; null when
 * the node is missing (can't offer a choice).
 */
export function upscaleModelOptionsFromObjectInfo(
  objectInfo: Record<string, unknown> | null | undefined,
): UpscaleModelOption[] | null {
  const node = objectInfo?.UpscaleModelLoader as
    { input?: { required?: Record<string, unknown> } } | undefined;
  const spec = node?.input?.required?.model_name;
  if (!Array.isArray(spec)) return null;
  const opts = comboOptions(spec);
  return Array.isArray(opts) ? toUpscaleModelOptions(opts) : null;
}

/**
 * Validated model file name from request params, or undefined. Accepts
 * ComfyUI-relative names ("4x-UltraSharp.pth", "sub/x.pth"); rejects paths
 * that climb or are absolute.
 */
export function sanitizeUpscaleModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > 255) return undefined;
  if (!MODEL_EXT.test(v)) return undefined;
  const norm = v.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-z]:/i.test(norm)) return undefined;
  if (norm.split("/").some((part) => part === ".." || part === ".")) {
    return undefined;
  }
  if (/[\0-\x1f<>|"*?]/.test(v)) return undefined;
  return v;
}

/** Creativity (0–100, default 35) as a clamped integer. */
export function clampCreativity(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return CREATIVITY_DEFAULT;
  return Math.round(Math.min(CREATIVITY_MAX, Math.max(CREATIVITY_MIN, n)));
}

/** Creativity → denoise (0 → 0.10, 35 → 0.20, 100 → 0.50). */
export function creativityDenoise(value: unknown): number {
  const c = clampCreativity(value);
  const d =
    c <= CREATIVITY_DEFAULT
      ? DENOISE_AT_MIN +
        ((DENOISE_AT_DEFAULT - DENOISE_AT_MIN) * (c - CREATIVITY_MIN)) /
          (CREATIVITY_DEFAULT - CREATIVITY_MIN)
      : DENOISE_AT_DEFAULT +
        ((DENOISE_AT_MAX - DENOISE_AT_DEFAULT) * (c - CREATIVITY_DEFAULT)) /
          (CREATIVITY_MAX - CREATIVITY_DEFAULT);
  return Math.round(d * 100) / 100;
}

/** ImageScaleBy factor that brings a model's output to CREATIVE_TARGET_SCALE. */
export function creativeRescale(modelFile: string | undefined): number {
  const scale =
    (modelFile ? upscaleModelScale(modelFile) : null) ?? DEFAULT_MODEL_SCALE;
  return Math.round((CREATIVE_TARGET_SCALE / scale) * 100) / 100;
}

/**
 * /api/jobs/action params for an upscale action. Empty model = the user's
 * default upscaler (applied at submit); knobs a mode does not use are left
 * out, and defaults ("model" size, no clean-up) are not sent.
 */
export function upscaleRequestParams(
  action: string,
  opts: {
    model?: unknown;
    creativity?: unknown;
    size?: unknown;
    cleanup?: unknown;
    redetail?: unknown;
    sharpen?: unknown;
    strength?: unknown;
  } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const model = sanitizeUpscaleModel(opts.model);
  if (model) params[UPSCALE_MODEL_PARAM] = model;
  if (action === UPSCALE_CREATIVE_ACTION) {
    params[UPSCALE_CREATIVITY_PARAM] = clampCreativity(opts.creativity);
  }
  if (action === VIDEO_UPSCALE_ACTION) {
    params[UPSCALE_SIZE_PARAM] = videoUpscaleScale(opts.size);
    return params;
  }
  if (action === UPSCALE_SUBTLE_ACTION) {
    const id = typeof opts.size === "string" ? opts.size : "";
    if (upscaleSize(id).kind !== "model") params[UPSCALE_SIZE_PARAM] = id;
  }
  if (action === UPSCALE_REDETAIL_ACTION) {
    params[UPSCALE_SIZE_PARAM] =
      REDETAIL_SIZES.find((s) => s.id === opts.size)?.id ??
      REDETAIL_DEFAULT_SIZE;
    params[UPSCALE_REDETAIL_PARAM] = Math.round(
      redetailDenoise(opts.redetail) * 100,
    );
  }
  if (cleanupModel(opts.cleanup)) {
    params[UPSCALE_CLEANUP_PARAM] = String(opts.cleanup).trim().toLowerCase();
  }
  Object.assign(params, upscaleFinishParams(opts));
  return params;
}
