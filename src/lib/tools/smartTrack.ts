/**
 * Smart select for VIDEO tools: click a subject on any frame (include /
 * exclude points), optionally add more "occurrences" on other frames where it
 * re-appears, and SAM 3.1 tracks it through the whole clip.
 *
 * Graph design (core comfy_extras.nodes_sam3 + one VHS node):
 *
 *   per occurrence at time t (prepared frame k = round(t * 24)):
 *     LoadVideo -> Video Slice(k/24) -> GetVideoComponents -> ImageFromBatch(0,1)
 *       -> SAM3_Detect(points in NATURAL pixels) -> MaskToImage
 *       -> ImageScale(prep w/h, crop center) -> ImageToMask = seed mask
 *     forward : ImageFromBatch(prep, k, 4096)        -> SAM3_VideoTrack(seed) -> TrackToMask  = frames k..end
 *     backward: ImageFromBatch(prep, 0, k+1) -> VHS_SelectImages("::-1")
 *               -> SAM3_VideoTrack(seed) -> TrackToMask -> VHS_SelectMasks("1::-1") = frames 0..k-1
 *     full    : MaskToImage x2 -> ImageBatch(backward, forward) -> ImageToMask
 *   occurrences: MaskComposite "add" (clamped to 0..1) = per-frame union.
 *
 * Why detect on the SOURCE frame: the clicks are in the clip's natural pixels,
 * and LabsH3PrepareVideo scales to cover then center-crops to the 32-px grid;
 * ImageScale(crop "center") crops to the target aspect then scales, the same
 * geometry, so the seed mask lands on the prepared frame without porting the
 * prep sizing rules. Why VHS for reversal: core ComfyUI has no batch-reverse
 * node; VideoHelperSuite's index syntax "::-1" is a
 * plain tensor index (no decode, no copy to disk). ImageFromBatch clamps its
 * index/length to the batch, so a click past the prepared window can never
 * index out of range (we still drop those occurrences up front).
 *
 * Everything is built into the tool's own graph (one prompt): the track runs on
 * exactly the frames the tool processes, so frame count / size / fps match by
 * construction and no mask artifact has to be stored or re-sampled.
 */
import type { Workflow } from "@/types";

export interface SmartTrackPoint {
  x: number;
  y: number;
}

export interface SmartTrackOccurrence {
  /** Seconds into the source clip. */
  t: number;
  positive: SmartTrackPoint[];
  negative: SmartTrackPoint[];
}

export type NodeRef = [string, number];

/** LabsH3PrepareVideo always resamples to 24 fps. */
export const SMART_TRACK_FPS = 24;
export const SMART_TRACK_MAX_OCCURRENCES = 8;
export const SMART_TRACK_MAX_POINTS = 24;
const MAX_COORD = 16384;
/** First node id used by the injected subgraph (pack graphs stay below 100). */
export const SMART_TRACK_ID_BASE = 900;
const PER_OCCURRENCE = 20;

export const SMART_TRACK_DETECT = {
  threshold: 0.5,
  refineIterations: 2,
};

/** Actions whose text-prompted SAM branch can be replaced by clicks. */
export const SMART_TRACK_ACTIONS = new Set([
  "video_object_remove",
  "video_remove_text",
  "video_object_swap",
  "person_remove",
  "video_lipsync",
  "video_bg_swap",
]);

/**
 * Seconds each action processes (mirrors VIDEO_REMOVE_SECONDS /
 * PERSON_REMOVE_MAX_SECONDS / VIDEO_LIPSYNC_MAX_SECONDS; kept here so the client picker doesn't pull the
 * graph builders in; a test pins them equal).
 */
export const SMART_TRACK_WINDOW_SECONDS: Record<string, number> = {
  video_object_remove: 3,
  video_remove_text: 3,
  video_object_swap: 3,
  person_remove: 5.2,
  // H3 masked edits (H3_MASKED_EDIT_SECONDS); cast_swap clicks per person.
  video_bg_swap: 5.2,
  cast_swap: 5.2,
  video_lipsync: 14.76,
};

export class SmartTrackError extends Error {}

function cleanPoints(raw: unknown): SmartTrackPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: SmartTrackPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = Number((p as SmartTrackPoint).x);
    const y = Number((p as SmartTrackPoint).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      x: Math.min(MAX_COORD, Math.max(0, Math.round(x))),
      y: Math.min(MAX_COORD, Math.max(0, Math.round(y))),
    });
    if (out.length >= SMART_TRACK_MAX_POINTS) break;
  }
  return out;
}

/**
 * Sanitize client-sent occurrences: ints in natural pixels, t >= 0, at least
 * one include point each, capped counts; same-frame occurrences are merged.
 * Garbage -> [] (the caller falls back to the text prompt).
 */
export function parseSmartTrack(raw: unknown): SmartTrackOccurrence[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { occurrences?: unknown }).occurrences)
      ? (raw as { occurrences: unknown[] }).occurrences
      : [];
  const byFrame = new Map<number, SmartTrackOccurrence>();
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const t = Number((o as SmartTrackOccurrence).t);
    if (!Number.isFinite(t) || t < 0 || t > 100_000) continue;
    const positive = cleanPoints((o as SmartTrackOccurrence).positive);
    const negative = cleanPoints((o as SmartTrackOccurrence).negative);
    if (positive.length === 0) continue;
    const k = frameIndexAt(t);
    const prev = byFrame.get(k);
    if (prev) {
      prev.positive = [...prev.positive, ...positive].slice(
        0,
        SMART_TRACK_MAX_POINTS,
      );
      prev.negative = [...prev.negative, ...negative].slice(
        0,
        SMART_TRACK_MAX_POINTS,
      );
    } else {
      byFrame.set(k, { t: k / SMART_TRACK_FPS, positive, negative });
    }
  }
  return [...byFrame.values()]
    .sort((a, b) => a.t - b.t)
    .slice(0, SMART_TRACK_MAX_OCCURRENCES);
}

export function hasSmartTrack(raw: unknown): boolean {
  return parseSmartTrack(raw).length > 0;
}

/** Prepared-frame index for a source time (24 fps grid). */
export function frameIndexAt(t: number, fps = SMART_TRACK_FPS): number {
  return Math.max(0, Math.round(t * fps));
}

/** SAM3_Detect positive/negative_coords format: JSON [{"x":int,"y":int}]. */
export function coordsJson(points: SmartTrackPoint[]): string {
  return JSON.stringify(
    points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
  );
}

/**
 * Map a click on a letterboxed (object-fit: contain) <video> to natural
 * pixels. `offsetX/Y` are relative to the element box. null = in the bars.
 */
export function clientToNatural(
  offsetX: number,
  offsetY: number,
  boxW: number,
  boxH: number,
  naturalW: number,
  naturalH: number,
): SmartTrackPoint | null {
  if (!(boxW > 0 && boxH > 0 && naturalW > 0 && naturalH > 0)) return null;
  const r = contentRect(boxW, boxH, naturalW, naturalH);
  const x = (offsetX - r.left) / r.scale;
  const y = (offsetY - r.top) / r.scale;
  if (x < 0 || y < 0 || x > naturalW || y > naturalH) return null;
  return {
    x: Math.min(naturalW - 1, Math.round(x)),
    y: Math.min(naturalH - 1, Math.round(y)),
  };
}

/** Displayed content box of an object-fit: contain media element. */
export function contentRect(
  boxW: number,
  boxH: number,
  naturalW: number,
  naturalH: number,
): { left: number; top: number; width: number; height: number; scale: number } {
  const scale = Math.min(boxW / naturalW, boxH / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return {
    left: (boxW - width) / 2,
    top: (boxH - height) / 2,
    width,
    height,
    scale,
  };
}

export interface SmartTrackGraphOptions {
  /** LoadVideo node (the untouched source clip, natural pixels). */
  sourceVideo: NodeRef;
  /** Prepared frame batch the tool processes (IMAGE). */
  frames: NodeRef;
  width: NodeRef | number;
  height: NodeRef | number;
  /** SAM 3.1 model (CheckpointLoaderSimple output 0). */
  samModel: NodeRef;
  occurrences: SmartTrackOccurrence[];
  fps?: number;
  idBase?: number;
}

/**
 * Add the click-tracking subgraph to `workflow` (mutates). Returns the
 * union MASK batch, one mask per prepared frame.
 */
export function addSmartTrackNodes(
  workflow: Workflow,
  opts: SmartTrackGraphOptions,
): NodeRef {
  const occ = opts.occurrences;
  if (occ.length === 0) throw new SmartTrackError("no smart-select clicks");
  const fps = opts.fps ?? SMART_TRACK_FPS;
  const base = opts.idBase ?? SMART_TRACK_ID_BASE;
  const add = (
    id: number,
    class_type: string,
    inputs: Record<string, unknown>,
  ) => {
    const key = String(id);
    if (workflow[key]) throw new SmartTrackError(`node id ${key} already used`);
    workflow[key] = {
      class_type,
      inputs,
      _meta: { title: `Smart select ${class_type}` },
    };
    return key;
  };

  const occurrenceMasks: NodeRef[] = occ.map((o, i) => {
    const b = base + i * PER_OCCURRENCE;
    const k = frameIndexAt(o.t, fps);
    const slice = add(b, "Video Slice", {
      video: opts.sourceVideo,
      start_time: k / fps,
      duration: 0.25,
      strict_duration: false,
    });
    const comps = add(b + 1, "GetVideoComponents", { video: [slice, 0] });
    const frame = add(b + 2, "ImageFromBatch", {
      image: [comps, 0],
      batch_index: 0,
      length: 1,
    });
    const detect = add(b + 3, "SAM3_Detect", {
      model: opts.samModel,
      image: [frame, 0],
      threshold: SMART_TRACK_DETECT.threshold,
      refine_iterations: SMART_TRACK_DETECT.refineIterations,
      individual_masks: false,
      positive_coords: coordsJson(o.positive),
      negative_coords: coordsJson(o.negative),
    });
    const dimg = add(b + 4, "MaskToImage", { mask: [detect, 0] });
    const scaled = add(b + 5, "ImageScale", {
      image: [dimg, 0],
      upscale_method: "bilinear",
      width: opts.width,
      height: opts.height,
      crop: "center",
    });
    const seed = add(b + 6, "ImageToMask", {
      image: [scaled, 0],
      channel: "red",
    });

    const track = (frames: NodeRef, id: number) => {
      const tr = add(id, "SAM3_VideoTrack", {
        images: frames,
        model: opts.samModel,
        detection_threshold: SMART_TRACK_DETECT.threshold,
        max_objects: 1,
        detect_interval: 1,
        initial_mask: [seed, 0],
      });
      return add(id + 1, "SAM3_TrackToMask", {
        track_data: [tr, 0],
        object_indices: "",
      });
    };

    const fwdFrames = add(b + 7, "ImageFromBatch", {
      image: opts.frames,
      batch_index: k,
      length: 4096,
    });
    const fwd = track([fwdFrames, 0], b + 8); // b+8, b+9
    if (k === 0) return [fwd, 0];

    const bwdFrames = add(b + 10, "ImageFromBatch", {
      image: opts.frames,
      batch_index: 0,
      length: k + 1,
    });
    const bwdRev = add(b + 11, "VHS_SelectImages", {
      image: [bwdFrames, 0],
      indexes: "::-1",
      err_if_missing: false,
      err_if_empty: true,
    });
    const bwd = track([bwdRev, 0], b + 12); // b+12, b+13
    // Backward masks are [k, k-1 .. 0]: drop frame k (forward has it), re-reverse.
    const bwdBack = add(b + 14, "VHS_SelectMasks", {
      mask: [bwd, 0],
      indexes: "1::-1",
      err_if_missing: false,
      err_if_empty: true,
    });
    const bImg = add(b + 15, "MaskToImage", { mask: [bwdBack, 0] });
    const fImg = add(b + 16, "MaskToImage", { mask: [fwd, 0] });
    const cat = add(b + 17, "ImageBatch", {
      image1: [bImg, 0],
      image2: [fImg, 0],
    });
    const full = add(b + 18, "ImageToMask", {
      image: [cat, 0],
      channel: "red",
    });
    return [full, 0];
  });

  let union = occurrenceMasks[0];
  const ub = base + SMART_TRACK_MAX_OCCURRENCES * PER_OCCURRENCE;
  for (let i = 1; i < occurrenceMasks.length; i++) {
    const id = add(ub + i, "MaskComposite", {
      destination: union,
      source: occurrenceMasks[i],
      x: 0,
      y: 0,
      operation: "add",
    });
    union = [id, 0];
  }
  return union;
}

/** Point every input that links to `from` at `to` instead. */
export function rewireLinks(
  workflow: Workflow,
  from: NodeRef,
  to: NodeRef,
): number {
  let n = 0;
  for (const node of Object.values(workflow)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v[0] === from[0] && v[1] === from[1]) {
        node.inputs[k] = [to[0], to[1]];
        n++;
      }
    }
  }
  return n;
}

/**
 * Keep only occurrences inside the processed window (the tool keeps the first
 * `maxSeconds` of the clip). Throws when clicks exist but all are outside.
 */
export function occurrencesInWindow(
  occ: SmartTrackOccurrence[],
  maxSeconds: number,
  action: string,
): SmartTrackOccurrence[] {
  const inside = occ.filter((o) => o.t <= maxSeconds + 0.5 / SMART_TRACK_FPS);
  if (occ.length > 0 && inside.length === 0)
    throw new SmartTrackError(
      `${action}: every smart-select click is after the first ${maxSeconds} s this tool processes; click the subject earlier in the clip`,
    );
  return inside;
}

/**
 * Replace a pack's text-prompted SAM branch with the click track.
 * `replace` = the MASK output the rest of the graph consumes (e.g. TrackToMask),
 * `remove` = the text-SAM nodes to drop (detect/track/track-to-mask).
 */
export function applySmartTrack(
  workflow: Workflow,
  opts: SmartTrackGraphOptions & { replace: NodeRef; remove: string[] },
): NodeRef {
  const mask = addSmartTrackNodes(workflow, opts);
  rewireLinks(workflow, opts.replace, mask);
  for (const id of opts.remove) delete workflow[id];
  return mask;
}

// Preview graphs (POST /api/tools/smart-track)

export const PREVIEW_FRAME_OUTPUT = "990";
export const PREVIEW_TRACK_OUTPUT = "1199";
export const PREVIEW_MASKS_OUTPUT = "1198";
export const SAM3_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors";

/** Single-frame detect at time t: mask PNG at the clip's natural size. */
export function buildFramePreviewWorkflow(
  videoRef: string,
  t: number,
  positive: SmartTrackPoint[],
  negative: SmartTrackPoint[],
): Workflow {
  if (positive.length === 0) throw new SmartTrackError("add an include point");
  const k = frameIndexAt(t);
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: SAM3_CHECKPOINT },
    },
    "2": { class_type: "LoadVideo", inputs: { file: videoRef } },
    "3": {
      class_type: "Video Slice",
      inputs: {
        video: ["2", 0],
        start_time: k / SMART_TRACK_FPS,
        duration: 0.25,
        strict_duration: false,
      },
    },
    "4": { class_type: "GetVideoComponents", inputs: { video: ["3", 0] } },
    "5": {
      class_type: "ImageFromBatch",
      inputs: { image: ["4", 0], batch_index: 0, length: 1 },
    },
    "6": {
      class_type: "SAM3_Detect",
      inputs: {
        model: ["1", 0],
        image: ["5", 0],
        threshold: SMART_TRACK_DETECT.threshold,
        refine_iterations: SMART_TRACK_DETECT.refineIterations,
        individual_masks: false,
        positive_coords: coordsJson(positive),
        negative_coords: coordsJson(negative),
      },
    },
    "7": { class_type: "MaskToImage", inputs: { mask: ["6", 0] } },
    [PREVIEW_FRAME_OUTPUT]: {
      class_type: "PreviewImage",
      inputs: { images: ["7", 0] },
    },
  };
}

/**
 * Full track preview on the same prepared frames the tools use
 * (LabsH3PrepareVideo 480, first `seconds`): an overlay video (subject tinted
 * red) plus the raw mask frames (for checks / tests).
 */
export function buildTrackPreviewWorkflow(
  videoRef: string,
  occurrences: SmartTrackOccurrence[],
  seconds: number,
  opts: { saveMasks?: boolean; prefix?: string } = {},
): Workflow {
  const wf: Workflow = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: SAM3_CHECKPOINT },
    },
    "2": { class_type: "LoadVideo", inputs: { file: videoRef } },
    "3": {
      class_type: "LabsH3PrepareVideo",
      inputs: { video: ["2", 0], resolution: "480", duration_seconds: seconds },
    },
  };
  const inside = occurrencesInWindow(occurrences, seconds, "preview");
  const mask = addSmartTrackNodes(wf, {
    sourceVideo: ["2", 0],
    frames: ["3", 0],
    width: ["3", 2],
    height: ["3", 3],
    samModel: ["1", 0],
    occurrences: inside,
  });
  const prefix = opts.prefix ?? "smarttrack/preview";
  wf["1190"] = {
    class_type: "EmptyImage",
    inputs: {
      width: ["3", 2],
      height: ["3", 3],
      batch_size: 1,
      color: 0xff3030,
    },
  };
  wf["1191"] = {
    class_type: "ImageCompositeMasked",
    inputs: {
      destination: ["3", 0],
      source: ["1190", 0],
      x: 0,
      y: 0,
      resize_source: false,
      mask,
    },
  };
  wf["1192"] = {
    class_type: "ImageBlend",
    inputs: {
      image1: ["3", 0],
      image2: ["1191", 0],
      blend_factor: 0.55,
      blend_mode: "normal",
    },
  };
  // Prepared frames are padded to the 17n+5 window: trim to the real count.
  wf["1193"] = {
    class_type: "ImageFromBatch",
    inputs: { image: ["1192", 0], batch_index: 0, length: ["3", 5] },
  };
  wf["1194"] = {
    class_type: "CreateVideo",
    inputs: { images: ["1193", 0], fps: ["3", 6] },
  };
  wf[PREVIEW_TRACK_OUTPUT] = {
    class_type: "SaveVideo",
    inputs: {
      video: ["1194", 0],
      filename_prefix: prefix,
      format: "auto",
      codec: "auto",
    },
  };
  if (opts.saveMasks) {
    wf["1195"] = { class_type: "MaskToImage", inputs: { mask } };
    wf[PREVIEW_MASKS_OUTPUT] = {
      class_type: "SaveImage",
      inputs: { images: ["1195", 0], filename_prefix: `${prefix}_mask` },
    };
  }
  return wf;
}
