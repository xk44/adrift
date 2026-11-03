/**
 * Outpaint padding + mask-fill image prep for the LoRA edit tools.
 *
 * Geometry is pure (`planOutpaint`); pixel work uses `sharp`, which ships with
 * Next.js (image optimizer) and is imported lazily so geometry stays testable
 * without it.
 *
 * Conventions (from the LoRA cards):
 *   - Qwen 2.1 / FLUX.3 Klein outpaint: pad the canvas with solid #808080.
 *   - Krea 2 inpaint v2: the region to (re)generate is filled solid black.
 */

export const OUTPAINT_FILL = { r: 128, g: 128, b: 128 } as const;

/** Canvas dimensions are rounded up to a multiple of this (VAE/patch friendly). */
export const CANVAS_MULTIPLE = 16;
/** Above this many canvas pixels the source is downscaled before padding. */
export const MAX_CANVAS_PIXELS = 2048 * 2048;
/** Per-side padding cap, as a fraction of the source side. */
export const MAX_SIDE_FRACTION = 1;
/** Accepted target aspect range for `aspect` mode. */
export const MIN_ASPECT = 1 / 4;
export const MAX_ASPECT = 4;

export type OutpaintAnchor = "center" | "left" | "right" | "top" | "bottom";

export interface OutpaintSides {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A resolved padding request: explicit per-side fractions OR a target aspect. */
export type OutpaintSpec =
  | { kind: "sides"; sides: OutpaintSides }
  | { kind: "aspect"; aspect: number; anchor: OutpaintAnchor };

export interface OutpaintPlan {
  /** Source size after the optional downscale. */
  srcWidth: number;
  srcHeight: number;
  /** Source downscale factor (1 = untouched). */
  scale: number;
  /** Padding in output pixels. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Final canvas size. */
  width: number;
  height: number;
}

export class OutpaintError extends Error {}

const ceilTo = (n: number, m: number) => Math.ceil(n / m) * m;

/** Parse "16:9" / "1.78" into a width/height ratio, or null if invalid. */
export function parseAspect(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw >= MIN_ASPECT && raw <= MAX_ASPECT ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  let ratio: number;
  if (m) {
    const h = Number(m[2]);
    if (!(h > 0)) return null;
    ratio = Number(m[1]) / h;
  } else if (/^\s*\d+(?:\.\d+)?\s*$/.test(raw)) {
    ratio = Number(raw);
  } else {
    return null;
  }
  return Number.isFinite(ratio) && ratio >= MIN_ASPECT && ratio <= MAX_ASPECT
    ? ratio
    : null;
}

/**
 * Work out padding for a w x h source. Pure.
 *  - "sides": each side pads `fraction * (that axis of the source)` pixels.
 *  - "aspect": grow ONE axis until width/height == aspect; the added pixels are
 *    split by `anchor` (center splits evenly, left/right/top/bottom puts the
 *    source against that edge so all padding lands on the opposite side).
 * The canvas is then rounded up to CANVAS_MULTIPLE (extra goes right/bottom)
 * and, if over MAX_CANVAS_PIXELS, the source is downscaled first so the canvas
 * fits.
 */
export function planOutpaint(
  width: number,
  height: number,
  spec: OutpaintSpec,
  limits: { maxCanvasPixels?: number; multiple?: number } = {},
): OutpaintPlan {
  if (!(
    Number.isInteger(width) &&
    width > 0 &&
    Number.isInteger(height) &&
    height > 0
  )) {
    throw new OutpaintError("Source image has invalid dimensions");
  }
  const multiple = limits.multiple ?? CANVAS_MULTIPLE;
  const maxPixels = limits.maxCanvasPixels ?? MAX_CANVAS_PIXELS;

  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;

  if (spec.kind === "sides") {
    const s = spec.sides;
    for (const [name, v] of Object.entries(s)) {
      if (!Number.isFinite(v) || v < 0 || v > MAX_SIDE_FRACTION) {
        throw new OutpaintError(
          `Outpaint ${name} must be between 0 and ${MAX_SIDE_FRACTION}`,
        );
      }
    }
    left = Math.round(s.left * width);
    right = Math.round(s.right * width);
    top = Math.round(s.top * height);
    bottom = Math.round(s.bottom * height);
  } else {
    const target = spec.aspect;
    if (!(target >= MIN_ASPECT && target <= MAX_ASPECT)) {
      throw new OutpaintError("Outpaint aspect out of range");
    }
    const current = width / height;
    if (target > current) {
      const extra = Math.max(0, Math.round(height * target) - width);
      const [l, r] = splitExtra(extra, spec.anchor, "left", "right");
      left = l;
      right = r;
    } else if (target < current) {
      const extra = Math.max(0, Math.round(width / target) - height);
      const [t, b] = splitExtra(extra, spec.anchor, "top", "bottom");
      top = t;
      bottom = b;
    }
  }

  if (left + right + top + bottom === 0) {
    throw new OutpaintError("Outpaint adds no padding");
  }

  let canvasW = width + left + right;
  let canvasH = height + top + bottom;
  let scale = 1;
  let srcW = width;
  let srcH = height;

  if (canvasW * canvasH > maxPixels) {
    scale = Math.sqrt(maxPixels / (canvasW * canvasH));
    srcW = Math.max(1, Math.round(width * scale));
    srcH = Math.max(1, Math.round(height * scale));
    left = Math.round(left * scale);
    right = Math.round(right * scale);
    top = Math.round(top * scale);
    bottom = Math.round(bottom * scale);
    canvasW = srcW + left + right;
    canvasH = srcH + top + bottom;
  }

  // Round the canvas up; the slack becomes extra padding on the right/bottom.
  const roundedW = ceilTo(canvasW, multiple);
  const roundedH = ceilTo(canvasH, multiple);
  right += roundedW - canvasW;
  bottom += roundedH - canvasH;

  return {
    srcWidth: srcW,
    srcHeight: srcH,
    scale,
    left,
    right,
    top,
    bottom,
    width: roundedW,
    height: roundedH,
  };
}

function splitExtra(
  extra: number,
  anchor: OutpaintAnchor,
  low: "left" | "top",
  high: "right" | "bottom",
): [number, number] {
  // anchor === low edge: source hugs the low edge -> all padding on the high side.
  if (anchor === low) return [0, extra];
  if (anchor === high) return [extra, 0];
  const first = Math.floor(extra / 2);
  return [first, extra - first];
}

// Pixel work (sharp)

type SharpFn = typeof import("sharp");

async function loadSharp(): Promise<SharpFn> {
  const mod = (await import("sharp")) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}

export async function readImageSize(
  image: Uint8Array,
): Promise<{ width: number; height: number }> {
  const sharp = await loadSharp();
  const meta = await sharp(Buffer.from(image)).metadata();
  if (!meta.width || !meta.height) {
    throw new OutpaintError("Could not read image dimensions");
  }
  // EXIF orientations 5-8 swap the axes (applyOutpaintPlan/applyMaskFill rotate).
  const swap = (meta.orientation ?? 1) >= 5;
  return swap
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

/**
 * Fit width x height inside an exact target canvas without cropping and pad the
 * rest (centered) — e.g. the 1344x768 gray frame the character-sheet LoRA was
 * trained on. Feed the result to applyOutpaintPlan.
 */
export function planLetterbox(
  width: number,
  height: number,
  target: { width: number; height: number },
): OutpaintPlan {
  if (!(width > 0 && height > 0)) throw new OutpaintError("Image has no size");
  const scale = Math.min(target.width / width, target.height / height);
  const srcWidth = Math.min(target.width, Math.max(1, Math.round(width * scale)));
  const srcHeight = Math.min(target.height, Math.max(1, Math.round(height * scale)));
  const left = Math.floor((target.width - srcWidth) / 2);
  const top = Math.floor((target.height - srcHeight) / 2);
  return {
    srcWidth,
    srcHeight,
    scale,
    left,
    right: target.width - srcWidth - left,
    top,
    bottom: target.height - srcHeight - top,
    width: target.width,
    height: target.height,
  };
}

export async function applyOutpaintPlan(
  image: Uint8Array,
  plan: OutpaintPlan,
): Promise<Buffer> {
  const sharp = await loadSharp();
  let pipeline = sharp(Buffer.from(image)).rotate().flatten({
    background: OUTPAINT_FILL,
  });
  if (plan.scale !== 1) {
    pipeline = pipeline.resize(plan.srcWidth, plan.srcHeight, { fit: "fill" });
  }
  return pipeline
    .extend({
      top: plan.top,
      bottom: plan.bottom,
      left: plan.left,
      right: plan.right,
      background: OUTPAINT_FILL,
    })
    .png()
    .toBuffer();
}

/**
 * Black-fill the masked region (Krea 2 inpaint v2 convention).
 * Mask: any image; luminance >= 128 (after flattening transparency onto black)
 * is "fill here", so white strokes on transparent or black both work.
 * The mask is resized to the image if the sizes differ.
 */
export async function applyMaskFill(
  image: Uint8Array,
  mask: Uint8Array,
): Promise<{ png: Buffer; width: number; height: number }> {
  const sharp = await loadSharp();
  const base = sharp(Buffer.from(image))
    .rotate()
    .flatten({
      background: { r: 255, g: 255, b: 255 },
    });
  const { data: baseRgb, info } = await base
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const maskRaw = await sharp(Buffer.from(mask))
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .threshold(128)
    .raw()
    .toBuffer();

  const out = Buffer.from(baseRgb);
  let filled = 0;
  for (let i = 0; i < width * height; i++) {
    if (maskRaw[i] >= 128) {
      out[i * 3] = 0;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
      filled++;
    }
  }
  if (filled === 0) {
    throw new OutpaintError("Mask is empty: nothing to fill");
  }
  const png = await sharp(out, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, width, height };
}

// Krea 2 bbox outpaint (no pixel prep)

/** One Krea 2 outpaint pass: canvas size + where the source sits on it. */
export interface Krea2OutpaintPass {
  canvasWidth: number;
  canvasHeight: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Krea 2 outpaint LoRA geometry. The LoRA takes the ORIGINAL image registered
 * at a canvas bbox (TextEncodeKrea2Outpaint) and the composite node resizes it
 * back into that bbox, so nothing is padded here: the canvas is just scaled to
 * ~`megapixels` MP (sides multiple of 16, bbox edges multiple of 8).
 *
 * The model card's input contract: a single pass needs the source box to span
 * the full canvas width or height. Padding on both axes therefore runs two
 * passes (the card's outpaint.py `plan_passes`): first extend one axis on an
 * intermediate canvas, then the other; the axis whose intermediate canvas is
 * smaller goes first. `passes` has 1 or 2 entries; the last is the output.
 */
export interface Krea2OutpaintPlacement {
  passes: Krea2OutpaintPass[];
}

export function planKrea2Outpaint(
  width: number,
  height: number,
  spec: OutpaintSpec,
  megapixels = 1,
): Krea2OutpaintPlacement {
  // geometry at native resolution, no downscale, no canvas rounding
  const plan = planOutpaint(width, height, spec, {
    maxCanvasPixels: Number.POSITIVE_INFINITY,
    multiple: 1,
  });
  const s = Math.sqrt((megapixels * 1024 * 1024) / (plan.width * plan.height));
  const W = Math.max(16, Math.round((plan.width * s) / 16) * 16);
  const H = Math.max(16, Math.round((plan.height * s) / 16) * 16);
  const sx = W / plan.width;
  const sy = H / plan.height;
  const snap = (v: number, max: number) =>
    Math.min(max, Math.max(0, Math.round(v / 8) * 8));
  const x0 = snap(plan.left * sx, W - 8);
  const y0 = snap(plan.top * sy, H - 8);
  const x1 = Math.max(x0 + 8, snap((plan.left + plan.srcWidth) * sx, W));
  const y1 = Math.max(y0 + 8, snap((plan.top + plan.srcHeight) * sy, H));
  const final: Krea2OutpaintPass = { canvasWidth: W, canvasHeight: H, x0, y0, x1, y1 };
  if ((x0 === 0 && x1 === W) || (y0 === 0 && y1 === H)) {
    return { passes: [final] };
  }

  const bw = x1 - x0;
  const bh = y1 - y0;
  const align16 = (v: number) => Math.ceil(v / 16) * 16;
  // centered offset of the intermediate strip, on the 8 px grid, inside the canvas
  const offset = (lo: number, size: number, box: number, total: number) =>
    Math.min(total - size, Math.max(0, Math.floor((lo - (size - box) / 2) / 8) * 8));

  const candidates: Array<{ area: number; axis: string; passes: Krea2OutpaintPass[] }> = [];
  const ih = align16(bh);
  if (ih < H) {
    // horizontal first: full-width strip as tall as the source, then grow vertically
    const iy = offset(y0, ih, bh, H);
    candidates.push({
      area: W * ih,
      axis: "horizontal_first",
      passes: [
        { canvasWidth: W, canvasHeight: ih, x0, y0: y0 - iy, x1, y1: y0 - iy + bh },
        { canvasWidth: W, canvasHeight: H, x0: 0, y0: iy, x1: W, y1: iy + ih },
      ],
    });
  }
  const iw = align16(bw);
  if (iw < W) {
    const ix = offset(x0, iw, bw, W);
    candidates.push({
      area: iw * H,
      axis: "vertical_first",
      passes: [
        { canvasWidth: iw, canvasHeight: H, x0: x0 - ix, y0, x1: x0 - ix + bw, y1 },
        { canvasWidth: W, canvasHeight: H, x0: ix, y0: 0, x1: ix + iw, y1: H },
      ],
    });
  }
  if (candidates.length === 0) return { passes: [final] };
  candidates.sort((a, b) => a.area - b.area || a.axis.localeCompare(b.axis));
  return { passes: candidates[0].passes };
}

// Krea 2 AnyPaint (arbitrary-mask inpaint / outpaint)

/** Longest AnyPaint canvas side (the nodes accept up to 8192). */
export const ANYPAINT_MAX_SIDE = 4096;

/** Single-pass AnyPaint geometry: canvas + integer source bbox (x1/y1 exclusive). */
export interface AnyPaintPlacement {
  canvasWidth: number;
  canvasHeight: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The reference `prepare_anypaint` aspect check: the bbox must keep the source
 * aspect within max(2.5%, 2 px of the short box side).
 */
export function anyPaintAspectOk(
  srcWidth: number,
  srcHeight: number,
  boxWidth: number,
  boxHeight: number,
): boolean {
  const tolerance = Math.max(0.025, 2 / Math.min(boxWidth, boxHeight));
  return (
    Math.abs(boxWidth / boxHeight / (srcWidth / srcHeight) - 1) <= tolerance
  );
}

/**
 * AnyPaint canvas (~`megapixels`, multiples of 16) and where the source sits.
 * No spec = same-canvas inpaint (bbox = whole canvas). With a spec the canvas
 * grows like planOutpaint; axes without padding are spanned exactly and the
 * box keeps the source aspect (integer pixels, no 8 px snap).
 */
export function planAnyPaint(
  width: number,
  height: number,
  spec?: OutpaintSpec,
  megapixels = 1,
): AnyPaintPlacement {
  const target = megapixels * 1024 * 1024;
  const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  const check = (p: AnyPaintPlacement): AnyPaintPlacement => {
    const bw = p.x1 - p.x0;
    const bh = p.y1 - p.y0;
    if (Math.max(p.canvasWidth, p.canvasHeight) > ANYPAINT_MAX_SIDE) {
      throw new OutpaintError(
        `Inpaint + Expand canvas ${p.canvasWidth}x${p.canvasHeight} is too elongated (max side ${ANYPAINT_MAX_SIDE}); crop the image first`,
      );
    }
    if (bw < 1 || bh < 1 || !anyPaintAspectOk(width, height, bw, bh)) {
      throw new OutpaintError(
        `Inpaint + Expand cannot place a ${width}x${height} image on a ${p.canvasWidth}x${p.canvasHeight} canvas without distorting it; crop it to a less extreme aspect ratio`,
      );
    }
    return p;
  };

  let plan: OutpaintPlan | null = null;
  if (spec) {
    try {
      plan = planOutpaint(width, height, spec, {
        maxCanvasPixels: Number.POSITIVE_INFINITY,
        multiple: 1,
      });
    } catch (e) {
      // an aspect preset equal to the source's = same-canvas inpaint
      if (!(e instanceof OutpaintError && /no padding/.test(e.message))) throw e;
    }
  }
  const padX = !!plan && plan.width > plan.srcWidth;
  const padY = !!plan && plan.height > plan.srcHeight;
  if (!plan || (!padX && !padY)) {
    const s = Math.sqrt(target / (width * height));
    const W = round16(width * s);
    const H = round16(height * s);
    return check({ canvasWidth: W, canvasHeight: H, x0: 0, y0: 0, x1: W, y1: H });
  }

  const s = Math.sqrt(target / (plan.width * plan.height));
  const W = round16(plan.width * s);
  const H = round16(plan.height * s);
  let bw: number;
  let bh: number;
  if (!padX) {
    bw = W;
    bh = Math.min(H, Math.round((W * height) / width));
  } else if (!padY) {
    bh = H;
    bw = Math.min(W, Math.round((H * width) / height));
  } else {
    const f = Math.min(1, W / (width * s), H / (height * s));
    bw = Math.min(W, Math.max(1, Math.round(width * s * f)));
    bh = Math.min(H, Math.max(1, Math.round(height * s * f)));
  }
  // split the free space in the planned near:far padding ratio (0 = flush)
  const place = (near: number, far: number, free: number) =>
    near + far > 0 ? Math.round((free * near) / (near + far)) : 0;
  const x0 = place(plan.left, plan.right, W - bw);
  const y0 = place(plan.top, plan.bottom, H - bh);
  return check({
    canvasWidth: W,
    canvasHeight: H,
    x0,
    y0,
    x1: x0 + bw,
    y1: y0 + bh,
  });
}

/**
 * AnyPaint mask, normalized to the (EXIF-rotated) source size: flattened on
 * black, grayscale, thresholded at 128 (white = generate), written as an RGB
 * PNG for LoadImageMask(channel "red"). No mask = all black (pure outpaint).
 * An empty mask throws unless `allowEmpty` (the canvas grows, so there is
 * still something to generate).
 */
export async function prepareAnyPaintMask(
  image: Uint8Array,
  mask: Uint8Array | undefined,
  allowEmpty: boolean,
): Promise<{ png: Buffer; width: number; height: number; white: number }> {
  const sharp = await loadSharp();
  const { width, height } = await readImageSize(image);
  let bin: Buffer;
  if (mask) {
    bin = await sharp(Buffer.from(mask))
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize(width, height, { fit: "fill", kernel: "nearest" })
      .grayscale()
      .threshold(128)
      .raw()
      .toBuffer();
  } else {
    bin = Buffer.alloc(width * height);
  }
  const rgb = Buffer.alloc(width * height * 3);
  let white = 0;
  for (let i = 0; i < width * height; i++) {
    const v = bin[i] >= 128 ? 255 : 0;
    if (v) white++;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  if (white === 0 && !allowEmpty) {
    throw new OutpaintError("Mask is empty: paint the area to generate");
  }
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, width, height, white };
}
