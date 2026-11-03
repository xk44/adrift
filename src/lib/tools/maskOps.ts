/**
 * Mask edge tools for the tool runner's MaskPainter: grow / shrink, soften
 * (feather) and invert, applied when the mask is exported so the painted
 * strokes stay editable and the sliders can change at any time.
 *
 * Pure (no DOM): works on the RGBA pixels overlayToMaskPixels returns
 * (white = fill, r = g = b, alpha 255).
 */

export interface MaskAdjust {
  /** Grow (+) or shrink (-) the edge, -MASK_GROW_MAX..MASK_GROW_MAX steps. */
  grow: number;
  /** Soften the edge, 0..MASK_FEATHER_MAX steps. */
  feather: number;
  /** Swap the filled and empty areas. */
  invert: boolean;
}

export const MASK_GROW_MAX = 10;
export const MASK_FEATHER_MAX = 10;
export const NO_MASK_ADJUST: MaskAdjust = {
  grow: 0,
  feather: 0,
  invert: false,
};

/** One slider step = 0.5 % of the mask's shorter side (10 steps = 5 %). */
export function maskStepPx(steps: number, width: number, height: number) {
  return Math.round((Math.abs(steps) * Math.min(width, height)) / 200);
}

export function isMaskAdjusted(adj: MaskAdjust): boolean {
  return adj.grow !== 0 || adj.feather > 0 || adj.invert;
}

/**
 * Chamfer (3-4) distance from every pixel to the nearest pixel where
 * target[i] is true, in thirds of a pixel. Out-of-image counts as far away.
 */
function chamfer(target: Uint8Array, w: number, h: number): Int32Array {
  const INF = 1 << 29;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = target[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Binary grow (px > 0) or shrink (px < 0); values are 0 / 255. */
export function growGray(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
): Uint8ClampedArray {
  if (!px) return gray;
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = gray[i] > 127 ? 1 : 0;
  const out = new Uint8ClampedArray(w * h);
  const reach = Math.abs(px) * 3;
  if (px > 0) {
    const d = chamfer(on, w, h);
    for (let i = 0; i < out.length; i++) out[i] = d[i] <= reach ? 255 : 0;
  } else {
    const off = new Uint8Array(w * h);
    for (let i = 0; i < off.length; i++) off[i] = on[i] ? 0 : 1;
    const d = chamfer(off, w, h);
    for (let i = 0; i < out.length; i++) out[i] = d[i] > reach ? 255 : 0;
  }
  return out;
}

/** One box-blur pass along rows (dx = 1) or columns, edges clamped. */
function boxPass(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
): Float32Array {
  const out = new Float32Array(src.length);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const at = (line: number, k: number) =>
    horizontal ? line * w + k : k * w + line;
  const span = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const read = (k: number) =>
      src[at(line, Math.min(len - 1, Math.max(0, k)))];
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += read(k);
    for (let k = 0; k < len; k++) {
      out[at(line, k)] = sum / span;
      sum += read(k + r + 1) - read(k - r);
    }
  }
  return out;
}

/** Soft edge: three box blurs (close to a gaussian), radius px / 3 each. */
export function featherGray(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
): Uint8ClampedArray {
  const r = Math.max(1, Math.round(px / 3));
  if (px <= 0) return gray;
  let f: Float32Array = Float32Array.from(gray);
  for (let pass = 0; pass < 3; pass++) {
    f = boxPass(f, w, h, r, true);
    f = boxPass(f, w, h, r, false);
  }
  return Uint8ClampedArray.from(f, (v) => Math.round(v));
}

/**
 * Grow / shrink, then soften, then invert the exported mask pixels
 * (RGBA, white = fill). Returns the input untouched when nothing is set.
 */
export function adjustMaskPixels(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  adj: MaskAdjust,
): Uint8ClampedArray {
  if (!isMaskAdjusted(adj) || rgba.length !== w * h * 4) return rgba;
  let gray: Uint8ClampedArray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  const grow = Math.max(-MASK_GROW_MAX, Math.min(MASK_GROW_MAX, adj.grow));
  const feather = Math.max(0, Math.min(MASK_FEATHER_MAX, adj.feather));
  if (grow)
    gray = growGray(gray, w, h, Math.sign(grow) * maskStepPx(grow, w, h));
  if (feather) gray = featherGray(gray, w, h, maskStepPx(feather, w, h));
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < gray.length; i++) {
    const v = adj.invert ? 255 - gray[i] : gray[i];
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
