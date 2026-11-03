/**
 * Lightbox creator actions: a short quick row of pinned actions (at most
 * QUICK_ROW_MAX) over a handful of labelled groups (Vary, Edit, Upscale &
 * enhance, Animate, 3D & layers, Use & recipe) whose submenus hold the rest.
 * Each submenu can show/hide its actions and pin them to the quick row;
 * hidden actions stay reachable from the Tools panel.
 *
 * Pure (no React) so layout, prefs normalization and the Tools fallback are
 * unit-tested.
 */

import type {
  InlineRun,
  InlineVariant,
  LightboxMediaKind,
  LightboxTool,
} from "@/lib/ui/lightboxTools";
import {
  UPSCALE_MODE_HINTS,
  UPSCALE_REDETAIL_ACTION,
  VIDEO_UPSCALE_ACTION,
} from "@/lib/upscale/upscaleModels";
import { toolTitle } from "@/lib/tools/toolNames";

export type CreatorGroupId =
  "vary" | "edit" | "upscale" | "animate" | "layers" | "use";

export type CreatorActionId =
  | "vary_subtle"
  | "vary_strong"
  | "rerun"
  | "rerun_tweak"
  | "quick_edit"
  | "open_editor"
  | "video_editor"
  | "retake"
  | "upscale_faithful"
  | "upscale_creative"
  | "upscale_redetail"
  | "upscale_clip"
  | "fix_faces"
  | "detail"
  | "animate_low"
  | "animate_high"
  | "loop_low"
  | "loop_high"
  | "make_3d"
  | "layer_split"
  | "use_image"
  | "use_style"
  | "use_prompt"
  | "reproduce";

/** What a click does: a Lightbox inline run, or a Tools-page card. */
export type CreatorActionRun =
  InlineRun | { kind: "open_tool"; toolKey: string };

export interface CreatorActionSpec {
  id: CreatorActionId;
  group: CreatorGroupId;
  /** Label inside its group's submenu ("Subtle" under Vary). */
  label: string;
  /** Standalone name: accessible name, Customize, Tools fallback. */
  name: string;
  /** Quick-row button text (short). */
  quick: string;
  /** One line: tooltip and submenu hint. */
  hint: string;
  /** lucide icon name (creatorActionIcons + the Tools panel resolve it). */
  icon: string;
  media: LightboxMediaKind[];
  /** Needs a local run (generation actions); hidden for external images. */
  localOnly: boolean;
  /** Disabled without a still image / Quick edit; Retake drops out when the clip can't open in the editor. */
  needs?: "imageUrl" | "quickEdit" | "retake";
  kbd?: string;
  run: CreatorActionRun;
}

export interface CreatorGroupSpec {
  id: CreatorGroupId;
  label: string;
  icon: string;
}

export const CREATOR_GROUPS: readonly CreatorGroupSpec[] = [
  { id: "vary", label: "Vary", icon: "Wand2" },
  { id: "edit", label: "Edit", icon: "Brush" },
  { id: "upscale", label: "Upscale & enhance", icon: "ZoomIn" },
  { id: "animate", label: "Animate", icon: "Play" },
  { id: "layers", label: "3D & layers", icon: "Layers" },
  { id: "use", label: "Use & recipe", icon: "Image" },
];

export const CREATOR_GROUP_IDS: readonly CreatorGroupId[] = CREATOR_GROUPS.map(
  (g) => g.id,
);

/** Quick row cap: anything past it lives in the group submenus. */
export const QUICK_ROW_MAX = 4;

const IMG: LightboxMediaKind[] = ["image"];
const VID: LightboxMediaKind[] = ["video"];
const ALL: LightboxMediaKind[] = ["image", "video", "audio", "mesh"];
const action = (a: string, params?: Record<string, unknown>): InlineRun =>
  params
    ? { kind: "action", action: a, params }
    : { kind: "action", action: a };

export const CREATOR_ACTIONS: readonly CreatorActionSpec[] = [
  // Vary
  {
    id: "vary_subtle",
    group: "vary",
    label: "Subtle",
    name: "Vary subtle",
    quick: "Vary",
    hint: "Close to this image",
    icon: "Wand2",
    media: IMG,
    localOnly: true,
    run: action("vary_subtle"),
  },
  {
    id: "vary_strong",
    group: "vary",
    label: "Strong",
    name: "Vary strong",
    quick: "Vary strong",
    hint: "A looser take on this image",
    icon: "Wand2",
    media: IMG,
    localOnly: true,
    run: action("vary_strong"),
  },
  {
    id: "rerun",
    group: "vary",
    label: "Rerun",
    name: "Rerun",
    quick: "Rerun",
    hint: "Same prompt, new seed",
    icon: "RefreshCw",
    media: ALL,
    localOnly: true,
    run: { kind: "rerun" },
  },
  {
    id: "rerun_tweak",
    group: "vary",
    label: "Rerun with tweaks…",
    name: "Rerun with parameters",
    quick: "Tweak",
    hint: "Change stylize, chaos, aspect or seed, then rerun",
    icon: "SlidersHorizontal",
    media: ALL,
    localOnly: true,
    run: { kind: "rerun_tweak" },
  },
  // Edit
  {
    id: "quick_edit",
    group: "edit",
    label: "Quick edit",
    name: "Quick edit",
    quick: "Quick edit",
    hint: "Paint, expand or upscale right here",
    icon: "Brush",
    media: IMG,
    localOnly: true,
    needs: "quickEdit",
    kbd: "E",
    run: { kind: "quick_edit" },
  },
  {
    id: "open_editor",
    group: "edit",
    label: "Open editor",
    name: "Open in the image editor",
    quick: "Editor",
    hint: "Layers, masks and the full tool set",
    icon: "PenTool",
    media: IMG,
    localOnly: true,
    run: { kind: "edit" },
  },
  {
    id: "video_editor",
    group: "edit",
    label: "Open editor",
    name: "Open in the video editor",
    quick: "Editor",
    hint: "Trim, tools and export",
    icon: "PenTool",
    media: VID,
    localOnly: true,
    run: { kind: "edit" },
  },
  {
    id: "retake",
    group: "edit",
    label: "Retake",
    name: "Retake part of the video",
    quick: "Retake",
    hint: "Regenerate a marked range, keep the rest",
    icon: "Clapperboard",
    media: VID,
    localOnly: true,
    needs: "retake",
    run: { kind: "retake" },
  },
  // Upscale & enhance
  {
    id: "upscale_faithful",
    group: "upscale",
    label: "Faithful",
    name: "Upscale faithful",
    quick: "Upscale",
    hint: UPSCALE_MODE_HINTS.upscale_subtle,
    icon: "ZoomIn",
    media: IMG,
    localOnly: true,
    run: action("upscale_subtle"),
  },
  {
    id: "upscale_creative",
    group: "upscale",
    label: "Creative",
    name: "Upscale creative",
    quick: "Creative",
    hint: UPSCALE_MODE_HINTS.upscale_creative,
    icon: "ZoomIn",
    media: IMG,
    localOnly: true,
    run: action("upscale_creative"),
  },
  {
    id: "upscale_redetail",
    group: "upscale",
    label: "Re-detail",
    name: "Upscale re-detail",
    quick: "Re-detail",
    hint: UPSCALE_MODE_HINTS[UPSCALE_REDETAIL_ACTION],
    icon: "ZoomIn",
    media: IMG,
    localOnly: true,
    run: action(UPSCALE_REDETAIL_ACTION),
  },
  {
    id: "upscale_clip",
    group: "upscale",
    label: "Upscale clip",
    name: "Upscale video",
    quick: "Upscale",
    hint: `${UPSCALE_MODE_HINTS[VIDEO_UPSCALE_ACTION]} 2x with your video upscaler (Settings → Upscaler).`,
    icon: "ZoomIn",
    media: VID,
    localOnly: true,
    run: action(VIDEO_UPSCALE_ACTION),
  },
  {
    id: "fix_faces",
    group: "upscale",
    label: "Fix faces",
    name: "Fix faces (ADetailer)",
    quick: "Fix faces",
    hint: "Find faces and hands and repaint them cleanly",
    icon: "ScanFace",
    media: IMG,
    localOnly: true,
    run: action("adetailer"),
  },
  {
    id: "detail",
    group: "upscale",
    label: "Add detail",
    name: "Add detail",
    quick: "Detail",
    hint: "Second pass that sharpens texture and small detail",
    icon: "Sparkles",
    media: IMG,
    localOnly: true,
    run: action("detail"),
  },
  // Animate
  {
    id: "animate_low",
    group: "animate",
    label: "Low motion",
    name: "Animate low motion",
    quick: "Animate",
    hint: `${toolTitle("action:animate")}: gentle movement`,
    icon: "Play",
    media: IMG,
    localOnly: true,
    run: action("animate_low"),
  },
  {
    id: "animate_high",
    group: "animate",
    label: "High motion",
    name: "Animate high motion",
    quick: "Animate high",
    hint: `${toolTitle("action:animate")}: bigger movement`,
    icon: "Play",
    media: IMG,
    localOnly: true,
    run: action("animate_high"),
  },
  {
    id: "loop_low",
    group: "animate",
    label: "Loop, low motion",
    name: "Loop low motion",
    quick: "Loop",
    hint: "Seamless loop with gentle movement",
    icon: "Film",
    media: IMG,
    localOnly: true,
    run: action("animate_low", { loop: 0 }),
  },
  {
    id: "loop_high",
    group: "animate",
    label: "Loop, high motion",
    name: "Loop high motion",
    quick: "Loop high",
    hint: "Seamless loop with bigger movement",
    icon: "Film",
    media: IMG,
    localOnly: true,
    run: action("animate_high", { loop: 0 }),
  },
  // 3D & layers (open their Tools cards with this image)
  {
    id: "make_3d",
    group: "layers",
    label: toolTitle("action:make_3d_trellis"),
    name: `Open ${toolTitle("action:make_3d_trellis")} with this image`,
    quick: "3D",
    hint: "Turn this image into a mesh (opens in Tools)",
    icon: "Box",
    media: IMG,
    localOnly: false,
    run: { kind: "open_tool", toolKey: "action:make_3d_trellis" },
  },
  {
    id: "layer_split",
    group: "layers",
    label: toolTitle("action:see_through"),
    name: `Open ${toolTitle("action:see_through")} with this image`,
    quick: "Layers",
    hint: "Depth-ordered parts with hidden areas filled in (opens in Tools)",
    icon: "Layers",
    media: IMG,
    localOnly: false,
    run: { kind: "open_tool", toolKey: "action:see_through" },
  },
  // Use & recipe
  {
    id: "use_image",
    group: "use",
    label: "As image prompt",
    name: "Use as image prompt",
    quick: "Use image",
    hint: "Attach this image to the prompt bar",
    icon: "Image",
    media: IMG,
    localOnly: false,
    needs: "imageUrl",
    run: { kind: "use", mode: "image_prompt" },
  },
  {
    id: "use_style",
    group: "use",
    label: "As style reference",
    name: "Use as style reference",
    quick: "Style ref",
    hint: "Borrow this image's look for new prompts",
    icon: "Palette",
    media: IMG,
    localOnly: false,
    needs: "imageUrl",
    run: { kind: "use", mode: "style_ref" },
  },
  {
    id: "use_prompt",
    group: "use",
    label: "Prompt",
    name: "Use this prompt",
    quick: "Prompt",
    hint: "Put this prompt back in the prompt bar",
    icon: "FileText",
    media: ALL,
    localOnly: false,
    run: { kind: "use_prompt" },
  },
  {
    id: "reproduce",
    group: "use",
    label: "Reproduce",
    name: "Reproduce this recipe",
    quick: "Reproduce",
    hint: "Reopen the tool or Create with this recipe (not run)",
    icon: "ScrollText",
    media: ALL,
    localOnly: true,
    run: { kind: "reproduce" },
  },
];

export const CREATOR_ACTION_IDS: readonly CreatorActionId[] =
  CREATOR_ACTIONS.map((a) => a.id);

export function specOf(id: CreatorActionId): CreatorActionSpec {
  return CREATOR_ACTIONS.find((a) => a.id === id)!;
}

export function groupSpec(id: CreatorGroupId): CreatorGroupSpec {
  return CREATOR_GROUPS.find((g) => g.id === id)!;
}

/** Every action of a group, in catalog order. */
export function groupActionIds(group: CreatorGroupId): CreatorActionId[] {
  return CREATOR_ACTIONS.filter((a) => a.group === group).map((a) => a.id);
}

export interface CreatorActionPrefs {
  /** Quick-row actions, in order (the row shows the first QUICK_ROW_MAX that apply). */
  pinned: CreatorActionId[];
  hidden: CreatorActionId[];
  groupOrder: CreatorGroupId[];
  hiddenGroups: CreatorGroupId[];
}

/** Image: Vary · Upscale · Quick edit · Animate. Video: Upscale · Editor. */
export const DEFAULT_PINNED: readonly CreatorActionId[] = [
  "vary_subtle",
  "upscale_faithful",
  "quick_edit",
  "animate_low",
  "upscale_clip",
  "video_editor",
];

export const DEFAULT_CREATOR_ACTION_PREFS: CreatorActionPrefs = {
  pinned: [...DEFAULT_PINNED],
  hidden: [],
  groupOrder: [...CREATOR_GROUP_IDS],
  hiddenGroups: [],
};

export function defaultCreatorActionPrefs(): CreatorActionPrefs {
  return {
    pinned: [...DEFAULT_PINNED],
    hidden: [],
    groupOrder: [...CREATOR_GROUP_IDS],
    hiddenGroups: [],
  };
}

const isActionId = (v: unknown): v is CreatorActionId =>
  typeof v === "string" &&
  (CREATOR_ACTION_IDS as readonly string[]).includes(v);
const isGroupId = (v: unknown): v is CreatorGroupId =>
  typeof v === "string" && (CREATOR_GROUP_IDS as readonly string[]).includes(v);

/** v1 prefs hid whole rows; a hidden row hides the actions it held. */
const LEGACY_ROWS: Readonly<Record<string, CreatorActionId[]>> = {
  vary: ["vary_subtle", "vary_strong"],
  upscale: [
    "upscale_faithful",
    "upscale_creative",
    "upscale_redetail",
    "upscale_clip",
  ],
  edit: ["quick_edit", "open_editor", "video_editor", "retake"],
  animate: ["animate_low", "animate_high", "loop_low", "loop_high"],
  rerun: ["rerun", "rerun_tweak"],
  use: ["use_image", "use_style", "use_prompt"],
  reproduce: ["reproduce"],
};
const LEGACY_SECTIONS: Readonly<Record<string, string[]>> = {
  primary: ["vary", "upscale", "edit", "animate"],
  more: ["rerun", "use", "reproduce"],
};

/** Stored / hand-edited / v1 prefs -> valid prefs (unknown ids dropped). */
export function normalizeCreatorActionPrefs(raw: unknown): CreatorActionPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const hidden: CreatorActionId[] = [];
  for (const v of list(r.hidden)) {
    if (isActionId(v)) hidden.push(v);
    else if (typeof v === "string" && LEGACY_ROWS[v])
      hidden.push(...LEGACY_ROWS[v]);
  }
  for (const s of list(r.hiddenSections)) {
    if (typeof s !== "string") continue;
    for (const row of LEGACY_SECTIONS[s] ?? [])
      hidden.push(...LEGACY_ROWS[row]);
  }

  const groupOrder = uniq(list(r.groupOrder).filter(isGroupId));
  for (const id of CREATOR_GROUP_IDS) {
    if (groupOrder.includes(id)) continue;
    const at = CREATOR_GROUP_IDS.indexOf(id);
    const after = CREATOR_GROUP_IDS.slice(0, at)
      .reverse()
      .find((x) => groupOrder.includes(x));
    if (after) groupOrder.splice(groupOrder.indexOf(after) + 1, 0, id);
    else groupOrder.unshift(id);
  }

  return {
    pinned: Array.isArray(r.pinned)
      ? uniq(r.pinned.filter(isActionId))
      : [...DEFAULT_PINNED],
    hidden: uniq(hidden),
    groupOrder,
    hiddenGroups: uniq(list(r.hiddenGroups).filter(isGroupId)),
  };
}

/** Shown in the lightbox (ignores media; see creatorActionLayout). */
export function isCreatorActionShown(
  prefs: CreatorActionPrefs,
  id: CreatorActionId,
): boolean {
  return (
    !prefs.hidden.includes(id) && !prefs.hiddenGroups.includes(specOf(id).group)
  );
}

export interface CreatorActionContext {
  media: LightboxMediaKind;
  external: boolean;
  /** The open clip can go to the video editor (Retake). Defaults to true. */
  canRetake?: boolean;
}

export function appliesTo(
  id: CreatorActionId,
  { media, external, canRetake = true }: CreatorActionContext,
): boolean {
  const spec = specOf(id);
  if (!spec.media.includes(media)) return false;
  if (external && spec.localOnly) return false;
  if (spec.needs === "retake" && !canRetake) return false;
  return true;
}

export interface CreatorGroupLayout {
  id: CreatorGroupId;
  /** Shown actions, catalog order. */
  actions: CreatorActionId[];
  /** Applicable but hidden (listed while customizing). */
  hidden: CreatorActionId[];
}

export interface CreatorActionLayout {
  /** At most QUICK_ROW_MAX. */
  quick: CreatorActionId[];
  /** Visible groups that have at least one applicable action. */
  groups: CreatorGroupLayout[];
  /** Applicable but hidden (by action or group): the Tools fallback. */
  hidden: CreatorActionId[];
}

export function creatorActionLayout(
  prefs: CreatorActionPrefs,
  ctx: CreatorActionContext,
): CreatorActionLayout {
  const quick = prefs.pinned
    .filter((id) => appliesTo(id, ctx) && isCreatorActionShown(prefs, id))
    .slice(0, QUICK_ROW_MAX);
  const groups: CreatorGroupLayout[] = [];
  const hidden: CreatorActionId[] = [];
  for (const g of prefs.groupOrder) {
    const ids = groupActionIds(g).filter((id) => appliesTo(id, ctx));
    if (ids.length === 0) continue;
    if (prefs.hiddenGroups.includes(g)) {
      hidden.push(...ids);
      continue;
    }
    const shown = ids.filter((id) => !prefs.hidden.includes(id));
    const off = ids.filter((id) => prefs.hidden.includes(id));
    hidden.push(...off);
    groups.push({ id: g, actions: shown, hidden: off });
  }
  return { quick, groups, hidden };
}

/** Pinned and shown, so it sits in the quick row (when it applies). */
export function isPinnedShown(
  prefs: CreatorActionPrefs,
  id: CreatorActionId,
): boolean {
  return prefs.pinned.includes(id) && isCreatorActionShown(prefs, id);
}

/** Pinning `id` would fit the quick row (always true for a pinned one). */
export function canPin(
  prefs: CreatorActionPrefs,
  id: CreatorActionId,
  ctx: CreatorActionContext,
): boolean {
  if (isPinnedShown(prefs, id)) return true;
  return creatorActionLayout(prefs, ctx).quick.length < QUICK_ROW_MAX;
}

export function withPinned(
  prefs: CreatorActionPrefs,
  id: CreatorActionId,
  on: boolean,
): CreatorActionId[] {
  if (on)
    return prefs.pinned.includes(id) ? prefs.pinned : [...prefs.pinned, id];
  return prefs.pinned.filter((x) => x !== id);
}

const swap = <T>(list: T[], item: T, dir: -1 | 1, among: T[] = list): T[] => {
  const at = among.indexOf(item);
  const other = among[at + dir];
  if (at === -1 || other === undefined) return list;
  const next = [...list];
  const i = next.indexOf(item);
  const j = next.indexOf(other);
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Move a pinned action left/right among the pins that apply to `ctx`. */
export function movePinned(
  prefs: CreatorActionPrefs,
  id: CreatorActionId,
  dir: -1 | 1,
  ctx?: CreatorActionContext,
): CreatorActionId[] {
  const among = ctx
    ? prefs.pinned.filter((x) => appliesTo(x, ctx))
    : prefs.pinned;
  return swap(prefs.pinned, id, dir, among);
}

export function moveGroup(
  prefs: CreatorActionPrefs,
  id: CreatorGroupId,
  dir: -1 | 1,
): CreatorGroupId[] {
  return swap(prefs.groupOrder, id, dir);
}

/** One group back to defaults: its actions shown, default pins, group visible. */
export function resetGroupPrefs(
  prefs: CreatorActionPrefs,
  group: CreatorGroupId,
): CreatorActionPrefs {
  const ids = groupActionIds(group);
  const inGroup = (id: CreatorActionId) => ids.includes(id);
  const pinned = prefs.pinned.filter((id) => !inGroup(id));
  for (const id of DEFAULT_PINNED) {
    if (!inGroup(id)) continue;
    // Back at its default slot relative to the other default pins.
    const at = DEFAULT_PINNED.indexOf(id);
    const before = DEFAULT_PINNED.slice(at + 1).find((x) => pinned.includes(x));
    if (before) pinned.splice(pinned.indexOf(before), 0, id);
    else pinned.push(id);
  }
  return {
    ...prefs,
    pinned,
    hidden: prefs.hidden.filter((id) => !inGroup(id)),
    hiddenGroups: prefs.hiddenGroups.filter((g) => g !== group),
  };
}

// Tools-panel fallback for hidden actions

export const HIDDEN_ACTIONS_GROUP = "Hidden actions";

/**
 * Tools-panel rows for hidden actions (one per group, its hidden actions as
 * buttons) so search still finds them. 3D & layers are skipped: their cards
 * are already in Tools.
 */
export function hiddenActionTools(ids: CreatorActionId[]): LightboxTool[] {
  const out: LightboxTool[] = [];
  for (const g of CREATOR_GROUP_IDS) {
    const specs = ids
      .map(specOf)
      .filter((s) => s.group === g && s.run.kind !== "open_tool");
    if (specs.length === 0) continue;
    const group = groupSpec(g);
    const variants: InlineVariant[] = specs.map((s) => ({
      label: s.label,
      ariaLabel: s.name,
      run: s.run as InlineRun,
    }));
    out.push({
      key: `creator:${g}`,
      title: group.label,
      subtitle: specs.map((s) => s.name).join(", "),
      group: HIDDEN_ACTIONS_GROUP,
      icon: group.icon,
      media: [...new Set(specs.flatMap((s) => s.media))],
      localOnly: specs.every((s) => s.localOnly),
      aliases: [group.label, ...specs.map((s) => s.name), "hidden", "action"],
      target: { kind: "inline", variants },
    });
  }
  return out;
}
