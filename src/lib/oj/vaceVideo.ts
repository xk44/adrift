/**
 * Wan2.2 Fun VACE video-to-video tools (packs/wan22/vace_*.json), core
 * ComfyUI nodes only. The source clip is trimmed from its start to the
 * generation window (Video Slice), resampled to 16 fps (VideoFrameSample,
 * uniform) and fed to WanVaceToVideo as a control video:
 *
 * - vace_restyle: canny edges of the source keep motion + layout, the prompt
 *   (and an optional style reference image) sets the look.
 * - vace_reframe: the source is fitted inside a new aspect canvas and padded;
 *   the pad mask tells VACE which pixels to invent.
 * - vace_extend: the last 17 frames of the 16 fps window are kept as
 *   context, VACE generates what happens next on the ~480p canvas (frames
 *   squeezed, not cropped). The output is NOT the resampled window: it is
 *   the source window itself at native resolution, fps and audio
 *   (GetVideoComponents on the Video Slice; only SaveVideo's H.264 encode
 *   touches it) followed by the continuation, which is
 *     1. colour-matched to the context frames (CJColorMatchToReference, one
 *        clip-wide LAB mean/std transfer; params.color_match 0..1, default 1),
 *     2. retimed 16 fps -> source fps by duplicating/dropping whole frames
 *        (CJRetimeFrames "nearest": no ghosting, motion stays 16 fps-smooth),
 *     3. lanczos-upscaled to the source size (core ImageScale),
 *   with silence (EmptyAudio + AudioConcat) under it. Source fps = the
 *   client's probe (params.sourceFps) else GetVideoComponents' rate. Sources
 *   above 1080p are output at 1080p pixel count; the window shrinks below 20 s
 *   when source + continuation frames pass VACE_EXTEND_PIXEL_BUDGET (RAM).
 *   The last 17 generated frames (canvas size, 16 fps, before H.264) are saved
 *   as PNGs under video/adrift_ctx/CJ_VaceExtend_<token>/ (SaveImage tagged
 *   adrift_sidecar: never gallery media). Extending such an output again: the
 *   client derives those refs from the lightbox clip URL
 *   (vaceTailRefsFromVideoUrl), checks two of them exist and sends
 *   params.contextFrames; when the whole clip fits the window the graph loads
 *   them (LoadImage x17) as context instead of the H.264 frames.
 *   cj_video_extend lives in comfy_nodes/ (deploy: docs/custom-nodes.md).
 *
 * Two-stage hi/lo sampling. speed "balanced" (default): high-noise model
 * without LoRA, 8 steps, cfg 3.5 for steps 0-4, then low-noise + lightx2v
 * LoRA at cfg 1. speed "fast": lightx2v LoRA on both, 4 steps, cfg 1.
 * Restyle / reframe output the 16 fps resampled window without audio.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import { SIDECAR_SUBFOLDER } from "@/lib/output/saveNodes";
import { normalizeFps } from "@/lib/videoFps";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
  validateViewRef,
} from "./engine";
import { RELIGHT_PRESETS } from "./relight";
import { VACE_LOOK_PRESETS, type VaceLookPreset } from "./vacePresets";

export {
  VACE_LIGHT_OPTIONS,
  VACE_LOOK_PRESETS,
  VACE_PRESET_NONE,
  type VaceLookPreset,
} from "./vacePresets";

export const VACE_RESTYLE_ACTION = "vace_restyle";
export const VACE_REFRAME_ACTION = "vace_reframe";
export const VACE_EXTEND_ACTION = "vace_extend";

export const VACE_FPS = 16;
/** 4n+1 window: 17 frames (~1 s) to 81 frames (~5 s). */
export const VACE_MIN_LENGTH = 17;
export const VACE_MAX_LENGTH = 81;
const SHORT_EDGE = 480;
const MAX_LONG_EDGE = 832;

/** Reframe target canvases (multiples of 16, ~480p). */
export const VACE_CANVASES: Record<string, { width: number; height: number }> =
  {
    "9:16": { width: 480, height: 832 },
    "16:9": { width: 832, height: 480 },
    "1:1": { width: 624, height: 624 },
    "4:5": { width: 512, height: 640 },
  };

/** Extend: context frames kept from the source tail. */
export const VACE_EXTEND_CONTEXT = 17;
/** Extend: longest source we re-encode in full (frames at 16 fps, 20 s). */
export const VACE_EXTEND_MAX_SOURCE = 320;

export const VACE_RESTYLE_NEGATIVE =
  "photograph, photorealistic, blurry, low quality, static, distorted, text, watermark, worst quality, jpeg artifacts";
/** Appended to the scene description (a generic prompt alone fills poorly). */
export const VACE_REFRAME_SUFFIX =
  "Seamless continuation of the same environment, consistent lighting, cinematic.";
export const VACE_EXTEND_PROMPT =
  "The scene continues naturally with the same motion, same camera movement, consistent lighting and style.";

// Restyle presets: "Mixed Media" looks + "Video Relight" lights

/** Video Relight lights: the image relight tool's phrasing (relight.ts). */
export const VACE_LIGHT_PRESETS: Record<string, string> = {
  ...RELIGHT_PRESETS,
};

export const VACE_RELIGHT_NEGATIVE =
  "blurry, low quality, distorted, text, watermark, worst quality, jpeg artifacts, cartoon, painting, illustration, flat lighting";

export function vaceLookPreset(id: unknown): VaceLookPreset | undefined {
  return typeof id === "string"
    ? VACE_LOOK_PRESETS.find((p) => p.id === id.trim())
    : undefined;
}

export function vaceLightPreset(id: unknown): string | undefined {
  const key = typeof id === "string" ? id.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(VACE_LIGHT_PRESETS, key)
    ? VACE_LIGHT_PRESETS[key]
    : undefined;
}

/**
 * Restyle prompt + negative from a look preset, a light preset and the
 * user's text: "<look>, <user text>, relit with <light>". A light with no
 * look keeps the footage photoreal (and drops "photorealistic" from the
 * negative). Returns an empty prompt when all three are empty.
 */
export function vaceRestylePrompt(params: Record<string, unknown>): {
  prompt: string;
  negative: string;
  relight: boolean;
} {
  const user = promptOf(params);
  const look = vaceLookPreset(params.look);
  const light = vaceLightPreset(params.light);
  const parts: string[] = [];
  if (look) parts.push(look.prompt);
  else if (light)
    parts.push("realistic footage of the same scene and subjects");
  if (user) parts.push(user);
  if (light) parts.push(`relit with ${light}`);
  const relight = !look && !!light;
  return {
    prompt: parts.join(", "),
    negative: relight ? VACE_RELIGHT_NEGATIVE : VACE_RESTYLE_NEGATIVE,
    relight,
  };
}

function finite(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Frames for a clip of `seconds` at 16 fps, snapped DOWN to 4n+1 and clamped
 * to [17, 81]. Unknown duration → 81 (5 s). Longer clips are trimmed to their
 * first ~5 s (the UI says so).
 */
export function vaceLength(seconds?: number | null): number {
  const s = finite(seconds);
  if (s === undefined) return VACE_MAX_LENGTH;
  const frames = Math.floor(s * VACE_FPS);
  const snapped = Math.floor((frames - 1) / 4) * 4 + 1;
  return Math.min(VACE_MAX_LENGTH, Math.max(VACE_MIN_LENGTH, snapped));
}

const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/** Output size: 480 short edge, source aspect, multiples of 16, long edge ≤ 832. */
export function vaceDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = finite(width) ?? 16;
  const h = finite(height) ?? 9;
  const long = Math.min(
    MAX_LONG_EDGE,
    round16((SHORT_EDGE * Math.max(w, h)) / Math.min(w, h)),
  );
  return w >= h
    ? { width: long, height: SHORT_EDGE }
    : { width: SHORT_EDGE, height: long };
}

export function vaceCanvas(aspect: unknown): { width: number; height: number } {
  const key = typeof aspect === "string" ? aspect.trim() : "";
  return VACE_CANVASES[key] ?? VACE_CANVASES["9:16"];
}

export interface VaceFit {
  /** Scaled source size inside the canvas. */
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Fit the source (aspect preserved, multiples of 16: an unaligned fit left a
 * washed-out seam in the fill) inside the canvas and split the padding
 * (multiples of 8). Throws when the source already has the canvas aspect
 * (less than 32 px to fill).
 */
export function vaceReframeFit(
  srcWidth: number | undefined,
  srcHeight: number | undefined,
  canvas: { width: number; height: number },
): VaceFit {
  const sw = finite(srcWidth) ?? 16;
  const sh = finite(srcHeight) ?? 9;
  const a = sw / sh;
  let width: number;
  let height: number;
  if (a >= canvas.width / canvas.height) {
    width = canvas.width;
    height = Math.min(canvas.height, round16(canvas.width / a));
  } else {
    height = canvas.height;
    width = Math.min(canvas.width, round16(canvas.height * a));
  }
  const padX = canvas.width - width;
  const padY = canvas.height - height;
  if (padX + padY < 32) {
    throw new Error(
      `${VACE_REFRAME_ACTION}: the clip already has this aspect ratio; pick another one`,
    );
  }
  const left = Math.floor(padX / 16) * 8;
  const top = Math.floor(padY / 16) * 8;
  return { width, height, left, top, right: padX - left, bottom: padY - top };
}

/** Extend: total generated window (17 context + new) for 2/3/4 s of new footage. */
export function vaceExtendLength(seconds: unknown): number {
  const s = typeof seconds === "string" ? Number(seconds) : seconds;
  const n = typeof s === "number" && Number.isFinite(s) ? s : 3;
  const add = Math.min(4, Math.max(1, Math.round(n))) * VACE_FPS;
  return VACE_EXTEND_CONTEXT + add;
}

/** Extend: source frames used (whole clip at 16 fps, capped at 20 s). */
export function vaceExtendSourceFrames(seconds?: number | null): number {
  const s = finite(seconds);
  if (s === undefined) return VACE_MAX_LENGTH;
  return Math.min(
    VACE_EXTEND_MAX_SOURCE,
    Math.max(VACE_EXTEND_CONTEXT, Math.floor(s * VACE_FPS)),
  );
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === classType)
    .sort((a, b) => Number(a) - Number(b));
}

function titleOf(workflow: Workflow, id: string): string {
  const meta = (workflow[id] as { _meta?: { title?: unknown } })._meta;
  return typeof meta?.title === "string" ? meta.title : "";
}

export interface VaceNodes {
  vace: string;
  load: string;
  slice: string;
  sample: string;
  scale: string;
  pos: string;
  neg: string;
  hi: string;
  lo: string;
  loraHi?: string;
  shiftHi?: string;
}

function vaceNodes(workflow: Workflow, action: string): VaceNodes {
  const vace = nodeIdOf(workflow, "WanVaceToVideo");
  const load = nodeIdOf(workflow, "LoadVideo");
  const slice = nodeIdOf(workflow, "Video Slice");
  const sample = nodeIdOf(workflow, "VideoFrameSample");
  const scale = nodeIdOf(workflow, "ImageScale");
  const samplers = nodeIdsOf(workflow, "KSamplerAdvanced");
  if (!vace || !load || !slice || !sample || !scale || samplers.length !== 2) {
    throw new Error(
      `${action}: workflow needs LoadVideo, Video Slice, VideoFrameSample, ImageScale, WanVaceToVideo and two KSamplerAdvanced`,
    );
  }
  const [hi, lo] = samplers;
  const pos = workflow[vace].inputs.positive;
  const neg = workflow[vace].inputs.negative;
  if (!Array.isArray(pos) || !Array.isArray(neg)) {
    throw new Error(`${action}: WanVaceToVideo prompts are not wired`);
  }
  const shiftHiRef = workflow[hi].inputs.model;
  const shiftHi = Array.isArray(shiftHiRef) ? String(shiftHiRef[0]) : undefined;
  const loraHi = nodeIdsOf(workflow, "LoraLoaderModelOnly").find((id) =>
    /high/i.test(`${titleOf(workflow, id)} ${workflow[id].inputs.lora_name}`),
  );
  return {
    vace,
    load,
    slice,
    sample,
    scale,
    hi,
    lo,
    loraHi,
    shiftHi,
    pos: String(pos[0]),
    neg: String(neg[0]),
  };
}

export type VaceSpeed = "balanced" | "fast";

export function vaceSpeed(value: unknown): VaceSpeed {
  return value === "fast" ? "fast" : "balanced";
}

/** Balanced: hi w/o LoRA 8 steps cfg 3.5 (0-4) → lo + LoRA cfg 1. Fast: LoRA both, 4 steps, cfg 1. */
export function applyVaceSpeed(
  workflow: Workflow,
  n: Pick<VaceNodes, "hi" | "lo" | "loraHi" | "shiftHi">,
  speed: VaceSpeed,
) {
  const hiModel = workflow[n.loraHi ?? ""]?.inputs.model;
  if (speed === "fast") {
    if (!n.loraHi || !n.shiftHi)
      throw new Error("vace: fast mode needs the high-noise LoRA node");
    setNodeInput(workflow, n.shiftHi, "model", [n.loraHi, 0]);
    setNodeInput(workflow, n.hi, "steps", 4);
    setNodeInput(workflow, n.hi, "cfg", 1);
    setNodeInput(workflow, n.hi, "end_at_step", 2);
    setNodeInput(workflow, n.lo, "steps", 4);
    setNodeInput(workflow, n.lo, "start_at_step", 2);
    return;
  }
  if (n.shiftHi && Array.isArray(hiModel))
    setNodeInput(workflow, n.shiftHi, "model", hiModel);
  if (n.loraHi) delete workflow[n.loraHi];
  setNodeInput(workflow, n.hi, "steps", 8);
  setNodeInput(workflow, n.hi, "cfg", 3.5);
  setNodeInput(workflow, n.hi, "end_at_step", 4);
  setNodeInput(workflow, n.lo, "steps", 8);
  setNodeInput(workflow, n.lo, "start_at_step", 4);
}

function promptOf(params: Record<string, unknown>): string {
  return typeof params.prompt === "string"
    ? params.prompt.replace(/\s+/g, " ").trim().slice(0, 1500)
    : "";
}

type BuildResult = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function common(
  action: string,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
) {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);
  const n = vaceNodes(workflow, action);
  setNodeInput(workflow, n.load, "file", videoRef);
  const seconds = finite(params.video_seconds, sourceRun.params?.video_seconds);
  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, n.hi, "noise_seed", seed);
  applyVaceSpeed(workflow, n, vaceSpeed(params.speed));
  const slots: WorkflowSlots = {
    ksamplerId: n.hi,
    posTextId: n.pos,
    posTextInputName: "text",
    negTextId: n.neg,
    latentDimsId: n.vace,
    imageInputId: n.load,
  };
  return { workflow, n, seconds, seed, slots };
}

/** Trim + resample the source window to `frames` at 16 fps. */
function setWindow(workflow: Workflow, n: VaceNodes, frames: number) {
  setNodeInput(workflow, n.slice, "start_time", 0);
  setNodeInput(workflow, n.slice, "duration", frames / VACE_FPS);
  setNodeInput(workflow, n.sample, "num_frames", frames);
}

export function buildVaceRestyleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const action = VACE_RESTYLE_ACTION;
  const { prompt, negative, relight } = vaceRestylePrompt(params);
  if (!prompt) throw new Error(`${action}: prompt or a preset is required`);
  const { workflow, n, seconds, seed, slots } = common(
    action,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
  const length = vaceLength(seconds);
  const dims = vaceDims(sourceRun.width, sourceRun.height);
  setWindow(workflow, n, length);
  setNodeInput(workflow, n.scale, "width", dims.width);
  setNodeInput(workflow, n.scale, "height", dims.height);
  setNodeInput(workflow, n.scale, "crop", "center");
  setNodeInput(workflow, n.vace, "width", dims.width);
  setNodeInput(workflow, n.vace, "height", dims.height);
  setNodeInput(workflow, n.vace, "length", length);
  setNodeInput(workflow, n.pos, "text", prompt);
  setNodeInput(workflow, n.neg, "text", negative);

  const ref =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (ref) {
    if (!parseInputRef(ref)) {
      throw new Error(
        `${action}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
      );
    }
    let id = 100;
    while (workflow[String(id)]) id++;
    workflow[String(id)] = {
      class_type: "LoadImage",
      inputs: { image: ref },
      _meta: { title: "Style reference" },
    } as Workflow[string];
    setNodeInput(workflow, n.vace, "reference_image", [String(id), 0]);
  } else if (relight) {
    // Relight: canny alone forgets colors and identity; the source's first
    // frame as VACE reference keeps them while the prompt changes the light.
    let id = 100;
    while (workflow[String(id)]) id++;
    workflow[String(id)] = {
      class_type: "ImageFromBatch",
      inputs: { image: [n.scale, 0], batch_index: 0, length: 1 },
      _meta: { title: "Source first frame (relight reference)" },
    } as Workflow[string];
    setNodeInput(workflow, n.vace, "reference_image", [String(id), 0]);
  }
  return { workflow, slots, seed };
}

export function buildVaceReframeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const action = VACE_REFRAME_ACTION;
  const { workflow, n, seconds, seed, slots } = common(
    action,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
  const padId = nodeIdOf(workflow, "ImagePadForOutpaint");
  const repeatId = nodeIdOf(workflow, "RepeatImageBatch");
  if (!padId || !repeatId) {
    throw new Error(
      `${action}: workflow needs ImagePadForOutpaint and RepeatImageBatch`,
    );
  }
  const prompt = promptOf(params);
  if (!prompt)
    throw new Error(`${action}: describe the scene (prompt is required)`);
  const length = vaceLength(seconds);
  const canvas = vaceCanvas(params.aspect);
  const fit = vaceReframeFit(sourceRun.width, sourceRun.height, canvas);
  setWindow(workflow, n, length);
  setNodeInput(workflow, n.scale, "width", fit.width);
  setNodeInput(workflow, n.scale, "height", fit.height);
  setNodeInput(workflow, n.scale, "crop", "disabled");
  for (const side of ["left", "top", "right", "bottom"] as const) {
    setNodeInput(workflow, padId, side, fit[side]);
  }
  setNodeInput(workflow, repeatId, "amount", length);
  setNodeInput(workflow, n.vace, "width", canvas.width);
  setNodeInput(workflow, n.vace, "height", canvas.height);
  setNodeInput(workflow, n.vace, "length", length);
  setNodeInput(
    workflow,
    n.pos,
    "text",
    `${prompt.replace(/[.\s]+$/, "")}. ${VACE_REFRAME_SUFFIX}`,
  );
  return { workflow, slots, seed };
}

/** Fixed node ids in packs/wan22/vace_extend.json (checked by class). */
export const VACE_EXTEND_NODES = {
  create: "16",
  save: "17",
  slice: "21",
  sample: "22",
  frames16: "23",
  canvas: "24",
  native: "30",
  nativeSize: "31",
  ctx: "40",
  gray: "41",
  keep: "43",
  generate: "44",
  newFrames: "47",
  joined: "48",
  colorMatch: "50",
  tailBatch: "51",
  tail: "52",
  tailSave: "53",
  upscale: "55",
  retime: "56",
  silence: "57",
  audio: "58",
} as const;

const VACE_EXTEND_CLASSES: Record<keyof typeof VACE_EXTEND_NODES, string> = {
  create: "CreateVideo",
  save: "SaveVideo",
  slice: "Video Slice",
  sample: "VideoFrameSample",
  frames16: "GetVideoComponents",
  canvas: "ImageScale",
  native: "GetVideoComponents",
  nativeSize: "GetImageSize",
  ctx: "ImageFromBatch",
  gray: "EmptyImage",
  keep: "EmptyImage",
  generate: "EmptyImage",
  newFrames: "ImageFromBatch",
  joined: "ImageBatch",
  colorMatch: "CJColorMatchToReference",
  tailBatch: "ImageBatch",
  tail: "ImageFromBatch",
  tailSave: "SaveImage",
  upscale: "ImageScale",
  retime: "CJRetimeFrames",
  silence: "EmptyAudio",
  audio: "AudioConcat",
};

/** Base name of extend outputs; a per-run token follows ("CJ_VaceExtend_<token>"). */
export const VACE_EXTEND_PREFIX = "CJ_VaceExtend";
/** Subfolder segment of the lossless tail PNGs (hidden from the gallery, saveNodes.ts). */
export { SIDECAR_SUBFOLDER as VACE_EXTEND_TAIL_FOLDER } from "@/lib/output/saveNodes";
/**
 * Native source pixel-frames held in RAM (float32, ~12 bytes each, several
 * copies while joining/encoding): 12 s of 1080p30 for source + continuation.
 */
export const VACE_EXTEND_PIXEL_BUDGET = 1920 * 1080 * 30 * 12;
/** Larger sources are output at this many pixels (aspect kept); 1080p. */
export const VACE_EXTEND_MAX_OUTPUT_PIXELS = 1920 * 1080;

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Output size of the extended clip: the source size, or (sources above
 * VACE_EXTEND_MAX_OUTPUT_PIXELS) scaled down to that pixel count. null when
 * the source size is unknown or already fits (no rescale node).
 */
export function vaceExtendOutputSize(
  width?: number,
  height?: number,
): { width: number; height: number } | null {
  const w = finite(width);
  const h = finite(height);
  if (!w || !h || w * h <= VACE_EXTEND_MAX_OUTPUT_PIXELS) return null;
  const f = Math.sqrt(VACE_EXTEND_MAX_OUTPUT_PIXELS / (w * h));
  return { width: even(w * f), height: even(h * f) };
}

/**
 * Seconds of the source kept (from its start): the whole clip up to 20 s,
 * less when the native frames of source + `addSeconds` of continuation would
 * pass VACE_EXTEND_PIXEL_BUDGET (unknown size/fps: 1280x720 at 30 fps).
 * Never below the 17-frame context. Unknown duration: 81/16 s.
 */
export function vaceExtendWindowSeconds(
  seconds: number | null | undefined,
  opts: { width?: number; height?: number; fps?: number; addSeconds?: number } = {},
): number {
  const out = vaceExtendOutputSize(opts.width, opts.height);
  const w = out?.width ?? finite(opts.width) ?? 1280;
  const h = out?.height ?? finite(opts.height) ?? 720;
  const fps = finite(opts.fps) ?? 30;
  const add = finite(opts.addSeconds) ?? 0;
  const cap = Math.min(
    VACE_EXTEND_MAX_SOURCE / VACE_FPS,
    VACE_EXTEND_PIXEL_BUDGET / (w * h * fps) - add,
  );
  const s = finite(seconds) ?? VACE_MAX_LENGTH / VACE_FPS;
  return Math.max(VACE_EXTEND_CONTEXT / VACE_FPS, Math.min(s, cap));
}

/** Random file-name token: one tail folder per extend run (counters never collide). */
function runToken(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).replace(/[^a-z0-9]/g, "");
}

const VIDEO_NAME_RE = new RegExp(`^(${VACE_EXTEND_PREFIX}_[A-Za-z0-9]+)_\\d{5}_\\.mp4$`);

/**
 * Lossless tail of an extend output: the 17 PNG refs ("sub/f_000NN_.png
 * [output]") its run saved next to the MP4, from the MP4's /view or
 * /api/comfy/image URL. null for any other clip. The refs are only a guess
 * until the files are checked (the client probes them before sending).
 */
export function vaceTailRefsFromVideoUrl(url: string | undefined | null): string[] | null {
  if (!url) return null;
  let q: URLSearchParams;
  try {
    q = new URL(url, "http://localhost").searchParams;
  } catch {
    return null;
  }
  if ((q.get("type") || "output") !== "output") return null;
  const m = VIDEO_NAME_RE.exec(q.get("filename") ?? "");
  if (!m) return null;
  const sub = (q.get("subfolder") ?? "").replace(/^\/+|\/+$/g, "");
  const folder = [sub, SIDECAR_SUBFOLDER, m[1]].filter(Boolean).join("/");
  const refs: string[] = [];
  for (let i = 1; i <= VACE_EXTEND_CONTEXT; i++) {
    const ref = validateViewRef(`f_${String(i).padStart(5, "0")}_.png`, folder, "output");
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

/** params.contextFrames when it is exactly 17 tail PNG refs (else null). */
export function vaceContextFrames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== VACE_EXTEND_CONTEXT) return null;
  for (const v of value) {
    if (typeof v !== "string") return null;
    const m = /^(.+) \[output\]$/.exec(v);
    if (!m || !/\.png$/i.test(m[1])) return null;
    const path = m[1];
    const slash = path.lastIndexOf("/");
    const sub = slash >= 0 ? path.slice(0, slash) : "";
    if (!sub.split("/").includes(SIDECAR_SUBFOLDER)) return null;
    if (validateViewRef(path.slice(slash + 1), sub, "output") !== v) return null;
  }
  return value as string[];
}

/** Colour-match strength (params.color_match, 0..1); default 1. */
export function vaceColorMatch(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export function buildVaceExtendWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const action = VACE_EXTEND_ACTION;
  const { workflow, n, seconds, seed, slots } = common(
    action,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
  const N = VACE_EXTEND_NODES;
  for (const [key, id] of Object.entries(N)) {
    const want = VACE_EXTEND_CLASSES[key as keyof typeof N];
    if (workflow[id]?.class_type !== want) {
      throw new Error(`${action}: workflow node ${id} must be ${want}`);
    }
  }
  const length = vaceExtendLength(params.seconds);
  const k = VACE_EXTEND_CONTEXT;
  const added = length - k;
  const dims = vaceDims(sourceRun.width, sourceRun.height);
  const fps = normalizeFps(params.sourceFps);
  const windowS = vaceExtendWindowSeconds(seconds, {
    width: sourceRun.width,
    height: sourceRun.height,
    fps: fps ?? undefined,
    addSeconds: added / VACE_FPS,
  });

  // Lossless context: the previous extend's tail PNGs, only when the whole
  // clip is kept (they must be its last frames).
  const tail = vaceContextFrames(params.contextFrames);
  const useTail =
    !!tail && seconds !== undefined && seconds <= windowS + 1e-6;

  // Generation path: 16 fps window squeezed (no crop: the upscale back is
  // its exact inverse) onto the VACE canvas.
  setNodeInput(workflow, n.scale, "width", dims.width);
  setNodeInput(workflow, n.scale, "height", dims.height);
  setNodeInput(workflow, n.scale, "crop", "disabled");
  setNodeInput(workflow, N.ctx, "length", k);
  if (useTail) {
    setNodeInput(workflow, N.slice, "start_time", 0);
    setNodeInput(workflow, N.slice, "duration", 0);
    delete workflow[N.sample];
    delete workflow[N.frames16];
    let prev: [string, number] | null = null;
    tail!.forEach((ref, i) => {
      const id = String(60 + i);
      workflow[id] = {
        class_type: "LoadImage",
        inputs: { image: ref },
        _meta: { title: `Lossless context ${i + 1}` },
      } as Workflow[string];
      if (prev) {
        const bid = String(80 + i);
        workflow[bid] = {
          class_type: "ImageBatch",
          inputs: { image1: prev, image2: [id, 0] },
          _meta: { title: "Lossless context batch" },
        } as Workflow[string];
        prev = [bid, 0];
      } else prev = [id, 0];
    });
    setNodeInput(workflow, n.scale, "image", prev!);
    setNodeInput(workflow, N.ctx, "batch_index", 0);
  } else {
    const ns = Math.max(k, Math.floor(windowS * VACE_FPS));
    setWindow(workflow, n, ns);
    // Context = last k frames of the 16 fps window.
    setNodeInput(workflow, N.ctx, "batch_index", ns - k);
  }
  // Generated tail = frames k.. of the output.
  setNodeInput(workflow, N.newFrames, "batch_index", k);
  setNodeInput(workflow, N.newFrames, "length", added);
  for (const [id, count] of [
    [N.gray, added],
    [N.keep, k],
    [N.generate, added],
  ] as const) {
    setNodeInput(workflow, id, "width", dims.width);
    setNodeInput(workflow, id, "height", dims.height);
    setNodeInput(workflow, id, "batch_size", count);
  }
  setNodeInput(workflow, n.vace, "width", dims.width);
  setNodeInput(workflow, n.vace, "height", dims.height);
  setNodeInput(workflow, n.vace, "length", length);
  setNodeInput(workflow, n.pos, "text", promptOf(params) || VACE_EXTEND_PROMPT);

  // Output path: native source frames + colour-matched, retimed, upscaled
  // continuation, at the source fps with the source audio (+ silence).
  setNodeInput(workflow, N.colorMatch, "strength", vaceColorMatch(params.color_match));
  setNodeInput(workflow, N.tail, "batch_index", added);
  setNodeInput(workflow, N.tail, "length", k);
  setNodeInput(workflow, N.retime, "src_fps", VACE_FPS);
  if (fps !== null) {
    // The client's probe beats GetVideoComponents' average rate (1 fps for
    // streams without one).
    setNodeInput(workflow, N.retime, "dst_fps", fps);
    setNodeInput(workflow, N.create, "fps", fps);
  }
  setNodeInput(workflow, N.silence, "duration", added / VACE_FPS);
  const out = vaceExtendOutputSize(sourceRun.width, sourceRun.height);
  if (out) {
    const id = "32";
    workflow[id] = {
      class_type: "ImageScale",
      inputs: {
        image: [N.native, 0],
        upscale_method: "lanczos",
        width: out.width,
        height: out.height,
        crop: "disabled",
      },
      _meta: { title: "Source to output size" },
    } as Workflow[string];
    setNodeInput(workflow, N.nativeSize, "image", [id, 0]);
    setNodeInput(workflow, N.joined, "image1", [id, 0]);
  }
  const token = runToken();
  const name = `${VACE_EXTEND_PREFIX}_${token}`;
  setNodeInput(workflow, N.save, "filename_prefix", `video/${name}`);
  setNodeInput(
    workflow,
    N.tailSave,
    "filename_prefix",
    `video/${SIDECAR_SUBFOLDER}/${name}/f`,
  );
  return { workflow, slots, seed };
}
