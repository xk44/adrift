/**
 * Tools hub IA: task categories over every runnable card —
 * catalog LoRA tools, action tools, template cards, apps and "coming"
 * placeholders. Pure (no React) so grouping/search are unit-tested.
 */

import {
  APP_TEMPLATES,
  appEngines,
  type AppCategory,
  type AppTemplate,
} from "./apps";
import { STYLE_PRESETS } from "./stylePresets";
import {
  EDIT_ENGINES,
  PLACEHOLDERS,
  TEMPLATES,
  enginesAvailability,
  type EngineContext,
  preferredEngine,
} from "./templates";
import type { CatalogTool, ToolCard } from "./toolsPage";
import type { BadgeSource, LicenseBadge } from "./licenseBadges";
import { toolAliases, toolName, toolTitle } from "./toolNames";
import { STORYBOARD_ENGINES } from "./storyboard";
import {
  boardCard,
  dubVideoCard,
  voiceChangerCard,
  overlayCompositeCard,
  pipelineCards,
} from "./pipelineCards";
import { productStudioCard } from "./productStudio";
import { ltxShotCards } from "./ltxShots";
import { flux3ShotCards } from "./flux3Shots";
import { motionCards } from "./motionCard";
import { stitchClipsCard } from "./stitchClips";
import { gridVideoCard } from "./gridVideo";
import { musicVideoCard, type MvModelStatus } from "./musicVideo";
import { trainIdentityCards } from "./trainIdentityCard";
import { trainAudioLoraCards } from "./audioLoraCard";
import { hairdeckCard } from "@/lib/hairdeck/card";

export const HUB_CATEGORIES = [
  "Image",
  "Edit",
  "Identity",
  "Video",
  "VFX",
  "Enhance",
  // One-click apps (appTemplates.json + a few template cards), by job.
  "Ads",
  "Portraits",
  "Characters",
  "Styles",
  "Scenes",
  "Audio",
] as const;

export type HubCategory = (typeof HUB_CATEGORIES)[number];

export const HUB_CATEGORY_LABELS: Record<HubCategory, string> = {
  Image: "Image",
  Edit: "Edit",
  Identity: "Swap",
  Video: "Video",
  VFX: "LTX VFX",
  Enhance: "Enhance",
  Ads: "Products",
  Portraits: "Portraits",
  Characters: "Characters",
  Styles: "Art Styles",
  Scenes: "Scenes & Effects",
  Audio: "Audio",
};

/**
 * The retired "Apps" section. Saved user tools (data/user_tools.json) and
 * older clients may still send it; it reads as Scenes & Effects.
 */
export const LEGACY_APPS_CATEGORY = "Apps";
export const LEGACY_APPS_TARGET: HubCategory = "Scenes";

/** App template category (appTemplates.json) -> hub section. */
export const APP_HUB: Record<AppCategory, HubCategory> = {
  "Ads & Products": "Ads",
  Portraits: "Portraits",
  "Characters & Games": "Characters",
  "Style & Art": "Styles",
  "Scenes & FX": "Scenes",
};

/**
 * One-line note under a section heading. LTX VFX names its core model so it
 * is clear every tool there runs on LTX-2.5.
 */
export const HUB_CATEGORY_NOTES: Partial<Record<HubCategory, string>> = {
  VFX:
    "Video in, video out, with synced audio. LTX-2.5 22B, open weights.",
};

export type HubCardKind =
  ToolCard["kind"] | "template" | "special" | "app" | "placeholder";

export interface HubCard extends Omit<ToolCard, "kind" | "category"> {
  kind: HubCardKind;
  hubCategory: HubCategory;
  /** Open model shown subtly on the card ("Model · license" via modelLine). */
  model: string | null;
  /** Non-commercial weights (badge). */
  nc: boolean;
  /** Extra search terms. */
  aliases: string[];
  /** App category (appTemplates.json; picks the app's hub section). */
  appCategory?: string;
  /** Engine group id when this grid card stands for several engines. */
  engineGroup?: string;
  /** Card the grid opens (the group's best ready engine); default `key`. */
  openKey?: string;
  /** Folded engine-group card: its most permissive engine's license badge. */
  weights?: LicenseBadge;
  /** Licenses behind `weights` (tooltip terms + links). */
  weightSources?: BadgeSource[];
}

interface Override {
  title?: string;
  hub?: HubCategory;
  model?: string;
  nc?: boolean;
  aliases?: string[];
}

/**
 * Hub section, open model and NC badge per existing card. Display titles
 * and search aliases live in toolNames.ts (one name per tool app-wide).
 */
const CARD_META: Record<string, Omit<Override, "title" | "aliases">> = {
  "action:edit_photo": { hub: "Edit", model: "Krea 2 + edit LoRA" },
  "action:edit_qwen21": {
    hub: "Edit",
    model: "Qwen-Image 2.1",
    nc: true,
  },
  "action:edit_flux3": { hub: "Edit", model: "FLUX.3 Klein" },
  "action:edit_fibo": {
    hub: "Edit",
    model: "Bria FIBO 2.0",
    nc: true,
  },
  "action:remove_object": { hub: "Edit", model: "Krea 2 + edit LoRA" },
  "action:restyle_locked": { hub: "Image", model: "Krea 2 + edit LoRA" },
  "action:replace_person": {
    hub: "Identity",
    model: "Krea 2 + grounded LoRA",
  },
  "action:pose_character": {
    hub: "Identity",
    model: "Krea 2 + identity LoRA + depth control",
  },
  "action:bg_remove": {
    hub: "Edit",
    model: "Background-removal model",
  },
  "action:upscale": { hub: "Enhance", model: "Real-ESRGAN" },
  "action:enhance_faces": { hub: "Enhance", model: "Krea 2 detailer" },
  "action:animate": { hub: "Video", model: "LTX-Video" },
  "action:make_3d_trellis": { hub: "Image", model: "TRELLIS.2 / Pixal3D" },
  "action:image_to_splat": { hub: "Image", model: "TripoSplat" },
  "action:body_3d": { hub: "Image", model: "SAM 3D Body" },
  "action:moge_geometry": { hub: "Image", model: "MoGe-2 / MoGe-3" },
  "action:material_maps": { hub: "Image", model: "Marigold V2" },
  "action:body_3d_video": { hub: "Video", model: "SAM 3D Body" },
  "action:make_3d": { hub: "Image" },
  "action:music": { hub: "Audio", model: "ACE-Step 1.5 turbo" },
  "action:sfx": {
    hub: "Audio",
    model: "Stable Audio 3 small SFX",
  },
  "action:sa3_t2a": { hub: "Audio", model: "Stable Audio 3 Medium" },
  "action:sa3_a2a": { hub: "Audio", model: "Stable Audio 3 Medium" },
  "action:sa3_inpaint": { hub: "Audio", model: "Stable Audio 3 Medium" },
  "action:sa3_extend": { hub: "Audio", model: "Stable Audio 3 Medium" },
  "action:face_swap": { hub: "Identity", model: "MiniMax H3" },
  "action:character_swap": {
    hub: "Identity",
    model: "MiniMax H3 + Character Swap LoRA",
  },
  "action:wan_animate": { hub: "Identity", model: "Wan Animate 2" },
  "action:talking_avatar": { hub: "Audio", model: "Wan 2.2 S2V" },
  "action:lipsync": {
    hub: "Audio",
    model: "InfiniteTalk (Wan 2.1)",
  },
  "action:video_lipsync": {
    hub: "Audio",
    model: "InfiniteTalk (Wan 2.1) + SAM 3.1",
  },
  "action:orbit_360": { hub: "Video", model: "MiniMax H3" },
  "action:camera_move": { hub: "Video", model: "MiniMax H3" },
  "action:transition": { hub: "Video", model: "MiniMax H3" },
  "action:ref_video": {
    hub: "Video",
    model: "MiniMax H3 Ref2VA + Turbo 8-step",
  },
  "action:multiframe_ref": {
    hub: "Video",
    model: "MiniMax H3 Ref2VA + keyframe guides",
  },
  "action:h3_charsheet": {
    hub: "Identity",
    model: "MiniMax H3 Ref2VA + Turbo 8-step",
  },
  "action:ltx25_animate": {
    hub: "Video",
    model: "LTX-2.5 22B distilled · open weights",
  },
  "action:ltx25_transition": {
    hub: "Video",
    model: "LTX-2.5 22B distilled · open weights",
  },
  "action:wan_motion": {
    hub: "Video",
    model: "Wan 2.1 / 2.2 + motion LoRAs",
  },
  "action:wan_camera": { hub: "Video", model: "Wan 2.2 Fun Camera" },
  "action:wan_move": { hub: "Video", model: "Wan-Move 14B" },
  "action:person_remove": { hub: "Video", model: "MiniMax H3 + SAM 3.1" },
  "action:cast_swap": {
    hub: "Identity",
    model: "MiniMax H3 + SAM 3.1 + Qwen3-VL",
  },
  "action:video_bg_swap": { hub: "Video", model: "MiniMax H3 + SAM 3.1" },
  "action:video_object_add": { hub: "Video", model: "MiniMax H3" },
  "action:video_object_remove": {
    hub: "Video",
    model: "SAM 3.1 + Wan2.2 Fun VACE",
  },
  "action:video_object_swap": {
    hub: "Video",
    model: "SAM 3.1 + Wan2.2 Fun VACE",
  },
  "action:video_remove_text": {
    hub: "Video",
    model: "SAM 3.1 + Wan2.2 Fun VACE",
  },
  "action:video_bg_change": {
    hub: "Video",
    model: "BiRefNet matte + composite",
  },
  "action:video_palette": { hub: "Video", model: "OKLab LUT grade (CPU, no model)" },
  "action:crossview": { hub: "Video", model: "MiniMax H3" },
  "action:video_bg_remove": { hub: "Video", model: "Video matting model" },
  "action:subject_matte": {
    hub: "Video",
    model: "MatAnyone2 + SAM 3.1",
    nc: true,
  },
  "action:upscale_seedvr2": {
    hub: "Enhance",
    model: "SeedVR2 3B / 7B / 7B sharp",
  },
  "action:upscale_vosr2": { hub: "Enhance", model: "VOSR 2.0" },
  "action:upscale_video": {
    hub: "Video",
    model: "Real-ESRGAN / UltraSharp / SeedVR2 3B / 7B / 7B sharp",
  },
  "action:interpolate": { hub: "Video", model: "RIFE 4.26 / FILM" },
  "action:relight": {
    hub: "Enhance",
    model: "Qwen-Image-Edit-2509 + Relight / Light Migration LoRA",
  },
  "action:vace_restyle": { hub: "Video", model: "Wan2.2 Fun VACE" },
  "action:vace_reframe": { hub: "Video", model: "Wan2.2 Fun VACE" },
  "action:video_expand": { hub: "Video", model: "LTX-2.5 + IC-LoRA Outpaint" },
  "action:video_retake": { hub: "Video", model: "LTX-2.5" },
  "action:vace_extend": { hub: "Video", model: "Wan2.2 Fun VACE" },
  "action:shots": {
    hub: "Enhance",
    model: "Qwen-Image-Edit-2509 + Multiple-Angles LoRA",
  },
  "action:zooms": {
    hub: "Enhance",
    model: "Qwen-Image-Edit-2509 + Multiple-Angles LoRA",
  },
  "action:layers": { hub: "Edit", model: "Qwen-Image-Layered" },
  "action:vectorize": {
    hub: "Edit",
    model: "OpenCV tracer (vtracer optional)",
  },
  "action:breakdown": { hub: "Edit", model: "SAM 3.1" },
  "action:see_through": {
    hub: "Edit",
    model: "see-through (SDXL LayerDiff3D + Marigold)",
  },
  "action:refocus": {
    hub: "Edit",
    model: "Depth Anything 3 + layered lens blur",
  },
  "action:rack_focus": {
    hub: "Video",
    model: "Depth Anything 3 + layered lens blur",
  },
  "action:sdr_to_hdr": {
    hub: "Enhance",
    model: "ImageSDRToHDR (core, no weights)",
  },
  "action:video_edit": {
    hub: "Video",
    model: "Lucy Edit Dev",
    nc: true,
  },
  "action:describe": { hub: "Image", model: "Qwen3-VL" },
  "catalog:outpaint": { hub: "Edit" },
  "catalog:qwen21-restore": { hub: "Enhance" },
  "catalog:qwen21-camera": { hub: "Image" },
  "catalog:flux3-camera": { hub: "Image" },
  "catalog:qwen2511-camera": { hub: "Image" },
  "catalog:qwen21-remove-bg": { hub: "Edit" },
  "catalog:qwen21-outfit-swap": { hub: "Identity" },
  "catalog:qwen21-unblur-background": { hub: "Enhance" },
  "catalog:krea2-general-edit": { hub: "Edit" },
  "catalog:krea2-inpaint": { hub: "Edit" },
  "catalog:krea2-anypaint": { hub: "Edit" },
  "catalog:qwen21-head-swap": { hub: "Identity" },
  "catalog:krea2-head-swap": { hub: "Identity" },
  "catalog:qwen21-body-swap": { hub: "Identity" },
  "catalog:krea2-body-swap": { hub: "Identity" },
  "catalog:qwen21-next-scene": { hub: "Image" },
  "catalog:qwen21-remove-box": { hub: "Edit" },
  "catalog:qwen2511-remove": { hub: "Edit" },
  "catalog:qwen21-doodle": { hub: "Edit" },
  "catalog:qwen21-anything2real": { hub: "Image" },
  "catalog:qwen21-pano360": { hub: "Image" },
  "catalog:qwen21-character-sheet": { hub: "Identity" },
  "catalog:qwen21-realism": { hub: "Enhance" },
  "catalog:qwen2511-unblur-upscale": { hub: "Enhance" },
  "catalog:flux3-restore": { hub: "Enhance" },
  "catalog:flux3-outpaint": { hub: "Edit" },
  "catalog:qwen21-outpaint": { hub: "Edit" },
  "catalog:krea2-outpaint": { hub: "Edit" },
  "catalog:moss-restyle-depth": { hub: "Image" },
  "catalog:krea2-restyle-depth": { hub: "Image" },
  "catalog:krea2-layout-regions": { hub: "Image" },
  "catalog:moss-charref": { hub: "Identity" },
  "catalog:moss-colorize": { hub: "Enhance" },
  "action:voiceover": {
    hub: "Audio",
    model: "VibeVoice Realtime 0.5B / 1.5B",
  },
  "action:add_sound": {
    hub: "Audio",
    model: "MMAudio",
    nc: true,
  },
  // Restore: LTX-2.5 restoration IC-LoRAs (ltx-2.x community license).
  "action:ltx_restore": {
    hub: "Video",
    model:
      "LTX-2.5 IC-LoRA Restore / Deblur / Decompression / Colorization / Refine-Details",
  },
  // LTX VFX: LTX-2.5 LoRAs (ltx-2.x community license, not NC), own section.
  "action:ltx_alpha_matte": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Alpha-Gen",
  },
  "action:ltx_clean_plate": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Clean-Plate",
  },
  "action:ltx_day_to_night": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Day-To-Night",
  },
  "action:ltx_add_water": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Water-Simulation",
  },
  "action:ltx_cinemagraph": {
    hub: "VFX",
    model: "LTX-2.5 LoRA Cinemagraph",
  },
  "action:ltx_slow_motion": {
    hub: "VFX",
    model: "LTX-2.5 LoRA Slow-Motion-Control",
  },
  "action:ltx_ripple": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA LTX Ripple (community)",
  },
  "action:ltx_edge_control": {
    hub: "VFX",
    model: "LTX-2.5 + LTX-2.3 IC-LoRA Union Control",
  },
  "action:ltx_blockout_render": {
    hub: "VFX",
    model: "LTX-2.5 + LTX-2.3 IC-LoRA Union Control (Depth Anything 3 depth)",
  },
  "action:ltx_sdr_to_hdr": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA SDR-To-HDR",
  },
  "action:ltx_layout_render": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Layout-To-Render 1.0",
  },
  "action:ltx_ingredients": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA Ingredients 0.9",
  },
  "action:ltx_reshoot": {
    hub: "VFX",
    model: "LTX-2.5 + Qwen-Image 2.1 camera-angles LoRA",
    nc: true,
  },
  "action:ltx_exploded_view": {
    hub: "VFX",
    model: "LTX-2.5 LoRA XPLDV Exploded View (community)",
  },
  "action:ltx_paint_fluid": {
    hub: "VFX",
    model: "LTX-2.5 IC-LoRA ainvfx-fluid (community)",
  },
};

/** CARD_META merged with the canonical names from toolNames.ts. */
export const CARD_OVERRIDES: Record<string, Override> = Object.fromEntries(
  Object.entries(CARD_META).map(([key, meta]) => {
    const name = toolName(key);
    return [
      key,
      name ? { ...meta, title: name.title, aliases: [...name.aliases] } : meta,
    ];
  }),
);

/** Catalog category → hub section for tools without an override. */
export const CATALOG_HUB: Record<string, HubCategory> = {
  Edit: "Edit",
  Expand: "Edit",
  Inpaint: "Edit",
  Remove: "Edit",
  Restore: "Enhance",
  Enhance: "Enhance",
  Camera: "Image",
  Compose: "Image",
  Restyle: "Image",
  Story: "Image",
  Swap: "Identity",
  Outfit: "Identity",
};

/** Action-tool category → hub section fallback. */
export const ACTION_HUB: Record<string, HubCategory> = {
  Edit: "Edit",
  Enhance: "Enhance",
  "Animate & 3D": "Video",
  Audio: "Audio",
  Describe: "Image",
  "LTX VFX": "VFX",
};

/** Open model labels by catalog base id (fallback: the tool's baseLabel). */
const BASE_MODEL: Record<string, string> = {
  qwen21: "Qwen-Image 2.1",
  qwen2511: "Qwen-Image-Edit 2511",
  krea2: "Krea 2",
  flux3: "FLUX.3 Klein",
  moss: "MOSS-Image",
};

export function modelLine(model: string | null): string | null {
  if (!model) return null;
  // Lines that already name a license ("X · MIT") are shown as is.
  return model.includes(" · ") ? model : `${model} · open weights`;
}

export function toHubCard(
  card: ToolCard,
  catalog: CatalogTool[] | null,
): HubCard {
  const o = CARD_OVERRIDES[card.key] ?? {};
  const tool =
    card.kind === "catalog"
      ? catalog?.find((t) => t.id === card.id)
      : undefined;
  const hub =
    o.hub ??
    (card.kind === "catalog"
      ? CATALOG_HUB[card.category]
      : ACTION_HUB[card.category]) ??
    "Edit";
  const model =
    o.model ??
    (tool ? (BASE_MODEL[tool.base] ?? tool.baseLabel ?? null) : null);
  const nc = o.nc ?? tool?.license?.commercial === false;
  const { category: _category, ...rest } = card;
  void _category;
  return {
    ...rest,
    title: toolTitle(card.key, card.title),
    hubCategory: hub,
    model,
    nc,
    aliases: [...toolAliases(card.key), card.title, card.category],
  };
}

export const COLOR_GRADE_KEY = "special:color_grade";
export const SOUL_CAST_KEY = "special:soul_cast";
export const STYLE_PRESETS_KEY = "special:style_presets";
export const STORYBOARD_KEY = "special:storyboard";
export const CHARACTER_PROFILES_KEY = "special:character_profiles";

/** Model-free / builder cards that open their own runner. */
function specialCards(ctx: EngineContext): HubCard[] {
  return [
    {
      key: COLOR_GRADE_KEY,
      kind: "special",
      id: "color_grade",
      title: "Color Grade",
      subtitle: "Film looks, white balance and grain. Runs in your browser",
      icon: "SlidersHorizontal",
      hubCategory: "Enhance",
      available: true,
      unavailableReason: null,
      licenseNote: null,
      checking: false,
      model: "No model · runs in your browser",
      nc: false,
      aliases: ["colorgrade", "lut", "filter", "grading"],
    },
    {
      key: SOUL_CAST_KEY,
      kind: "special",
      id: "soul_cast",
      title: "Actor Builder",
      subtitle: "Cast a film character from genre, era and archetype menus",
      icon: "Clapperboard",
      hubCategory: "Image",
      // Imagine with the default pack: available when packs loaded at all.
      available: ctx.packIds ? ctx.packIds.size > 0 : false,
      unavailableReason:
        ctx.packIds && ctx.packIds.size === 0
          ? "No text-to-image pack is installed."
          : null,
      licenseNote: null,
      checking: !ctx.packIds,
      model: "Default Imagine pack",
      nc: false,
      aliases: ["soul cast", "cast", "character", "actor"],
    },
    {
      key: CHARACTER_PROFILES_KEY,
      kind: "special",
      id: "character_profiles",
      title: "Character Profiles",
      subtitle:
        "Save a character once (references, look, prompt suffix) and reuse it in any tool",
      icon: "UserSquare",
      hubCategory: "Identity",
      // Browser-side library; the tools it feeds report their own status.
      available: true,
      unavailableReason: null,
      licenseNote: null,
      checking: false,
      model: "Reference identity · no training",
      nc: false,
      aliases: [
        "soul id",
        "influencer",
        "ai influencer",
        "identity",
        "consistent character",
        "saved character",
      ],
    },
    {
      key: STYLE_PRESETS_KEY,
      kind: "special",
      id: "style_presets",
      title: "Style Presets",
      subtitle: `${STYLE_PRESETS.length} named looks for text-to-image, from film to claymation`,
      icon: "Paintbrush",
      hubCategory: "Image",
      available: ctx.packIds ? ctx.packIds.size > 0 : false,
      unavailableReason:
        ctx.packIds && ctx.packIds.size === 0
          ? "No text-to-image pack is installed."
          : null,
      licenseNote: null,
      checking: !ctx.packIds,
      model: "Default Imagine pack",
      nc: false,
      aliases: ["soul", "styles", "presets", "look", "aesthetic"],
    },
    engineCard(
      STORYBOARD_KEY,
      "special",
      "storyboard",
      "Storyboard",
      "A premise becomes 4-8 consistent frames, then animate them all",
      "LayoutGrid",
      "Image",
      STORYBOARD_ENGINES,
      ctx,
      ["popcorn", "storyboard", "sequence", "shots", "next scene", "story"],
    ),
  ];
}

function engineCard(
  key: string,
  kind: HubCardKind,
  id: string,
  title: string,
  subtitle: string,
  icon: string,
  hub: HubCategory,
  engineIds: Parameters<typeof enginesAvailability>[0],
  ctx: EngineContext,
  aliases: string[],
  appCategory?: string,
): HubCard {
  const av = enginesAvailability(engineIds, ctx);
  const models = [...new Set(engineIds.map((e) => EDIT_ENGINES[e].model))];
  const firstAvailable = preferredEngine(
    engineIds
      .map((e) => EDIT_ENGINES[e])
      .filter((e) => enginesAvailability([e.id], ctx).available),
  );
  const model = firstAvailable?.model ?? models[0] ?? null;
  return {
    key,
    kind,
    id,
    title,
    subtitle,
    icon,
    hubCategory: hub,
    available: av.available,
    unavailableReason: av.reason,
    licenseNote: null,
    checking: av.checking,
    model,
    nc: firstAvailable?.license === "nc",
    aliases,
    appCategory,
  };
}

export function appCard(app: AppTemplate, ctx: EngineContext): HubCard {
  return engineCard(
    `app:${app.id}`,
    "app",
    app.id,
    app.name,
    app.description,
    app.inputs?.second ? "Layers" : app.motion ? "Film" : "Wand",
    APP_HUB[app.category],
    appEngines(app),
    ctx,
    [app.category, ...(app.motion ? ["animate", "video"] : [])],
    app.category,
  );
}

export function buildHubCards(opts: {
  toolCards: ToolCard[];
  ctx: EngineContext;
  /** /api/tools/model-status (special cards that check files / nodes). */
  modelStatus?: MvModelStatus | null;
}): HubCard[] {
  const { ctx } = opts;
  const out: HubCard[] = opts.toolCards.map((c) => toHubCard(c, ctx.catalog));
  for (const t of TEMPLATES) {
    out.push(
      engineCard(
        `template:${t.id}`,
        "template",
        t.id,
        t.title,
        t.subtitle,
        t.icon,
        t.hubCategory as HubCategory,
        t.engines,
        ctx,
        t.aliases ?? [],
      ),
    );
  }
  out.push(...specialCards(ctx));
  out.push(...pipelineCards(ctx));
  out.push(productStudioCard(ctx));
  out.push(dubVideoCard(ctx));
  out.push(voiceChangerCard(ctx));
  out.push(overlayCompositeCard());
  out.push(hairdeckCard());
  out.push(boardCard());
  out.push(...ltxShotCards(ctx));
  out.push(...flux3ShotCards(ctx));
  out.push(...motionCards());
  out.push(stitchClipsCard());
  out.push(gridVideoCard());
  out.push(musicVideoCard(ctx, opts.modelStatus));
  out.push(...trainIdentityCards());
  out.push(...trainAudioLoraCards());
  for (const p of PLACEHOLDERS) {
    out.push({
      key: `placeholder:${p.id}`,
      kind: "placeholder",
      id: p.id,
      title: p.title,
      subtitle: p.subtitle,
      icon: p.icon,
      hubCategory: p.hubCategory as HubCategory,
      available: false,
      unavailableReason: p.reason,
      licenseNote: null,
      checking: false,
      model: null,
      nc: false,
      aliases: ["coming soon"],
    });
  }
  for (const app of APP_TEMPLATES) out.push(appCard(app, ctx));
  return out;
}

/** Case-insensitive AND-of-words match over title, subtitle, model, aliases. */
export function filterHubCards(cards: HubCard[], query: string): HubCard[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return cards;
  return cards.filter((c) => {
    const hay = [
      c.title,
      c.subtitle,
      c.model ?? "",
      c.hubCategory,
      c.appCategory ?? "",
      ...c.aliases,
      c.nc ? "non-commercial nc" : "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface HubGroup {
  category: HubCategory;
  label: string;
  cards: HubCard[];
}

/**
 * Sections in HUB_CATEGORIES order; inside each: ready first, then still
 * checking, then disabled (placeholders last); otherwise input order.
 */
export function groupHubCards(
  cards: HubCard[],
  only?: HubCategory | null,
): HubGroup[] {
  const rank = (c: HubCard) =>
    c.available ? 0 : c.checking ? 1 : c.kind === "placeholder" ? 3 : 2;
  return HUB_CATEGORIES.filter((cat) => !only || cat === only)
    .map((cat) => ({
      category: cat,
      label: HUB_CATEGORY_LABELS[cat],
      cards: cards
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c.hubCategory === cat)
        .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
        .map((x) => x.c),
    }))
    .filter((g) => g.cards.length > 0);
}
