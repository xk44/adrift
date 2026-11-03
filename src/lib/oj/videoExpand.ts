/**
 * "Expand video" / zoom out: video outpainting, core ComfyUI nodes only, with
 * two engines (params.engine):
 *
 * - "ltx" (DEFAULT, packs/ltx25/video_expand.json): distilled LTX-2.5 22B +
 *   oumoumad's IC-LoRA Outpaint. The first VIDEO_EXPAND_LTX_MAX_FRAMES source
 *   frames (native fps) are trimmed to the largest 8n+1 and scaled into a
 *   PURE BLACK canvas (black = the LoRA's "generate here" sentinel), long edge
 *   1024 (or 1280), multiples of 32. The guided generation is upscaled to
 *   the expanded output size and the ORIGINAL frames are composited back
 *   with a wide feather (the regenerated centre matches the source closely,
 *   so the seam is invisible). Anything that does not say "wan" gets LTX.
 * - "wan" (EXPERIMENTAL, packs/wan22/video_expand.json): Wan2.2 Fun VACE 14B.
 *   The source is padded with neutral grey in a ~480p VACE canvas, the pad
 *   mask is the only area VACE invents, then the same upscale + pasteback
 *   with a short feather. It leaves a dark halo / flat border;
 *   kept selectable only, never picked automatically.
 *
 * Both keep the source fps + audio and cap the expanded frame at
 * VIDEO_EXPAND_MAX_EDGE (larger sources are scaled down first, node 23).
 *
 * VACE geometry (videoExpandPlan): the VACE canvas has the target aspect at
 * the pixel budget of the other VACE tools (832x480, long edge ≤ 1280), the
 * source rect in it is a multiple of 16 (an unaligned fit leaves a washed
 * seam), the pads multiples of 8; the output pads are derived from the
 * canvas pads so the generated border lines up with the composited original.
 * LTX geometry (videoExpandLtxPlan): same idea on a /32 canvas, the source
 * rect keeps the source aspect (even sizes, any position).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { VACE_REFRAME_SUFFIX, applyVaceSpeed, vaceSpeed } from "./vaceVideo";

export const VIDEO_EXPAND_ACTION = "video_expand";

export type VideoExpandEngine = "ltx" | "wan";
export const VIDEO_EXPAND_DEFAULT_ENGINE: VideoExpandEngine = "ltx";
/** Picker order = UI order; the first is the default. */
export const VIDEO_EXPAND_ENGINES: Record<
  VideoExpandEngine,
  { label: string; template: string; experimental: boolean }
> = {
  ltx: {
    label: "LTX-2.5 Outpaint",
    template: "video_expand",
    experimental: false,
  },
  wan: {
    label: "Wan2.2 VACE (experimental)",
    template: "video_expand_wan",
    experimental: true,
  },
};

/** Only an explicit "wan" selects VACE; anything else (unset too) is LTX. */
export function videoExpandEngine(value: unknown): VideoExpandEngine {
  return value === "wan" ? "wan" : VIDEO_EXPAND_DEFAULT_ENGINE;
}

/** Registry template of the engine's graph (action route lookup). */
export function videoExpandTemplate(engine: unknown): string {
  return VIDEO_EXPAND_ENGINES[videoExpandEngine(engine)].template;
}

/** Frames kept from the start of the clip (native fps; VACE window 81). */
export const VIDEO_EXPAND_VACE_MAX_FRAMES = 81;
/** LTX: frames read from the start (native fps), then trimmed to 8n+1. */
export const VIDEO_EXPAND_LTX_MAX_FRAMES = 121;
/** The same window in seconds at 24 fps (121 / 24 ≈ 5); UI copy only. */
export const VIDEO_EXPAND_LTX_WINDOW_SECONDS = 5;
/** LTX canvas long edge (px, /32); 1280 is an opt-in (more VRAM). */
export const VIDEO_EXPAND_LTX_EDGES = [1024, 1280] as const;
export const VIDEO_EXPAND_LTX_DEFAULT_EDGE = 1024;
/** LTX pasteback feather (px at output scale), padded sides only. */
export const VIDEO_EXPAND_LTX_FEATHER = 48;
export const VIDEO_EXPAND_LTX_DEFAULT_PROMPT =
  "the same scene, wider shot, more of the surrounding environment, consistent lighting";
/** Appended to the scene description for the LTX engine. */
export const VIDEO_EXPAND_LTX_WIDE_SUFFIX =
  "A wider shot of the same scene shows more of the surroundings, consistent lighting and camera motion.";
export const VIDEO_EXPAND_LTX_NEGATIVE =
  "black bars, letterbox, border, frame, text, watermark, blurry, distorted, jitter, worst quality";
export const VIDEO_EXPAND_LTX_LORA =
  "ltx25/ltx-2.3-22b-ic-lora-outpaint.safetensors";

export function videoExpandLtxEdge(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return (VIDEO_EXPAND_LTX_EDGES as readonly unknown[]).includes(n)
    ? (n as number)
    : VIDEO_EXPAND_LTX_DEFAULT_EDGE;
}
/** Longest edge of the expanded output; larger sources are scaled down first. */
export const VIDEO_EXPAND_MAX_EDGE = 2560;
/** Pan modes extend one side by this fraction of the source dimension. */
export const VIDEO_EXPAND_PAN = 0.5;

export const VIDEO_EXPAND_DEFAULT_PROMPT =
  "Continue the scene naturally beyond the frame edges, seamless extension of the same environment, consistent lighting, cinematic.";

/** Fixed node ids in packs/wan22/video_expand.json. */
export const VEX_NODES = {
  loraHi: "5",
  shiftHi: "7",
  pos: "9",
  neg: "10",
  vace: "11",
  hi: "12",
  lo: "13",
  trim: "16",
  load: "20",
  crop: "21",
  parts: "22",
  cap: "23",
  /** GetImageSize of the raw clip (size + frame count). */
  size: "24",
  genScale: "30",
  pad: "31",
  outW: "42",
  outH: "43",
  offX: "44",
  offY: "45",
  capW: "46",
  capH: "47",
  /** GetImageSize of the fitted frames (added by the builder). */
  fitSize: "48",
  keep: "50",
  feather: "51",
  outScale: "52",
  composite: "53",
} as const;

const NODE_CLASSES: Record<string, string> = {
  [VEX_NODES.loraHi]: "LoraLoaderModelOnly",
  [VEX_NODES.shiftHi]: "ModelSamplingSD3",
  [VEX_NODES.pos]: "CLIPTextEncode",
  [VEX_NODES.vace]: "WanVaceToVideo",
  [VEX_NODES.hi]: "KSamplerAdvanced",
  [VEX_NODES.lo]: "KSamplerAdvanced",
  [VEX_NODES.load]: "LoadVideo",
  [VEX_NODES.crop]: "VideoTemporalCrop",
  [VEX_NODES.parts]: "GetVideoComponents",
  [VEX_NODES.size]: "GetImageSize",
  [VEX_NODES.genScale]: "ImageScale",
  [VEX_NODES.pad]: "ImagePadForOutpaint",
  [VEX_NODES.outW]: "ComfyMathExpression",
  [VEX_NODES.outH]: "ComfyMathExpression",
  [VEX_NODES.keep]: "SolidMask",
  [VEX_NODES.feather]: "FeatherMask",
  [VEX_NODES.outScale]: "ImageScale",
  [VEX_NODES.composite]: "ImageCompositeMasked",
};

type Sides = { left: number; top: number; right: number; bottom: number };

/** Expansion per side as a fraction of the source width/height. */
type Mode =
  | { label: string; group: string; sides: Sides }
  | {
      label: string;
      group: string;
      aspect: number;
    };

const zoom = (f: number): Sides => {
  const s = (f - 1) / 2;
  return { left: s, top: s, right: s, bottom: s };
};
const none: Sides = { left: 0, top: 0, right: 0, bottom: 0 };
const P = VIDEO_EXPAND_PAN;

export const VIDEO_EXPAND_MODES: Record<string, Mode> = {
  // First entry = the Tools-page default.
  zoom_1_5: { label: "Zoom out 1.5×", group: "Zoom out", sides: zoom(1.5) },
  zoom_1_25: { label: "Zoom out 1.25×", group: "Zoom out", sides: zoom(1.25) },
  zoom_2: { label: "Zoom out 2×", group: "Zoom out", sides: zoom(2) },
  pan_left: {
    label: "Extend left",
    group: "Extend one side",
    sides: { ...none, left: P },
  },
  pan_right: {
    label: "Extend right",
    group: "Extend one side",
    sides: { ...none, right: P },
  },
  pan_up: {
    label: "Extend up",
    group: "Extend one side",
    sides: { ...none, top: P },
  },
  pan_down: {
    label: "Extend down",
    group: "Extend one side",
    sides: { ...none, bottom: P },
  },
  aspect_16_9: {
    label: "Widen to 16:9",
    group: "Change aspect",
    aspect: 16 / 9,
  },
  aspect_9_16: { label: "Tall 9:16", group: "Change aspect", aspect: 9 / 16 },
  aspect_1_1: { label: "Square 1:1", group: "Change aspect", aspect: 1 },
  aspect_4_5: { label: "Portrait 4:5", group: "Change aspect", aspect: 4 / 5 },
};

export const VIDEO_EXPAND_DEFAULT_MODE = "zoom_1_5";

export function videoExpandMode(value: unknown): string {
  return typeof value === "string" && value in VIDEO_EXPAND_MODES
    ? value
    : VIDEO_EXPAND_DEFAULT_MODE;
}

export interface VideoExpandPlan {
  /** Source frame size fed to the graph (after the cap downscale). */
  srcWidth: number;
  srcHeight: number;
  /** True when the source is scaled down to keep the output ≤ max edge. */
  downscaled: boolean;
  /** Expanded output: size + where the original sits. */
  out: Sides & { width: number; height: number };
  /** VACE canvas, source rect inside it, grey pads (multiples of 8). */
  gen: Sides & {
    width: number;
    height: number;
    srcWidth: number;
    srcHeight: number;
  };
  /** Feather ramp (px, inside the original) on padded sides only. */
  feather: Sides;
}

const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
/** Same pixel budget as the 832x480 VACE tools, long edge ≤ 1280. */
export const VIDEO_EXPAND_GEN_AREA = 832 * 480;
const GEN_MAX_EDGE = 1280;

/** VACE canvas with the target aspect (multiples of 16). */
export function videoExpandCanvas(
  width: number,
  height: number,
): { width: number; height: number } {
  const a = width / height;
  let w = Math.sqrt(VIDEO_EXPAND_GEN_AREA * a);
  let h = w / a;
  const k = Math.min(1, GEN_MAX_EDGE / Math.max(w, h));
  w *= k;
  h *= k;
  return { width: round16(w), height: round16(h) };
}

const positive = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.round(v)
    : fallback;

const SAME_ASPECT = "The clip already has this aspect ratio; pick another one.";

/**
 * Why a mode can't run on a clip of this size (null = fine). The Tools
 * picker disables such options before submit; the builder throws the same.
 */
export function videoExpandModeIssue(
  modeId: string,
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  const mode = VIDEO_EXPAND_MODES[modeId];
  if (!mode || "sides" in mode || !width || !height) return null;
  return Math.abs(width / height - mode.aspect) / mode.aspect < 0.03
    ? SAME_ASPECT
    : null;
}

function sidesFor(mode: Mode, sw: number, sh: number): Sides {
  if ("sides" in mode) return mode.sides;
  const a = sw / sh;
  if (Math.abs(a - mode.aspect) / mode.aspect < 0.03) {
    throw new Error(`${VIDEO_EXPAND_ACTION}: ${SAME_ASPECT}`);
  }
  if (a < mode.aspect) {
    const s = (mode.aspect / a - 1) / 2;
    return { left: s, right: s, top: 0, bottom: 0 };
  }
  const s = (a / mode.aspect - 1) / 2;
  return { left: 0, right: 0, top: s, bottom: s };
}

/**
 * Split `total` px between two sides by weight, on a `grid` (8 for the VACE
 * pads, 1 for LTX). One-sided growth puts all of it on that side.
 */
export function splitSides(
  total: number,
  a: number,
  b: number,
  grid = 1,
): [number, number] {
  if (total <= 0) return [0, 0];
  if (a <= 0) return [0, total];
  if (b <= 0) return [total, 0];
  const first = Math.round((total * a) / (a + b) / grid) * grid;
  return [first, total - first];
}

type Gen = VideoExpandPlan["gen"];
/** Canvas + source rect for the (nominal) source size and the mode's sides. */
type GenLayout = (sw: number, sh: number, sides: Sides, fx: number, fy: number) => Gen;

/** VACE (wan) geometry: ~480p canvas, 16-px source rect, 8-px pads. */
export function videoExpandPlan(
  srcWidth: number | undefined,
  srcHeight: number | undefined,
  modeId: unknown,
): VideoExpandPlan {
  return planFor(srcWidth, srcHeight, modeId, vaceGen, (sw, sh) =>
    Math.min(16, Math.max(4, Math.round(Math.min(sw, sh) / 90))),
  );
}

/**
 * LTX geometry: canvas at the expanded aspect with a long edge of `edge`
 * (multiples of 32); `gen.srcWidth/srcHeight` is the source rect on it (even
 * sizes, source aspect), `gen.left/top/...` the black bars around it.
 */
export function videoExpandLtxPlan(
  srcWidth: number | undefined,
  srcHeight: number | undefined,
  modeId: unknown,
  edge: number = VIDEO_EXPAND_LTX_DEFAULT_EDGE,
): VideoExpandPlan {
  const e = videoExpandLtxEdge(edge);
  return planFor(
    srcWidth,
    srcHeight,
    modeId,
    (sw, sh, sides, fx, fy) => ltxGen(sw, sh, sides, fx, fy, e),
    // Wide feather (the regenerated centre closely matches the source).
    (sw, sh) =>
      Math.min(
        VIDEO_EXPAND_LTX_FEATHER,
        Math.max(4, Math.floor(Math.min(sw, sh) / 6)),
      ),
  );
}

/**
 * Source size after the cap: even, and small enough that the expanded frame
 * stays ≤ VIDEO_EXPAND_MAX_EDGE. Mirrored in-graph by capExpressions (same
 * float maths in the same order, so both give the same numbers).
 */
export function videoExpandCapSize(
  sw: number,
  sh: number,
  gen: Gen,
): { width: number; height: number; scaled: boolean } {
  const L = VIDEO_EXPAND_MAX_EDGE;
  const k = Math.min(
    1,
    (L * gen.srcWidth) / (sw * gen.width),
    (L * gen.srcHeight) / (sh * gen.height),
  );
  return {
    width: 2 * Math.trunc((sw * k) / 2),
    height: 2 * Math.trunc((sh * k) / 2),
    scaled: k < 1,
  };
}

/**
 * Output frame for a (capped, even) source size. Mirrored in-graph by
 * pastebackExpressions, so the paste-back follows the frames the graph
 * actually decodes even when the run's recorded size is wrong.
 */
export function videoExpandOutput(
  sw: number,
  sh: number,
  gen: Gen,
): VideoExpandPlan["out"] {
  const axis = (s: number, c: number, g: number, lead: number, trail: number) => {
    const size = g === c ? s : 2 * Math.floor((s * c + g) / (2 * g));
    const off = !lead
      ? 0
      : !trail
        ? size - s
        : Math.floor((2 * lead * size + c) / (2 * c));
    return [size, off];
  };
  const [width, left] = axis(sw, gen.width, gen.srcWidth, gen.left, gen.right);
  const [height, top] = axis(sh, gen.height, gen.srcHeight, gen.top, gen.bottom);
  return {
    width,
    height,
    left,
    top,
    right: width - sw - left,
    bottom: height - sh - top,
  };
}

function planFor(
  srcWidth: number | undefined,
  srcHeight: number | undefined,
  modeId: unknown,
  genLayout: GenLayout,
  featherPx: (sw: number, sh: number) => number,
): VideoExpandPlan {
  const mode = VIDEO_EXPAND_MODES[videoExpandMode(modeId)];
  const sw0 = positive(srcWidth, 1280);
  const sh0 = positive(srcHeight, 720);
  const sides = sidesFor(mode, sw0, sh0);
  const fx = 1 + sides.left + sides.right;
  const fy = 1 + sides.top + sides.bottom;
  // The canvas depends only on the aspect; the output on the real size.
  const gen = genLayout(sw0, sh0, sides, fx, fy);
  const cap = videoExpandCapSize(sw0, sh0, gen);
  const f = featherPx(cap.width, cap.height);
  return {
    srcWidth: cap.width,
    srcHeight: cap.height,
    downscaled: cap.scaled,
    out: videoExpandOutput(cap.width, cap.height, gen),
    gen,
    feather: {
      left: gen.left ? f : 0,
      top: gen.top ? f : 0,
      right: gen.right ? f : 0,
      bottom: gen.bottom ? f : 0,
    },
  };
}

function vaceGen(sw: number, sh: number, sides: Sides, fx: number, fy: number): Gen {
  // VACE canvas for the target aspect; source rect on the 16-px grid.
  const canvas = videoExpandCanvas(sw * fx, sh * fy);
  // A non-expanded axis spans the whole canvas; when only one axis grows,
  // its size follows the source aspect so the source is not squashed.
  const fitW = (v: number) => Math.min(canvas.width - 16, round16(v));
  const fitH = (v: number) => Math.min(canvas.height - 16, round16(v));
  let gw = canvas.width;
  let gh = canvas.height;
  if (fx > 1 && fy > 1) {
    gw = fitW(canvas.width / fx);
    gh = fitH(canvas.height / fy);
  } else if (fx > 1) {
    gw = fitW((canvas.height * sw) / sh);
  } else if (fy > 1) {
    gh = fitH((canvas.width * sh) / sw);
  }
  const [left, right] = splitSides(canvas.width - gw, sides.left, sides.right, 8);
  const [top, bottom] = splitSides(canvas.height - gh, sides.top, sides.bottom, 8);
  return { ...canvas, srcWidth: gw, srcHeight: gh, left, top, right, bottom };
}

const round32 = (v: number) => Math.max(64, Math.round(v / 32) * 32);

/** LTX canvas (/32) with the expanded aspect and the given long edge. */
export function videoExpandLtxCanvas(
  width: number,
  height: number,
  edge: number = VIDEO_EXPAND_LTX_DEFAULT_EDGE,
): { width: number; height: number } {
  const a = width / height;
  return a >= 1
    ? { width: round32(edge), height: round32(edge / a) }
    : { width: round32(edge * a), height: round32(edge) };
}

function ltxGen(
  sw: number,
  sh: number,
  sides: Sides,
  fx: number,
  fy: number,
  edge: number,
): Gen {
  const canvas = videoExpandLtxCanvas(sw * fx, sh * fy, edge);
  // Source rect: keeps the source aspect; a non-expanded axis spans the
  // whole canvas. At least 2 px of black on every expanded side pair.
  let gw = canvas.width;
  let gh = canvas.height;
  if (fy > 1) {
    gh = Math.min(
      canvas.height - 2,
      fx > 1 ? even(canvas.height / fy) : even((canvas.width * sh) / sw),
    );
  }
  if (fx > 1) gw = Math.min(canvas.width - 2, even((gh * sw) / sh));
  const [left, right] = splitSides(canvas.width - gw, sides.left, sides.right);
  const [top, bottom] = splitSides(canvas.height - gh, sides.top, sides.bottom);
  return { ...canvas, srcWidth: gw, srcHeight: gh, left, top, right, bottom };
}

/** In-graph mirror of videoExpandCapSize (a = width, b = height). */
export function capExpressions(gen: Gen): { width: string; height: string } {
  const L = VIDEO_EXPAND_MAX_EDGE;
  const k = `min(1, ${L} * ${gen.srcWidth} / (a * ${gen.width}), ${L} * ${gen.srcHeight} / (b * ${gen.height}))`;
  return {
    width: `2 * int(a * ${k} / 2)`,
    height: `2 * int(b * ${k} / 2)`,
  };
}

/**
 * In-graph mirror of videoExpandOutput: `size` takes a = source size on
 * that axis; `offset` takes a = source size, b = output size (null = 0).
 */
export function pastebackExpressions(gen: Gen): {
  outW: string;
  outH: string;
  x: string | null;
  y: string | null;
} {
  const size = (c: number, g: number) =>
    g === c ? "a" : `2 * ((a * ${c} + ${g}) // ${2 * g})`;
  const off = (c: number, lead: number, trail: number) =>
    !lead ? null : !trail ? "b - a" : `(${2 * lead} * b + ${c}) // ${2 * c}`;
  return {
    outW: size(gen.width, gen.srcWidth),
    outH: size(gen.height, gen.srcHeight),
    x: off(gen.width, gen.left, gen.right),
    y: off(gen.height, gen.top, gen.bottom),
  };
}

/** Node ids the shared fit / paste-back wiring writes into. */
interface FitIds {
  /** Raw decoded frames ([id, 0]) and their GetImageSize node. */
  raw: [string, number];
  rawSize: string;
  cap: string;
  capW: string;
  capH: string;
  /** GetImageSize of the capped frames. */
  size: string;
  outW: string;
  outH: string;
  offX: string;
  offY: string;
  keep: string;
  feather: string;
  composite: string;
}

/**
 * Fit the decoded frames (even size, expanded frame ≤ cap) and paste them
 * back over the upscaled generation. Everything that depends on the real
 * frame size is computed in-graph, so a run whose recorded width/height is
 * wrong (uploads, upscaled or rotated clips) still pastes back centred.
 */
function wireFitAndPasteback(
  workflow: Workflow,
  ids: FitIds,
  plan: VideoExpandPlan,
): [string, number] {
  const math = (id: string, expression: string, a: unknown, b?: unknown, title?: string) => {
    workflow[id] = {
      class_type: "ComfyMathExpression",
      inputs: {
        expression,
        "values.a": a,
        ...(b === undefined ? {} : { "values.b": b }),
      },
      ...(title ? { _meta: { title } } : {}),
    } as Workflow[string];
  };
  const cap = capExpressions(plan.gen);
  math(ids.capW, cap.width, [ids.rawSize, 0], [ids.rawSize, 1], "Fit width");
  math(ids.capH, cap.height, [ids.rawSize, 0], [ids.rawSize, 1], "Fit height");
  workflow[ids.cap] = {
    class_type: "ImageScale",
    inputs: {
      image: ids.raw,
      upscale_method: "area",
      width: [ids.capW, 1],
      height: [ids.capH, 1],
      crop: "disabled",
    },
    _meta: {
      title: `Fit source (even size, expanded frame ≤ ${VIDEO_EXPAND_MAX_EDGE} px)`,
    },
  } as Workflow[string];
  const fitted: [string, number] = [ids.cap, 0];
  if (workflow[ids.size]) {
    setNodeInput(workflow, ids.size, "image", fitted);
  } else {
    workflow[ids.size] = {
      class_type: "GetImageSize",
      inputs: { image: fitted },
      _meta: { title: "Fitted source size" },
    } as Workflow[string];
  }

  const pb = pastebackExpressions(plan.gen);
  setNodeInput(workflow, ids.outW, "expression", pb.outW);
  setNodeInput(workflow, ids.outH, "expression", pb.outH);
  setNodeInput(workflow, ids.outW, "values.a", [ids.size, 0]);
  setNodeInput(workflow, ids.outH, "values.a", [ids.size, 1]);
  for (const side of ["left", "top", "right", "bottom"] as const) {
    setNodeInput(workflow, ids.feather, side, plan.feather[side]);
  }
  setNodeInput(workflow, ids.keep, "value", 1);
  setNodeInput(workflow, ids.keep, "width", [ids.size, 0]);
  setNodeInput(workflow, ids.keep, "height", [ids.size, 1]);
  setNodeInput(workflow, ids.composite, "source", fitted);
  setNodeInput(workflow, ids.composite, "resize_source", false);
  for (const [axis, id, expr, i, out] of [
    ["x", ids.offX, pb.x, 0, ids.outW],
    ["y", ids.offY, pb.y, 1, ids.outH],
  ] as const) {
    if (expr) {
      math(id, expr, [ids.size, i], [out, 1], `Paste-back ${axis}`);
      setNodeInput(workflow, ids.composite, axis, [id, 1]);
    } else {
      delete workflow[id];
      setNodeInput(workflow, ids.composite, axis, 0);
    }
  }
  return fitted;
}

function promptFor(sourceRun: ImagineRun, params: Record<string, unknown>) {
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
  const own = clean(params.prompt);
  // A seed-upload run's prompt is the tool title, not a scene description.
  const fromSource = sourceRun.params?.seed_upload
    ? ""
    : clean(sourceRun.parsedPrompt || sourceRun.prompt);
  const scene = own || fromSource;
  return scene
    ? `${scene.replace(/[.\s]+$/, "")}. ${VACE_REFRAME_SUFFIX}`
    : VIDEO_EXPAND_DEFAULT_PROMPT;
}

/**
 * LTX outpaint prompt. The IC-LoRA needs a description of what is in the
 * shot: the generic default left the black canvas
 * untouched, while a scene description filled it seamlessly. So the user's
 * text, else the source run's prompt, is followed by the wide-shot phrasing;
 * the bare default is only a last resort.
 */
export function ltxPromptFor(
  sourceRun: Pick<ImagineRun, "params" | "parsedPrompt" | "prompt">,
  params: Record<string, unknown>,
): string {
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
  const scene =
    clean(params.prompt) ||
    (sourceRun.params?.seed_upload ? "" : clean(sourceRun.parsedPrompt || sourceRun.prompt));
  return scene
    ? `${scene.replace(/[.\s]+$/, "")}. ${VIDEO_EXPAND_LTX_WIDE_SUFFIX}`
    : VIDEO_EXPAND_LTX_DEFAULT_PROMPT;
}

/** Node ids in packs/ltx25/video_expand.json. */
export const VEX_LTX_NODES = {
  lora: "2",
  pos: "7",
  neg: "8",
  cond: "9",
  latent: "10",
  guide: "11",
  audioLatent: "12",
  noise: "14",
  load: "20",
  crop: "21",
  parts: "22",
  count: "26",
  frames: "27",
  cap: "23",
  /** GetImageSize of the clip (frame count + raw size). */
  rawSize: "24",
  audioCrop: "28",
  audio: "29",
  innerScale: "30",
  canvas: "31",
  guideImage: "32",
  size: "35",
  decode: "40",
  outW: "42",
  outH: "43",
  offX: "44",
  offY: "45",
  capW: "46",
  capH: "47",
  keep: "50",
  feather: "51",
  genScale: "52",
  composite: "53",
  create: "54",
  save: "55",
} as const;

const LTX_NODE_CLASSES: Record<string, string> = {
  [VEX_LTX_NODES.lora]: "LoraLoaderModelOnly",
  [VEX_LTX_NODES.pos]: "CLIPTextEncode",
  [VEX_LTX_NODES.neg]: "CLIPTextEncode",
  [VEX_LTX_NODES.cond]: "LTXVConditioning",
  [VEX_LTX_NODES.latent]: "EmptyLTXVLatentVideo",
  [VEX_LTX_NODES.guide]: "LTXVAddGuide",
  [VEX_LTX_NODES.audioLatent]: "LTXVEmptyLatentAudio",
  [VEX_LTX_NODES.noise]: "RandomNoise",
  [VEX_LTX_NODES.load]: "LoadVideo",
  [VEX_LTX_NODES.crop]: "VideoTemporalCrop",
  [VEX_LTX_NODES.parts]: "GetVideoComponents",
  [VEX_LTX_NODES.count]: "ComfyMathExpression",
  [VEX_LTX_NODES.frames]: "ImageFromBatch",
  [VEX_LTX_NODES.audioCrop]: "VideoTemporalCrop",
  [VEX_LTX_NODES.audio]: "GetVideoComponents",
  [VEX_LTX_NODES.innerScale]: "ImageScale",
  [VEX_LTX_NODES.canvas]: "EmptyImage",
  [VEX_LTX_NODES.guideImage]: "ImageCompositeMasked",
  [VEX_LTX_NODES.size]: "GetImageSize",
  [VEX_LTX_NODES.decode]: "VAEDecodeTiled",
  [VEX_LTX_NODES.outW]: "ComfyMathExpression",
  [VEX_LTX_NODES.outH]: "ComfyMathExpression",
  [VEX_LTX_NODES.keep]: "SolidMask",
  [VEX_LTX_NODES.feather]: "FeatherMask",
  [VEX_LTX_NODES.genScale]: "ImageScale",
  [VEX_LTX_NODES.composite]: "ImageCompositeMasked",
  [VEX_LTX_NODES.create]: "CreateVideo",
  [VEX_LTX_NODES.save]: "SaveVideo",
};

/** 8n+1 frame count (the pack computes it from the clip; mirrored here). */
export function videoExpandLtxFrames(frames: number): number {
  const n = Math.min(Math.floor(frames), VIDEO_EXPAND_LTX_MAX_FRAMES);
  return n < 1 ? 1 : 8 * Math.floor((n - 1) / 8) + 1;
}

function checkClasses(
  workflow: Workflow,
  classes: Record<string, string>,
  engine: VideoExpandEngine,
) {
  for (const [id, cls] of Object.entries(classes)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(
        `${VIDEO_EXPAND_ACTION} (${engine}): workflow node ${id} must be ${cls}`,
      );
    }
  }
}

/** Optional first frame of the window (params.start_frame, ≥ 0 integer). */
export function videoExpandStartFrame(value: unknown): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), 1_000_000)
    : 0;
}

function seedFrom(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? params.seed
    : Math.floor(Math.random() * 2 ** 32);
}

/**
 * Video Expand graph for the chosen engine. LTX-2.5 + IC-LoRA Outpaint is
 * the default (also when `params.engine` is missing or unknown); Wan2.2 VACE
 * only runs on an explicit `engine: "wan"` (experimental).
 */
export function buildVideoExpandWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  return videoExpandEngine(params.engine) === "wan"
    ? buildVideoExpandWanWorkflow(baseWorkflow, sourceRun, sourceJobIndex, params)
    : buildVideoExpandLtxWorkflow(baseWorkflow, sourceRun, sourceJobIndex, params);
}

export function buildVideoExpandLtxWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_EXPAND_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  checkClasses(workflow, LTX_NODE_CLASSES, "ltx");
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);

  const N = VEX_LTX_NODES;
  const plan = videoExpandLtxPlan(
    sourceRun.width,
    sourceRun.height,
    params.expand,
    videoExpandLtxEdge(params.res),
  );
  setNodeInput(workflow, N.load, "file", videoRef);
  // Up to 121 frames at native fps from start_frame, trimmed to 8n+1
  // in-graph (node 26). The audio crop (28) is nested inside this window.
  setNodeInput(workflow, N.crop, "start_frame", videoExpandStartFrame(params.start_frame));
  setNodeInput(workflow, N.crop, "length", VIDEO_EXPAND_LTX_MAX_FRAMES);

  const original = wireFitAndPasteback(
    workflow,
    {
      raw: [N.frames, 0],
      rawSize: N.rawSize,
      cap: N.cap,
      capW: N.capW,
      capH: N.capH,
      size: N.size,
      outW: N.outW,
      outH: N.outH,
      offX: N.offX,
      offY: N.offY,
      keep: N.keep,
      feather: N.feather,
      composite: N.composite,
    },
    plan,
  );
  setNodeInput(workflow, N.innerScale, "image", original);

  // Guide: source frames centred on a pure-black canvas (the LoRA's
  // outpaint sentinel), canvas /32 at the expanded aspect.
  setNodeInput(workflow, N.innerScale, "width", plan.gen.srcWidth);
  setNodeInput(workflow, N.innerScale, "height", plan.gen.srcHeight);
  setNodeInput(workflow, N.innerScale, "crop", "disabled");
  setNodeInput(workflow, N.canvas, "width", plan.gen.width);
  setNodeInput(workflow, N.canvas, "height", plan.gen.height);
  setNodeInput(workflow, N.canvas, "color", 0);
  setNodeInput(workflow, N.guideImage, "x", plan.gen.left);
  setNodeInput(workflow, N.guideImage, "y", plan.gen.top);
  setNodeInput(workflow, N.guideImage, "resize_source", false);
  setNodeInput(workflow, N.latent, "width", plan.gen.width);
  setNodeInput(workflow, N.latent, "height", plan.gen.height);
  setNodeInput(workflow, N.guide, "frame_idx", 0);
  setNodeInput(workflow, N.guide, "strength", 1);
  setNodeInput(workflow, N.lora, "lora_name", VIDEO_EXPAND_LTX_LORA);

  setNodeInput(workflow, N.pos, "text", ltxPromptFor(sourceRun, params));
  setNodeInput(workflow, N.neg, "text", VIDEO_EXPAND_LTX_NEGATIVE);
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

/** Wan2.2 Fun VACE outpaint (experimental; explicit `engine: "wan"`). */
export function buildVideoExpandWanWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_EXPAND_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  for (const [id, cls] of Object.entries(NODE_CLASSES)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(`${action}: workflow node ${id} must be ${cls}`);
    }
  }
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);

  const N = VEX_NODES;
  const plan = videoExpandPlan(
    sourceRun.width,
    sourceRun.height,
    params.expand,
  );
  setNodeInput(workflow, N.load, "file", videoRef);
  setNodeInput(workflow, N.crop, "start_frame", videoExpandStartFrame(params.start_frame));
  setNodeInput(workflow, N.crop, "length", VIDEO_EXPAND_VACE_MAX_FRAMES);

  const original = wireFitAndPasteback(
    workflow,
    {
      raw: [N.parts, 0],
      rawSize: N.size,
      cap: N.cap,
      capW: N.capW,
      capH: N.capH,
      size: N.fitSize,
      outW: N.outW,
      outH: N.outH,
      offX: N.offX,
      offY: N.offY,
      keep: N.keep,
      feather: N.feather,
      composite: N.composite,
    },
    plan,
  );
  setNodeInput(workflow, N.genScale, "image", original);

  // Generation canvas.
  setNodeInput(workflow, N.genScale, "width", plan.gen.srcWidth);
  setNodeInput(workflow, N.genScale, "height", plan.gen.srcHeight);
  setNodeInput(workflow, N.genScale, "crop", "disabled");
  for (const side of ["left", "top", "right", "bottom"] as const) {
    setNodeInput(workflow, N.pad, side, plan.gen[side]);
  }
  setNodeInput(workflow, N.pad, "feathering", 0);
  setNodeInput(workflow, N.vace, "width", plan.gen.width);
  setNodeInput(workflow, N.vace, "height", plan.gen.height);

  setNodeInput(workflow, N.pos, "text", promptFor(sourceRun, params));
  const seed = seedFrom(params);
  setNodeInput(workflow, N.hi, "noise_seed", seed);
  applyVaceSpeed(workflow, N, vaceSpeed(params.speed));

  const slots: WorkflowSlots = {
    ksamplerId: N.hi,
    posTextId: N.pos,
    posTextInputName: "text",
    negTextId: N.neg,
    latentDimsId: N.vace,
    imageInputId: N.load,
  };
  return { workflow, slots, seed };
}
