/**
 * Visual helpers for the Tools hub: procedural card covers (no image
 * assets — a deterministic gradient per card from a curated palette),
 * featured strip, "new" flags and per-section counts. Pure so the hub
 * page stays a thin renderer and these rules are unit-tested.
 */

import type { HubCard, HubCategory } from "./hub";
import { HUB_CATEGORIES, STORYBOARD_KEY } from "./hub";
import { LTX_LISTING_PREFIX } from "./ltxShowcase";
import { MOTION_DESIGNER_KEY } from "./motionCard";
import {
  CLICK_TO_AD_KEY,
  CLIPCUT_KEY,
  SHORTS_STUDIO_KEY,
  URBAN_CUTS_KEY,
} from "./pipelineCards";
import { PRODUCT_STUDIO_KEY } from "./productStudio";
import { resolveCardKey } from "./toolRegistry";

/** Base hue per hub section, spread around the wheel so sections read apart. */
export const CATEGORY_HUE: Record<HubCategory, number> = {
  Image: 14,
  Edit: 268,
  Identity: 328,
  Video: 205,
  VFX: 96,
  Enhance: 158,
  Ads: 38,
  Portraits: 298,
  Characters: 126,
  Styles: 182,
  Scenes: 66,
  Audio: 240,
};

/**
 * Hero cards at the top of the hub: two LTX VFX tools lead (LTX-2.5 is the
 * core video engine; first so they stay in view on the phone scroll strip
 * too), then the FLUX 3 Product Studio, Click to Ad and the H3 flagship.
 * Five fills one desktop row; Shorts Studio and Storyboard stay in their
 * own sections only.
 */
export const FEATURED_KEYS: readonly string[] = [
  "action:ltx_day_to_night",
  "action:ltx_cinemagraph",
  // FLUX 3 flagship: hero shots of one product in four looks.
  PRODUCT_STUDIO_KEY,
  CLICK_TO_AD_KEY,
  // MiniMax H3 flagship: a new shot with sound from cast photos.
  "action:ref_video",
];

/** Recently added cards that get a "New" badge. */
export const NEW_KEYS: ReadonlySet<string> = new Set([
  PRODUCT_STUDIO_KEY,
  SHORTS_STUDIO_KEY,
  CLICK_TO_AD_KEY,
  STORYBOARD_KEY,
  MOTION_DESIGNER_KEY,
  CLIPCUT_KEY,
  URBAN_CUTS_KEY,
  "action:ref_video",
  "action:multiframe_ref",
  "action:h3_charsheet",
  "action:image_to_splat",
  "action:body_3d",
  "action:body_3d_video",
  "action:ltx_alpha_matte",
  "action:ltx_clean_plate",
  "action:ltx_day_to_night",
  "action:ltx_add_water",
  "action:ltx_cinemagraph",
  "action:ltx_slow_motion",
  "action:ltx_ripple",
  "action:ltx_edge_control",
  "action:ltx_blockout_render",
  "action:ltx_sdr_to_hdr",
  "action:ltx_layout_render",
  "action:ltx_ingredients",
  "action:ltx_reshoot",
  "action:ltx_restore",
  "action:ltx_exploded_view",
  "action:ltx_paint_fluid",
]);

export function isNewCard(card: Pick<HubCard, "key">): boolean {
  return NEW_KEYS.has(card.key);
}

/** FNV-1a, 32-bit: small, stable across runtimes. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface CoverSpec {
  /** Primary hue (deg), section base + small per-card jitter. */
  hue: number;
  /** Secondary hue for the far corner. */
  hue2: number;
  /** Highlight position, percent. */
  x: number;
  y: number;
  /** Gradient angle, deg. */
  angle: number;
  /** Texture laid over the gradient. */
  pattern: CoverPattern;
}

export const COVER_PATTERNS = ["grid", "dots", "lines", "rings"] as const;
export type CoverPattern = (typeof COVER_PATTERNS)[number];

/**
 * Cover hues, picked per card (not per section) so a section reads varied
 * instead of one wash. Curated: no muddy yellow-greens.
 */
export const COVER_HUES: readonly number[] = [
  6, 22, 152, 168, 186, 200, 214, 230, 248, 266, 288, 318, 342,
];

/** Palette slot a card's hash lands on. */
export function hueSlot(key: string): number {
  return hashKey(`hue:${key}`) % COVER_HUES.length;
}

/**
 * Palette slots for one section in display order: the card's own slot,
 * nudged when it repeats one of the previous few cards, so neighbours on a
 * row (and usually the row above) never share a wash.
 */
export function spreadHueSlots(
  keys: readonly string[],
  window = 4,
): Map<string, number> {
  const out = new Map<string, number>();
  const recent: number[] = [];
  for (const key of keys) {
    let slot = hueSlot(key);
    for (let i = 0; i < COVER_HUES.length && recent.includes(slot); i++)
      slot = (slot + 5) % COVER_HUES.length;
    out.set(key, slot);
    recent.push(slot);
    if (recent.length > window) recent.shift();
  }
  return out;
}

export function coverSpec(
  card: Pick<HubCard, "key" | "hubCategory">,
  slot?: number,
): CoverSpec {
  const h = hashKey(card.key);
  // Mix the bits again so the palette pick is independent of the layout bits.
  const pick = hashKey(`hue:${card.key}`);
  const base =
    COVER_HUES[
      slot !== undefined && slot >= 0
        ? slot % COVER_HUES.length
        : pick % COVER_HUES.length
    ];
  const jitter = (h % 13) - 6; // -6..6 keeps the palette recognisable
  const hue = (base + jitter + 360) % 360;
  // Neighbouring hue (either side) keeps one cover coherent;
  // a wide jump reads muddy (orange into green).
  const swing = 14 + ((h >>> 8) % 22);
  const hue2 = (hue + ((h >>> 24) & 1 ? swing : -swing) + 360) % 360;
  return {
    hue,
    hue2,
    x: 18 + ((h >>> 12) % 64),
    y: 14 + ((h >>> 18) % 50),
    angle: 120 + ((h >>> 4) % 100),
    pattern: COVER_PATTERNS[(pick >>> 16) % COVER_PATTERNS.length],
  };
}

/** CSS background for a cover; tuned to sit on both light and dark surfaces. */
export function coverBackground(spec: CoverSpec): string {
  const { hue, hue2, x, y, angle } = spec;
  return [
    `radial-gradient(120% 90% at ${x}% ${y}%, hsl(${hue} 85% 62% / 0.55), transparent 60%)`,
    `radial-gradient(90% 80% at ${100 - x}% ${100 - y / 2}%, hsl(${hue2} 80% 55% / 0.35), transparent 65%)`,
    `linear-gradient(${angle}deg, hsl(${hue} 45% 14%), hsl(${hue2} 40% 9%))`,
  ].join(", ");
}

/** CSS for the texture layer (white strokes; caller sets opacity + mask). */
export function patternStyle(pattern: CoverPattern): {
  backgroundImage: string;
  backgroundSize: string;
} {
  const c = "rgba(255,255,255,0.4)";
  switch (pattern) {
    case "dots":
      return {
        backgroundImage: `radial-gradient(${c} 1px, transparent 1.5px)`,
        backgroundSize: "14px 14px",
      };
    case "lines":
      return {
        backgroundImage: `repeating-linear-gradient(135deg, ${c} 0 1px, transparent 1px 12px)`,
        backgroundSize: "auto",
      };
    case "rings":
      return {
        backgroundImage: `repeating-radial-gradient(circle at 50% 50%, transparent 0 18px, ${c} 18px 19px)`,
        backgroundSize: "auto",
      };
    default:
      return {
        backgroundImage: `linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`,
        backgroundSize: "22px 22px",
      };
  }
}

/**
 * Featured grid shape for `n` cards. The wide layout is four columns: the
 * bento (lead 2x2 beside four) only fills it at five, a 2-wide lead beside
 * two at three. Four cards sit one per column (a lead there pushed the last
 * card onto a lonely second row, e.g. with "Commercial use OK" on).
 */
export function featuredLayout(n: number): { lead: boolean; bento: boolean } {
  if (n >= 5) return { lead: true, bento: true };
  return { lead: n === 3, bento: false };
}

/** Featured cards in FEATURED_KEYS order (missing keys skipped). */
export function featuredCards(cards: HubCard[]): HubCard[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  return FEATURED_KEYS.map((k) => byKey.get(k)).filter(
    (c): c is HubCard => !!c,
  );
}

/** Per-section card counts (for filter chips); `all` = total. */
export function countByCategory(
  cards: HubCard[],
): Record<HubCategory | "all", number> {
  // LTX cross-listed copies open a tool already counted in its home section.
  const all = cards.filter((c) => !c.key.startsWith(LTX_LISTING_PREFIX));
  const out = { all: all.length } as Record<HubCategory | "all", number>;
  for (const cat of HUB_CATEGORIES) out[cat] = 0;
  for (const c of cards) out[c.hubCategory] = (out[c.hubCategory] ?? 0) + 1;
  return out;
}

/** Ready-to-run count (header stat): models checked, not just "no error". */
export function readyCount(cards: HubCard[]): number {
  return cards.filter(
    (c) => c.available && !c.unverified && c.kind !== "placeholder",
  ).length;
}

/** `?tool=` deep-link param read; null when absent/unknown. */
export function toolFromSearch(
  search: string,
  keys: Iterable<string>,
): string | null {
  const raw = new URLSearchParams(search).get("tool");
  if (!raw) return null;
  // Retired cards (old links) open their replacement.
  const v = resolveCardKey(raw);
  for (const k of keys) if (k === v) return k;
  return null;
}

/** Search string with `tool` set (or removed when key is null). */
export function searchWithTool(search: string, key: string | null): string {
  const p = new URLSearchParams(search);
  if (key) p.set("tool", key);
  else p.delete("tool");
  const s = p.toString();
  return s ? `?${s}` : "";
}
