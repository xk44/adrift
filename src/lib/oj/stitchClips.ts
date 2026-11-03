/**
 * stitch_clips (packs/utility/stitch_clips.json): joins 2-8 finished clips
 * into one. No models: core ComfyUI + VideoHelperSuite nodes only. The pack
 * is a two-clip hard cut; this builder keeps its SaveVideo and regenerates
 * the rest per clip:
 *
 *   VHS_LoadVideo (resampled to params.fps) per clip
 *   -> ImageScale to the first clip's size (GetImageSize, linked) or to
 *      params.width x params.height, center crop
 *   -> seams: cut = ImageBatch; fade = VHS_SplitImages takes the last K
 *      frames of the timeline so far and the first K of the next clip, each
 *      pair is mixed by its own ImageBlend (factor (j+1)/(K+1)), so the
 *      joined clip is K frames shorter per seam
 *   -> CreateVideo (optional soundtrack) -> SaveVideo (H.264 MP4)
 *
 *   params.clips[i] = "ref" | { video: "ref", seconds?, audio? }
 *     video    ComfyUI file ref ("video/x_00001_.mp4 [output]")
 *     seconds  clip length (browser metadata); needed for params.audio,
 *              also caps the crossfade at half the shortest clip
 *     audio    false = clip has no sound track (silence is used)
 *   params.transition "cut" | "fade"; params.fadeSeconds (fade length)
 *   params.fps 12..30 (fractional kept, faster rates halved; falls back to
 *   params.sourceFps); params.fit "crop" (default) | "letterbox" (black
 *   bars, ResizeAndPadImage); params.audio keep sound (default false)
 *   params.width / params.height optional output size (else first clip)
 *
 * Sound: each clip's track is padded with silence and cut to the frames it
 * contributes (minus the crossfade it hands to the next clip), then chained
 * with AudioConcat, so it stays in sync with the picture. VHS raises on a clip
 * without an audio stream, hence audio is opt-in.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow } from "./engine";
import { VIDEO_EXT, isSafeFileRef } from "@/lib/tools/pipelines";
import {
  STITCH_CLIPS_ACTION,
  STITCH_DEFAULT_FADE_SECONDS,
  STITCH_MAX_CLIPS,
  STITCH_MAX_FADE_FRAMES,
  STITCH_MAX_TOTAL_SECONDS,
  STITCH_MIN_CLIPS,
  STITCH_MIN_FADE_FRAMES,
  stitchFps,
  type StitchFit,
  type StitchTransition,
} from "@/lib/tools/stitchClips";

export { STITCH_CLIPS_ACTION };

const SAMPLE_RATE = 44100;

export interface StitchPlanClip {
  video: string;
  /** Frames the clip has at plan.fps (from seconds), null = unknown. */
  frames: number | null;
  audio: boolean;
  /** Seconds of the clip on the joined timeline (null = unknown). */
  seconds: number | null;
}

export interface StitchPlan {
  clips: StitchPlanClip[];
  fps: number;
  transition: StitchTransition;
  /** Frames blended at each seam (0 for cut). */
  fadeFrames: number;
  width: number | null;
  height: number | null;
  /** crop = ImageScale center crop; letterbox = ResizeAndPadImage, black. */
  fit: StitchFit;
  audio: boolean;
  prefix: string;
  /** Joined length, null when any clip length is unknown. */
  totalSeconds: number | null;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function size(value: unknown, what: string): number {
  const n = num(value);
  if (n === undefined || n < 64 || n > 4096)
    throw new Error(`${STITCH_CLIPS_ACTION}: ${what} must be 64-4096`);
  return Math.round(n / 2) * 2;
}

/** Validate params and compute frame counts (pure; throws on bad input). */
export function planStitch(params: Record<string, unknown>): StitchPlan {
  const A = STITCH_CLIPS_ACTION;
  const raw = params.clips;
  if (!Array.isArray(raw) || raw.length < STITCH_MIN_CLIPS)
    throw new Error(`${A}: needs at least ${STITCH_MIN_CLIPS} clips`);
  if (raw.length > STITCH_MAX_CLIPS)
    throw new Error(`${A}: at most ${STITCH_MAX_CLIPS} clips`);
  const fps = stitchFps(num(params.fps) ?? num(params.sourceFps));
  const audio = params.audio === true;

  const clips = raw.map((c, i): StitchPlanClip => {
    const clip = (
      typeof c === "string" ? { video: c } : c && typeof c === "object" ? c : {}
    ) as Record<string, unknown>;
    if (!isSafeFileRef(clip.video, VIDEO_EXT))
      throw new Error(
        `${A}: clip ${i + 1} needs a video ref ("name.mp4 [output]")`,
      );
    const seconds = num(clip.seconds);
    if (
      seconds !== undefined &&
      (seconds <= 0 || seconds > STITCH_MAX_TOTAL_SECONDS)
    )
      throw new Error(
        `${A}: clip ${i + 1} seconds must be 0-${STITCH_MAX_TOTAL_SECONDS}`,
      );
    if (audio && seconds === undefined)
      throw new Error(`${A}: keeping sound needs clip ${i + 1}'s seconds`);
    return {
      video: clip.video,
      frames:
        seconds === undefined ? null : Math.max(1, Math.floor(seconds * fps)),
      audio: clip.audio !== false,
      seconds: null,
    };
  });

  let transition: StitchTransition =
    params.transition === "fade" ? "fade" : "cut";
  let fadeFrames = 0;
  if (transition === "fade") {
    const fadeSeconds = Math.min(
      2,
      Math.max(0, num(params.fadeSeconds) ?? STITCH_DEFAULT_FADE_SECONDS),
    );
    fadeFrames = Math.min(
      STITCH_MAX_FADE_FRAMES,
      Math.round(fadeSeconds * fps),
    );
    // A seam can only blend frames both neighbours have; a clip in the
    // middle gives frames to both its seams.
    const known = clips
      .map((c) => c.frames)
      .filter((f): f is number => f !== null);
    if (known.length)
      fadeFrames = Math.min(fadeFrames, Math.floor(Math.min(...known) / 2));
    if (fadeFrames < STITCH_MIN_FADE_FRAMES) {
      transition = "cut";
      fadeFrames = 0;
    }
  }

  const n = clips.length;
  if (clips.every((c) => c.frames !== null)) {
    clips.forEach((c, i) => {
      c.seconds = round3((c.frames! - (i < n - 1 ? fadeFrames : 0)) / fps);
    });
  }
  const totalSeconds = clips.every((c) => c.seconds !== null)
    ? round3(clips.reduce((a, c) => a + c.seconds!, 0))
    : null;
  if (totalSeconds !== null && totalSeconds > STITCH_MAX_TOTAL_SECONDS)
    throw new Error(
      `${A}: ${totalSeconds}s is longer than ${STITCH_MAX_TOTAL_SECONDS}s`,
    );

  const sized = params.width !== undefined || params.height !== undefined;
  const width = sized ? size(params.width, "width") : null;
  const height = sized ? size(params.height, "height") : null;
  const prefix =
    typeof params.prefix === "string" &&
    /^video\/[A-Za-z0-9_-]{1,40}$/.test(params.prefix)
      ? params.prefix
      : "video/adrift_stitch";
  return {
    clips,
    fps,
    transition,
    fadeFrames,
    width,
    height,
    fit: params.fit === "letterbox" ? "letterbox" : "crop",
    audio,
    prefix,
    totalSeconds,
  };
}

export function buildStitchClipsWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = STITCH_CLIPS_ACTION;
  const plan = planStitch(params);
  const base = cloneWorkflow(baseWorkflow);
  const saveId = Object.keys(base).find(
    (k) => base[k]?.class_type === "SaveVideo",
  );
  if (!saveId) throw new Error(`${A}: workflow needs SaveVideo`);

  // Keep annotations + SaveVideo; everything else is regenerated.
  const workflow: Workflow = {};
  for (const [k, v] of Object.entries(base))
    if (k.startsWith("_")) workflow[k] = v;
  workflow[saveId] = base[saveId];
  let next =
    Math.max(0, ...Object.keys(base).map(Number).filter(Number.isFinite)) + 1;
  const add = (
    class_type: string,
    inputs: Record<string, unknown>,
    title: string,
  ): string => {
    const id = String(next++);
    workflow[id] = { class_type, inputs, _meta: { title } };
    return id;
  };

  const loads = plan.clips.map((clip, i) =>
    add(
      "VHS_LoadVideo",
      {
        video: clip.video,
        force_rate: plan.fps,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
        format: "None",
      },
      `Clip ${i + 1}`,
    ),
  );

  // Common frame size: explicit, or linked from the first clip.
  let width: unknown = plan.width;
  let height: unknown = plan.height;
  if (width === null) {
    const dims = add("GetImageSize", { image: [loads[0], 0] }, "Clip 1 Size");
    width = [dims, 0];
    height = [dims, 1];
  }
  const frames = loads.map((load, i) =>
    i === 0 && plan.width === null
      ? load
      : plan.fit === "letterbox"
        ? add(
            "ResizeAndPadImage",
            {
              image: [load, 0],
              target_width: width,
              target_height: height,
              padding_color: "black",
              interpolation: "lanczos",
            },
            `Clip ${i + 1} Fit`,
          )
        : add(
            "ImageScale",
            {
              image: [load, 0],
              upscale_method: "lanczos",
              width,
              height,
              crop: "center",
            },
            `Clip ${i + 1} Fit`,
          ),
  );

  let timeline = frames[0];
  for (let i = 1; i < frames.length; i++) {
    const n = i + 1;
    if (plan.transition === "cut") {
      timeline = add(
        "ImageBatch",
        { image1: [timeline, 0], image2: [frames[i], 0] },
        `Cut to Clip ${n}`,
      );
      continue;
    }
    const k = plan.fadeFrames;
    const out = add(
      "VHS_SplitImages",
      { images: [timeline, 0], split_index: -k },
      `Fade ${i} Out Frames`,
    );
    const into = add(
      "VHS_SplitImages",
      { images: [frames[i], 0], split_index: k },
      `Fade ${i} In Frames`,
    );
    let fade: string | null = null;
    for (let j = 0; j < k; j++) {
      const a = add(
        "ImageFromBatch",
        { image: [out, 2], batch_index: j, length: 1 },
        `Fade ${i} Out ${j + 1}`,
      );
      const b = add(
        "ImageFromBatch",
        { image: [into, 0], batch_index: j, length: 1 },
        `Fade ${i} In ${j + 1}`,
      );
      const mix = add(
        "ImageBlend",
        {
          image1: [a, 0],
          image2: [b, 0],
          blend_factor: Math.round(((j + 1) / (k + 1)) * 100) / 100,
          blend_mode: "normal",
        },
        `Fade ${i} Mix ${j + 1}`,
      );
      fade =
        fade === null
          ? mix
          : add(
              "ImageBatch",
              { image1: [fade, 0], image2: [mix, 0] },
              `Fade ${i} Frames ${j + 1}`,
            );
    }
    const head = add(
      "ImageBatch",
      { image1: [out, 0], image2: [fade, 0] },
      `Fade ${i} Joined`,
    );
    timeline = add(
      "ImageBatch",
      { image1: [head, 0], image2: [into, 2] },
      `Fade to Clip ${n}`,
    );
  }

  let track: string | null = null;
  if (plan.audio) {
    plan.clips.forEach((clip, i) => {
      const seconds = clip.seconds!;
      const silence = add(
        "EmptyAudio",
        { duration: seconds, sample_rate: SAMPLE_RATE, channels: 2 },
        `Clip ${i + 1} Silence`,
      );
      let clipAudio = silence;
      if (clip.audio) {
        const padded = add(
          "AudioConcat",
          { audio1: [loads[i], 2], audio2: [silence, 0], direction: "after" },
          `Clip ${i + 1} Pad Sound`,
        );
        clipAudio = add(
          "TrimAudioDuration",
          { audio: [padded, 0], start_index: 0, duration: seconds },
          `Clip ${i + 1} Fit Sound`,
        );
      }
      track =
        track === null
          ? clipAudio
          : add(
              "AudioConcat",
              {
                audio1: [track, 0],
                audio2: [clipAudio, 0],
                direction: "after",
              },
              `Sound + Clip ${i + 1}`,
            );
    });
  }

  const video = add(
    "CreateVideo",
    {
      images: [timeline, 0],
      fps: plan.fps,
      ...(track ? { audio: [track, 0] } : {}),
    },
    "Stitched Video",
  );
  workflow[saveId] = {
    ...workflow[saveId],
    inputs: {
      ...workflow[saveId].inputs,
      video: [video, 0],
      filename_prefix: plan.prefix,
    },
  };

  return {
    workflow,
    slots: {
      ksamplerId: saveId,
      posTextId: saveId,
      posTextInputName: "filename_prefix",
      negTextId: "",
      latentDimsId: "",
    },
    seed: 0,
  };
}
