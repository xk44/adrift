/**
 * Hub cards for the multi-step pipelines (Shorts Studio, Click to Ad,
 * ClipCut / Urban Cuts). Kept
 * out of hub.ts so the registry edit there stays one line.
 */
import type { HubCard } from "./hub";
import {
  EDIT_ENGINES,
  SINGLE_ENGINES,
  enginesAvailability,
  type EngineContext,
  preferredEngine,
} from "./templates";
import { toolAliases, toolTitle } from "./toolNames";
import { LTX25_PACK_ID } from "@/lib/oj/ltx25";

export const SHORTS_STUDIO_KEY = "special:shorts_studio";
export const CLICK_TO_AD_KEY = "special:click_to_ad";
export const CLIPCUT_KEY = "special:clipcut";
export const URBAN_CUTS_KEY = "special:urban_cuts";

export const CLIPCUT_MODEL_LINE =
  "LTX-Video + ACE-Step + in-browser beat detection";

export const PIPELINE_MODEL_LINE =
  "Qwen3-VL 8B + LTX-Video + Kokoro + ACE-Step";

/** Click to Ad renders every clip with LTX-2.5 i2v + sound (adLtx.ts). */
export const AD_MODEL_LINE = "Qwen3-VL 8B + LTX-2.5 + Kokoro + ACE-Step";

export function pipelineCards(ctx: EngineContext): HubCard[] {
  const packsKnown = !!ctx.packIds;
  const hasPacks = packsKnown && ctx.packIds!.size > 0;
  const edit = enginesAvailability(SINGLE_ENGINES, ctx);
  // Click to Ad needs the LTX-2.5 pack too (every clip is LTX-2.5 i2v).
  const noLtx = packsKnown && !ctx.packIds!.has(LTX25_PACK_ID);
  const ad = noLtx
    ? {
        available: false,
        checking: false,
        reason: "The ltx25 (LTX-2.5) pack isn't installed on this server.",
      }
    : edit;
  const firstEdit = preferredEngine(
    SINGLE_ENGINES.map((id) => EDIT_ENGINES[id]).filter(
      (e) => enginesAvailability([e.id], ctx).available,
    ),
  );
  return [
    {
      key: SHORTS_STUDIO_KEY,
      kind: "special",
      id: "shorts_studio",
      title: "Shorts Studio",
      subtitle:
        "Topic in, captioned vertical short out: script, scenes, motion, voice and music",
      icon: "Film",
      hubCategory: "Video",
      available: hasPacks,
      unavailableReason:
        packsKnown && !hasPacks ? "No text-to-image pack is installed." : null,
      licenseNote: null,
      checking: !packsKnown,
      model: PIPELINE_MODEL_LINE,
      nc: false,
      aliases: [
        "faceless",
        "shorts",
        "content factory",
        "explainer",
        "reels",
        "tiktok",
        "pipeline",
        "script",
      ],
    },
    {
      key: CLICK_TO_AD_KEY,
      kind: "special",
      id: "click_to_ad",
      title: "Click to Ad",
      subtitle:
        "Product photo in, vertical LTX-2.5 video ad with sound out, hook to end card",
      icon: "Clapperboard",
      hubCategory: "Video",
      available: ad.available,
      unavailableReason: ad.reason,
      licenseNote: null,
      checking: ad.checking,
      model: firstEdit ? `${firstEdit.model} + ${AD_MODEL_LINE}` : AD_MODEL_LINE,
      nc: firstEdit?.license === "nc",
      aliases: [
        "ad",
        "ltx",
        "ltx-2.5",
        "ugc",
        "marketing",
        "product video",
        "commercial",
        "pipeline",
      ],
    },
    {
      key: CLIPCUT_KEY,
      kind: "special",
      id: "clipcut",
      title: "ClipCut",
      subtitle:
        "One photo, several outfits, a reel that cuts between the looks on the beat",
      icon: "Scissors",
      hubCategory: "Video",
      available: edit.available,
      unavailableReason: edit.reason,
      licenseNote: null,
      checking: edit.checking,
      model: firstEdit
        ? `${firstEdit.model} + ${CLIPCUT_MODEL_LINE}`
        : CLIPCUT_MODEL_LINE,
      nc: firstEdit?.license === "nc",
      aliases: [
        "beat sync",
        "outfit reel",
        "look reel",
        "fashion reel",
        "outfit change",
        "transition",
        "music video",
        "pipeline",
      ],
    },
    {
      key: URBAN_CUTS_KEY,
      kind: "special",
      id: "urban_cuts",
      title: "Urban Cuts",
      subtitle:
        "Street-style looks across city spots, cut to a hip hop beat or your own track",
      icon: "Shirt",
      hubCategory: "Video",
      available: edit.available,
      unavailableReason: edit.reason,
      licenseNote: null,
      checking: edit.checking,
      model: firstEdit
        ? `${firstEdit.model} + ${CLIPCUT_MODEL_LINE}`
        : CLIPCUT_MODEL_LINE,
      nc: firstEdit?.license === "nc",
      aliases: [
        "street style",
        "streetwear",
        "beat sync",
        "outfit reel",
        "city",
        "pipeline",
      ],
    },
  ];
}

export const DUB_VIDEO_KEY = "special:dub_video";
export const DUB_VIDEO_MODEL_LINE =
  "Whisper large-v3-turbo + Qwen3-VL 8B + Chatterbox multilingual or VibeVoice-1.5B + InfiniteTalk";

/**
 * Video Translator (Dub video): needs the audio pack (Whisper + VibeVoice /
 * Chatterbox on the video host). Lipsync mode also needs wan-animate; the
 * runner checks that per mode.
 */
export function dubVideoCard(ctx: EngineContext): HubCard {
  const packsKnown = !!ctx.packIds;
  const hasAudio = packsKnown && ctx.packIds!.has("audio");
  return {
    key: DUB_VIDEO_KEY,
    kind: "special",
    id: "dub_video",
    title: toolTitle(DUB_VIDEO_KEY, "Dub Video"),
    subtitle:
      "Translate what someone says into another language, in their own voice, with matching lips",
    icon: "Languages",
    hubCategory: "Audio",
    available: hasAudio,
    unavailableReason:
      packsKnown && !hasAudio ? "The audio pack is not installed." : null,
    licenseNote: null,
    checking: !packsKnown,
    model: DUB_VIDEO_MODEL_LINE,
    nc: false,
    aliases: [
      ...toolAliases(DUB_VIDEO_KEY),
      "dub",
      "voice translation",
      "localization",
      "foreign language",
      "pipeline",
    ],
  };
}

export const VOICE_CHANGER_KEY = "special:voice_changer";
export const VOICE_CHANGER_MODEL_LINE = "Chatterbox VC (Resemble AI) · MIT";

/** Voice changer: needs the audio pack (Chatterbox runs on the video host). */
export function voiceChangerCard(ctx: EngineContext): HubCard {
  const packsKnown = !!ctx.packIds;
  const hasAudio = packsKnown && ctx.packIds!.has("audio");
  return {
    key: VOICE_CHANGER_KEY,
    kind: "special",
    id: "voice_changer",
    title: "Voice Changer",
    subtitle:
      "Make a recording or a clip sound like another voice, keeping every word and pause",
    icon: "AudioWaveform",
    hubCategory: "Audio",
    available: hasAudio,
    unavailableReason:
      packsKnown && !hasAudio ? "The audio pack is not installed." : null,
    licenseNote: null,
    checking: !packsKnown,
    model: VOICE_CHANGER_MODEL_LINE,
    nc: false,
    aliases: [
      "voice changer",
      "change voice",
      "voice conversion",
      "speech to speech",
      "voice swap",
      "revoice",
      "voice clone",
    ],
  };
}
export const OVERLAY_COMPOSITE_KEY = "special:overlay_composite";
export const OVERLAY_COMPOSITE_MODEL_LINE =
  "No model (stock compositing nodes); looks: default Imagine pack + Qwen-Image 2.1 cut-out";

/**
 * Overlay Composite: the compositing itself needs no model (core nodes and
 * VideoHelperSuite), so the card is always available; the illustrated looks
 * also need qwen-image-21 for the cut-out (overlayLooksAvailable).
 */
export function overlayCompositeCard(): HubCard {
  return {
    key: OVERLAY_COMPOSITE_KEY,
    kind: "special",
    id: "overlay_composite",
    title: "Overlay Composite",
    subtitle:
      "Stickers, cut-outs and animated layers over a clip, with blend and timing",
    icon: "Layers",
    hubCategory: "Video",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: OVERLAY_COMPOSITE_MODEL_LINE,
    nc: false,
    aliases: [
      "mixed media",
      "overlay",
      "overlays",
      "sticker",
      "stickers",
      "doodle",
      "composite",
      "layers",
      "logo overlay",
      "png over video",
    ],
  };
}

/** Looks need a text-to-image pack plus the Qwen-Image 2.1 cut-out tool. */
export function overlayLooksAvailable(ctx: EngineContext): {
  available: boolean;
  reason: string | null;
} {
  if (!ctx.packIds) return { available: true, reason: null };
  if (!ctx.packIds.has("qwen-image-21"))
    return {
      available: false,
      reason: "Looks need the Qwen-Image 2.1 pack for the cut-out.",
    };
  return { available: true, reason: null };
}

export const BOARD_KEY = "special:board";

/** Tools > Board: lanes of chained tool steps (src/lib/tools/board.ts). */
export function boardCard(): HubCard {
  return {
    key: BOARD_KEY,
    kind: "special",
    id: "board",
    title: "Board",
    subtitle:
      "Chain tools into lanes: edit, upscale, animate and add sound, each feeding the next",
    icon: "LayoutGrid",
    hubCategory: "Video",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: "Chains the installed tools",
    nc: false,
    aliases: [
      "canvas",
      "chain",
      "workflow",
      "node",
      "nodes",
      "pipeline",
      "lanes",
    ],
  };
}
