/**
 * Action builders for the LTX-2.5 tools (open-weights engine):
 *  - ltx25_animate: the source image becomes the first frame of a two-stage
 *    LTX-2.5 i2v clip with sound.
 *  - ltx25_transition: the source image is the first frame and an uploaded
 *    image the last frame of a single-stage LTX-2.5 first/last-frame clip.
 * Size follows the source image's aspect (or params.ar) at ~0.9 MP; length
 * is picked in seconds (24 fps, snapped to 8n+1).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { discoverVideoSlots, traceUpstream } from "./discovery";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { transitionEndRef, transitionPrompt } from "./h3ImageVideo";
import {
  LTX25_ANIMATE_ACTION,
  LTX25_TRANSITION_ACTION,
  isLtx25TwoStage,
  ltx25Dims,
  ltx25LengthForSeconds,
  ltx25Length,
  ltx25SourceDims,
  parseAspect,
  setLtx25Length,
  setLtx25Size,
  syncLtx25AudioVideo,
} from "./ltx25";
import { applyLtxExtraLora } from "./ltxCommunityLoras";

export const LTX25_DURATIONS = ["5", "8", "10"] as const;

/** Appended when the user gives no motion text and the source has no prompt. */
export const LTX25_ANIMATE_PROMPT =
  "The scene comes to life with natural, smooth motion and matching ambient sound. Consistent lighting, style and identity.";

type BuildResult = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function textParam(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function seedFor(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? params.seed
    : Math.floor(Math.random() * 2 ** 32);
}

/** Frames from `frames`/`length` (explicit) or `duration` seconds. */
function lengthFor(params: Record<string, unknown>): number {
  const explicit = params.frames ?? params.length;
  if (explicit !== undefined) return ltx25Length(explicit);
  return ltx25LengthForSeconds(params.duration ?? 5);
}

function ratioOf(run: ImagineRun): number {
  const w = Number(run.width);
  const h = Number(run.height);
  return w > 0 && h > 0 ? w / h : 1;
}

function finish(
  workflow: Workflow,
  params: Record<string, unknown>,
  imageInputId: string,
): BuildResult {
  const slots = discoverVideoSlots(workflow);
  applyLtxExtraLora(workflow, params, slots.posTextId);
  const seed = seedFor(params);
  const noiseId = slots.customSampling?.noiseId;
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);
  syncLtx25AudioVideo(workflow);
  return { workflow, slots: { ...slots, imageInputId }, seed };
}

export function buildLtx25AnimateWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const workflow = cloneWorkflow(baseWorkflow);
  const startRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!startRef) {
    throw new Error(`${LTX25_ANIMATE_ACTION}: source run has no image`);
  }
  const slots = discoverVideoSlots(workflow);
  if (!slots.imageInputId) {
    throw new Error(`${LTX25_ANIMATE_ACTION}: workflow needs a LoadImage node`);
  }
  setNodeInput(workflow, slots.imageInputId, "image", startRef);
  // parsedPrompt has the --flags stripped (a "--pack flux3 --ar 16:9" key
  // art run must not leak them into the video prompt).
  const prompt =
    textParam(params.prompt) ||
    textParam(sourceRun.parsedPrompt) ||
    textParam(sourceRun.prompt) ||
    LTX25_ANIMATE_PROMPT;
  setNodeInput(workflow, slots.posTextId, "text", prompt);
  // params.ar ("9:16") pins the clip shape (Click to Ad is always
  // vertical); otherwise the clip is sized from the source image on the
  // LTX grid (closest aspect, never below the default size).
  const twoStage = isLtx25TwoStage(workflow);
  const ar = parseAspect(params.ar);
  setLtx25Size(
    workflow,
    ar !== undefined
      ? ltx25Dims(ar, twoStage)
      : ltx25SourceDims(
          Number(sourceRun.width),
          Number(sourceRun.height),
          twoStage,
        ),
  );
  setLtx25Length(workflow, lengthFor(params));
  return finish(workflow, params, slots.imageInputId);
}

/** LoadImage feeding the LTXVAddGuide whose frame_idx is `frameIdx`. */
function guideImageLoader(workflow: Workflow, frameIdx: number): string | null {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "LTXVAddGuide") continue;
    const inputs = node.inputs as Record<string, unknown>;
    if (Number(inputs.frame_idx) !== frameIdx) continue;
    const image = inputs.image;
    if (!Array.isArray(image)) return null;
    return traceUpstream(
      workflow,
      String(image[0]),
      (n) => n.class_type === "LoadImage",
    );
  }
  return null;
}

export function buildLtx25TransitionWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const workflow = cloneWorkflow(baseWorkflow);
  const startRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!startRef) {
    throw new Error(`${LTX25_TRANSITION_ACTION}: source run has no image`);
  }
  const endRef = transitionEndRef(params);
  if (!endRef) {
    throw new Error(
      `${LTX25_TRANSITION_ACTION}: endImage (or secondRefImage) must be an uploaded image ref ("name.png [input]")`,
    );
  }
  const firstId = guideImageLoader(workflow, 0);
  const lastId = guideImageLoader(workflow, -1);
  if (!firstId || !lastId || firstId === lastId) {
    throw new Error(
      `${LTX25_TRANSITION_ACTION}: workflow needs first (frame_idx 0) and last (frame_idx -1) LTXVAddGuide images from two LoadImage nodes`,
    );
  }
  setNodeInput(workflow, firstId, "image", startRef);
  setNodeInput(workflow, lastId, "image", endRef);
  const slots = discoverVideoSlots(workflow);
  setNodeInput(
    workflow,
    slots.posTextId,
    "text",
    transitionPrompt(params.prompt),
  );
  setLtx25Size(
    workflow,
    ltx25Dims(ratioOf(sourceRun), isLtx25TwoStage(workflow)),
  );
  setLtx25Length(workflow, lengthFor(params));
  return finish(workflow, params, firstId);
}
