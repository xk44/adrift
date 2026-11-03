/**
 * Finishing controls shared by the image upscalers (Faithful, Creative,
 * Re-detail, SeedVR2): applied on the built graph, right before SaveImage.
 *
 *   params.sharpen   0–100 % → core ImageSharpen (3x3 unsharp mask,
 *                    alpha = percent / 100 × SHARPEN_ALPHA_MAX; 0 = no node).
 *                    ImageSharpen weights the blur by alpha × 10, so its own
 *                    default (1.0) is very strong: on 4x upscales alpha 0.05
 *                    already lifts edge energy ~1.4x and 1.0 ~8–10x with
 *                    visible grain. Measured, alpha ≤ 0.3 (~3.3x) is the
 *                    useful range, so 100 % maps there.
 *   params.strength  0–100 % of the upscaled result kept. Below 100 a core
 *                    ImageBlend mixes the result with the source image
 *                    (ImageBlend bicubic-resizes image2 to image1's size), so
 *                    invented detail or over-sharpening can be dialled back.
 *
 * Both core nodes: no pack needed. Graphs without SaveImage (video) are left
 * alone.
 */
import type { Workflow } from "@/types";

export const UPSCALE_SHARPEN_PARAM = "sharpen";
export const UPSCALE_STRENGTH_PARAM = "strength";

export const SHARPEN_MIN = 0;
export const SHARPEN_MAX = 100;
export const SHARPEN_DEFAULT = 0;
/** ImageSharpen alpha at 100 %. */
export const SHARPEN_ALPHA_MAX = 0.3;

export const STRENGTH_MIN = 0;
export const STRENGTH_MAX = 100;
export const STRENGTH_DEFAULT = 100;

function percent(value: unknown, fallback: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** Sharpen amount in percent, clamped; non-numbers → 0. */
export function sharpenAmount(value: unknown): number {
  return percent(value, SHARPEN_DEFAULT);
}

/** Percent of the upscaled image kept, clamped; non-numbers → 100. */
export function upscaleStrength(value: unknown): number {
  return percent(value, STRENGTH_DEFAULT);
}

/** Request params for the finishing controls; defaults are not sent. */
export function upscaleFinishParams(opts: {
  sharpen?: unknown;
  strength?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sharpen = sharpenAmount(opts.sharpen);
  if (sharpen !== SHARPEN_DEFAULT) out[UPSCALE_SHARPEN_PARAM] = sharpen;
  const strength = upscaleStrength(opts.strength);
  if (strength !== STRENGTH_DEFAULT) out[UPSCALE_STRENGTH_PARAM] = strength;
  return out;
}

function ids(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow).filter(
    (k) => !k.startsWith("_") && workflow[k]?.class_type === classType,
  );
}

function freshId(workflow: Workflow, hint: string): string {
  let id = hint;
  for (let i = 2; workflow[id]; i++) id = `${hint}_${i}`;
  return id;
}

function isRef(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[1] === "number";
}

/**
 * Insert the sharpen / strength nodes in front of every SaveImage. Returns
 * the ids added (empty when both controls are at their defaults).
 */
export function applyUpscaleFinish(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const alpha = Number(
    (
      (sharpenAmount(params[UPSCALE_SHARPEN_PARAM]) / 100) *
      SHARPEN_ALPHA_MAX
    ).toFixed(3),
  );
  const strength = upscaleStrength(params[UPSCALE_STRENGTH_PARAM]);
  if (alpha === 0 && strength === STRENGTH_DEFAULT) return [];
  // The untouched source: the first LoadImage something reads.
  const source = ids(workflow, "LoadImage").find((id) =>
    Object.values(workflow).some((n) =>
      Object.values(n?.inputs ?? {}).some(
        (v) => isRef(v) && String(v[0]) === id,
      ),
    ),
  );
  const added: string[] = [];
  for (const saveId of ids(workflow, "SaveImage")) {
    let feed = workflow[saveId].inputs.images;
    if (!isRef(feed)) continue;
    if (alpha > 0) {
      const sid = freshId(workflow, `${saveId}_sharpen`);
      workflow[sid] = {
        class_type: "ImageSharpen",
        inputs: { image: feed, sharpen_radius: 1, sigma: 1, alpha },
        _meta: { title: "Sharpen" },
      };
      feed = [sid, 0];
      added.push(sid);
    }
    if (strength < STRENGTH_DEFAULT && source) {
      const bid = freshId(workflow, `${saveId}_strength`);
      workflow[bid] = {
        class_type: "ImageBlend",
        inputs: {
          image1: feed,
          image2: [source, 0],
          blend_factor: Number(((100 - strength) / 100).toFixed(2)),
          blend_mode: "normal",
        },
        _meta: { title: "Upscale strength" },
      };
      feed = [bid, 0];
      added.push(bid);
    }
    workflow[saveId].inputs.images = feed;
  }
  return added;
}
