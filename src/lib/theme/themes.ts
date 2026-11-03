/**
 * Theme presets and accent swatches — the single source of truth for every
 * theme color in the app.
 *
 * A preset fixes the mode (light | dark, which drives data-theme, Tailwind
 * `dark:` variants and color-scheme) and supplies that mode's neutral scale
 * (the Tailwind `dark.*` or `light.*` palette) plus the semantic CSS tokens
 * (--bg-*, --text-*, --border-*, --focus-ring, scrollbar). The accent
 * (Tailwind `splash`, --accent-*) is chosen independently.
 *
 * `buildThemeCss()` turns the table into the stylesheet injected by the root
 * layout; `THEME_BOOT_SCRIPT` applies the persisted choice before first paint.
 */

import type { ThemeMode } from "@/types";
import {
  DARK_SCALE_KEYS,
  LIGHT_SCALE_KEYS,
  SPLASH_VAR,
  scaleVar,
  type DarkScaleKey,
  type LightScaleKey,
} from "./tokens";

export const SEMANTIC_COLOR_KEYS = [
  "--bg-primary",
  "--bg-secondary",
  "--bg-tertiary",
  "--bg-hover",
  "--bg-active",
  "--border-primary",
  "--border-secondary",
  "--border-accent",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-muted",
  "--focus-ring",
] as const;

export const SEMANTIC_KEYS = [
  ...SEMANTIC_COLOR_KEYS,
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
] as const;

export type SemanticKey = (typeof SEMANTIC_KEYS)[number];

interface PresetBase {
  id: string;
  name: string;
  /** One plain line for the settings card. */
  description: string;
  semantic: Record<SemanticKey, string>;
}

export interface DarkPreset extends PresetBase {
  mode: "dark";
  scale: Record<DarkScaleKey, string>;
}

export interface LightPreset extends PresetBase {
  mode: "light";
  scale: Record<LightScaleKey, string>;
}

export type ThemePreset = DarkPreset | LightPreset;

const DARK_SCROLLBAR = {
  "--scrollbar-thumb": "rgba(255, 255, 255, 0.12)",
  "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.22)",
} as const;

const LIGHT_SCROLLBAR = {
  "--scrollbar-thumb": "rgba(0, 0, 0, 0.14)",
  "--scrollbar-thumb-hover": "rgba(0, 0, 0, 0.26)",
} as const;

/** The original Adrift dark look. Values are the pre-theme hex, unchanged. */
export const ADRIFT_DARK: DarkPreset = {
  id: "adrift-dark",
  name: "Adrift Dark",
  description: "Cool near-black. The default.",
  mode: "dark",
  scale: {
    "200": "#3f3f46",
    "300": "#52525b",
    // Caption text: >= 4.5:1 (WCAG AA) on dark bg / input / 800-900.
    "400": "#8e8e97",
    "500": "#a1a1aa",
    "600": "#d4d4d8",
    "700": "#e4e4e7",
    "750": "#2a2a2e",
    "800": "#1e1e22",
    "850": "#19191d",
    "900": "#141417",
    bg: "#0d0e12",
    input: "#1a1b21",
    primary: "#f4f4f5",
  },
  semantic: {
    "--bg-primary": "#0d0e12",
    "--bg-secondary": "#1e1f25",
    "--bg-tertiary": "#16181d",
    "--bg-hover": "#292c32",
    "--bg-active": "#292c32",
    "--border-primary": "#292c32",
    "--border-secondary": "#434651",
    "--border-accent": "#434651",
    "--text-primary": "#ebecef",
    "--text-secondary": "#a3a6af",
    "--text-tertiary": "#8f929c",
    "--text-muted": "#858892",
    // Neutral, not the accent: an accent ring next to a control read as an
    // error state. ~11:1 on --bg-primary.
    "--focus-ring": "#c9cbd1",
    ...DARK_SCROLLBAR,
  },
};

/** The original Adrift light look. Values are the pre-theme hex, unchanged. */
export const ADRIFT_LIGHT: LightPreset = {
  id: "adrift-light",
  name: "Adrift Light",
  description: "Clean white with neutral greys.",
  mode: "light",
  scale: {
    "50": "#fafafa",
    "100": "#f4f4f5",
    "200": "#e4e4e7",
    "300": "#d4d4d8",
    "400": "#a1a1aa",
    // Caption text: >= 4.5:1 (WCAG AA) on white, light-50/100 and inputs.
    "500": "#63636b",
    "600": "#52525b",
    "700": "#3f3f46",
    bg: "#ffffff",
    input: "#f4f4f5",
    primary: "#09090b",
  },
  semantic: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f5f5f5",
    "--bg-tertiary": "#ebebeb",
    "--bg-hover": "#e0e0e0",
    "--bg-active": "#d5d5d5",
    "--border-primary": "#e0e0e0",
    "--border-secondary": "#d0d0d0",
    "--border-accent": "#c0c0c0",
    "--text-primary": "#0d0d0d",
    "--text-secondary": "#525252",
    "--text-tertiary": "#5f5f5f",
    "--text-muted": "#696969",
    "--focus-ring": "#3d3f45",
    ...LIGHT_SCROLLBAR,
  },
};

export const THEME_PRESETS: readonly ThemePreset[] = [
  ADRIFT_DARK,
  ADRIFT_LIGHT,
  {
    id: "oled",
    name: "OLED Black",
    description: "True black surfaces. Saves power on OLED screens.",
    mode: "dark",
    scale: {
      "200": "#3d3d3d",
      "300": "#545454",
      "400": "#8f8f8f",
      "500": "#a6a6a6",
      "600": "#d6d6d6",
      "700": "#e6e6e6",
      "750": "#262626",
      "800": "#171717",
      "850": "#0f0f0f",
      "900": "#0a0a0a",
      bg: "#000000",
      input: "#121212",
      primary: "#f5f5f5",
    },
    semantic: {
      "--bg-primary": "#000000",
      "--bg-secondary": "#171717",
      "--bg-tertiary": "#0f0f0f",
      "--bg-hover": "#262626",
      "--bg-active": "#262626",
      "--border-primary": "#262626",
      "--border-secondary": "#3d3d3d",
      "--border-accent": "#3d3d3d",
      "--text-primary": "#e6e6e6",
      "--text-secondary": "#a6a6a6",
      "--text-tertiary": "#8f8f8f",
      "--text-muted": "#878787",
      "--focus-ring": "#d6d6d6",
      ...DARK_SCROLLBAR,
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep blue-slate.",
    mode: "dark",
    scale: {
      "200": "#313e5e",
      "300": "#40527d",
      "400": "#8994a9",
      "500": "#a0a9ba",
      "600": "#d3d7df",
      "700": "#e4e7ec",
      "750": "#212a40",
      "800": "#171e2d",
      "850": "#131825",
      "900": "#101520",
      bg: "#0c1018",
      input: "#151b28",
      primary: "#f4f4f6",
    },
    semantic: {
      "--bg-primary": "#0c1018",
      "--bg-secondary": "#171e2d",
      "--bg-tertiary": "#131825",
      "--bg-hover": "#212a40",
      "--bg-active": "#212a40",
      "--border-primary": "#212a40",
      "--border-secondary": "#313e5e",
      "--border-accent": "#313e5e",
      "--text-primary": "#e4e7ec",
      "--text-secondary": "#a0a9ba",
      "--text-tertiary": "#8994a9",
      "--text-muted": "#808ca3",
      "--focus-ring": "#d3d7df",
      ...DARK_SCROLLBAR,
    },
  },
  {
    id: "frost",
    name: "Frost",
    description: "Cool grey-blue, lighter than the other dark themes.",
    mode: "dark",
    scale: {
      "200": "#4e596e",
      "300": "#5f6c86",
      "400": "#9ba9bf",
      "500": "#b1bccd",
      "600": "#d7dce5",
      "700": "#e6e9ef",
      "750": "#3d4657",
      "800": "#313745",
      "850": "#2a303c",
      "900": "#262b36",
      bg: "#222630",
      input: "#2c333f",
      primary: "#f4f5f6",
    },
    semantic: {
      "--bg-primary": "#222630",
      "--bg-secondary": "#313745",
      "--bg-tertiary": "#2a303c",
      "--bg-hover": "#3d4657",
      "--bg-active": "#3d4657",
      "--border-primary": "#3d4657",
      "--border-secondary": "#4e596e",
      "--border-accent": "#4e596e",
      "--text-primary": "#e6e9ef",
      "--text-secondary": "#b1bccd",
      "--text-tertiary": "#9ba9bf",
      "--text-muted": "#92a1b9",
      "--focus-ring": "#d7dce5",
      ...DARK_SCROLLBAR,
    },
  },
  {
    id: "dusk",
    name: "Warm Dusk",
    description: "Warm brown-greys.",
    mode: "dark",
    scale: {
      "200": "#4e433b",
      "300": "#69594f",
      "400": "#a19487",
      "500": "#b5aba1",
      "600": "#dbd6d1",
      "700": "#e9e6e2",
      "750": "#372f2a",
      "800": "#27211e",
      "850": "#201b18",
      "900": "#1c1815",
      bg: "#14110f",
      input: "#231e1a",
      primary: "#f4f2f1",
    },
    semantic: {
      "--bg-primary": "#14110f",
      "--bg-secondary": "#27211e",
      "--bg-tertiary": "#201b18",
      "--bg-hover": "#372f2a",
      "--bg-active": "#372f2a",
      "--border-primary": "#372f2a",
      "--border-secondary": "#4e433b",
      "--border-accent": "#4e433b",
      "--text-primary": "#e9e6e2",
      "--text-secondary": "#b5aba1",
      "--text-tertiary": "#a19487",
      "--text-muted": "#9a8c7e",
      "--focus-ring": "#dbd6d1",
      ...DARK_SCROLLBAR,
    },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Warm off-white.",
    mode: "light",
    scale: {
      "50": "#f6f4ee",
      "100": "#f1ede4",
      "200": "#e9e1d3",
      "300": "#ddd2bb",
      "400": "#bea97e",
      "500": "#72614f",
      "600": "#5a4d3f",
      "700": "#453b30",
      bg: "#faf8f5",
      input: "#f3efe7",
      primary: "#1b1713",
    },
    semantic: {
      "--bg-primary": "#faf8f5",
      "--bg-secondary": "#f6f4ee",
      "--bg-tertiary": "#f1ede4",
      "--bg-hover": "#e9e1d3",
      "--bg-active": "#ddd2bb",
      "--border-primary": "#e9e1d3",
      "--border-secondary": "#ddd2bb",
      "--border-accent": "#cfbfa0",
      "--text-primary": "#1b1713",
      "--text-secondary": "#5a4d3f",
      "--text-tertiary": "#6f5e4d",
      "--text-muted": "#72614f",
      "--focus-ring": "#453b30",
      "--scrollbar-thumb": "rgba(60, 40, 10, 0.16)",
      "--scrollbar-thumb-hover": "rgba(60, 40, 10, 0.3)",
    },
  },
  {
    id: "contrast",
    name: "High Contrast",
    description: "Black and white with bright borders. Text meets WCAG AAA.",
    mode: "dark",
    scale: {
      "200": "#737373",
      "300": "#8c8c8c",
      "400": "#b3b3b3",
      "500": "#c7c7c7",
      "600": "#e6e6e6",
      "700": "#f2f2f2",
      "750": "#4d4d4d",
      "800": "#121212",
      "850": "#0d0d0d",
      "900": "#080808",
      bg: "#000000",
      input: "#0f0f0f",
      primary: "#ffffff",
    },
    semantic: {
      "--bg-primary": "#000000",
      "--bg-secondary": "#121212",
      "--bg-tertiary": "#0d0d0d",
      "--bg-hover": "#4d4d4d",
      "--bg-active": "#4d4d4d",
      "--border-primary": "#4d4d4d",
      "--border-secondary": "#737373",
      "--border-accent": "#737373",
      "--text-primary": "#f2f2f2",
      "--text-secondary": "#c7c7c7",
      "--text-tertiary": "#b3b3b3",
      "--text-muted": "#ababab",
      "--focus-ring": "#ffffff",
      "--scrollbar-thumb": "rgba(255, 255, 255, 0.35)",
      "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.55)",
    },
  },
];

export const DEFAULT_DARK_PALETTE = ADRIFT_DARK.id;
export const DEFAULT_LIGHT_PALETTE = ADRIFT_LIGHT.id;

export function getPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

export function presetsForMode(mode: ThemeMode): ThemePreset[] {
  return THEME_PRESETS.filter((p) => p.mode === mode);
}

// Accent

export interface AccentSwatch {
  id: string;
  name: string;
  hex: string;
}

/**
 * Accent swatches. Each keeps >= 3:1 (WCAG non-text contrast) against white
 * (button labels are white) and against every preset background.
 */
export const ACCENTS: readonly AccentSwatch[] = [
  { id: "adrift", name: "Adrift", hex: "#f2330d" },
  { id: "amber", name: "Amber", hex: "#d0700a" },
  { id: "lime", name: "Lime", hex: "#5a9410" },
  { id: "teal", name: "Teal", hex: "#0d9488" },
  { id: "blue", name: "Blue", hex: "#3b82f6" },
  { id: "violet", name: "Violet", hex: "#8b5cf6" },
  { id: "pink", name: "Pink", hex: "#e0367f" },
];

export const DEFAULT_ACCENT = "adrift";

export function getAccent(id: string): AccentSwatch | undefined {
  return ACCENTS.find((a) => a.id === id);
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function rgbToHex(rgb: number[]): string {
  return `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** "#f2330d" -> "242 51 13" (the channel form Tailwind's <alpha-value> needs). */
export function hexToChannels(hex: string): string {
  return hexToRgb(hex).join(" ");
}

/**
 * Accent tokens from one swatch: secondary is 20% toward white (lighter text
 * and hover fills), hover is 20% toward black. For the Adrift red this
 * reproduces the original #f55c3d / #c2290a exactly.
 */
export function deriveAccent(hex: string): {
  primary: string;
  secondary: string;
  hover: string;
} {
  const rgb = hexToRgb(hex);
  return {
    primary: hex.toLowerCase(),
    secondary: rgbToHex(rgb.map((c) => c + (255 - c) * 0.2)),
    hover: rgbToHex(rgb.map((c) => c * 0.8)),
  };
}

// Persisted preference model

export interface ThemePrefs {
  /** Resolved mode in use (drives data-theme). */
  theme: ThemeMode;
  /** Follow prefers-color-scheme; `theme` then tracks the system. */
  followSystem: boolean;
  darkPalette: string;
  lightPalette: string;
  accent: string;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = {
  theme: "dark",
  followSystem: false,
  darkPalette: DEFAULT_DARK_PALETTE,
  lightPalette: DEFAULT_LIGHT_PALETTE,
  accent: DEFAULT_ACCENT,
};

/**
 * Clean persisted theme fields. Builds before presets only stored `theme`;
 * unknown or mismatched ids fall back to the Adrift defaults.
 */
export function sanitizeThemePrefs(raw: unknown): ThemePrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const modeOk = (id: unknown, mode: ThemeMode) =>
    typeof id === "string" && getPreset(id)?.mode === mode;
  return {
    theme: p.theme === "light" ? "light" : "dark",
    followSystem: p.followSystem === true,
    darkPalette: modeOk(p.darkPalette, "dark")
      ? (p.darkPalette as string)
      : DEFAULT_DARK_PALETTE,
    lightPalette: modeOk(p.lightPalette, "light")
      ? (p.lightPalette as string)
      : DEFAULT_LIGHT_PALETTE,
    accent:
      typeof p.accent === "string" && getAccent(p.accent)
        ? p.accent
        : DEFAULT_ACCENT,
  };
}

export function activePaletteId(
  prefs: Pick<ThemePrefs, "theme" | "darkPalette" | "lightPalette">,
): string {
  return prefs.theme === "light" ? prefs.lightPalette : prefs.darkPalette;
}

/** Browser chrome color (meta theme-color) for a palette: its page bg. */
export function themeColorFor(paletteId: string): string {
  const preset = getPreset(paletteId) ?? ADRIFT_DARK;
  return preset.semantic["--bg-primary"];
}

// CSS generation

function decls(entries: Array<[string, string]>): string {
  return entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
}

function scaleDecls(preset: ThemePreset): Array<[string, string]> {
  const keys: readonly string[] =
    preset.mode === "dark" ? DARK_SCALE_KEYS : LIGHT_SCALE_KEYS;
  const scale = preset.scale as Record<string, string>;
  return keys.map((k) => [scaleVar(preset.mode, k), hexToChannels(scale[k])]);
}

function semanticDecls(preset: ThemePreset): Array<[string, string]> {
  return SEMANTIC_KEYS.map((k) => [k, preset.semantic[k]]);
}

function accentDecls(hex: string): Array<[string, string]> {
  const a = deriveAccent(hex);
  return [
    ["--accent-primary", a.primary],
    ["--accent-secondary", a.secondary],
    ["--accent-hover", a.hover],
    [SPLASH_VAR, hexToChannels(a.primary)],
  ];
}

/**
 * The theme stylesheet. :root carries both default scales (light.* classes
 * work in dark mode and vice versa), the Adrift Dark semantic tokens and the
 * default accent; each other preset overrides only its own mode's scale and
 * the semantic tokens, scoped to its mode so a stale palette id can never
 * paint the wrong mode.
 */
export function buildThemeCss(): string {
  const defaultAccent = getAccent(DEFAULT_ACCENT)!;
  const blocks: string[] = [
    `:root {\n  color-scheme: dark;\n${decls([
      ...scaleDecls(ADRIFT_DARK),
      ...scaleDecls(ADRIFT_LIGHT),
      ...semanticDecls(ADRIFT_DARK),
      ...accentDecls(defaultAccent.hex),
    ])}\n}`,
    `[data-theme="light"] {\n  color-scheme: light;\n${decls(
      semanticDecls(ADRIFT_LIGHT),
    )}\n}`,
  ];
  for (const preset of THEME_PRESETS) {
    if (preset === ADRIFT_DARK || preset === ADRIFT_LIGHT) continue;
    blocks.push(
      `[data-theme="${preset.mode}"][data-palette="${preset.id}"] {\n${decls([
        ...scaleDecls(preset),
        ...semanticDecls(preset),
      ])}\n}`,
    );
  }
  for (const accent of ACCENTS) {
    if (accent.id === DEFAULT_ACCENT) continue;
    blocks.push(
      `[data-accent="${accent.id}"] {\n${decls(accentDecls(accent.hex))}\n}`,
    );
  }
  return blocks.join("\n");
}

// Applying

export interface ThemeAttrs {
  mode: ThemeMode;
  palette: string;
  accent: string;
  themeColor: string;
}

export function resolveThemeAttrs(
  prefs: ThemePrefs,
  systemPrefersLight = false,
): ThemeAttrs {
  const mode: ThemeMode = prefs.followSystem
    ? systemPrefersLight
      ? "light"
      : "dark"
    : prefs.theme;
  const palette = activePaletteId({ ...prefs, theme: mode });
  return {
    mode,
    palette,
    accent: prefs.accent,
    themeColor: themeColorFor(palette),
  };
}

/** Write the theme attributes and browser chrome color onto the document. */
export function applyThemeAttrs(attrs: ThemeAttrs, doc: Document = document) {
  const root = doc.documentElement;
  root.setAttribute("data-theme", attrs.mode);
  root.setAttribute("data-palette", attrs.palette);
  root.setAttribute("data-accent", attrs.accent);
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "theme-color";
    doc.head.appendChild(meta);
  }
  meta.content = attrs.themeColor;
}

/**
 * Inline <head> script: reads the persisted UI store (new key, then the
 * pre-rename key) and applies the theme before first paint, so a non-default
 * theme never flashes the dark default. Must stay dependency-free.
 */
export function buildThemeBootScript(storageKeys: readonly string[]): string {
  const presets = Object.fromEntries(
    THEME_PRESETS.map((p) => [p.id, [p.mode, p.semantic["--bg-primary"]]]),
  );
  const accents = ACCENTS.map((a) => a.id);
  return `(function(){try{var P=${JSON.stringify(presets)},A=${JSON.stringify(
    accents,
  )},K=${JSON.stringify(storageKeys)},s=null;for(var i=0;i<K.length&&!s;i++){try{var r=localStorage.getItem(K[i]);if(r){var j=JSON.parse(r);s=j&&j.state}}catch(e){}}s=s||{};var m=s.theme==="light"?"light":"dark";if(s.followSystem===true&&window.matchMedia){m=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}var p=m==="light"?s.lightPalette:s.darkPalette;if(!P[p]||P[p][0]!==m){p=m==="light"?${JSON.stringify(
    DEFAULT_LIGHT_PALETTE,
  )}:${JSON.stringify(DEFAULT_DARK_PALETTE)}}var a=A.indexOf(s.accent)>=0?s.accent:${JSON.stringify(
    DEFAULT_ACCENT,
  )};var d=document.documentElement;d.setAttribute("data-theme",m);d.setAttribute("data-palette",p);d.setAttribute("data-accent",a);var t=document.querySelector('meta[name="theme-color"]');if(t)t.setAttribute("content",P[p][1])}catch(e){}})();`;
}
