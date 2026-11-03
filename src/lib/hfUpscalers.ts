/**
 * Which Hugging Face repos/files Adrift may download: upscalers only, into
 * models/upscale_models or models/latent_upscale_models. Pure (client and
 * server); the download route re-checks everything against the Hub.
 */
import { extOf, isPickleFilename } from "@/lib/civitaiFolders";

export const HF_UPSCALE_FOLDERS = [
  "upscale_models",
  "latent_upscale_models",
] as const;
export type HfUpscaleFolder = (typeof HF_UPSCALE_FOLDERS)[number];

export function isHfUpscaleFolder(v: unknown): v is HfUpscaleFolder {
  return (
    typeof v === "string" &&
    (HF_UPSCALE_FOLDERS as readonly string[]).includes(v)
  );
}

/**
 * Formats ComfyUI's upscale loaders read. No .bin: on upscaler repos that is
 * almost always an NCNN export ComfyUI can't load.
 */
export const HF_UPSCALER_EXTS = [".safetensors", ".pth", ".pt", ".ckpt"] as const;

const UPSCALER_TAGS = new Set([
  "super-resolution",
  "image-super-resolution",
  "upscale",
  "upscaler",
  "upscaling",
  "esrgan",
  "real-esrgan",
  "swinir",
]);

/**
 * "super-resolution" also tags ControlNets, IC-LoRAs and diffusers/
 * transformers pipelines. Those don't load from upscale_models, so repos
 * carrying any of these tags are never offered for download.
 */
const NOT_UPSCALER_TAGS = new Set([
  "controlnet",
  "lora",
  "ic-lora",
  "peft",
  "diffusers",
  "transformers",
]);

/** Export folders whose files ComfyUI can't load. */
const SKIP_DIRS_RE = /(^|\/)(ncnn|onnx|coreml|tflite|openvino)\//i;

/** Common upscaler names: 4x-UltraSharp, RealESRGAN_x4plus, 2x_NMKD-…, SwinIR. */
const UPSCALER_NAME_RE =
  /(upscal|esrgan|realesr|swinir|ultrasharp|nmkd|(^|[^a-z0-9])[248]x[-_]|[-_]x[248]([^0-9]|$))/i;

export function isUpscalerName(name: string): boolean {
  return UPSCALER_NAME_RE.test(name);
}

/** A repo looks like an upscaler by its tags or its name. */
export function isHfUpscalerRepo(repo: {
  id: string;
  tags?: readonly string[];
}): boolean {
  const tags = (repo.tags ?? []).map((t) => t.toLowerCase());
  if (tags.some((t) => NOT_UPSCALER_TAGS.has(t))) return false;
  if (tags.some((t) => UPSCALER_TAGS.has(t))) return true;
  return isUpscalerName(repo.id.split("/").pop() ?? repo.id);
}

function hasExcludedTag(repo: { tags?: readonly string[] }): boolean {
  return (repo.tags ?? []).some((t) => NOT_UPSCALER_TAGS.has(t.toLowerCase()));
}

export function isHfUpscalerFileExt(file: string): boolean {
  return (HF_UPSCALER_EXTS as readonly string[]).includes(extOf(file));
}

/**
 * A file in a repo Adrift may download: a weight format the upscale loaders
 * read, and either the repo is an upscaler or the file name says it is one.
 */
export function isHfUpscalerFile(
  repo: { id: string; tags?: readonly string[] },
  file: string,
): boolean {
  if (!isHfUpscalerFileExt(file) || SKIP_DIRS_RE.test(file)) return false;
  if (hasExcludedTag(repo)) return false;
  const base = file.split("/").pop() ?? file;
  return isHfUpscalerRepo(repo) || isUpscalerName(base);
}

/** Latent upscalers (LTX spatial/temporal, Hunyuan, …) go to latent_upscale_models. */
export function suggestedUpscaleFolder(
  file: string,
  tags: readonly string[] = [],
): HfUpscaleFolder {
  if (/latent|spatial-upscaler|temporal-upscaler/i.test(file))
    return "latent_upscale_models";
  if (tags.some((t) => /latent[-_]?upscal/i.test(t)))
    return "latent_upscale_models";
  return "upscale_models";
}

export function hfUpscaleProgressKey(repo: string, file: string): string {
  return `hf:${repo}:${file}`;
}

export { isPickleFilename };

/** One downloadable file as the GET listing reports it. */
export interface HfUpscalerFile {
  file: string;
  size: number | null;
  sha256: string | null;
  folder: HfUpscaleFolder;
  pickle: boolean;
}
