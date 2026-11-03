/**
 * Long MiniMax H3 clips + a per-subject "Fix faces" pass.
 *
 * Long clip: one graph, one sampling run, no decode between segments. H3
 * degrades when a clip is decoded to pixels and re-encoded as the next
 * segment's start, so segments are chained in latent space instead:
 *
 *   context     core MiniMaxH3ContextWindows (ComfyUI PR #17425): every step
 *               denoises all windows and fuses the overlaps (pyramid), with
 *               FreeNoise; the joint audio latent is split at the same
 *               boundaries, so the soundtrack stays one continuous stream.
 *   sequential  MiniMaxH3TemporalWindow (ComfyUI-MiniMaxH3-TemporalWindow-
 *               SpatialTiles, MIT): windows run in order, each one carrying the
 *               previous window's finished overlap (video + audio latent) as
 *               its frame-0 guide, crossfaded in the overlap.
 *
 * Fix faces (idea from OPENjutsu, D3voz/openjutsu, MIT; nodes from
 * ComfyUI-H3-FaceRefine, MIT): SAM 3 tracks up to N people once; then each
 * subject gets its OWN pass so faces never mix: seed a point inside that
 * subject's mask -> track + crop that face -> low-denoise H3 refine of the
 * crop (same model, refs and soundtrack as reference audio) -> stitch the face
 * back -> clamp the change to that subject's mask. Pass k+1 starts from pass
 * k's output. The soundtrack is the long clip's own (refine audio is dropped).
 *
 *   params.longClip      true to enable
 *   params.longSeconds   target duration (H3_LONG_MIN..MAX_SECONDS)
 *   params.longMethod    "context" (default) | "sequential"
 *   params.longWindow    frames per window (17k+5, H3_LONG_WINDOW_MIN..MAX)
 *   params.longOverlap   frames shared by neighbours (17k+5; unset = method default)
 *   params.fixFaces      subjects to polish (0 = off, 1..H3_FIX_FACES_MAX)
 */
import type { Workflow } from "@/types";
import { nextNodeId } from "./loraInsert";
import { samplerModelSource } from "./h3Video";
import { requestedH3Speed } from "./h3Speed";

export const H3_FPS = 24;
/** H3 video latent chunk: 5 tokens = 17 frames (1 + 4 + 4 + 4 + 4). */
const CHUNK_TOKENS = 5;
const CHUNK_FRAMES = 17;
const CHUNK_TOKEN_OFFSETS = [0, 1, 5, 9, 13];

export const H3_LONG_MIN_SECONDS = 6;
export const H3_LONG_MAX_SECONDS = 30;
export const H3_LONG_DEFAULT_SECONDS = 10;
/** One window = H3's single-clip sweet spot (124 frames, ~5.2 s). */
export const H3_LONG_WINDOW_FRAMES = 124;
export const H3_LONG_WINDOW_MIN = 73;
export const H3_LONG_WINDOW_MAX = 192;
export const H3_LONG_CONTEXT_OVERLAP = 39;
export const H3_LONG_SEQUENTIAL_OVERLAP = 22;
export const H3_FIX_FACES_MAX = 3;

export type H3LongMethod = "context" | "sequential";

export const H3_CONTEXT_WINDOWS_NODE = "MiniMaxH3ContextWindows";
export const H3_TEMPORAL_WINDOW_NODE = "MiniMaxH3TemporalWindow";

export const H3_FIX_FACES_SAM3 = "sam3.1_multiplex_fp16.safetensors";
export const H3_FIX_FACES_SAM = "sam_vit_b_01ec64.pth";
export const H3_FIX_FACES_DETECTOR = "bbox/face_yolov8m.pt";
export const H3_FIX_FACES_FALLBACK = "segm/person_yolov8m-seg.pt";
/** Base denoise; H3PerFrameDenoise scales it down for faces that are already big. */
export const H3_FIX_FACES_DENOISE = 0.4;

/** Video latent length for `frames` pixel frames (2 for <= 5, then 5 per 17). */
export function h3VideoLatentT(frames: number): number {
  const f = Math.max(1, Math.floor(frames));
  return f <= 5 ? 2 : Math.floor((f - 5) / CHUNK_FRAMES) * CHUNK_TOKENS + 2;
}

/** Smallest 17k+5 frame count >= `frames`. */
export function h3SnapFrames(frames: number): number {
  const f = Math.max(5, Math.ceil(frames));
  return 5 + Math.ceil((f - 5) / CHUNK_FRAMES) * CHUNK_FRAMES;
}

/** Frames for a target duration, snapped up to the 17k+5 grid. */
export function h3FramesForSeconds(seconds: number): number {
  return h3SnapFrames(seconds * H3_FPS);
}

/**
 * First pixel frame of video latent token `t`: chunks of 5 tokens cover 1, 4,
 * 4, 4, 4 frames from token 0 (5k+2 tokens = k chunks + a 1,4 tail). Token
 * `latentT` maps to the frame count, so [start, end) maps to [start, end).
 */
export function h3LatentToFrame(t: number): number {
  if (t <= 0) return 0;
  return (
    Math.floor(t / CHUNK_TOKENS) * CHUNK_FRAMES +
    CHUNK_TOKEN_OFFSETS[t % CHUNK_TOKENS]
  );
}

/** Core STATIC_STANDARD schedule: [start, end) latent windows of `len`. */
export function h3ContextWindows(
  latentT: number,
  len: number,
  overlap: number,
): Array<[number, number]> {
  if (latentT <= len) return [[0, latentT]];
  const delta = len - overlap;
  const out: Array<[number, number]> = [];
  for (let start = 0; start < latentT; start += delta) {
    if (start + len >= latentT) {
      out.push([latentT - len, latentT]);
      break;
    }
    out.push([start, start + len]);
  }
  return out;
}

/** MiniMaxH3TemporalWindow plan_windows: [start, end) latent windows. */
export function h3SequentialWindows(
  latentT: number,
  windowFrames: number,
  overlapFrames: number,
): Array<[number, number]> {
  const win = h3VideoLatentT(windowFrames);
  if (windowFrames <= 0 || win >= latentT) return [[0, latentT]];
  const ov = Math.min(h3VideoLatentT(overlapFrames), win - CHUNK_TOKENS);
  const starts: Array<[number, number]> = [[0, win]];
  while (starts[starts.length - 1][0] + win < latentT) {
    let start = starts[starts.length - 1][0] + win - ov;
    if (start + win > latentT)
      start = Math.floor((latentT - win) / CHUNK_TOKENS) * CHUNK_TOKENS;
    starts.push([start, Math.min(win, latentT - start)]);
  }
  return starts.map(([s, n]) => [s, s + n]);
}

export interface H3LongWindow {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
}

export interface H3LongPlan {
  method: H3LongMethod;
  frames: number;
  seconds: number;
  latentT: number;
  windowFrames: number;
  overlapFrames: number;
  windows: H3LongWindow[];
  segments: number;
  fixFaces: number;
  /** Rough wall time on a 24 GB GPU once the models are loaded. */
  etaSeconds: number;
}

export function h3LongMethod(v: unknown): H3LongMethod {
  return v === "sequential" ? "sequential" : "context";
}

export function h3LongSeconds(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return H3_LONG_DEFAULT_SECONDS;
  return Math.min(H3_LONG_MAX_SECONDS, Math.max(H3_LONG_MIN_SECONDS, n));
}

/** Snap to the 17k+5 grid (nearest), clamped to [min, max]. */
function snapGrid(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n))
    return fallback;
  const snapped = 5 + Math.round((n - 5) / CHUNK_FRAMES) * CHUNK_FRAMES;
  return Math.min(max, Math.max(min, snapped));
}

/** Frames per window: 17k+5 in [H3_LONG_WINDOW_MIN, H3_LONG_WINDOW_MAX]. */
export function h3LongWindowFrames(v: unknown): number {
  return snapGrid(v, H3_LONG_WINDOW_MIN, H3_LONG_WINDOW_MAX, H3_LONG_WINDOW_FRAMES);
}

/**
 * Overlap frames: 17k+5, at least one chunk shorter than the window; unset
 * or "auto" picks the method's default.
 */
export function h3LongOverlapFrames(
  v: unknown,
  method: H3LongMethod,
  windowFrames: number,
): number {
  const fallback =
    method === "context" ? H3_LONG_CONTEXT_OVERLAP : H3_LONG_SEQUENTIAL_OVERLAP;
  const max = windowFrames - CHUNK_FRAMES;
  return Math.min(
    max,
    snapGrid(v === "auto" ? undefined : v, 5, max, fallback),
  );
}

export function h3FixFacesCount(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(H3_FIX_FACES_MAX, Math.max(0, n)) : 0;
}

/**
 * Seconds per 124-frame window at 864x480 with Turbo 8-step (calibrated from
 * the single-clip figure: 3 s in ~45 s). Scaled by canvas area and steps.
 */
const ETA_WINDOW_480_TURBO8 = 75;
const ETA_SPEED: Record<string, number> = {
  turbo8: 1,
  turbo4: 0.55,
  fast8: 1,
  off: 2.5,
};
const ETA_768 = 2.5;
/** Per subject: SAM 3 + crop + a 768x768 refine at 0.4 denoise, per window. */
const ETA_FACE_PER_WINDOW = 0.6;
const ETA_OVERHEAD = 20;

export function planH3LongClip(opts: {
  seconds: unknown;
  method?: unknown;
  windowFrames?: unknown;
  overlapFrames?: unknown;
  resolution?: unknown;
  h3Speed?: unknown;
  fixFaces?: unknown;
}): H3LongPlan {
  const method = h3LongMethod(opts.method);
  const frames = h3FramesForSeconds(h3LongSeconds(opts.seconds));
  const latentT = h3VideoLatentT(frames);
  const windowFrames = h3LongWindowFrames(opts.windowFrames);
  const overlapFrames = h3LongOverlapFrames(
    opts.overlapFrames,
    method,
    windowFrames,
  );
  const ranges =
    method === "context"
      ? h3ContextWindows(
          latentT,
          h3VideoLatentT(windowFrames),
          Math.min(
            h3VideoLatentT(overlapFrames),
            h3VideoLatentT(windowFrames) - CHUNK_TOKENS,
          ),
        )
      : h3SequentialWindows(latentT, windowFrames, overlapFrames);
  const windows = ranges.map(([s, e]) => {
    const startFrame = h3LatentToFrame(s);
    const endFrame = Math.min(frames, h3LatentToFrame(e));
    return {
      startFrame,
      endFrame,
      startSec: startFrame / H3_FPS,
      endSec: endFrame / H3_FPS,
    };
  });
  const fixFaces = h3FixFacesCount(opts.fixFaces);
  const speed = requestedH3Speed({ h3Speed: opts.h3Speed });
  const perWindow =
    ETA_WINDOW_480_TURBO8 *
    (windowFrames / H3_LONG_WINDOW_FRAMES) *
    (ETA_SPEED[speed] ?? 1) *
    (String(opts.resolution ?? "") === "768" ? ETA_768 : 1);
  const sampling = perWindow * windows.length;
  const faces =
    fixFaces *
    ETA_WINDOW_480_TURBO8 *
    (windowFrames / H3_LONG_WINDOW_FRAMES) *
    ETA_FACE_PER_WINDOW *
    windows.length;
  return {
    method,
    frames,
    seconds: frames / H3_FPS,
    latentT,
    windowFrames,
    overlapFrames,
    windows,
    segments: windows.length,
    fixFaces,
    etaSeconds: Math.round(ETA_OVERHEAD + sampling + faces),
  };
}

function formatEta(s: number): string {
  if (s < 90) return `${Math.max(10, Math.round(s / 10) * 10)} s`;
  return `${Math.round(s / 60)} min`;
}

/** One-line trade-off between the two long clip methods (picker help). */
export const H3_LONG_METHOD_TRADEOFF =
  "Chained: length not capped by memory, may drift at joins. Context windows: one smoother pass, length bounded by RAM/VRAM.";

/**
 * RAM for the decoded frames (ComfyUI IMAGE = float32 RGB), in GB. Fix faces
 * keeps about two more full-length copies per subject (stitch + clamp).
 */
export function h3LongDecodedGb(
  frames: number,
  size: { width: number; height: number },
  fixFaces = 0,
): number {
  const one = (frames * size.width * size.height * 3 * 4) / 1e9;
  return one * (1 + 2 * h3FixFacesCount(fixFaces));
}

/**
 * Slider help line: "3 segments (5.2 s each, 1.6 s overlap), 243 frames =
 * 10.1 s, about 4 min on a 24 GB GPU, ~1.2 GB RAM for decoded frames. ...".
 */
export function h3LongPlanHint(
  plan: H3LongPlan,
  size?: { width: number; height: number },
): string {
  const seg = plan.windowFrames / H3_FPS;
  const ov = plan.overlapFrames / H3_FPS;
  const parts = [
    `${plan.segments} segment${plan.segments === 1 ? "" : "s"} (${seg.toFixed(1)} s each, ${ov.toFixed(1)} s overlap)`,
    `${plan.frames} frames = ${plan.seconds.toFixed(1)} s`,
    `about ${formatEta(plan.etaSeconds)} on a 24 GB GPU`,
  ];
  if (size) {
    const gb = h3LongDecodedGb(plan.frames, size, plan.fixFaces);
    parts.push(`~${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB RAM for decoded frames`);
  }
  const tail =
    plan.method === "context"
      ? "Single pass over all windows, continuous sound."
      : "Windows chained in order, continuous sound.";
  return `${parts.join(", ")}. ${tail}`;
}

/**
 * Window-length help: VRAM per sampling step follows the window, not the
 * clip. Up to 124 frames matches a native single H3 clip, which fits 24 GB
 * at 768p; longer windows go past what H3 renders in one clip.
 */
export function h3LongWindowHint(
  windowFrames: unknown,
  resolution?: unknown,
): string {
  const f = h3LongWindowFrames(windowFrames);
  const secs = (f / H3_FPS).toFixed(1);
  const hi = String(resolution ?? "") === "768";
  const res = hi ? "768p" : "480p";
  if (f <= H3_LONG_WINDOW_FRAMES)
    return `${secs} s per window. VRAM per step is that of one ${secs} s ${res} clip (fits 24 GB). Shorter = less VRAM, more windows and joins.`;
  return hi
    ? `${secs} s per window, longer than H3's native 124-frame clip: at 768p this likely needs more than 24 GB VRAM; use 480p or 124 frames.`
    : `${secs} s per window, longer than H3's native 124-frame clip: more VRAM per step (480p is safest on 24 GB) and motion may loosen.`;
}

const H3_COND_NODES = ["MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"];

function findClass(workflow: Workflow, cls: string): string | undefined {
  return Object.keys(workflow).find((id) => workflow[id].class_type === cls);
}

function inputsOf(workflow: Workflow, id: string): Record<string, unknown> {
  return workflow[id].inputs as Record<string, unknown>;
}

const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2;

const linkTo = (v: unknown, id: string, slot = 0) =>
  isLink(v) && String(v[0]) === id && Number(v[1]) === slot;

function addNode(
  workflow: Workflow,
  classType: string,
  inputs: Record<string, unknown>,
  title?: string,
): string {
  const id = nextNodeId(workflow);
  workflow[id] = {
    class_type: classType,
    inputs,
    ...(title ? { _meta: { title } } : {}),
  } as Workflow[string];
  return id;
}

/** Frame count for a long clip request (null when params don't ask for one). */
export function h3LongClipFrames(
  params: Record<string, unknown>,
): number | null {
  if (params.longClip !== true) return null;
  return h3FramesForSeconds(h3LongSeconds(params.longSeconds));
}

/**
 * Make an H3 graph render a long clip in place: set the conditioning node's
 * length and insert the window node at the tail of the sampler's model chain
 * (after Turbo / extra LoRAs / SigmaShift). Sequential mode also routes the
 * text encoder through the window node so each window gets its own prompt
 * encoding. Returns the added node ids (empty when not requested or not H3).
 */
export function applyH3LongClip(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const frames = h3LongClipFrames(params);
  if (frames === null) return [];
  const condId = H3_COND_NODES.map((c) => findClass(workflow, c)).find(Boolean);
  const source = samplerModelSource(workflow);
  if (!condId || !source) return [];
  if (
    findClass(workflow, H3_CONTEXT_WINDOWS_NODE) ||
    findClass(workflow, H3_TEMPORAL_WINDOW_NODE)
  )
    return [];
  inputsOf(workflow, condId).length = frames;

  const method = h3LongMethod(params.longMethod);
  const windowFrames = h3LongWindowFrames(params.longWindow);
  const overlapFrames = h3LongOverlapFrames(
    params.longOverlap,
    method,
    windowFrames,
  );
  let windowId: string;
  if (method === "context") {
    windowId = addNode(
      workflow,
      H3_CONTEXT_WINDOWS_NODE,
      {
        model: [source, 0],
        context_length: windowFrames,
        context_overlap: overlapFrames,
        fuse_method: "pyramid",
        freenoise: true,
        split_conds_to_windows: false,
      },
      "Long clip: H3 context windows",
    );
  } else {
    const clip = inputsOf(workflow, condId).clip;
    windowId = addNode(
      workflow,
      H3_TEMPORAL_WINDOW_NODE,
      {
        model: [source, 0],
        temporal_windows: true,
        window_frames: windowFrames,
        overlap_frames: overlapFrames,
        carry_overlap: true,
        spatial_tiles: false,
        tile_width: 960,
        tile_height: 544,
        tile_overlap: 256,
        crop_ref_images_per_tile: true,
        ...(isLink(clip) ? { clip } : {}),
      },
      "Long clip: H3 temporal windows",
    );
    if (isLink(clip)) inputsOf(workflow, condId).clip = [windowId, 1];
  }
  // Only the sampler's model; BasicScheduler keeps the plain model (sigmas
  // only read model_sampling).
  for (const [id, node] of Object.entries(workflow)) {
    if (id === windowId) continue;
    if (
      !["BasicGuider", "CFGGuider", "KSampler", "KSamplerAdvanced"].includes(
        node.class_type,
      )
    )
      continue;
    const inputs = inputsOf(workflow, id);
    if (linkTo(inputs.model, source)) inputs.model = [windowId, 0];
  }
  return [windowId];
}

function consumersOf(
  workflow: Workflow,
  id: string,
  slot: number,
  cls: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [nid, node] of Object.entries(workflow)) {
    if (node.class_type !== cls) continue;
    for (const [k, v] of Object.entries(inputsOf(workflow, nid)))
      if (linkTo(v, id, slot)) out.push([nid, k]);
  }
  return out;
}

/**
 * Append the per-subject Fix faces passes between the video decode and
 * CreateVideo of a Ref2VA graph. Needs MiniMaxH3ReferenceToVideo (its refs
 * anchor identity), a guider, SamplerCustomAdvanced and CreateVideo. Returns
 * the added node ids (empty when off or the graph doesn't fit).
 */
export function applyH3FixFaces(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const subjects = h3FixFacesCount(params.fixFaces);
  if (!subjects) return [];
  const r2vId = findClass(workflow, "MiniMaxH3ReferenceToVideo");
  const createId = findClass(workflow, "CreateVideo");
  const samplerId = findClass(workflow, "SamplerCustomAdvanced");
  const guiderId = findClass(workflow, "BasicGuider");
  if (!r2vId || !createId || !samplerId || !guiderId) return [];
  const create = inputsOf(workflow, createId);
  const decodeLink = create.images;
  if (!isLink(decodeLink)) return [];
  const decodeId = String(decodeLink[0]);
  if (workflow[decodeId]?.class_type !== "VAEDecode") return [];
  const r2v = inputsOf(workflow, r2vId);
  const sampler = inputsOf(workflow, samplerId);
  const guider = inputsOf(workflow, guiderId);
  const audioLink = create.audio;
  if (!isLink(r2v.clip) || !isLink(r2v.vae) || !isLink(guider.model)) return [];

  const schedId = isLink(sampler.sigmas) ? String(sampler.sigmas[0]) : "";
  const sched =
    workflow[schedId]?.class_type === "BasicScheduler"
      ? inputsOf(workflow, schedId)
      : null;
  const steps = typeof sched?.steps === "number" ? sched.steps : 8;
  const added: string[] = [];
  const add = (
    cls: string,
    inputs: Record<string, unknown>,
    title?: string,
  ) => {
    const id = addNode(workflow, cls, inputs, title);
    added.push(id);
    return id;
  };

  const frames: [string, number] = [decodeId, 0];
  const sam3 = add(
    "CheckpointLoaderSimple",
    { ckpt_name: H3_FIX_FACES_SAM3 },
    "Fix faces: SAM 3.1",
  );
  const who = add(
    "CLIPTextEncode",
    { clip: [sam3, 1], text: "person" },
    "Fix faces: who (SAM text)",
  );
  const track = add(
    "SAM3_VideoTrack",
    {
      images: frames,
      model: [sam3, 0],
      conditioning: [who, 0],
      detection_threshold: 0.5,
      max_objects: subjects,
      detect_interval: 1,
    },
    "Fix faces: track people",
  );
  const sam = add(
    "SAMLoader",
    { model_name: H3_FIX_FACES_SAM, device_mode: "AUTO" },
    "Fix faces: SAM (face shape)",
  );
  const refs = Object.fromEntries(
    Object.entries(r2v).filter(
      ([k, v]) => k.startsWith("ref_images.") && isLink(v),
    ),
  );

  let base: [string, number] = frames;
  for (let k = 0; k < subjects; k++) {
    const n = k + 1;
    const raw = add(
      "SAM3_TrackToMask",
      { track_data: [track, 0], object_indices: String(k) },
      `Fix faces: person ${n} mask`,
    );
    const mask = add(
      "CJMaskTemporal",
      { mask: [raw, 0], mode: "max", radius: 2 },
      `Fix faces: person ${n} mask (steady)`,
    );
    const seed = add(
      "CJSubjectFaceSeed",
      {
        mask: [mask, 0],
        images: frames,
        min_area_frac: 0.002,
        seed_frame: "largest_mask",
        head_frac: 0.3,
      },
      `Fix faces: person ${n} face point`,
    );
    const crop = add(
      "H3FaceTrackCrop",
      {
        images: base,
        detector: H3_FIX_FACES_DETECTOR,
        confidence: 0.35,
        crop_factor: 3,
        canvas_width: 768,
        canvas_height: 768,
        canvas_mode: "auto_capped_768",
        smooth_window: 21,
        size_smooth_window: 51,
        smooth_method: "gaussian",
        size_mode: "per_frame",
        // No insightface weights on the box; the seed point + continuity hold
        // the subject and the mask clamp catches any swap.
        identity_track: false,
        select: "closest_to_xy",
        X: [seed, 0],
        Y: [seed, 1],
        frame_index: [seed, 2],
        fallback_detector: H3_FIX_FACES_FALLBACK,
        fallback_head_frac: 0.5,
      },
      `Fix faces: person ${n} track + crop`,
    );
    const cond = add(
      "MiniMaxH3ReferenceToVideo",
      {
        clip: r2v.clip,
        vae: r2v.vae,
        ...(isLink(r2v.audio_vae) ? { audio_vae: r2v.audio_vae } : {}),
        prompt: r2v.prompt,
        width: [crop, 4],
        height: [crop, 5],
        length: [crop, 6],
        ref_image_size: r2v.ref_image_size ?? "match",
        ...refs,
        ...(isLink(audioLink) ? { "ref_audios.ref_audio_0": audioLink } : {}),
      },
      `Fix faces: person ${n} refine conditioning`,
    );
    const inject = add(
      "H3InjectVideoLatent",
      { av_latent: [cond, 1], images: [crop, 0], vae: r2v.vae },
      `Fix faces: person ${n} encode crop`,
    );
    const perFrame = add(
      "H3PerFrameDenoise",
      {
        model: guider.model,
        av_latent: [inject, 0],
        transform: [crop, 1],
        denoise_multiplier_small_face: 1,
        denoise_multiplier_large_face: 0.35,
        scale_mode: "absolute_px",
        face_px_small: 30,
        face_px_large: 120,
        gamma: 1,
        smooth_frames: 9,
      },
      `Fix faces: person ${n} per-frame denoise`,
    );
    const sigmas = add(
      "BasicScheduler",
      {
        model: [perFrame, 2],
        scheduler: sched?.scheduler ?? "simple",
        steps,
        denoise: H3_FIX_FACES_DENOISE,
      },
      `Fix faces: person ${n} schedule`,
    );
    const g = add(
      "BasicGuider",
      { model: [perFrame, 2], conditioning: [cond, 0] },
      `Fix faces: person ${n} guider`,
    );
    const sample = add(
      "SamplerCustomAdvanced",
      {
        noise: sampler.noise,
        guider: [g, 0],
        sampler: sampler.sampler,
        sigmas: [sigmas, 0],
        latent_image: [perFrame, 0],
      },
      `Fix faces: person ${n} refine`,
    );
    const dec = add(
      "VAEDecode",
      { samples: [sample, 0], vae: r2v.vae },
      `Fix faces: person ${n} decode`,
    );
    const faceMask = add(
      "H3FaceMaskSAM",
      {
        crops: [crop, 0],
        sam_model: [sam, 0],
        transform: [crop, 1],
        threshold: 0.93,
        dilation: 0,
        temporal_smooth: 5,
      },
      `Fix faces: person ${n} face shape`,
    );
    const stitch = add(
      "H3FaceStitch",
      {
        base_images: base,
        refined_crops: [dec, 0],
        transform: [crop, 1],
        paste_region: "face_only",
        mask_dilation: 16,
        feather: 6,
        colour_match: 1,
        blend: 1,
        undetected_frames: "fade_out",
        feather_scales_with_crop: false,
        masks: [faceMask, 0],
      },
      `Fix faces: person ${n} stitch`,
    );
    const clamp = add(
      "CJMaskedFaceClamp",
      {
        base_images: base,
        polished_images: [stitch, 0],
        mask: [mask, 0],
        dilation_px: 16,
        feather_px: 12,
      },
      `Fix faces: person ${n} only inside their mask`,
    );
    base = [clamp, 0];
  }
  for (const [id, key] of consumersOf(workflow, decodeId, 0, "CreateVideo"))
    inputsOf(workflow, id)[key] = base;
  return added;
}
