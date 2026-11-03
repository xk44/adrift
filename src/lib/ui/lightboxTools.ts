/**
 * Lightbox "Tools" panel catalog.
 *
 * The lightbox keeps a short set of core rows (Rerun, Vary, Upscale, Use,
 * Edit, Animate); everything else lives in one searchable Tools panel:
 *  - inline tools: the lightbox's own action handlers (Expand zoom/pan,
 *    Face Enhancer, Realism, Remix, 3D, ...) that run on the open image
 *    directly; row titles come from lib/tools/toolNames.ts, and
 *  - hub tools: Tools-page cards that open with the open image/clip
 *    preloaded as their input (see lib/tools/toolHandoff.ts).
 *
 * Pure (no React) so filtering / search / grouping are unit-tested.
 */

import {
  VIDEO_EXPAND_LTX_MAX_FRAMES,
  VIDEO_EXPAND_LTX_WINDOW_SECONDS,
} from "@/lib/oj/videoExpand";
import type { GalleryImage } from "@/types";
import {
  ACTION_TOOLS,
  buildToolCards,
  type ActionToolSpec,
  type CatalogTool,
} from "@/lib/tools/toolsPage";
import {
  buildHubCards,
  HUB_CATEGORIES,
  HUB_CATEGORY_LABELS,
  type HubCard,
} from "@/lib/tools/hub";
import { EXPAND_KEY, toolAliases, toolTitle } from "@/lib/tools/toolNames";
import { HIDDEN_ACTIONS_GROUP } from "@/lib/ui/creatorActions";

/** What kind of item is open in the lightbox. */
export type LightboxMediaKind = "image" | "video" | "audio" | "mesh";

export function lightboxMediaKind(item: GalleryImage): LightboxMediaKind {
  if (item.videoUrl) return "video";
  if (item.audioUrl) return "audio";
  if (item.meshUrl) return "mesh";
  return "image";
}

/** What an inline tool does when picked (dispatched by the Lightbox). */
export type InlineRun =
  | { kind: "action"; action: string; params?: Record<string, unknown> }
  | { kind: "remix"; variant: "subtle" | "strong" }
  | { kind: "use_start_frame" }
  | { kind: "prompt_seed" }
  // Creator actions the user hid (lib/ui/creatorActions.ts).
  | { kind: "rerun" }
  | { kind: "rerun_tweak" }
  | { kind: "use"; mode: "image_prompt" | "style_ref" }
  | { kind: "use_prompt" }
  | { kind: "quick_edit" }
  | { kind: "edit" }
  | { kind: "retake" }
  | { kind: "reproduce" };

export interface InlineVariant {
  /** Button text (short) or "" for icon-only. */
  label: string;
  ariaLabel: string;
  /** Icon name for icon-only buttons (pan arrows). */
  icon?: string;
  run: InlineRun;
}

export type LightboxToolTarget =
  | { kind: "inline"; variants: InlineVariant[] }
  | { kind: "open"; toolKey: string };

export interface LightboxTool {
  /** "inline:<id>" or the hub card key. */
  key: string;
  title: string;
  subtitle: string;
  group: string;
  /** Icon name (TOOL_ICONS or the panel's own inline icon map). */
  icon: string;
  /** Item kinds the tool takes. */
  media: LightboxMediaKind[];
  /** Needs a local run (generation actions); hidden for external images. */
  localOnly: boolean;
  aliases: string[];
  target: LightboxToolTarget;
}

/** Video Expand (LTX-2.5 IC-LoRA Outpaint, packs/ltx25/video_expand.json). */
const VIDEO_EXPAND_KEY = "action:video_expand";

/** Inline groups first, in this order; hub sections follow (HUB_CATEGORIES). */
export const INLINE_GROUPS = ["Reframe", "Refine", "Remix"] as const;

const act = (
  label: string,
  ariaLabel: string,
  action: string,
  params?: Record<string, unknown>,
  icon?: string,
): InlineVariant => ({
  label,
  ariaLabel,
  ...(icon ? { icon } : {}),
  run: params ? { kind: "action", action, params } : { kind: "action", action },
});

/**
 * toolNames.ts key that names each inline row: zoom + pan are both Expand,
 * ADetailer is Face Enhancer.
 */
export const INLINE_TOOL_NAME_KEY: Readonly<Record<string, string>> = {
  "inline:zoom": EXPAND_KEY,
  "inline:pan": EXPAND_KEY,
  "inline:vzoom": VIDEO_EXPAND_KEY,
  "inline:vpan": VIDEO_EXPAND_KEY,
  "inline:detail": "inline:detail",
  "inline:adetailer": "action:enhance_faces",
  "inline:realism": "inline:realism",
  "inline:remix": "inline:remix",
  "inline:reuse": "inline:reuse",
};

const EXPAND = toolTitle(EXPAND_KEY);
const VEXPAND = toolTitle(VIDEO_EXPAND_KEY);
/** Frame window the lightbox rows run on (LTX default engine). */
const VEX_WINDOW = `first ${VIDEO_EXPAND_LTX_MAX_FRAMES} frames, ~${VIDEO_EXPAND_LTX_WINDOW_SECONDS} s`;
const vex = (label: string, aria: string, expand: string, icon?: string) =>
  act(
    label,
    `${VEXPAND}: ${aria} (${VEX_WINDOW})`,
    "video_expand",
    { expand, engine: "ltx" },
    icon,
  );

/** Canonical aliases for an inline row (minus `drop`) plus row extras. */
function inlineAliases(
  key: string,
  extra: string[],
  drop: string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of [...toolAliases(INLINE_TOOL_NAME_KEY[key]), ...extra]) {
    const k = a.toLowerCase();
    if (seen.has(k) || drop.includes(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export const INLINE_TOOLS: LightboxTool[] = [
  {
    key: "inline:zoom",
    title: `${EXPAND} (zoom out)`,
    subtitle: "Widen the frame and paint in the new border",
    group: "Reframe",
    icon: "ZoomOut",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:zoom", ["zoom"], ["pan"]),
    target: {
      kind: "inline",
      variants: [
        act("1.5x", `${EXPAND}: zoom out 1.5x`, "zoom_out_1_5x"),
        act("2x", `${EXPAND}: zoom out 2x`, "zoom_out_2x"),
      ],
    },
  },
  {
    key: "inline:pan",
    title: `${EXPAND} (pan)`,
    subtitle: "Extend the image in one direction",
    group: "Reframe",
    icon: "Move",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases(
      "inline:pan",
      ["pan", "left", "right", "up", "down"],
      ["zoom", "zoom out"],
    ),
    target: {
      kind: "inline",
      variants: [
        act("", `${EXPAND}: pan left`, "pan_left", undefined, "ArrowLeft"),
        act("", `${EXPAND}: pan up`, "pan_up", undefined, "ArrowUp"),
        act("", `${EXPAND}: pan down`, "pan_down", undefined, "ArrowDown"),
        act("", `${EXPAND}: pan right`, "pan_right", undefined, "ArrowRight"),
      ],
    },
  },
  {
    key: "inline:vzoom",
    title: `${VEXPAND} (zoom out)`,
    subtitle: `Widen the clip (${VEX_WINDOW}); only the new border is generated, the original stays untouched`,
    group: "Reframe",
    icon: "ZoomOut",
    media: ["video"],
    localOnly: true,
    aliases: inlineAliases("inline:vzoom", ["zoom"], ["pan"]),
    target: {
      kind: "inline",
      variants: [
        vex("1.25x", "zoom out 1.25x", "zoom_1_25"),
        vex("1.5x", "zoom out 1.5x", "zoom_1_5"),
        vex("2x", "zoom out 2x", "zoom_2"),
      ],
    },
  },
  {
    key: "inline:vpan",
    title: `${VEXPAND} (pan)`,
    subtitle: `Extend the clip in one direction (${VEX_WINDOW})`,
    group: "Reframe",
    icon: "Move",
    media: ["video"],
    localOnly: true,
    aliases: inlineAliases(
      "inline:vpan",
      ["left", "right", "up", "down"],
      ["zoom out video"],
    ),
    target: {
      kind: "inline",
      variants: [
        vex("", "extend left", "pan_left", "ArrowLeft"),
        vex("", "extend up", "pan_up", "ArrowUp"),
        vex("", "extend down", "pan_down", "ArrowDown"),
        vex("", "extend right", "pan_right", "ArrowRight"),
      ],
    },
  },
  {
    key: "inline:detail",
    title: toolTitle("inline:detail"),
    subtitle: "Second pass that sharpens texture and small detail",
    group: "Refine",
    icon: "Sparkles",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:detail", []),
    target: {
      kind: "inline",
      variants: [
        act("Detail", "Detail", "detail"),
        act("Upscale + Detail", "Upscale + Detail", "upscale_detail"),
      ],
    },
  },
  {
    key: "inline:adetailer",
    title: toolTitle("action:enhance_faces"),
    subtitle: "Find faces and hands and repaint them cleanly",
    group: "Refine",
    icon: "ScanFace",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:adetailer", ["refine"]),
    target: {
      kind: "inline",
      variants: [
        act("Fix faces", "Fix faces (ADetailer)", "adetailer"),
        act("Auto Refine", "Auto Refine", "adetailer_auto"),
      ],
    },
  },
  {
    key: "inline:realism",
    title: toolTitle("inline:realism"),
    subtitle: "Push toward a photographic finish",
    group: "Refine",
    icon: "Camera",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:realism", []),
    target: {
      kind: "inline",
      variants: [
        act("Realism", "Realism", "realism_lite"),
        act("Realism+", "Realism+", "realism_pro"),
      ],
    },
  },
  {
    key: "inline:remix",
    title: toolTitle("inline:remix"),
    subtitle: "Send the prompt and this image back to Create",
    group: "Remix",
    icon: "RefreshCw",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:remix", ["remix"]),
    target: {
      kind: "inline",
      variants: [
        {
          label: "Subtle",
          ariaLabel: "Remix subtle",
          run: { kind: "remix", variant: "subtle" },
        },
        {
          label: "Strong",
          ariaLabel: "Remix strong",
          run: { kind: "remix", variant: "strong" },
        },
      ],
    },
  },
  {
    key: "inline:reuse",
    title: toolTitle("inline:reuse"),
    subtitle: "Prompt with its seed, or this image as a video start frame",
    group: "Remix",
    icon: "Film",
    media: ["image"],
    localOnly: true,
    aliases: inlineAliases("inline:reuse", []),
    target: {
      kind: "inline",
      variants: [
        {
          label: "Prompt + seed",
          ariaLabel: "Use + Seed",
          run: { kind: "prompt_seed" },
        },
        {
          label: "Start frame",
          ariaLabel: "Use as start frame",
          run: { kind: "use_start_frame" },
        },
      ],
    },
  },
  // 3D: the hub's 3D Model card (Trellis) opens with this image.
];

/** Which item kinds an action tool's runner takes as its first input. */
export function actionToolMedia(spec: ActionToolSpec): LightboxMediaKind[] {
  if (spec.noSourceInput) return spec.audioHandoff ? ["audio"] : [];
  if (spec.videoInput) return ["video"];
  return ["image"];
}

/**
 * Special cards whose runner takes the hand-off (useToolHandoff), by key,
 * with the item kinds it accepts as its first input.
 */
export const SPECIAL_TOOL_MEDIA: Readonly<
  Record<string, readonly LightboxMediaKind[]>
> = {
  "special:dub_video": ["video"],
};

/**
 * Hub card -> panel entry for cards whose runner accepts the hand-off
 * (ToolRunner action + catalog cards, templates, apps, the special cards in
 * SPECIAL_TOOL_MEDIA). Null for everything else, and for catalog tools that
 * are not installed (no dead ends).
 */
export function hubToolEntry(card: HubCard): LightboxTool | null {
  let media: LightboxMediaKind[];
  if (card.kind === "catalog") {
    // Catalog LoRA tools (Expand, Inpaint, Face Swap, ...) are image edits.
    if (!card.available) return null;
    media = ["image"];
  } else if (card.kind === "action") {
    const spec = ACTION_TOOLS.find((s) => s.id === card.id);
    media = spec ? actionToolMedia(spec) : [];
  } else if (card.kind === "template" || card.kind === "app") {
    media = ["image"];
  } else if (
    card.kind === "special" &&
    Object.prototype.hasOwnProperty.call(SPECIAL_TOOL_MEDIA, card.key)
  ) {
    media = [...SPECIAL_TOOL_MEDIA[card.key]];
  } else {
    return null;
  }
  if (media.length === 0) return null;
  return {
    key: card.key,
    title: card.title,
    subtitle: card.subtitle,
    group: HUB_CATEGORY_LABELS[card.hubCategory],
    icon: card.icon,
    media,
    localOnly: false,
    aliases: [...card.aliases, card.model ?? ""].filter(Boolean),
    target: { kind: "open", toolKey: card.key },
  };
}

/**
 * Hub cards (action availability is checked on the Tools page itself).
 * `catalog` is GET /api/tools; null until it loads, so catalog tools join
 * the panel once it arrives.
 */
export function buildHubToolEntries(
  catalog: CatalogTool[] | null = null,
): LightboxTool[] {
  const toolCards = buildToolCards({
    catalog,
    packIds: null,
    editLoras: null,
  });
  const cards = buildHubCards({
    toolCards,
    ctx: { catalog, packIds: null, editLoras: null },
  });
  const out: LightboxTool[] = [];
  for (const c of cards) {
    const entry = hubToolEntry(c);
    if (entry) out.push(entry);
  }
  return out;
}

export function buildLightboxTools(
  catalog: CatalogTool[] | null = null,
): LightboxTool[] {
  return [...INLINE_TOOLS, ...buildHubToolEntries(catalog)];
}

export interface LightboxToolFilter {
  media: LightboxMediaKind;
  /** External (non-local) item: inline generation actions don't apply. */
  external: boolean;
  query: string;
}

/** Media + locality + AND-of-words search over title/subtitle/group/aliases. */
export function filterLightboxTools(
  tools: LightboxTool[],
  { media, external, query }: LightboxToolFilter,
): LightboxTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter((t) => {
    if (!t.media.includes(media)) return false;
    if (external && t.localOnly) return false;
    if (!words.length) return true;
    const variantText =
      t.target.kind === "inline"
        ? t.target.variants.map((v) => `${v.label} ${v.ariaLabel}`).join(" ")
        : "";
    const hay = [t.title, t.subtitle, t.group, variantText, ...t.aliases]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface LightboxToolGroup {
  group: string;
  tools: LightboxTool[];
}

const GROUP_ORDER: string[] = [
  HIDDEN_ACTIONS_GROUP,
  ...INLINE_GROUPS,
  ...HUB_CATEGORIES.map((c) => HUB_CATEGORY_LABELS[c]),
];

/** Inline groups first, then hub sections; input order within a group. */
export function groupLightboxTools(tools: LightboxTool[]): LightboxToolGroup[] {
  const map = new Map<string, LightboxTool[]>();
  for (const t of tools) {
    const list = map.get(t.group) ?? [];
    list.push(t);
    map.set(t.group, list);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([group, list]) => ({ group, tools: list }));
}
