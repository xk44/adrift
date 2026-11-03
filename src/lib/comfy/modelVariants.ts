/**
 * Precision-variant fallback for model files. Packs name one precision
 * (krea2_turbo_bf16.safetensors); many installs only have a sibling
 * (krea2_turbo_fp8_scaled.safetensors). Before validation, a loader whose
 * file the server does not list is pointed at an installed sibling with the
 * same stem, so the job runs instead of failing with "value not in list".
 *
 *   stem      = file name minus a trailing precision tag and extension,
 *               folder prefix kept ("FLUX1/x_bf16.safetensors" -> "flux1/x")
 *   order     = bf16 > fp16 > fp32 > fp8 variants (closest quality first)
 *   never     = int8 / nvfp4 / mxfp4 / gguf: they need their own loaders or
 *               hardware, so they are not drop-in siblings. A graph may NAME
 *               one (H3's int8_convrot TE keeps a 93 GB-RAM box out of OOM);
 *               a server without it falls back to the bf16 sibling.
 *   MPS       = fp8 is skipped on Apple Silicon (unsupported by the backend)
 *
 * Only files the server does not list are touched; a fresh /object_info
 * confirms the miss first, so a file installed seconds ago is still used.
 */
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { getComfyCapabilities } from "@/lib/comfy/capabilities";
import { comboOptions } from "@/lib/comfy/validatePrompt";

/** Loader inputs that name a swappable file. */
export const VARIANT_INPUTS: ReadonlyArray<[classType: string, input: string]> =
  [
    ["UNETLoader", "unet_name"],
    ["CLIPLoader", "clip_name"],
    ["DualCLIPLoader", "clip_name1"],
    ["DualCLIPLoader", "clip_name2"],
  ];

/** Drop-in precisions, best first. */
const ORDER = [
  "bf16",
  "fp16",
  "fp32",
  "fp8_scaled",
  "fp8_e4m3fn_scaled",
  "fp8_e4m3fn",
  "fp8mixed",
  "fp8_e5m2",
  "fp8",
] as const;
/** Precisions that are never drop-in siblings. */
const SPECIAL = ["int8_convrot", "int8", "nvfp4", "mxfp4", "w4a8", "awq"];

const TAG_RE = new RegExp(
  `[_-](${[...ORDER, ...SPECIAL].join("|")})(?=\\.(safetensors|sft|pt|pth|bin)$)`,
  "i",
);

export interface ParsedModelName {
  stem: string;
  precision: string | null;
  ext: string;
}

export function parseModelName(name: string): ParsedModelName | null {
  const norm = name.replace(/\\/g, "/");
  const ext = /\.(safetensors|sft|pt|pth|bin)$/i.exec(norm)?.[1]?.toLowerCase();
  if (!ext) return null;
  const m = TAG_RE.exec(norm);
  if (!m) return null; // no precision tag: nothing to swap between
  return {
    stem: norm.slice(0, m.index).toLowerCase(),
    precision: m[1].toLowerCase(),
    ext,
  };
}

/**
 * Best installed sibling of `want` among `options`, or null. `want` itself
 * being listed means no fallback is needed (also null).
 */
export function pickVariant(
  want: string,
  options: readonly string[],
  opts: { noFp8?: boolean } = {},
): string | null {
  if (options.includes(want)) return null;
  const w = parseModelName(want);
  if (!w) return null;
  let best: { name: string; rank: number } | null = null;
  for (const o of options) {
    const p = parseModelName(o);
    if (!p || p.stem !== w.stem || !p.precision) continue;
    const rank = (ORDER as readonly string[]).indexOf(p.precision);
    if (rank < 0) continue; // special precisions are never drop-in
    if (opts.noFp8 && p.precision.startsWith("fp8")) continue;
    if (!best || rank < best.rank) best = { name: o, rank };
  }
  return best?.name ?? null;
}

export interface VariantSwap {
  nodeId: string;
  classType: string;
  input: string;
  from: string;
  to: string;
}

type PromptNode = { class_type?: string; inputs?: Record<string, unknown> };

function loaderOptions(
  info: Record<string, unknown>,
  classType: string,
  input: string,
): string[] {
  const node = info[classType] as
    { input?: { required?: Record<string, unknown> } } | undefined;
  const spec = node?.input?.required?.[input];
  const opts = (Array.isArray(spec) && comboOptions(spec)) || [];
  return opts.filter((o): o is string => typeof o === "string");
}

/**
 * Pure: swaps against an /object_info snapshot. Returns a copy when anything
 * changed (the input prompt is never mutated).
 */
export function swapModelVariants<T extends object>(
  prompt: T,
  info: Record<string, unknown>,
  opts: { noFp8?: boolean } = {},
): { prompt: T; swaps: VariantSwap[] } {
  const swaps: VariantSwap[] = [];
  let out: T | null = null;
  for (const [nodeId, raw] of Object.entries(prompt)) {
    const node = raw as PromptNode;
    if (!node || typeof node !== "object" || !node.inputs) continue;
    for (const [classType, input] of VARIANT_INPUTS) {
      if (node.class_type !== classType) continue;
      const want = node.inputs[input];
      if (typeof want !== "string") continue;
      const to = pickVariant(want, loaderOptions(info, classType, input), opts);
      if (!to) continue;
      out ??= JSON.parse(JSON.stringify(prompt)) as T;
      (out as Record<string, PromptNode>)[nodeId].inputs![input] = to;
      swaps.push({ nodeId, classType, input, from: want, to });
    }
  }
  return { prompt: out ?? prompt, swaps };
}

/**
 * Server-side pre-submit step (see queuePrompt). Unreachable ComfyUI: the
 * prompt is returned as-is and ComfyUI decides.
 */
export async function applyModelVariantFallback<T extends object>(
  prompt: T,
  baseUrl?: string,
): Promise<{ prompt: T; swaps: VariantSwap[] }> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return { prompt, swaps: [] };
  // Nothing missing (the common case): no /system_stats round-trip.
  if (swapModelVariants(prompt, info).swaps.length === 0)
    return { prompt, swaps: [] };
  const fresh = (await getObjectInfoCached(baseUrl, { fresh: true })) ?? info;
  const { noFp8 } = await getComfyCapabilities(baseUrl);
  return swapModelVariants(prompt, fresh, { noFp8 });
}
