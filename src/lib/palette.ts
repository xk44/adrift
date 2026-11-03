/**
 * Palette extraction + color-verb naming for the lightbox "palette" feature.
 * The quantization and naming are pure functions over pixel data / hex strings
 * so they're unit-testable; the DOM/canvas plumbing lives in the component.
 */

export interface PaletteColor {
  hex: string;
  /** human verb, e.g. "deep teal", "warm amber" */
  name: string;
  /** share of sampled pixels, 0..1 */
  weight: number;
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Parse "#rrggbb" → [r,g,b] (0..255). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace(/^#/, "");
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return [h * 360, s, l];
}

const HUE_NAMES: Array<[number, string]> = [
  [15, "red"],
  // Orange ends ~38°: 40–50° (#e6a809 rain-jacket yellow) reads amber/gold,
  // and "orange" in a prompt pulls it too red.
  [38, "orange"],
  [50, "amber"],
  [65, "yellow"],
  [90, "lime"],
  [150, "green"],
  [190, "teal"],
  [240, "blue"],
  [280, "indigo"],
  [320, "magenta"],
  [345, "pink"],
  [360, "red"],
];

function hueName(h: number): string {
  for (const [ceil, name] of HUE_NAMES) {
    if (h <= ceil) return name;
  }
  return "red";
}

/** sRGB channel (0..255) → linear light 0..1. */
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * sRGB → OKLab lightness L (0..1) and chroma C (~0..0.32 for sRGB).
 * HSL saturation is relative to lightness and explodes near black/white
 * (#0b0d0a is 13% "saturated" in HSL), so it can't decide whether a swatch
 * has a hue at all. OKLab chroma is an absolute perceptual colorfulness.
 */
export function oklabLC(r: number, g: number, b: number): [number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  const L = 0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B)];
}

/** Below this OKLCH chroma a swatch reads as neutral at any lightness. */
const NEUTRAL_CHROMA = 0.03;
/** Very dark swatches need more chroma before a hue is perceptible. */
const DARK_L = 0.25;
const DARK_NEUTRAL_CHROMA = 0.045;

/** Neutral name by OKLab L (cut points = the old HSL bins on the pure-grey axis). */
function neutralName(L: number): string {
  if (L < 0.237) return "near-black";
  if (L < 0.418) return "charcoal";
  if (L < 0.641) return "grey";
  if (L < 0.843) return "silver";
  return "off-white";
}

/** A descriptive verb for a color, e.g. "deep teal", "pale amber", "charcoal". */
export function describeColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const [L, C] = oklabLC(r, g, b);

  const [h, s, l] = rgbToHsl(r, g, b);

  // Neutral when chroma is imperceptible — never derive a hue from noise.
  // (Low HSL saturation stays neutral too, so mid-tone greys keep their names.)
  if (
    C < NEUTRAL_CHROMA ||
    (L < DARK_L && C < DARK_NEUTRAL_CHROMA) ||
    s < 0.12
  ) {
    return neutralName(L);
  }

  // Chromatic: hue bins + modifiers stay HSL-based so names for clearly
  // saturated colors are unchanged.
  const base = hueName(h);
  let light = "";
  if (l < 0.22) light = "deep";
  else if (l < 0.4) light = "dark";
  else if (l > 0.8) light = "pale";
  else if (l > 0.65) light = "light";

  const sat = s > 0.75 && !light ? "vivid" : "";
  return [light || sat, base].filter(Boolean).join(" ");
}

/**
 * Quantize RGBA pixel data into the top `count` distinct colors.
 * Buckets each channel into `1<<bits` levels, tallies, then greedily picks the
 * heaviest buckets while skipping ones too close (in bucket space) to an already
 * chosen color, so the result is a spread rather than 5 near-identical shades.
 */
export function extractPalette(
  pixels: Uint8ClampedArray,
  count = 5,
  bits = 4,
): PaletteColor[] {
  const shift = 8 - bits;
  const buckets = new Map<
    number,
    { r: number; g: number; b: number; n: number }
  >();
  let total = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 128) continue; // skip transparent
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const key =
      ((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
    total += 1;
  }

  if (total === 0) return [];

  const sorted = [...buckets.entries()]
    .map(([key, v]) => ({
      key,
      r: Math.round(v.r / v.n),
      g: Math.round(v.g / v.n),
      b: Math.round(v.b / v.n),
      n: v.n,
    }))
    .sort((a, b) => b.n - a.n);

  const chosen: typeof sorted = [];
  const minDist = 48; // rgb euclidean-ish spacing to avoid near-duplicates
  for (const c of sorted) {
    if (chosen.length >= count) break;
    const tooClose = chosen.some((p) => {
      const dr = p.r - c.r;
      const dg = p.g - c.g;
      const db = p.b - c.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) < minDist;
    });
    if (!tooClose) chosen.push(c);
  }
  // If spacing filtered too many out, backfill from the heaviest remaining.
  if (chosen.length < count) {
    for (const c of sorted) {
      if (chosen.length >= count) break;
      if (!chosen.includes(c)) chosen.push(c);
    }
  }

  return chosen.map((c) => {
    const hex = toHex(c.r, c.g, c.b);
    return { hex, name: describeColor(hex), weight: c.n / total };
  });
}

/** Prompt fragment from selected palette colors, e.g. "deep teal, warm amber palette". */
export function palettePromptText(colors: PaletteColor[]): string {
  if (colors.length === 0) return "";
  const names = [...new Set(colors.map((c) => c.name))];
  return `${names.join(", ")} color palette`;
}

/**
 * Weighted hex list for the Video Color Palette tool, e.g.
 * "#1f3a4b:0.42, #d98c4a:0.31". Weights are pixel shares (2 decimals, at
 * least 0.01) so dominant colours pull the grade harder.
 */
export function paletteHexList(colors: PaletteColor[]): string {
  return colors
    .map((c) => {
      const w = Math.max(0.01, Math.round(c.weight * 100) / 100);
      return `${c.hex.toLowerCase()}:${w}`;
    })
    .join(", ");
}
