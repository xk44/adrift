/**
 * Image-in builders for the H3 orbit / camera-move tools (see h3Video.ts for
 * the recipes). Separate from h3Video.ts so engine.ts can import the pure
 * helpers there without an import cycle.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow, comfyImageRefFromViewUrl, setNodeInput } from "./engine";
import { applyH3Speed } from "./h3Speed";
import {
  CAMERA_LENGTH,
  CAMERA_MOVE_ACTION,
  CAMERA_DRAFT_SHORT_EDGE,
  CAMERA_SHORT_EDGE,
  ORBIT_360_ACTION,
  ORBIT_LENGTH,
  ORBIT_SHORT_EDGE,
  applyH3ExtraLoras,
  cameraMovePrompt,
  orbitPrompt,
  transitionStyle,
} from "./h3Video";

const snap32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);
/** H3's native canvas long edge (1344x768 at 16:9). */
const MAX_LONG_EDGE = 1344;

/**
 * Short edge `shortEdge`, source aspect (square when unknown), /32. When the
 * long edge would pass MAX_LONG_EDGE both edges shrink together: the H3 node
 * stretches the first frame onto the canvas, so a clamped-only long edge
 * squashes the picture (a 16:9 photo at 768 became 4:3).
 */
export function h3ImageDims(
  shortEdge: number,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = typeof width === "number" && width > 0 ? width : 1;
  const h = typeof height === "number" && height > 0 ? height : 1;
  const ratio = Math.max(w, h) / Math.min(w, h);
  let long = snap32(shortEdge * ratio);
  let short = shortEdge;
  if (long > MAX_LONG_EDGE) {
    long = MAX_LONG_EDGE;
    short = snap32(MAX_LONG_EDGE / ratio);
  }
  return w >= h
    ? { width: long, height: short }
    : { width: short, height: long };
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

interface ImageVideoSpec {
  action: string;
  prompt: (params: Record<string, unknown>) => string;
  shortEdge: number | ((params: Record<string, unknown>) => number);
  length: number;
}

function buildH3ImageVideoWorkflow(
  spec: ImageVideoSpec,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${spec.action}: source run has no image`);

  const imageId = nodeIdOf(workflow, "LoadImage");
  const h3Id = nodeIdOf(workflow, "MiniMaxH3ImageToVideo");
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  if (!imageId || !h3Id) {
    throw new Error(
      `${spec.action}: workflow needs LoadImage and MiniMaxH3ImageToVideo`,
    );
  }

  setNodeInput(workflow, imageId, "image", imageRef);
  setNodeInput(workflow, h3Id, "prompt", spec.prompt(params));
  setNodeInput(workflow, h3Id, "length", spec.length);
  const shortEdge =
    typeof spec.shortEdge === "function" ? spec.shortEdge(params) : spec.shortEdge;
  const dims = h3ImageDims(shortEdge, sourceRun.width, sourceRun.height);
  setNodeInput(workflow, h3Id, "width", dims.width);
  setNodeInput(workflow, h3Id, "height", dims.height);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
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

const userText = (p: Record<string, unknown>) =>
  typeof p.prompt === "string" ? p.prompt : undefined;

/**
 * 360 orbit: source image is both the first and the last frame;
 * `params.orbitLook` is an ORBIT_PRESETS id.
 */
export function buildOrbit360Workflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildH3ImageVideoWorkflow(
    {
      action: ORBIT_360_ACTION,
      prompt: (p) => orbitPrompt(userText(p), p.orbitLook),
      shortEdge: ORBIT_SHORT_EDGE,
      length: ORBIT_LENGTH,
    },
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}

/** Camera move: `params.cameraMove` is a CAMERA_PRESETS id. */
export function buildCameraMoveWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildH3ImageVideoWorkflow(
    {
      action: CAMERA_MOVE_ACTION,
      prompt: (p) => cameraMovePrompt(p.cameraMove, userText(p)),
      shortEdge: (p) =>
        String(p.resolution ?? "") === "480" ? CAMERA_DRAFT_SHORT_EDGE : CAMERA_SHORT_EDGE,
      length: CAMERA_LENGTH,
    },
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}

// Transition: start image → end image (packs/minimax/transition.json)

export const TRANSITION_ACTION = "transition";
/** 73 = 17*4 + 5, ~3 s at 24 fps. */
export const TRANSITION_LENGTH = 73;
export const TRANSITION_MIN_LENGTH = 22;
/** 241 = 17*14 + 5, ~10 s at 24 fps. */
export const TRANSITION_MAX_LENGTH = 241;
export const TRANSITION_SHORT_EDGE = 768;

/** Appended to every transition prompt (FL2VA keys off a scene description). */
export const TRANSITION_PROMPT =
  "One continuous shot that moves naturally from the opening frame to the closing frame. " +
  "Smooth, physically plausible motion; consistent lighting, style and identity. No cuts, fades or added text.";

/** Style sentence (TRANSITION_STYLES id), then user text, then the tail. */
export function transitionPrompt(userText?: unknown, style?: unknown): string {
  const extra =
    typeof userText === "string" ? userText.replace(/\s+/g, " ").trim() : "";
  return [transitionStyle(style).text, extra, TRANSITION_PROMPT]
    .filter(Boolean)
    .join(" ");
}

/** Frame count: snapped DOWN onto the H3 17k+5 grid, clamped to [22, 241]. */
export function transitionLength(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return TRANSITION_LENGTH;
  const snapped = Math.floor((Math.round(n) - 5) / 17) * 17 + 5;
  return Math.min(
    TRANSITION_MAX_LENGTH,
    Math.max(TRANSITION_MIN_LENGTH, snapped),
  );
}

const ANNOTATED_REF_RE = /^[^\s].* \[(input|output|temp)\]$/;

/** End-frame ref: params.endImage | end_image | secondRefImage ("name.png [input]"). */
export function transitionEndRef(
  params: Record<string, unknown>,
): string | null {
  for (const key of ["endImage", "end_image", "secondRefImage"]) {
    const v = params[key];
    if (typeof v !== "string") continue;
    const ref = v.trim();
    if (
      ref.length <= 300 &&
      ANNOTATED_REF_RE.test(ref) &&
      !ref.split(" [")[0].split("/").includes("..")
    )
      return ref;
  }
  return null;
}

function linkedNodeId(value: unknown): string | undefined {
  return Array.isArray(value) && value.length === 2 ? String(value[0]) : undefined;
}

/**
 * Transition: the source run's image is the FIRST frame, the uploaded end
 * image the LAST frame of an H3 FL2VA clip; prompt = user text + the
 * transition tail. Size follows the start image (768 short edge).
 */
export function buildTransitionWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const startRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!startRef) throw new Error(`${TRANSITION_ACTION}: source run has no image`);
  const endRef = transitionEndRef(params);
  if (!endRef) {
    throw new Error(
      `${TRANSITION_ACTION}: endImage (or secondRefImage) must be an uploaded image ref ("name.png [input]")`,
    );
  }

  const h3Id = nodeIdOf(workflow, "MiniMaxH3ImageToVideo");
  if (!h3Id) {
    throw new Error(`${TRANSITION_ACTION}: workflow needs MiniMaxH3ImageToVideo`);
  }
  const h3Inputs = workflow[h3Id].inputs as Record<string, unknown>;
  const firstId = linkedNodeId(h3Inputs.first_frame);
  const lastId = linkedNodeId(h3Inputs.last_frame);
  if (
    !firstId ||
    !lastId ||
    firstId === lastId ||
    workflow[firstId]?.class_type !== "LoadImage" ||
    workflow[lastId]?.class_type !== "LoadImage"
  ) {
    throw new Error(
      `${TRANSITION_ACTION}: first_frame and last_frame must come from two LoadImage nodes`,
    );
  }

  setNodeInput(workflow, firstId, "image", startRef);
  setNodeInput(workflow, lastId, "image", endRef);
  setNodeInput(
    workflow,
    h3Id,
    "prompt",
    transitionPrompt(params.prompt, params.transitionStyle),
  );
  setNodeInput(
    workflow,
    h3Id,
    "length",
    transitionLength(params.length ?? params.frames),
  );
  const dims = h3ImageDims(
    TRANSITION_SHORT_EDGE,
    sourceRun.width,
    sourceRun.height,
  );
  setNodeInput(workflow, h3Id, "width", dims.width);
  setNodeInput(workflow, h3Id, "height", dims.height);

  const noiseId = nodeIdOf(workflow, "RandomNoise");
  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
  applyH3Speed(workflow, params);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: h3Id,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: h3Id,
      imageInputId: firstId,
    },
    seed,
  };
}
