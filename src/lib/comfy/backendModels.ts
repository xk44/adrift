/**
 * Model / node availability of a workflow on a REMOTE ComfyUI backend, read
 * from its /object_info (GET only). The default backend is checked on disk
 * (src/lib/tools/modelStatus.ts); a backend on another machine can only be
 * asked over HTTP, where loader combos list exactly the files ComfyUI can see
 * (search paths, extra_model_paths and all).
 *
 * Server-side only.
 */
import type { Workflow } from "@/types";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { comboOptions } from "@/lib/comfy/validatePrompt";

/** Loader inputs whose combo values are weight files → models/<dir> hint. */
const LOADER_INPUTS: Record<string, Array<[input: string, dir: string]>> = {
  UNETLoader: [["unet_name", "diffusion_models"]],
  CLIPLoader: [["clip_name", "text_encoders"]],
  DualCLIPLoader: [
    ["clip_name1", "text_encoders"],
    ["clip_name2", "text_encoders"],
  ],
  VAELoader: [["vae_name", "vae"]],
  LatentUpscaleModelLoader: [["model_name", "latent_upscale_models"]],
  UpscaleModelLoader: [["model_name", "upscale_models"]],
  LoraLoaderModelOnly: [["lora_name", "loras"]],
  AnimaRefAdapter: [["lora_name", "loras"]],
  AnimaRefAdapterLoader: [["lora_name", "loras"]],
  LoraLoader: [["lora_name", "loras"]],
  OpenH3RegenLora: [
    ["lora_name", "loras"],
    ["curve_name", "loras"],
  ],
  CheckpointLoaderSimple: [["ckpt_name", "checkpoints"]],
  // MOSS Toolkit single-file DiT (skipped when the input is not a combo)
  MOSSImageLoader: [["dit", "diffusion_models"]],
  LoadDA3Model: [["model_name", "geometry_estimation"]],
  LoadMoGeModel: [["model_name", "geometry_estimation"]],
  ConditioningLoader: [["conditioning_name", "embeddings"]],
  // ComfyUI-VOSR2: bundle folder name under models/vosr2/ (the disk check
  // in modelStatus.ts requires the bundle's DiT inside it).
  VOSR2ModelLoader: [["model", "vosr2"]],
  // ComfyUI-See-through: HF repo ids under models/SeeThrough/. The combo also
  // lists the default repo ids when they are not downloaded, so this cannot
  // catch missing weights; with auto_download off the loader fails at queue time.
  SeeThrough_LoadLayerDiffModel: [["model", "SeeThrough"]],
  SeeThrough_LoadDepthModel: [["model", "SeeThrough"]],
  LoadBackgroundRemovalModel: [["bg_removal_name", "background_removal"]],
  TripoSRModelLoader: [["model", "checkpoints"]],
  FrameInterpolationModelLoader: [["model_name", "frame_interpolation"]],
  MMAudioModelLoader: [["mmaudio_model", "mmaudio"]],
  // Voiceover: the stock voice prompt must be listed (models/tts/VibeVoice/voices).
  VibeVoiceTTS: [
    ["model_name", "tts/VibeVoice"],
    ["voice_preset", "tts/VibeVoice/voices"],
  ],
  MMAudioFeatureUtilsLoader: [
    ["vae_model", "mmaudio"],
    ["synchformer_model", "mmaudio"],
    ["clip_model", "mmaudio"],
  ],
};

type NodeInfo = {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
};

function optionsFor(
  info: NodeInfo | undefined,
  input: string,
): string[] | null {
  const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
  if (!Array.isArray(spec)) return null;
  const opts = comboOptions(spec);
  return Array.isArray(opts) ? opts.map(String) : null;
}

/**
 * Missing node classes ("node:<Class>") and loader files ("<dir>/<file>") of
 * `workflow` against an object_info dump. Nodes marked `_meta.optional` are
 * skipped (queuePrompt bypasses them).
 */
export function missingAgainstObjectInfo(
  workflow: Workflow,
  objectInfo: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      missing.push(s);
    }
  };
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== "object" || !node.class_type) continue;
    const meta = (node as { _meta?: { optional?: unknown } })._meta;
    if (meta?.optional) continue;
    const info = objectInfo[node.class_type] as NodeInfo | undefined;
    if (!info) {
      add(`node:${node.class_type}`);
      continue;
    }
    for (const [input, dir] of LOADER_INPUTS[node.class_type] ?? []) {
      const value = node.inputs?.[input];
      if (typeof value !== "string" || !value.trim()) continue;
      const opts = optionsFor(info, input);
      if (!opts) continue;
      const want = value.replace(/\\/g, "/").toLowerCase();
      if (!opts.some((o) => o.replace(/\\/g, "/").toLowerCase() === want))
        add(`${dir}/${value}`);
    }
  }
  return missing;
}

/**
 * Missing models/nodes for `workflow` on the backend at `baseUrl`.
 * Unreachable backend → a single "backend unreachable" entry, so a UI gate
 * stays closed instead of offering a tool that cannot run.
 */
export async function missingOnBackend(
  workflow: Workflow,
  baseUrl: string,
): Promise<string[]> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return [`backend unreachable: ${baseUrl}`];
  return missingAgainstObjectInfo(workflow, info);
}

/** LoRA files (lowercase, "/"-separated) an object_info dump lists; null when
 *  neither LoRA loader is present (can't judge). */
export function loraFilesFromInfo(
  info: Record<string, unknown> | null | undefined,
): Set<string> | null {
  if (!info) return null;
  const opts =
    optionsFor(info.LoraLoaderModelOnly as NodeInfo | undefined, "lora_name") ??
    optionsFor(info.LoraLoader as NodeInfo | undefined, "lora_name");
  if (!opts) return null;
  return new Set(opts.map((o) => o.replace(/\\/g, "/").toLowerCase()));
}

/** LoRA files (by name) a backend lists for LoraLoaderModelOnly; null if unreachable. */
export async function backendLoraFiles(
  baseUrl: string,
): Promise<Set<string> | null> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return null;
  return loraFilesFromInfo(info) ?? new Set();
}

/** UNET files (by name) a backend lists for UNETLoader; null if unreachable. */
export async function backendUnetFiles(
  baseUrl: string,
): Promise<Set<string> | null> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return null;
  const opts =
    optionsFor(info.UNETLoader as NodeInfo | undefined, "unet_name") ?? [];
  return new Set(opts.map((o) => o.replace(/\\/g, "/").toLowerCase()));
}

// Tool model status (GET /api/tools/model-status), backend-aware

/**
 * Custom node packs recognised by folder name under COMFY_ROOT/custom_nodes,
 * used only when the default backend's /object_info is unavailable.
 */
const CUSTOM_NODE_DIRS: Record<string, RegExp> = {
  TripoSRModelLoader: /triposr/i,
  TripoSRSampler: /triposr/i,
  CJSA3InpaintConditioning: /cj_sa3_audio/i,
  CJAudioPasteback: /cj_sa3_audio/i,
  VOSR2ModelLoader: /vosr2/i,
  VOSR2Upscale: /vosr2/i,
  RTXVideoSuperResolution: /nvidia_rtx/i,
  MatAnyone2: /matanyone/i,
  // This repo's node packs (comfy_nodes/*), for when /object_info is unknown.
  CJVectorize: /cj_image_tools/i,
  CJCutouts: /cj_image_tools/i,
  CJVideoPalette: /cj_h3_tools/i,
};

/**
 * Pack-relative workflow file for a model check: the pack's own entry, else
 * the registry action's template file (e.g. make_3d → i23d.json,
 * video_bg_remove → packs/utility/video_bg_remove.json).
 */
export function modelCheckWorkflowRel(
  packWorkflow: string | undefined,
  action: string,
  registry: {
    actions: Record<string, { template?: string }>;
    templates: Record<string, { file?: string }>;
  },
): string | undefined {
  if (packWorkflow) return packWorkflow;
  const template = registry.actions[action]?.template ?? action;
  return registry.templates[template]?.file;
}

/** "<name>.json" → "<name>.video.json" (the video host's variant). */
export function videoVariantRel(rel: string): string {
  return rel.replace(/\.json$/, ".video.json");
}

export interface DefaultBackendCheckDeps {
  /** Disk check of loader files (COMFY_ROOT/models). */
  diskMissing: (workflow: Workflow) => Promise<string[]>;
  /** Default backend /object_info, null when unreachable. */
  objectInfo: () => Promise<Record<string, unknown> | null>;
  /** custom_nodes folder names, for the offline fallback. */
  customNodeDirs: () => Promise<string[]>;
}

/** Loader files of `workflow` that /object_info combos list (lowercased). */
function objectInfoListedFiles(
  workflow: Workflow,
  objectInfo: Record<string, unknown>,
): Set<string> {
  const listed = new Set<string>();
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== "object" || !node.class_type) continue;
    const info = objectInfo[node.class_type] as NodeInfo | undefined;
    for (const [input] of LOADER_INPUTS[node.class_type] ?? []) {
      const value = node.inputs?.[input];
      if (typeof value !== "string" || !value.trim()) continue;
      const want = value.replace(/\\/g, "/").toLowerCase();
      const opts = optionsFor(info, input);
      if (opts?.some((o) => o.replace(/\\/g, "/").toLowerCase() === want))
        listed.add(want);
    }
  }
  return listed;
}

/**
 * Missing items for a workflow on the DEFAULT backend. Reachable
 * /object_info is authoritative: a disk miss its loader combo lists is
 * dropped (COMFY_ROOT may be another machine's tree when the backend is
 * tunnelled, or lack extra_model_paths dirs), and its own misses (nodes,
 * files) are added. Offline: the disk check alone, plus known custom node
 * packs looked up by folder name so e.g. TripoSR still reports missing.
 */
export async function missingOnDefaultBackend(
  workflow: Workflow,
  deps: DefaultBackendCheckDeps,
): Promise<string[]> {
  const disk = await deps.diskMissing(workflow);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  };
  const info = await deps.objectInfo().catch(() => null);
  if (info) {
    // A loader combo that lists the file is authoritative: COMFY_ROOT may be
    // another machine's tree (tunnelled backend) or miss extra_model_paths.
    const listed = objectInfoListedFiles(workflow, info);
    for (const item of disk) {
      const file = item.replace(/\\/g, "/").toLowerCase();
      if (![...listed].some((f) => file === f || file.endsWith(`/${f}`)))
        add(item);
    }
    for (const item of missingAgainstObjectInfo(workflow, info)) add(item);
    return out;
  }
  for (const item of disk) add(item);
  let dirs: string[] = [];
  try {
    dirs = await deps.customNodeDirs();
  } catch {
    /* no custom_nodes folder */
  }
  for (const node of Object.values(workflow)) {
    const re = node && CUSTOM_NODE_DIRS[node.class_type];
    if (re && !dirs.some((d) => re.test(d))) add(`node:${node.class_type}`);
  }
  return out;
}
