/**
 * "Lipsync / talking photo" (packs/wan-animate/lipsync.json) — InfiniteTalk
 * on Wan 2.1 I2V 480p, core ComfyUI nodes only. The photo (job.images[0]) is
 * the start image + CLIP-vision reference; the speech (params.audioRef, else
 * job.audios[0] from seed-run) is wav2vec2-encoded and drives mouth + head.
 *
 * One WanInfiniteTalkToVideo pass renders 81 frames @ 25 fps (3.24 s). Longer
 * speech chains extra passes: each feeds every frame so far as
 * previous_frames (the node keeps the last 9 as motion context, offsets the
 * audio window to match and asks us to drop those 9 decoded frames), adding
 * 72 new frames per pass. Passes are capped at LIPSYNC_MAX_SEGMENTS (369
 * frames ≈ 14.8 s); longer speech is cut. The frames are trimmed to the
 * speech length and the speech trimmed to the frames, then muxed by
 * CreateVideo so the mp4 carries the audio track.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";

export const LIPSYNC_ACTION = "lipsync";
export const LIPSYNC_FPS = 25;
export const LIPSYNC_WINDOW = 81;
export const LIPSYNC_MOTION_FRAMES = 9;
export const LIPSYNC_MAX_SEGMENTS = 5;
export const LIPSYNC_MAX_FRAMES =
  LIPSYNC_WINDOW +
  (LIPSYNC_WINDOW - LIPSYNC_MOTION_FRAMES) * (LIPSYNC_MAX_SEGMENTS - 1);
/** Longest speech rendered in full (seconds); longer audio is cut. */
export const LIPSYNC_MAX_SECONDS = LIPSYNC_MAX_FRAMES / LIPSYNC_FPS;
const MIN_FRAMES = 25;
const SHORT_EDGE = 480;
const MAX_LONG_EDGE = 832;

export const LIPSYNC_PROMPT =
  "A person talking to the camera with natural head movement and facial expressions, lips moving in sync with the speech.";

const N = {
  photo: "1",
  speech: "3",
  prompt: "10",
  resize: "14",
  talk: "16",
  sampler: "17",
  scheduler: "18",
  noise: "19",
  guider: "20",
  sample: "21",
  decode: "22",
  trim: "23",
  mux: "24",
} as const;

const EXPECT: Record<string, string> = {
  [N.photo]: "LoadImage",
  "2": "LoadAudio",
  [N.speech]: "TrimAudioDuration",
  [N.prompt]: "CLIPTextEncode",
  [N.resize]: "ResizeImageMaskNode",
  [N.talk]: "WanInfiniteTalkToVideo",
  [N.scheduler]: "BasicScheduler",
  [N.noise]: "RandomNoise",
  [N.guider]: "CFGGuider",
  [N.sample]: "SamplerCustomAdvanced",
  [N.decode]: "VAEDecode",
  [N.trim]: "ImageFromBatch",
  [N.mux]: "CreateVideo",
};

/** Plan for `seconds` of speech: output frames and InfiniteTalk passes. */
export function lipsyncPlan(seconds?: number | null): {
  frames: number;
  segments: number;
  truncated: boolean;
} {
  const valid =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
  const want = valid ? Math.ceil(seconds * LIPSYNC_FPS) : LIPSYNC_WINDOW;
  const frames = Math.min(LIPSYNC_MAX_FRAMES, Math.max(MIN_FRAMES, want));
  const step = LIPSYNC_WINDOW - LIPSYNC_MOTION_FRAMES;
  const segments = 1 + Math.ceil(Math.max(0, frames - LIPSYNC_WINDOW) / step);
  return { frames, segments, truncated: want > LIPSYNC_MAX_FRAMES };
}

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/** Output size: 480 short edge, photo aspect, multiples of 16, long edge ≤ 832. */
export function lipsyncDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = typeof width === "number" && width > 0 ? width : 3;
  const h = typeof height === "number" && height > 0 ? height : 4;
  const long = Math.min(
    MAX_LONG_EDGE,
    snap16((SHORT_EDGE * Math.max(w, h)) / Math.min(w, h)),
  );
  return w >= h
    ? { width: long, height: SHORT_EDGE }
    : { width: SHORT_EDGE, height: long };
}

function numberOr(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function buildLipsyncWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];

  const photoRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!photoRef) throw new Error(`${LIPSYNC_ACTION}: source run has no image`);
  const explicitAudio =
    typeof params.audioRef === "string" ? params.audioRef.trim() : "";
  let audioRef: string | null = null;
  if (explicitAudio) {
    if (!parseInputRef(explicitAudio, { allowAudio: true })) {
      throw new Error(
        `${LIPSYNC_ACTION}: audioRef must be an uploaded audio ref ("name.wav [input]")`,
      );
    }
    audioRef = explicitAudio;
  } else {
    audioRef = comfyImageRefFromViewUrl(job?.audios?.[0]);
  }
  if (!audioRef) {
    throw new Error(`${LIPSYNC_ACTION}: attach a speech audio file`);
  }
  for (const [id, cls] of Object.entries(EXPECT)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(
        `${LIPSYNC_ACTION}: workflow node ${id} should be ${cls} (graph out of sync)`,
      );
    }
  }

  setNodeInput(workflow, N.photo, "image", photoRef);
  setNodeInput(workflow, "2", "audio", audioRef);

  const dims = lipsyncDims(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, N.resize, "resize_type.width", dims.width);
  setNodeInput(workflow, N.resize, "resize_type.height", dims.height);
  setNodeInput(workflow, N.talk, "width", dims.width);
  setNodeInput(workflow, N.talk, "height", dims.height);
  setNodeInput(workflow, N.talk, "length", LIPSYNC_WINDOW);

  const prompt =
    typeof params.prompt === "string" && params.prompt.trim()
      ? params.prompt.trim().slice(0, 1000)
      : LIPSYNC_PROMPT;
  setNodeInput(workflow, N.prompt, "text", prompt);

  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, N.noise, "noise_seed", seed);

  const seconds = numberOr(
    params.audio_seconds,
    sourceRun.params?.audio_seconds,
  );
  const plan = lipsyncPlan(seconds);
  setNodeInput(
    workflow,
    N.speech,
    "duration",
    Math.round((plan.frames / LIPSYNC_FPS) * 100) / 100,
  );

  // Chain extra passes; `acc` is the running frame batch.
  let next = Math.max(
    ...Object.keys(workflow).map(Number).filter(Number.isFinite),
  );
  const newId = () => String(++next);
  let acc: [string, number] = [N.decode, 0];
  const talk = workflow[N.talk];
  for (let k = 2; k <= plan.segments; k++) {
    const t = newId();
    const sch = newId();
    const gd = newId();
    const smp = newId();
    const dec = newId();
    const fresh = newId();
    const batch = newId();
    const meta = (title: string) => ({ title: `${title} (pass ${k})` });
    workflow[t] = {
      class_type: "WanInfiniteTalkToVideo",
      inputs: { ...structuredClone(talk.inputs), previous_frames: acc },
      _meta: meta("InfiniteTalk"),
    } as Workflow[string];
    workflow[sch] = {
      class_type: "BasicScheduler",
      inputs: {
        ...structuredClone(workflow[N.scheduler].inputs),
        model: [t, 0],
      },
      _meta: meta("Scheduler"),
    } as Workflow[string];
    workflow[gd] = {
      class_type: "CFGGuider",
      inputs: {
        ...structuredClone(workflow[N.guider].inputs),
        model: [t, 0],
        positive: [t, 1],
        negative: [t, 2],
      },
      _meta: meta("Guider"),
    } as Workflow[string];
    workflow[smp] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: [N.noise, 0],
        guider: [gd, 0],
        sampler: [N.sampler, 0],
        sigmas: [sch, 0],
        latent_image: [t, 3],
      },
      _meta: meta("Sample"),
    } as Workflow[string];
    workflow[dec] = {
      class_type: "VAEDecode",
      inputs: {
        ...structuredClone(workflow[N.decode].inputs),
        samples: [smp, 0],
      },
      _meta: meta("Decode"),
    } as Workflow[string];
    workflow[fresh] = {
      class_type: "ImageFromBatch",
      inputs: { image: [dec, 0], batch_index: [t, 4], length: 4096 },
      _meta: meta("Drop Motion Frames"),
    } as Workflow[string];
    workflow[batch] = {
      class_type: "ImageBatch",
      inputs: { image1: acc, image2: [fresh, 0] },
      _meta: meta("Append"),
    } as Workflow[string];
    acc = [batch, 0];
  }
  setNodeInput(workflow, N.trim, "image", acc);
  setNodeInput(workflow, N.trim, "batch_index", 0);
  setNodeInput(workflow, N.trim, "length", plan.frames);
  setNodeInput(workflow, N.mux, "fps", LIPSYNC_FPS);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: N.prompt,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: N.talk,
      imageInputId: N.photo,
    },
    seed,
  };
}
