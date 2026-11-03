/**
 * Client-side Color Grade (no model): per-pixel grade math over RGBA buffers,
 * applied on a canvas and exported as PNG. Pure so it can be unit-tested.
 */

export interface GradeSettings {
  /** Stops, -2..2. */
  exposure: number;
  /** -100..100 for the rest. */
  contrast: number;
  saturation: number;
  /** Warm (+) / cool (-). */
  temperature: number;
  /** Magenta (+) / green (-). */
  tint: number;
  highlights: number;
  shadows: number;
  /** Lifted blacks, 0..100. */
  fade: number;
  /** 0..100. */
  vignette: number;
  /** 0..100. */
  grain: number;
}

export const NEUTRAL_GRADE: GradeSettings = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
};

export interface GradeSlider {
  key: keyof GradeSettings;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const GRADE_SLIDERS: GradeSlider[] = [
  { key: "exposure", label: "Exposure", min: -2, max: 2, step: 0.05 },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1 },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1 },
  { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1 },
  { key: "tint", label: "Tint", min: -100, max: 100, step: 1 },
  { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1 },
  { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1 },
  { key: "fade", label: "Fade", min: 0, max: 100, step: 1 },
  { key: "vignette", label: "Vignette", min: 0, max: 100, step: 1 },
  { key: "grain", label: "Grain", min: 0, max: 100, step: 1 },
];

export interface GradePreset {
  id: string;
  label: string;
  settings: Partial<GradeSettings>;
}

export const GRADE_PRESETS: GradePreset[] = [
  { id: "none", label: "Original", settings: {} },
  {
    id: "teal_orange",
    label: "Teal & Orange",
    settings: {
      contrast: 20,
      saturation: 15,
      temperature: 18,
      tint: -6,
      shadows: -10,
      highlights: -10,
    },
  },
  {
    id: "kodak",
    label: "Warm Film",
    settings: {
      contrast: 10,
      saturation: -5,
      temperature: 25,
      fade: 18,
      grain: 25,
      highlights: -15,
    },
  },
  {
    id: "bleach",
    label: "Bleach Bypass",
    settings: {
      contrast: 45,
      saturation: -55,
      highlights: 10,
      shadows: -15,
      grain: 15,
    },
  },
  {
    id: "noir",
    label: "Noir",
    settings: {
      contrast: 50,
      saturation: -100,
      shadows: -20,
      vignette: 45,
      grain: 30,
    },
  },
  {
    id: "cool_night",
    label: "Cool Night",
    settings: {
      exposure: -0.3,
      temperature: -40,
      tint: 8,
      contrast: 15,
      vignette: 30,
    },
  },
  {
    id: "pastel",
    label: "Pastel",
    settings: {
      exposure: 0.25,
      contrast: -25,
      saturation: -20,
      fade: 30,
      highlights: -10,
    },
  },
  {
    id: "vivid",
    label: "Vivid Pop",
    settings: { contrast: 25, saturation: 40, shadows: 10, vignette: 15 },
  },
  {
    id: "golden",
    label: "Golden Hour",
    settings: {
      exposure: 0.15,
      temperature: 45,
      tint: 6,
      saturation: 10,
      highlights: -20,
      fade: 8,
    },
  },
];

export function presetSettings(id: string): GradeSettings {
  const p = GRADE_PRESETS.find((x) => x.id === id);
  return { ...NEUTRAL_GRADE, ...(p?.settings ?? {}) };
}

export function isNeutral(s: GradeSettings): boolean {
  return (Object.keys(NEUTRAL_GRADE) as (keyof GradeSettings)[]).every(
    (k) => s[k] === NEUTRAL_GRADE[k],
  );
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Deterministic hash noise in [-1, 1] for pixel i (stable exports). */
function noise(i: number): number {
  let x = (i ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x / 0xffffffff) * 2 - 1;
}

/**
 * Grade one RGB triple (0..1). Exposed for tests; `applyGrade` runs it over
 * a buffer and adds the position-dependent effects (vignette, grain).
 */
export function gradeRgb(
  r: number,
  g: number,
  b: number,
  s: GradeSettings,
): [number, number, number] {
  const gain = Math.pow(2, s.exposure);
  r *= gain;
  g *= gain;
  b *= gain;

  // White balance: temperature shifts red/blue, tint shifts green.
  const t = s.temperature / 100;
  const ti = s.tint / 100;
  r *= 1 + 0.15 * t;
  b *= 1 - 0.15 * t;
  g *= 1 - 0.1 * ti;

  // Tone: shadows/highlights lift/compress weighted by luminance.
  let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sh = (s.shadows / 100) * 0.35 * Math.pow(1 - clamp01(l), 2);
  const hi = (s.highlights / 100) * 0.35 * Math.pow(clamp01(l), 2);
  r += sh + hi;
  g += sh + hi;
  b += sh + hi;

  // Contrast around mid-gray.
  const c = 1 + s.contrast / 100;
  r = (r - 0.5) * c + 0.5;
  g = (g - 0.5) * c + 0.5;
  b = (b - 0.5) * c + 0.5;

  // Saturation around luminance.
  l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = 1 + s.saturation / 100;
  r = l + (r - l) * sat;
  g = l + (g - l) * sat;
  b = l + (b - l) * sat;

  // Fade: lift blacks.
  const f = (s.fade / 100) * 0.25;
  r = f + clamp01(r) * (1 - f);
  g = f + clamp01(g) * (1 - f);
  b = f + clamp01(b) * (1 - f);

  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** Grade an RGBA buffer in place (alpha untouched). */
export function applyGrade(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  s: GradeSettings,
): void {
  if (isNeutral(s)) return;
  const cx = width / 2;
  const cy = height / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  const vig = s.vignette / 100;
  const grain = (s.grain / 100) * 0.08;
  // 256-entry LUT for the position-independent part is not separable
  // (saturation mixes channels), so grade per pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let [r, g, b] = gradeRgb(
        data[i] / 255,
        data[i + 1] / 255,
        data[i + 2] / 255,
        s,
      );
      if (vig > 0) {
        const d = Math.hypot(x - cx, y - cy) / maxD;
        const k = 1 - vig * 0.75 * Math.pow(Math.max(0, d - 0.35) / 0.65, 2);
        r *= k;
        g *= k;
        b *= k;
      }
      if (grain > 0) {
        const n = noise(y * width + x) * grain;
        r += n;
        g += n;
        b += n;
      }
      data[i] = Math.round(clamp01(r) * 255);
      data[i + 1] = Math.round(clamp01(g) * 255);
      data[i + 2] = Math.round(clamp01(b) * 255);
    }
  }
}

/** Preview canvas size: longest side capped, aspect kept. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
