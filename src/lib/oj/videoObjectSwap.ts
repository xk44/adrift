/**
 * "Swap object in video" from a reference image
 * (packs/wan22/video_object_swap.json).
 *
 * Same tracking, masking and paste-back as video_object_remove (SAM 3.1 text
 * prompt or Smart select clicks -> GrowMask -> CJMaskTemporal -> grey-filled
 * control video + control_masks -> two-stage Wan2.2 Fun VACE ->
 * CJPasteBackSave at source resolution with audio). The difference: the
 * uploaded photo of the replacement (params.secondRefImage) is VACE's
 * reference_image, cut out with BiRefNet and centred on white at the video
 * size (VACE's subject-reference convention), so the masked area is
 * repainted as THAT object instead of clean background.
 *
 * Params: target (what to replace, SAM prompt), replacement (optional words
 * for the new object, helps the prompt), smartTrack (clicks, replaces the
 * text SAM branch), secondRefImage (required), refPrep "cutout" | "asis",
 * margin "normal" | "wide" (wide = a differently shaped object), temporalRadius
 * (k: frames of mask dilation each side, default per margin), speed, seed.
 * control_masks take a wider, VACE latent-safe dilation (vaceMask.ts).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyVaceSpeed, vaceSpeed } from "./vaceVideo";
import { maskTemporalRadius } from "./vaceMask";
import {
  VIDEO_OBJECT_DEFAULT_TARGET,
  VIDEO_REMOVE_LENGTH,
  VIDEO_REMOVE_SECONDS,
  VOR_NODES,
  applyVaceMaskTiming,
  cleanRemoveTarget,
  plainTarget,
} from "./videoObjectRemove";
import {
  applySmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";

export const VIDEO_OBJECT_SWAP_ACTION = "video_object_swap";

/** Same 3 s / 73-frame window as removal (shared prepare + VACE length). */
export const VIDEO_SWAP_SECONDS = VIDEO_REMOVE_SECONDS;
export const VIDEO_SWAP_LENGTH = VIDEO_REMOVE_LENGTH;

/** Fixed node ids in packs/wan22/video_object_swap.json. */
export const VOS_NODES = {
  ...VOR_NODES,
  refLoad: "40",
  refBgModel: "41",
  refBgMask: "42",
  refCrop: "43",
  refFit: "44",
} as const;

export const VIDEO_SWAP_MARGINS: Record<
  string,
  { label: string; grow: number; temporal: number }
> = {
  normal: { label: "Similar shape", grow: 16, temporal: 2 },
  wide: { label: "Different shape", grow: 40, temporal: 4 },
};
export const VIDEO_SWAP_DEFAULT_MARGIN = "normal";
export const VIDEO_SWAP_REF_PREPS = ["cutout", "asis"] as const;

const TUNING = { threshold: 0.4, maxObjects: 4, detectInterval: 4 };

export const VIDEO_SWAP_NEGATIVE =
  "blurry, smeared, ghosting, artifacts, low quality, distorted, deformed, duplicate, worst quality, jpeg artifacts";

export function videoSwapMargin(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(VIDEO_SWAP_MARGINS, key)
    ? key
    : VIDEO_SWAP_DEFAULT_MARGIN;
}

export function objectSwapPrompts(
  target: string,
  replacement: string,
  margin: string = VIDEO_SWAP_DEFAULT_MARGIN,
): { positive: string; negative: string } {
  const plain = plainTarget(target) || VIDEO_OBJECT_DEFAULT_TARGET;
  const what = replacement
    ? `${replacement} (the object from the reference image)`
    : "the object from the reference image";
  // Never name the target in the positive prompt: VACE paints what it reads,
  // so "in place of the man" brings a (new) man back into the mask. A
  // "Different shape" swap (man -> cat) also puts
  // the target in the negative; a similar-shape swap (cup -> mug) does not,
  // or the negative would fight the replacement.
  const negTarget =
    videoSwapMargin(margin) === "wide" && plain !== VIDEO_OBJECT_DEFAULT_TARGET;
  return {
    positive:
      `${what}, filling the masked area in the same position, scale and motion, ` +
      "matching the scene's perspective, lighting and shadows, sharp natural detail, consistent with the rest of the video.",
    negative: negTarget
      ? `${plain}, ${VIDEO_SWAP_NEGATIVE}`
      : VIDEO_SWAP_NEGATIVE,
  };
}

export function buildVideoObjectSwapWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_OBJECT_SWAP_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);
  for (const id of Object.values(VOS_NODES)) {
    if (!workflow[id])
      throw new Error(`${action}: workflow is missing node ${id}`);
  }
  const ref =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (!ref || !parseInputRef(ref)) {
    throw new Error(
      `${action}: secondRefImage (the replacement object) must be an uploaded image ref ("name.png [input]")`,
    );
  }

  setNodeInput(workflow, VOS_NODES.load, "file", videoRef);
  setNodeInput(
    workflow,
    VOS_NODES.prep,
    "duration_seconds",
    VIDEO_SWAP_SECONDS,
  );
  setNodeInput(workflow, VOS_NODES.vace, "length", VIDEO_SWAP_LENGTH);

  // Reference: cut out on white (default) or the photo as is (already a
  // clean product shot, or BiRefNet would drop part of the object).
  setNodeInput(workflow, VOS_NODES.refLoad, "image", ref);
  setNodeInput(workflow, VOS_NODES.vace, "reference_image", [
    VOS_NODES.refFit,
    0,
  ]);
  if (params.refPrep === "asis") {
    setNodeInput(workflow, VOS_NODES.refFit, "image", [VOS_NODES.refLoad, 0]);
    delete workflow[VOS_NODES.refCrop];
    delete workflow[VOS_NODES.refBgMask];
    delete workflow[VOS_NODES.refBgModel];
  }

  const target = cleanRemoveTarget(params.target, VIDEO_OBJECT_DEFAULT_TARGET);
  const replacement = cleanRemoveTarget(params.replacement, "");
  const margin = VIDEO_SWAP_MARGINS[videoSwapMargin(params.margin)];
  setNodeInput(workflow, VOS_NODES.samText, "text", target);
  setNodeInput(
    workflow,
    VOS_NODES.track,
    "detection_threshold",
    TUNING.threshold,
  );
  setNodeInput(workflow, VOS_NODES.track, "max_objects", TUNING.maxObjects);
  setNodeInput(
    workflow,
    VOS_NODES.track,
    "detect_interval",
    TUNING.detectInterval,
  );
  setNodeInput(workflow, VOS_NODES.grow, "expand", margin.grow);
  // k = params.temporalRadius (default per margin); control_masks get the
  // VACE latent-safe dilation on top (no grey smear behind fast limbs).
  applyVaceMaskTiming(
    workflow,
    maskTemporalRadius(params.temporalRadius, margin.temporal),
    VIDEO_SWAP_LENGTH,
  );

  const clicks = occurrencesInWindow(
    parseSmartTrack(params.smartTrack),
    VIDEO_SWAP_SECONDS,
    action,
  );
  if (clicks.length > 0) {
    applySmartTrack(workflow, {
      sourceVideo: [VOS_NODES.load, 0],
      frames: [VOS_NODES.prep, 0],
      width: [VOS_NODES.prep, 2],
      height: [VOS_NODES.prep, 3],
      samModel: [VOS_NODES.samModel, 0],
      occurrences: clicks,
      replace: [VOS_NODES.trackMask, 0],
      remove: [VOS_NODES.track, VOS_NODES.trackMask],
    });
  }

  // Clicks without a typed target: the prompt says "the object".
  const prompts = objectSwapPrompts(
    clicks.length > 0 && !cleanRemoveTarget(params.target, "")
      ? VIDEO_OBJECT_DEFAULT_TARGET
      : target,
    replacement,
    videoSwapMargin(params.margin),
  );
  setNodeInput(workflow, VOS_NODES.pos, "text", prompts.positive);
  setNodeInput(workflow, VOS_NODES.neg, "text", prompts.negative);
  setNodeInput(workflow, VOS_NODES.paste, "protect_text", false);
  setNodeInput(
    workflow,
    VOS_NODES.paste,
    "filename_prefix",
    "video/CJ_ObjectSwap",
  );

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, VOS_NODES.hi, "noise_seed", seed);
  applyVaceSpeed(
    workflow,
    {
      hi: VOS_NODES.hi,
      lo: VOS_NODES.lo,
      loraHi: VOS_NODES.loraHi,
      shiftHi: VOS_NODES.shiftHi,
    },
    vaceSpeed(params.speed),
  );

  return {
    workflow,
    slots: {
      ksamplerId: VOS_NODES.hi,
      posTextId: VOS_NODES.pos,
      posTextInputName: "text",
      negTextId: VOS_NODES.neg,
      latentDimsId: "",
      imageInputId: VOS_NODES.load,
    },
    seed,
  };
}
