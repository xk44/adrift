/**
 * Tool registry rules that sit on top of ACTION_TOOLS (toolsPage.ts):
 *
 * - Card-key aliases: retired cards resolve to their replacement, so old
 *   `?tool=` links and bookmarks still open something useful
 *   (the legacy single-pass 3D card opens the Trellis 3D card).
 * - Media variants: one capability with a photo and a video runner shows as
 *   ONE card on the Tools grid (SeedVR2 upscale); the runner switches between
 *   the variants. The non-primary variant stays a real card so lightbox
 *   hand-offs for clips still reach it.
 *
 * - Engine groups (engineGroups.ts): one job on several engines is one grid
 *   card with an engine picker; every member stays openable by key.
 *
 * Pure (no React) so the rules are unit-tested.
 */

import { isEngineGridCard } from "./engineGroups";

/** Retired card key -> the card that replaces it. */
export const CARD_KEY_ALIASES: Readonly<Record<string, string>> = {
  "action:make_3d": "action:make_3d_trellis",
  // Reframe video (VACE) folded into Expand video's "Change aspect" modes.
  "action:vace_reframe": "action:video_expand",
};

/** Resolve a card key through CARD_KEY_ALIASES (unknown keys pass through). */
export function resolveCardKey(key: string): string {
  return CARD_KEY_ALIASES[key] ?? key;
}

export interface MediaVariant {
  /** Action tool id. */
  id: string;
  /** Switch label ("Photo" / "Video"). */
  label: string;
}

/**
 * Capabilities with one runner per input kind. The first variant is the card
 * shown on the grid; the others are reached through its switch.
 */
export const MEDIA_VARIANT_GROUPS: ReadonlyArray<readonly MediaVariant[]> = [
  [
    { id: "upscale_seedvr2", label: "Photo" },
    { id: "upscale_video", label: "Video" },
  ],
  [
    { id: "body_3d", label: "Photo" },
    { id: "body_3d_video", label: "Video" },
  ],
  [
    { id: "refocus", label: "Photo" },
    { id: "rack_focus", label: "Video" },
  ],
];

/** The variant group an action id belongs to, or null. */
export function mediaVariants(
  actionId: string,
): readonly MediaVariant[] | null {
  return (
    MEDIA_VARIANT_GROUPS.find((g) => g.some((v) => v.id === actionId)) ?? null
  );
}

/**
 * False for cards folded into another card on the Tools grid (a secondary
 * media variant or a non-primary engine). They stay openable by key
 * (lightbox hand-off, deep link, saved boards).
 */
export function isGridCard(cardKey: string): boolean {
  if (!isEngineGridCard(cardKey)) return false;
  if (!cardKey.startsWith("action:")) return true;
  const id = cardKey.slice("action:".length);
  const group = mediaVariants(id);
  return !group || group[0].id === id;
}
