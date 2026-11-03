/**
 * LTX showcase on the Tools hub. The LTX VFX section lists every tool that
 * runs on LTX-2.5: the VFX LoRA tools homed there plus
 * cross-listed copies of the LTX tools that live elsewhere (Animate and
 * Transitions fold into Video engine groups, Video Expand, Restore video
 * and Motion presets sit under Video). A copy opens the real tool; it is a
 * grid entry only, never a second tool. Pure so the listing is unit-tested.
 */

import type { HubCard } from "./hub";
import { LTX_SHOT_RECIPES, ltxShotKey } from "./ltxShots";

/** Key prefix of a cross-listed copy ("ltx:action:ltx25_animate"). */
export const LTX_LISTING_PREFIX = "ltx:";

interface CrossListing {
  /** The real card's key (opened on click). */
  key: string;
  title: string;
  subtitle: string;
}

/** LTX tools homed outside the LTX VFX section, in section order. */
export const LTX_CROSS_LISTINGS: readonly CrossListing[] = [
  {
    key: "action:ltx25_animate",
    title: "Animate (LTX-2.5)",
    subtitle: "Image in, video out with synced audio: the core LTX-2.5 engine",
  },
  {
    key: "action:ltx25_transition",
    title: "Transitions (LTX-2.5)",
    subtitle: "Start and end frame in, a clip with synced audio between them",
  },
  {
    key: "action:video_expand",
    title: "Expand video (LTX-2.5)",
    subtitle:
      "Video in, wider video out: the IC-LoRA outpaint fills the border",
  },
  {
    key: "action:ltx_restore",
    title: "Restore video (LTX-2.5)",
    subtitle:
      "Deblur, decompress, colorize or refine a clip with the restoration IC-LoRAs",
  },
  {
    key: "action:wan_motion",
    title: "Motion presets (LTX-2.5)",
    subtitle: "Effect presets on a photo; pick the LTX-2.5 engine for sound",
  },
];

/** Every real card key the LTX VFX section shows (home + cross-listed). */
export const LTX_SECTION_KEYS: readonly string[] = [
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
  "action:ltx_exploded_view",
  "action:ltx_paint_fluid",
  ...LTX_CROSS_LISTINGS.map((l) => l.key),
  // Shot boards (ltxShots): chains of the tools above.
  ...LTX_SHOT_RECIPES.map((r) => ltxShotKey(r.id)),
];

/**
 * Grid cards plus an LTX VFX copy of each cross-listed tool. `all` is the
 * unfolded card list (engine members folded off the grid still have a
 * card there). Missing tools are skipped.
 */
export function withLtxListings(grid: HubCard[], all: HubCard[]): HubCard[] {
  const byKey = new Map(all.map((c) => [c.key, c]));
  const copies: HubCard[] = [];
  for (const l of LTX_CROSS_LISTINGS) {
    const src = byKey.get(l.key);
    if (!src) continue;
    copies.push({
      ...src,
      key: `${LTX_LISTING_PREFIX}${src.key}`,
      title: l.title,
      subtitle: l.subtitle,
      hubCategory: "VFX",
      engineGroup: undefined,
      openKey: src.key,
      aliases: [
        ...new Set([...src.aliases, src.title, "ltx", "ltx-2.5", "ltx vfx"]),
      ],
    });
  }
  return [...grid, ...copies];
}

/** Card key the cover preview is looked up by (a copy uses its tool's). */
export function previewKey(card: Pick<HubCard, "key" | "openKey">): string {
  return card.key.startsWith(LTX_LISTING_PREFIX) && card.openKey
    ? card.openKey
    : card.key;
}

/** True when the card runs on LTX-2.5 (gets the "LTX" cover chip). */
export function isLtxCard(
  card: Pick<HubCard, "hubCategory" | "model">,
): boolean {
  return card.hubCategory === "VFX" || /^LTX-2\.5\b/.test(card.model ?? "");
}
