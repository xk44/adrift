/**
 * "Replace person in video" — MiniMax H3 Ref2VA + akatz H3 Character Swap
 * LoRA (h3_character_swap_v1.5, strength 1.0), native ComfyUI nodes only
 * (packs/minimax/character_swap.json). The source clip is <Video 1>
 * (LoadVideo → GetVideoComponents → ref_videos.ref_video_0) and the character
 * reference is <Picture 1> (LoadImage → ref_images.ref_image_0).
 *
 * Recipe (HF card akatz-ai/MiniMax-H3-Character-Swap-LoRA): 24 fps, 8 steps,
 * CFG 1, er_sde/normal. Speed LoRA: lightx2v fl2v Turbo 8-step v1.1 plus
 * MiniMaxH3SigmaShift 12/3 (the card names the RunningHub Ref2VA-Acc-8Step
 * conversion, but stock ComfyUI cannot load it: its PDD head bias bank is
 * stored as set_bias, which ComfyUI skips, so sampling crashes in _pdd_head).
 *
 * There is no native fps-resample node: clients must hand in a 24 fps clip
 * (cj-ios exports at 24 fps before upload).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import { applyH3ExtraLoras } from "./h3Video";
import { applyH3Speed } from "./h3Speed";

export const CHARACTER_SWAP_ACTION = "character_swap";
export const CHARACTER_SWAP_LORA = "h3_character_swap_v1.5.safetensors";
export const CHARACTER_SWAP_FPS = 24;
export const CHARACTER_SWAP_DEFAULT_LENGTH = 124;
/** Upper end of the H3 trained range (~124–362 frames @ 24 fps). */
export const CHARACTER_SWAP_MAX_LENGTH = 362;
const MIN_LENGTH = 22; // 17·1 + 5
const SHORT_EDGE = 480;
const MAX_LONG_EDGE = 1024;

export const CHARACTER_SWAP_PROMPT =
  "Replace the selected person in <Video 1> with the character in <Picture 1>. " +
  "Keep the reference character's face, hair and clothing. " +
  "Follow the source performance's pose, gaze, expression and movement. " +
  "Preserve the scene and the other people.";

/**
 * The card's prompt template; an optional "who to replace" description
 * replaces "the selected person" (e.g. "the man in the red jacket").
 */
export function characterSwapPrompt(target?: string): string {
  const who = target?.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!who) return CHARACTER_SWAP_PROMPT;
  return CHARACTER_SWAP_PROMPT.replace("the selected person", who);
}

/**
 * Output frame count for a clip of `seconds`: 24 fps, snapped DOWN onto the
 * H3 length grid (n % 17 == 5, which is also how the node trims ref videos),
 * clamped to [22, 362]. Unknown duration → the node default (124 ≈ 5.2 s).
 */
export function characterSwapLength(seconds?: number | null): number {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return CHARACTER_SWAP_DEFAULT_LENGTH;
  }
  const frames = Math.round(seconds * CHARACTER_SWAP_FPS);
  const snapped = frames < 5 ? 5 : Math.floor((frames - 5) / 17) * 17 + 5;
  return Math.min(CHARACTER_SWAP_MAX_LENGTH, Math.max(MIN_LENGTH, snapped));
}

const snap32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/** Output size: 480 short edge, source aspect, multiples of 32, long edge ≤ 1024. */
export function characterSwapDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = typeof width === "number" && width > 0 ? width : 16;
  const h = typeof height === "number" && height > 0 ? height : 9;
  const long = Math.min(
    MAX_LONG_EDGE,
    snap32((SHORT_EDGE * Math.max(w, h)) / Math.min(w, h)),
  );
  return w >= h
    ? { width: long, height: SHORT_EDGE }
    : { width: SHORT_EDGE, height: long };
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function numberOr(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export interface H3SwapSpec {
  /** Action name used in error messages. */
  action: string;
  /** Prompt when the caller supplies none. */
  promptFor: (params: Record<string, unknown>) => string;
  /** When set, an explicit params.prompt is honoured only if it contains it. */
  explicitPromptMarker?: string;
}

/**
 * Shared H3 Ref2VA "video + one reference image" builder (character swap,
 * face swap): points LoadVideo at the source run's clip and LoadImage at the
 * uploaded reference (params.secondRefImage, an "name.png [input]" ref), and
 * sets prompt / length / size / seed. Throws when either input is missing.
 */
export function buildH3VideoSwapWorkflow(
  spec: H3SwapSpec,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];

  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) {
    throw new Error(`${spec.action}: source run has no video`);
  }
  const refImage =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (!parseInputRef(refImage)) {
    throw new Error(
      `${spec.action}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
    );
  }

  const videoId = nodeIdOf(workflow, "LoadVideo");
  const imageId = nodeIdOf(workflow, "LoadImage");
  const h3Id = nodeIdOf(workflow, "MiniMaxH3ReferenceToVideo");
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  if (!videoId || !imageId || !h3Id) {
    throw new Error(
      `${spec.action}: workflow needs LoadVideo, LoadImage and MiniMaxH3ReferenceToVideo`,
    );
  }

  setNodeInput(workflow, videoId, "file", videoRef);
  setNodeInput(workflow, imageId, "image", refImage);

  const explicitPrompt =
    spec.explicitPromptMarker !== undefined &&
    typeof params.prompt === "string" &&
    params.prompt.includes(spec.explicitPromptMarker)
      ? params.prompt.trim()
      : undefined;
  setNodeInput(workflow, h3Id, "prompt", explicitPrompt ?? spec.promptFor(params));

  const seconds = numberOr(
    params.video_seconds,
    sourceRun.params?.video_seconds,
  );
  setNodeInput(workflow, h3Id, "length", characterSwapLength(seconds));
  const dims = characterSwapDims(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, h3Id, "width", dims.width);
  setNodeInput(workflow, h3Id, "height", dims.height);

  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2 ** 32);
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
  // No-op on the shipped graph (it already loads the Turbo LoRA).
  applyH3Speed(workflow, params);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: h3Id,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: h3Id,
      imageInputId: imageId,
    },
    seed,
  };
}

/** Point the character-swap graph at the source run's video + reference image. */
export function buildCharacterSwapWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  return buildH3VideoSwapWorkflow(
    {
      action: CHARACTER_SWAP_ACTION,
      explicitPromptMarker: "<Video 1>",
      promptFor: (p) =>
        characterSwapPrompt(typeof p.target === "string" ? p.target : undefined),
    },
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}
