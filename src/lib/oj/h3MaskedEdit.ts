/**
 * MiniMax H3 masked-edit tools: four packs that regenerate only a masked
 * region of a clip with H3 Ref2VA and paste it back at source resolution
 * (packs/minimax/{character_swap_masked,cast_swap,video_bg_swap,
 * video_object_add}.json).
 *
 *   character_swap_masked  "Mannequin" mode of Replace person in video: SAM
 *       3.1 tracks the person, the motion reference (<Video 1>) shows them as a
 *       smooth grey mannequin so H3 cannot copy the original face/clothes,
 *       H3 renders <Picture 1> inside the +40 px edit mask only. Motion
 *       guide (default Pose, applyMotionGuide): SDPose whole-body keypoints of
 *       the masked person drive the H3 Fun ControlNet inside the same mask.
 *   cast_swap  Up to 3 people, one reference photo each. Qwen3-VL 8B sees
 *       frame 0 with every tracked person tinted (red 0 / green 1 / blue 2)
 *       next to each photo and picks the person it replaces. One masked pass
 *       per person; masks of people already done are subtracted from later
 *       edit masks so two passes never touch the same face.
 *   video_bg_swap  Keeps the tracked people, regenerates everything else
 *       (inverted, grown person mask) from text and/or a background photo.
 *   video_object_add  A placement box (position + size presets) is the edit
 *       mask; H3 renders the object there with no motion reference.
 *
 * Every pass is the h3-relay masked-edit pattern: VAEEncode(prepared frames)
 * -> H3RelayApplyEditMask(Ref2V latent, source latent, edit mask) ->
 * 8-step Turbo sampling -> VAEDecode -> CJPasteBackSave (raw + expanded
 * mask, source audio).
 *
 * The mannequin motion reference, the background grey-blur reference, the
 * "no reference video" object add and the prompt structure are adapted from
 * openjutsu / comfyui-h3-oneclick-swap by D3voz (MIT License, Copyright (c)
 * 2026 D3voz; github.com/D3voz/openjutsu). Re-implemented with core ComfyUI
 * nodes; no code from its GPL parts is used. Its license:
 *
 * MIT License
 *
 * Copyright (c) 2026 D3voz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import { applyFollowCam, applyFollowCamCast } from "@/lib/oj/followCam";
import {
  applySmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
  type NodeRef,
  type SmartTrackOccurrence,
} from "@/lib/tools/smartTrack";

export const CHARACTER_SWAP_MASKED_ACTION = "character_swap_masked";
export const CAST_SWAP_ACTION = "cast_swap";
export const VIDEO_BG_SWAP_ACTION = "video_bg_swap";
export const VIDEO_OBJECT_ADD_ACTION = "video_object_add";

/** LabsH3PrepareVideo window: 124 frames @ 24 fps (H3 17n+5 grid). */
export const H3_MASKED_EDIT_SECONDS = 5.2;
export const H3_MASKED_EDIT_FPS = 24;
export const CAST_SWAP_MAX_PEOPLE = 3;

/** Node ids shared by the four packs. */
export const ME_NODES = {
  loadVideo: "7",
  prep: "29",
  samModel: "11",
  samText: "17",
  frame0: "12",
  samDetect: "13",
  samSelect: "14",
  samTrack: "15",
  samMask: "16",
  charLora: "9",
  refImage: "40",
  ref2v: "41",
  noise: "44",
  trim: "51",
  save: "52",
} as const;

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function seedOf(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? params.seed
    : Math.floor(Math.random() * 2 ** 32);
}

function sourceVideo(
  action: string,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
): string {
  const ref = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.videos?.[0],
  );
  if (!ref) throw new Error(`${action}: source run has no video`);
  return ref;
}

function imageRef(action: string, value: unknown, field: string): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (ref && !parseInputRef(ref))
    throw new Error(
      `${action}: ${field} must be an uploaded image ref ("name.png [input]")`,
    );
  return ref;
}

function requireNodes(action: string, workflow: Workflow, ids: string[]) {
  for (const id of ids)
    if (!workflow[id])
      throw new Error(`${action}: workflow is missing node ${id}`);
}

function setPrepWindow(workflow: Workflow) {
  setNodeInput(
    workflow,
    ME_NODES.prep,
    "duration_seconds",
    H3_MASKED_EDIT_SECONDS,
  );
}

function smartClicks(
  params: Record<string, unknown>,
  action: string,
  raw: unknown = params.smartTrack,
): SmartTrackOccurrence[] {
  return occurrencesInWindow(
    parseSmartTrack(raw),
    H3_MASKED_EDIT_SECONDS,
    action,
  );
}

function trackInto(
  workflow: Workflow,
  clicks: SmartTrackOccurrence[],
  replace: NodeRef,
  remove: string[],
  idBase?: number,
) {
  applySmartTrack(workflow, {
    sourceVideo: [ME_NODES.loadVideo, 0],
    frames: [ME_NODES.prep, 0],
    width: [ME_NODES.prep, 2],
    height: [ME_NODES.prep, 3],
    samModel: [ME_NODES.samModel, 0],
    occurrences: clicks,
    replace,
    remove,
    idBase,
  });
}

/** Drop a node's ref_image_0 (and LoadImage) when no picture was given. */
function dropRefImage(workflow: Workflow, ref2v: string, loader: string) {
  delete workflow[ref2v].inputs["ref_images.ref_image_0"];
  delete workflow[loader];
}

type Built = { workflow: Workflow; slots: WorkflowSlots; seed: number };

const DESC_MARK = "\u0001";

/**
 * Swap prompt with the character's outfit sentence. A typed description is
 * spliced in directly (the Qwen3-VL describe nodes descNode..descNode+2 are
 * dropped); otherwise the prompt is split around the sentence slot and the
 * two StringConcatenate nodes join head + Qwen sentence + tail. Without a
 * sentence H3 dresses the mannequin in its own light-grey-ish clothes.
 */
function setSwapPrompt(
  workflow: Workflow,
  ref2v: string,
  descNode: number,
  build: (desc: string) => string,
  userDesc: string,
) {
  const ids = [descNode, descNode + 1, descNode + 2].map(String);
  if (userDesc || !ids.every((i) => workflow[i])) {
    setNodeInput(workflow, ref2v, "prompt", build(userDesc));
    for (const i of ids) delete workflow[i];
    return;
  }
  const [head, tail] = build(DESC_MARK).split(DESC_MARK);
  setNodeInput(workflow, ids[1], "string_a", head);
  setNodeInput(workflow, ids[2], "string_b", tail);
  setNodeInput(workflow, ref2v, "prompt", [ids[2], 0]);
}

function dropUnusedQwen(workflow: Workflow) {
  if (!Object.values(workflow).some((nd) => nd.class_type === "TextGenerate"))
    delete workflow["72"];
}

function slots(prompt: string, image: string): WorkflowSlots {
  return {
    ksamplerId: "",
    posTextId: prompt,
    posTextInputName: "prompt",
    negTextId: "",
    latentDimsId: "",
    imageInputId: image,
  };
}

/* Prompts (structure from openjutsu build_prompt / build_edit_prompt /  */
/* build_add_prompt, MIT, D3voz)                                        */

const SOUND =
  "overall_soundscape:\nAny ambience and physical sounds already present in <Audio 1> remain part of its unchanged mix. " +
  "Add no new room noise, footsteps, voices or impacts.\n\nnon_diegetic_music:\nReuse the original music and vocals in <Audio 1> " +
  "at their original tempo, pitch, mix and synchronization. Do not generate a new performance or additional score.";
const SOUND_NO_REF = SOUND.split("<Audio 1>").join("the source soundtrack");
// "lip-sync any vocals" makes swapped people mouth along to sung music;
// tying lips to visible talking in <Video 1> plus understated-expression bans
// keeps mouths closed like the source. BasicGuider has no negative, so bans
// live here.
const LIP_SYNC =
  "Lips move only where the source people visibly talk or sing in <Video 1>; while they are not talking their mouths stay as relaxed as in <Video 1>, even when the music has vocals. " +
  "Expressions stay natural and understated: no exaggerated expressions, no beauty-filter skin. The soundtrack itself is unchanged. ";
const KEEP_MOTION =
  "Continue the original camera movement and performance through the last frame without adding transitions or changing speed.";

const secs = (s = H3_MASKED_EDIT_SECONDS) => s.toFixed(3);

/** "the man in red" -> role words used in the prompt. */
export function swapRole(target: unknown): string {
  const t = clean(target, 160);
  if (!t || /^(a |the )?(person|people|human)$/i.test(t))
    return "the main person";
  return /^(the|a|an) /i.test(t) ? t : `the ${t}`;
}

/**
 * Prompt for one masked swap pass: <Picture 1> replaces `role`, who is the
 * grey mannequin in <Video 1>; `others` = everyone else stays as is.
 */
export function maskedSwapPrompt(
  role: string,
  seconds?: number,
  others = false,
  desc = "",
): string {
  const lines = [
    "subject_definitions:",
    `<Subject 1> is the person from <Picture 1>. ${desc ? desc + " " : ""}They replace ${role} in <Video 1>, in every shot where that person appears. ` +
      "Their face, hair, body and clothing all come from <Picture 1>.",
  ];
  if (others)
    lines.push(
      "<Subject 2> is every other person in <Video 1>, who is not replaced here and keeps exactly their look in <Video 1>.",
    );
  const setting = others ? 3 : 2;
  lines.push(
    `<Subject ${setting}> is the setting, props and lighting in <Video 1>.`,
    `<Video 1> is the source footage being edited, a ${secs(seconds)}-second section at 24 fps, in which the person to replace is shown as a smooth grey ` +
      "figure. It supplies the exact camera framing, camera movement, performance timing, body poses, interactions and hard cuts. " +
      "The grey figure supplies movement only; face, hair, skin and clothing come from the picture.",
    "<Audio 1> is the synchronized original soundtrack supplied with <Video 1>, reused unchanged as the complete final soundtrack.",
    "",
    "summary:",
    "[video editing + reference generation + audio reuse] The target video is an edited version of <Video 1>. " +
      `<Subject 1> takes the place of ${role}. Identity and complete outfit come from the picture. ` +
      "The source performance, camera, cuts, setting, props and soundtrack retain their timing and layout.",
    "",
    "retention_analysis:",
    "<Subject 1> (all shots): fully_preserved - the referenced facial identity, hair, skin tone and complete outfit remain consistent " +
      `while poses and mouth movements follow ${role}.`,
  );
  if (others)
    lines.push(
      "<Subject 2> (all shots): fully_copy - unchanged from <Video 1>.",
    );
  lines.push(
    `<Subject ${setting}> (setting and props): fully_preserved - the location, props and lighting retain their source appearance and position.`,
    "<Video 1> (edited source): partially_preserved - the replaced person's identity and outfit change; camera movement, shot composition, " +
      "actions, interaction, cuts and timing are retained.",
    "<Audio 1>: fully_copy - the original synchronized soundtrack is the complete final audio, without additional generated vocals or sound effects.",
    "",
    "detailed_description:",
    "Live-action footage in the same setting as <Video 1>, with natural skin tones and the source lighting and lens perspective. " +
      "The replacement person appears only where the person they replace is visible; the background of the picture does not enter the scene.",
    `<Subject 1> performs every action of ${role}: the same gestures, steps, gaze, expressions and mouth shapes at the same moments.`,
    `Throughout all shots, ${role} is always the person in <Picture 1>, regardless of screen position or size. Their outfit replaces the ` +
      `original clothing completely; no face, hair, skin, costume, fabric pattern or accessory of ${role} remains. ` +
      LIP_SYNC +
      KEEP_MOTION,
    "",
    SOUND,
  );
  return lines.join("\n");
}

/** Background swap prompt (openjutsu build_edit_prompt, mode "background"). */
export function bgSwapPrompt(
  keep: string,
  setting: string,
  picture: boolean,
  seconds?: number,
): string {
  const thing = keep || "the people";
  const Thing = thing[0].toUpperCase() + thing.slice(1);
  const newSetting = "<Subject 1>" + (setting ? `, ${setting}` : "");
  return [
    "subject_definitions:",
    picture
      ? "<Subject 1> is the new setting from <Picture 1>."
      : `<Subject 1> is the new setting: ${setting || "a new location"}.`,
    `<Video 1> is the source footage being edited, a ${secs(seconds)}-second section at 24 fps, in which the setting around ${thing} is shown ` +
      "as a smooth grey blur that supplies only the camera movement and rough layout. It supplies the exact camera framing, camera movement, " +
      "people, performance timing and hard cuts.",
    "<Audio 1> is the synchronized original soundtrack supplied with <Video 1>, reused unchanged as the complete final soundtrack.",
    "",
    "summary:",
    "[video editing + reference generation + audio reuse] The target video is an edited version of <Video 1>. " +
      `${Thing} keeps their exact look and performance, while the setting around them becomes ${newSetting}. ` +
      "Everything else keeps its source look, timing and layout.",
    "",
    "retention_analysis:",
    "<Subject 1> (setting): partially_preserved - the look, materials and lighting of the new setting come from it; the camera " +
      "framing and movement are those of <Video 1>.",
    `<Video 1> (edited source): partially_preserved - only the setting changes; ${thing}, the actions, camera movement, cuts and timing are retained.`,
    "<Audio 1>: fully_copy - the original synchronized soundtrack is the complete final audio, without additional generated vocals or sound effects.",
    "",
    "detailed_description:",
    "Live-action footage with the source lighting and lens perspective.",
    `Throughout all shots, the surroundings are ${newSetting}, lit to match ${thing}; no part of the original location remains.`,
    KEEP_MOTION,
    "",
    SOUND,
  ].join("\n");
}

/* Background swap setting presets                                      */

export const BG_SWAP_CUSTOM = "custom";

/**
 * "New setting" presets (Tools card picker). Used only when the setting text
 * is empty; a background picture still leads when one is uploaded. The first
 * entry (custom) means: use what was typed or uploaded.
 */
export const BG_SWAP_SETTINGS: { id: string; label: string; text: string }[] = [
  { id: BG_SWAP_CUSTOM, label: "Custom (type or picture)", text: "" },
  {
    id: "neon_city",
    label: "Neon city at night",
    text: "a rain-soaked neon city street at night, glowing signs reflected in the wet asphalt",
  },
  {
    id: "golden_beach",
    label: "Beach at golden hour",
    text: "a quiet sandy beach at golden hour, low warm sun and gentle waves behind",
  },
  {
    id: "snow_village",
    label: "Snowy village",
    text: "a snowy mountain village at dusk, light snowfall and warmly lit windows",
  },
  {
    id: "white_studio",
    label: "White studio",
    text: "a seamless white photo studio cyclorama with soft, even light",
  },
  {
    id: "misty_forest",
    label: "Misty forest",
    text: "a misty pine forest in soft morning light, sunbeams through the trees",
  },
  {
    id: "space_station",
    label: "Space station",
    text: "the bright interior of an orbital space station, the Earth visible through a large window",
  },
  {
    id: "desert_canyon",
    label: "Desert canyon",
    text: "a red rock desert canyon under a clear blue midday sky",
  },
];

/** Setting sentence of a BG_SWAP_SETTINGS id ("" for custom / unknown). */
export function bgSwapSettingText(id: unknown): string {
  return BG_SWAP_SETTINGS.find((s) => s.id === id)?.text ?? "";
}

/* Object add placement                                                 */

export const OBJECT_ADD_POSITIONS: Record<
  string,
  { cx: number; cy: number; label: string }
> = {
  "top-left": { cx: 0.22, cy: 0.25, label: "Top left" },
  top: { cx: 0.5, cy: 0.25, label: "Top" },
  "top-right": { cx: 0.78, cy: 0.25, label: "Top right" },
  left: { cx: 0.22, cy: 0.5, label: "Left" },
  center: { cx: 0.5, cy: 0.5, label: "Center" },
  right: { cx: 0.78, cy: 0.5, label: "Right" },
  "bottom-left": { cx: 0.22, cy: 0.72, label: "Bottom left" },
  bottom: { cx: 0.5, cy: 0.72, label: "Bottom" },
  "bottom-right": { cx: 0.78, cy: 0.72, label: "Bottom right" },
};
export const OBJECT_ADD_SIZES: Record<string, { frac: number; label: string }> =
  {
    small: { frac: 0.2, label: "Small" },
    medium: { frac: 0.32, label: "Medium" },
    large: { frac: 0.48, label: "Large" },
  };
export const OBJECT_ADD_DEFAULT_POSITION = "bottom";
export const OBJECT_ADD_DEFAULT_SIZE = "medium";
const CANVAS = 1000;

const pick = <T>(
  table: Record<string, T>,
  value: unknown,
  fallback: string,
): string => {
  const k = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(table, k) ? k : fallback;
};

/** Box on the 1000x1000 canvas (stretched to the frame later). */
export function objectAddBox(position: unknown, size: unknown) {
  const p =
    OBJECT_ADD_POSITIONS[
      pick(OBJECT_ADD_POSITIONS, position, OBJECT_ADD_DEFAULT_POSITION)
    ];
  const s = Math.round(
    OBJECT_ADD_SIZES[pick(OBJECT_ADD_SIZES, size, OBJECT_ADD_DEFAULT_SIZE)]
      .frac * CANVAS,
  );
  const clamp = (v: number) => Math.min(CANVAS - s, Math.max(0, v));
  return {
    x: clamp(Math.round(p.cx * CANVAS - s / 2)),
    y: clamp(Math.round(p.cy * CANVAS - s / 2)),
    size: s,
  };
}

/** Where the box sits, in words: H3's text encoder never sees the mask (openjutsu placement_words). */
export function placementWords(box: {
  x: number;
  y: number;
  size: number;
}): string {
  const cx = (box.x + box.size / 2) / CANVAS;
  const cy = (box.y + box.size / 2) / CANVAS;
  const col = cx < 0.36 ? "left" : cx > 0.64 ? "right" : "centre";
  const row = cy < 0.36 ? "upper" : cy > 0.64 ? "lower" : "middle";
  if (row === "middle")
    return col === "centre"
      ? "in the centre of the frame"
      : `on the ${col} of the frame`;
  return `in the ${row} ${col} of the frame`;
}

/** Object add prompt (openjutsu build_add_prompt; no reference video). */
export function objectAddPrompt(
  object: string,
  surface: string,
  where: string,
  picture: boolean,
  seconds?: number,
): string {
  const thing = object || "the new object";
  const target = surface || "in the scene";
  const neu = picture ? `<Subject 1> (${thing})` : thing;
  const lines = ["subject_definitions:"];
  if (picture) lines.push(`<Subject 1> is ${thing}, from <Picture 1>.`);
  lines.push(
    `The source footage is a ${secs(seconds)}-second section at 24 fps. It supplies the exact camera framing, camera movement, people, ` +
      "performance timing, setting and hard cuts, and its original soundtrack is reused unchanged.",
    "",
    "summary:",
    `[video editing + ${picture ? "reference generation + " : ""}audio reuse] The target video is an edited version of the source footage in which ` +
      `${neu} is ${target}, ${where}, a real object with contact shadows that match the source light and perspective. ` +
      "Everything else keeps its source look, timing and layout.",
    "",
    "retention_analysis:",
  );
  if (picture)
    lines.push(
      "<Subject 1> (all shots): fully_preserved - its shape, colours, materials and details stay consistent in every frame.",
    );
  lines.push(
    `The source footage (edited source): partially_preserved - the only change is ${neu} ${target}; the people, actions, camera movement, ` +
      "shot composition, cuts and timing are retained.",
    "The soundtrack: fully_copy - the original synchronized soundtrack is the complete final audio, without additional generated vocals or sound effects.",
    "",
    "detailed_description:",
    "Live-action footage with the source lighting and lens perspective.",
    `Throughout all shots, ${neu} is clearly visible ${target}, ${where}, with the same size, identity and materials in every frame; people ` +
      "who move in front of it pass in front of it.",
    KEEP_MOTION,
    "",
    SOUND_NO_REF,
  );
  return lines.join("\n");
}

/* Builders                                                             */

/* Exact fidelity: every source frame 1:1, composite in the source's YUV */

const EXACT_PASTE_BACK = "52";
const EXACT_EDIT_AREA = "20";
const EXACT_REF_TEXT = "97";
const EXACT_REF_DETECT = "98";
const EXACT_REF_ON_SCENE = "99";
const EXACT_EDIT_EXPAND = 80;
const EXACT_EDGE_RAMP = 28;
export const EXACT_WINDOW_FRAMES = 124;
export const EXACT_WINDOW_OVERLAP = 39;
export const EXACT_WINDOW_NODE = "96";

/** params.fidelity === "exact": see comfy_nodes/cj_h3_tools/cj_exact.py. */
export function exactOf(params: Record<string, unknown>): boolean {
  return params.fidelity === "exact";
}

/**
 * Swaps the 24 fps cropped prepare and the RGB paste-back for the exact pair
 * (same output slots) and runs the sampler in context windows, which do
 * nothing on clips shorter than one window. Length stays a link: the frame
 * count is only known once the source is decoded.
 */
function applyExact(workflow: Workflow, params: Record<string, unknown>) {
  const res = params.resolution === "768" ? "768" : "480";
  workflow[ME_NODES.prep] = {
    class_type: "CJExactPrepare",
    inputs: {
      video: [ME_NODES.loadVideo, 0],
      resolution: res,
      duration_seconds: 0,
    },
    _meta: { title: "Exact prepare (every frame, no crop)" },
  } as Workflow[string];
  const paste = workflow[EXACT_PASTE_BACK];
  if (!paste) throw new Error("character_swap_masked: paste-back node missing");
  // The model repaints all of its editable area and carries the character
  // photo's background into it. Cut the character out onto a blurred copy of
  // the scene, and give the area room with a soft fade: at +40 px the grey guide
  // figure shows as a halo and its coat comes back. Sizes are at the 480 render.
  const photo = workflow[ME_NODES.ref2v]?.inputs["ref_images.ref_image_0"];
  if (!photo) throw new Error("character_swap_masked: character photo missing");
  workflow[EXACT_REF_TEXT] = {
    class_type: "CLIPTextEncode",
    inputs: { clip: [ME_NODES.samModel, 1], text: "person" },
    _meta: { title: "Character photo: find the person" },
  } as Workflow[string];
  workflow[EXACT_REF_DETECT] = {
    class_type: "SAM3_Detect",
    inputs: {
      model: [ME_NODES.samModel, 0],
      image: photo,
      conditioning: [EXACT_REF_TEXT, 0],
      threshold: 0.35,
      refine_iterations: 2,
      individual_masks: true,
    },
    _meta: { title: "Character photo: person mask" },
  } as Workflow[string];
  workflow[EXACT_REF_ON_SCENE] = {
    class_type: "CJRefOnScene",
    inputs: {
      reference: photo,
      reference_masks: [EXACT_REF_DETECT, 0],
      scene: [ME_NODES.frame0, 0],
      scene_mask: [ME_NODES.samSelect, 0],
    },
    _meta: { title: "Character photo on the scene" },
  } as Workflow[string];
  workflow[ME_NODES.ref2v].inputs["ref_images.ref_image_0"] = [EXACT_REF_ON_SCENE, 0];
  const sizeScale = res === "768" ? 1.6 : 1;
  const editArea = workflow[EXACT_EDIT_AREA];
  if (!editArea) throw new Error("character_swap_masked: edit area node missing");
  editArea.inputs.expand = Math.round(EXACT_EDIT_EXPAND * sizeScale);
  workflow[EXACT_PASTE_BACK] = {
    class_type: "CJExactPasteSave",
    inputs: {
      frames: paste.inputs.frames,
      source: paste.inputs.source,
      raw_mask: paste.inputs.raw_mask,
      expanded_mask: paste.inputs.expanded_mask,
      source_frames: [ME_NODES.prep, 5],
      filename_prefix: "video/CJ_H3_CharSwapExact",
      crf: 14,
      master: params.output === "master",
      diff_thresh: paste.inputs.diff_thresh,
      grow_px: paste.inputs.grow_px,
      feather_px: paste.inputs.feather_px,
      t_radius: paste.inputs.t_radius,
      match_colour: true,
      edge_ramp_px: Math.round(EXACT_EDGE_RAMP * sizeScale),
    },
    _meta: { title: "Exact paste back + save" },
  } as Workflow[string];
  const guider = workflow["45"];
  if (!guider) throw new Error("character_swap_masked: guider node missing");
  workflow[EXACT_WINDOW_NODE] = {
    class_type: "MiniMaxH3ContextWindows",
    inputs: {
      model: guider.inputs.model,
      context_length: EXACT_WINDOW_FRAMES,
      context_overlap: EXACT_WINDOW_OVERLAP,
      fuse_method: "pyramid",
      freenoise: true,
      split_conds_to_windows: false,
    },
    _meta: { title: "Long clip: H3 context windows" },
  } as Workflow[string];
  guider.inputs.model = [EXACT_WINDOW_NODE, 0];
}

/** Mannequin character swap (character_swap tool, modes "mannequin", "exact"). */
export function buildCharacterSwapMaskedWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  rawParams: Record<string, unknown> = {},
): Built {
  const action = CHARACTER_SWAP_MASKED_ACTION;
  const exact = exactOf(rawParams);
  // 2K finish and follow-cam work in the crop geometry; clicks are stamped at
  // 24 fps. None of them hold on the source's own timeline.
  const params = exact
    ? {
        ...rawParams,
        finish: "off",
        followSubject: "off",
        smartTrack: undefined,
      }
    : rawParams;
  const workflow = cloneWorkflow(baseWorkflow);
  requireNodes(action, workflow, [
    ME_NODES.loadVideo,
    ME_NODES.prep,
    ME_NODES.samText,
    ME_NODES.samMask,
    ME_NODES.refImage,
    ME_NODES.ref2v,
    ME_NODES.noise,
  ]);
  setNodeInput(
    workflow,
    ME_NODES.loadVideo,
    "file",
    sourceVideo(action, sourceRun, sourceJobIndex),
  );
  const ref = imageRef(action, params.secondRefImage, "secondRefImage");
  if (!ref)
    throw new Error(
      `${action}: a character photo (secondRefImage) is required`,
    );
  setNodeInput(workflow, ME_NODES.refImage, "image", ref);
  if (!exact) setPrepWindow(workflow);

  const target = clean(params.target, 120);
  setNodeInput(workflow, ME_NODES.samText, "text", target || "person");
  const clicks = smartClicks(params, action);
  if (clicks.length > 0)
    trackInto(
      workflow,
      clicks,
      [ME_NODES.samMask, 0],
      [
        ME_NODES.frame0,
        ME_NODES.samDetect,
        ME_NODES.samSelect,
        ME_NODES.samTrack,
        ME_NODES.samMask,
        ME_NODES.samText,
      ],
    );

  const role = clicks.length ? "the selected person" : swapRole(target);
  setSwapPrompt(
    workflow,
    ME_NODES.ref2v,
    37,
    (desc) => maskedSwapPrompt(role, undefined, false, desc),
    clean(params.description, 400),
  );
  dropUnusedQwen(workflow);
  applyMotionGuide(workflow, params);
  applyFinish2K(workflow, params);
  applyFollowCam(workflow, params);
  if (exact) applyExact(workflow, params);
  const seed = seedOf(params);
  setNodeInput(workflow, ME_NODES.noise, "noise_seed", seed);
  return { workflow, slots: slots(ME_NODES.ref2v, ME_NODES.refImage), seed };
}

/* 2K finish: Open-H3-Regenerate re-render of the swap (opt-in)         */

export type Finish = "off" | "2k";

/** Finish subgraph shipped detached in character_swap_masked.json. */
export const FINISH_2K_IDS = {
  prepare: "80",
  encode: "81",
  upscalerModel: "82",
  width: "83",
  height: "84",
  upscale: "85",
  refine: "86",
  lora: "87",
  sigmas: "88",
  sampler: "89",
  guider: "90",
  sample: "91",
  separate: "92",
  decode: "93",
  finish: "94",
  align: "95",
} as const;
export const FINISH_2K_MODELS = {
  lora: "h3/open_h3_regenerate_2k_lora.safetensors",
  curve: "h3/sharp_curve_branches.safetensors",
  upscaler: "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
} as const;
/** start_sigma of the 3-step refine (UI 40-80%, default 50%). 0.35 came out
 * softer and still moved the expression, so the floor stays above it. */
export const FINISH_DEFAULT_STRENGTH = 0.5;
export const FINISH_STRENGTH_RANGE = { min: 0.4, max: 0.8 } as const;
const PASTE_BACK = "52";

/** "off" (default) or "2k". */
export function finishOf(params: Record<string, unknown>): Finish {
  return params.finish === "2k" ? "2k" : "off";
}

/**
 * 2K finish (opt-in): the trimmed swap frames (node 51, generation geometry)
 * go through the Open-H3-Regenerate chain (576p prepare -> H3 latent
 * upscaler to the 1080p grid -> 3-step refine with the 2K LoRA + sharp curve
 * under the swap's own Ref2VA conditioning -> 1088 -> 1080 crop) and
 * CJRegenAlign brings the result back to the frames' aspect before
 * paste-back, which then upscales the source to the finish's size
 * (output_res "frames"). The pack marks 80-95 optional so the model check
 * does not require the finish weights; when 2K is picked the flag is
 * dropped so a missing node pack fails loudly instead of being bypassed.
 * Off removes 80-95, leaving the base graph node for node.
 */
export function applyFinish2K(
  workflow: Workflow,
  params: Record<string, unknown>,
) {
  const I = FINISH_2K_IDS;
  const save = workflow[PASTE_BACK];
  if (finishOf(params) === "2k" && save && workflow[I.align]) {
    for (const id of Object.values(I)) {
      const node = workflow[id];
      if (!node) throw new Error(`character_swap_masked: 2K finish node ${id} missing`);
      if (node._meta) delete node._meta.optional;
    }
    workflow[I.sigmas].inputs.start_sigma = num(
      params.finishStrength,
      FINISH_STRENGTH_RANGE.min,
      FINISH_STRENGTH_RANGE.max,
      FINISH_DEFAULT_STRENGTH,
    );
    save.inputs.frames = [I.align, 0];
    save.inputs.output_res = "frames";
    return;
  }
  for (const id of Object.values(I)) delete workflow[id];
}

/* Motion guide: SDPose skeleton of the masked subject (pack default)   */

export type MotionGuide = "off" | "pose" | "depth";

/** Pose subgraph shipped in character_swap_masked.json (ids 60-70). */
export const MOTION_GUIDE_POSE_IDS = {
  detector: "60",
  sdpose: "61",
  outside: "62",
  subject: "63",
  black: "64",
  detect: "65",
  keypoints: "66",
  draw: "67",
  poseVideo: "68",
  patch: "69",
  apply: "70",
} as const;
export const MOTION_GUIDE_POSE_MODELS = {
  detector: "rt_detr_v4-x-hgnet_fp16.safetensors",
  sdpose: "sdpose_wholebody_fp16.safetensors",
  controlnet: "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors",
} as const;
/** Pose control strength (UI 20-120%, default 80%). The comfy.org Fun
 * ControlNet pose template runs 1.0 on a full repaint; inside the mask the
 * grey mannequin already carries the motion, so a little less leaves the
 * Character Swap LoRA room for the new body's proportions. */
export const MOTION_GUIDE_POSE_DEFAULT_STRENGTH = 0.8;
export const MOTION_GUIDE_STRENGTH_RANGE = { min: 0.2, max: 1.2 } as const;

/** "pose" (default), "off", or the API-only "depth" (legacy motionLock). */
export function motionGuideOf(params: Record<string, unknown>): MotionGuide {
  const v = params.motionGuide;
  if (v === "off" || v === "pose" || v === "depth") return v;
  if (params.motionLock === "depth") return "depth";
  return "pose";
}

/**
 * Pose (default): the pack's RT-DETR + SDPose subgraph reads whole-body
 * keypoints from the prepared source with everything outside the edit mask
 * blacked out, so only the tracked subject can drive the control (other
 * people in the shot are never detected); the drawn skeleton is re-masked to
 * the edit area and MiniMaxH3FunControlNetApply applies it to the sampling
 * model with the same edit mask. Off / depth remove that subgraph and put
 * the guider back on the plain model: Off leaves the base graph node for
 * node.
 */
export function applyMotionGuide(
  workflow: Workflow,
  params: Record<string, unknown>,
  guider = "45",
) {
  const mode = motionGuideOf(params);
  const I = MOTION_GUIDE_POSE_IDS;
  const apply = workflow[I.apply];
  if (mode === "pose" && apply) {
    apply.inputs.strength = num(
      params.motionGuideStrength,
      MOTION_GUIDE_STRENGTH_RANGE.min,
      MOTION_GUIDE_STRENGTH_RANGE.max,
      MOTION_GUIDE_POSE_DEFAULT_STRENGTH,
    );
    return;
  }
  const g = workflow[guider];
  if (apply && g && isLink(g.inputs.model) && g.inputs.model[0] === I.apply)
    g.inputs.model = apply.inputs.model;
  for (const id of Object.values(I)) delete workflow[id];
  if (mode === "depth") applyMotionLock(workflow, { ...params, motionLock: "depth" }, guider);
}

const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

/* Motion lock: H3 Fun ControlNet Union 2.0 depth, inside the mask      */

export const MOTION_LOCK_CONTROLNET = MOTION_GUIDE_POSE_MODELS.controlnet;
export const MOTION_LOCK_DEPTH_MODEL =
  "depth_anything_3_mono_large.safetensors";
/** Default strength / release point. The control is let go at 60% of the
 * steps so the late steps redraw hair and clothing from <Picture 1> instead
 * of the original actor's silhouette volume. */
export const MOTION_LOCK_DEFAULTS = { strength: 0.5, end: 0.6 } as const;
export const MOTION_LOCK_IDS = {
  depthModel: "1900",
  depth: "1901",
  depthImage: "1902",
  patch: "1903",
  apply: "1904",
} as const; // smart-track uses 900+

const num = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : dflt;

/**
 * Motion guide "depth" (API only; legacy params.motionLock === "depth",
 * replaces the pose guide): Depth Anything 3 depth of the prepared
 * source frames drives MiniMaxH3FunControlNetApply (core) on the sampling
 * model, restricted to the grown edit mask, so the replacement follows the
 * source body's 3D motion (limb order, head turns, distance to camera)
 * rather than only the flat grey mannequin.
 */
export function applyMotionLock(
  workflow: Workflow,
  params: Record<string, unknown>,
  guider = "45",
  maskNode = "20",
) {
  if (params.motionLock !== "depth") return;
  const g = workflow[guider];
  if (!g || g.class_type !== "BasicGuider" || !workflow[maskNode]) return;
  const I = MOTION_LOCK_IDS;
  const strength = num(
    params.motionLockStrength,
    0,
    2,
    MOTION_LOCK_DEFAULTS.strength,
  );
  const end = num(params.motionLockEnd, 0.05, 1, MOTION_LOCK_DEFAULTS.end);
  workflow[I.depthModel] = {
    class_type: "LoadDA3Model",
    inputs: { model_name: MOTION_LOCK_DEPTH_MODEL, weight_dtype: "default" },
  };
  workflow[I.depth] = {
    class_type: "DA3Inference",
    inputs: {
      da3_model: [I.depthModel, 0],
      image: [ME_NODES.prep, 0],
      resolution: 504,
      resize_method: "upper_bound_resize",
      mode: "mono",
    },
  };
  workflow[I.depthImage] = {
    class_type: "DA3Render",
    inputs: {
      da3_geometry: [I.depth, 0],
      output: "depth",
      "output.normalization": "v2_style",
      "output.apply_sky_clip": false,
    },
  };
  workflow[I.patch] = {
    class_type: "ModelPatchLoader",
    inputs: { name: MOTION_LOCK_CONTROLNET },
  };
  workflow[I.apply] = {
    class_type: "MiniMaxH3FunControlNetApply",
    inputs: {
      model: g.inputs.model,
      model_patch: [I.patch, 0],
      vae: ["5", 0],
      strength,
      start_percent: 0,
      end_percent: end,
      control_video: [I.depthImage, 0],
      mask: [maskNode, 0],
      source_video: [ME_NODES.prep, 0],
    },
  };
  g.inputs.model = [I.apply, 0];
}

/** Clean the "who is who" text into one line per character photo. */
export function castRoles(value: unknown, count: number): string[] {
  const raw = typeof value === "string" ? value : "";
  const out: string[] = Array(count).fill("");
  const lines = raw
    .split(/\n|;|\//)
    .map((l) => l.trim())
    .filter(Boolean);
  let next = 0;
  for (const line of lines) {
    const m = line.match(/^([1-9])\s*[:=.)-]\s*(.+)$/);
    const i = m ? Number(m[1]) - 1 : next;
    const text = clean(m ? m[2] : line, 120);
    if (i >= 0 && i < count && text) out[i] = text;
    next = i + 1;
  }
  return out;
}

/** Qwen3-VL instruction for "which tinted person does this photo replace?". */
export function castPickPrompt(role: string, taken: boolean): string {
  return (
    "The left image is a video frame. Up to three people in it are tinted: person 0 red, person 1 green, person 2 blue. " +
    "The right image is a character photo. " +
    (role
      ? `This character replaces ${role}. `
      : "Pick the tinted person this character most plausibly replaces. ") +
    "Answer with a single digit, 0, 1 or 2" +
    (taken ? ", and never this already chosen digit: " : ".")
  );
}

export interface CastRefs {
  refs: string[];
}

/** Several people, one photo each (cast_swap tool). */
export function buildCastSwapWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const action = CAST_SWAP_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  requireNodes(action, workflow, [
    ME_NODES.loadVideo,
    ME_NODES.prep,
    ME_NODES.samText,
    ME_NODES.samTrack,
    "100",
    "300",
    "321",
  ]);
  setNodeInput(
    workflow,
    ME_NODES.loadVideo,
    "file",
    sourceVideo(action, sourceRun, sourceJobIndex),
  );
  setPrepWindow(workflow);

  const refs = [
    params.secondRefImage,
    ...(Array.isArray(params.extraRefImages) ? params.extraRefImages : []),
  ]
    .map((v, i) =>
      imageRef(
        action,
        v,
        i === 0 ? "secondRefImage" : `extraRefImages[${i - 1}]`,
      ),
    )
    .filter(Boolean)
    .slice(0, CAST_SWAP_MAX_PEOPLE);
  if (refs.length === 0)
    throw new Error(`${action}: at least one character photo is required`);
  const n = refs.length;
  const roles = castRoles(params.roles, n);
  const descriptions = Array.isArray(params.descriptions)
    ? params.descriptions
    : [];
  const target = clean(params.target, 120);
  setNodeInput(workflow, ME_NODES.samText, "text", target || "person");
  const seed = seedOf(params);

  // Per-subject clicks (params.smartTrackSubjects[k]) replace that person's
  // Qwen pick with a click track.
  const subjectClicks: SmartTrackOccurrence[][] = Array.from(
    { length: n },
    (_, k) => {
      const raw = Array.isArray(params.smartTrackSubjects)
        ? params.smartTrackSubjects[k]
        : undefined;
      return raw === undefined ? [] : smartClicks(params, action, raw);
    },
  );

  for (let k = 1; k <= CAST_SWAP_MAX_PEOPLE; k++) {
    const b = 100 * k;
    const id = (o: number) => String(b + o);
    if (k > n) {
      for (let o = 0; o <= 25; o++) delete workflow[id(o)];
      continue;
    }
    setNodeInput(workflow, id(0), "image", refs[k - 1]);
    const role = roles[k - 1];
    const who = role ? swapRole(role) : "the person shown as the grey figure";
    setSwapPrompt(
      workflow,
      id(11),
      b + 23,
      (desc) => maskedSwapPrompt(who, undefined, true, desc),
      clean(descriptions[k - 1], 400),
    );
    setNodeInput(workflow, id(14), "noise_seed", seed + k);
    if (subjectClicks[k - 1].length > 0) {
      // Clicked: this person's click track replaces the Qwen pick.
      trackInto(
        workflow,
        subjectClicks[k - 1],
        [id(5), 0],
        [id(1), id(2), id(3), id(4), id(5)],
        1000 + (k - 1) * 200,
      );
      continue;
    }
    // Pick prompt; later picks are told which digits earlier picks took.
    const taken = Array.from({ length: k - 1 }, (_, j) => j)
      .filter((j) => subjectClicks[j].length === 0)
      .map((j): NodeRef => [String(100 * (j + 1) + 4), 0]);
    setNodeInput(
      workflow,
      id(2),
      "string_a",
      castPickPrompt(role, taken.length > 0),
    );
    if (taken.length === 1) setNodeInput(workflow, id(2), "string_b", taken[0]);
    if (taken.length === 2) {
      workflow[id(22)] = {
        class_type: "StringConcatenate",
        inputs: { string_a: taken[0], string_b: taken[1], delimiter: " or " },
        _meta: { title: "Digits already taken" },
      };
      setNodeInput(workflow, id(2), "string_b", [id(22), 0]);
    }
  }

  // Finish from the last pass + its unions.
  const last = 100 * n;
  const unionRaw = n === 1 ? "106" : `${last + 20}`;
  const unionEdit = n === 1 ? "108" : `${last + 21}`;
  setNodeInput(workflow, ME_NODES.trim, "image", [`${last + 19}`, 0]);
  setNodeInput(workflow, ME_NODES.save, "raw_mask", [unionRaw, 0]);
  setNodeInput(workflow, ME_NODES.save, "expanded_mask", [unionEdit, 0]);
  applyFollowCamCast(workflow, params, n);

  // No Qwen pick left (every person clicked): drop the tint subgraph.
  const anyPick = Array.from({ length: n }, (_, j) => j).some(
    (j) => subjectClicks[j].length === 0,
  );
  if (!anyPick)
    for (const nid of Object.keys(workflow)) {
      const v = Number(nid);
      if (v >= 73 && v <= 93) delete workflow[nid];
    }
  dropUnusedQwen(workflow);
  const anyTextTrack = Object.values(workflow).some(
    (nd) =>
      nd.class_type === "SAM3_TrackToMask" &&
      Array.isArray(nd.inputs.track_data) &&
      nd.inputs.track_data[0] === ME_NODES.samTrack,
  );
  if (!anyTextTrack) {
    delete workflow[ME_NODES.samTrack];
    delete workflow[ME_NODES.samText];
    if (anyPick === false) delete workflow[ME_NODES.frame0];
  }

  return { workflow, slots: slots("111", "100"), seed };
}

/** Background swap (video_bg_swap tool). */
export function buildVideoBgSwapWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const action = VIDEO_BG_SWAP_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  requireNodes(action, workflow, [
    ME_NODES.loadVideo,
    ME_NODES.prep,
    ME_NODES.samText,
    ME_NODES.samMask,
    ME_NODES.ref2v,
    ME_NODES.noise,
  ]);
  setNodeInput(
    workflow,
    ME_NODES.loadVideo,
    "file",
    sourceVideo(action, sourceRun, sourceJobIndex),
  );
  setPrepWindow(workflow);

  // Typed setting wins; otherwise the picked BG_SWAP_SETTINGS preset.
  const setting =
    clean(params.setting ?? params.prompt, 300) ||
    bgSwapSettingText(params.settingPreset);
  const ref = imageRef(action, params.secondRefImage, "secondRefImage");
  if (!setting && !ref)
    throw new Error(
      `${action}: describe the new background or upload a background photo`,
    );
  if (ref) setNodeInput(workflow, ME_NODES.refImage, "image", ref);
  else dropRefImage(workflow, ME_NODES.ref2v, ME_NODES.refImage);

  const keep = clean(params.target, 120);
  setNodeInput(workflow, ME_NODES.samText, "text", keep || "person");
  const clicks = smartClicks(params, action);
  if (clicks.length > 0)
    trackInto(
      workflow,
      clicks,
      [ME_NODES.samMask, 0],
      [
        ME_NODES.frame0,
        ME_NODES.samDetect,
        ME_NODES.samTrack,
        ME_NODES.samMask,
        ME_NODES.samText,
      ],
    );
  const who = clicks.length
    ? "the selected people"
    : keep
      ? swapRole(keep).replace("the main person", "the people")
      : "the people";
  setNodeInput(
    workflow,
    ME_NODES.ref2v,
    "prompt",
    bgSwapPrompt(who, setting, !!ref),
  );
  const seed = seedOf(params);
  setNodeInput(workflow, ME_NODES.noise, "noise_seed", seed);
  return {
    workflow,
    slots: slots(ME_NODES.ref2v, ref ? ME_NODES.refImage : ME_NODES.loadVideo),
    seed,
  };
}

/** Object add (video_object_add tool). */
export function buildVideoObjectAddWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const action = VIDEO_OBJECT_ADD_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  requireNodes(action, workflow, [
    ME_NODES.loadVideo,
    ME_NODES.prep,
    "61",
    "62",
    ME_NODES.ref2v,
    ME_NODES.noise,
  ]);
  setNodeInput(
    workflow,
    ME_NODES.loadVideo,
    "file",
    sourceVideo(action, sourceRun, sourceJobIndex),
  );
  setPrepWindow(workflow);

  const object = clean(params.object ?? params.prompt, 200);
  const ref = imageRef(action, params.secondRefImage, "secondRefImage");
  if (!object && !ref)
    throw new Error(`${action}: describe the object or upload a photo of it`);
  if (ref) setNodeInput(workflow, ME_NODES.refImage, "image", ref);
  else dropRefImage(workflow, ME_NODES.ref2v, ME_NODES.refImage);

  const box = objectAddBox(params.position, params.size);
  setNodeInput(workflow, "61", "width", box.size);
  setNodeInput(workflow, "61", "height", box.size);
  setNodeInput(workflow, "62", "x", box.x);
  setNodeInput(workflow, "62", "y", box.y);
  const surface = clean(params.surface, 120);
  setNodeInput(
    workflow,
    ME_NODES.ref2v,
    "prompt",
    objectAddPrompt(object, surface, placementWords(box), !!ref),
  );
  const seed = seedOf(params);
  setNodeInput(workflow, ME_NODES.noise, "noise_seed", seed);
  return {
    workflow,
    slots: slots(ME_NODES.ref2v, ref ? ME_NODES.refImage : ME_NODES.loadVideo),
    seed,
  };
}
