/**
 * Video Retake (packs/ltx25/video_retake.json): regenerate a time range of a
 * clip with the distilled LTX-2.5 22B model and keep everything outside it.
 *
 * The first VIDEO_RETAKE_MAX_FRAMES source frames (native fps) are padded to
 * the smallest 8n+1 (last frame held), VAE-encoded as the init latent, and a
 * per-latent-frame noise mask picks what is regenerated: 1 inside the range
 * (or `strength` < 1 for a lighter variation), a short fade on the latent
 * frames just outside it, 0 elsewhere (clean context). After decode the
 * generation is composited over the ORIGINAL frames with a per-frame pixel
 * alpha that is 0 outside the range, so those frames are the source pixels,
 * with a few-frame ramp inside each range edge (none at the clip start/end).
 *
 * Latent time axis (LTX VAE, temporal compression 8): latent 0 = pixel
 * frame 0, latent k >= 1 = pixel frames 8k-7..8k.
 *
 * Both masks are static value lists written by the builder as runs of 1x1
 * EmptyImage batches (red channel = value) chained with ImageBatch; the
 * latent list is cut to the in-graph latent count (node 35), the pixel list
 * is truncated to the clip by ImageCompositeMasked.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const VIDEO_RETAKE_ACTION = "video_retake";
/** Window the graph processes: first 121 frames at the clip's own fps. */
export const VIDEO_RETAKE_MAX_FRAMES = 121;
export const VIDEO_RETAKE_MAX_LATENTS = (VIDEO_RETAKE_MAX_FRAMES - 1) / 8 + 1;
export const VIDEO_RETAKE_WINDOW_SECONDS = 5;
export const VIDEO_RETAKE_DEFAULT_FPS = 24;
export const VIDEO_RETAKE_TEMPORAL_SCALE = 8;
export const VIDEO_RETAKE_EDGES = [768, 1024] as const;
export const VIDEO_RETAKE_DEFAULT_EDGE = 1024;
export const VIDEO_RETAKE_DEFAULT_STRENGTH = 1;
export const VIDEO_RETAKE_MIN_STRENGTH = 0.3;
/** Latent frames outside the range that fade from `strength` to 0. */
export const VIDEO_RETAKE_LATENT_RAMP = 1;
/** Pixel frames inside each range edge blended from source to generation. */
export const VIDEO_RETAKE_PIXEL_RAMP = 4;
/** Context the editor adds around the range (seconds per side). */
export const VIDEO_RETAKE_CONTEXT_SECONDS = 1;

export type VideoRetakeAudio = "keep" | "follow" | "regen";
export const VIDEO_RETAKE_AUDIO_MODES: Record<
  VideoRetakeAudio,
  { label: string; hint: string }
> = {
  keep: {
    label: "Keep original",
    hint: "The source soundtrack is kept as is.",
  },
  follow: {
    label: "Keep + follow it",
    hint: "The source audio also guides the new motion (clip needs sound).",
  },
  regen: {
    label: "Regenerate in range",
    hint: "New audio for the range (clip needs sound; the rest is re-encoded).",
  },
};
export const VIDEO_RETAKE_DEFAULT_AUDIO: VideoRetakeAudio = "keep";

export const VIDEO_RETAKE_DEFAULT_PROMPT =
  "the same scene, continuous natural motion, consistent lighting";
export const VIDEO_RETAKE_NEGATIVE =
  "jump cut, flicker, morphing, distorted, blurry, text, watermark, worst quality";

/** Node ids in packs/ltx25/video_retake.json. */
export const VRT_NODES = {
  unet: "1",
  videoVae: "4",
  audioVae: "5",
  pos: "7",
  neg: "8",
  cond: "9",
  emptyAudio: "12",
  av: "13",
  noise: "14",
  separate: "19",
  load: "20",
  crop: "21",
  components: "22",
  size: "24",
  frames: "26",
  latents: "27",
  genScale: "32",
  encode: "33",
  latentMaskCut: "35",
  latentMask: "36",
  noiseMask: "37",
  audioEncode: "38",
  audioFreeze: "39",
  audioMask: "41",
  decode: "40",
  backScale: "42",
  pixelMask: "44",
  composite: "45",
  audioDecode: "46",
  video: "54",
  save: "55",
  latentValues: "100",
  pixelValues: "200",
} as const;

const NODE_CLASSES: Record<string, string> = {
  [VRT_NODES.unet]: "UNETLoader",
  [VRT_NODES.pos]: "CLIPTextEncode",
  [VRT_NODES.neg]: "CLIPTextEncode",
  [VRT_NODES.emptyAudio]: "LTXVEmptyLatentAudio",
  [VRT_NODES.av]: "LTXVConcatAVLatent",
  [VRT_NODES.noise]: "RandomNoise",
  [VRT_NODES.separate]: "LTXVSeparateAVLatent",
  [VRT_NODES.load]: "LoadVideo",
  [VRT_NODES.crop]: "VideoTemporalCrop",
  [VRT_NODES.components]: "GetVideoComponents",
  [VRT_NODES.genScale]: "ImageScale",
  [VRT_NODES.latentMaskCut]: "ImageFromBatch",
  [VRT_NODES.noiseMask]: "SetLatentNoiseMask",
  [VRT_NODES.audioEncode]: "LTXVAudioVAEEncode",
  [VRT_NODES.audioFreeze]: "LTXVFreezeLatent",
  [VRT_NODES.audioMask]: "LTXVAudioVideoMask",
  [VRT_NODES.pixelMask]: "ImageToMask",
  [VRT_NODES.composite]: "ImageCompositeMasked",
  [VRT_NODES.audioDecode]: "LTXVAudioVAEDecode",
  [VRT_NODES.video]: "CreateVideo",
  [VRT_NODES.latentValues]: "EmptyImage",
  [VRT_NODES.pixelValues]: "EmptyImage",
};

/** First id of the builder's latent / pixel mask chains. */
const LATENT_CHAIN_BASE = 100;
const PIXEL_CHAIN_BASE = 200;

/** Smallest 8n+1 frame count that holds `frames` (capped at the window). */
export function videoRetakeFrames(frames: number): number {
  const n = Math.min(Math.floor(frames), VIDEO_RETAKE_MAX_FRAMES);
  return n <= 1 ? 1 : 8 * Math.ceil((n - 1) / 8) + 1;
}

/** Latent frames for an 8n+1 pixel frame count. */
export function videoRetakeLatentCount(frames: number): number {
  return (videoRetakeFrames(frames) - 1) / VIDEO_RETAKE_TEMPORAL_SCALE + 1;
}

/** Latent frame that holds pixel frame `p`. */
export function videoRetakeLatentOf(p: number): number {
  return p <= 0
    ? 0
    : Math.floor(
        (p + VIDEO_RETAKE_TEMPORAL_SCALE - 1) / VIDEO_RETAKE_TEMPORAL_SCALE,
      );
}

/** Pixel frames [first, last] of latent frame `k`. */
export function videoRetakePixelsOf(k: number): [number, number] {
  return k <= 0 ? [0, 0] : [8 * k - 7, 8 * k];
}

export function videoRetakeFps(value: unknown): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 240
    ? n
    : VIDEO_RETAKE_DEFAULT_FPS;
}

export interface VideoRetakeRange {
  /** First regenerated frame (window-relative). */
  start: number;
  /** One past the last regenerated frame. */
  end: number;
  /** The range starts at frame 0: no ramp in from the source. */
  openStart: boolean;
  /** The range runs to the end of the clip: no ramp back to the source. */
  openEnd: boolean;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * Range in seconds (relative to the clip / window start) to frame indices.
 * A missing or non-positive end, an end past the window, or `toEnd` means
 * "to the end of the clip".
 */
export function videoRetakeRange(
  startSeconds: unknown,
  endSeconds: unknown,
  fps: number,
  toEnd = false,
): VideoRetakeRange {
  const max = VIDEO_RETAKE_MAX_FRAMES;
  const s = Math.max(0, num(startSeconds) ?? 0);
  const e = num(endSeconds);
  const start = Math.round(s * fps);
  const rawEnd = e !== null && e > 0 ? Math.round(e * fps) : max;
  const openEnd = toEnd || rawEnd >= max;
  const end = openEnd ? max : rawEnd;
  if (end <= start || start >= max) {
    throw new Error(
      `${VIDEO_RETAKE_ACTION}: the range is empty (end must be after start, within the first ${max} frames)`,
    );
  }
  return { start, end, openStart: start === 0, openEnd };
}

/**
 * Noise-mask value per latent frame (length VIDEO_RETAKE_MAX_LATENTS): the
 * latents that hold any range frame get `strength`, the `ramp` latents on
 * each side fade linearly to 0.
 */
export function videoRetakeLatentMask(
  range: Pick<VideoRetakeRange, "start" | "end">,
  strength: number = VIDEO_RETAKE_DEFAULT_STRENGTH,
  ramp: number = VIDEO_RETAKE_LATENT_RAMP,
  latents: number = VIDEO_RETAKE_MAX_LATENTS,
): number[] {
  const out = new Array<number>(latents).fill(0);
  const kA = videoRetakeLatentOf(range.start);
  const kB = videoRetakeLatentOf(range.end - 1);
  for (let k = kA; k <= kB && k < latents; k++) out[k] = strength;
  for (let j = 1; j <= ramp; j++) {
    const v = strength * (1 - j / (ramp + 1));
    for (const k of [kA - j, kB + j]) {
      if (k >= 0 && k < latents) out[k] = Math.max(out[k], v);
    }
  }
  return out;
}

/**
 * Composite alpha per pixel frame (length VIDEO_RETAKE_MAX_FRAMES): 0
 * outside the range (source frames kept), inside it ramps up over `ramp`
 * frames from each closed edge.
 */
export function videoRetakePixelAlpha(
  range: VideoRetakeRange,
  ramp: number = VIDEO_RETAKE_PIXEL_RAMP,
  frames: number = VIDEO_RETAKE_MAX_FRAMES,
): number[] {
  const out = new Array<number>(frames).fill(0);
  const len = range.end - range.start;
  for (let i = range.start; i < range.end && i < frames; i++) {
    const idx = i - range.start;
    const up = range.openStart ? 1 : (idx + 1) / (ramp + 1);
    const down = range.openEnd ? 1 : (len - idx) / (ramp + 1);
    out[i] = Math.min(1, up, down);
  }
  return out;
}

/** 8-bit level of a mask value (what EmptyImage's red channel can carry). */
export function maskLevel(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** Run-length encoding of the 8-bit levels of `values`. */
export function maskRuns(values: number[]): { level: number; count: number }[] {
  const runs: { level: number; count: number }[] = [];
  for (const v of values) {
    const level = maskLevel(v);
    const last = runs[runs.length - 1];
    if (last && last.level === level) last.count++;
    else runs.push({ level, count: 1 });
  }
  return runs;
}

/**
 * Writes `values` as a chain of 1x1 EmptyImage runs joined by ImageBatch,
 * ids from `base` up; returns the link to the full batch.
 */
function wireMaskValues(
  workflow: Workflow,
  base: number,
  values: number[],
  title: string,
): [string, number] {
  let id = base;
  let tail: [string, number] | null = null;
  for (const run of maskRuns(values)) {
    const seg = String(id++);
    workflow[seg] = {
      class_type: "EmptyImage",
      inputs: {
        width: 1,
        height: 1,
        batch_size: run.count,
        color: run.level << 16,
      },
      _meta: {
        title: `${title}: ${run.count} x ${(run.level / 255).toFixed(3)}`,
      },
    };
    if (!tail) {
      tail = [seg, 0];
      continue;
    }
    const join = String(id++);
    workflow[join] = {
      class_type: "ImageBatch",
      inputs: { image1: tail, image2: [seg, 0] },
      _meta: { title },
    };
    tail = [join, 0];
  }
  return tail ?? [String(base), 0];
}

const round32 = (v: number) => Math.max(256, Math.round(v / 32) * 32);

/**
 * Generation size: /32, source aspect, long edge `edge` (never above the
 * source's long edge rounded to /32).
 */
export function videoRetakeGenSize(
  width: number,
  height: number,
  edge: number = VIDEO_RETAKE_DEFAULT_EDGE,
): { width: number; height: number } {
  const w = width > 0 ? width : 16;
  const h = height > 0 ? height : 9;
  const long = Math.min(edge, Math.max(round32(Math.max(w, h)), 256));
  const a = w / h;
  return a >= 1
    ? { width: round32(long), height: round32(long / a) }
    : { width: round32(long * a), height: round32(long) };
}

export function videoRetakeEdge(value: unknown): number {
  const n = num(value);
  return VIDEO_RETAKE_EDGES.find((e) => e === n) ?? VIDEO_RETAKE_DEFAULT_EDGE;
}

export function videoRetakeStrength(value: unknown): number {
  const n = num(value);
  return n === null
    ? VIDEO_RETAKE_DEFAULT_STRENGTH
    : Math.min(1, Math.max(VIDEO_RETAKE_MIN_STRENGTH, n));
}

export function videoRetakeAudio(value: unknown): VideoRetakeAudio {
  return value === "follow" || value === "regen"
    ? value
    : VIDEO_RETAKE_DEFAULT_AUDIO;
}

/** Prompt for the new segment: the user's text, else the source prompt. */
export function videoRetakePrompt(
  sourceRun: Pick<ImagineRun, "params" | "parsedPrompt" | "prompt">,
  params: Record<string, unknown>,
): string {
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
  return (
    clean(params.prompt) ||
    (sourceRun.params?.seed_upload
      ? ""
      : clean(sourceRun.parsedPrompt || sourceRun.prompt)) ||
    VIDEO_RETAKE_DEFAULT_PROMPT
  );
}

function seedFrom(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? params.seed
    : Math.floor(Math.random() * 2 ** 32);
}

const truthy = (v: unknown) =>
  v === true || v === 1 || v === "1" || v === "true";

export function buildVideoRetakeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_RETAKE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  for (const [id, cls] of Object.entries(NODE_CLASSES)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(`${action}: workflow node ${id} must be ${cls}`);
    }
  }
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);

  const N = VRT_NODES;
  const fps = videoRetakeFps(params.sourceFps ?? params.fps);
  const range = videoRetakeRange(
    params.retake_start,
    params.retake_end,
    fps,
    truthy(params.retake_to_end),
  );
  const strength = videoRetakeStrength(params.strength);
  const audio = videoRetakeAudio(params.audio);

  setNodeInput(workflow, N.load, "file", videoRef);
  setNodeInput(workflow, N.crop, "start_frame", 0);
  setNodeInput(workflow, N.crop, "length", VIDEO_RETAKE_MAX_FRAMES);
  const gen = videoRetakeGenSize(
    sourceRun.width,
    sourceRun.height,
    videoRetakeEdge(params.res),
  );
  setNodeInput(workflow, N.genScale, "width", gen.width);
  setNodeInput(workflow, N.genScale, "height", gen.height);

  delete workflow[N.latentValues];
  delete workflow[N.pixelValues];
  setNodeInput(
    workflow,
    N.latentMaskCut,
    "image",
    wireMaskValues(
      workflow,
      LATENT_CHAIN_BASE,
      videoRetakeLatentMask(range, strength),
      "Latent mask",
    ),
  );
  setNodeInput(
    workflow,
    N.pixelMask,
    "image",
    wireMaskValues(
      workflow,
      PIXEL_CHAIN_BASE,
      videoRetakePixelAlpha(range),
      "Pixel alpha",
    ),
  );

  const drop = (...ids: string[]) => ids.forEach((id) => delete workflow[id]);
  if (audio === "keep") {
    setNodeInput(workflow, N.av, "audio_latent", [N.emptyAudio, 0]);
    setNodeInput(workflow, N.video, "audio", [N.components, 1]);
    drop(N.audioEncode, N.audioFreeze, N.audioMask, N.audioDecode);
  } else if (audio === "follow") {
    setNodeInput(workflow, N.av, "audio_latent", [N.audioFreeze, 0]);
    setNodeInput(workflow, N.video, "audio", [N.components, 1]);
    drop(N.emptyAudio, N.audioMask, N.audioDecode);
  } else {
    setNodeInput(
      workflow,
      N.audioMask,
      "audio_start_time",
      round3(range.start / fps),
    );
    setNodeInput(
      workflow,
      N.audioMask,
      "audio_end_time",
      round3(range.end / fps),
    );
    setNodeInput(workflow, N.audioMask, "max_length", "partial");
    setNodeInput(workflow, N.audioMask, "existing_mask_mode", "overwrite");
    setNodeInput(workflow, N.av, "audio_latent", [N.audioMask, 1]);
    setNodeInput(workflow, N.video, "audio", [N.audioDecode, 0]);
    drop(N.emptyAudio, N.audioFreeze);
  }

  setNodeInput(workflow, N.pos, "text", videoRetakePrompt(sourceRun, params));
  setNodeInput(workflow, N.neg, "text", VIDEO_RETAKE_NEGATIVE);
  const seed = seedFrom(params);
  setNodeInput(workflow, N.noise, "noise_seed", seed);

  const slots: WorkflowSlots = {
    ksamplerId: "",
    posTextId: N.pos,
    posTextInputName: "text",
    negTextId: N.neg,
    latentDimsId: "",
    imageInputId: N.load,
  };
  return { workflow, slots, seed };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Editor cut for a retake: the range plus context, within one window. */
export interface VideoRetakeCut {
  /** Cut window on the timeline (seconds). */
  cutStart: number;
  cutEnd: number;
  /** Range relative to the cut start (seconds). */
  retakeStart: number;
  retakeEnd: number;
  /** The range reaches the end of the clip (no ramp back). */
  toEnd: boolean;
}

/**
 * Picks the clip window the editor renders for a retake of [start, end]
 * on a timeline of `duration` seconds: up to `context` seconds on each side,
 * the whole cut within VIDEO_RETAKE_MAX_FRAMES at `fps` (minus 2 frames of
 * rounding slack) and under VIDEO_RETAKE_WINDOW_SECONDS. Null when the range
 * itself is too long or empty.
 */
export function videoRetakeCut(
  start: number,
  end: number,
  duration: number,
  fps: number = VIDEO_RETAKE_DEFAULT_FPS,
  context: number = VIDEO_RETAKE_CONTEXT_SECONDS,
): VideoRetakeCut | null {
  const f = videoRetakeFps(fps);
  // Below the card's End slider max, which means "to the end of the clip".
  const window = Math.min(
    (VIDEO_RETAKE_MAX_FRAMES - 2) / f,
    VIDEO_RETAKE_WINDOW_SECONDS - 0.1,
  );
  const s = Math.max(0, start);
  const e = Math.min(duration, end);
  if (!(e - s > 1 / f) || e - s > window) return null;
  const spare = window - (e - s);
  let before = Math.min(context, s, spare / 2);
  const after = Math.min(context, duration - e, spare - before);
  before = Math.min(s, context, spare - after);
  const cutStart = round3(s - before);
  const cutEnd = round3(e + after);
  return {
    cutStart,
    cutEnd,
    retakeStart: round3(s - cutStart),
    retakeEnd: round3(e - cutStart),
    toEnd: duration - e < 1 / f,
  };
}
