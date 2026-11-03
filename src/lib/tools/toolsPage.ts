/**
 * Tools tab logic (web / desktop)
 * Pure, client-safe helpers behind the Tools page. Mirrors the iOS Tools tab
 * (cj-ios/CJ/Models/Tools.swift) for the action-based cards and adds every
 * catalog tool served by GET /api/tools (POST /api/jobs/tool).
 *
 * No React, no fetch, no fs: everything here is unit-tested without a server.
 * Submission lives in ./runTool.ts, UI in src/components/tools/.
 */

import {
  SMART_TRACK_ACTIONS,
  hasSmartTrack,
  parseSmartTrack,
  type SmartTrackOccurrence,
} from "./smartTrack";
import { ASMR_SOUNDS, composeAsmrPrompt } from "./asmrPresets";
import {
  VIDEO_PALETTE_DEFAULT_STRENGTH,
  VIDEO_PALETTE_PRESETS,
  VIDEO_PALETTE_SKIN_PROTECT,
  formatHexPalette,
  parseHexPalette,
  strengthFraction,
  videoPalettePreset,
} from "./videoPalette";
import { AVATAR_GESTURES, composeAvatarScene } from "./avatarPresets";
import {
  EDIT_MODES,
  renderEditPrompt,
  type EditModeId,
} from "@/lib/krea2/editModes";
import { editActionFor } from "@/lib/krea2/editLoras";
import {
  WAN_CAMERA_POSES,
  WAN_CAMERA_SPEEDS,
  WAN_AUTO_LENGTH,
  WAN_EFFECT_SECTIONS,
  WAN_LENGTHS,
  WAN_MODES,
  WAN_MOTION_PRESETS,
  WAN_RESOLUTIONS,
} from "@/lib/oj/wanMotionPresets";
import {
  LTX_EFFECT_PRESET_IDS,
  WAN_MOTION_ENGINE_DEFAULT,
  resolveWanMotionEngine,
  wanMotionLtxRequest,
} from "@/lib/oj/wanMotionLtx";
import {
  VACE_LIGHT_OPTIONS,
  VACE_LOOK_GROUPS,
  VACE_LOOK_PRESETS,
  VACE_PRESET_NONE,
} from "@/lib/oj/vacePresets";
import { WAN_MOVE_REGIONS, WAN_MOVE_TRAJECTORIES } from "@/lib/oj/wanMove";
import {
  RACK_FOCUS_MAX_FRAMES,
  REFOCUS_DEFAULT_BLUR,
  REFOCUS_DEFAULT_HIGHLIGHTS,
  focusPoint,
  type FocusPoint,
} from "@/lib/oj/refocus";
import { SDR_TO_HDR_DEFAULT_PEAK } from "@/lib/oj/sdrToHdr";
import {
  VIDEO_EXPAND_DEFAULT_MODE,
  VIDEO_EXPAND_MAX_EDGE,
  VIDEO_EXPAND_DEFAULT_ENGINE,
  VIDEO_EXPAND_ENGINES,
  VIDEO_EXPAND_LTX_DEFAULT_EDGE,
  VIDEO_EXPAND_LTX_MAX_FRAMES,
  VIDEO_EXPAND_LTX_WINDOW_SECONDS,
  videoExpandModeIssue,
  VIDEO_EXPAND_VACE_MAX_FRAMES,
  VIDEO_EXPAND_MODES,
} from "@/lib/oj/videoExpand";
import {
  VIDEO_RETAKE_AUDIO_MODES,
  VIDEO_RETAKE_DEFAULT_AUDIO,
  VIDEO_RETAKE_DEFAULT_EDGE,
  VIDEO_RETAKE_MAX_FRAMES,
  VIDEO_RETAKE_MIN_STRENGTH,
  VIDEO_RETAKE_WINDOW_SECONDS,
} from "@/lib/oj/videoRetake";
import { SA3_TOOL_SPECS, buildSa3Request, type Sa3ToolId } from "./sa3Tools";
import {
  CLEANUP_MODELS,
  CREATIVITY_DEFAULT,
  REDETAIL_DEFAULT,
  REDETAIL_DEFAULT_SIZE,
  REDETAIL_MAX,
  REDETAIL_MIN,
  REDETAIL_SIZES,
  UPSCALE_MODEL_PARAM,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_SIZES,
  VIDEO_UPSCALE_ACTION,
  upscaleRequestParams,
} from "@/lib/upscale/upscaleModels";
import {
  CAMERA_PRESETS,
  CAMERA_TRAINED_COUNT,
  H3_FLEX_SUBTLE_STRENGTH,
  ORBIT_PRESETS,
  TRANSITION_STYLES,
} from "@/lib/oj/h3Video";
import { REF_VIDEO_SCENES, refVideoSize } from "@/lib/oj/h3RefVideo";
import {
  CHAR_SHEET_DEFAULT_RENDER,
  CHAR_SHEET_DEFAULT_ROLE,
  CHAR_SHEET_DEFAULT_SIZE,
  CHAR_SHEET_DEFAULT_VIEWS,
  CHAR_SHEET_RENDERS,
  CHAR_SHEET_REF_ROLES,
  CHAR_SHEET_SIZES,
  parseCharSheetViews,
} from "@/lib/oj/h3CharSheet";
import {
  H3_FPS,
  H3_LONG_CONTEXT_OVERLAP,
  H3_LONG_DEFAULT_SECONDS,
  H3_LONG_MAX_SECONDS,
  H3_LONG_METHOD_TRADEOFF,
  H3_LONG_MIN_SECONDS,
  H3_LONG_SEQUENTIAL_OVERLAP,
  H3_LONG_WINDOW_FRAMES,
  H3_LONG_WINDOW_MAX,
  H3_LONG_WINDOW_MIN,
  h3FixFacesCount,
  h3LongPlanHint,
  h3LongWindowHint,
  planH3LongClip,
} from "@/lib/oj/h3LongClip";
import {
  parseWanMoveDraw,
  type WanMoveDraw,
} from "@/lib/oj/wanMoveDraw";
import {
  VOICEOVER_KOKORO_VOICES,
  VOICEOVER_STOCK_VOICES,
} from "@/lib/oj/voiceoverVoices";
import { VACE_EXTEND_MAX_SOURCE, VACE_FPS, VACE_MAX_LENGTH } from "@/lib/oj/vaceVideo";
import { LTX_VFX_SPECS } from "@/lib/oj/ltxVfx";
import {
  SHARPEN_DEFAULT,
  SHARPEN_MAX,
  SHARPEN_MIN,
  STRENGTH_DEFAULT,
  STRENGTH_MAX,
  STRENGTH_MIN,
  UPSCALE_SHARPEN_PARAM,
  UPSCALE_STRENGTH_PARAM,
  upscaleFinishParams,
} from "@/lib/upscale/upscaleFinish";
import {
  LTX_RESTORE_ACTION,
  LTX_RESTORE_FPS,
  LTX_RESTORE_MAX_FRAMES,
} from "@/lib/oj/ltxRestore";
import {
  LTX_RESHOOT_DISTANCES,
  LTX_RESHOOT_DEFAULTS,
  LTX_RESHOOT_FPS,
  LTX_RESHOOT_HEIGHTS,
  LTX_RESHOOT_MAX_FRAMES,
  LTX_RESHOOT_ORBITS,
  type ReshootChoice,
} from "@/lib/oj/ltxReshoot";
import { ltxExtraLoraParams } from "@/lib/oj/ltxCommunityLoras";
import { PERSON_REMOVE_MAX_FRAMES } from "@/lib/oj/personRemove";
import {
  BG_SWAP_SETTINGS,
  CAST_SWAP_MAX_PEOPLE,
  H3_MASKED_EDIT_FPS,
  FINISH_DEFAULT_STRENGTH,
  FINISH_STRENGTH_RANGE,
  H3_MASKED_EDIT_SECONDS,
  MOTION_GUIDE_POSE_DEFAULT_STRENGTH,
  OBJECT_ADD_DEFAULT_POSITION,
  OBJECT_ADD_DEFAULT_SIZE,
  OBJECT_ADD_POSITIONS,
  OBJECT_ADD_SIZES,
} from "@/lib/oj/h3MaskedEdit";
import { VIDEO_REMOVE_LENGTH } from "@/lib/oj/videoObjectRemove";
import {
  CHARACTER_SWAP_FPS,
  CHARACTER_SWAP_MAX_LENGTH,
} from "@/lib/oj/characterSwap";
import { WAN_ANIMATE_MAX_FRAMES } from "@/lib/oj/wanAnimate";
import { LIPSYNC_FPS, LIPSYNC_MAX_FRAMES } from "@/lib/oj/lipsync";
import { VIDEO_BG_CHANGE_MAX_SECONDS } from "@/lib/oj/videoBgChange";
import { ADD_SOUND_MAX_SECONDS } from "@/lib/oj/voiceSound";
import { BODY_3D_MAX_SECONDS } from "@/lib/oj/body3d";
import type { EditLora } from "@/types";
import { badgeLinks, sourceFor, type BadgeSource } from "./licenseBadges";

// Catalog tool (GET /api/tools) – client-side mirror of toPublicTool()

export interface CatalogOptionValue {
  id: string;
  label: string;
  text: string;
}

export interface CatalogEnumOption {
  id: string;
  label: string;
  type: "enum";
  default: string;
  values: CatalogOptionValue[];
}

export interface CatalogOutpaintPreset {
  id: string;
  label: string;
  sides?: { left?: number; right?: number; top?: number; bottom?: number };
  aspect?: string;
  anchor?: OutpaintAnchor;
}

export type OutpaintAnchor = "center" | "left" | "right" | "top" | "bottom";

export interface CatalogToolLicense {
  name: string;
  /**
   * true = commercial OK, false = non-commercial, null = conditional: see
   * `badge` (missing = "check").
   */
  commercial: boolean | null;
  note: string;
  badge?: "cap" | "check";
  /** Where the license was read (model card / LICENSE file). */
  source?: string;
}

export interface CatalogTool {
  id: string;
  label: string;
  category: string;
  base: string;
  baseLabel: string;
  description: string;
  loras: { file: string; strength: number }[];
  extras: {
    keepFraming: {
      label: string;
      description: string;
      default: boolean;
      available: boolean;
    } | null;
  };
  speed:
    | { supported: false }
    | {
        supported: true;
        default: boolean;
        available: boolean;
        steps: number;
        cfg: number;
        /** Speed LoRA name for the toggle hint (older servers omit it). */
        label?: string;
      };
  defaults: { steps: number; cfg: number };
  refCount: number;
  refLabels: string[];
  needsMask: boolean;
  /** Short hint shown above the mask painter (needsMask tools). */
  maskHint?: string | null;
  outpaint: {
    default: string;
    fill: string;
    maxSide: number;
    presets: CatalogOutpaintPreset[];
  } | null;
  promptMode: "none" | "optional" | "required";
  promptTemplate: string;
  promptHint: string;
  options: CatalogEnumOption[];
  requiresNodes: string | null;
  license: CatalogToolLicense;
  sourceUrl: string;
  installed: boolean;
  packAvailable: boolean;
  /** Node classes ComfyUI lacks for this tool's graph (older servers omit it). */
  missingNodes?: string[];
  available: boolean;
}

// Action tools (POST /api/jobs/action) – the iOS cards the web already supports

export type ActionToolId =
  | "edit_photo"
  | "edit_qwen21"
  | "edit_flux3"
  | "edit_fibo"
  | "remove_object"
  | "restyle_locked"
  | "replace_person"
  | "pose_character"
  | "bg_remove"
  | "upscale"
  | "enhance_faces"
  | "animate"
  | "make_3d"
  | "make_3d_trellis"
  | "image_to_splat"
  | "body_3d"
  | "body_3d_video"
  | "music"
  | "sfx"
  | Sa3ToolId
  | "face_swap"
  | "orbit_360"
  | "camera_move"
  | "person_remove"
  | "video_object_remove"
  | "video_remove_text"
  | "video_object_swap"
  | "cast_swap"
  | "video_bg_swap"
  | "video_object_add"
  | "video_bg_change"
  | "video_palette"
  | "crossview"
  | "describe"
  | "character_swap"
  | "character_swap_full"
  | "wan_animate"
  | "lipsync"
  | "video_lipsync"
  | "talking_avatar"
  | "transition"
  | "ref_video"
  | "multiframe_ref"
  | "h3_charsheet"
  | "ltx25_animate"
  | "ltx25_transition"
  | "video_bg_remove"
  | "upscale_seedvr2"
  | "upscale_vosr2"
  | "upscale_video"
  | "flashvsr_upscale"
  | "rtx_upscale"
  | "subject_matte"
  | "ltx_upscale_x2"
  | "interpolate"
  | "relight"
  | "light_migration"
  | "wan_motion"
  | "wan_camera"
  | "wan_move"
  | "vace_restyle"
  | "vace_reframe"
  | "video_expand"
  | "video_retake"
  | "vace_extend"
  | "shots"
  | "zooms"
  | "layers"
  | "vectorize"
  | "breakdown"
  | "see_through"
  | "refocus"
  | "rack_focus"
  | "moge_geometry"
  | "material_maps"
  | "sdr_to_hdr"
  | "video_edit"
  | "voiceover"
  | "add_sound"
  | "ltx_alpha_matte"
  | "ltx_clean_plate"
  | "ltx_day_to_night"
  | "ltx_add_water"
  | "ltx_cinemagraph"
  | "ltx_slow_motion"
  | "ltx_ripple"
  | "ltx_edge_control"
  | "ltx_blockout_render"
  | "ltx_sdr_to_hdr"
  | "ltx_layout_render"
  | "ltx_ingredients"
  | "ltx_reshoot"
  | "ltx_restore"
  | "ltx_exploded_view"
  | "ltx_paint_fluid";

/**
 * GET /api/tools/model-status `options` key for character_swap's mannequin
 * mode (its own graph, action character_swap_masked).
 */
export const CHARACTER_SWAP_MASKED_OPTION = "characterSwapMasked";

export interface ActionChoice {
  id: string;
  label: string;
  /** Dropdown section (<optgroup>); consecutive options share one. */
  group?: string;
  /**
   * The option runs through another action tool's pack and models (e.g. the
   * LTX-2.5 engine of Motion presets); while that tool is unavailable the
   * option blocks Run with its reason (ToolCard.optionBlocks).
   */
  requiresTool?: ActionToolId;
  /**
   * The option loads weights the card's default graph does not (SeedVR2 7B):
   * `key` names a GET /api/tools/model-status `options` entry; while its
   * files are missing the option blocks Run ("Needs <model> model").
   */
  requiresOption?: { key: string; model: string };
  /** Shown but not selectable (set at render time, e.g. by optionIssue). */
  disabled?: boolean;
  /** Tooltip; defaults to the label. */
  hint?: string;
}

/** Runs of consecutive options sharing a `group` (ungrouped runs get ""). */
export function groupOptions<T extends ActionChoice>(
  options: T[],
): { group: string; options: T[] }[] {
  const out: { group: string; options: T[] }[] = [];
  for (const o of options) {
    const g = o.group ?? "";
    const last = out[out.length - 1];
    if (last && last.group === g) last.options.push(o);
    else out.push({ group: g, options: [o] });
  }
  return out;
}

/** Show a picker / input only while another picker has `value` (or one of `oneOf`). */
export interface PickCondition {
  key: string;
  value?: string;
  oneOf?: string[];
}

export interface ActionPicker {
  key: string;
  title: string;
  /** First option is the default unless `defaultId` names another. */
  options: ActionChoice[];
  /**
   * Default option id when it is not the first one, so numeric choices
   * (length, tempo) can read in order while the default stays mid-range.
   */
  defaultId?: string;
  /** Render as a dropdown (long lists) instead of segmented buttons. */
  dropdown?: boolean;
  /** Only shown (and sent) while this other pick is active. */
  showWhen?: PickCondition;
  /** One-line help under the options. */
  hint?: string;
  /**
   * Option ids are plain params, not backend actions (even when an id
   * happens to match one, e.g. "pan_left"): docs / model maps skip them.
   */
  paramOnly?: boolean;
  /**
   * Why an option can't run on the picked source video (null = fine): the
   * option is disabled with this tooltip, and a current pick that has an
   * issue blocks Run with it (before anything is uploaded).
   */
  optionIssue?: (
    id: string,
    video: { width: number; height: number },
  ) => string | null;
}

export interface ActionTextKnob {
  label: string;
  placeholder: string;
  required: boolean;
  /** One-line help under the field. */
  hint?: string;
  /** Single-line input instead of the multi-line mono textarea. */
  compact?: boolean;
  /** Only shown (and sent) while this pick is active. */
  showWhen?: PickCondition;
}

/** Range knob; the value lives in ToolSettings.picks[key] as a number string. */
export interface ActionSlider {
  key: string;
  title: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Suffix after the value ("%"). */
  unit?: string;
  /** Only shown (and sent) while this other pick is active. */
  showWhen?: PickCondition;
  /** Rendered in the card's collapsed "Advanced" section. */
  advanced?: boolean;
  /** Help line under the slider. */
  hint?: string;
  /** Live help line from the current value (wins over `hint`). */
  hintFor?: (value: number, settings: ToolSettings) => string;
}

export type VideoToolWindow =
  | { maxFrames: number; fps?: number }
  | { seconds: number };

/** Seconds of a clip at `sourceFps` that a windowed tool processes. */
export function videoWindowSeconds(
  w: VideoToolWindow | undefined,
  sourceFps: number,
): number | null {
  if (!w) return null;
  if ("seconds" in w) return w.seconds;
  const fps = w.fps ?? (sourceFps > 0 ? sourceFps : 24);
  return Math.floor((w.maxFrames / fps) * 1000) / 1000;
}

export interface ActionToolSpec {
  id: ActionToolId;
  title: string;
  subtitle: string;
  category: string;
  /** Lucide icon name; the page maps it to a component. */
  icon: string;
  /** Workflow pack that must be installed (GET /api/oj/packs). */
  requiredPack?: string;
  text?: ActionTextKnob;
  pickers?: ActionPicker[];
  /** Range knobs rendered after the pickers (e.g. grade strength). */
  sliders?: ActionSlider[];
  /** Runs through the krea2-edit pack and needs an installed edit LoRA. */
  usesEditLora?: boolean;
  /** The user picks the edit-LoRA family (Edit photo). */
  picksEditFamily?: boolean;
  /** Label of the first image picker (default "Photo"). */
  firstImage?: string;
  /** Label of a second reference picker (Replace person). */
  secondImage?: string;
  /** The `secondImage` reference may be left empty (video tools, ref_video). */
  secondImageOptional?: boolean;
  /**
   * Labels of further optional reference photos after `secondImage`
   * (cast_swap / ref_video: references 2..3), sent as params.extraRefImages.
   */
  extraImages?: string[];
  /**
   * Smart select per reference photo (cast_swap): the clip picker edits the
   * clicks of one person at a time → ToolSettings.smartTrackSubjects[k].
   */
  smartTrackPerRef?: boolean;
  /** Not an /api/jobs/action tool (Describe → /api/describe). */
  special?: "describe";
  /**
   * Video-in tool: the primary input is a source clip (label), seeded through
   * /api/jobs/seed-run; `secondImage` is then the single reference photo.
   */
  videoInput?: string;
  /**
   * Video-in tools that only process the start of the clip: at most
   * `maxFrames` frames sampled at `fps` (unset = the clip's own rate), or the
   * first `seconds`. Unset = the whole clip. The video editor uses it to
   * send (and later replace) only the part the tool actually renders.
   */
  videoWindow?: VideoToolWindow;
  /**
   * Audio-in tool: label of a speech/audio picker (wav/mp3/m4a/flac). The file
   * is uploaded to ComfyUI input and sent as params.audioRef (+ audio_seconds).
   */
  audioInput?: string;
  /** Help line under the audio picker. */
  audioNote?: string;
  /** The audio picker is shown and required only while this pick is active. */
  audioWhen?: PickCondition;
  /** Lightbox audio items open this tool with the item as its audio input. */
  audioHandoff?: boolean;
  /** Help line under the clip picker (default: the H3 24 fps note). */
  videoNote?: string;
  /**
   * Pack workflow whose loader weights must exist on disk
   * (GET /api/tools/model-status); missing files disable the tool.
   */
  modelCheck?: { pack: string; action: string };
  /**
   * This repo's custom node pack (comfy_nodes/<id>) that the modelCheck
   * graph needs. When model-status reports any of `nodes` missing
   * ("node:<Class>"), the card reads "The <id> pack isn't installed ..."
   * instead of a generic missing-model line. The pack's workflow dir
   * (image-tools, utility, ...) ships with the app; these nodes don't.
   * `install` replaces the "Copy comfy_nodes/<id>" fix for third-party packs.
   */
  nodePack?: { id: string; nodes: string[]; install?: string };
  /**
   * Custom ComfyUI nodes this tool needs that are not part of this app's
   * install. The card is listed but disabled with this text; nothing runs.
   */
  requiresNodes?: string;
  /**
   * Not offered anywhere (Tools grid, lightbox, editor): retired or stub
   * tools kept only so old runs, slots and links still resolve.
   */
  hidden?: boolean;
  /**
   * The backend registers this action separately: no entry for it in
   * /api/tools/model-status means the pack/workflow isn't wired on this
   * server yet, so the card stays disabled (never enabled-but-broken).
   */
  requireStatusEntry?: boolean;
  /**
   * The pack writes its own master files (adrift_master/), so the runner
   * hides the opt-in master-format picker.
   */
  ownMaster?: boolean;
  /** Show a Seed field (blank = random); sent as params.seed. */
  seedInput?: boolean;
  /**
   * Text-in tool (music, sfx): no source image or clip. The client seeds an
   * empty text run (POST /api/jobs/seed-run { text_only }) and queues the
   * action on it.
   */
  noSourceInput?: boolean;
  /** Optional second text field (music lyrics) → ToolSettings.secondText. */
  secondText?: ActionTextKnob;
  /** Third-party idea/code credit, listed in docs/TOOLS.md. */
  credit?: string;
}

/** Re-shoot camera pickers: the default choice first (pickers default to [0]). */
function reshootPicker(
  key: string,
  title: string,
  list: ReshootChoice[],
  def: string,
): ActionPicker {
  const first = list.filter((c) => c.id === def);
  const rest = list.filter((c) => c.id !== def);
  return {
    key,
    title,
    paramOnly: true,
    options: [...first, ...rest].map(({ id, label }) => ({ id, label })),
  };
}

/** Refocus / Rack focus: depth of field + depth model. */
const refocusPickers: ActionPicker[] = [
  {
    key: "depthOfField",
    title: "In-focus depth",
    options: [
      { id: "normal", label: "Normal" },
      { id: "shallow", label: "Razor thin" },
      { id: "deep", label: "Deep" },
    ],
    paramOnly: true,
  },
  {
    key: "depthModel",
    title: "Depth",
    options: [
      { id: "quality", label: "DA3 Mono Large" },
      { id: "fast", label: "DA3 Base (fast)" },
    ],
    paramOnly: true,
  },
];

const refocusSliders: ActionSlider[] = [
  {
    key: "blur",
    title: "Aperture (blur)",
    min: 0,
    max: 100,
    step: 1,
    default: REFOCUS_DEFAULT_BLUR,
    hint: "Higher = shallower depth of field, bigger bokeh.",
  },
  {
    key: "highlights",
    title: "Bokeh highlights",
    min: 0,
    max: 100,
    step: 5,
    default: REFOCUS_DEFAULT_HIGHLIGHTS,
    unit: "%",
    advanced: true,
    hint: "Bright out-of-focus points bloom into discs.",
  },
];

/** Wan2.2 VACE tools: balanced = hybrid 8-step sampling, fast = 4-step LoRA. */
/** Follow subject (follow-cam crop + paste-back) on the H3 masked swaps. */
const followSubjectPicker: ActionPicker = {
  key: "followSubject",
  title: "Follow subject",
  paramOnly: true,
  options: [
    {
      id: "auto",
      label: "Auto",
      hint: "Zooms in on the person when they are small in the frame, then pastes the result back",
    },
    {
      id: "on",
      label: "On",
      hint: "Always runs the swap on a smooth crop around each person (more face detail in wide shots)",
    },
    { id: "off", label: "Off", hint: "Swap on the whole frame" },
  ],
};

const vaceSpeedPicker: ActionPicker = {
  key: "speed",
  title: "Speed",
  options: [
    { id: "balanced", label: "Best" },
    { id: "fast", label: "Fast" },
  ],
};

/** Restyle video: "Mixed Media" look presets (first = prompt only). */
const vaceLookPicker: ActionPicker = {
  key: "look",
  title: "Look",
  options: [
    { id: VACE_PRESET_NONE, label: "None (prompt only)" },
    ...VACE_LOOK_GROUPS.flatMap((g) =>
      VACE_LOOK_PRESETS.filter((p) => p.group === g).map(({ id, label }) => ({
        id,
        label,
        group: g,
      })),
    ),
  ],
  dropdown: true,
};

/** Restyle video: "Video Relight" light presets (first = keep the light). */
const vaceLightPicker: ActionPicker = {
  key: "light",
  title: "Relight",
  options: [
    { id: VACE_PRESET_NONE, label: "Keep lighting" },
    ...VACE_LIGHT_OPTIONS,
  ],
};

/** Fix text when the NVIDIA RTX engine's nodes are missing. */
export const RTX_NODES_INSTALL =
  "Install it from https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI and run `pip install nvidia-vfx --extra-index-url https://pypi.nvidia.com` in the ComfyUI venv (needs an RTX GPU and driver 580.82 or newer), then restart ComfyUI.";

export const MATANYONE_NODES_INSTALL =
  "Install it from https://github.com/FuouM/ComfyUI-MatAnyone and put matanyone2.pth from https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth in its checkpoint folder. The weights are non-commercial (S-Lab License 1.0).";

export const GROUNDED_FAMILY = "krea2edit";
export const KREA2_EDIT_PACK = "krea2-edit";
/** Krea 2 edit action behind the Pose character card (packs/krea2-edit/pose_character.json). */
export const POSE_CHARACTER_ACTION = "edit_pose";

const speedPicker = (quality: string, fast: string): ActionPicker => ({
  key: "speed",
  title: "Speed",
  options: [
    { id: quality, label: "Best" },
    { id: fast, label: "Fast" },
  ],
});

/** FIBO 2.0 edit: Turbo = Edit Turbo (4 steps), Quality = Dev (30 steps). */
const fiboSpeedPicker: ActionPicker = {
  key: "speed",
  title: "Speed",
  options: [
    { id: "edit_fibo", label: "Turbo" },
    { id: "edit_fibo_dev", label: "Quality" },
  ],
};

/**
 * Full-res paste-back (CJImagePasteBack): keep the original's pixels and
 * resolution outside the edit. Default on (first option).
 */
const pasteBackPicker: ActionPicker = {
  key: "pasteBack",
  title: "Keep original outside the edit",
  options: [
    { id: "on", label: "On" },
    { id: "off", label: "Off" },
  ],
};

/** Pose change: take the whole person from the edit (face stays original). */
const pastePosePicker: ActionPicker = {
  key: "pasteBackPose",
  title: "Pose change",
  options: [
    { id: "off", label: "Off" },
    { id: "on", label: "On" },
  ],
  showWhen: { key: "pasteBack", value: "on" },
};

/** "Area to change" (SAM3 text for the paste-back region). */
const pasteAreaText = (hint: string): ActionTextKnob => ({
  label: "Area to change",
  placeholder: "the jacket",
  required: false,
  compact: true,
  hint,
});

/** On/off toggle picker for an optional extra LoRA (value "on" enables it). */
const loraTogglePicker = (key: string, title: string): ActionPicker => ({
  key,
  title,
  options: [
    { id: "off", label: "Off" },
    { id: "on", label: "On" },
  ],
});

/** H3 Turbo speed (lightx2v step-distilled LoRA; ids = h3Speed values). */
const h3SpeedPicker: ActionPicker = {
  key: "h3Speed",
  title: "Speed",
  options: [
    { id: "off", label: "Off" },
    { id: "turbo8", label: "Turbo (8 steps)" },
    { id: "turbo4", label: "Turbo (4 steps)" },
  ],
};

/**
 * H3 Quality vs FastH3 (FastVideo's distilled DiT, 8 steps; ids = h3Speed
 * values). For FL2VA graphs without graph LoRAs (transition); the LoRA tools
 * keep the Turbo picker since their LoRAs are trained on base H3.
 */
export const h3QualityPicker: ActionPicker = {
  key: "h3Speed",
  title: "Speed",
  options: [
    { id: "off", label: "Quality" },
    { id: "fast8", label: "Fast (8 steps)" },
  ],
};

/**
 * Pika H3 Flex: opt-in fine-tune LoRA, FL2VA or Ref2VA file picked from the
 * graph (lib/oj/h3Video.ts). Off by default.
 */
export const h3FlexPicker: ActionPicker = {
  key: "h3Flex",
  title: "Pika Flex",
  paramOnly: true,
  options: [
    { id: "off", label: "Off" },
    { id: "on", label: "On", hint: "Pika's H3 fine-tune at full strength" },
    {
      id: "subtle",
      label: "Subtle",
      hint: `Strength ${H3_FLEX_SUBTLE_STRENGTH}`,
    },
  ],
  hint: "Mellis (Pika) fine-tune of MiniMax H3, under the MiniMax H3 Community License.",
};

/** Clip length for the LTX-2.5 tools (24 fps, snapped to 8n+1 frames). */
export const ltx25DurationPicker: ActionPicker = {
  key: "duration",
  title: "Length",
  options: [
    { id: "5", label: "5 s" },
    { id: "8", label: "8 s" },
    { id: "10", label: "10 s" },
  ],
};

/** Optional H3 LoRA toggles shared by the H3 image-to-video tools. */
export const H3_TOGGLE_PICKERS: ActionPicker[] = [
  loraTogglePicker("motionRepair", "Motion repair"),
  loraTogglePicker("handheld", "Handheld shake"),
  h3FlexPicker,
  h3SpeedPicker,
];

/** Camera-move presets (from CAMERA_PRESETS in lib/oj/h3Video.ts), trained moves first. */
const CAMERA_MOVE_OPTIONS: ActionChoice[] = CAMERA_PRESETS.map(
  ({ id, label }, i) => ({
    id,
    label,
    group: i < CAMERA_TRAINED_COUNT ? "Trained moves" : "Prompt-steered",
  }),
);

/**
 * Wan motion presets: camera moves first, then effects by hub section
 * (Viral / UGC / Commercial), then "None"; each block is a dropdown group.
 */
const WAN_MOTION_OPTIONS: ActionChoice[] = [
  ...WAN_MOTION_PRESETS.filter(
    (p) => p.category === "camera" && !p.group,
  ).map((p) => ({
    ...p,
    group: "Camera",
  })),
  // Open-weights camera catalog, one dropdown group per catalog group
  // (already in group order), searchable in the chip picker.
  ...WAN_MOTION_PRESETS.filter((p) => p.category === "camera" && p.group).map(
    (p) => ({ ...p, group: `Camera · ${p.group}` }),
  ),
  ...WAN_EFFECT_SECTIONS.flatMap((sec) =>
    WAN_MOTION_PRESETS.filter(
      (p) => p.category === "effect" && (p.section ?? "viral") === sec.id,
    ).map((p) => ({ ...p, group: sec.label })),
  ),
  ...WAN_MOTION_PRESETS.filter((p) => p.category === "none").map((p) => ({
    ...p,
    group: "Prompt only",
  })),
].map(({ id, label, group }) => ({
  id,
  label,
  group,
  // Tooltip flags the presets that also run on LTX-2.5 (Engine picker).
  ...(LTX_EFFECT_PRESET_IDS.includes(id)
    ? { hint: `${label} (also on LTX-2.5 with sound)` }
    : {}),
}));

/**
 * Motion presets engine: prompt-only effects that LTX-2.5 suits better (synced
 * sound, long steady camera moves; src/lib/oj/wanMotionLtx.ts) can run on
 * LTX-2.5 i2v instead. Shown only for those presets; Wan 2.2 is the default.
 */
const WAN_MOTION_ENGINE_PICKER: ActionPicker = {
  key: "engine",
  title: "Engine",
  options: [
    { id: WAN_MOTION_ENGINE_DEFAULT, label: "Wan 2.2" },
    {
      id: "ltx25",
      label: "LTX-2.5 (with sound)",
      requiresTool: "ltx25_animate",
    },
  ],
  showWhen: { key: "preset", oneOf: LTX_EFFECT_PRESET_IDS },
};

/** Mode / resolution / duration pickers shared by the Wan image-to-video tools. */
const WAN_VIDEO_PICKERS: ActionPicker[] = [
  { key: "mode", title: "Speed", options: WAN_MODES },
  {
    key: "resolution",
    title: "Resolution",
    options: WAN_RESOLUTIONS.map(({ id, label }) => ({ id, label })),
  },
  {
    key: "duration",
    title: "Length",
    options: WAN_LENGTHS.map(({ id, label }) => ({ id, label })),
  },
];

/** Custom timing (Multiframe Reference): where keyframes 2..4 land, % of the clip. */
export const MULTIFRAME_KEY_SLIDERS: ActionSlider[] = [2, 3, 4].map((k, i) => ({
  key: `key${k}At`,
  title: `Keyframe ${k} at`,
  min: 5,
  max: 100,
  step: 5,
  default: [35, 70, 100][i],
  unit: "%",
  showWhen: { key: "timing", value: "custom" },
}));

/** SeedVR2 DiT choice (ids = seedvr2Upscale SEEDVR2_MODELS keys). */
export const SEEDVR2_MODEL_PICKER: ActionPicker = {
  key: "model",
  title: "Model",
  options: [
    {
      id: "fast",
      label: "3B (fast)",
      hint: "SeedVR2 3B: quickest, lowest VRAM (3.4 GB of weights)",
    },
    {
      id: "quality",
      label: "7B",
      hint: "SeedVR2 7B: more detail, slower, 8.2 GB of weights",
      requiresOption: { key: "seedvr2_7b", model: "SeedVR2 7B" },
    },
    {
      id: "sharp",
      label: "7B sharp",
      hint: "SeedVR2 7B sharp: crisper edges and texture, same cost as 7B",
      requiresOption: { key: "seedvr2_7b_sharp", model: "SeedVR2 7B sharp" },
    },
  ],
  hint: "7B needs more VRAM: plan on a 24 GB card (RTX 4090). Clips then run in smaller chunks, so they take longer.",
};

function finishSlider(
  spec: ActionToolSpec,
  settings: ToolSettings,
  key: string,
): number | undefined {
  const sl = spec.sliders?.find((x) => x.key === key);
  return sl ? sliderValue(sl, settings) : undefined;
}

/** Image upscalers' finishing pass (lib/upscale/upscaleFinish). */
export const UPSCALE_FINISH_SLIDERS: ActionSlider[] = [
  {
    key: UPSCALE_STRENGTH_PARAM,
    title: "Strength",
    min: STRENGTH_MIN,
    max: STRENGTH_MAX,
    step: 5,
    default: STRENGTH_DEFAULT,
    unit: "%",
    advanced: true,
    hint: "How much of the upscale to keep. Lower blends back toward the original, softening invented detail.",
  },
  {
    key: UPSCALE_SHARPEN_PARAM,
    title: "Sharpen",
    min: SHARPEN_MIN,
    max: SHARPEN_MAX,
    step: 5,
    default: SHARPEN_DEFAULT,
    unit: "%",
    advanced: true,
    hint: "Unsharp mask on the final image. Higher values crisp up edges but also bring up grain on smooth areas. 0 = off.",
  },
];

/** SeedVR2PostProcessing color match against the resized source. */
export const SEEDVR2_COLOR_PICKER: ActionPicker = {
  key: "color",
  title: "Color match",
  options: [
    {
      id: "lab",
      label: "LAB",
      hint: "Transfer color in LAB space: most faithful to the source",
    },
    {
      id: "wavelet",
      label: "Wavelet",
      hint: "Match low-frequency color, keep the upscaled fine detail",
    },
    {
      id: "adain",
      label: "AdaIN",
      hint: "Match per-channel mean and contrast: fastest, global tint only",
    },
    {
      id: "none",
      label: "Off",
      hint: "No color transfer: keep SeedVR2's own colors",
    },
  ],
  paramOnly: true,
};

export const ACTION_TOOLS: ActionToolSpec[] = [
  {
    id: "edit_photo",
    title: "Edit photo",
    subtitle: "Change anything by describing it",
    category: "Edit",
    icon: "WandSparkles",
    text: {
      label: "Instruction",
      placeholder: "make the car matte black",
      required: true,
    },
    usesEditLora: true,
    picksEditFamily: true,
  },
  {
    id: "edit_qwen21",
    title: "Edit (Qwen 2.1)",
    subtitle: "Instruction edit with Qwen-Image 2.1",
    category: "Edit",
    icon: "PencilLine",
    requiredPack: "qwen-image-21",
    text: {
      label: "Instruction",
      placeholder: "replace the sky with a storm",
      required: true,
    },
    secondText: pasteAreaText(
      "Name the area to keep everything else from the original at full resolution.",
    ),
    pickers: [
      speedPicker("edit_qwen21", "edit_qwen21_fast"),
      pasteBackPicker,
      pastePosePicker,
    ],
  },
  {
    id: "edit_flux3",
    title: "Edit (FLUX.3)",
    subtitle: "Instruction edit with FLUX.3 Klein",
    category: "Edit",
    icon: "Zap",
    requiredPack: "flux3",
    text: {
      label: "Instruction",
      placeholder: "turn it into a watercolor",
      required: true,
    },
    secondText: pasteAreaText(
      "Name the area to keep everything else from the original at full resolution.",
    ),
    pickers: [
      speedPicker("edit_flux3", "edit_flux3_fast"),
      pasteBackPicker,
      pastePosePicker,
    ],
  },
  {
    id: "edit_fibo",
    title: "FIBO 2.0 Edit",
    subtitle: "Instruction edit, pasted back at full resolution",
    category: "Edit",
    icon: "PencilRuler",
    requiredPack: "fibo2",
    modelCheck: { pack: "fibo2", action: "edit_fibo" },
    text: {
      label: "Instruction",
      placeholder: "make the jacket red leather",
      required: true,
      hint: "Bria FIBO 2.0 weights are non-commercial (CC-BY-NC-4.0).",
    },
    secondText: pasteAreaText(
      "Empty = keep only what the edit changed (faces stay original).",
    ),
    pickers: [fiboSpeedPicker, pasteBackPicker, pastePosePicker],
  },
  {
    id: "remove_object",
    title: "Object Remover",
    subtitle: "Erase something and fill the gap",
    category: "Edit",
    icon: "Eraser",
    text: {
      label: "What to remove",
      placeholder: "the person on the left",
      required: false,
    },
    usesEditLora: true,
    pickers: [pasteBackPicker, pastePosePicker],
  },
  {
    id: "restyle_locked",
    title: "Restyle",
    subtitle: "New look, same composition",
    category: "Edit",
    icon: "Paintbrush",
    text: {
      label: "Style",
      placeholder: "oil painting, warm light",
      required: true,
    },
    usesEditLora: true,
  },
  {
    id: "replace_person",
    title: "Replace person",
    subtitle: "Put someone from another photo into this one",
    category: "Edit",
    icon: "Users",
    requiredPack: KREA2_EDIT_PACK,
    text: {
      label: "Who to replace",
      placeholder: "the man on the left",
      required: false,
    },
    usesEditLora: true,
    secondImage: "Person",
  },
  {
    id: "pose_character",
    title: "Pose character",
    subtitle: "Your character in the pose from another photo",
    category: "Edit",
    icon: "PersonStanding",
    requiredPack: KREA2_EDIT_PACK,
    modelCheck: { pack: KREA2_EDIT_PACK, action: POSE_CHARACTER_ACTION },
    text: {
      label: "Style",
      placeholder: "on a sunny beach, golden hour",
      required: false,
      hint: "Optional scene or style. Empty keeps the pose photo's background. The pose comes from the pose photo (plus its depth); face, hair and outfit from the character.",
    },
    usesEditLora: true,
    firstImage: "Character",
    secondImage: "Pose",
  },
  {
    id: "bg_remove",
    title: "Remove background",
    subtitle: "Transparent PNG cut-out",
    category: "Enhance",
    icon: "ImageOff",
  },
  {
    id: "upscale",
    title: "Upscale",
    subtitle: "Bigger and sharper",
    category: "Enhance",
    icon: "Maximize2",
    pickers: [
      {
        key: "mode",
        title: "Mode",
        options: [
          { id: "upscale_subtle", label: "Faithful" },
          { id: "upscale_creative", label: "Creative" },
          { id: UPSCALE_REDETAIL_ACTION, label: "Re-detail" },
        ],
      },
      {
        key: "size",
        title: "Size",
        options: UPSCALE_SIZES.map((o) => ({
          id: o.id,
          label: o.label,
          hint:
            o.id === "model"
              ? "The model's own factor (your preferred scale)"
              : o.size.kind === "long"
                ? `Long edge ${o.label}`
                : undefined,
        })),
        dropdown: true,
        paramOnly: true,
        showWhen: { key: "mode", value: "upscale_subtle" },
      },
      {
        key: "detail_size",
        title: "Re-detail size",
        options: REDETAIL_SIZES.map((o) => ({ id: o.id, label: o.label })),
        defaultId: REDETAIL_DEFAULT_SIZE,
        paramOnly: true,
        showWhen: { key: "mode", value: UPSCALE_REDETAIL_ACTION },
      },
      {
        key: "cleanup",
        title: "Clean up first",
        options: [
          { id: "off", label: "Off" },
          ...Object.entries(CLEANUP_MODELS).map(([id, m]) => ({
            id,
            label: m.label,
            hint: `1× ${m.file} pass before the upscale`,
          })),
        ],
        paramOnly: true,
      },
    ],
    // Model choice: UpscaleModelPicker (ToolRunner) writes picks.upscale_model.
    // No face-restore pass: the box has no FaceRestore nodes (Enhance faces
    // covers faces with FaceDetailer).
    sliders: [
      {
        key: "creativity",
        title: "Creativity",
        min: 0,
        max: 100,
        step: 5,
        default: CREATIVITY_DEFAULT,
        unit: "%",
        showWhen: { key: "mode", value: "upscale_creative" },
      },
      {
        key: "redetail",
        title: "Re-detail strength",
        min: REDETAIL_MIN,
        max: REDETAIL_MAX,
        step: 5,
        default: REDETAIL_DEFAULT,
        unit: "%",
        showWhen: { key: "mode", value: UPSCALE_REDETAIL_ACTION },
      },
      ...UPSCALE_FINISH_SLIDERS,
    ],
  },
  {
    id: "enhance_faces",
    title: "Enhance faces",
    subtitle: "Fix and sharpen faces",
    category: "Enhance",
    icon: "Smile",
    pickers: [
      {
        key: "mode",
        title: "Mode",
        options: [
          { id: "adetailer_auto", label: "Auto" },
          { id: "adetailer", label: "Standard" },
        ],
      },
    ],
  },
  {
    id: "animate",
    title: "Animate image",
    subtitle: "Bring a still to life",
    category: "Animate & 3D",
    icon: "Clapperboard",
    text: {
      label: "Motion",
      placeholder: "slow push-in, hair blowing",
      required: false,
    },
    pickers: [
      {
        key: "motion",
        title: "Motion",
        options: [
          { id: "animate_low", label: "Gentle" },
          { id: "animate_high", label: "Lively" },
        ],
      },
    ],
  },
  {
    id: "make_3d_trellis",
    title: "Make 3D",
    subtitle:
      "Turn an object or character image into a textured 3D model (GLB)",
    category: "Animate & 3D",
    icon: "Box",
    pickers: [
      {
        key: "engine",
        title: "Engine",
        options: [
          { id: "pixal3d", label: "Pixal3D (best)" },
          { id: "trellis2", label: "TRELLIS.2" },
        ],
      },
      {
        key: "quality",
        title: "Quality",
        options: [
          { id: "high", label: "High" },
          { id: "fast", label: "Fast" },
        ],
      },
      {
        key: "texture",
        title: "Texture",
        options: [
          { id: "on", label: "Textured" },
          { id: "off", label: "Shape only" },
        ],
      },
    ],
    // TRELLIS.2 / Pixal3D / MoGe / DINOv3 weights on the video host.
    modelCheck: { pack: "trellis2", action: "make_3d_trellis" },
    requireStatusEntry: true,
  },
  {
    id: "image_to_splat",
    title: "3D splat",
    subtitle: "Turn an object or character image into a 3D Gaussian splat",
    category: "Animate & 3D",
    icon: "Box",
    pickers: [
      {
        key: "format",
        title: "File",
        paramOnly: true,
        options: [
          { id: "ply", label: "PLY (most apps)" },
          { id: "spz", label: "SPZ (smaller)" },
        ],
      },
      {
        key: "mesh",
        title: "Mesh",
        paramOnly: true,
        options: [
          { id: "off", label: "Splat only" },
          { id: "on", label: "Also make a mesh" },
          {
            id: "detailed",
            label: "Also make a detailed mesh",
            hint: "Closer to the splat, with over twice the faces and a larger FBX.",
          },
        ],
      },
    ],
    // TripoSplat + DINOv3 ViT-H + FLUX.2 VAE + BiRefNet on the video host.
    modelCheck: { pack: "triposplat", action: "image_to_splat" },
    requireStatusEntry: true,
  },
  {
    id: "body_3d",
    title: "Body 3D",
    subtitle: "Fit a 3D body model to the people in a photo",
    category: "Animate & 3D",
    icon: "PersonStanding",
    pickers: [
      {
        key: "view",
        title: "Preview",
        paramOnly: true,
        options: [
          { id: "mesh", label: "Body on photo" },
          { id: "solo", label: "Body only" },
          { id: "skeleton", label: "Skeleton" },
        ],
      },
      {
        key: "file",
        title: "File",
        paramOnly: true,
        options: [
          { id: "glb", label: "GLB (3D mesh)" },
          { id: "bvh", label: "BVH (skeleton)" },
        ],
      },
    ],
    // SAM 3D Body + RT-DETR v4 person detector on the video host.
    modelCheck: { pack: "sam3d-body", action: "body_3d" },
    requireStatusEntry: true,
  },
  {
    id: "moge_geometry",
    title: "Depth & Normals",
    subtitle:
      "Depth map, normal map, 3D point-map mesh and camera FOV from one image",
    category: "Animate & 3D",
    icon: "Boxes",
    pickers: [
      {
        key: "source",
        title: "Shot",
        paramOnly: true,
        options: [
          { id: "photo", label: "Photo" },
          { id: "panorama", label: "360° panorama" },
        ],
      },
      {
        key: "mesh",
        title: "3D mesh",
        paramOnly: true,
        options: [
          { id: "light", label: "Standard" },
          { id: "full", label: "Full detail (large file)" },
          { id: "preview", label: "Preview (small file)" },
          { id: "off", label: "No mesh" },
        ],
      },
      {
        key: "depth",
        title: "Depth map",
        paramOnly: true,
        options: [
          { id: "gray", label: "Grayscale" },
          { id: "colored", label: "Colored" },
        ],
      },
      {
        key: "normals",
        title: "Normal map",
        paramOnly: true,
        options: [
          { id: "opengl", label: "OpenGL (Blender)" },
          { id: "directx", label: "DirectX (Unreal)" },
        ],
      },
      {
        key: "detail",
        title: "Detail",
        paramOnly: true,
        options: [
          { id: "max", label: "Max" },
          { id: "balanced", label: "Balanced" },
          { id: "fast", label: "Fast" },
        ],
      },
      {
        key: "model",
        title: "Model",
        paramOnly: true,
        options: [
          { id: "moge2", label: "MoGe-2 (fast)" },
          { id: "moge3", label: "MoGe-3 giant (finer, slower)" },
        ],
        hint: "MoGe-3 giant is a 2.5 GB download and runs a 3-step refiner.",
      },
    ],
    // MoGe-2 ViT-L (geometry_estimation/) on the video host; core MoGe nodes.
    // MoGe-3 ViT-G is an opt-in node of the pack (see mogeGeometry.ts).
    modelCheck: { pack: "image-tools", action: "moge_geometry" },
    requireStatusEntry: true,
  },
  {
    id: "material_maps",
    title: "Material Maps",
    subtitle:
      "Depth, normal and albedo maps from one image, each as its own image",
    category: "Animate & 3D",
    icon: "Layers",
    pickers: [
      {
        key: "depth",
        title: "Depth map",
        paramOnly: true,
        options: [
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ],
      },
      {
        key: "normals",
        title: "Normal map",
        paramOnly: true,
        options: [
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ],
      },
      {
        key: "albedo",
        title: "Albedo map",
        paramOnly: true,
        options: [
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ],
        hint: "Each map is saved as a separate image. From a head-on photo of a surface they work as PBR texture maps: albedo = base color, normals = normal map, depth = height (near is bright). Pick at least one.",
      },
      {
        key: "detail",
        title: "Detail",
        paramOnly: true,
        options: [
          { id: "standard", label: "Standard (1 MP)" },
          { id: "high", label: "High (2 MP, slower)" },
        ],
      },
    ],
    // Marigold V2 LoRAs on Qwen-Image-Edit-2509 (video host), one step per map.
    modelCheck: { pack: "qwen-edit-2509", action: "material_maps" },
    requireStatusEntry: true,
  },
  {
    id: "body_3d_video",
    title: "Body 3D from video",
    subtitle: "Track people's 3D body motion through a clip",
    category: "Animate & 3D",
    icon: "PersonStanding",
    videoInput: `Source video (first ${BODY_3D_MAX_SECONDS} s)`,
    videoWindow: { seconds: BODY_3D_MAX_SECONDS },
    videoNote: "Works best with whole bodies in view. Longer clips are cut.",
    pickers: [
      {
        key: "view",
        title: "Preview",
        paramOnly: true,
        options: [
          { id: "mesh", label: "Body on video" },
          { id: "solo", label: "Body only" },
          { id: "skeleton", label: "Skeleton" },
        ],
      },
      {
        key: "smooth",
        title: "Motion",
        paramOnly: true,
        options: [
          { id: "on", label: "Smoothed" },
          { id: "off", label: "Raw" },
        ],
      },
      {
        key: "file",
        title: "File",
        paramOnly: true,
        options: [
          { id: "glb", label: "GLB (animated mesh)" },
          { id: "bvh", label: "BVH (skeleton)" },
        ],
      },
    ],
    modelCheck: { pack: "sam3d-body", action: "body_3d" },
    requireStatusEntry: true,
  },
  {
    id: "make_3d",
    title: "Make 3D (legacy)",
    subtitle: "Legacy single-pass image → 3D model",
    category: "Animate & 3D",
    icon: "Box",
    // Retired: the 3D Model card (make_3d_trellis) replaces it; its card key
    // aliases there (toolRegistry.ts). Nodes/weights are checked server-side
    // (registry template i23d).
    hidden: true,
    modelCheck: { pack: "utility", action: "make_3d" },
    requireStatusEntry: true,
  },
  {
    id: "music",
    title: "Make music",
    subtitle: "Generate a song or instrumental from a description",
    category: "Audio",
    icon: "Music",
    noSourceInput: true,
    text: {
      label: "Style",
      placeholder: "warm lo-fi hip hop, dusty drums, mellow piano",
      required: true,
      hint: "Genre, instruments, mood (comma separated tags).",
    },
    secondText: {
      label: "Lyrics",
      placeholder: "[verse]\n...\n[chorus]\n...",
      required: false,
      hint: "Leave empty for an instrumental.",
    },
    pickers: [
      {
        key: "duration",
        title: "Length",
        defaultId: "30",
        options: [
          { id: "15", label: "15 s" },
          { id: "30", label: "30 s" },
          { id: "60", label: "1 min" },
          { id: "120", label: "2 min" },
        ],
      },
      {
        key: "bpm",
        title: "Tempo",
        defaultId: "120",
        options: [
          { id: "90", label: "90 BPM" },
          { id: "100", label: "100 BPM" },
          { id: "120", label: "120 BPM" },
          { id: "140", label: "140 BPM" },
          { id: "170", label: "170 BPM" },
        ],
      },
      {
        key: "key",
        title: "Key",
        options: [
          { id: "C major", label: "C major" },
          { id: "A minor", label: "A minor" },
          { id: "G major", label: "G major" },
          { id: "E minor", label: "E minor" },
          { id: "D major", label: "D major" },
          { id: "D minor", label: "D minor" },
          { id: "F major", label: "F major" },
        ],
      },
    ],
    modelCheck: { pack: "audio", action: "music" },
    requireStatusEntry: true,
  },
  {
    id: "sfx",
    title: "Sound effect",
    subtitle: "Generate a sound effect or ambience from a description",
    category: "Audio",
    icon: "AudioLines",
    noSourceInput: true,
    text: {
      label: "Sound",
      placeholder: "heavy wooden door creaking open in a stone hall",
      required: true,
    },
    pickers: [
      {
        key: "duration",
        title: "Length",
        defaultId: "8",
        options: [
          { id: "4", label: "4 s" },
          { id: "8", label: "8 s" },
          { id: "15", label: "15 s" },
          { id: "30", label: "30 s" },
        ],
      },
    ],
    modelCheck: { pack: "audio", action: "sfx" },
    requireStatusEntry: true,
  },
  // Stable Audio 3 Medium: Music & sound, Restyle, Fix a section, Extend.
  ...SA3_TOOL_SPECS,
  {
    id: "face_swap",
    title: "Swap face in video",
    subtitle: "Put a face from a photo onto the person in a clip",
    category: "Animate & 3D",
    icon: "Smile",
    requiredPack: "minimax",
    videoInput: "Source video",
    secondImage: "Face photo",
    modelCheck: { pack: "minimax", action: "face_swap" },
  },
  {
    id: "orbit_360",
    title: "360 orbit video",
    subtitle: "Frozen-time camera orbit around your photo",
    category: "Animate & 3D",
    icon: "Camera",
    requiredPack: "minimax",
    text: {
      label: "Extra notes (optional)",
      placeholder: "keep the neon sign lit",
      required: false,
    },
    pickers: [
      {
        key: "orbitLook",
        title: "Look",
        options: ORBIT_PRESETS.map(({ id, label, hint }) => ({
          id,
          label,
          hint,
        })),
        dropdown: true,
        paramOnly: true,
      },
      ...H3_TOGGLE_PICKERS,
    ],
    modelCheck: { pack: "minimax", action: "orbit_360" },
  },
  {
    id: "camera_move",
    title: "Camera move video",
    subtitle: "Push, pull, orbit or crane the camera through your photo",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "minimax",
    text: {
      label: "Scene (optional)",
      placeholder: "a woman walking through a night market",
      required: false,
    },
    pickers: [
      {
        key: "cameraMove",
        title: "Camera move",
        options: CAMERA_MOVE_OPTIONS,
        dropdown: true,
        paramOnly: true,
      },
      {
        key: "resolution",
        title: "Resolution",
        paramOnly: true,
        options: [
          {
            id: "768",
            label: "768p",
            hint: "Native size (1344x768 at 16:9), sharpest faces (default)",
          },
          {
            id: "480",
            label: "480p",
            hint: "Faster draft, about 2.5x quicker",
          },
        ],
      },
      ...H3_TOGGLE_PICKERS,
    ],
    modelCheck: { pack: "minimax", action: "camera_move" },
  },
  {
    id: "person_remove",
    title: "Video Person Remover",
    subtitle:
      "Erase a person from a clip and rebuild the background behind them",
    category: "Animate & 3D",
    icon: "Eraser",
    requiredPack: "minimax",
    videoInput: "Source video (24 fps, up to ~5 s)",
    videoWindow: { maxFrames: PERSON_REMOVE_MAX_FRAMES, fps: 24 },
    secondImage: "Clean first frame (optional)",
    secondImageOptional: true,
    text: {
      label: "Who to remove",
      placeholder: "woman in a yellow shirt",
      required: false,
      hint: "Short description for the tracker. Leave the clean frame empty and it is made automatically.",
    },
    secondText: {
      label: "What's behind them",
      placeholder: "empty driver seat and truck cab interior",
      required: false,
      compact: true,
      hint: "Optional. Leave empty and the clean frame is captioned automatically; the remover rebuilds what this names.",
    },
    modelCheck: { pack: "minimax", action: "person_remove" },
    requireStatusEntry: true,
  },
  {
    id: "video_object_remove",
    title: "Video Object Remover",
    subtitle:
      "Erase anything you name from a clip; only that area is repainted, audio kept",
    category: "Animate & 3D",
    icon: "Eraser",
    videoInput: "Source video (first 3 s, 24 fps)",
    videoWindow: { maxFrames: VIDEO_REMOVE_LENGTH, fps: 24 },
    text: {
      label: "What to remove",
      placeholder: "red umbrella",
      required: true,
      hint: "Short description for the tracker; separate several with commas. Everything outside the tracked area stays the original footage.",
    },
    pickers: [vaceSpeedPicker],
    modelCheck: { pack: "wan22", action: "video_object_remove" },
    requireStatusEntry: true,
  },
  {
    id: "video_remove_text",
    title: "Video Text Remover",
    subtitle:
      "Erase captions, subtitles, watermarks or logos from a clip; audio kept",
    category: "Animate & 3D",
    icon: "Type",
    videoInput: "Source video (first 3 s, 24 fps)",
    videoWindow: { maxFrames: VIDEO_REMOVE_LENGTH, fps: 24 },
    text: {
      label: "Custom target (optional)",
      placeholder: "station logo",
      required: false,
      hint: "Overrides the preset, or click the logo / caption on the video (Smart select). Everything outside the found text stays the original footage.",
    },
    pickers: [
      {
        key: "textPreset",
        title: "Remove",
        options: [
          { id: "all", label: "All text" },
          { id: "captions", label: "Captions / subtitles" },
          { id: "watermark", label: "Watermark / logo" },
        ],
      },
      vaceSpeedPicker,
    ],
    modelCheck: { pack: "wan22", action: "video_remove_text" },
    requireStatusEntry: true,
  },
  {
    id: "video_object_swap",
    title: "Swap object in video",
    subtitle:
      "Replace something in a clip with the object from your photo; audio kept",
    category: "Animate & 3D",
    icon: "Wand",
    videoInput: "Source video (first 3 s, 24 fps)",
    videoWindow: { maxFrames: VIDEO_REMOVE_LENGTH, fps: 24 },
    secondImage: "Replacement object (photo)",
    text: {
      label: "What to replace",
      placeholder: "coffee cup",
      required: true,
      hint: "Short description for the tracker, or click it on the video (Smart select). Everything outside the tracked area stays the original footage.",
    },
    secondText: {
      label: "New object",
      placeholder: "red ceramic mug",
      required: false,
      compact: true,
      hint: "A few words about the object in the photo; helps the prompt.",
    },
    pickers: [
      {
        key: "margin",
        title: "Shape",
        options: [
          { id: "normal", label: "Similar shape" },
          { id: "wide", label: "Different shape" },
        ],
      },
      {
        key: "refPrep",
        title: "Reference",
        options: [
          { id: "cutout", label: "Cut out object" },
          { id: "asis", label: "Use photo as is" },
        ],
      },
      vaceSpeedPicker,
    ],
    modelCheck: { pack: "wan22", action: "video_object_swap" },
    requireStatusEntry: true,
  },
  {
    id: "video_object_add",
    title: "Add object to video",
    subtitle:
      "Place an object from a photo or words into a clip; the rest stays as shot",
    category: "Animate & 3D",
    icon: "Box",
    requiredPack: "minimax",
    videoInput: "Source video (24 fps, first ~5 s)",
    videoWindow: { maxFrames: Math.round(H3_MASKED_EDIT_SECONDS * H3_MASKED_EDIT_FPS), fps: H3_MASKED_EDIT_FPS },
    secondImage: "Object photo (optional)",
    secondImageOptional: true,
    text: {
      label: "Object",
      placeholder: "a small red fox figurine",
      required: false,
      hint: "Describe it, upload a photo of it, or both. It is rendered inside the chosen box only.",
    },
    secondText: {
      label: "Resting on",
      placeholder: "the pavement",
      required: false,
      compact: true,
      hint: "Optional surface it stands on (helps grounding and shadows).",
    },
    pickers: [
      {
        key: "position",
        title: "Where",
        dropdown: true,
        paramOnly: true,
        options: [
          OBJECT_ADD_DEFAULT_POSITION,
          ...Object.keys(OBJECT_ADD_POSITIONS).filter(
            (k) => k !== OBJECT_ADD_DEFAULT_POSITION,
          ),
        ].map((id) => ({ id, label: OBJECT_ADD_POSITIONS[id].label })),
      },
      {
        key: "size",
        title: "Size",
        paramOnly: true,
        options: [
          OBJECT_ADD_DEFAULT_SIZE,
          ...Object.keys(OBJECT_ADD_SIZES).filter(
            (k) => k !== OBJECT_ADD_DEFAULT_SIZE,
          ),
        ].map((id) => ({ id, label: OBJECT_ADD_SIZES[id].label })),
      },
    ],
    modelCheck: { pack: "minimax", action: "video_object_add" },
    requireStatusEntry: true,
  },
  {
    id: "video_bg_swap",
    title: "Swap video background (H3)",
    subtitle:
      "Keep the people, put them somewhere new from words or a picture; audio kept",
    category: "Animate & 3D",
    icon: "Layers",
    requiredPack: "minimax",
    videoInput: "Source video (24 fps, first ~5 s)",
    videoWindow: { maxFrames: Math.round(H3_MASKED_EDIT_SECONDS * H3_MASKED_EDIT_FPS), fps: H3_MASKED_EDIT_FPS },
    secondImage: "Background picture (optional)",
    secondImageOptional: true,
    text: {
      label: "Who to keep",
      placeholder: "person",
      required: false,
      hint: "Tracker text (default: everyone), or click them on the video (Smart select). They stay the original footage.",
    },
    secondText: {
      label: "New setting",
      placeholder: "snowy mountain village at dusk",
      required: false,
      hint: "Describe the new place, upload a picture of it, or both.",
    },
    pickers: [
      {
        key: "settingPreset",
        title: "Setting preset",
        options: BG_SWAP_SETTINGS.map(({ id, label }) => ({ id, label })),
        dropdown: true,
        paramOnly: true,
      },
    ],
    modelCheck: { pack: "minimax", action: "video_bg_swap" },
    requireStatusEntry: true,
  },
  {
    id: "cast_swap",
    title: "Recast several people",
    subtitle:
      "Swap up to 3 people in a clip for your characters, each in its own mask",
    category: "Animate & 3D",
    icon: "Users",
    requiredPack: "minimax",
    videoInput: "Source video (24 fps, first ~5 s)",
    videoWindow: { maxFrames: Math.round(H3_MASKED_EDIT_SECONDS * H3_MASKED_EDIT_FPS), fps: H3_MASKED_EDIT_FPS },
    secondImage: "Character 1 photo",
    extraImages: Array.from(
      { length: CAST_SWAP_MAX_PEOPLE - 1 },
      (_, i) => `Character ${i + 2} photo (optional)`,
    ),
    smartTrackPerRef: true,
    text: {
      label: "Who is who",
      placeholder: "1: the man in the grey hoodie\n2: the man on the left",
      required: false,
      hint: "Optional, one line per photo. Empty: Qwen3-VL matches each photo to a tracked person. Or click each person on the video. Everyone must be in the first frame.",
    },
    pickers: [followSubjectPicker],
    modelCheck: { pack: "minimax", action: "cast_swap" },
    requireStatusEntry: true,
  },
  {
    id: "crossview",
    title: "CrossView video",
    subtitle: "Cross-view warp with the Ref2VA CrossView LoRA",
    category: "Animate & 3D",
    icon: "Users",
    requiredPack: "minimax",
    videoInput: "Source video",
    requiresNodes:
      "ComfyUI-CrossViewWarp custom node (not installed). The CrossView-Warp LoRA needs its multi-stage warp pipeline.",
    // Stub: nothing can run it yet, so it is not offered.
    hidden: true,
  },
  {
    id: "describe",
    title: "Describe",
    subtitle: "Get prompts for an image",
    category: "Describe",
    icon: "ScanText",
    special: "describe",
  },
  {
    id: "character_swap",
    title: "Character swap in video",
    subtitle:
      "Swap a character in a video for your photo; motion and expressions carry over",
    category: "Animate & 3D",
    icon: "Users",
    requiredPack: "minimax",
    videoInput: "Source video",
    videoWindow: { maxFrames: CHARACTER_SWAP_MAX_LENGTH, fps: CHARACTER_SWAP_FPS },
    videoNote:
      "Up to 32 MB. Full re-render: 24 fps, up to 15 s at 480p. Mannequin: the first ~5 s. Exact: the whole clip at its own frame rate and size.",
    secondImage: "Character photo",
    text: {
      label: "Who to replace",
      placeholder: "the man in the red jacket",
      required: false,
      hint: "More than one person in the shot? Describe who. Full re-render may swap everyone; Mannequin and Exact use this as the tracker target (default: the person) and take the largest match in the first frame.",
    },
    pickers: [
      {
        key: "mode",
        title: "Mode",
        options: [
          {
            // The card's own check (modelCheck action character_swap).
            id: "full",
            label: "Full re-render",
            hint: "Whole frame re-rendered; up to 15 s",
          },
          {
            id: "mannequin",
            label: "Mannequin (keep scene)",
            // Its own graph (character_swap_masked, int8 Ref2VA + SAM3):
            // model-status options.characterSwapMasked.
            requiresOption: {
              key: CHARACTER_SWAP_MASKED_OPTION,
              model: "Mannequin",
            },
            hint: "Only the tracked person is re-rendered (grey mannequin guide); first ~5 s",
          },
          {
            id: "exact",
            label: "Exact (whole clip)",
            // Same graph and weights as Mannequin; the builder swaps prepare
            // and paste-back (cj_exact.py).
            requiresOption: {
              key: CHARACTER_SWAP_MASKED_OPTION,
              model: "Mannequin",
            },
            hint: "Re-renders the tracked person and the area around them. Everything further out, every frame, its timing and the sound stay as in the source. Long or high frame rate clips take longer. The person must be visible in the first frame.",
          },
        ],
      },
      {
        key: "motionGuide",
        title: "Motion guide",
        paramOnly: true,
        showWhen: { key: "mode", oneOf: ["mannequin", "exact"] },
        options: [
          {
            id: "pose",
            label: "Pose",
            hint: "Follows the tracked person's skeleton (hands, limbs, size); other people are ignored",
          },
          { id: "off", label: "Off", hint: "Grey mannequin guide only" },
        ],
      },
      {
        key: "resolution",
        title: "Working resolution",
        paramOnly: true,
        showWhen: { key: "mode", value: "exact" },
        options: [
          { id: "480", label: "480p", hint: "Up to 0.5 MP. The source keeps its own size." },
          { id: "768", label: "768p", hint: "Up to 1 MP. Sharper person, about twice the time." },
        ],
      },
      {
        key: "output",
        title: "Output file",
        paramOnly: true,
        showWhen: { key: "mode", value: "exact" },
        options: [
          { id: "delivery", label: "Delivery", hint: "High quality H.264 at the source's bit depth. 8-bit 4:2:0 clips play anywhere; 10-bit or 4:2:2 sources may not play in a browser." },
          { id: "master", label: "Lossless master", hint: "Pixels outside the edit area decode bit-identical to the source. Large file, browsers may not play it." },
        ],
      },
      { ...followSubjectPicker, showWhen: { key: "mode", value: "mannequin" } },
      {
        key: "finish",
        title: "Finish",
        paramOnly: true,
        showWhen: { key: "mode", value: "mannequin" },
        options: [
          { id: "off", label: "Off", hint: "Swap at the working resolution" },
          {
            id: "2k",
            label: "2K",
            hint: "Re-renders the swapped person at 2K. Adds ~3 min. Needs the Open-H3-Regenerate nodes.",
          },
        ],
      },
    ],
    sliders: [
      {
        key: "poseStrength",
        title: "Pose strength",
        min: 20,
        max: 120,
        step: 5,
        default: Math.round(MOTION_GUIDE_POSE_DEFAULT_STRENGTH * 100),
        unit: "%",
        advanced: true,
        showWhen: { key: "motionGuide", value: "pose" },
        hint: "Higher follows the source pose more tightly; lower leaves more room for the new body shape.",
      },
      {
        key: "finishStrength",
        title: "Finish strength",
        min: Math.round(FINISH_STRENGTH_RANGE.min * 100),
        max: Math.round(FINISH_STRENGTH_RANGE.max * 100),
        step: 5,
        default: Math.round(FINISH_DEFAULT_STRENGTH * 100),
        unit: "%",
        advanced: true,
        showWhen: { key: "finish", value: "2k" },
        hint: "Higher adds more detail but can drift from the swap; lower stays closer to it.",
      },
    ],
    secondText: {
      label: "Outfit",
      placeholder: "bright yellow hooded raincoat, blue jeans",
      required: false,
      compact: true,
      hint: "What the character wears. Empty: the photo is described automatically (Qwen3-VL).",
      showWhen: { key: "mode", oneOf: ["mannequin", "exact"] },
    },
    // Card availability = the default mode's graph: "full" queues action
    // character_swap (bf16 Ref2VA), so the card can't read ready while that
    // is missing. Mannequin (character_swap_masked, int8 Ref2VA) is gated
    // per option through model-status options.characterSwapMasked.
    modelCheck: { pack: "minimax", action: "character_swap" },
    requireStatusEntry: true,
  },
  {
    id: "wan_animate",
    title: "Animate character",
    subtitle: "A character from a photo performs the motion of a clip",
    category: "Animate & 3D",
    icon: "UserSquare",
    requiredPack: "wan-animate",
    videoInput: "Motion clip",
    videoWindow: { maxFrames: WAN_ANIMATE_MAX_FRAMES },
    videoNote:
      "Any frame rate, up to 241 frames (about 10 s at 24 fps) and 32 MB. Output is 480p at the clip's frame rate; the photo is center-cropped to the clip's shape.",
    secondImage: "Character photo",
    text: {
      label: "Character (optional)",
      placeholder: "a cartoon robot with an orange head",
      required: false,
      hint: "Animate photo keeps the photo's background. Replace in video swaps the clip's single main performer (needs BiRefNet; no per-person targeting).",
    },
    pickers: [
      {
        key: "mode",
        title: "Mode",
        options: [
          { id: "animate", label: "Animate photo" },
          { id: "replace", label: "Replace in video" },
        ],
      },
      {
        key: "speed",
        title: "Speed",
        options: [
          { id: "fast", label: "Fast (distilled)" },
          { id: "quality", label: "Best" },
        ],
      },
    ],
    modelCheck: { pack: "wan-animate", action: "wan_animate" },
    requireStatusEntry: true,
  },
  {
    id: "lipsync",
    title: "Lipsync / talking photo",
    subtitle:
      "InfiniteTalk: make the person in a photo speak an audio clip (up to ~15 s)",
    category: "Animate & 3D",
    icon: "Mic",
    requiredPack: "wan-animate",
    audioInput: "Speech audio",
    audioNote:
      "wav, mp3, m4a or flac, up to 32 MB. Video length follows the speech, capped at about 14.7 s (longer audio is cut). Output is 25 fps, 480p, with the speech as its soundtrack.",
    text: {
      label: "Scene (optional)",
      placeholder: "a man talking calmly to the camera",
      required: false,
    },
    modelCheck: { pack: "wan-animate", action: "lipsync" },
    requireStatusEntry: true,
  },
  {
    id: "video_lipsync",
    title: "Lipsync onto video",
    subtitle:
      "Re-sync the lips in an existing clip to new speech; the rest stays original",
    category: "Animate & 3D",
    icon: "Mic",
    requiredPack: "wan-animate",
    videoInput: "Source video (one face)",
    videoWindow: { maxFrames: LIPSYNC_MAX_FRAMES, fps: LIPSYNC_FPS },
    videoNote:
      "Any frame rate: the clip is resampled to 25 fps (InfiniteTalk's audio rate) so the lips stay on the speech, and the output is 25 fps. Length follows the shorter of video and speech, capped at about 14.7 s. The face is generated at 480p and pasted back onto the source; the new speech replaces the original audio.",
    audioInput: "New speech audio",
    audioNote:
      "wav, mp3, m4a or flac, up to 32 MB. Only this audio drives the lips.",
    text: {
      label: "Whose face (optional)",
      placeholder: "face",
      required: false,
      hint: "Short tracker prompt, e.g. 'woman's face'. Or click the face on the video (Smart select).",
    },
    modelCheck: { pack: "wan-animate", action: "video_lipsync" },
    requireStatusEntry: true,
  },
  {
    id: "talking_avatar",
    title: "Talking avatar",
    subtitle:
      "Wan 2.2 S2V: a photo talks or sings to your audio, with head and body motion (up to 15 s)",
    category: "Animate & 3D",
    icon: "Mic",
    requiredPack: "wan-animate",
    audioInput: "Speech or song",
    audioNote:
      "wav, mp3, m4a or flac, up to 32 MB. Video length follows the audio, capped at about 14.8 s (longer audio is cut). Output is 16 fps, about 640 px, with the audio as its soundtrack.",
    text: {
      label: "Scene (optional)",
      placeholder: "a woman singing passionately on a stage",
      required: false,
    },
    pickers: [
      {
        key: "mode",
        title: "Speed",
        options: [
          { id: "fast", label: "Fast (4 steps)" },
          { id: "quality", label: "Quality (20 steps, slower)" },
        ],
      },
      {
        key: "gesture",
        title: "Delivery",
        dropdown: true,
        options: AVATAR_GESTURES.map(({ id, label, group }) => ({
          id,
          label,
          ...(group ? { group } : {}),
        })),
      },
    ],
    modelCheck: { pack: "wan-animate", action: "talking_avatar" },
    requireStatusEntry: true,
  },
  {
    id: "transition",
    title: "Transition",
    subtitle: "Video that moves from a start frame to an end frame",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "minimax",
    secondImage: "End frame",
    text: {
      label: "How it moves",
      placeholder: "the camera whips around as day turns to night",
      required: false,
    },
    pickers: [
      {
        key: "transitionStyle",
        title: "Style",
        options: TRANSITION_STYLES.map(({ id, label, hint }) => ({
          id,
          label,
          hint,
        })),
        dropdown: true,
        paramOnly: true,
      },
      h3FlexPicker,
      h3QualityPicker,
    ],
    modelCheck: { pack: "minimax", action: "transition" },
    requireStatusEntry: true,
  },
  {
    id: "ref_video",
    title: "Reference to Video",
    subtitle:
      "MiniMax H3: 1-3 character photos star in a brand-new shot with sound",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "minimax",
    firstImage: "Character 1",
    secondImage: "Character 2 (optional)",
    secondImageOptional: true,
    extraImages: ["Character 3 or setting (optional)"],
    text: {
      label: "What happens (optional)",
      placeholder: "they share an umbrella and run for the tram",
      required: false,
      hint: "Replaces the scene's action; look, camera and sound stay. MiniMax H3 Turbo 8-step renders 3 s at 480p in about 45 s on a 24 GB GPU once loaded; the first run also loads the models.",
    },
    pickers: [
      {
        key: "scene",
        title: "Scene",
        dropdown: true,
        paramOnly: true,
        options: REF_VIDEO_SCENES.map(({ id, label }) => ({ id, label })),
      },
      {
        key: "lastRef",
        title: "Last photo is",
        paramOnly: true,
        options: [
          { id: "cast", label: "A character" },
          {
            id: "setting",
            label: "The setting",
            hint: "With 2-3 photos: the last one is the place, not a cast member",
          },
        ],
      },
      {
        key: "aspect",
        title: "Aspect",
        paramOnly: true,
        options: [
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "1:1", label: "1:1" },
        ],
      },
      {
        key: "duration",
        title: "Length",
        paramOnly: true,
        options: [
          { id: "3", label: "3 s" },
          { id: "2", label: "2 s" },
          { id: "5", label: "5 s" },
          {
            id: "long",
            label: "Long clip",
            hint: "6-30 s in one graph: overlapping latent windows, continuous sound",
          },
        ],
      },
      {
        key: "longMethod",
        title: "Long clip method",
        paramOnly: true,
        showWhen: { key: "duration", value: "long" },
        hint: H3_LONG_METHOD_TRADEOFF,
        options: [
          {
            id: "context",
            label: "Context windows (single pass)",
            hint: "One sampling pass; every step denoises all windows and blends their overlaps (core MiniMaxH3ContextWindows). Smoothest; bounded by RAM/VRAM",
          },
          {
            id: "sequential",
            label: "Chained",
            hint: "Windows run in order; each starts from the last one's finished overlap. Length not bound by memory; joins can drift",
          },
        ],
      },
      {
        key: "longOverlap",
        title: "Window overlap",
        paramOnly: true,
        showWhen: { key: "duration", value: "long" },
        options: [
          {
            id: "auto",
            label: "Default",
            hint: `${(H3_LONG_CONTEXT_OVERLAP / H3_FPS).toFixed(1)} s for context windows, ${(H3_LONG_SEQUENTIAL_OVERLAP / H3_FPS).toFixed(1)} s chained`,
          },
          { id: "22", label: "0.9 s", hint: "Fewer windows, faster; joins show more" },
          { id: "39", label: "1.6 s" },
          {
            id: "56",
            label: "2.3 s",
            hint: "Smoothest joins; more windows, slower",
          },
        ],
      },
      {
        key: "fixFaces",
        title: "Fix faces",
        paramOnly: true,
        options: [
          { id: "0", label: "Off" },
          {
            id: "1",
            label: "1 person",
            hint: "Re-renders the face up close at low denoise; changes stay inside the person's mask",
          },
          {
            id: "2",
            label: "2 people",
            hint: "One separate pass per person so faces never mix",
          },
          { id: "3", label: "3 people", hint: "One separate pass per person" },
        ],
      },
      {
        key: "resolution",
        title: "Resolution",
        paramOnly: true,
        options: [
          {
            id: "768",
            label: "768p",
            hint: "Native size (1344x768 at 16:9), clean full frame (default)",
          },
          {
            id: "480",
            label: "480p",
            hint: "Faster draft, about 2.5x quicker; portrait refs can smear the side edges",
          },
        ],
      },
      h3FlexPicker,
      {
        key: "h3Speed",
        title: "Speed",
        options: [
          {
            id: "turbo8",
            label: "Turbo (8 steps)",
            hint: "Best quality per minute (default)",
          },
          {
            id: "turbo4",
            label: "Turbo (4 steps)",
            hint: "About half the sampling time, softer detail",
          },
          {
            id: "fast8",
            label: "FastH3 (8 steps)",
            hint: "FastVideo's distilled H3 DiT",
          },
          {
            id: "off",
            label: "Quality (20 steps)",
            hint: "Base H3, about 2.5x the sampling time",
          },
        ],
      },
    ],
    sliders: [
      {
        key: "longSeconds",
        title: "Long clip length",
        min: H3_LONG_MIN_SECONDS,
        max: H3_LONG_MAX_SECONDS,
        step: 1,
        default: H3_LONG_DEFAULT_SECONDS,
        unit: " s",
        showWhen: { key: "duration", value: "long" },
        hintFor: (value, settings) =>
          h3LongPlanHint(
            planH3LongClip({
              seconds: value,
              method: settings.picks.longMethod,
              windowFrames: settings.picks.longWindow,
              overlapFrames: settings.picks.longOverlap,
              resolution: settings.picks.resolution,
              h3Speed: settings.picks.h3Speed || "turbo8",
              fixFaces: settings.picks.fixFaces,
            }),
            refVideoSize(settings.picks.aspect, settings.picks.resolution),
          ),
      },
      {
        key: "longWindow",
        title: "Window length",
        min: H3_LONG_WINDOW_MIN,
        max: H3_LONG_WINDOW_MAX,
        step: 17,
        default: H3_LONG_WINDOW_FRAMES,
        unit: " frames",
        advanced: true,
        showWhen: { key: "duration", value: "long" },
        hintFor: (value, settings) =>
          h3LongWindowHint(value, settings.picks.resolution ?? "768"),
      },
    ],
    modelCheck: { pack: "minimax", action: "ref_video" },
    requireStatusEntry: true,
  },
  {
    id: "multiframe_ref",
    title: "Multiframe Reference",
    subtitle:
      "MiniMax H3: 2-4 keyframe photos pinned to chosen moments of a new shot with sound",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "minimax",
    firstImage: "Keyframe 1 (start)",
    secondImage: "Keyframe 2",
    extraImages: ["Keyframe 3 (optional)", "Keyframe 4 (optional)"],
    text: {
      label: "What happens (optional)",
      placeholder: "she turns from the window and walks out into the rain",
      required: false,
      hint: "Keyframe 1 is the first frame and the identity; the others are hit at their moments (evenly spread, the last on the final frame, unless you set custom timing). Same models as Reference to Video.",
    },
    pickers: [
      {
        key: "flow",
        title: "Between keyframes",
        paramOnly: true,
        options: [
          {
            id: "continuous",
            label: "One shot",
            hint: "Camera and subject move from keyframe to keyframe (keyframes should share a scene)",
          },
          {
            id: "cuts",
            label: "Cuts",
            hint: "Each keyframe opens a new shot (the official template)",
          },
        ],
      },
      {
        key: "timing",
        title: "Timing",
        paramOnly: true,
        options: [
          { id: "even", label: "Even", hint: "Last keyframe on the final frame" },
          { id: "custom", label: "Custom" },
        ],
      },
      {
        key: "keysAsRefs",
        title: "Keyframes 2-4",
        paramOnly: true,
        options: [
          {
            id: "anchor",
            label: "Anchors only",
            hint: "The official graph: pinned frames, faster",
          },
          {
            id: "refs",
            label: "Also references",
            hint: "The encoder sees them too (<Picture 2-4>); slower",
          },
        ],
      },
      {
        key: "aspect",
        title: "Aspect",
        paramOnly: true,
        options: [
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "1:1", label: "1:1" },
        ],
      },
      {
        key: "duration",
        title: "Length",
        paramOnly: true,
        options: [
          { id: "5", label: "5 s" },
          { id: "3", label: "3 s" },
          { id: "8", label: "8 s" },
        ],
      },
      {
        key: "resolution",
        title: "Resolution",
        paramOnly: true,
        options: [
          {
            id: "768",
            label: "768p",
            hint: "Native size (1344x768 at 16:9), clean full frame (default)",
          },
          {
            id: "480",
            label: "480p",
            hint: "Faster draft, about 2.5x quicker; portrait refs can smear the side edges",
          },
        ],
      },
      h3FlexPicker,
      {
        key: "h3Speed",
        title: "Speed",
        options: [
          {
            id: "turbo8",
            label: "Turbo (8 steps)",
            hint: "Best quality per minute (default)",
          },
          {
            id: "turbo4",
            label: "Turbo (4 steps)",
            hint: "About half the sampling time, softer detail",
          },
          {
            id: "fast8",
            label: "FastH3 (8 steps)",
            hint: "FastVideo's distilled H3 DiT",
          },
          {
            id: "off",
            label: "Quality (20 steps)",
            hint: "Base H3, about 2.5x the sampling time",
          },
        ],
      },
    ],
    sliders: MULTIFRAME_KEY_SLIDERS,
    modelCheck: { pack: "minimax", action: "multiframe_ref" },
    requireStatusEntry: true,
  },
  {
    id: "h3_charsheet",
    title: "H3 Character Sheet",
    subtitle:
      "MiniMax H3: pick the views and get one turnaround sheet of your character",
    category: "Camera",
    icon: "LayoutGrid",
    requiredPack: "minimax",
    firstImage: "Character (identity)",
    secondImage: "Reference 2 (optional)",
    secondImageOptional: true,
    extraImages: ["Reference 3 (optional)"],
    text: {
      label: "Character description (optional)",
      placeholder: "wiry courier, cropped red jacket over a grey hoodie, cargo shorts, taped fingerless gloves",
      required: false,
      hint: "Fills in what the photos don't show. Views, outfit rules and the panel layout are written for you.",
    },
    secondText: {
      label: "Name",
      placeholder: "Mara",
      required: false,
      compact: true,
    },
    pickers: [
      {
        key: "size",
        title: "Sheet size",
        paramOnly: true,
        options: CHAR_SHEET_SIZES.map(({ id, label, hint }) => ({
          id,
          label,
          hint,
        })),
        defaultId: CHAR_SHEET_DEFAULT_SIZE,
      },
      {
        key: "render",
        title: "Rendering",
        dropdown: true,
        paramOnly: true,
        options: CHAR_SHEET_RENDERS.map(({ id, label }) => ({ id, label })),
        defaultId: CHAR_SHEET_DEFAULT_RENDER,
      },
      {
        key: "ref2Role",
        title: "Reference 2 shows",
        dropdown: true,
        paramOnly: true,
        options: CHAR_SHEET_REF_ROLES.map(({ id, label }) => ({ id, label })),
        defaultId: CHAR_SHEET_DEFAULT_ROLE,
      },
      {
        key: "ref3Role",
        title: "Reference 3 shows",
        dropdown: true,
        paramOnly: true,
        options: CHAR_SHEET_REF_ROLES.map(({ id, label }) => ({ id, label })),
        defaultId: CHAR_SHEET_DEFAULT_ROLE,
      },
      {
        key: "h3Speed",
        title: "Speed",
        options: [
          { id: "turbo8", label: "Turbo (8 steps)", hint: "Default" },
          { id: "turbo4", label: "Turbo (4 steps)", hint: "Faster draft; small faces in full-body views can smear" },
          { id: "fast8", label: "FastH3 (8 steps)", hint: "FastVideo's distilled H3 DiT" },
          { id: "off", label: "Quality (20 steps)", hint: "Base H3, about 2.5x the time" },
        ],
      },
    ],
    modelCheck: { pack: "minimax", action: "h3_charsheet" },
    requireStatusEntry: true,
    seedInput: true,
    credit:
      "View catalog + structured Ref2VA sheet prompt idea, MIT © ukr8b3g-cmyk (H3-Character-Sheet-Designer)",
  },
  {
    id: "ltx25_animate",
    title: "Animate (LTX-2.5)",
    subtitle:
      "Open-weights LTX-2.5: a still becomes a video clip with sound, 8+3 distilled steps",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "ltx25",
    text: {
      label: "What happens (optional)",
      placeholder: "she turns toward the camera as the wind picks up",
      required: false,
    },
    pickers: [ltx25DurationPicker],
    modelCheck: { pack: "ltx25", action: "ltx25_animate" },
    requireStatusEntry: true,
  },
  {
    id: "ltx25_transition",
    title: "Transition (LTX-2.5)",
    subtitle:
      "Open-weights LTX-2.5: a clip with sound from a start frame to an end frame",
    category: "Animate & 3D",
    icon: "Clapperboard",
    requiredPack: "ltx25",
    secondImage: "End frame",
    text: {
      label: "How it moves",
      placeholder: "the camera glides forward as day turns to night",
      required: false,
    },
    pickers: [ltx25DurationPicker],
    modelCheck: { pack: "ltx25", action: "ltx25_transition" },
    requireStatusEntry: true,
  },
  {
    id: "video_bg_remove",
    title: "Remove video background",
    subtitle: "Cut the subject out of a clip",
    category: "Animate & 3D",
    icon: "ImageOff",
    videoInput: "Source video",
    text: {
      label: "Who to keep",
      placeholder: "man in the blue vest",
      required: false,
      compact: true,
      hint: "They can walk in later, but a hard cut to another shot can lose them. Describe them so only one match fits; empty means the largest person. The tracker takes the closest match, so check the result.",
      showWhen: { key: "engine", value: "matanyone" },
    },
    pickers: [
      {
        key: "engine",
        title: "Keep",
        paramOnly: true,
        options: [
          {
            id: "birefnet",
            label: "Main subject",
            hint: "BiRefNet decides per frame what counts as the subject. Two people stay together.",
          },
          {
            id: "matanyone",
            label: "One named subject (non-commercial)",
            hint: "MatAnyone2 follows the person or object you name through the clip. Longer clips are cut: about 480 frames at 1080p, 120 at 4K. Its weights are non-commercial.",
            requiresTool: "subject_matte",
          },
        ],
      },
      {
        key: "background",
        title: "Background",
        options: [
          { id: "alpha", label: "Transparent" },
          { id: "green", label: "Green screen" },
        ],
      },
    ],
    modelCheck: { pack: "utility", action: "video_bg_remove" },
    requireStatusEntry: true,
  },
  {
    id: "video_bg_change",
    title: "Change video background",
    subtitle:
      "Put a clip's subject over a new background image, or blur the old one",
    category: "Animate & 3D",
    icon: "Layers",
    videoInput: "Source video (first 10 s)",
    videoWindow: { seconds: VIDEO_BG_CHANGE_MAX_SECONDS },
    secondImage: "New background (optional)",
    secondImageOptional: true,
    text: {
      label: "Who to keep",
      placeholder: "person",
      required: false,
      hint: "Short description for the tracker; everything else is replaced. Leave empty for every person.",
    },
    pickers: [
      {
        key: "background",
        title: "Background",
        options: [
          { id: "image", label: "Your image" },
          { id: "blur", label: "Blur original" },
        ],
      },
      {
        key: "blend",
        title: "Edge blend",
        options: [
          { id: "natural", label: "Natural" },
          { id: "strong", label: "Strong" },
          { id: "none", label: "None" },
        ],
      },
    ],
    modelCheck: { pack: "utility", action: "video_bg_change" },
    requireStatusEntry: true,
  },
  {
    id: "video_palette",
    title: "Video Color Palette",
    subtitle:
      "Regrade a clip to a palette or reference still: one flicker-free grade, plus a .cube LUT",
    category: "Animate & 3D",
    icon: "Palette",
    videoInput: "Source video",
    videoNote:
      "Any length; frames are graded on the CPU with one LUT fitted to the whole clip. The source audio is kept.",
    secondImage: "Reference still (for Match a reference)",
    secondImageOptional: true,
    text: {
      label: "Hex colors",
      placeholder: "#0b3c49, #1f7a8c, #e07a2f, #f2c48d",
      required: false,
      compact: true,
      hint: "Up to 16, comma separated; #rrggbb:weight pulls harder. The lightbox Palette's Copy hex pastes here.",
      showWhen: { key: "source", value: "hex" },
    },
    pickers: [
      {
        key: "source",
        title: "Palette from",
        options: [
          { id: "preset", label: "Preset" },
          { id: "hex", label: "Hex colors" },
          { id: "reference", label: "Match a reference" },
        ],
      },
      {
        key: "preset",
        title: "Preset",
        dropdown: true,
        options: VIDEO_PALETTE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
        showWhen: { key: "source", value: "preset" },
      },
      {
        key: "luminance",
        title: "Luminance",
        options: [
          { id: "regrade", label: "Regrade" },
          { id: "keep", label: "Keep source" },
        ],
      },
      {
        key: "skin",
        title: "Skin tones",
        options: [
          { id: "grade", label: "Grade" },
          { id: "protect", label: "Protect" },
        ],
      },
    ],
    sliders: [
      {
        key: "strength",
        title: "Strength",
        min: 0,
        max: 100,
        step: 5,
        default: VIDEO_PALETTE_DEFAULT_STRENGTH,
        unit: "%",
      },
    ],
    modelCheck: { pack: "utility", action: "video_palette" },
    nodePack: { id: "cj_h3_tools", nodes: ["CJVideoPalette"] },
    requireStatusEntry: true,
  },
  {
    id: "upscale_seedvr2",
    title: "Upscale (SeedVR2)",
    subtitle: "Restore detail while upscaling a photo or clip",
    category: "Enhance",
    icon: "Maximize2",
    pickers: [
      {
        key: "scale",
        title: "Size",
        options: [
          { id: "2x", label: "2x" },
          { id: "1080p", label: "1080p" },
          { id: "4k", label: "4K" },
        ],
      },
      SEEDVR2_MODEL_PICKER,
      SEEDVR2_COLOR_PICKER,
    ],
    sliders: UPSCALE_FINISH_SLIDERS,
    modelCheck: { pack: "seedvr2", action: "seedvr2_upscale" },
    requireStatusEntry: true,
  },
  {
    id: "upscale_vosr2",
    title: "Photo upscale (VOSR2)",
    subtitle:
      "One-step diffusion upscale, best for photos. Model folder: models/vosr2/VOSR2",
    category: "Enhance",
    icon: "Maximize2",
    pickers: [
      {
        key: "scale",
        title: "Size",
        options: [
          { id: "4x", label: "4x" },
          { id: "2x", label: "2x" },
        ],
        paramOnly: true,
      },
      {
        key: "color",
        title: "Color match",
        options: [
          {
            id: "wavelet",
            label: "Wavelet",
            hint: "Match low-frequency color, keep the upscaled fine detail",
          },
          {
            id: "adain",
            label: "AdaIN",
            hint: "Match per-channel mean and contrast: global tint only",
          },
          {
            id: "none",
            label: "Off",
            hint: "No color transfer: keep VOSR2's own colors",
          },
        ],
        paramOnly: true,
      },
    ],
    sliders: UPSCALE_FINISH_SLIDERS,
    modelCheck: { pack: "vosr2", action: "upscale_vosr2" },
    requireStatusEntry: true,
  },
  {
    id: "upscale_video",
    title: "Upscale video",
    subtitle: "Sharper, higher-res clip",
    category: "Animate & 3D",
    icon: "Maximize2",
    videoInput: "Source video",
    pickers: [
      {
        key: "engine",
        title: "Engine",
        options: [
          {
            id: "fast",
            label: "Fast",
            hint: "Every frame through your video upscaler (minutes)",
          },
          {
            id: "best",
            label: "Best (SeedVR2)",
            hint: "SeedVR2 diffusion restore: cleaner detail, much slower",
            requiresTool: "upscale_seedvr2",
          },
          {
            id: "flashvsr",
            label: "FlashVSR",
            hint: "FlashVSR v1.1 one-step video super-resolution on Wan 1.3B: sharp, temporally stable detail. Up to about 8 s at 1080p per run; longer clips are trimmed",
            requiresTool: "flashvsr_upscale",
          },
          {
            id: "rtx",
            label: "NVIDIA RTX (proprietary)",
            hint: "Fastest. Deterministic, not generative: sharpens without inventing detail. Needs an RTX GPU and NVIDIA's proprietary SDK (nvidia-vfx). Up to 240 frames at 4K per run; longer clips are trimmed",
            requiresTool: "rtx_upscale",
          },
          {
            id: "ltx_x2",
            label: "LTX ×2",
            hint: "LTX-2.5 IC-LoRA: exactly 2x, up to 1920 px; invents fine detail, best on generated clips. LTX-2 Community License (gated)",
            requiresTool: "ltx_upscale_x2",
          },
        ],
        paramOnly: true,
      },
      {
        key: "scale",
        title: "Size",
        options: [
          {
            id: "2x",
            label: "2x",
            hint: "Double the size. On large clips Best stops at 1080p, FlashVSR at 1440p and NVIDIA RTX at 4K",
          },
          { id: "1080p", label: "1080p" },
          {
            id: "4k",
            label: "4K",
            hint: "4K output (Best and FlashVSR cap clips at 1080p)",
          },
        ],
        showWhen: {
          key: "engine",
          oneOf: ["fast", "best", "flashvsr", "rtx"],
        },
      },
      { ...SEEDVR2_MODEL_PICKER, showWhen: { key: "engine", value: "best" } },
      { ...SEEDVR2_COLOR_PICKER, showWhen: { key: "engine", value: "best" } },
    ],
    // Fast engine model: UpscaleModelPicker (ToolRunner, video row default).
    modelCheck: { pack: "utility", action: VIDEO_UPSCALE_ACTION },
    requireStatusEntry: true,
  },
  {
    id: "ltx_restore",
    title: "Restore video",
    subtitle:
      "Repair old or damaged footage: deblur, remove compression, colorize, refine detail",
    category: "Animate & 3D",
    icon: "WandSparkles",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_RESTORE_MAX_FRAMES, fps: LTX_RESTORE_FPS },
    videoNote:
      "Uses the first 4 s (24 fps, up to 97 frames) at 960×544 (Refine details: 1024×576; vertical clips swap). Deinterlace first and do not pre-sharpen. For old footage run Restore before Refine details. Source audio kept.",
    text: {
      label: "Scene (optional)",
      placeholder: "a 1950s street market, women in summer dresses, cars",
      required: false,
      hint: "Describe what is in the shot (period, place, people, materials). Colorize and Restore use it to choose colors.",
    },
    pickers: [
      {
        key: "mode",
        title: "Mode",
        options: [
          {
            id: "ltx_restore",
            label: "Restore",
            hint: "Archival footage: scratches, flicker, tape/sepia casts, compression; colorizes monochrome",
          },
          {
            id: "ltx_restore_deblur",
            label: "Deblur",
            hint: "Out-of-focus shots back in focus (defocus, not motion blur)",
          },
          {
            id: "ltx_restore_decompress",
            label: "Decompress",
            hint: "Blocky, heavily compressed video: macroblocking, chroma bleed, ringing",
          },
          {
            id: "ltx_restore_colorize",
            label: "Colorize",
            hint: "Black-and-white footage to natural color",
          },
          {
            id: "ltx_restore_refine",
            label: "Refine details",
            hint: "Soft footage gets fine texture and crisp detail",
          },
        ],
      },
    ],
    sliders: [
      {
        key: "strength",
        title: "Strength",
        min: 0.5,
        max: 1.5,
        step: 0.05,
        default: 1,
        advanced: true,
        hint: "The model cards use 1.0. Lower (0.8) if halos or color bleed appear; Restore stops colorizing below about 0.8.",
      },
    ],
    seedInput: true,
    modelCheck: { pack: "ltx25", action: LTX_RESTORE_ACTION },
    requireStatusEntry: true,
  },
  {
    id: "interpolate",
    title: "Smooth motion / slow-mo",
    subtitle: "Add in-between frames",
    category: "Animate & 3D",
    icon: "Film",
    videoInput: "Source video",
    pickers: [
      {
        key: "mode",
        title: "Output",
        options: [
          { id: "smooth", label: "Smoother (more fps)" },
          { id: "slowmo", label: "Slow-mo (no audio)" },
        ],
      },
      {
        key: "multiplier",
        title: "Frames",
        options: [
          { id: "2", label: "2x" },
          { id: "4", label: "4x" },
        ],
      },
      {
        key: "model",
        title: "Model",
        options: [
          { id: "rife", label: "RIFE (fast)" },
          { id: "rife_heavy", label: "RIFE heavy" },
          { id: "film", label: "FILM (big motion)" },
        ],
      },
    ],
    modelCheck: { pack: "interp", action: "interpolate" },
    requireStatusEntry: true,
  },
  {
    id: "relight",
    title: "Relight",
    subtitle: "Change the lighting of a photo, or match another photo's light",
    category: "Enhance",
    icon: "Lightbulb",
    secondImage: "Light reference (for Match a reference)",
    secondImageOptional: true,
    text: {
      label: "Lighting details",
      placeholder: "e.g. light coming from the window on the left",
      required: false,
      hint: "Optional; required for Custom.",
    },
    pickers: [
      {
        key: "preset",
        title: "Light",
        options: [
          { id: "golden_hour", label: "Golden hour" },
          { id: "neon_night", label: "Neon night" },
          { id: "studio_softbox", label: "Studio softbox" },
          { id: "rim_light", label: "Rim light" },
          { id: "overcast", label: "Overcast" },
          { id: "candlelight", label: "Candlelight" },
          { id: "sunset_backlight", label: "Sunset backlight" },
          { id: "moonlight", label: "Moonlight" },
          { id: "custom", label: "Custom" },
          {
            id: "reference",
            label: "Match a reference",
            requiresTool: "light_migration",
            hint: "Copy the light and color tone of the reference photo",
          },
        ],
      },
      {
        key: "faceDetail",
        title: "Faces",
        paramOnly: true,
        showWhen: { key: "preset", value: "reference" },
        options: [
          {
            id: "keep",
            label: "Keep detail",
            hint: "Faces keep their own detail under the new light",
          },
          {
            id: "model",
            label: "Redraw",
            hint: "Use the model's output as is",
          },
        ],
      },
    ],
    modelCheck: { pack: "qwen-edit-2509", action: "relight" },
    requireStatusEntry: true,
  },
  {
    id: "wan_motion",
    title: "Motion presets",
    subtitle:
      "200+ camera moves and effects for your photo; 60+ also on LTX-2.5 with sound",
    category: "Animate & 3D",
    icon: "Sparkles",
    requiredPack: "wan22",
    text: {
      label: "Subject (optional)",
      placeholder: "a red fox",
      required: false,
      hint: "Named in the preset's motion prompt. With None, this is the whole prompt.",
    },
    pickers: [
      {
        key: "preset",
        title: "Preset",
        options: WAN_MOTION_OPTIONS,
        dropdown: true,
      },
      WAN_MOTION_ENGINE_PICKER,
      ...WAN_VIDEO_PICKERS.map((p) =>
        p.key === "duration"
          ? { ...p, options: [WAN_AUTO_LENGTH, ...p.options] }
          : p,
      ),
    ],
    modelCheck: { pack: "wan22", action: "wan_motion" },
    requireStatusEntry: true,
  },
  {
    id: "wan_camera",
    title: "Camera control",
    subtitle: "Pan, tilt, zoom or roll the camera with Wan 2.2 Fun Camera",
    category: "Animate & 3D",
    icon: "Camera",
    requiredPack: "wan22",
    text: {
      label: "Scene (optional)",
      placeholder: "a red fox standing in falling snow",
      required: false,
    },
    pickers: [
      {
        key: "camera",
        title: "Camera move",
        options: WAN_CAMERA_POSES.map(({ id, label }) => ({ id, label })),
        paramOnly: true,
      },
      {
        key: "cameraSpeed",
        title: "Move speed",
        options: WAN_CAMERA_SPEEDS.map(({ id, label }) => ({ id, label })),
      },
      ...WAN_VIDEO_PICKERS,
    ],
    modelCheck: { pack: "wan22", action: "wan_camera" },
    requireStatusEntry: true,
  },
  {
    id: "wan_move",
    title: "Trajectory motion",
    subtitle:
      "Drag part of your photo along a path: slide, arc, swirl, or draw your own",
    category: "Animate & 3D",
    icon: "Film",
    requiredPack: "wan22",
    text: {
      label: "Subject (optional)",
      placeholder: "the red balloon",
      required: false,
      hint: "What sits in the chosen region; named in the motion prompt.",
    },
    pickers: [
      {
        key: "source",
        title: "Motion",
        options: [
          { id: "preset", label: "Preset path" },
          { id: "draw", label: "Draw your own" },
        ],
      },
      {
        key: "trajectory",
        title: "Path",
        options: WAN_MOVE_TRAJECTORIES.map(({ id, label }) => ({ id, label })),
        showWhen: { key: "source", value: "preset" },
      },
      {
        key: "region",
        title: "Region",
        options: WAN_MOVE_REGIONS.map(({ id, label }) => ({ id, label })),
        showWhen: { key: "source", value: "preset" },
      },
      { key: "mode", title: "Speed", options: WAN_MODES },
      {
        key: "duration",
        title: "Length",
        options: WAN_LENGTHS.map(({ id, label }) => ({ id, label })),
      },
    ],
    modelCheck: { pack: "wan22", action: "wan_move" },
    requireStatusEntry: true,
  },
  {
    id: "vace_restyle",
    title: "Restyle video",
    subtitle:
      "Re-render a clip in a new style or light; motion and layout follow the source",
    category: "Animate & 3D",
    icon: "Paintbrush",
    videoInput: "Source video",
    videoWindow: { maxFrames: VACE_MAX_LENGTH, fps: VACE_FPS },
    secondImage: "Style reference (optional)",
    secondImageOptional: true,
    text: {
      label: "New look",
      placeholder:
        "hand-painted anime, soft watercolor background, cel shading",
      required: false,
      hint: "Pick a Look or Relight preset, type a look, or both (your text is added to the preset). Uses the first 5 s of the clip (16 fps, ~480p). Audio is not kept.",
    },
    pickers: [vaceLookPicker, vaceLightPicker, vaceSpeedPicker],
    modelCheck: { pack: "wan22", action: "vace_restyle" },
    requireStatusEntry: true,
  },
  {
    id: "vace_reframe",
    title: "Reframe video",
    subtitle: "Change a clip's aspect ratio: the model paints in the new edges",
    // Retired: Expand video (video_expand, LTX default; its "Change aspect"
    // modes) replaces it; its card key aliases there (toolRegistry.ts).
    // Kept so old runs, slots and links still resolve.
    hidden: true,
    category: "Expand",
    icon: "Expand",
    videoInput: "Source video",
    videoWindow: { maxFrames: VACE_MAX_LENGTH, fps: VACE_FPS },
    text: {
      label: "Scene description",
      placeholder: "aerial shot of a red car on a coastal cliff road at sunset",
      required: true,
      hint: "Uses the first 5 s of the clip (16 fps, ~480p). Audio is not kept.",
    },
    pickers: [
      {
        key: "aspect",
        title: "Aspect",
        options: [
          { id: "9:16", label: "9:16" },
          { id: "16:9", label: "16:9" },
          { id: "1:1", label: "1:1" },
          { id: "4:5", label: "4:5" },
        ],
      },
      vaceSpeedPicker,
    ],
    modelCheck: { pack: "wan22", action: "vace_reframe" },
    requireStatusEntry: true,
  },
  {
    id: "video_expand",
    title: "Expand video",
    // ≤ 90 chars (toolsA11y).
    subtitle: `Zoom out, widen or extend a side; first ${VIDEO_EXPAND_LTX_MAX_FRAMES} frames (~${VIDEO_EXPAND_LTX_WINDOW_SECONDS} s), new border only`,
    category: "Expand",
    icon: "Expand",
    videoInput: "Source video",
    // Native fps: no `fps` (the window is 121 frames at the clip's own rate).
    videoWindow: { maxFrames: VIDEO_EXPAND_LTX_MAX_FRAMES },
    videoNote: `Uses ${VIDEO_EXPAND_LTX_MAX_FRAMES} frames at the clip's own fps (~${VIDEO_EXPAND_LTX_WINDOW_SECONDS} s at 24 fps; trimmed to 8n+1) from the start frame, or ${VIDEO_EXPAND_VACE_MAX_FRAMES} with the experimental Wan engine; the rest of the clip is cut. Fps and audio are kept (audio trimmed to the same window).`,
    text: {
      label: "Scene description",
      placeholder: "a ceramic fox on a white table in a bright studio",
      required: true,
      hint: `Say what is in the shot and around it: the outpaint model needs the scene, and a generic prompt tends to leave black borders. Dark or night clips can come back with black borders even with a scene description (LTX engine), so use well-lit footage. LTX-2.5 + IC-LoRA Outpaint generates the wider shot at ~1024 px (1280 option) around the source on a black canvas; the original frames are pasted back over the centre unchanged, with a soft seam inside the original edge. Zoom out 2× regenerates 3/4 of the frame, so the border is softer than at 1.25-1.5×. Wan2.2 VACE is experimental (weaker borders). Expanded frame max ${VIDEO_EXPAND_MAX_EDGE} px on the long side (bigger sources are scaled down first). The output is re-encoded (H.264). Needs a CUDA GPU with ~24 GB VRAM: the int8 LTX / fp8 Wan weights don't run on Apple Silicon (MPS).`,
    },

    pickers: [
      {
        key: "expand",
        title: "Expand",
        options: Object.entries(VIDEO_EXPAND_MODES).map(
          ([id, { label, group }]) => ({ id, label, group }),
        ),
        dropdown: true,
        // Mode ids (pan_left…) are params; "pan_left" etc. are also image
        // actions (SDXL outpaint) that must not leak into this card's models.
        paramOnly: true,
        optionIssue: (id, v) => videoExpandModeIssue(id, v.width, v.height),
      },
      {
        key: "engine",
        title: "Engine",
        // First = default: LTX. Wan VACE stays opt-in (experimental).
        options: [
          {
            id: VIDEO_EXPAND_DEFAULT_ENGINE,
            label: VIDEO_EXPAND_ENGINES[VIDEO_EXPAND_DEFAULT_ENGINE].label,
          },
          { id: "wan", label: VIDEO_EXPAND_ENGINES.wan.label },
        ],
        paramOnly: true,
      },
      {
        key: "res",
        title: "Resolution",
        options: [
          { id: String(VIDEO_EXPAND_LTX_DEFAULT_EDGE), label: "1024 px" },
          { id: "1280", label: "1280 px (more VRAM)" },
        ],
        paramOnly: true,
        showWhen: { key: "engine", value: "ltx" },
      },
      { ...vaceSpeedPicker, showWhen: { key: "engine", value: "wan" } },
    ],
    sliders: [
      // Frames skipped before the window (0 = clip start; 240 = 10 s at 24 fps).
      { key: "start_frame", title: "Start frame", min: 0, max: 1440, step: 1, default: 0 },
    ],
    modelCheck: { pack: "ltx25", action: "video_expand" },
    requireStatusEntry: true,
  },
  {
    id: "video_retake",
    title: "Retake video",
    // ≤ 90 chars (toolsA11y).
    subtitle: `Regenerate a time range, keep the rest; first ${VIDEO_RETAKE_MAX_FRAMES} frames (~${VIDEO_RETAKE_WINDOW_SECONDS} s)`,
    category: "Animate & 3D",
    icon: "Clapperboard",
    videoInput: "Source video",
    videoWindow: { maxFrames: VIDEO_RETAKE_MAX_FRAMES },
    videoNote: `Uses the first ${VIDEO_RETAKE_MAX_FRAMES} frames at the clip's own fps (~${VIDEO_RETAKE_WINDOW_SECONDS} s at 24 fps); the rest of the clip is cut. Only the range is regenerated: frames outside it are the source frames. For a longer clip, mark In/Out in the Edit tab and use Retake there (it cuts a window around the range and puts the result back).`,
    text: {
      label: "What happens in the range",
      placeholder: "she turns to the camera and smiles",
      required: true,
      hint: "Describe the new moment (scene + action). LTX-2.5 distilled regenerates the range with the frames around it as context, so motion continues into and out of it; a short blend at each edge hides the seam. Lower Change keeps more of the original motion. Range times are seconds from the clip start; End at the right end of the slider = to the end of the clip. The output is re-encoded (H.264). Needs a CUDA GPU with ~24 GB VRAM: the int8 LTX weights don't run on Apple Silicon (MPS).",
    },
    pickers: [
      {
        key: "audio",
        title: "Audio",
        options: (
          Object.entries(VIDEO_RETAKE_AUDIO_MODES) as [string, { label: string }][]
        ).map(([id, { label }]) => ({ id, label })),
        paramOnly: true,
      },
      {
        key: "res",
        title: "Resolution",
        options: [
          { id: String(VIDEO_RETAKE_DEFAULT_EDGE), label: "1024 px" },
          { id: "768", label: "768 px (faster)" },
        ],
        paramOnly: true,
      },
    ],
    sliders: [
      { key: "retake_start", title: "Range start", min: 0, max: VIDEO_RETAKE_WINDOW_SECONDS, step: 0.1, default: 2, unit: " s" },
      { key: "retake_end", title: "Range end", min: 0.1, max: VIDEO_RETAKE_WINDOW_SECONDS, step: 0.1, default: 3.5, unit: " s" },
      {
        key: "strength",
        title: "Change",
        min: VIDEO_RETAKE_MIN_STRENGTH,
        max: 1,
        step: 0.05,
        default: 1,
        hint: "1 = new take; lower keeps more of the original motion in the range.",
      },
    ],
    seedInput: true,
    modelCheck: { pack: "ltx25", action: "video_retake" },
    requireStatusEntry: true,
  },
  {
    id: "vace_extend",
    title: "Extend video",
    subtitle: "Continue a clip: the model generates what happens next",
    category: "Animate & 3D",
    icon: "Film",
    videoInput: "Source video",
    videoWindow: { maxFrames: VACE_EXTEND_MAX_SOURCE, fps: VACE_FPS },
    text: {
      label: "What happens next",
      placeholder: "the car keeps driving along the coast",
      required: false,
      hint: "Output is the clip (up to its first 20 s; less for 1080p+ or high frame rates) at its own resolution, frame rate and sound, plus the new seconds (generated at ~480p/16 fps, then upscaled, color-matched and retimed to fit). Clips over 1080p come out at 1080p.",
    },
    pickers: [
      {
        key: "seconds",
        title: "Add",
        options: [
          { id: "3", label: "3 s" },
          { id: "2", label: "2 s" },
          { id: "4", label: "4 s" },
        ],
      },
      vaceSpeedPicker,
    ],
    sliders: [
      {
        key: "color_match",
        title: "Color match",
        min: 0,
        max: 100,
        step: 5,
        default: 100,
        unit: "%",
        advanced: true,
        hint: "How strongly the new seconds are pulled to the clip's colors (LAB mean/std of its last second).",
      },
    ],
    modelCheck: { pack: "wan22", action: "vace_extend" },
    requireStatusEntry: true,
  },
  {
    id: "shots",
    title: "Shots",
    subtitle: "One image, nine camera setups of the same scene",
    category: "Enhance",
    icon: "Camera",
    text: {
      label: "Extra direction",
      placeholder: "e.g. keep the warm evening light",
      required: false,
      hint: "Optional; added to every shot. Returns a 3x3 contact sheet plus the nine shots: establishing, wide, medium, close-up, over the shoulder, low angle, high angle, profile, detail.",
    },
    modelCheck: { pack: "qwen-edit-2509", action: "shots" },
    requireStatusEntry: true,
  },
  {
    id: "zooms",
    title: "Zooms",
    subtitle: "Nine-step zoom ladder from extreme wide to macro",
    category: "Enhance",
    icon: "ZoomIn",
    text: {
      label: "Zoom target",
      placeholder: "e.g. the necklace",
      required: false,
      hint: "Optional; what the tight steps close in on (default: the face, then the eyes). Returns a 3x3 contact sheet plus the nine steps.",
    },
    modelCheck: { pack: "qwen-edit-2509", action: "zooms" },
    requireStatusEntry: true,
  },
  {
    id: "layers",
    title: "Layers",
    subtitle:
      "Split an image into transparent layers: background, subject, props",
    category: "Edit",
    icon: "Layers",
    text: {
      label: "Caption",
      placeholder: "e.g. a red bicycle leaning against a brick wall",
      required: false,
      hint: "Optional; a short description of the image can improve the split. Returns a flattened preview plus each layer as a transparent PNG, back to front. Extra layers can come back empty on simple scenes.",
    },
    pickers: [
      {
        key: "layers",
        title: "Layers",
        options: [
          { id: "4", label: "4" },
          { id: "3", label: "3" },
          { id: "6", label: "6" },
        ],
      },
      {
        key: "resolution",
        title: "Resolution",
        options: [
          { id: "640", label: "640 px" },
          { id: "1024", label: "1024 px (slow)" },
        ],
      },
      {
        key: "speed",
        title: "Speed",
        options: [
          { id: "fast", label: "Fast (20 steps)" },
          { id: "best", label: "Best (50 steps, slow)" },
        ],
      },
    ],
    modelCheck: { pack: "qwen-layered", action: "layers" },
    requireStatusEntry: true,
  },
  {
    id: "vectorize",
    title: "Vectorize",
    subtitle:
      "Trace an image into a scalable SVG: logos, flat art, poster looks",
    category: "Edit",
    icon: "PenTool",
    pickers: [
      {
        key: "preset",
        title: "Style",
        options: [
          { id: "logo", label: "Logo (few colors, sharp)" },
          { id: "illustration", label: "Illustration (smooth curves)" },
          { id: "poster", label: "Photo to poster" },
        ],
      },
      {
        key: "colors",
        title: "Colors",
        options: [
          { id: "0", label: "Auto" },
          { id: "4", label: "4" },
          { id: "8", label: "8" },
          { id: "16", label: "16" },
          { id: "32", label: "32" },
        ],
      },
    ],
    modelCheck: { pack: "image-tools", action: "vectorize" },
    nodePack: { id: "cj_image_tools", nodes: ["CJVectorize"] },
    requireStatusEntry: true,
  },
  {
    id: "breakdown",
    title: "Breakdown",
    subtitle:
      "Cut every person, garment and prop out as its own transparent PNG",
    category: "Edit",
    icon: "Scissors",
    text: {
      label: "Parts",
      placeholder: "person, clothing, bag, background objects",
      required: false,
      hint: "Comma-separated things to cut out (max 8). Add :N to a part to cap how many it finds (default 4). Returns a labeled contact sheet plus each cutout as a transparent PNG.",
    },
    modelCheck: { pack: "image-tools", action: "breakdown" },
    // SAM3_Detect is core ComfyUI (comfy_extras.nodes_sam3); its weights
    // are reported as missing models.
    nodePack: { id: "cj_image_tools", nodes: ["CJCutouts"] },
    requireStatusEntry: true,
  },
  {
    id: "see_through",
    title: "Layer Split",
    subtitle:
      "Split an illustration into ~24 depth-ordered parts with hidden areas filled in",
    category: "Edit",
    icon: "Layers",
    pickers: [
      {
        key: "detail",
        title: "Detail",
        paramOnly: true,
        options: [
          { id: "max", label: "Max (1280 px)" },
          { id: "fast", label: "Fast (1024 px)" },
        ],
      },
      {
        key: "steps",
        title: "Steps",
        paramOnly: true,
        options: [
          { id: "30", label: "30" },
          { id: "20", label: "20 (faster)" },
        ],
      },
      {
        key: "split",
        title: "Split left/right parts",
        paramOnly: true,
        hint: "Eyes, ears, hands and other paired parts become separate left and right layers.",
        options: [
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ],
      },
      {
        key: "lowVram",
        title: "Low VRAM",
        paramOnly: true,
        hint: "Offloads model groups to the CPU: about 10 GB peak, roughly 1.5x slower.",
        options: [
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ],
      },
    ],
    seedInput: true,
    // ComfyUI-See-through node pack; SDXL LayerDiff3D + Marigold under models/SeeThrough/.
    modelCheck: { pack: "image-tools", action: "see_through" },
    requireStatusEntry: true,
    credit: "Layers by see-through (shitagaki-lab, MIT node pack; weights RAIL++-M)",
  },
  {
    id: "refocus",
    title: "Refocus",
    subtitle: "Click what should be sharp: real depth-of-field blur from a depth map",
    category: "Edit",
    icon: "Aperture",
    pickers: refocusPickers,
    sliders: refocusSliders,
    modelCheck: { pack: "image-tools", action: "refocus" },
    requireStatusEntry: true,
  },
  {
    id: "rack_focus",
    title: "Rack focus",
    subtitle: "Pull focus from one subject to another during a clip",
    category: "Animate & 3D",
    icon: "Aperture",
    videoInput: "Source video",
    videoWindow: { maxFrames: RACK_FOCUS_MAX_FRAMES },
    videoNote: `Depth is estimated per frame; the first ${RACK_FOCUS_MAX_FRAMES} frames are processed, at the clip's own frame rate, with its sound.`,
    pickers: [
      {
        key: "ease",
        title: "Focus pull",
        options: [
          { id: "smooth", label: "Smooth" },
          { id: "linear", label: "Linear" },
          { id: "ease_in", label: "Slow start" },
          { id: "ease_out", label: "Slow landing" },
        ],
        paramOnly: true,
      },
      ...refocusPickers,
    ],
    sliders: refocusSliders,
    modelCheck: { pack: "image-tools", action: "rack_focus" },
    requireStatusEntry: true,
  },
  {
    id: "sdr_to_hdr",
    title: "SDR to HDR",
    subtitle:
      "Expand a photo to HDR: a 10-bit HLG AVIF to view plus a linear EXR master",
    category: "Enhance",
    icon: "Contrast",
    sliders: [
      {
        key: "peak",
        title: "Peak brightness",
        min: 0,
        max: 4000,
        step: 50,
        default: SDR_TO_HDR_DEFAULT_PEAK,
        unit: " nits",
        hint: "How bright the brightest whites get. 0 keeps the node's calibrated rendering. Dark images are not pushed up to this peak.",
      },
    ],
    pickers: [
      {
        key: "exr",
        title: "EXR master",
        options: [
          { id: "half", label: "16-bit half float" },
          { id: "float", label: "32-bit float" },
        ],
        paramOnly: true,
      },
    ],
    modelCheck: { pack: "image-tools", action: "sdr_to_hdr" },
    requireStatusEntry: true,
  },
  {
    id: "video_edit",
    title: "Edit video",
    subtitle:
      "Change a clip with words: swap an outfit, add an object, restyle; motion is kept",
    category: "Animate & 3D",
    icon: "WandSparkles",
    videoInput: "Source video",
    videoWindow: { maxFrames: VACE_MAX_LENGTH, fps: VACE_FPS },
    text: {
      label: "Edit instruction",
      placeholder: "change the shirt to a red leather jacket",
      required: true,
      hint: "Describe the change, starting with a verb (change, add, replace, turn into). Uses the first 5 s of the clip (16 fps, ~480p). Audio is not kept. Non-commercial model license.",
    },
    pickers: [
      {
        key: "speed",
        title: "Quality",
        options: [
          { id: "balanced", label: "Balanced (30 steps)" },
          { id: "fast", label: "Fast (20 steps)" },
          { id: "best", label: "Best (40 steps)" },
        ],
      },
    ],
    modelCheck: { pack: "wan22", action: "video_edit" },
    requireStatusEntry: true,
  },
  // LTX VFX: six Lightricks LTX-2.5 LoRAs (4 IC-LoRA video-to-video, 2 image
  // to video) on the distilled LTX-2.5 22B. src/lib/oj/ltxVfx.ts.
  {
    id: "ltx_alpha_matte",
    title: "Alpha Matte",
    subtitle:
      "LTX VFX: turn a clip into a black-and-white alpha matte for compositing (white = subject)",
    category: "LTX VFX",
    icon: "Contrast",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_alpha_matte.maxFrames, fps: LTX_VFX_SPECS.ltx_alpha_matte.fps },
    videoNote:
      "Uses the first 4 s (24 fps, up to 97 frames), center-cropped to 960×544 (or 544×960 for vertical clips). Output is a grayscale matte video: white = keep, black = cut out. Use it as a luma matte in your editor or compositor. No prompt needed.",
    modelCheck: { pack: "ltx25", action: "ltx_alpha_matte" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_clean_plate",
    title: "Clean Plate",
    subtitle:
      "LTX VFX: remove the people from a shot and get the empty background plate",
    category: "LTX VFX",
    icon: "Eraser",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_clean_plate.maxFrames, fps: LTX_VFX_SPECS.ltx_clean_plate.fps },
    videoNote:
      "Uses the first 4 s (25 fps, up to 97 frames), center-cropped to 1024×576 (or 576×1024). No mask needed. Best when people cover less than half the frame. Source audio kept.",
    text: {
      label: "Scene (optional)",
      placeholder: "a cobblestone square with a fountain and parked bikes",
      required: false,
      hint: "Describe what should remain, not what to remove. Name objects that must stay so they are not erased.",
    },
    modelCheck: { pack: "ltx25", action: "ltx_clean_plate" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_day_to_night",
    title: "Day to Night",
    subtitle:
      "LTX VFX: relight a daytime clip as night; framing, camera move and motion stay identical",
    category: "LTX VFX",
    icon: "Moon",
    videoInput: "Daytime clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_day_to_night.maxFrames, fps: LTX_VFX_SPECS.ltx_day_to_night.fps },
    videoNote:
      "Uses the first 4 s (24 fps, up to 97 frames) at 768×448 (or 448×768). Source audio kept.",
    text: {
      label: "Night look (optional)",
      placeholder: "warm street lamps, lit windows, clear starry sky",
      required: false,
      hint: "Describe the night lighting. Everything else is locked to the source clip.",
    },
    modelCheck: { pack: "ltx25", action: "ltx_day_to_night" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_add_water",
    title: "Add Water",
    subtitle:
      "LTX VFX: add water to a clip: floods, rain, splashes, wet streets",
    category: "LTX VFX",
    icon: "Droplets",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_add_water.maxFrames, fps: LTX_VFX_SPECS.ltx_add_water.fps },
    videoNote:
      "Uses the first 5 s (24 fps, up to 121 frames) at 960×544 (or 544×960). Source audio kept.",
    text: {
      label: "Water to add",
      placeholder: "the street floods knee-deep and rain ripples the surface",
      required: true,
      hint: "Describe only the water. People, clothing, framing and background stay identical to the source.",
    },
    pickers: [
      {
        key: "strength",
        title: "Intensity",
        options: [
          { id: "1", label: "Natural" },
          { id: "1.25", label: "Strong" },
          { id: "1.45", label: "Dramatic" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_add_water" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_cinemagraph",
    title: "Cinemagraph",
    subtitle:
      "LTX VFX: bring one part of a photo to life while the rest stays frozen, as a seamless loop",
    category: "LTX VFX",
    icon: "Repeat",
    text: {
      label: "What moves",
      placeholder: "the waterfall",
      required: true,
      hint: "Name one element: hair in the wind, steam from a cup, a flag. The camera stays locked and everything else holds still. 704×512 (or 512×704), 24 fps.",
    },
    pickers: [
      {
        key: "frames",
        title: "Loop length",
        options: [
          { id: "25", label: "1 s (best)" },
          { id: "49", label: "2 s" },
          { id: "97", label: "4 s" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_cinemagraph" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_slow_motion",
    title: "Slow Motion",
    subtitle:
      "LTX VFX: animate a photo as true slow motion, from 2× to 40× slower",
    category: "LTX VFX",
    icon: "Timer",
    text: {
      label: "Action",
      placeholder:
        "a dancer spins and her skirt flares out, droplets fly from her hair",
      required: true,
      hint: 'Describe the action at normal speed. Don\'t write "slow motion": the Speed setting controls it. 5 s at 24 fps, 1280×704 (or 704×1280).',
    },
    pickers: [
      {
        key: "speed",
        title: "Speed",
        options: [
          { id: "0.2", label: "5× slower" },
          { id: "0.5", label: "2× slower" },
          { id: "0.1", label: "10× slower" },
          { id: "0.05", label: "20× slower" },
          { id: "0.025", label: "40× slower" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_slow_motion" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_ripple",
    title: "Ripple Edit",
    subtitle:
      "LTX VFX: edit a clip's first frame anywhere; the edit carries through the whole shot",
    category: "LTX VFX",
    icon: "Waves",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_ripple.maxFrames, fps: LTX_VFX_SPECS.ltx_ripple.fps },
    videoNote:
      "Uses the first 5 s (24 fps, up to 121 frames) at 960×544 (or 544×960). Export the clip's first frame, edit it (new lighting, an object, a material, a style), then add it below. Motion, timing and camera come from the clip. Source audio kept.",
    secondImage: "Edited first frame",
    text: {
      label: "What changed (optional)",
      placeholder: "the jacket is now bright red leather",
      required: false,
      hint: "Ripple works without a prompt; a short description helps difficult edits.",
    },
    pickers: [
      {
        key: "strength",
        title: "Edit strength",
        options: [
          { id: "1.35", label: "Card default" },
          { id: "1.1", label: "Lighter (keeps more of the clip)" },
          { id: "1.6", label: "Stronger (carries big edits)" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_ripple" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_edge_control",
    title: "Edge Control",
    subtitle:
      "LTX VFX: keep a clip's motion and layout (canny edges), restyled from your prompt",
    category: "LTX VFX",
    icon: "Spline",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_edge_control.maxFrames, fps: LTX_VFX_SPECS.ltx_edge_control.fps },
    videoNote:
      "Uses the first 4 s (24 fps, up to 97 frames) at 960×512 (or 512×960). Edges are traced in the graph; no audio of its own, source audio kept. Union Control was trained on LTX-2.3, so expect looser edge following than on its own base.",
    text: {
      label: "New look",
      placeholder: "a watercolor painting of a harbor at dawn",
      required: true,
      hint: "Describe the whole scene as it should look. Layout and motion follow the source clip.",
    },
    modelCheck: { pack: "ltx25", action: "ltx_edge_control" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_blockout_render",
    title: "Blockout to Render",
    subtitle:
      "LTX VFX: render a grey 3D blockout clip as a finished shot, keeping its layout and camera",
    category: "LTX VFX",
    icon: "Box",
    videoInput: "Blockout clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_blockout_render.maxFrames, fps: LTX_VFX_SPECS.ltx_blockout_render.fps },
    videoNote:
      "Uses the first 4 s (24 fps, up to 97 frames) at 960×512 (or 512×960). Render the blockout from any 3D app (grey boxes and proxies are enough); Depth Anything 3 traces its depth in the graph. Source audio kept. Union Control was trained on LTX-2.3, so expect looser following than on its own base.",
    text: {
      label: "Final look",
      placeholder:
        "a rain-soaked neon street at night, a woman in a red coat walks toward camera",
      required: true,
      hint: "Describe every material, light and character of the final shot. Layout, scale and camera motion come from the blockout.",
    },
    modelCheck: { pack: "ltx25", action: "ltx_blockout_render" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_sdr_to_hdr",
    title: "SDR to HDR (video)",
    subtitle:
      "LTX VFX: regrade an SDR clip as HDR, a 10-bit HLG video plus ACEScg EXR frames",
    category: "LTX VFX",
    icon: "Contrast",
    videoInput: "SDR clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_sdr_to_hdr.maxFrames, fps: LTX_VFX_SPECS.ltx_sdr_to_hdr.fps },
    videoNote:
      "Uses the first 5 s (24 fps, up to 121 frames), center-cropped to 960×544 (or 544×960). The video is 10-bit HLG (Rec.2020) AV1 for HDR displays; the scene-linear ACEScg EXR frames are under Other outputs for grading. No prompt needed. Source audio kept.",
    pickers: [
      {
        key: "exr",
        title: "EXR master",
        options: [
          { id: "half", label: "16-bit half float" },
          { id: "float", label: "32-bit float" },
        ],
        paramOnly: true,
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_sdr_to_hdr" },
    requireStatusEntry: true,
    ownMaster: true,
  },
  {
    id: "ltx_layout_render",
    title: "Layout to Render",
    subtitle:
      "LTX VFX: turn a layout or greybox clip into a finished shot, keeping layout and camera",
    category: "LTX VFX",
    icon: "Box",
    videoInput: "Layout clip",
    videoWindow: { maxFrames: LTX_VFX_SPECS.ltx_layout_render.maxFrames, fps: LTX_VFX_SPECS.ltx_layout_render.fps },
    videoNote:
      "Uses the first 3.4 s (24 fps, up to 81 frames), rendered in two stages to 1920×1088 (or 1088×1920). A viewport playblast or greybox is enough; clay shading isn't needed. Source audio kept.",
    secondImage: "Look frame (optional, recommended)",
    secondImageOptional: true,
    text: {
      label: "Finished shot",
      placeholder:
        "a sunlit Tuscan courtyard at golden hour, a woman in a linen dress walks past the fountain",
      required: true,
      hint: 'One or two sentences describing the final shot as seen in its first frame. Don\'t write "clay", "3D" or engine names. For a set art direction, render the layout\'s first frame into a finished still with an image edit tool and add it as the look frame.',
    },
    modelCheck: { pack: "ltx25", action: "ltx_layout_render" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_ingredients",
    title: "Ingredients",
    subtitle:
      "LTX VFX: compose a shot from up to four reference images (characters, props, location)",
    category: "LTX VFX",
    icon: "LayoutGrid",
    firstImage: "Ingredient 1 (main subject, or a finished sheet)",
    secondImage: "Ingredient 2 (optional)",
    secondImageOptional: true,
    extraImages: ["Ingredient 3 (optional)", "Ingredient 4 (optional)"],
    text: {
      label: "Generated video",
      placeholder:
        "the woman picks up the red guitar and plays it on the rooftop at sunset, the camera slowly circles her",
      required: true,
      hint: "Describe the action, camera and sound. Use clean images on plain or black backgrounds, one element each (a face close-up, a product shot, a location); larger panels keep more detail. 5 s at 24 fps, 768×448 (or 448×768).",
    },
    secondText: {
      label: "Reference sheet (optional)",
      placeholder:
        "Panel 1: a woman with short black hair in a yellow raincoat. Panel 2: a red electric guitar. Panel 3: a city rooftop.",
      required: false,
      hint: "Describe each panel in order. Empty: a generic description is used.",
    },
    pickers: [
      {
        key: "strength",
        title: "Reference strength",
        options: [
          { id: "1.4", label: "Card default" },
          { id: "1.2", label: "Looser" },
          { id: "1.6", label: "Stricter" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_ingredients" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_reshoot",
    title: "Re-shoot",
    subtitle:
      "LTX VFX: shoot a clip again from a new camera angle (Qwen 2.1 camera angles, then LTX-2.5)",
    category: "LTX VFX",
    icon: "Camera",
    videoInput: "Source clip",
    videoWindow: { maxFrames: LTX_RESHOOT_MAX_FRAMES, fps: LTX_RESHOOT_FPS },
    videoNote:
      "Up to the first 5 s. The first frame is re-rendered from the picked angle (anything the original hides is imagined), then LTX-2.5 animates it from your description with new sound. The motion is re-generated, not copied frame for frame from the clip.",
    text: {
      label: "What happens in the shot",
      placeholder: "the chef flips the pancake and catches it, steam rising",
      required: true,
      hint: "Describe the action of the original clip; the new angle is added for you.",
    },
    pickers: [
      reshootPicker("orbit", "Orbit", LTX_RESHOOT_ORBITS, LTX_RESHOOT_DEFAULTS.orbit),
      reshootPicker("height", "Height", LTX_RESHOOT_HEIGHTS, LTX_RESHOOT_DEFAULTS.height),
      reshootPicker(
        "distance",
        "Distance",
        LTX_RESHOOT_DISTANCES,
        LTX_RESHOOT_DEFAULTS.distance,
      ),
    ],
    modelCheck: { pack: "ltx25", action: "ltx_reshoot" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_exploded_view",
    title: "Exploded View",
    subtitle:
      "LTX VFX: a product photo comes apart into an ordered exploded view of its parts",
    category: "LTX VFX",
    icon: "Boxes",
    text: {
      label: "Object",
      placeholder: "vintage film camera",
      required: false,
      hint: 'Name the object (and its parts if you like). A full prompt with "exploded view" is used as written. 5 s at 24 fps, 960×544 (or 544×960). Works best on a clean product shot.',
    },
    pickers: [
      {
        key: "strength",
        title: "Effect strength",
        options: [
          { id: "0.5", label: "Card default" },
          { id: "0.75", label: "Stronger" },
        ],
      },
    ],
    modelCheck: { pack: "ltx25", action: "ltx_exploded_view" },
    requireStatusEntry: true,
  },
  {
    id: "ltx_paint_fluid",
    title: "Paint Fluid",
    subtitle:
      "LTX VFX: paint flat color blobs on a frame; they turn into smoke, steam or fire",
    category: "LTX VFX",
    icon: "Flame",
    firstImage: "Painted first frame",
    secondImage: "Painted last frame (optional)",
    secondImageOptional: true,
    text: {
      label: "Fluid",
      placeholder: "smoke plume rising over a city, blue sky",
      required: false,
      hint: "Paint one flat color per volume (grey smoke, white steam, orange/yellow fire) on black or over a photo. The last frame shows where it ends up; empty = same as the first. 5 s at 24 fps, 960×512 (or 512×960).",
    },
    modelCheck: { pack: "ltx25", action: "ltx_paint_fluid" },
    requireStatusEntry: true,
  },
  {
    id: "voiceover",
    title: "Voiceover",
    subtitle:
      "Read a script aloud in a stock voice, Kokoro, or a cloned sample",
    category: "Audio",
    icon: "Mic",
    noSourceInput: true,
    pickers: [
      {
        key: "engine",
        title: "Voice",
        options: [
          { id: "stock", label: "Stock voice" },
          { id: "kokoro", label: "Kokoro (fast)" },
          { id: "clone", label: "Clone a sample" },
        ],
      },
      {
        key: "voice",
        title: "Stock voice",
        dropdown: true,
        showWhen: { key: "engine", value: "stock" },
        options: VOICEOVER_STOCK_VOICES.map(({ id, label }) => ({ id, label })),
      },
      {
        key: "kokoro_voice",
        title: "Kokoro voice",
        dropdown: true,
        showWhen: { key: "engine", value: "kokoro" },
        options: VOICEOVER_KOKORO_VOICES.map(({ id, label }) => ({
          id,
          label,
        })),
      },
      {
        key: "pace",
        title: "Pace",
        showWhen: { key: "engine", value: "kokoro" },
        options: [
          { id: "1", label: "Normal" },
          { id: "0.85", label: "Slower" },
          { id: "1.15", label: "Faster" },
        ],
      },
    ],
    audioInput: "Voice sample",
    audioWhen: { key: "engine", value: "clone" },
    audioNote:
      "5-30 s of clear speech from one person (wav, mp3, m4a or flac) whose voice you have the right to use; the script is read in that voice. Tip: feed the result to Lipsync to make a photo speak it.",
    text: {
      label: "Script",
      placeholder:
        "Welcome back. Today we are building a tiny cabin by the lake.",
      required: true,
      hint: "Up to 2000 characters. Plain text; punctuation sets the pacing.",
    },
    modelCheck: { pack: "audio", action: "voiceover" },
    requireStatusEntry: true,
  },
  {
    id: "add_sound",
    title: "Add sound to clip",
    subtitle: "Generate foley and ambience that fits a silent video",
    category: "Audio",
    icon: "AudioLines",
    videoInput: "Silent clip",
    videoWindow: { seconds: ADD_SOUND_MAX_SECONDS },
    videoNote:
      "The first 10 s are scored; the new sound replaces any existing audio. Non-commercial model (MMAudio, CC BY-NC 4.0).",
    pickers: [
      {
        key: "asmr",
        title: "ASMR preset",
        dropdown: true,
        options: ASMR_SOUNDS.map(({ id, label, group }) => ({
          id,
          label,
          ...(group ? { group } : {}),
        })),
      },
    ],
    text: {
      label: "Sound (optional)",
      placeholder: "waves crashing on rocks, seagulls in the distance",
      required: false,
      hint: "Leave empty to let the model infer the sound from the picture.",
    },
    secondText: {
      label: "Avoid",
      placeholder: "music, speech",
      required: false,
      hint: "Sounds to keep out (default: music, speech, voice).",
    },
    modelCheck: { pack: "audio", action: "add_sound" },
    requireStatusEntry: true,
  },
  // Hidden: Character Swap's Full re-render mode as its own id (old runs,
  // links and upscale-after still name it). The card itself now checks the
  // same graph (its default mode), so no picker option points here.
  {
    id: "character_swap_full",
    title: "Character swap in video (full re-render)",
    subtitle: "Model check for Character swap's Full re-render mode",
    category: "Animate & 3D",
    icon: "Users",
    requiredPack: "minimax",
    videoInput: "Source video (24 fps)",
    videoWindow: { maxFrames: CHARACTER_SWAP_MAX_LENGTH, fps: CHARACTER_SWAP_FPS },
    secondImage: "Character photo",
    modelCheck: { pack: "minimax", action: "character_swap" },
    requireStatusEntry: true,
    hidden: true,
  },
  // Hidden: model check for Relight's "Match a reference" option (the
  // Light-Migration LoRA graph).
  {
    id: "light_migration",
    title: "Relight (match a reference)",
    subtitle: "Model check for Relight's Match a reference option",
    category: "Enhance",
    icon: "Lightbulb",
    firstImage: "Photo",
    secondImage: "Light reference",
    modelCheck: { pack: "qwen-edit-2509", action: "light_migration" },
    requireStatusEntry: true,
    hidden: true,
  },
  // Hidden: model checks for Upscale video's FlashVSR, NVIDIA RTX and LTX x2
  // engines.
  {
    id: "flashvsr_upscale",
    title: "Upscale video (FlashVSR)",
    subtitle: "Model check for Upscale video's FlashVSR engine",
    category: "Animate & 3D",
    icon: "Maximize2",
    videoInput: "Source video",
    modelCheck: { pack: "flashvsr", action: "flashvsr_upscale" },
    requireStatusEntry: true,
    hidden: true,
  },
  {
    id: "subject_matte",
    title: "Remove video background (MatAnyone2)",
    subtitle: "Node check for Remove video background's named-subject engine",
    category: "Animate & 3D",
    icon: "ImageOff",
    videoInput: "Source video",
    modelCheck: { pack: "matanyone", action: "subject_matte" },
    requireStatusEntry: true,
    hidden: true,
    nodePack: {
      id: "ComfyUI-MatAnyone",
      nodes: ["MatAnyone2"],
      install: MATANYONE_NODES_INSTALL,
    },
  },
  {
    id: "rtx_upscale",
    title: "Upscale video (NVIDIA RTX)",
    subtitle: "Node check for Upscale video's NVIDIA RTX engine",
    category: "Animate & 3D",
    icon: "Maximize2",
    videoInput: "Source video",
    modelCheck: { pack: "rtx", action: "rtx_upscale" },
    requireStatusEntry: true,
    hidden: true,
    nodePack: {
      id: "Nvidia_RTX_Nodes_ComfyUI",
      nodes: ["RTXVideoSuperResolution"],
      install: RTX_NODES_INSTALL,
    },
  },
  {
    id: "ltx_upscale_x2",
    title: "Upscale video (LTX x2)",
    subtitle: "Model check for Upscale video's LTX x2 engine",
    category: "Animate & 3D",
    icon: "Maximize2",
    videoInput: "Source video",
    modelCheck: { pack: "ltx25", action: "ltx_upscale_x2" },
    requireStatusEntry: true,
    hidden: true,
  },
];

export function getActionTool(id: string): ActionToolSpec | undefined {
  return ACTION_TOOLS.find((t) => t.id === id);
}

// Edit-LoRA list (GET /api/krea2-edit-loras)

export type InstalledEditLora = EditLora & { installed: boolean };

export interface EditLoraListResponse {
  families: Record<string, { label: string }>;
  loras: InstalledEditLora[];
}

export function editFamilies(
  resp: EditLoraListResponse | null,
): { id: string; label: string }[] {
  if (!resp) return [];
  const keys = new Set(
    resp.loras.filter((l) => l.installed).map((l) => l.family),
  );
  return [...keys]
    .map((id) => ({ id, label: resp.families[id]?.label ?? id }))
    .sort(
      (a, b) =>
        Number(b.id === GROUNDED_FAMILY) - Number(a.id === GROUNDED_FAMILY) ||
        a.label.localeCompare(b.label),
    );
}

export function editLorasIn(
  resp: EditLoraListResponse | null,
  family: string,
): InstalledEditLora[] {
  return (resp?.loras ?? []).filter((l) => l.installed && l.family === family);
}

// Settings

export type OutpaintDirection =
  "all" | "horizontal" | "vertical" | "left" | "right" | "top" | "bottom";

export interface ToolSettings {
  text: string;
  /** Action-picker key / catalog enum option id → chosen value id. */
  picks: Record<string, string>;
  fast: boolean;
  keepFraming: boolean;
  outpaintMode: "sides" | "aspect";
  outpaintDirection: OutpaintDirection;
  /** Fraction of the image size added per selected side (0..maxSide). */
  outpaintAmount: number;
  outpaintAspect: string;
  outpaintAnchor: OutpaintAnchor;
  /** Advanced overrides; undefined = tool default. */
  steps?: number;
  cfg?: number;
  seed?: number;
  editFamily?: string;
  editLoraId?: string;
  /** Second text field (ActionToolSpec.secondText, e.g. music lyrics). */
  secondText?: string;
  /** Smart select clicks on the source video (video_object_remove / person_remove). */
  smartTrack?: SmartTrackOccurrence[];
  /** Per-person Smart select clicks (spec.smartTrackPerRef, cast_swap). */
  smartTrackSubjects?: SmartTrackOccurrence[][];
  /** Free-draw paths / motion brush / pins over the photo (wan_move "Draw your own"). */
  wanMoveDraw?: WanMoveDraw;
  /** Refocus: [focus]; Rack focus: [A, B] with times (normalized x/y, seconds). */
  focusPoints?: FocusPoint[];
}

export function defaultSettings(
  tool?: CatalogTool | ActionToolSpec | null,
): ToolSettings {
  const base: ToolSettings = {
    text: "",
    picks: {},
    fast: false,
    keepFraming: false,
    outpaintMode: "sides",
    outpaintDirection: "all",
    outpaintAmount: 0.25,
    outpaintAspect: "16:9",
    outpaintAnchor: "center",
  };
  if (tool && "loras" in tool) {
    if (tool.speed.supported) base.fast = tool.speed.default;
    if (tool.extras.keepFraming)
      base.keepFraming = tool.extras.keepFraming.default;
  }
  return base;
}

function condition(
  cond: PickCondition,
  spec: ActionToolSpec,
  settings: ToolSettings,
  depth = 0,
): boolean {
  const p = spec.pickers?.find((x) => x.key === cond.key);
  // A hidden picker is inactive: whatever depends on it hides too
  // (Character swap: Pose strength <- Motion guide <- Mode).
  if (p?.showWhen && depth < 4 && !condition(p.showWhen, spec, settings, depth + 1))
    return false;
  const v = p ? pickValue(p, settings) : settings.picks[cond.key];
  return cond.oneOf ? cond.oneOf.includes(v) : v === cond.value;
}

/** Whether `picker` is shown (its `showWhen` pick is active). */
export function pickerVisible(
  picker: ActionPicker,
  spec: ActionToolSpec,
  settings: ToolSettings,
): boolean {
  return !picker.showWhen || condition(picker.showWhen, spec, settings);
}

/** Whether the spec's audio picker is shown and required right now. */
export function audioActive(
  spec: ActionToolSpec | null | undefined,
  settings: ToolSettings,
): boolean {
  if (!spec?.audioInput) return false;
  return !spec.audioWhen || condition(spec.audioWhen, spec, settings);
}

/** Whether the spec's text field is shown (its `showWhen` pick is active). */
export function textVisible(
  spec: ActionToolSpec | null | undefined,
  settings: ToolSettings,
): boolean {
  if (!spec?.text) return false;
  return !spec.text.showWhen || condition(spec.text.showWhen, spec, settings);
}

/** Whether the spec's second text field is shown (its `showWhen` pick is active). */
export function secondTextVisible(
  spec: ActionToolSpec | null | undefined,
  settings: ToolSettings,
): boolean {
  if (!spec?.secondText) return false;
  return (
    !spec.secondText.showWhen ||
    condition(spec.secondText.showWhen, spec, settings)
  );
}

/** Whether `slider` is shown (its `showWhen` pick is active). */
export function sliderVisible(
  slider: ActionSlider,
  spec: ActionToolSpec,
  settings: ToolSettings,
): boolean {
  return !slider.showWhen || condition(slider.showWhen, spec, settings);
}

/** Reference to Video Long clip + Fix faces params (none while off). */
function refVideoLongParams(
  spec: ActionToolSpec,
  settings: ToolSettings,
  pick: (key: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (pick("duration") === "long") {
    const sl = spec.sliders?.find((x) => x.key === "longSeconds");
    out.longClip = true;
    out.longSeconds = sl ? sliderValue(sl, settings) : H3_LONG_DEFAULT_SECONDS;
    out.longMethod = pick("longMethod") === "sequential" ? "sequential" : "context";
    const win = spec.sliders?.find((x) => x.key === "longWindow");
    if (win) out.longWindow = sliderValue(win, settings);
    const overlap = Number(pick("longOverlap"));
    if (Number.isFinite(overlap)) out.longOverlap = overlap;
  }
  const faces = h3FixFacesCount(pick("fixFaces"));
  if (faces) out.fixFaces = faces;
  return out;
}

/** Slider value from settings.picks (clamped, snapped to step) or its default. */
export function sliderValue(
  slider: ActionSlider,
  settings: ToolSettings,
): number {
  const raw = settings.picks[slider.key];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return slider.default;
  const snapped =
    slider.min + Math.round((n - slider.min) / slider.step) * slider.step;
  return Math.min(slider.max, Math.max(slider.min, snapped));
}

/**
 * Character swap (mannequin) Motion guide params: motionGuide always (so the
 * builder never guesses), the pose strength (0..1.2) only while Pose is on.
 */
export function motionGuideParams(
  spec: ActionToolSpec,
  settings: ToolSettings,
): { motionGuide?: string; motionGuideStrength?: number } {
  const picker = spec.pickers?.find((p) => p.key === "motionGuide");
  if (!picker || !pickerVisible(picker, spec, settings)) return {};
  const motionGuide = pickValue(picker, settings);
  const slider = spec.sliders?.find((sl) => sl.key === "poseStrength");
  if (motionGuide !== "pose" || !slider || !sliderVisible(slider, spec, settings))
    return { motionGuide };
  return { motionGuide, motionGuideStrength: sliderValue(slider, settings) / 100 };
}

/**
 * Character swap (mannequin) Finish params: finish always while the picker
 * shows, the refine strength (start_sigma 0.4..0.8) only for 2K.
 */
export function finishParams(
  spec: ActionToolSpec,
  settings: ToolSettings,
): { finish?: string; finishStrength?: number } {
  const picker = spec.pickers?.find((p) => p.key === "finish");
  if (!picker || !pickerVisible(picker, spec, settings)) return {};
  const finish = pickValue(picker, settings);
  const slider = spec.sliders?.find((sl) => sl.key === "finishStrength");
  if (finish !== "2k" || !slider || !sliderVisible(slider, spec, settings))
    return { finish };
  return { finish, finishStrength: sliderValue(slider, settings) / 100 };
}

/** Follow subject param while its picker shows (character swap / cast). */
export function followSubjectParams(
  spec: ActionToolSpec,
  settings: ToolSettings,
): { followSubject?: string } {
  const picker = spec.pickers?.find((p) => p.key === "followSubject");
  if (!picker || !pickerVisible(picker, spec, settings)) return {};
  return { followSubject: pickValue(picker, settings) };
}

export function pickValue(
  picker: ActionPicker,
  settings: ToolSettings,
): string {
  const chosen = settings.picks[picker.key];
  if (chosen && picker.options.some((o) => o.id === chosen)) return chosen;
  return defaultPick(picker);
}

/** A picker's default option id (`defaultId` when listed, else the first). */
export function defaultPick(picker: ActionPicker): string {
  if (picker.defaultId && picker.options.some((o) => o.id === picker.defaultId))
    return picker.defaultId;
  return picker.options[0]?.id ?? "";
}

// Cards, availability, grouping

export interface ToolCard {
  /** Stable key: "catalog:<id>" or "action:<id>". */
  key: string;
  kind: "catalog" | "action";
  id: string;
  title: string;
  subtitle: string;
  category: string;
  icon: string;
  available: boolean;
  /** Why the card is disabled (shown on the card and under Run). */
  unavailableReason: string | null;
  /** Small license note for non-commercial / unverified tools. */
  licenseNote: string | null;
  /** Pack/LoRA state still loading. */
  checking: boolean;
  /** Available, but its models are not checked on the server. */
  unverified?: boolean;
  /**
   * Picker options that run through another tool (ActionChoice.requiresTool)
   * and cannot run right now: picker key -> option id -> block.
   */
  optionBlocks?: Record<string, Record<string, OptionBlock>>;
}

/** Why a requiresTool picker option cannot run (same shape as a card block). */
export interface OptionBlock {
  reason: string | null;
  checking: boolean;
  /** Model name for the setup hint ("LTX-2.5"). */
  model: string;
}

/**
 * Tool categories in Tools hub order (hub.ts HUB_CATEGORIES: Image, Edit,
 * Identity, Video, VFX, Enhance, then the app sections, Audio), so docs and
 * the hub agree.
 */
export const CATEGORY_ORDER = [
  "Describe",
  "Camera",
  "Compose",
  "Restyle",
  "Story",
  "Edit",
  "Expand",
  "Inpaint",
  "Remove",
  "Swap",
  "Outfit",
  "Animate & 3D",
  "LTX VFX",
  "Enhance",
  "Restore",
  "Audio",
];

const CATEGORY_ICONS: Record<string, string> = {
  Expand: "Expand",
  Restore: "Sparkles",
  Camera: "Camera",
  Compose: "Paintbrush",
  Outfit: "Shirt",
  Edit: "WandSparkles",
  Inpaint: "Brush",
  Swap: "Replace",
  Story: "BookOpen",
  Remove: "Eraser",
  Restyle: "Palette",
  Enhance: "Aperture",
};

export function catalogIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? "Wrench";
}

export function catalogUnavailableReason(tool: CatalogTool): string | null {
  if (tool.available) return null;
  if (!tool.installed) {
    const names = tool.loras
      .map((l) =>
        l.file
          .split("/")
          .pop()
          ?.replace(/\.safetensors$/i, ""),
      )
      .filter(Boolean)
      .join(", ");
    return `LoRA not installed${names ? `: ${names}` : ""}. Put it in models/loras/edit_tools.`;
  }
  if (tool.missingNodes?.length) {
    const pack = tool.requiresNodes ? `${tool.requiresNodes}: ` : "";
    return `Needs ComfyUI custom nodes (${pack}${tool.missingNodes.join(", ")}). Install them and restart ComfyUI.`;
  }
  if (!tool.packAvailable) {
    const nodes = tool.requiresNodes ? ` (needs ${tool.requiresNodes})` : "";
    return `${tool.baseLabel} base model or workflow is not installed${nodes}.`;
  }
  return "Not available on this server.";
}

/** Links for a catalog tool's license line: license text, then model page. */
export function catalogLicenseLinks(
  license: CatalogToolLicense | undefined,
): BadgeSource[] {
  if (!license || license.commercial === true) return [];
  return badgeLinks([
    sourceFor(license.name),
    ...(license.source ? [{ license: "Model page", url: license.source }] : []),
  ]);
}

/** Badge of a catalog license: commercial true/false, else its `badge`. */
export function catalogLicenseBadge(
  license: CatalogToolLicense | undefined,
): "open" | "nc" | "cap" | "check" | null {
  if (!license) return null;
  if (license.commercial === true) return "open";
  if (license.commercial === false) return "nc";
  return license.badge ?? "check";
}

const NOTE_PREFIX = {
  nc: "Non-commercial",
  cap: "Revenue cap",
  check: "Check license",
} as const;

/**
 * One-line license note for a catalog tool (null = open license). It starts
 * with the badge word ("Non-commercial: …", "Revenue cap: …", "Check
 * license: …") so pickers can show the head.
 */
export function licenseNoteFor(
  license: CatalogToolLicense | undefined,
): string | null {
  const badge = catalogLicenseBadge(license);
  if (!license || !badge || badge === "open") return null;
  const word = NOTE_PREFIX[badge];
  if (!license.note) return `${word} (${license.name})`;
  return license.note.toLowerCase().startsWith(word.toLowerCase())
    ? license.note
    : `${word}: ${license.note}`;
}

export interface ActionAvailability {
  available: boolean;
  checking: boolean;
  reason: string | null;
  /** Available, but nothing checks its models (no modelCheck). */
  unverified?: boolean;
}

/** GET /api/tools/model-status: missing weight files per model-checked tool. */
export interface ModelStatusResponse {
  tools: Record<string, { missing: string[] }>;
  /**
   * Optional-weight install state, keyed by option (motionRepair, handheld,
   * h3Flex, h3Turbo8, h3Turbo4, h3Fast8, mossSpeed8, mossSpeed4, deband,
   * mossTurbo, seedvr2_7b, seedvr2_7b_sharp, characterSwapMasked).
   * `missing` empty = installed.
   */
  options?: Record<string, { file: string; missing: string[] }>;
  /** MOSS-Image speed used when the caller picks none ("balanced" when installed). */
  mossDefaultSpeed?: "off" | "balanced" | "fast" | "fast4" | "turbo";
  /** The check itself failed (server unreachable): keep gated tools off. */
  failed?: boolean;
}

export function missingModelsReason(missing: string[]): string {
  const names = missing.map((m) => m.split("/").pop() ?? m);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` (+${names.length - 3} more)` : "";
  return `Model not installed: ${shown}${more}. Download it into ComfyUI/models first.`;
}

/**
 * "The cj_image_tools pack isn't installed ..." when model-status reports
 * nodes of the spec's repo node pack missing (setupHint: "Needs the
 * cj_image_tools pack"); null otherwise. Other missing files are appended.
 */
export function nodePackReason(
  spec: Pick<ActionToolSpec, "nodePack">,
  missing: string[],
): string | null {
  const pack = spec.nodePack;
  if (!pack) return null;
  const ofPack = (m: string) =>
    m.startsWith("node:") && pack.nodes.includes(m.slice(5));
  const nodes = missing.filter(ofPack).map((m) => m.slice(5));
  if (!nodes.length) return null;
  const rest = missing
    .filter((m) => !ofPack(m))
    .map((m) => m.split("/").pop() ?? m);
  const also = rest.length ? ` Also missing: ${rest.join(", ")}.` : "";
  const fix =
    pack.install ??
    `Copy comfy_nodes/${pack.id} into ComfyUI/custom_nodes and restart ComfyUI.`;
  return `The ${pack.id} pack isn't installed on this server (missing nodes: ${nodes.join(", ")}). ${fix}${also}`;
}

export function actionAvailability(
  spec: ActionToolSpec,
  packIds: Set<string> | null,
  editLoras: EditLoraListResponse | null,
  modelStatus: ModelStatusResponse | null = null,
): ActionAvailability {
  if (spec.requiredPack) {
    if (!packIds) return { available: false, checking: true, reason: null };
    if (!packIds.has(spec.requiredPack))
      return {
        available: false,
        checking: false,
        reason: `The ${spec.requiredPack} pack isn't installed on this server.`,
      };
  }
  if (spec.requiresNodes) {
    return {
      available: false,
      checking: false,
      reason: `Needs custom nodes: ${spec.requiresNodes}`,
    };
  }
  if (spec.modelCheck) {
    if (!modelStatus) return { available: false, checking: true, reason: null };
    if (modelStatus.failed)
      return {
        available: false,
        checking: false,
        reason: "Couldn't check which models are installed on this server.",
      };
    const entry = modelStatus.tools[spec.id];
    if (!entry && spec.requireStatusEntry)
      return {
        available: false,
        checking: false,
        reason: "Not set up on this server yet (workflow not registered).",
      };
    const missing = entry?.missing ?? [];
    if (missing.length > 0)
      return {
        available: false,
        checking: false,
        reason: nodePackReason(spec, missing) ?? missingModelsReason(missing),
      };
  }
  if (spec.usesEditLora) {
    if (!editLoras) return { available: false, checking: true, reason: null };
    const family = spec.picksEditFamily ? null : GROUNDED_FAMILY;
    const any = family
      ? editLorasIn(editLoras, family).length > 0
      : editFamilies(editLoras).length > 0;
    if (!any)
      return {
        available: false,
        checking: false,
        reason: family
          ? "Needs a Krea 2 edit LoRA (grounded family). Install one from the Edit tab's LoRA list."
          : "No edit LoRA is installed on this server.",
      };
  }
  return spec.modelCheck
    ? { available: true, checking: false, reason: null }
    : { available: true, checking: false, reason: null, unverified: true };
}

/**
 * Blocks for the spec's requiresTool picker options whose tool cannot run
 * (pack or models missing, or still being checked). Undefined when none.
 */
export function optionBlocksFor(
  spec: ActionToolSpec,
  packIds: Set<string> | null,
  editLoras: EditLoraListResponse | null,
  modelStatus: ModelStatusResponse | null = null,
): Record<string, Record<string, OptionBlock>> | undefined {
  let out: Record<string, Record<string, OptionBlock>> | undefined;
  for (const p of spec.pickers ?? [])
    for (const o of p.options) {
      if (o.requiresOption) {
        const block = requiredOptionBlock(o.requiresOption, modelStatus);
        if (block) {
          out ??= {};
          (out[p.key] ??= {})[o.id] = block;
        }
        continue;
      }
      if (!o.requiresTool) continue;
      const via = getActionTool(o.requiresTool);
      if (!via) continue;
      const av = actionAvailability(via, packIds, editLoras, modelStatus);
      if (av.available) continue;
      out ??= {};
      (out[p.key] ??= {})[o.id] = {
        reason: av.reason,
        checking: av.checking,
        model: o.label.replace(/\s*\(.*\)$/, ""),
      };
    }
  return out;
}

function requiredOptionBlock(
  req: { key: string; model: string },
  modelStatus: ModelStatusResponse | null,
): OptionBlock | null {
  if (!modelStatus) return { reason: null, checking: true, model: req.model };
  // An older server without this option entry: let the queue report it.
  const missing = modelStatus.options?.[req.key]?.missing ?? [];
  if (!missing.length) return null;
  return {
    reason: missingModelsReason(missing),
    checking: false,
    model: req.model,
  };
}

/** The block on the current picks (a visible blocked option), else null. */
export function pickBlock(
  card: Pick<ToolCard, "optionBlocks">,
  spec: ActionToolSpec,
  settings: ToolSettings,
): OptionBlock | null {
  if (!card.optionBlocks) return null;
  for (const p of spec.pickers ?? []) {
    if (!pickerVisible(p, spec, settings)) continue;
    const block = card.optionBlocks[p.key]?.[pickValue(p, settings)];
    if (block) return block;
  }
  return null;
}

export function buildToolCards(opts: {
  catalog: CatalogTool[] | null;
  packIds: Set<string> | null;
  editLoras: EditLoraListResponse | null;
  modelStatus?: ModelStatusResponse | null;
  /** Describe needs StyleVault (STYLEVAULT_API_URL); false leaves it out. */
  describeAvailable?: boolean;
}): ToolCard[] {
  const cards: ToolCard[] = [];
  for (const spec of ACTION_TOOLS) {
    if (spec.hidden) continue;
    if (spec.special === "describe" && opts.describeAvailable === false) continue;
    const av = actionAvailability(
      spec,
      opts.packIds,
      opts.editLoras,
      opts.modelStatus ?? null,
    );
    const optionBlocks = optionBlocksFor(
      spec,
      opts.packIds,
      opts.editLoras,
      opts.modelStatus ?? null,
    );
    cards.push({
      key: `action:${spec.id}`,
      kind: "action",
      id: spec.id,
      title: spec.title,
      subtitle: spec.subtitle,
      category: spec.category,
      icon: spec.icon,
      available: av.available,
      unavailableReason: av.reason,
      licenseNote: null,
      checking: av.checking,
      ...(av.unverified ? { unverified: true } : {}),
      ...(optionBlocks ? { optionBlocks } : {}),
    });
  }
  const outpaintCard = buildOutpaintCard(opts.catalog);
  if (outpaintCard) cards.push(outpaintCard);
  for (const tool of opts.catalog ?? []) {
    // Outpaint backends are folded into the single "Outpaint" card above.
    if (outpaintCard && isOutpaintTool(tool)) continue;
    cards.push({
      key: `catalog:${tool.id}`,
      kind: "catalog",
      id: tool.id,
      title: tool.label,
      subtitle: tool.description,
      category: tool.category,
      icon: catalogIcon(tool.category),
      available: tool.available,
      unavailableReason: catalogUnavailableReason(tool),
      licenseNote: licenseNoteFor(tool.license),
      checking: false,
    });
  }
  return cards;
}

// Unified "Outpaint" card: picks the fastest installed outpaint backend

export const OUTPAINT_CARD_KEY = "catalog:outpaint";

export function isOutpaintTool(tool: CatalogTool): boolean {
  return tool.outpaint != null;
}

/**
 * Sampler steps the tool runs with its fastest available configuration
 * (speed LoRA when installed, else the default steps).
 */
export function outpaintEffectiveSteps(tool: CatalogTool): number {
  if (tool.speed.supported && tool.speed.available) return tool.speed.steps;
  return tool.defaults.steps;
}

/**
 * Fastest outpaint backend that is installed: fewest effective steps; ties
 * keep catalog order. Null when none is available.
 */
export function pickFastestOutpaint(
  catalog: CatalogTool[] | null,
): CatalogTool | null {
  let best: CatalogTool | null = null;
  for (const tool of catalog ?? []) {
    if (!isOutpaintTool(tool) || !tool.available) continue;
    if (!best || outpaintEffectiveSteps(tool) < outpaintEffectiveSteps(best))
      best = tool;
  }
  return best;
}

/**
 * The catalog tool the Outpaint card runs, with the speed LoRA switched on
 * when it is installed. When nothing is installed, the first outpaint tool
 * (so the runner can show why). Null when the server has no outpaint tool.
 */
export function resolveOutpaintTool(
  catalog: CatalogTool[] | null,
): CatalogTool | null {
  const best = pickFastestOutpaint(catalog);
  const tool = best ?? (catalog ?? []).find(isOutpaintTool) ?? null;
  if (!tool) return null;
  if (tool.speed.supported && tool.speed.available)
    return { ...tool, speed: { ...tool.speed, default: true } };
  return tool;
}

function buildOutpaintCard(catalog: CatalogTool[] | null): ToolCard | null {
  const tool = resolveOutpaintTool(catalog);
  if (!tool) return null;
  const ready = tool.available;
  const steps = outpaintEffectiveSteps(tool);
  const noneInstalled = (catalog ?? []).filter(isOutpaintTool).length > 1;
  const reason = catalogUnavailableReason(tool);
  return {
    key: OUTPAINT_CARD_KEY,
    kind: "catalog",
    id: tool.id,
    title: "Outpaint",
    subtitle: ready
      ? `Extend the picture by aspect, zoom-out or per side (${tool.baseLabel}, ${steps} steps)`
      : "Extend the picture by aspect, zoom-out or per side",
    category: "Expand",
    icon: "Expand",
    available: ready,
    unavailableReason:
      ready || !reason
        ? null
        : noneInstalled
          ? `No outpaint model installed. ${reason}`
          : reason,
    licenseNote: licenseNoteFor(tool.license),
    checking: false,
  };
}

/** One-tap zoom-out presets (fraction added per side; 0.25 = 1.5x canvas). */
export const OUTPAINT_ZOOM_PRESETS: {
  id: string;
  label: string;
  amount: number;
}[] = [
  { id: "zoom_1_5", label: "Zoom out 1.5x", amount: 0.25 },
  { id: "zoom_2", label: "Zoom out 2x", amount: 0.5 },
];

export function zoomPresetSettings(amount: number): Partial<ToolSettings> {
  return {
    outpaintMode: "sides",
    outpaintDirection: "all",
    outpaintAmount: amount,
  };
}

export function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Outpaint option

export const OUTPAINT_DIRECTIONS: { id: OutpaintDirection; label: string }[] = [
  { id: "all", label: "All sides" },
  { id: "horizontal", label: "Left + right" },
  { id: "vertical", label: "Top + bottom" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
];

export const OUTPAINT_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1"];

export const OUTPAINT_ANCHORS: OutpaintAnchor[] = [
  "center",
  "left",
  "right",
  "top",
  "bottom",
];

export interface OutpaintSidesFractions {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function sidesFor(
  direction: OutpaintDirection,
  amount: number,
): OutpaintSidesFractions {
  const a = Math.round(amount * 1000) / 1000;
  const has = (...d: OutpaintDirection[]) =>
    direction === "all" || d.includes(direction);
  return {
    left: has("horizontal", "left") ? a : 0,
    right: has("horizontal", "right") ? a : 0,
    top: has("vertical", "top") ? a : 0,
    bottom: has("vertical", "bottom") ? a : 0,
  };
}

export type OutpaintOption =
  OutpaintSidesFractions | { aspect: string; anchor: OutpaintAnchor };

export function outpaintOption(
  settings: ToolSettings,
  maxSide = 1,
): OutpaintOption | { error: string } {
  if (settings.outpaintMode === "aspect") {
    if (!OUTPAINT_ASPECTS.includes(settings.outpaintAspect))
      return { error: "Pick an aspect ratio." };
    return { aspect: settings.outpaintAspect, anchor: settings.outpaintAnchor };
  }
  const amount = Math.min(Math.max(settings.outpaintAmount, 0), maxSide);
  const sides = sidesFor(settings.outpaintDirection, amount);
  if (Object.values(sides).every((v) => v <= 0))
    return { error: "Choose how much to expand." };
  return sides;
}

// Catalog request body (POST /api/jobs/tool)

export type ToolImageRef = string | { run_id: string; job_index: number };

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface CatalogRequestBody {
  toolId: string;
  images: ToolImageRef[];
  mask?: string;
  prompt?: string;
  options: Record<string, unknown>;
  client_id: string;
}

export function catalogPromptNeeded(tool: CatalogTool): boolean {
  return tool.promptMode !== "none";
}

/** Throws ToolInputError for anything the server would 400 on. */
export function buildCatalogBody(
  tool: CatalogTool,
  settings: ToolSettings,
  images: (ToolImageRef | null)[],
  mask: string | null,
  clientId: string,
): CatalogRequestBody {
  const filled = images.filter((i): i is ToolImageRef => i != null);
  if (filled.length < tool.refCount || images.length < tool.refCount) {
    const missing = tool.refLabels[filled.length] ?? "an image";
    throw new ToolInputError(`Add ${missing.toLowerCase()} first.`);
  }
  const text = settings.text.trim();
  if (tool.promptMode === "required" && !text)
    throw new ToolInputError("Add a prompt first.");
  if (tool.needsMask && !mask)
    throw new ToolInputError("Paint the area to change first.");

  const options: Record<string, unknown> = {};
  if (tool.speed.supported && tool.speed.available)
    options.fast = settings.fast;
  if (tool.extras.keepFraming?.available)
    options.keepFraming = settings.keepFraming;
  for (const opt of tool.options) {
    const v = settings.picks[opt.id];
    options[opt.id] = v && opt.values.some((x) => x.id === v) ? v : opt.default;
  }
  if (tool.outpaint) {
    const o = outpaintOption(settings, tool.outpaint.maxSide);
    if ("error" in o) throw new ToolInputError(o.error);
    options.outpaint = o;
  }
  if (settings.steps !== undefined) options.steps = settings.steps;
  if (settings.cfg !== undefined) options.cfg = settings.cfg;
  if (settings.seed !== undefined) options.seed = settings.seed;

  const body: CatalogRequestBody = {
    toolId: tool.id,
    images: filled.slice(0, tool.refCount),
    options,
    client_id: clientId,
  };
  if (tool.needsMask && mask) body.mask = mask;
  if (tool.promptMode !== "none" && text) body.prompt = text;
  return body;
}

/** Prompt the server will send (client-side preview of the template). */
export function previewCatalogPrompt(
  tool: CatalogTool,
  settings: ToolSettings,
): string {
  if (tool.promptMode === "none" || !tool.promptTemplate) return "";
  let out = tool.promptTemplate;
  for (const opt of tool.options) {
    const v = settings.picks[opt.id] ?? opt.default;
    const text = opt.values.find((x) => x.id === v)?.text ?? "";
    out = out.replaceAll(`{${opt.id}}`, text);
  }
  return out
    .replaceAll("{prompt}", settings.text.trim())
    .replace(/\s+/g, " ")
    .trim();
}

// Action request body (POST /api/jobs/action)

export interface ActionRequest {
  action: string;
  params: Record<string, unknown>;
  overrides: Record<string, string | number | boolean>;
}

// "image 1" / "image 2" are the MODEL's vision blocks, not the card's
// upload slots. pose_character.json feeds Krea2EditGroundedEncode
// image = pose photo (node 14 -> 40, ref A, "scene") and image_b = character
// (node 5, ref B, "subject"), in that training order. The card's first
// upload ("Character") is the source -> node 5 = image 2; its second upload
// ("Pose", secondRefImage) -> node 14 = image 1. So: replace the person in
// the pose photo with the character, keeping the character's identity.
export function poseCharacterPrompt(style: string): string {
  const raw = style.trim();
  const extra = raw && raw[0].toUpperCase() + raw.slice(1);
  return (
    "Replace the person in image 1 with the person from image 2, in exactly " +
    "the same pose and body position as image 1. Keep the face, hairstyle " +
    "and outfit of the person from image 2." +
    (extra ? ` ${/[.!?]$/.test(extra) ? extra : `${extra}.`}` : "")
  );
}

export function replacePersonPrompt(who: string): string {
  const target = who.trim() || "the person";
  return (
    `Replace ${target} in image 1 with the person from image 2. ` +
    "Keep their face, hair and clothing; match the pose, lighting and framing of image 1."
  );
}

/** The LoRA an edit tool will use (chosen, else first installed in family). */
export function pickEditLora(
  spec: ActionToolSpec,
  settings: ToolSettings,
  resp: EditLoraListResponse | null,
): InstalledEditLora | null {
  const family = spec.picksEditFamily
    ? (settings.editFamily ?? editFamilies(resp)[0]?.id)
    : GROUNDED_FAMILY;
  if (!family) return null;
  const list = editLorasIn(resp, family);
  return list.find((l) => l.id === settings.editLoraId) ?? list[0] ?? null;
}

/** h3Flex pick -> params ("on" = default strength, "subtle" = lower). */
function h3FlexParams(
  pick: (key: string) => string,
): { h3Flex?: true; h3FlexStrength?: number } {
  const flex = pick("h3Flex");
  if (flex === "on") return { h3Flex: true };
  if (flex === "subtle")
    return { h3Flex: true, h3FlexStrength: H3_FLEX_SUBTLE_STRENGTH };
  return {};
}

function h3ToggleParams(
  pick: (key: string) => string,
): Record<string, boolean | string | number> {
  const out: Record<string, boolean | string | number> = {};
  if (pick("motionRepair") === "on") out.motionRepair = true;
  if (pick("handheld") === "on") out.handheld = true;
  Object.assign(out, h3FlexParams(pick));
  const speed = pick("h3Speed");
  if (speed && speed !== "off") out.h3Speed = speed;
  return out;
}

/**
 * Paste-back request params (lib/oj/imagePasteBack.ts). Off: FIBO
 * (`alwaysSend`, on by default server-side) gets pasteBack:false; the
 * generic edits paste back only when asked, so nothing is sent.
 */
function pasteBackParams(
  pick: (key: string) => string,
  area: string,
  alwaysSend: boolean,
): Record<string, unknown> {
  if (pick("pasteBack") !== "on") return alwaysSend ? { pasteBack: false } : {};
  const out: Record<string, unknown> = {
    pasteBack: true,
    pasteBackArea: area.slice(0, 200),
  };
  if (pick("pasteBackPose") === "on") out.pasteBackPose = true;
  return out;
}

export function buildActionRequest(
  spec: ActionToolSpec,
  settings: ToolSettings,
  resp: EditLoraListResponse | null,
  secondRef?: string,
  audio?: { ref: string; seconds?: number },
  /** Further uploaded reference photos (spec.extraImages, cast_swap). */
  extraRefs?: string[],
): ActionRequest {
  const text = settings.text.trim();
  // Smart select clicks stand in for the SAM text target.
  const clicked =
    SMART_TRACK_ACTIONS.has(spec.id) && hasSmartTrack(settings.smartTrack);
  if (spec.text?.required && !text && !clicked)
    throw new ToolInputError(
      SMART_TRACK_ACTIONS.has(spec.id)
        ? `Add ${spec.text.label.toLowerCase()}, or click it on the video (Smart select).`
        : `Add ${spec.text.label.toLowerCase()} first.`,
    );
  const pick = (key: string) => {
    const p = spec.pickers?.find((x) => x.key === key);
    return p ? pickValue(p, settings) : "";
  };

  switch (spec.id) {
    case "edit_photo":
    case "remove_object":
    case "restyle_locked": {
      const lora = pickEditLora(spec, settings, resp);
      if (!lora)
        throw new ToolInputError("No edit LoRA is installed on this server.");
      const modeId: EditModeId =
        spec.id === "edit_photo"
          ? "instruct"
          : spec.id === "remove_object"
            ? "remove"
            : "restyle";
      const grounded = lora.family === GROUNDED_FAMILY;
      const params: Record<string, unknown> = {
        pack_id: KREA2_EDIT_PACK,
        prompt: grounded ? renderEditPrompt(EDIT_MODES[modeId], text) : text,
      };
      if (grounded) params.editMode = modeId;
      if (lora.kvCache) params.editLoraKvCache = true;
      // Remove object: paste back onto the original at full res; the
      // "what to remove" text is the SAM3 region (empty = diff-only).
      if (spec.id === "remove_object")
        Object.assign(params, pasteBackParams(pick, text, false));
      return {
        action: editActionFor(
          lora.family,
          grounded && spec.id === "restyle_locked",
        ),
        params,
        overrides: {
          "2.lora_name": lora.file,
          "2.strength_model": lora.defaultStrength,
        },
      };
    }
    case "replace_person": {
      const lora = pickEditLora(spec, settings, resp);
      if (!lora)
        throw new ToolInputError("No edit LoRA is installed on this server.");
      if (!secondRef) throw new ToolInputError("Add the person's photo first.");
      return {
        action: "edit_instruct_dual",
        params: {
          pack_id: KREA2_EDIT_PACK,
          prompt: replacePersonPrompt(text),
          editMode: "swap",
          secondRefImage: secondRef,
          ...(lora.kvCache ? { editLoraKvCache: true } : {}),
        },
        overrides: {
          "2.lora_name": lora.file,
          "2.strength_model": lora.defaultStrength,
        },
      };
    }
    case "pose_character": {
      const lora = pickEditLora(spec, settings, resp);
      if (!lora)
        throw new ToolInputError("No edit LoRA is installed on this server.");
      if (!secondRef) throw new ToolInputError("Add the pose photo first.");
      return {
        action: POSE_CHARACTER_ACTION,
        params: {
          pack_id: KREA2_EDIT_PACK,
          prompt: poseCharacterPrompt(text),
          secondRefImage: secondRef,
          ...(lora.kvCache ? { editLoraKvCache: true } : {}),
        },
        overrides: {
          "2.lora_name": lora.file,
          "2.strength_model": lora.defaultStrength,
        },
      };
    }
    case "edit_qwen21":
    case "edit_flux3": {
      // Paste-back only when an area is named (else the full re-render).
      const area = settings.secondText?.trim() ?? "";
      return {
        action: pick("speed"),
        params: {
          pack_id: spec.requiredPack ?? "",
          prompt: text,
          ...(area ? pasteBackParams(pick, area, false) : {}),
        },
        overrides: {},
      };
    }
    case "edit_fibo":
      return {
        action: pick("speed"),
        params: {
          pack_id: "fibo2",
          prompt: text,
          ...pasteBackParams(pick, settings.secondText?.trim() ?? "", true),
        },
        overrides: {},
      };
    case "bg_remove":
    case "make_3d":
      return { action: spec.id, params: {}, overrides: {} };
    case "make_3d_trellis":
      return {
        action: "make_3d_trellis",
        params: {
          pack_id: "trellis2",
          engine: pick("engine"),
          quality: pick("quality"),
          texture: pick("texture"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "image_to_splat":
      return {
        action: "image_to_splat",
        params: {
          pack_id: "triposplat",
          format: pick("format") || "ply",
          mesh: pick("mesh") || "off",
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "body_3d":
    case "body_3d_video":
      return {
        action: "body_3d",
        params: {
          pack_id: "sam3d-body",
          media: spec.videoInput ? "video" : "image",
          view: pick("view") || "mesh",
          file: pick("file") || "glb",
          ...(spec.videoInput ? { smooth: pick("smooth") || "on" } : {}),
        },
        overrides: {},
      };
    case "moge_geometry":
      return {
        action: "moge_geometry",
        params: {
          source: pick("source") || "photo",
          mesh: pick("mesh") || "light",
          depth: pick("depth") || "gray",
          normals: pick("normals") || "opengl",
          detail: pick("detail") || "max",
          model: pick("model") || "moge2",
        },
        overrides: {},
      };
    case "material_maps": {
      const maps = {
        depth: pick("depth") || "on",
        normals: pick("normals") || "on",
        albedo: pick("albedo") || "on",
      };
      if (!Object.values(maps).includes("on"))
        throw new ToolInputError("Turn on at least one map.");
      return {
        action: "material_maps",
        params: { ...maps, detail: pick("detail") || "standard" },
        overrides: {},
      };
    }
    case "music": {
      const lyrics = settings.secondText?.trim() ?? "";
      return {
        action: "music",
        params: {
          pack_id: "audio",
          prompt: text,
          ...(lyrics ? { lyrics } : {}),
          duration: Number(pick("duration")),
          bpm: Number(pick("bpm")),
          key: pick("key"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "sa3_t2a":
    case "sa3_a2a":
    case "sa3_inpaint":
    case "sa3_extend":
      return buildSa3Request(
        spec,
        settings,
        audio,
        (m) => new ToolInputError(m),
      );
    case "sfx":
      return {
        action: "sfx",
        params: {
          pack_id: "audio",
          prompt: text,
          duration: Number(pick("duration")),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "character_swap":
    case "character_swap_full": {
      if (!secondRef)
        throw new ToolInputError("Add the character photo first.");
      if (
        spec.id === "character_swap" &&
        (pick("mode") === "mannequin" || pick("mode") === "exact")
      ) {
        const outfit = secondTextVisible(spec, settings)
          ? (settings.secondText?.trim() ?? "")
          : "";
        return {
          action: "character_swap_masked",
          params: {
            pack_id: spec.requiredPack ?? "minimax",
            secondRefImage: secondRef,
            ...(text ? { target: text } : {}),
            ...(outfit ? { description: outfit } : {}),
            ...(pick("mode") === "exact"
              ? {
                  fidelity: "exact",
                  resolution: pick("resolution"),
                  output: pick("output"),
                }
              : {}),
            ...motionGuideParams(spec, settings),
            ...finishParams(spec, settings),
            ...followSubjectParams(spec, settings),
            ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
          },
          overrides: {},
        };
      }
      return {
        action: "character_swap",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          secondRefImage: secondRef,
          ...(text ? { target: text } : {}),
        },
        overrides: {},
      };
    }
    case "wan_animate":
      if (!secondRef)
        throw new ToolInputError("Add the character photo first.");
      return {
        action: "wan_animate",
        params: {
          pack_id: spec.requiredPack ?? "wan-animate",
          secondRefImage: secondRef,
          mode: pick("mode") || "animate",
          speed: pick("speed") || "fast",
          ...(text ? { character: text } : {}),
        },
        overrides: {},
      };
    case "lipsync":
      if (!audio?.ref) throw new ToolInputError("Add the speech audio first.");
      return {
        action: "lipsync",
        params: {
          pack_id: spec.requiredPack ?? "wan-animate",
          audioRef: audio.ref,
          ...(typeof audio.seconds === "number" &&
          Number.isFinite(audio.seconds)
            ? { audio_seconds: audio.seconds }
            : {}),
          ...(text ? { prompt: text } : {}),
        },
        overrides: {},
      };
    case "video_lipsync": {
      if (!audio?.ref)
        throw new ToolInputError("Add the new speech audio first.");
      const clicks = parseSmartTrack(settings.smartTrack);
      return {
        action: "video_lipsync",
        params: {
          pack_id: spec.requiredPack ?? "wan-animate",
          audioRef: audio.ref,
          ...(typeof audio.seconds === "number" &&
          Number.isFinite(audio.seconds)
            ? { audio_seconds: audio.seconds }
            : {}),
          ...(text ? { target: text } : {}),
          ...(clicks.length ? { smartTrack: clicks } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "talking_avatar": {
      if (!audio?.ref) throw new ToolInputError("Add the audio first.");
      const avatarScene = composeAvatarScene(text, pick("gesture"));
      return {
        action: "talking_avatar",
        params: {
          pack_id: spec.requiredPack ?? "wan-animate",
          audioRef: audio.ref,
          ...(typeof audio.seconds === "number" &&
          Number.isFinite(audio.seconds)
            ? { audio_seconds: audio.seconds }
            : {}),
          mode: pick("mode") || "fast",
          ...(avatarScene ? { prompt: avatarScene } : {}),
        },
        overrides: {},
      };
    }
    case "transition":
      if (!secondRef) throw new ToolInputError("Add the end frame first.");
      return {
        action: "transition",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          secondRefImage: secondRef,
          ...(text ? { prompt: text } : {}),
          ...(pick("transitionStyle") !== TRANSITION_STYLES[0].id
            ? { transitionStyle: pick("transitionStyle") }
            : {}),
          ...h3ToggleParams(pick),
        },
        overrides: {},
      };
    case "ref_video": {
      const refs = [secondRef, ...(extraRefs ?? [])].filter(
        (r): r is string => Boolean(r),
      );
      return {
        action: "ref_video",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          ...(refs.length ? { secondRefImage: refs[0] } : {}),
          ...(refs.length > 1 ? { extraRefImages: refs.slice(1) } : {}),
          scene: pick("scene") || "market",
          ...(pick("lastRef") === "setting" && refs.length
            ? { lastIsSetting: true }
            : {}),
          aspect: pick("aspect") || "16:9",
          duration: pick("duration") || "3",
          ...refVideoLongParams(spec, settings, pick),
          ...(pick("resolution") === "768" ? { resolution: "768" } : {}),
          h3Speed: pick("h3Speed") || "turbo8",
          ...h3FlexParams(pick),
          ...(text ? { prompt: text } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "multiframe_ref": {
      // Keyframes 2..4 keep their own timing slider when a slot is skipped.
      const slots = [secondRef, ...(extraRefs ?? [])]
        .slice(0, MULTIFRAME_KEY_SLIDERS.length)
        .map((ref, i) => ({ ref, slider: MULTIFRAME_KEY_SLIDERS[i] }))
        .filter((s): s is { ref: string; slider: ActionSlider } =>
          Boolean(s.ref),
        );
      if (!slots.length)
        throw new ToolInputError("Add keyframe 2 first (at least 2 keyframes).");
      const custom = pick("timing") === "custom";
      return {
        action: "multiframe_ref",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          secondRefImage: slots[0].ref,
          ...(slots.length > 1
            ? { extraRefImages: slots.slice(1).map((s) => s.ref) }
            : {}),
          flow: pick("flow") || "continuous",
          timing: custom ? "custom" : "even",
          ...(custom
            ? {
                keyPositions: slots.map((s) => sliderValue(s.slider, settings)),
              }
            : {}),
          ...(pick("keysAsRefs") === "refs" ? { keysAsRefs: true } : {}),
          aspect: pick("aspect") || "16:9",
          duration: pick("duration") || "5",
          ...(pick("resolution") === "768" ? { resolution: "768" } : {}),
          h3Speed: pick("h3Speed") || "turbo8",
          ...h3FlexParams(pick),
          ...(text ? { prompt: text } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "h3_charsheet": {
      const views = parseCharSheetViews(
        settings.picks.views ?? CHAR_SHEET_DEFAULT_VIEWS.join(","),
      );
      if (!views.length) throw new ToolInputError("Choose at least one view.");
      // Roles follow their slot, then drop with it when the slot is empty.
      const slots = [
        { ref: secondRef, role: pick("ref2Role") },
        { ref: extraRefs?.[0], role: pick("ref3Role") },
      ].filter((s): s is { ref: string; role: string } => Boolean(s.ref));
      const name = settings.secondText?.trim() ?? "";
      return {
        action: "h3_charsheet",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          views: views.join(","),
          size: pick("size") || CHAR_SHEET_DEFAULT_SIZE,
          render: pick("render") || CHAR_SHEET_DEFAULT_RENDER,
          ...(slots.length ? { secondRefImage: slots[0].ref } : {}),
          ...(slots.length > 1 ? { extraRefImages: [slots[1].ref] } : {}),
          ...(slots.length
            ? { refRoles: slots.map((s) => s.role || CHAR_SHEET_DEFAULT_ROLE) }
            : {}),
          h3Speed: pick("h3Speed") || "turbo8",
          ...(text ? { prompt: text } : {}),
          ...(name ? { name } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "ltx25_animate":
      return {
        action: "ltx25_animate",
        params: {
          pack_id: spec.requiredPack ?? "ltx25",
          duration: pick("duration") || "5",
          ...(text ? { prompt: text } : {}),
          ...ltxExtraLoraParams(settings.picks),
        },
        overrides: {},
      };
    case "ltx25_transition":
      if (!secondRef) throw new ToolInputError("Add the end frame first.");
      return {
        action: "ltx25_transition",
        params: {
          pack_id: spec.requiredPack ?? "ltx25",
          secondRefImage: secondRef,
          duration: pick("duration") || "5",
          ...(text ? { prompt: text } : {}),
          ...ltxExtraLoraParams(settings.picks),
        },
        overrides: {},
      };
    case "subject_matte":
    case "video_bg_remove":
      if (spec.id === "subject_matte" || pick("engine") === "matanyone") {
        return {
          action: "subject_matte",
          params: {
            background: pick("background") || "alpha",
            ...(text ? { subject: text } : {}),
          },
          overrides: {},
        };
      }
      return {
        action: "video_bg_remove",
        params: { background: pick("background") || "alpha" },
        overrides: {},
      };
    case "video_bg_change": {
      const background = pick("background") || "image";
      if (background === "image" && !secondRef)
        throw new ToolInputError(
          "Add the background image, or pick Blur original.",
        );
      return {
        action: "video_bg_change",
        params: {
          background,
          blend: pick("blend") || "natural",
          ...(text ? { subject: text } : {}),
          ...(background === "image" && secondRef
            ? { secondRefImage: secondRef }
            : {}),
        },
        overrides: {},
      };
    }
    case "video_palette": {
      const slider = spec.sliders?.find((x) => x.key === "strength");
      const params: Record<string, unknown> = {
        source: pick("source") || "preset",
        strength: strengthFraction(
          slider ? sliderValue(slider, settings) : VIDEO_PALETTE_DEFAULT_STRENGTH,
        ),
        preserveLuminance: pick("luminance") === "keep",
        skinProtect: pick("skin") === "protect" ? VIDEO_PALETTE_SKIN_PROTECT : 0,
      };
      if (params.source === "reference") {
        if (!secondRef)
          throw new ToolInputError(
            "Add the reference still, or pick a preset / hex colors.",
          );
        params.secondRefImage = secondRef;
      } else if (params.source === "hex") {
        if (!text)
          throw new ToolInputError("Add hex colors, e.g. #0b3c49, #e07a2f.");
        try {
          params.palette = formatHexPalette(parseHexPalette(text));
        } catch (e) {
          throw new ToolInputError(`Hex colors: ${(e as Error).message}.`);
        }
      } else {
        const preset =
          videoPalettePreset(pick("preset")) ?? VIDEO_PALETTE_PRESETS[0];
        params.source = "preset";
        params.palette = preset.colors.join(", ");
      }
      return { action: "video_palette", params, overrides: {} };
    }
    case "video_object_remove":
    case "video_remove_text": {
      const clicks = parseSmartTrack(settings.smartTrack);
      if (spec.id === "video_object_remove" && !text && clicks.length === 0)
        throw new ToolInputError(
          "Say what to remove, or click it on the video (Smart select).",
        );
      return {
        action: spec.id,
        params: {
          speed: pick("speed") || "balanced",
          ...(spec.id === "video_remove_text"
            ? { textPreset: pick("textPreset") || "all" }
            : {}),
          ...(text ? { target: text } : {}),
          ...(clicks.length ? { smartTrack: clicks } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "video_object_swap": {
      const clicks = parseSmartTrack(settings.smartTrack);
      if (!text && clicks.length === 0)
        throw new ToolInputError(
          "Say what to replace, or click it on the video (Smart select).",
        );
      if (!secondRef)
        throw new ToolInputError("Add the photo of the replacement object.");
      const replacement = settings.secondText?.trim() ?? "";
      return {
        action: "video_object_swap",
        params: {
          secondRefImage: secondRef,
          speed: pick("speed") || "balanced",
          margin: pick("margin") || "normal",
          refPrep: pick("refPrep") || "cutout",
          ...(text ? { target: text } : {}),
          ...(replacement ? { replacement } : {}),
          ...(clicks.length ? { smartTrack: clicks } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "video_object_add": {
      const object = text;
      if (!object && !secondRef)
        throw new ToolInputError(
          "Describe the object, or add a photo of it.",
        );
      const surface = settings.secondText?.trim() ?? "";
      return {
        action: "video_object_add",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          position: pick("position") || OBJECT_ADD_DEFAULT_POSITION,
          size: pick("size") || OBJECT_ADD_DEFAULT_SIZE,
          ...(object ? { object } : {}),
          ...(surface ? { surface } : {}),
          ...(secondRef ? { secondRefImage: secondRef } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "video_bg_swap": {
      const setting = settings.secondText?.trim() ?? "";
      const settingPreset = pick("settingPreset");
      const hasPreset = settingPreset !== BG_SWAP_SETTINGS[0].id;
      if (!setting && !secondRef && !hasPreset)
        throw new ToolInputError(
          "Describe the new setting, pick a preset, or add a picture of it.",
        );
      const clicks = parseSmartTrack(settings.smartTrack);
      return {
        action: "video_bg_swap",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          ...(setting ? { setting } : {}),
          ...(hasPreset ? { settingPreset } : {}),
          ...(secondRef ? { secondRefImage: secondRef } : {}),
          ...(text ? { target: text } : {}),
          ...(clicks.length ? { smartTrack: clicks } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "cast_swap": {
      if (!secondRef)
        throw new ToolInputError("Add the first character photo.");
      const extras = (extraRefs ?? []).filter(Boolean);
      const subjects = (settings.smartTrackSubjects ?? [])
        .slice(0, 1 + extras.length)
        .map((occ) => parseSmartTrack(occ));
      return {
        action: "cast_swap",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          secondRefImage: secondRef,
          ...(extras.length ? { extraRefImages: extras } : {}),
          ...(text ? { roles: text } : {}),
          ...(subjects.some((c) => c.length)
            ? { smartTrackSubjects: subjects }
            : {}),
          ...followSubjectParams(spec, settings),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "flashvsr_upscale":
      return {
        action: "flashvsr_upscale",
        params: { scale: pick("scale") || "2x" },
        overrides: {},
      };
    case "rtx_upscale":
      return {
        action: "rtx_upscale",
        params: { scale: pick("scale") || "2x" },
        overrides: {},
      };
    case "ltx_upscale_x2":
      return { action: "ltx_upscale_x2", params: {}, overrides: {} };
    case "upscale_video":
      // Video: Fast = per-frame model upscale, Best = SeedVR2, plus the
      // FlashVSR and LTX x2 diffusion engines, and NVIDIA RTX VSR.
      if (pick("engine") === "flashvsr") {
        return {
          action: "flashvsr_upscale",
          params: { scale: pick("scale") || "2x" },
          overrides: {},
        };
      }
      if (pick("engine") === "rtx") {
        return {
          action: "rtx_upscale",
          params: { scale: pick("scale") || "2x" },
          overrides: {},
        };
      }
      if (pick("engine") === "ltx_x2") {
        return { action: "ltx_upscale_x2", params: {}, overrides: {} };
      }
      if (pick("engine") !== "best") {
        return {
          action: VIDEO_UPSCALE_ACTION,
          params: upscaleRequestParams(VIDEO_UPSCALE_ACTION, {
            model: settings.picks[UPSCALE_MODEL_PARAM],
            size: pick("scale"),
          }),
          overrides: {},
        };
      }
    // falls through
    case "upscale_seedvr2":
      return {
        action: "seedvr2_upscale",
        params: {
          media: spec.videoInput ? "video" : "image",
          scale: pick("scale") || "2x",
          model: pick("model") || "fast",
          color: pick("color") || "lab",
          ...(spec.videoInput
            ? {}
            : upscaleFinishParams({
                sharpen: finishSlider(spec, settings, UPSCALE_SHARPEN_PARAM),
                strength: finishSlider(spec, settings, UPSCALE_STRENGTH_PARAM),
              })),
        },
        overrides: {},
      };
    case "upscale_vosr2":
      return {
        action: "upscale_vosr2",
        params: {
          scale: pick("scale") || "4x",
          color: pick("color") || "wavelet",
          ...upscaleFinishParams({
            sharpen: finishSlider(spec, settings, UPSCALE_SHARPEN_PARAM),
            strength: finishSlider(spec, settings, UPSCALE_STRENGTH_PARAM),
          }),
        },
        overrides: {},
      };
    case "interpolate":
      return {
        action: "interpolate",
        params: {
          mode: pick("mode") || "smooth",
          multiplier: Number(pick("multiplier") || 2),
          model: pick("model") || "rife",
        },
        overrides: {},
      };
    case "relight":
    case "light_migration": {
      const preset =
        spec.id === "light_migration"
          ? "reference"
          : pick("preset") || "golden_hour";
      if (preset === "reference") {
        if (!secondRef)
          throw new ToolInputError(
            "Add the light reference photo, or pick a light preset.",
          );
        return {
          action: "light_migration",
          params: {
            secondRefImage: secondRef,
            faceDetail: pick("faceDetail") === "model" ? "model" : "keep",
            ...(text ? { text } : {}),
          },
          overrides: {},
        };
      }
      if (preset === "custom" && !text)
        throw new ToolInputError("Describe the lighting for Custom.");
      return {
        action: "relight",
        params: { preset, ...(text ? { text } : {}) },
        overrides: {},
      };
    }
    case "shots":
      return {
        action: "shots",
        params: text ? { text } : {},
        overrides: {},
      };
    case "zooms":
      return {
        action: "zooms",
        params: text ? { target: text } : {},
        overrides: {},
      };
    case "layers":
      return {
        action: "layers",
        params: {
          layers: Number(pick("layers") || 4),
          resolution: Number(pick("resolution") || 640),
          speed: pick("speed") || "fast",
          ...(text ? { text } : {}),
        },
        overrides: {},
      };
    case "vectorize":
      return {
        action: "vectorize",
        params: {
          preset: pick("preset") || "logo",
          colors: Number(pick("colors") || 0),
        },
        overrides: {},
      };
    case "breakdown":
      return {
        action: "breakdown",
        params: text ? { parts: text } : {},
        overrides: {},
      };
    case "see_through":
      return {
        action: "see_through",
        params: {
          detail: pick("detail") || "max",
          steps: Number(pick("steps") || 30),
          split: (pick("split") || "on") === "on",
          lowVram: pick("lowVram") === "on",
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "sdr_to_hdr": {
      const sl = spec.sliders?.find((x) => x.key === "peak");
      return {
        action: "sdr_to_hdr",
        params: {
          peak: sl ? sliderValue(sl, settings) : SDR_TO_HDR_DEFAULT_PEAK,
          exr: pick("exr") || "half",
        },
        overrides: {},
      };
    }
    case "refocus":
    case "rack_focus": {
      const slider = (key: string) => {
        const sl = spec.sliders?.find((x) => x.key === key);
        return sl ? sliderValue(sl, settings) : undefined;
      };
      const points = (settings.focusPoints ?? []).map(focusPoint);
      const params: Record<string, unknown> = {
        blur: slider("blur") ?? REFOCUS_DEFAULT_BLUR,
        highlights: slider("highlights") ?? REFOCUS_DEFAULT_HIGHLIGHTS,
        depthOfField: pick("depthOfField") || "normal",
        depthModel: pick("depthModel") || "quality",
      };
      if (spec.id === "refocus") {
        if (!points[0])
          throw new ToolInputError("Click the photo where it should be sharp.");
        return { action: "refocus", params: { ...params, focus: points[0] }, overrides: {} };
      }
      if (!points[0] || !points[1])
        throw new ToolInputError(
          "Pick focus point A and point B on the clip (scrub to the time, then click).",
        );
      return {
        action: "rack_focus",
        params: {
          ...params,
          focusA: points[0],
          focusB: points[1],
          ease: pick("ease") || "smooth",
        },
        overrides: {},
      };
    }
    case "video_edit":
      return {
        action: "video_edit",
        params: { prompt: text, speed: pick("speed") || "balanced" },
        overrides: {},
      };
    case "ltx_sdr_to_hdr":
      return {
        action: "ltx_sdr_to_hdr",
        params: {
          exr: pick("exr") || "half",
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_alpha_matte":
      return {
        action: "ltx_alpha_matte",
        params: settings.seed !== undefined ? { seed: settings.seed } : {},
        overrides: {},
      };
    case "ltx_clean_plate":
    case "ltx_day_to_night":
      return {
        action: spec.id,
        params: {
          ...(text ? { prompt: text } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_add_water":
      return {
        action: "ltx_add_water",
        params: {
          prompt: text,
          strength: Number(pick("strength") || "1"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_cinemagraph":
      return {
        action: "ltx_cinemagraph",
        params: {
          prompt: text,
          frames: Number(pick("frames") || "25"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
          ...ltxExtraLoraParams(settings.picks),
        },
        overrides: {},
      };
    case "ltx_slow_motion":
      return {
        action: "ltx_slow_motion",
        params: {
          prompt: text,
          speed: Number(pick("speed") || "0.2"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
          ...ltxExtraLoraParams(settings.picks),
        },
        overrides: {},
      };
    case "ltx_ripple":
      if (!secondRef) throw new ToolInputError("Add the edited first frame.");
      return {
        action: "ltx_ripple",
        params: {
          secondRefImage: secondRef,
          strength: Number(pick("strength") || "1.35"),
          ...(text ? { prompt: text } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_restore": {
      const slider = spec.sliders?.find((x) => x.key === "strength");
      return {
        action: pick("mode") || LTX_RESTORE_ACTION,
        params: {
          ...(text ? { prompt: text } : {}),
          strength: slider
            ? Math.round(sliderValue(slider, settings) * 100) / 100
            : 1,
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "ltx_reshoot":
      return {
        action: "ltx_reshoot",
        params: {
          prompt: text,
          orbit: pick("orbit"),
          height: pick("height"),
          distance: pick("distance"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_edge_control":
    case "ltx_blockout_render":
    case "ltx_layout_render":
    case "ltx_paint_fluid":
      return {
        action: spec.id,
        params: {
          ...(text ? { prompt: text } : {}),
          ...(secondRef ? { secondRefImage: secondRef } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "ltx_ingredients": {
      const sheet = settings.secondText?.trim() ?? "";
      const extras = [secondRef, ...(extraRefs ?? [])].filter(
        (r): r is string => !!r,
      );
      return {
        action: "ltx_ingredients",
        params: {
          prompt: text,
          ...(sheet ? { sheet } : {}),
          ...(extras.length ? { secondRefImage: extras[0] } : {}),
          ...(extras.length > 1 ? { extraRefImages: extras.slice(1) } : {}),
          strength: Number(pick("strength") || "1.4"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "ltx_exploded_view":
      return {
        action: "ltx_exploded_view",
        params: {
          ...(text ? { prompt: text } : {}),
          strength: Number(pick("strength") || "0.5"),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "voiceover": {
      const seed = settings.seed !== undefined ? { seed: settings.seed } : {};
      if (pick("engine") === "clone") {
        if (!audio?.ref)
          throw new ToolInputError("Add the voice sample first.");
        return {
          action: "voiceover",
          params: {
            pack_id: "audio",
            script: text,
            engine: "clone",
            audioRef: audio.ref,
            ...seed,
          },
          overrides: {},
        };
      }
      if (pick("engine") === "kokoro") {
        return {
          action: "voiceover",
          params: {
            pack_id: "audio",
            script: text,
            engine: "kokoro",
            voice: pick("kokoro_voice"),
            speed: Number(pick("pace") || 1),
            ...seed,
          },
          overrides: {},
        };
      }
      return {
        action: "voiceover",
        params: {
          pack_id: "audio",
          script: text,
          engine: "stock",
          voice: pick("voice"),
          ...seed,
        },
        overrides: {},
      };
    }
    case "add_sound": {
      const avoid = settings.secondText?.trim() ?? "";
      const sound = composeAsmrPrompt(pick("asmr"), text);
      return {
        action: "add_sound",
        params: {
          pack_id: "audio",
          ...(sound ? { prompt: sound } : {}),
          ...(avoid ? { negative_prompt: avoid } : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    }
    case "video_expand": {
      const params: Record<string, unknown> = {
        expand: pick("expand") || VIDEO_EXPAND_DEFAULT_MODE,
        engine:
          pick("engine") === "wan" ? "wan" : VIDEO_EXPAND_DEFAULT_ENGINE,
      };
      if (params.engine === "wan") params.speed = pick("speed") || "balanced";
      else params.res = pick("res") || String(VIDEO_EXPAND_LTX_DEFAULT_EDGE);
      const startSlider = spec.sliders?.find((sl) => sl.key === "start_frame");
      const start = startSlider ? sliderValue(startSlider, settings) : 0;
      if (start > 0) params.start_frame = Math.floor(start);
      if (text) params.prompt = text;
      return { action: spec.id, params, overrides: {} };
    }
    case "video_retake": {
      const slider = (key: string) => {
        const sl = spec.sliders?.find((x) => x.key === key);
        return sl ? Math.round(sliderValue(sl, settings) * 1000) / 1000 : undefined;
      };
      const start = slider("retake_start") ?? 0;
      const end = slider("retake_end") ?? VIDEO_RETAKE_WINDOW_SECONDS;
      if (end <= start)
        throw new ToolInputError("Range end must be after the range start.");
      const toEnd =
        settings.picks.retake_to_end === "1" ||
        end >= VIDEO_RETAKE_WINDOW_SECONDS;
      const params: Record<string, unknown> = {
        retake_start: start,
        retake_end: end,
        strength: slider("strength") ?? 1,
        audio: pick("audio") || VIDEO_RETAKE_DEFAULT_AUDIO,
        res: pick("res") || String(VIDEO_RETAKE_DEFAULT_EDGE),
      };
      if (toEnd) params.retake_to_end = true;
      if (text) params.prompt = text;
      if (settings.seed !== undefined) params.seed = settings.seed;
      return { action: spec.id, params, overrides: {} };
    }
    case "vace_restyle":
    case "vace_reframe":
    case "vace_extend": {
      const params: Record<string, unknown> = {
        speed: pick("speed") || "balanced",
      };
      if (text) params.prompt = text;
      if (spec.id === "vace_restyle") {
        const look = pick("look");
        const light = pick("light");
        if (look && look !== VACE_PRESET_NONE) params.look = look;
        if (light && light !== VACE_PRESET_NONE) params.light = light;
        if (!text && !params.look && !params.light)
          throw new ToolInputError(
            "Pick a Look or Relight preset, or describe the new look.",
          );
        if (secondRef) params.secondRefImage = secondRef;
      }
      if (spec.id === "vace_reframe") params.aspect = pick("aspect") || "9:16";
      if (spec.id === "vace_extend") {
        params.seconds = Number(pick("seconds") || 3);
        const cm = spec.sliders?.find((sl) => sl.key === "color_match");
        const v = cm ? sliderValue(cm, settings) : 100;
        if (cm && v !== cm.default) params.color_match = v / 100;
      }
      return { action: spec.id, params, overrides: {} };
    }
    case "face_swap":
      if (!secondRef) throw new ToolInputError("Add the face photo first.");
      // The LoRA is trained on the bare "Faceswap" trigger: no prompt knob.
      return {
        action: "face_swap",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          secondRefImage: secondRef,
        },
        overrides: {},
      };
    case "orbit_360":
      return {
        action: "orbit_360",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          ...(pick("orbitLook") !== ORBIT_PRESETS[0].id
            ? { orbitLook: pick("orbitLook") }
            : {}),
          ...(text ? { prompt: text } : {}),
          ...h3ToggleParams(pick),
        },
        overrides: {},
      };
    case "camera_move":
      return {
        action: "camera_move",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          cameraMove: pick("cameraMove"),
          resolution: pick("resolution"),
          ...(text ? { prompt: text } : {}),
          ...h3ToggleParams(pick),
        },
        overrides: {},
      };
    case "wan_motion": {
      // LTX-2.5 engine (only for presets that offer it): same preset, LTX i2v.
      if (resolveWanMotionEngine(pick("preset"), pick("engine")) === "ltx25") {
        const ltx = wanMotionLtxRequest({
          preset: pick("preset"),
          subject: text,
          duration: pick("duration"),
        });
        if (ltx) return { ...ltx, overrides: {} };
      }
      return {
        action: "wan_motion",
        params: {
          pack_id: spec.requiredPack ?? "wan22",
          preset: pick("preset"),
          mode: pick("mode"),
          resolution: pick("resolution"),
          duration: pick("duration"),
          ...(text ? { prompt: text } : {}),
        },
        overrides: {},
      };
    }
    case "wan_camera":
      return {
        action: "wan_camera",
        params: {
          pack_id: spec.requiredPack ?? "wan22",
          camera: pick("camera"),
          cameraSpeed: pick("cameraSpeed"),
          mode: pick("mode"),
          resolution: pick("resolution"),
          duration: pick("duration"),
          ...(text ? { prompt: text } : {}),
        },
        overrides: {},
      };
    case "wan_move":
      if (pick("source") === "draw") {
        const draw = parseWanMoveDraw(settings.wanMoveDraw);
        if (!draw)
          throw new ToolInputError(
            "Draw at least one path on the photo (drag from the object to where it should go).",
          );
        return {
          action: "wan_move",
          params: {
            pack_id: spec.requiredPack ?? "wan22",
            draw,
            mode: pick("mode"),
            duration: pick("duration"),
            ...(text ? { prompt: text } : {}),
          },
          overrides: {},
        };
      }
      return {
        action: "wan_move",
        params: {
          pack_id: spec.requiredPack ?? "wan22",
          trajectory: pick("trajectory"),
          region: pick("region"),
          mode: pick("mode"),
          duration: pick("duration"),
          ...(text ? { prompt: text } : {}),
        },
        overrides: {},
      };
    case "person_remove":
      return {
        action: "person_remove",
        params: {
          pack_id: spec.requiredPack ?? "minimax",
          ...(text ? { target: text } : {}),
          ...(hasSmartTrack(settings.smartTrack)
            ? { smartTrack: parseSmartTrack(settings.smartTrack) }
            : {}),
          ...(secondRef ? { secondRefImage: secondRef } : {}),
          ...(settings.secondText?.trim()
            ? { background: settings.secondText.trim() }
            : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
        overrides: {},
      };
    case "crossview":
      throw new ToolInputError(
        `${spec.title} is unavailable: ${spec.requiresNodes ?? "required nodes are missing"}`,
      );
    case "upscale": {
      const action = pick("mode");
      const slider = (key: string) => {
        const sl = spec.sliders?.find((x) => x.key === key);
        return sl ? sliderValue(sl, settings) : undefined;
      };
      return {
        action,
        params: upscaleRequestParams(action, {
          model: settings.picks[UPSCALE_MODEL_PARAM],
          creativity: slider("creativity"),
          size: pick(action === UPSCALE_REDETAIL_ACTION ? "detail_size" : "size"),
          cleanup: pick("cleanup"),
          redetail: slider("redetail"),
          sharpen: slider(UPSCALE_SHARPEN_PARAM),
          strength: slider(UPSCALE_STRENGTH_PARAM),
        }),
        overrides: {},
      };
    }
    case "enhance_faces":
      return { action: pick("mode"), params: {}, overrides: {} };
    case "animate":
      return {
        action: pick("motion"),
        params: text ? { prompt: text } : {},
        overrides: {},
      };
    case "describe":
      throw new ToolInputError("Describe does not queue a job.");
  }
}

// Mask helpers

/**
 * Painted RGBA overlay → black/white mask pixels (in place copy). Any pixel
 * with alpha > 0 becomes white (fill), the rest opaque black. Returns the
 * number of painted pixels.
 */
export function overlayToMaskPixels(rgba: Uint8ClampedArray | Uint8Array): {
  pixels: Uint8ClampedArray;
  painted: number;
} {
  const out = new Uint8ClampedArray(rgba.length);
  let painted = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const on = rgba[i + 3] > 8;
    const v = on ? 255 : 0;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
    if (on) painted++;
  }
  return { pixels: out, painted };
}

/**
 * Masks export at the source image's own size, so edges stay sharp instead of
 * being upscaled from a small mask. This cap only guards browser canvas memory
 * (iOS Safari stops at ~16.7 MP = 4096 x 4096); larger images are scaled down
 * and the server resizes the mask to the image.
 */
export const MASK_MAX_SIDE = 4096;

export function maskSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, MASK_MAX_SIDE / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
