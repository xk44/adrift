/**
 * Outpaint seam harmonize pass (pan / zoom-out / outpaint).
 *
 * Outpaint graphs leave a visible seam where the source meets the generated
 * area. This appends a low-denoise masked img2img pass over a band straddling
 * that seam and composites it back with a feathered mask, so every pixel
 * outside the band (including the source's interior) stays exactly what the
 * outpaint produced.
 *
 * Core ComfyUI nodes only: SolidMask, MaskComposite, MaskToImage, ImageBlur,
 * ImageToMask, VAEEncode, SetLatentNoiseMask, KSampler, VAEDecode,
 * ImageCompositeMasked (+ CLIPTextEncode / ConditioningZeroOut on the Krea 2
 * bbox graph, whose own sampler conditioning is outpaint-specific).
 */

import type { Workflow } from "@/types";

type Link = [string, number];

/** Where the source sits on the outpainted canvas (x1/y1 exclusive). */
export interface SeamPlacement {
  canvasWidth: number;
  canvasHeight: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SeamHarmonizeOptions {
  /** img2img strength of the band pass. */
  denoise: number;
  /** Full band width straddling the seam (half inside, half outside). */
  bandPx: number;
  /** Blur radius softening the composite mask edges. */
  featherPx: number;
}

export const SEAM_HARMONIZE_DEFAULTS: SeamHarmonizeOptions = {
  denoise: 0.3,
  bandPx: 48,
  featherPx: 16,
};

export interface SeamRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SeamBand {
  /** Padded sides: these edges of the source are seams. */
  sides: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  /** Source rect grown by `half` on each seam side (clamped to the canvas). */
  outer: SeamRect;
  /** Source rect shrunk by `half` on each seam side; null = band covers it all. */
  inner: SeamRect | null;
}

/**
 * Band = outer minus inner: a strip `2*half` wide centred on every seam edge.
 * Pure. Returns null when no side is padded (nothing to harmonize).
 */
export function planSeamBand(p: SeamPlacement, half: number): SeamBand | null {
  const W = p.canvasWidth;
  const H = p.canvasHeight;
  const sides = {
    left: p.x0 > 0,
    right: p.x1 < W,
    top: p.y0 > 0,
    bottom: p.y1 < H,
  };
  if (!sides.left && !sides.right && !sides.top && !sides.bottom) return null;
  const h = Math.max(1, Math.round(half));
  const ox0 = Math.max(0, p.x0 - (sides.left ? h : 0));
  const oy0 = Math.max(0, p.y0 - (sides.top ? h : 0));
  const ox1 = Math.min(W, p.x1 + (sides.right ? h : 0));
  const oy1 = Math.min(H, p.y1 + (sides.bottom ? h : 0));
  const ix0 = p.x0 + (sides.left ? h : 0);
  const iy0 = p.y0 + (sides.top ? h : 0);
  const ix1 = p.x1 - (sides.right ? h : 0);
  const iy1 = p.y1 - (sides.bottom ? h : 0);
  return {
    sides,
    outer: { x: ox0, y: oy0, width: ox1 - ox0, height: oy1 - oy0 },
    inner:
      ix1 > ix0 && iy1 > iy0
        ? { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 }
        : null,
  };
}

function isLink(v: unknown): v is Link {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
  );
}

function firstId(
  workflow: Workflow,
  pred: (id: string) => boolean,
): string | undefined {
  return Object.keys(workflow).find(pred);
}

function nextIdFrom(workflow: Workflow, floor: number): () => string {
  let n = Math.max(
    floor,
    ...Object.keys(workflow)
      .map((k) => Number(k))
      .filter((k) => Number.isInteger(k))
      .map((k) => k + 1),
  );
  return () => String(n++);
}

/** Title marker on every node the pass adds (tests + idempotency). */
export const SEAM_TITLE_PREFIX = "Seam harmonize";

/**
 * Append the harmonize pass in front of the graph's SaveImage. Returns the id
 * of the final ImageCompositeMasked, or null when the graph lacks a piece
 * (no SaveImage / KSampler / VAE, or nothing padded) — the graph is then left
 * untouched. Idempotent: a graph that already has the pass is not changed.
 */
export function addSeamHarmonize(
  workflow: Workflow,
  placement: SeamPlacement,
  opts: SeamHarmonizeOptions = SEAM_HARMONIZE_DEFAULTS,
  ksamplerId?: string,
): string | null {
  if (
    Object.values(workflow).some((n) =>
      n._meta?.title?.startsWith(SEAM_TITLE_PREFIX),
    )
  )
    return null;
  const featherPx = Math.max(0, Math.min(31, Math.round(opts.featherPx)));
  const half = Math.max(4, Math.round(opts.bandPx / 2));
  const band = planSeamBand(placement, half);
  // The latent noise band also covers the composite mask's blur tail.
  const noiseBand = planSeamBand(placement, half + featherPx);
  if (!band || !noiseBand) return null;

  const saveId = firstId(
    workflow,
    (id) =>
      workflow[id].class_type === "SaveImage" &&
      isLink(workflow[id].inputs.images),
  );
  const samplerId =
    ksamplerId && workflow[ksamplerId]?.class_type === "KSampler"
      ? ksamplerId
      : firstId(workflow, (id) => workflow[id].class_type === "KSampler");
  const decodeId = firstId(
    workflow,
    (id) =>
      /^VAEDecode/.test(workflow[id].class_type) &&
      isLink(workflow[id].inputs.vae),
  );
  if (!saveId || !samplerId || !decodeId) return null;
  const sampler = workflow[samplerId].inputs;
  const finalImage = workflow[saveId].inputs.images as Link;
  const vae = workflow[decodeId].inputs.vae as Link;
  if (
    !isLink(sampler.model) ||
    !isLink(sampler.positive) ||
    !isLink(sampler.negative)
  )
    return null;

  const id = nextIdFrom(workflow, 950);
  const add = (
    classType: string,
    inputs: Record<string, unknown>,
    title: string,
  ): string => {
    const nid = id();
    workflow[nid] = {
      class_type: classType,
      inputs,
      _meta: { title: `${SEAM_TITLE_PREFIX}: ${title}` },
    };
    return nid;
  };

  let model: Link = sampler.model;
  let positive: Link = sampler.positive;
  let negative: Link = sampler.negative;
  // Krea 2 bbox outpaint: the sampler runs the outpaint LoRA + model patch on
  // TextEncodeKrea2Outpaint (reference-image) conditioning, which only makes
  // sense on the generated canvas. The band pass is a plain img2img: base
  // UNET (before the LoRA) and a plain text encode of the same prompt.
  const encId = isLink(positive) ? positive[0] : undefined;
  const enc = encId ? workflow[encId] : undefined;
  if (
    enc?.class_type === "TextEncodeKrea2Outpaint" &&
    isLink(enc.inputs.clip)
  ) {
    const unetId = firstId(
      workflow,
      (nid) => workflow[nid].class_type === "UNETLoader",
    );
    if (unetId) model = [unetId, 0];
    const pos = add(
      "CLIPTextEncode",
      {
        clip: enc.inputs.clip,
        text: typeof enc.inputs.prompt === "string" ? enc.inputs.prompt : "",
      },
      "prompt",
    );
    positive = [pos, 0];
    negative = [
      add("ConditioningZeroOut", { conditioning: positive }, "negative"),
      0,
    ];
  }

  const W = placement.canvasWidth;
  const H = placement.canvasHeight;
  const bandMask = (b: SeamBand, title: string): Link => {
    const base = add(
      "SolidMask",
      { value: 0, width: W, height: H },
      `${title} canvas`,
    );
    const outerRect = add(
      "SolidMask",
      { value: 1, width: b.outer.width, height: b.outer.height },
      `${title} outer`,
    );
    let mask = add(
      "MaskComposite",
      {
        destination: [base, 0],
        source: [outerRect, 0],
        x: b.outer.x,
        y: b.outer.y,
        operation: "add",
      },
      `${title} add outer`,
    );
    if (b.inner) {
      const innerRect = add(
        "SolidMask",
        { value: 1, width: b.inner.width, height: b.inner.height },
        `${title} inner`,
      );
      mask = add(
        "MaskComposite",
        {
          destination: [mask, 0],
          source: [innerRect, 0],
          x: b.inner.x,
          y: b.inner.y,
          operation: "subtract",
        },
        `${title} cut inner`,
      );
    }
    return [mask, 0];
  };

  const noiseMask = bandMask(noiseBand, "noise band");
  let blendMask = bandMask(band, "blend band");
  if (featherPx > 0) {
    const asImage = add("MaskToImage", { mask: blendMask }, "feather in");
    const blurred = add(
      "ImageBlur",
      {
        image: [asImage, 0],
        blur_radius: featherPx,
        sigma: Math.min(10, Math.max(0.1, featherPx / 2)),
      },
      "feather",
    );
    blendMask = [
      add(
        "ImageToMask",
        { image: [blurred, 0], channel: "red" },
        "feather out",
      ),
      0,
    ];
  }

  const encoded = add("VAEEncode", { pixels: finalImage, vae }, "encode");
  const masked = add(
    "SetLatentNoiseMask",
    { samples: [encoded, 0], mask: noiseMask },
    "noise mask",
  );
  const resampled = add(
    "KSampler",
    {
      model,
      positive,
      negative,
      latent_image: [masked, 0],
      seed: sampler.seed ?? 0,
      steps: sampler.steps ?? 8,
      cfg: sampler.cfg ?? 1,
      sampler_name: sampler.sampler_name ?? "euler",
      scheduler: sampler.scheduler ?? "simple",
      denoise: Math.min(1, Math.max(0.05, opts.denoise)),
    },
    "sampler",
  );
  const decoded = add("VAEDecode", { samples: [resampled, 0], vae }, "decode");
  const composite = add(
    "ImageCompositeMasked",
    {
      destination: finalImage,
      source: [decoded, 0],
      x: 0,
      y: 0,
      resize_source: false,
      mask: blendMask,
    },
    "composite",
  );
  workflow[saveId].inputs.images = [composite, 0];
  return composite;
}
