/**
 * Where each Civitai model type lands on disk, shared by the browser (to
 * label cards and pick the target) and the download route (which re-checks
 * it against the type Civitai reports, so a client can't steer a file into
 * the wrong folder).
 *
 * Pure: no fs, no fetch. The server maps a `CivitaiDest` to a real path.
 */

export type CivitaiDest =
  | "checkpoints"
  | "loras"
  | "controlnet"
  | "embeddings"
  | "vae"
  | "upscale_models"
  | "latent_upscale_models"
  | "hypernetworks"
  | "animatediff_models"
  | "diffusion_models"
  | "text_encoders"
  | "clip_vision"
  | "ultralytics/bbox"
  | "ultralytics/segm"
  | "poses"
  | "wildcards"
  | "workflows";

export const CIVITAI_DESTS: readonly CivitaiDest[] = [
  "checkpoints",
  "loras",
  "controlnet",
  "embeddings",
  "vae",
  "upscale_models",
  "latent_upscale_models",
  "hypernetworks",
  "animatediff_models",
  "diffusion_models",
  "text_encoders",
  "clip_vision",
  "ultralytics/bbox",
  "ultralytics/segm",
  "poses",
  "wildcards",
  "workflows",
];

export function isCivitaiDest(value: unknown): value is CivitaiDest {
  return (
    typeof value === "string" &&
    (CIVITAI_DESTS as readonly string[]).includes(value)
  );
}

/** Model weight formats ComfyUI loaders read. */
export const WEIGHT_EXTS = [
  ".safetensors",
  ".sft",
  ".gguf",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
] as const;
/** Formats that are Python pickles and can run code when loaded. */
export const PICKLE_EXTS = [".ckpt", ".pt", ".pth", ".bin"] as const;

const DEST_EXTS: Record<CivitaiDest, readonly string[]> = {
  checkpoints: WEIGHT_EXTS,
  loras: WEIGHT_EXTS,
  controlnet: WEIGHT_EXTS,
  embeddings: [".safetensors", ".pt", ".bin"],
  vae: WEIGHT_EXTS,
  upscale_models: [".safetensors", ".pth", ".pt", ".ckpt", ".bin"],
  latent_upscale_models: [".safetensors", ".pth", ".pt", ".ckpt", ".bin"],
  hypernetworks: [".safetensors", ".pt", ".pth", ".ckpt"],
  animatediff_models: [".safetensors", ".ckpt", ".pt", ".pth"],
  diffusion_models: WEIGHT_EXTS,
  text_encoders: WEIGHT_EXTS,
  clip_vision: WEIGHT_EXTS,
  "ultralytics/bbox": [".pt", ".pth", ".safetensors"],
  "ultralytics/segm": [".pt", ".pth", ".safetensors"],
  poses: [".png", ".jpg", ".jpeg", ".webp", ".json"],
  wildcards: [".txt"],
  workflows: [".json"],
};

/** Per-destination size ceiling in bytes (on top of the size Civitai reports). */
export const DEST_MAX_BYTES: Record<CivitaiDest, number> = {
  checkpoints: 64 * 2 ** 30,
  loras: 8 * 2 ** 30,
  controlnet: 16 * 2 ** 30,
  embeddings: 256 * 2 ** 20,
  vae: 4 * 2 ** 30,
  upscale_models: 4 * 2 ** 30,
  latent_upscale_models: 4 * 2 ** 30,
  hypernetworks: 2 * 2 ** 30,
  animatediff_models: 8 * 2 ** 30,
  diffusion_models: 64 * 2 ** 30,
  text_encoders: 32 * 2 ** 30,
  clip_vision: 8 * 2 ** 30,
  "ultralytics/bbox": 1 * 2 ** 30,
  "ultralytics/segm": 1 * 2 ** 30,
  poses: 50 * 2 ** 20,
  // wildcardsFs ignores files above 256 KB.
  wildcards: 256 * 2 ** 10,
  workflows: 20 * 2 ** 20,
};

export function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function isPickleFilename(filename: string): boolean {
  return (PICKLE_EXTS as readonly string[]).includes(extOf(filename));
}

export function destAllowsExt(dest: CivitaiDest, filename: string): boolean {
  return DEST_EXTS[dest].includes(extOf(filename));
}

export function destExtensions(dest: CivitaiDest): readonly string[] {
  return DEST_EXTS[dest];
}

/** Human folder label shown on cards ("Saves to …"). */
export function destLabel(dest: CivitaiDest): string {
  switch (dest) {
    case "poses":
      return "ComfyUI/input/poses";
    case "wildcards":
      return "Adrift wildcards";
    case "workflows":
      return "ComfyUI saved workflows";
    default:
      return `models/${dest}`;
  }
}

export interface CivitaiTypeRule {
  /** Where the main file goes; absent = browse only. */
  dest?: CivitaiDest;
  /** Plain reason shown when the type is browse only. */
  browseOnly?: string;
  /** Short extra hint shown next to the download button. */
  note?: string;
}

const BROWSE_ONLY_UNKNOWN =
  "Civitai doesn't say what kind of file this is, so Adrift can't tell where ComfyUI would load it.";

/**
 * Every Civitai model type (civitaiFilters CIVITAI_MODEL_TYPES) maps to a
 * folder or to a plain browse-only reason. Keys are lowercase.
 */
const TYPE_RULES: Record<string, CivitaiTypeRule> = {
  checkpoint: { dest: "checkpoints" },
  textualinversion: {
    dest: "embeddings",
    note: "Use it in a prompt as embedding:name",
  },
  hypernetwork: {
    dest: "hypernetworks",
    note: "Loads with the Hypernetwork Loader node",
  },
  aestheticgradient: {
    browseOnly:
      "Aesthetic gradients were an old A1111 add-on. ComfyUI has no loader for them.",
  },
  lora: { dest: "loras" },
  locon: { dest: "loras" },
  dora: { dest: "loras" },
  controlnet: { dest: "controlnet" },
  "controlnet-v1-1": { dest: "controlnet" },
  upscaler: { dest: "upscale_models" },
  motionmodule: {
    dest: "animatediff_models",
    note: "Needs the AnimateDiff-Evolved node pack in ComfyUI",
  },
  vae: { dest: "vae" },
  textencoder: { dest: "text_encoders" },
  clip: { dest: "text_encoders" },
  unet: { dest: "diffusion_models" },
  clipvision: { dest: "clip_vision" },
  detection: {
    dest: "ultralytics/bbox",
    note: "Used by Impact Pack face/hand detailers",
  },
  poses: { dest: "poses", note: "Saved as images under ComfyUI/input/poses" },
  wildcards: { dest: "wildcards", note: "Use in prompts as __name__" },
  workflows: { dest: "workflows", note: "Shows up in Workflows" },
  comfyworkflows: { dest: "workflows", note: "Shows up in Workflows" },
  visionlanguage: {
    browseOnly:
      "Vision-language models need their own node pack and folder. Get them from the creator's page.",
  },
  llm: {
    browseOnly:
      "Language models run outside ComfyUI image workflows, so Adrift doesn't install them.",
  },
  other: { browseOnly: BROWSE_ONLY_UNKNOWN },
};

export function civitaiTypeRule(
  modelType: string | undefined | null,
): CivitaiTypeRule {
  if (!modelType) return { browseOnly: BROWSE_ONLY_UNKNOWN };
  return (
    TYPE_RULES[modelType.toLowerCase()] ?? {
      browseOnly:
        "This is a new kind of Civitai file Adrift doesn't know how to place yet.",
    }
  );
}

/** Civitai file entry as far as placement cares. */
export interface CivitaiFileLike {
  name: string;
  type?: string;
  primary?: boolean;
  sizeKB?: number;
}

export type CivitaiFilePlan =
  | { ok: true; dest: CivitaiDest; pickle: boolean; note?: string }
  | { ok: false; reason: string };

const NON_MODEL_FILE_TYPES: Record<string, string> = {
  config: "Config file. ComfyUI doesn't need it.",
  "training data": "Training data, not a model.",
  archive: "Zip archive. Download it from Civitai and unzip it yourself.",
};

/**
 * Where one file of a version goes, or why it can't be downloaded here.
 * The server calls this with the type Civitai reports, never the client's.
 */
export function planCivitaiFile(
  modelType: string | undefined | null,
  file: CivitaiFileLike,
): CivitaiFilePlan {
  const rule = civitaiTypeRule(modelType);
  const fileType = (file.type ?? "").toLowerCase();
  const nonModel = NON_MODEL_FILE_TYPES[fileType];
  if (nonModel) return { ok: false, reason: nonModel };

  let dest: CivitaiDest | undefined = rule.dest;
  // A VAE bundled with a checkpoint/LoRA version goes to vae.
  if (fileType === "vae") dest = "vae";
  // Checkpoint pages can carry a companion LoRA ("Enhancement LoRA") or a
  // diffusion-model-only file; route by the file's own type.
  else if (/\blora\b/.test(fileType)) dest = "loras";
  else if (fileType === "diffusion model") dest = "diffusion_models";
  if (!dest)
    return { ok: false, reason: rule.browseOnly ?? BROWSE_ONLY_UNKNOWN };

  const ext = extOf(file.name);
  // GGUF "checkpoints" are diffusion-model-only weights for the GGUF loader.
  if (dest === "checkpoints" && ext === ".gguf") dest = "diffusion_models";
  if (dest === "ultralytics/bbox" && /seg/i.test(file.name))
    dest = "ultralytics/segm";

  if (!destAllowsExt(dest, file.name)) {
    if (ext === ".zip")
      return { ok: false, reason: NON_MODEL_FILE_TYPES.archive };
    return {
      ok: false,
      reason: `ComfyUI can't load ${ext || "this file type"} from ${destLabel(dest)}.`,
    };
  }
  return {
    ok: true,
    dest,
    pickle: isPickleFilename(file.name),
    note: rule.note,
  };
}

/**
 * On-disk name for a file. Wildcards must match Adrift's wildcard name rule
 * (lowercase letters, digits, - and _), so their stem is normalised.
 */
export function diskNameFor(dest: CivitaiDest, filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  if (dest !== "wildcards") return base;
  const ext = extOf(base);
  const stem = base
    .slice(0, base.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${stem || "wildcard"}${ext}`;
}

/** Files of a version that Adrift can download, primary first. */
export function downloadableFiles<T extends CivitaiFileLike>(
  modelType: string | undefined | null,
  files: T[],
): Array<{ file: T; plan: CivitaiFilePlan }> {
  return [...files]
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    .map((file) => ({ file, plan: planCivitaiFile(modelType, file) }));
}

/** Key the download route reports progress under (GET ?key=). */
export function civitaiProgressKey(modelVersionId: number, filename: string): string {
  return `civitai:${modelVersionId}:${filename}`;
}
