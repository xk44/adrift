/**
 * "Edit video" (packs/wan22/video_edit.json): Lucy Edit Dev, a text-
 * instructed video edit (change outfit, add an object, restyle) that keeps
 * the source motion. Core ComfyUI nodes only: Lucy is a Wan2.2 TI2V-5B
 * finetune whose extra input channels take the source clip's VAE latent,
 * and InstructPixToPixConditioning builds exactly that concat latent (what
 * the decart LucyConditionConcat custom node does), so no node install.
 *
 * Source window: trimmed from the start, resampled to 16 fps (4n+1 frames,
 * 17..81 = up to ~5 s), scaled/cropped to a 480 short edge with both sides
 * multiples of 32 (Wan2.2 VAE). Source audio is not carried over.
 * License: the Lucy Edit Dev weights are non-commercial.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { VACE_FPS, vaceLength } from "./vaceVideo";

export const VIDEO_EDIT_ACTION = "video_edit";
export const VIDEO_EDIT_FPS = VACE_FPS;

const SHORT_EDGE = 480;
const MAX_LONG_EDGE = 832;

export const VIDEO_EDIT_SPEEDS = { fast: 20, balanced: 30, best: 40 } as const;
export type VideoEditSpeed = keyof typeof VIDEO_EDIT_SPEEDS;

export function videoEditSpeed(value: unknown): VideoEditSpeed {
  return value === "fast" || value === "best" ? value : "balanced";
}

function finite(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

const round32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/** 480 short edge, source aspect, multiples of 32, long edge <= 832. */
export function videoEditDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = finite(width) ?? 16;
  const h = finite(height) ?? 9;
  const long = Math.min(
    MAX_LONG_EDGE,
    round32((SHORT_EDGE * Math.max(w, h)) / Math.min(w, h)),
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

export function buildVideoEditWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_EDIT_ACTION;
  const prompt =
    typeof (params.prompt ?? params.text) === "string"
      ? String(params.prompt ?? params.text)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1500)
      : "";
  if (!prompt)
    throw new Error(`${action}: describe the edit (prompt is required)`);

  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);

  const load = nodeIdOf(workflow, "LoadVideo");
  const slice = nodeIdOf(workflow, "Video Slice");
  const sample = nodeIdOf(workflow, "VideoFrameSample");
  const scale = nodeIdOf(workflow, "ImageScale");
  const cond = nodeIdOf(workflow, "InstructPixToPixConditioning");
  const sampler = nodeIdOf(workflow, "KSampler");
  const pos = cond ? workflow[cond].inputs.positive : undefined;
  const neg = cond ? workflow[cond].inputs.negative : undefined;
  if (
    !load ||
    !slice ||
    !sample ||
    !scale ||
    !cond ||
    !sampler ||
    !Array.isArray(pos) ||
    !Array.isArray(neg)
  ) {
    throw new Error(
      `${action}: workflow needs LoadVideo, Video Slice, VideoFrameSample, ImageScale, InstructPixToPixConditioning (wired prompts) and KSampler`,
    );
  }
  const posId = String(pos[0]);
  const negId = String(neg[0]);

  setNodeInput(workflow, load, "file", videoRef);
  const seconds = finite(params.video_seconds, sourceRun.params?.video_seconds);
  const length = vaceLength(seconds);
  setNodeInput(workflow, slice, "start_time", 0);
  setNodeInput(workflow, slice, "duration", length / VIDEO_EDIT_FPS);
  setNodeInput(workflow, sample, "num_frames", length);
  const dims = videoEditDims(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, scale, "width", dims.width);
  setNodeInput(workflow, scale, "height", dims.height);
  setNodeInput(workflow, scale, "crop", "center");
  setNodeInput(workflow, posId, "text", prompt);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, sampler, "seed", seed);
  setNodeInput(
    workflow,
    sampler,
    "steps",
    VIDEO_EDIT_SPEEDS[videoEditSpeed(params.speed)],
  );

  return {
    workflow,
    slots: {
      ksamplerId: sampler,
      posTextId: posId,
      posTextInputName: "text",
      negTextId: negId,
      latentDimsId: "",
      imageInputId: load,
    },
    seed,
  };
}
