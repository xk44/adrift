/**
 * Core graph controls that ComfyUI users expect on any SD-style front end:
 *
 *   --clipskip N     CLIPSetLastLayer(stop_at_clip_layer = -N). SD1.5/SDXL
 *                    family only (CLIP-L/G text towers). N=1 is "no skip".
 *   --tiledvae       force VAEDecode -> VAEDecodeTiled
 *   --tiledvae-off   never auto-tile (authored VAEDecodeTiled nodes are kept)
 *   --tilesize N     tile size in px (implies --tiledvae)
 *   --lowvram        low-VRAM hint (set by the client memory preflight or the
 *                    user); auto-tiles the VAE decode. Env CJ_LOW_VRAM=1 too.
 *
 * Tiled decode is automatic when the decoded canvas is >= the pixel threshold
 * (default 2048x2048, env CJ_TILED_VAE_AUTO_PIXELS) or on low VRAM.
 *
 * Every control is gated on model family (detectWorkflowFamily on the graph's
 * checkpoint/UNET name, plus a structural check), so a stray flag on a
 * Krea2/Qwen/H3 graph is a silent no-op instead of a broken prompt.
 */

import type { Workflow } from "@/types";
import { detectModelFamilyStrict, isNonSdArchitectureName } from "./packs";

/** Families whose text encoder is a CLIP-L/G tower that CLIPSetLastLayer understands. */
export const CLIP_SKIP_FAMILIES: ReadonlySet<string> = new Set([
  "sd15",
  "sdxl",
  "pony",
  "illustrious",
]);

/**
 * Families where swapping VAEDecode for VAEDecodeTiled is NOT valid:
 * - minimax: H3's video VAE is a custom audio/video pair; tiled 3D decode is
 *   unvalidated and its canvas is already capped (applyMiniMaxCanvas).
 * - sefi: self-contained generator node, no VAEDecode to swap.
 */
export const TILED_VAE_BLOCKED_FAMILIES: ReadonlySet<string> = new Set([
  "minimax",
  "sefi",
]);

export const DEFAULT_TILED_VAE_AUTO_PIXELS = 2048 * 2048;
export const DEFAULT_VAE_TILE_SIZE = 512;
export const DEFAULT_VAE_TILE_OVERLAP = 64;
/** ComfyUI VAEDecodeTiled defaults for video VAEs (ignored by image VAEs). */
const DEFAULT_TEMPORAL_SIZE = 64;
const DEFAULT_TEMPORAL_OVERLAP = 8;

const CHECKPOINT_LOADERS = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "ImageOnlyCheckpointLoader",
]);
const UNET_LOADERS = new Set([
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
  "UnetLoaderGGUF",
]);
/** Standalone text-encoder loaders: present => not a plain SD1.5/SDXL CLIP graph. */
const SEPARATE_CLIP_LOADERS = new Set([
  "CLIPLoader",
  "DualCLIPLoader",
  "TripleCLIPLoader",
  "QuadrupleCLIPLoader",
  "CLIPLoaderGGUF",
  "DualCLIPLoaderGGUF",
]);
const CLIP_TEXT_ENCODERS = new Set(["CLIPTextEncode", "CLIPTextEncodeSDXL"]);

export interface GraphControlSupport {
  /** detectWorkflowFamily() of the graph's main model (or "unknown"). */
  family: string;
  /** Checkpoint/UNET filename the family was detected from, if any. */
  modelName?: string;
  clipSkip: boolean;
  tiledVae: boolean;
}

function isLink(v: unknown): v is [string, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
  );
}

function firstStringInput(
  workflow: Workflow,
  classes: ReadonlySet<string>,
  key: string,
): string | undefined {
  for (const node of Object.values(workflow)) {
    if (!classes.has(node.class_type)) continue;
    const v = node.inputs?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Family of the graph's main model via the existing pack detection.
 * Checkpoint graphs with an empty or unrecognised ckpt_name are SD ("sdxl")
 * structurally, independent of CJ_DEFAULT_PACK.
 */
export function detectWorkflowFamily(workflow: Workflow): {
  family: string;
  modelName?: string;
} {
  // Checkpoint graphs: a recognized name wins (so a flux3/qwen/moss file in a
  // checkpoint loader is not treated as SD); an unrecognized merge name is SD
  // structurally — the all-in-one checkpoint loader is SD-shaped. This never
  // consults CJ_DEFAULT_PACK (a krea2 default must not drop --clipskip).
  const ckpt = firstStringInput(workflow, CHECKPOINT_LOADERS, "ckpt_name");
  if (ckpt) {
    const strict = detectModelFamilyStrict(ckpt);
    if (strict !== "unknown") return { family: strict, modelName: ckpt };
    return {
      family: isNonSdArchitectureName(ckpt) ? "unknown" : "sdxl",
      modelName: ckpt,
    };
  }
  // UNET graphs are never SD-shaped: no default guess, "unknown" if unmatched.
  const unet = firstStringInput(workflow, UNET_LOADERS, "unet_name");
  if (unet) return { family: detectModelFamilyStrict(unet), modelName: unet };
  const hasCkptLoader = Object.values(workflow).some((n) =>
    CHECKPOINT_LOADERS.has(n.class_type),
  );
  // Unnamed checkpoint loader: the stock SD template (ckpt filled in later).
  if (hasCkptLoader) return { family: "sdxl" };
  return { family: "unknown" };
}

/** Checkpoint CLIP outputs ([loaderId, 1]) consumed by a CLIP text encoder / LoRA chain. */
function checkpointClipSources(workflow: Workflow): string[] {
  return Object.entries(workflow)
    .filter(([, n]) => CHECKPOINT_LOADERS.has(n.class_type))
    .map(([id]) => id);
}

export function getGraphControlSupport(
  workflow: Workflow,
  opts: { apiNode?: boolean } = {},
): GraphControlSupport {
  const { family, modelName } = detectWorkflowFamily(workflow);
  const classes = new Set(Object.values(workflow).map((n) => n.class_type));
  const hasSeparateClip = [...classes].some((c) =>
    SEPARATE_CLIP_LOADERS.has(c),
  );
  const hasUnet = [...classes].some((c) => UNET_LOADERS.has(c));
  const hasClipEncoder = [...classes].some((c) => CLIP_TEXT_ENCODERS.has(c));
  const clipSkip =
    !opts.apiNode &&
    CLIP_SKIP_FAMILIES.has(family) &&
    !hasSeparateClip &&
    !hasUnet &&
    hasClipEncoder &&
    (checkpointClipSources(workflow).length > 0 ||
      classes.has("CLIPSetLastLayer"));
  const tiledVae =
    !opts.apiNode &&
    !TILED_VAE_BLOCKED_FAMILIES.has(family) &&
    (classes.has("VAEDecode") || classes.has("VAEDecodeTiled"));
  return { family, modelName, clipSkip, tiledVae };
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Largest decoded canvas the graph will produce, in pixels. Uses any node
 * with literal width/height (latents, ImageScale), megapixel targets
 * (ImageScaleToTotalPixels) and LatentUpscaleBy factors. Returns 0 when the
 * size is only known at runtime (e.g. LoadImage-driven i2i).
 */
export function estimateDecodePixels(workflow: Workflow): number {
  let maxPx = 0;
  let upscale = 1;
  for (const node of Object.values(workflow)) {
    // CLIPTextEncodeSDXL & co. carry conditioning-size width/height (often
    // 4096) that say nothing about the decoded canvas.
    if (/TextEncode|Conditioning|CLIP/.test(node.class_type)) continue;
    const inp = node.inputs ?? {};
    const w = num(inp.width);
    const h = num(inp.height);
    if (w && h && w > 0 && h > 0) maxPx = Math.max(maxPx, w * h);
    const mp = num(inp.megapixels);
    if (mp && mp > 0) maxPx = Math.max(maxPx, mp * 1024 * 1024);
    if (node.class_type === "LatentUpscaleBy") {
      const s = num(inp.scale_by);
      if (s && s > 1) upscale = Math.max(upscale, s);
    }
  }
  return Math.round(maxPx * upscale * upscale);
}

export function tiledVaeAutoPixels(): number {
  const env = Number(process.env.CJ_TILED_VAE_AUTO_PIXELS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TILED_VAE_AUTO_PIXELS;
}

export type TiledVaeReason = "manual" | "pixels" | "lowvram";

export interface GraphControlResult {
  support: GraphControlSupport;
  clipSkipApplied?: number;
  tiledVae?: { reason: TiledVaeReason; tileSize: number; nodeIds: string[] };
}

/** Decide whether tiled decode applies; undefined = leave the graph alone. */
export function resolveTiledVae(
  params: Record<string, unknown>,
  pixels: number,
  env: { lowVram?: boolean; autoPixels?: number } = {},
): TiledVaeReason | undefined {
  if (params.notiledvae === true) return undefined;
  if (params.tiledvae === true || num(params.vaetile) !== undefined)
    return "manual";
  if (params.lowvram === true || env.lowVram) return "lowvram";
  const threshold = env.autoPixels ?? tiledVaeAutoPixels();
  if (pixels > 0 && pixels >= threshold) return "pixels";
  return undefined;
}

/**
 * Apply --clipskip and tiled VAE decode in place. Call after all other
 * injection (dims are final: --hd/--draft/--ar already applied).
 */
export function applyGraphControls(
  workflow: Workflow,
  params: Record<string, unknown>,
  opts: { apiNode?: boolean } = {},
): GraphControlResult {
  const support = getGraphControlSupport(workflow, opts);
  const result: GraphControlResult = { support };

  // Clip skip
  const rawSkip = num(params.clipskip);
  if (support.clipSkip && rawSkip !== undefined) {
    const skip = Math.max(1, Math.min(12, Math.round(rawSkip)));
    const layer = -skip;
    const existing = Object.entries(workflow).filter(
      ([, n]) => n.class_type === "CLIPSetLastLayer",
    );
    if (existing.length > 0) {
      for (const [, n] of existing) n.inputs.stop_at_clip_layer = layer;
      result.clipSkipApplied = skip;
    } else if (skip > 1) {
      // Insert one CLIPSetLastLayer per checkpoint and rewire every consumer
      // of that checkpoint's CLIP output (text encoders, LoraLoader clip).
      for (const loaderId of checkpointClipSources(workflow)) {
        const skipId = `cj_clip_skip_${loaderId}`;
        let rewired = false;
        for (const [nodeId, node] of Object.entries(workflow)) {
          if (nodeId === skipId) continue;
          for (const [key, v] of Object.entries(node.inputs ?? {})) {
            if (isLink(v) && v[0] === loaderId && v[1] === 1) {
              node.inputs[key] = [skipId, 0];
              rewired = true;
            }
          }
        }
        if (rewired) {
          workflow[skipId] = {
            class_type: "CLIPSetLastLayer",
            inputs: { clip: [loaderId, 1], stop_at_clip_layer: layer },
            _meta: { title: `Clip Skip ${skip}` },
          };
          result.clipSkipApplied = skip;
        }
      }
    }
  }

  // Tiled VAE decode
  if (support.tiledVae) {
    const reason = resolveTiledVae(params, estimateDecodePixels(workflow), {
      lowVram: process.env.CJ_LOW_VRAM === "1",
    });
    if (reason) {
      const requested = num(params.vaetile);
      const tileSize = requested
        ? Math.max(256, Math.min(4096, Math.round(requested / 32) * 32))
        : DEFAULT_VAE_TILE_SIZE;
      const overlap = Math.min(DEFAULT_VAE_TILE_OVERLAP, tileSize / 4);
      const nodeIds: string[] = [];
      for (const [nodeId, node] of Object.entries(workflow)) {
        if (node.class_type === "VAEDecode") {
          node.class_type = "VAEDecodeTiled";
          node.inputs = {
            ...node.inputs,
            tile_size: tileSize,
            overlap,
            temporal_size: DEFAULT_TEMPORAL_SIZE,
            temporal_overlap: DEFAULT_TEMPORAL_OVERLAP,
          };
          nodeIds.push(nodeId);
        } else if (node.class_type === "VAEDecodeTiled" && requested) {
          // Authored tiled decode: only an explicit --vaetile resizes it.
          node.inputs.tile_size = tileSize;
          node.inputs.overlap = overlap;
          nodeIds.push(nodeId);
        }
      }
      if (nodeIds.length > 0) result.tiledVae = { reason, tileSize, nodeIds };
    }
  }

  return result;
}

/**
 * Settings-panel defaults -> prompt flags, skipped when the prompt already
 * carries the user's own clip-skip / tiled-VAE flag (prompt wins).
 */
export function graphControlFlagsFromSettings(
  settings: { clipSkip?: number; tiledVae?: "auto" | "on" | "off" },
  basePrompt: string,
): string[] {
  const has = (re: RegExp) => re.test(basePrompt);
  const flags: string[] = [];
  if (
    settings.clipSkip &&
    settings.clipSkip > 1 &&
    !has(/(^|\s)--clip-?skip(\s|$)/i)
  ) {
    flags.push(`--clipskip ${Math.round(settings.clipSkip)}`);
  }
  const userTiled = has(
    /(^|\s)--(tiledvae|tiled-vae|tiledvae-off|untiledvae|tilesize|tile-size)(\s|$)/i,
  );
  if (!userTiled && settings.tiledVae === "on") flags.push("--tiledvae");
  if (!userTiled && settings.tiledVae === "off") flags.push("--tiledvae-off");
  return flags;
}
