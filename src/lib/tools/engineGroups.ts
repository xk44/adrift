/**
 * Engine groups: one job offered on several engines (Edit on Krea 2,
 * FLUX.3, Qwen 2.1 and FIBO) shows as ONE card on the Tools grid; the runner
 * switches engines (EngineVariantSwitch).
 *
 * Every member stays a real card under its own key, so old `?tool=` links,
 * saved boards/pipelines, lightbox hand-offs and Ask-Claude refs keep opening
 * that engine. The grid card keeps the primary member's key (thumbnail,
 * featured slot, test ids) and opens the best ready engine.
 *
 * Pure (no React) so the rules are unit-tested.
 */

import type { HubCard } from "./hub";
import { badgeRank, type LicenseBadge } from "./licenseBadges";
import { weightsClass, weightsSources, weightsTooltip } from "./openWeights";

export interface EngineVariant {
  /** Hub card key ("catalog:<id>" / "action:<id>"). */
  key: string;
  /** Picker label ("Krea 2", "Qwen 2.1"). */
  label: string;
}

export interface EngineGroup {
  id: string;
  /** Title of the merged card and the runner. */
  title: string;
  /** Member whose key the grid card keeps (its preview, featured slot). */
  primary: string;
  /** Members in preference order: the default is the first ready one. */
  variants: readonly EngineVariant[];
}

export const ENGINE_GROUPS: readonly EngineGroup[] = [
  {
    id: "edit",
    title: "Edit",
    primary: "catalog:krea2-general-edit",
    variants: [
      { key: "catalog:krea2-general-edit", label: "Krea 2" },
      { key: "action:edit_flux3", label: "FLUX.3 Klein" },
      { key: "action:edit_qwen21", label: "Qwen-Image 2.1" },
      { key: "action:edit_fibo", label: "FIBO 2.0" },
    ],
  },
  {
    id: "angles",
    title: "Angles",
    primary: "catalog:qwen21-camera",
    variants: [
      { key: "catalog:qwen2511-camera", label: "Qwen Edit 2511" },
      { key: "catalog:flux3-camera", label: "FLUX.3 Klein" },
      { key: "catalog:qwen21-camera", label: "Qwen-Image 2.1" },
    ],
  },
  {
    id: "object_remover",
    title: "Object Remover",
    primary: "action:remove_object",
    variants: [
      { key: "action:remove_object", label: "Krea 2" },
      { key: "catalog:qwen2511-remove", label: "Qwen Edit 2511 (name it)" },
      { key: "catalog:qwen21-remove-box", label: "Qwen-Image 2.1 (paint it)" },
    ],
  },
  {
    id: "face_swap",
    title: "Face Swap",
    primary: "catalog:qwen21-head-swap",
    variants: [
      { key: "catalog:krea2-head-swap", label: "Krea 2" },
      { key: "catalog:qwen21-head-swap", label: "Qwen-Image 2.1" },
    ],
  },
  {
    id: "body_swap",
    title: "Body Swap",
    primary: "catalog:qwen21-body-swap",
    variants: [
      { key: "catalog:qwen21-body-swap", label: "Qwen-Image 2.1" },
      { key: "catalog:krea2-body-swap", label: "Krea 2 (experimental)" },
    ],
  },
  {
    id: "background_remover",
    title: "Background Remover",
    primary: "action:bg_remove",
    variants: [
      { key: "action:bg_remove", label: "Cut-out model" },
      { key: "catalog:qwen21-remove-bg", label: "Qwen-Image 2.1 (RGBA)" },
    ],
  },
  {
    id: "restyle_depth",
    title: "Restyle from Depth",
    primary: "catalog:moss-restyle-depth",
    variants: [
      { key: "catalog:moss-restyle-depth", label: "MOSS-Image" },
      { key: "catalog:krea2-restyle-depth", label: "Krea 2" },
    ],
  },
  {
    id: "restore",
    title: "Restore",
    primary: "catalog:qwen21-restore",
    variants: [
      { key: "catalog:flux3-restore", label: "FLUX.3 Klein" },
      { key: "catalog:qwen21-restore", label: "Qwen-Image 2.1" },
    ],
  },
  {
    id: "image_to_video",
    title: "Image to Video",
    primary: "action:animate",
    variants: [
      { key: "action:ltx25_animate", label: "LTX-2.5" },
      { key: "action:animate", label: "LTX-Video" },
    ],
  },
  {
    id: "character_sheet",
    title: "Character Sheet",
    primary: "catalog:qwen21-character-sheet",
    variants: [
      { key: "catalog:qwen21-character-sheet", label: "Qwen-Image 2.1" },
      { key: "action:h3_charsheet", label: "MiniMax H3 (pick views)" },
    ],
  },
  {
    id: "transitions",
    title: "Transitions",
    primary: "action:transition",
    variants: [
      { key: "action:transition", label: "MiniMax H3" },
      { key: "action:ltx25_transition", label: "LTX-2.5" },
    ],
  },
];

const BY_KEY: ReadonlyMap<string, EngineGroup> = new Map(
  ENGINE_GROUPS.flatMap((g) => g.variants.map((v) => [v.key, g] as const)),
);

/** The engine group a card key belongs to, or null. */
export function engineGroupOf(cardKey: string): EngineGroup | null {
  return BY_KEY.get(cardKey) ?? null;
}

/** False for engine members folded into their group's primary card. */
export function isEngineGridCard(cardKey: string): boolean {
  const g = BY_KEY.get(cardKey);
  return !g || g.primary === cardKey;
}

/**
 * Most permissive first (licenseBadges BEST_ORDER): 0 Open, 1 Revenue cap,
 * 2 Non-commercial, 3 Region-limited, 4 Check license.
 */
export function licenseRank(card: HubCard): number {
  return badgeRank(weightsClass(card));
}

type Member = { variant: EngineVariant; card: HubCard };

function members(group: EngineGroup, byKey: Map<string, HubCard>): Member[] {
  return group.variants
    .map((variant) => ({ variant, card: byKey.get(variant.key) }))
    .filter((m): m is Member => !!m.card);
}

/**
 * The engine a group opens on: the first ready member in preference order,
 * else the first still checking, else the primary (its setup hint shows in
 * the picker).
 */
export function defaultEngineKey(group: EngineGroup, cards: HubCard[]): string {
  const ms = members(group, new Map(cards.map((c) => [c.key, c])));
  return (
    ms.find((m) => m.card.available && !m.card.unverified)?.card.key ??
    ms.find((m) => m.card.available)?.card.key ??
    ms.find((m) => m.card.checking)?.card.key ??
    group.primary
  );
}

/**
 * Grid cards: engine-group members fold into one card per group. The card
 * keeps the primary's key; title is the group's, it is available when any
 * engine is, its model line is the default engine's, its license badge is
 * the most permissive engine's, and search matches every engine's names.
 * Cards outside groups pass through untouched.
 */
export function foldEngineGroups(cards: HubCard[]): HubCard[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const out: HubCard[] = [];
  for (const card of cards) {
    const group = engineGroupOf(card.key);
    if (!group) {
      out.push(card);
      continue;
    }
    if (group.primary !== card.key) continue;
    const ms = members(group, byKey);
    const openKey = defaultEngineKey(group, cards);
    const open = byKey.get(openKey) ?? card;
    const anyReady = ms.some((m) => m.card.available);
    const best = [...ms].sort(
      (a, b) => licenseRank(a.card) - licenseRank(b.card),
    )[0].card;
    out.push({
      ...card,
      title: group.title,
      available: anyReady,
      checking: !anyReady && ms.some((m) => m.card.checking),
      unavailableReason: anyReady ? null : open.unavailableReason,
      unverified: anyReady ? open.unverified : card.unverified,
      model: open.model,
      nc: best.nc,
      licenseNote: best.licenseNote,
      weights: weightsClass(best),
      weightSources: weightsSources(best),
      aliases: [
        ...new Set(
          ms.flatMap((m) => [
            ...m.card.aliases,
            m.card.title,
            m.variant.label,
            m.card.model ?? "",
          ]),
        ),
      ].filter(Boolean),
      engineGroup: group.id,
      openKey,
    });
  }
  return out;
}

/** Per-engine picker row: label, readiness and license for one member. */
export interface EngineOption {
  key: string;
  label: string;
  available: boolean;
  checking: boolean;
  /** Setup reason when the engine cannot run. */
  reason: string | null;
  model: string | null;
  nc: boolean;
  licenseNote: string | null;
  /** License badge of this engine and its tooltip (terms + links). */
  badge: LicenseBadge;
  badgeTitle: string;
}

export function engineOptions(
  group: EngineGroup,
  cards: HubCard[],
): EngineOption[] {
  return members(group, new Map(cards.map((c) => [c.key, c]))).map(
    ({ variant, card }) => ({
      key: card.key,
      label: variant.label,
      available: card.available,
      checking: card.checking,
      reason: card.available ? null : card.unavailableReason,
      model: card.model,
      nc: card.nc,
      licenseNote: card.licenseNote,
      badge: weightsClass(card),
      badgeTitle: weightsTooltip(card),
    }),
  );
}
