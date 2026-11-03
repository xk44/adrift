/**
 * "Lipsync onto an existing video" (packs/wan-animate/video_lipsync.json).
 * InfiniteTalk (core WanInfiniteTalkToVideo, Wan 2.1 I2V 480p) re-renders
 * only the face of an existing clip so the mouth follows a NEW speech track.
 *
 * How the source clip gets in without leaking its own lip motion: every
 * InfiniteTalk pass samples from VAEEncode(that window's source frames) with
 * SetLatentNoiseMask(face mask) instead of the node's empty latent. Comfy's
 * inpaint sampler keeps the (noised) source outside the mask at every step and
 * returns it unchanged there, so head pose, body and background stay locked
 * to the source; inside the mask the latent starts from pure noise (denoise
 * 1.0), so the mouth and jaw come only from the driving audio's wav2vec2
 * features. The window's first source frame is the I2V start image (frame 0
 * of each window is a motion/context frame that is dropped after pass 1).
 *
 * Chaining mirrors lipsync.ts: pass k (0-based) covers source frames
 * [72k, 72k + 81), feeds every frame rendered so far as previous_frames (the
 * node keeps the last 9 as motion context and offsets the audio window) and
 * appends 72 new frames. Capped at LIPSYNC_MAX_SEGMENTS (~14.8 s). The clip is
 * padded with its last frame so every window exists when the speech outlasts
 * the video length we were told about.
 *
 * Frame rate: the clip is deliberately resampled to LIPSYNC_FPS (25) on load
 * (VHS force_rate drops/repeats frames by timestamp, so 24 fps in -> one
 * repeated frame per second, timing preserved) and the result is muxed at 25.
 * InfiniteTalk's wav2vec2 features are bucketed per 25 fps video frame, so
 * the frames must be on a 25 fps grid: loading at the source's own rate
 * (params.sourceFps, which the tool runner sends) would play the generated
 * mouth 25/24 too fast against the speech (~0.6 s off by 15 s). sourceFps is
 * therefore ignored here on purpose; frame count, speech trim (frames / 25)
 * and the mux all use the same 25 fps clock.
 *
 * Output: frames trimmed to min(video, speech), CJImagePasteBack keeps the
 * full-resolution source outside the face mask (tone-matched to the source
 * inside it, feathered seam: VIDEO_LIPSYNC_PASTE), CreateVideo muxes the trimmed
 * driving speech (the source audio track is replaced, not mixed).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import {
  LIPSYNC_FPS,
  LIPSYNC_MAX_SECONDS,
  LIPSYNC_MOTION_FRAMES,
  LIPSYNC_WINDOW,
  lipsyncDims,
  lipsyncPlan,
} from "./lipsync";
import {
  applySmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";

export const VIDEO_LIPSYNC_ACTION = "video_lipsync";
/** Longest stretch rendered (seconds); mirrors SMART_TRACK_WINDOW_SECONDS. */
export const VIDEO_LIPSYNC_MAX_SECONDS = LIPSYNC_MAX_SECONDS;
export const VIDEO_LIPSYNC_DEFAULT_TARGET = "face";
/** Long-edge cap for the full-resolution frames the face is pasted onto. */
export const VIDEO_LIPSYNC_MAX_LONG_EDGE = 1280;
const STEP = LIPSYNC_WINDOW - LIPSYNC_MOTION_FRAMES;

export const VIDEO_LIPSYNC_PROMPT =
  "A person talking with natural facial expressions, mouth and jaw moving in sync with the speech.";

/**
 * Paste-back tone + seam (CJImagePasteBack). The regenerated face drifts a
 * few levels from the source per frame and the global colour fit can't see
 * it (it trusts pixels far from the mask), so region_match fits a per-channel
 * mean/std transfer on the mask's inner rim and applies it inside the mask.
 * grow 14 / feather 10 (at an 880 px short side) put the soft seam ramp just
 * outside the regenerated area, where the VAE round-tripped source and the
 * original agree. region_match / match_band_px need the cj_h3_tools node from
 * this repo; an older node ignores them (widget values) and still runs.
 */
export const VIDEO_LIPSYNC_PASTE = {
  grow_px: 14,
  feather_px: 10,
  color_match: true,
  region_match: 1.0,
  match_band_px: 24,
} as const;

/** Fixed node ids in packs/wan-animate/video_lipsync.json. */
export const VL_NODES = {
  load: "1",
  audio: "2",
  speech: "3",
  vae: "12",
  prompt: "10",
  scale: "14",
  talk: "16",
  sampler: "17",
  scheduler: "18",
  noise: "19",
  guider: "20",
  sample: "21",
  decode: "22",
  trim: "23",
  paste: "24",
  mux: "25",
  repeat: "28",
  padded: "30",
  start: "31",
  window: "32",
  encode: "33",
  maskImage: "34",
  maskWindow: "35",
  maskWindowMask: "36",
  noiseMask: "37",
  samModel: "41",
  samText: "42",
  track: "43",
  trackMask: "44",
  grow: "45",
  temporal: "46",
} as const;

const EXPECT: Record<string, string> = {
  [VL_NODES.load]: "VHS_LoadVideo",
  [VL_NODES.audio]: "LoadAudio",
  [VL_NODES.speech]: "TrimAudioDuration",
  [VL_NODES.vae]: "VAELoader",
  [VL_NODES.prompt]: "CLIPTextEncode",
  [VL_NODES.scale]: "ImageScale",
  [VL_NODES.talk]: "WanInfiniteTalkToVideo",
  [VL_NODES.sampler]: "KSamplerSelect",
  [VL_NODES.scheduler]: "BasicScheduler",
  [VL_NODES.noise]: "RandomNoise",
  [VL_NODES.guider]: "CFGGuider",
  [VL_NODES.sample]: "SamplerCustomAdvanced",
  [VL_NODES.decode]: "VAEDecode",
  [VL_NODES.trim]: "ImageFromBatch",
  [VL_NODES.paste]: "CJImagePasteBack",
  [VL_NODES.mux]: "CreateVideo",
  [VL_NODES.repeat]: "RepeatImageBatch",
  [VL_NODES.padded]: "ImageFromBatch",
  [VL_NODES.start]: "ImageFromBatch",
  [VL_NODES.window]: "ImageFromBatch",
  [VL_NODES.encode]: "VAEEncode",
  [VL_NODES.maskImage]: "MaskToImage",
  [VL_NODES.maskWindow]: "ImageFromBatch",
  [VL_NODES.maskWindowMask]: "ImageToMask",
  [VL_NODES.noiseMask]: "SetLatentNoiseMask",
  [VL_NODES.samModel]: "CheckpointLoaderSimple",
  [VL_NODES.samText]: "CLIPTextEncode",
  [VL_NODES.track]: "SAM3_VideoTrack",
  [VL_NODES.trackMask]: "SAM3_TrackToMask",
  [VL_NODES.grow]: "GrowMask",
  [VL_NODES.temporal]: "CJMaskTemporal",
};

function numberOr(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/** Seconds actually rendered: the shorter of clip and speech (either may be unknown). */
export function videoLipsyncSeconds(
  videoSeconds?: number,
  audioSeconds?: number,
): number | undefined {
  const known = [videoSeconds, audioSeconds].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return known.length ? Math.min(...known) : undefined;
}

/** Plan: output frames, passes, and padded source frames every window needs. */
export function videoLipsyncPlan(
  videoSeconds?: number,
  audioSeconds?: number,
): { frames: number; segments: number; truncated: boolean; padded: number } {
  const plan = lipsyncPlan(videoLipsyncSeconds(videoSeconds, audioSeconds));
  return { ...plan, padded: LIPSYNC_WINDOW + STEP * (plan.segments - 1) };
}

/** VHS custom_width / custom_height that cap the long edge (0 = keep). */
export function videoLipsyncSourceCap(
  width?: number,
  height?: number,
): { custom_width: number; custom_height: number } {
  const w = typeof width === "number" && width > 0 ? width : 0;
  const h = typeof height === "number" && height > 0 ? height : 0;
  if (!w || !h || Math.max(w, h) <= VIDEO_LIPSYNC_MAX_LONG_EDGE)
    return { custom_width: 0, custom_height: 0 };
  return w >= h
    ? { custom_width: VIDEO_LIPSYNC_MAX_LONG_EDGE, custom_height: 0 }
    : { custom_width: 0, custom_height: VIDEO_LIPSYNC_MAX_LONG_EDGE };
}

export function cleanFaceTarget(value: unknown): string {
  const t =
    typeof value === "string"
      ? value
          .replace(/\s+/g, " ")
          .replace(/^[\s,]+|[\s,]+$/g, "")
          .slice(0, 80)
          .trim()
      : "";
  return t || VIDEO_LIPSYNC_DEFAULT_TARGET;
}

function resolveAudioRef(
  params: Record<string, unknown>,
  job: ImagineRun["jobs"][number] | undefined,
): string {
  const explicit =
    typeof params.audioRef === "string" ? params.audioRef.trim() : "";
  if (explicit) {
    if (!parseInputRef(explicit, { allowAudio: true })) {
      throw new Error(
        `${VIDEO_LIPSYNC_ACTION}: audioRef must be an uploaded audio ref ("name.wav [input]")`,
      );
    }
    return explicit;
  }
  const fromRun = comfyImageRefFromViewUrl(job?.audios?.[0]);
  if (!fromRun)
    throw new Error(`${VIDEO_LIPSYNC_ACTION}: attach the new speech audio`);
  return fromRun;
}

export function buildVideoLipsyncWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${VIDEO_LIPSYNC_ACTION}: source run has no video`);
  const audioRef = resolveAudioRef(params, job);
  for (const [id, cls] of Object.entries(EXPECT)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(
        `${VIDEO_LIPSYNC_ACTION}: workflow node ${id} should be ${cls} (graph out of sync)`,
      );
    }
  }

  const plan = videoLipsyncPlan(
    numberOr(params.video_seconds, sourceRun.params?.video_seconds),
    numberOr(params.audio_seconds, sourceRun.params?.audio_seconds),
  );
  const dims = lipsyncDims(sourceRun.width, sourceRun.height);
  const cap = videoLipsyncSourceCap(sourceRun.width, sourceRun.height);

  setNodeInput(workflow, VL_NODES.load, "video", videoRef);
  // Resample any source rate (24, 29.97, 30 ...) onto InfiniteTalk's 25 fps
  // audio clock; see the header. Never params.sourceFps.
  setNodeInput(workflow, VL_NODES.load, "force_rate", LIPSYNC_FPS);
  setNodeInput(workflow, VL_NODES.load, "frame_load_cap", plan.frames);
  setNodeInput(workflow, VL_NODES.load, "custom_width", cap.custom_width);
  setNodeInput(workflow, VL_NODES.load, "custom_height", cap.custom_height);
  setNodeInput(workflow, VL_NODES.audio, "audio", audioRef);
  setNodeInput(
    workflow,
    VL_NODES.speech,
    "duration",
    Math.round((plan.frames / LIPSYNC_FPS) * 100) / 100,
  );

  setNodeInput(workflow, VL_NODES.scale, "width", dims.width);
  setNodeInput(workflow, VL_NODES.scale, "height", dims.height);
  setNodeInput(workflow, VL_NODES.scale, "crop", "disabled");
  setNodeInput(workflow, VL_NODES.repeat, "amount", plan.padded);
  setNodeInput(workflow, VL_NODES.padded, "length", plan.padded);
  setNodeInput(workflow, VL_NODES.talk, "width", dims.width);
  setNodeInput(workflow, VL_NODES.talk, "height", dims.height);
  setNodeInput(workflow, VL_NODES.talk, "length", LIPSYNC_WINDOW);

  const prompt =
    typeof params.prompt === "string" && params.prompt.trim()
      ? params.prompt.trim().slice(0, 1000)
      : VIDEO_LIPSYNC_PROMPT;
  setNodeInput(workflow, VL_NODES.prompt, "text", prompt);
  setNodeInput(
    workflow,
    VL_NODES.samText,
    "text",
    cleanFaceTarget(params.target),
  );

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, VL_NODES.noise, "noise_seed", seed);

  // Smart select: clicked + tracked face replaces the text SAM branch.
  const clicks = occurrencesInWindow(
    parseSmartTrack(params.smartTrack),
    plan.frames / LIPSYNC_FPS,
    VIDEO_LIPSYNC_ACTION,
  );
  if (clicks.length > 0) {
    const coreLoad = "40";
    workflow[coreLoad] = {
      class_type: "LoadVideo",
      inputs: { file: videoRef },
      _meta: { title: "Source video (smart select)" },
    } as Workflow[string];
    applySmartTrack(workflow, {
      sourceVideo: [coreLoad, 0],
      frames: [VL_NODES.padded, 0],
      width: dims.width,
      height: dims.height,
      samModel: [VL_NODES.samModel, 0],
      occurrences: clicks,
      fps: LIPSYNC_FPS,
      replace: [VL_NODES.trackMask, 0],
      remove: [VL_NODES.samText, VL_NODES.track, VL_NODES.trackMask],
    });
  }

  // Chain passes 2..n; `acc` is the running frame batch.
  let next = Math.max(
    ...Object.keys(workflow).map(Number).filter(Number.isFinite),
  );
  const newId = () => String(++next);
  const add = (cls: string, inputs: Record<string, unknown>, title: string) => {
    const id = newId();
    workflow[id] = {
      class_type: cls,
      inputs,
      _meta: { title },
    } as Workflow[string];
    return id;
  };
  let acc: [string, number] = [VL_NODES.decode, 0];
  const talk = workflow[VL_NODES.talk];
  for (let k = 2; k <= plan.segments; k++) {
    const offset = STEP * (k - 1);
    const tag = (title: string) => `${title} (pass ${k})`;
    const start = add(
      "ImageFromBatch",
      { image: [VL_NODES.padded, 0], batch_index: offset, length: 1 },
      tag("Window start frame"),
    );
    const window = add(
      "ImageFromBatch",
      {
        image: [VL_NODES.padded, 0],
        batch_index: offset,
        length: LIPSYNC_WINDOW,
      },
      tag("Source window"),
    );
    const enc = add(
      "VAEEncode",
      { pixels: [window, 0], vae: [VL_NODES.vae, 0] },
      tag("Encode source window"),
    );
    const mwin = add(
      "ImageFromBatch",
      {
        image: [VL_NODES.maskImage, 0],
        batch_index: offset,
        length: LIPSYNC_WINDOW,
      },
      tag("Mask window"),
    );
    const mmask = add(
      "ImageToMask",
      { image: [mwin, 0], channel: "red" },
      tag("Mask window"),
    );
    const latent = add(
      "SetLatentNoiseMask",
      { samples: [enc, 0], mask: [mmask, 0] },
      tag("Regenerate only the face"),
    );
    const t = add(
      "WanInfiniteTalkToVideo",
      {
        ...structuredClone(talk.inputs),
        start_image: [start, 0],
        previous_frames: acc,
      },
      tag("InfiniteTalk"),
    );
    const sch = add(
      "BasicScheduler",
      {
        ...structuredClone(workflow[VL_NODES.scheduler].inputs),
        model: [t, 0],
      },
      tag("Scheduler"),
    );
    const gd = add(
      "CFGGuider",
      {
        ...structuredClone(workflow[VL_NODES.guider].inputs),
        model: [t, 0],
        positive: [t, 1],
        negative: [t, 2],
      },
      tag("Guider"),
    );
    const smp = add(
      "SamplerCustomAdvanced",
      {
        noise: [VL_NODES.noise, 0],
        guider: [gd, 0],
        sampler: [VL_NODES.sampler, 0],
        sigmas: [sch, 0],
        latent_image: [latent, 0],
      },
      tag("Sample"),
    );
    const dec = add(
      "VAEDecode",
      {
        ...structuredClone(workflow[VL_NODES.decode].inputs),
        samples: [smp, 0],
      },
      tag("Decode"),
    );
    const fresh = add(
      "ImageFromBatch",
      { image: [dec, 0], batch_index: [t, 4], length: 4096 },
      tag("Drop Motion Frames"),
    );
    const batch = add(
      "ImageBatch",
      { image1: acc, image2: [fresh, 0] },
      tag("Append"),
    );
    acc = [batch, 0];
  }
  for (const [k, v] of Object.entries(VIDEO_LIPSYNC_PASTE))
    setNodeInput(workflow, VL_NODES.paste, k, v);
  setNodeInput(workflow, VL_NODES.trim, "image", acc);
  setNodeInput(workflow, VL_NODES.trim, "batch_index", 0);
  setNodeInput(workflow, VL_NODES.trim, "length", plan.frames);
  setNodeInput(workflow, VL_NODES.mux, "fps", LIPSYNC_FPS);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: VL_NODES.prompt,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: VL_NODES.talk,
      imageInputId: VL_NODES.load,
    },
    seed,
  };
}
