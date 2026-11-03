/**
 * Video Color Palette: regrade a clip to a palette (preset, hex list from the
 * lightbox Palette, or a reference still). Pure helpers shared by the tools
 * page (pickers, swatch preview, request params) and the action builder
 * (src/lib/oj/videoPalette.ts → one CJVideoPalette node,
 * comfy_nodes/cj_h3_tools/cj_video_palette.py).
 *
 * The node fits ONE grade per clip (OKLab mean+covariance transfer, plus a
 * soft nearest-swatch pull for palettes) from frames sampled across the clip,
 * bakes it into a 33^3 LUT (also written as a .cube next to the MP4) and
 * applies that LUT to every frame, so the result cannot flicker.
 */

export const VIDEO_PALETTE_ACTION = "video_palette";
export const VIDEO_PALETTE_MAX_COLORS = 16;
export const VIDEO_PALETTE_DEFAULT_STRENGTH = 80;
/** Skin protection amount sent when "Protect" is picked (0..1). */
export const VIDEO_PALETTE_SKIN_PROTECT = 0.85;

export type VideoPaletteSource = "preset" | "hex" | "reference";

export interface PalettePreset {
  id: string;
  label: string;
  colors: string[];
}

/** Adrift's own grade presets (dark → light within each). */
export const VIDEO_PALETTE_PRESETS: PalettePreset[] = [
  {
    id: "teal_orange",
    label: "Teal & Orange",
    colors: ["#0b3c49", "#1f7a8c", "#e07a2f", "#f2c48d"],
  },
  {
    id: "golden_hour",
    label: "Golden Hour",
    colors: ["#3b2418", "#a0522d", "#e8a33d", "#f6d9a0"],
  },
  {
    id: "nordic_cold",
    label: "Nordic Cold",
    colors: ["#1c2833", "#46637a", "#9db4c0", "#e3ecf0"],
  },
  {
    id: "neon_night",
    label: "Neon Night",
    colors: ["#120b2e", "#5b2a86", "#e0218a", "#22d3ee"],
  },
  {
    id: "faded_film",
    label: "Faded Film",
    colors: ["#2f3a3a", "#7d8a7a", "#c9b99a", "#efe6d2"],
  },
  {
    id: "forest_moss",
    label: "Forest Moss",
    colors: ["#1a2618", "#3f5e3a", "#8ea36b", "#d8d3b0"],
  },
  {
    id: "desert_dust",
    label: "Desert Dust",
    colors: ["#4a3426", "#a6754a", "#d9b38c", "#f1e1c6"],
  },
  {
    id: "bleach_bypass",
    label: "Bleach Bypass",
    colors: ["#1e1f22", "#5c6066", "#a7a9ab", "#e4e2dc"],
  },
  {
    id: "rose_dusk",
    label: "Rose Dusk",
    colors: ["#2b1d33", "#7a4a6b", "#d98c8c", "#f5cfc4"],
  },
  {
    id: "mint_cream",
    label: "Mint & Cream",
    colors: ["#1f3b3a", "#4f9d8e", "#bfe3d0", "#f7f1e3"],
  },
  {
    id: "noir_blue",
    label: "Noir Blue",
    colors: ["#0a0f1a", "#1d2b44", "#5a6f8f", "#c8d2e0"],
  },
  {
    id: "candlelight",
    label: "Candlelight",
    colors: ["#1a0f08", "#5c2e14", "#c46a28", "#ffd59a"],
  },
];

export function videoPalettePreset(id: string): PalettePreset | undefined {
  return VIDEO_PALETTE_PRESETS.find((p) => p.id === id);
}

export interface HexSwatch {
  hex: string;
  weight: number;
}

const TOKEN = /^#?([0-9a-f]{6}|[0-9a-f]{3})(?::(\d*\.?\d+))?$/i;

/**
 * Parse "#rrggbb[:weight], ..." (commas, spaces or semicolons; "#rgb" ok; the
 * lightbox Palette's "Copy hex" output) into swatches. Throws a readable
 * Error on a bad token, an empty list or more than 16 colours.
 */
export function parseHexPalette(text: string): HexSwatch[] {
  const tokens = String(text ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const out: HexSwatch[] = [];
  for (const t of tokens) {
    const m = TOKEN.exec(t);
    if (!m) throw new Error(`"${t.slice(0, 24)}" is not a #rrggbb colour`);
    let h = m[1].toLowerCase();
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const weight = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(weight) || weight <= 0)
      throw new Error(`The weight of "${t}" must be above 0`);
    out.push({ hex: `#${h}`, weight });
  }
  if (out.length === 0) throw new Error("Add at least one hex colour");
  if (out.length > VIDEO_PALETTE_MAX_COLORS)
    throw new Error(`At most ${VIDEO_PALETTE_MAX_COLORS} colours`);
  return out;
}

/** Canonical node string: "#rrggbb" (weight 1) or "#rrggbb:w", comma separated. */
export function formatHexPalette(swatches: HexSwatch[]): string {
  return swatches
    .map((s) => (s.weight === 1 ? s.hex : `${s.hex}:${+s.weight.toFixed(4)}`))
    .join(", ");
}

/** Swatches for the runner preview; never throws (bad text → []). */
export function previewSwatches(
  source: string,
  presetId: string,
  text: string,
): HexSwatch[] {
  if (source === "preset") {
    const p = videoPalettePreset(presetId) ?? VIDEO_PALETTE_PRESETS[0];
    return p.colors.map((hex) => ({ hex, weight: 1 }));
  }
  if (source === "hex") {
    try {
      return parseHexPalette(text);
    } catch {
      return [];
    }
  }
  return [];
}

/** Strength percent (0..100, any input) → node strength 0..1. */
export function strengthFraction(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return VIDEO_PALETTE_DEFAULT_STRENGTH / 100;
  return Math.round(Math.min(100, Math.max(0, n))) / 100;
}
