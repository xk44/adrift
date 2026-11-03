/**
 * "Character from reference (Anima)" (packs/anima/anima_ref.json): Anima base
 * v1.0 + the ElectronGirl Anima Ref Adapter. A reference image of a
 * character supplies identity; the prompt carries only quality tags,
 * gender/solo and the scene/pose (no appearance tags, per the adapter README).
 *
 * Two graph shapes are accepted:
 *  - v2 (the pack): LoadImage -> AnimaRefAdapter (patches the MODEL) ->
 *    KSampler on an EmptyLatentImage. A second reference
 *    (params.secondRefImage, an uploaded "name.png [input]" ref) makes it a
 *    two-character graph: both LoadImages go through a core ImageStitch
 *    (left | right) into the adapter, and the default size turns landscape.
 *  - pilot (packs/anima/anima_ref_pilot.json, the pack's `_fallback` when
 *    the installed node pack has no AnimaRefAdapter, or an older saved
 *    graph): LoadImage -> AnimaRefLatent -> AnimaRefGuider ->
 *    SamplerCustomAdvanced. One character only.
 *
 * Params: prompt (or text; the scene prompt, required), negative (appended to the default
 * negative), width/height or aspect ("W:H"), seed, steps, ref_guidance, cfg,
 * secondRefImage (v2 only).
 *
 * Weights are CircleStone Labs Non-Commercial (Anima base + the adapter,
 * which is a derivative of it).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import registry from "./registry.json";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { nextNodeId } from "./loraInsert";
import { parseInputRef } from "@/lib/seedRun";

export const ANIMA_REF_ACTION = "anima_ref";

export const ANIMA_QUALITY_PREFIX =
  "masterpiece, best quality, score_7, newest, highres, absurdres, safe, ";
export const ANIMA_DEFAULT_NEGATIVE =
  "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, chromatic aberration, bad anatomy, bad hands, extra arms, extra fingers, missing fingers";

/** v2 single-character default (the upstream v2 workflow's size). */
export const ANIMA_DEFAULT_WIDTH = 832;
export const ANIMA_DEFAULT_HEIGHT = 1216;
/** v2 two-character default: landscape, per the upstream duo workflow. */
export const ANIMA_DUO_WIDTH = 1216;
export const ANIMA_DUO_HEIGHT = 832;
/** Pilot adapter's training size (legacy graph). */
export const ANIMA_PILOT_WIDTH = 896;
export const ANIMA_PILOT_HEIGHT = 1152;
export const ANIMA_DEFAULT_STEPS = 30;
export const ANIMA_DEFAULT_CFG = 4.5;
export const ANIMA_DEFAULT_REF_GUIDANCE = 4.5;

export const ANIMA_LICENSE = "CircleStone Labs Non-Commercial License";

/** Hint shown with the second reference slot. */
export const ANIMA_DUO_PROMPT_HINT =
  'Say who is on the left and who is on the right, e.g. "2girls, the girl on the left is …, the girl on the right is …".';

/** Quality tags the user may already have typed (then no prefix is added). */
const QUALITY_TAG_RE = /\b(masterpiece|best quality|score_\d)\b/i;

/** Positive prompt: default quality prefix + the scene-only text. */
export function animaPositive(text: unknown): string {
  const t = typeof text === "string" ? text.trim().replace(/^,+|,+$/g, "") : "";
  if (!t) throw new Error(`${ANIMA_REF_ACTION}: describe the scene to draw`);
  return QUALITY_TAG_RE.test(t) ? t : `${ANIMA_QUALITY_PREFIX}${t}`;
}

/** Negative prompt: the default negative + any user `--no` terms. */
export function animaNegative(extra: unknown): string {
  const parts = Array.isArray(extra)
    ? extra.map(String)
    : typeof extra === "string"
      ? [extra]
      : [];
  const add = parts
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  return add ? `${ANIMA_DEFAULT_NEGATIVE}, ${add}` : ANIMA_DEFAULT_NEGATIVE;
}

const MIN_SIDE = 512;
const MAX_SIDE = 2048;

function snap(v: number): number {
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(v / 64) * 64));
}

function parseRatio(aspect: unknown): number | null {
  if (typeof aspect !== "string") return null;
  const m = aspect.trim().match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * Output size. Explicit width/height win; else an aspect ("3:4") maps to the
 * registry preset or, for other ratios, to the default's pixel area at that
 * ratio (multiples of 64). With no size given: `fallback` (default 832x1216,
 * the v2 size; the builder passes 1216x832 for two characters and 896x1152
 * for the pilot graph).
 */
export function animaDims(
  params: Record<string, unknown> = {},
  fallback: { width: number; height: number } = {
    width: ANIMA_DEFAULT_WIDTH,
    height: ANIMA_DEFAULT_HEIGHT,
  },
): {
  width: number;
  height: number;
} {
  const w = Number(params.width);
  const h = Number(params.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: snap(w), height: snap(h) };
  }
  const aspect = typeof params.aspect === "string" ? params.aspect.trim() : "";
  const presets = (
    registry as unknown as {
      aspectPresets?: Record<string, { width: number; height: number }>;
    }
  ).aspectPresets;
  const preset = aspect ? presets?.[aspect] : undefined;
  if (preset) return { width: preset.width, height: preset.height };
  const ratio = parseRatio(aspect);
  if (!ratio) return { ...fallback };
  const area = fallback.width * fallback.height;
  return {
    width: snap(Math.sqrt(area * ratio)),
    height: snap(Math.sqrt(area / ratio)),
  };
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n))
    return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function linkId(v: unknown): string | undefined {
  return Array.isArray(v) ? String(v[0]) : undefined;
}

function classOf(
  workflow: Workflow,
  id: string | undefined,
): string | undefined {
  return id ? workflow[id]?.class_type : undefined;
}

/** Which adapter graph this is: v2 (AnimaRefAdapter) or the pilot. */
export function animaRefGraphKind(workflow: Workflow): "v2" | "pilot" | null {
  if (nodeIdOf(workflow, "AnimaRefAdapter")) return "v2";
  if (
    nodeIdOf(workflow, "AnimaRefLatent") &&
    nodeIdOf(workflow, "AnimaRefGuider")
  )
    return "pilot";
  return null;
}

/** The second reference ("name.png [input]"), or null when not given. */
function secondRefOf(params: Record<string, unknown>): string | null {
  const raw = params.secondRefImage;
  if (raw === undefined || raw === null || raw === "") return null;
  const ref = typeof raw === "string" ? raw.trim() : "";
  if (!parseInputRef(ref)) {
    throw new Error(
      `${ANIMA_REF_ACTION}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
    );
  }
  return ref;
}

function seedOf(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? Math.floor(params.seed)
    : Math.floor(Math.random() * 2 ** 32);
}

function promptText(params: Record<string, unknown>): string {
  return animaPositive(
    typeof params.prompt === "string" && params.prompt.trim()
      ? params.prompt
      : params.text,
  );
}

const steps = (params: Record<string, unknown>) =>
  Math.round(clampNum(params.steps, 20, 40, ANIMA_DEFAULT_STEPS));
const cfg = (params: Record<string, unknown>) =>
  clampNum(params.cfg, 1, 8, ANIMA_DEFAULT_CFG);
const refGuidance = (params: Record<string, unknown>) =>
  clampNum(params.ref_guidance, 3, 8, ANIMA_DEFAULT_REF_GUIDANCE);

export function buildAnimaRefWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${ANIMA_REF_ACTION}: no reference image to use`);
  const secondRef = secondRefOf(params);

  const kind = animaRefGraphKind(workflow);
  if (kind === "v2") return buildV2(workflow, imageRef, secondRef, params);
  if (kind === "pilot") {
    if (secondRef) {
      throw new Error(
        `${ANIMA_REF_ACTION}: two characters need the v2 Anima Ref Adapter (AnimaRefAdapter node); update ComfyUI-Anima-Ref-Adapter`,
      );
    }
    return buildPilot(workflow, imageRef, params);
  }
  throw new Error(
    `${ANIMA_REF_ACTION}: workflow needs AnimaRefAdapter (v2) or AnimaRefLatent + AnimaRefGuider (pilot)`,
  );
}

/** v2: LoadImage [-> ImageStitch <- LoadImage] -> AnimaRefAdapter -> KSampler. */
function buildV2(
  workflow: Workflow,
  imageRef: string,
  secondRef: string | null,
  params: Record<string, unknown>,
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const adapterId = nodeIdOf(workflow, "AnimaRefAdapter") as string;
  const ksamplerId = Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === "KSampler" &&
      linkId(workflow[id].inputs.model) === adapterId,
  );
  const ks = ksamplerId ? workflow[ksamplerId].inputs : undefined;
  const posId = linkId(ks?.positive);
  const negId = linkId(ks?.negative);
  const latentId = linkId(ks?.latent_image);
  const imgSrcId = linkId(workflow[adapterId].inputs.image);
  // The adapter's image is a LoadImage, or (a saved duo graph) an
  // ImageStitch whose image1 is one.
  const stitchId =
    classOf(workflow, imgSrcId) === "ImageStitch" ? imgSrcId : undefined;
  const loadId = stitchId ? linkId(workflow[stitchId].inputs.image1) : imgSrcId;
  if (
    !ksamplerId ||
    classOf(workflow, posId) !== "CLIPTextEncode" ||
    classOf(workflow, negId) !== "CLIPTextEncode" ||
    classOf(workflow, latentId) !== "EmptyLatentImage" ||
    classOf(workflow, loadId) !== "LoadImage"
  ) {
    throw new Error(
      `${ANIMA_REF_ACTION}: workflow needs LoadImage -> AnimaRefAdapter -> KSampler (CLIPTextEncode positive/negative, EmptyLatentImage)`,
    );
  }
  const pos = posId as string;
  const neg = negId as string;
  const latent = latentId as string;
  const load = loadId as string;

  setNodeInput(workflow, load, "image", imageRef);

  if (secondRef) {
    // Left = first reference, right = second (upstream two-character graph).
    const existing2 = stitchId
      ? linkId(workflow[stitchId].inputs.image2)
      : undefined;
    let load2 =
      classOf(workflow, existing2) === "LoadImage" ? existing2 : undefined;
    if (!load2) {
      load2 = nextNodeId(workflow);
      workflow[load2] = {
        class_type: "LoadImage",
        inputs: { image: secondRef },
        _meta: { title: "Character Reference (right)" },
      } as Workflow[string];
    }
    setNodeInput(workflow, load2, "image", secondRef);
    let stitch = stitchId;
    if (!stitch) {
      stitch = nextNodeId(workflow);
      workflow[stitch] = {
        class_type: "ImageStitch",
        inputs: {
          image1: [load, 0],
          image2: [load2, 0],
          direction: "right",
          match_image_size: true,
          spacing_width: 0,
          spacing_color: "white",
        },
        _meta: { title: "Two references side by side" },
      } as Workflow[string];
    } else {
      setNodeInput(workflow, stitch, "image2", [load2, 0]);
      setNodeInput(workflow, stitch, "direction", "right");
    }
    setNodeInput(workflow, adapterId, "image", [stitch, 0]);
  } else if (stitchId) {
    // Saved duo graph run with one reference: drop the stitch.
    const load2 = linkId(workflow[stitchId].inputs.image2);
    setNodeInput(workflow, adapterId, "image", [load, 0]);
    delete workflow[stitchId];
    if (load2 && classOf(workflow, load2) === "LoadImage") {
      const usedElsewhere = Object.values(workflow).some((n) =>
        Object.values(n.inputs ?? {}).some((v) => linkId(v) === load2),
      );
      if (!usedElsewhere) delete workflow[load2];
    }
  }

  setNodeInput(workflow, pos, "text", promptText(params));
  setNodeInput(workflow, neg, "text", animaNegative(params.negative));

  const { width, height } = animaDims(
    params,
    secondRef
      ? { width: ANIMA_DUO_WIDTH, height: ANIMA_DUO_HEIGHT }
      : { width: ANIMA_DEFAULT_WIDTH, height: ANIMA_DEFAULT_HEIGHT },
  );
  setNodeInput(workflow, latent, "width", width);
  setNodeInput(workflow, latent, "height", height);

  setNodeInput(workflow, ksamplerId, "steps", steps(params));
  setNodeInput(workflow, ksamplerId, "cfg", cfg(params));
  setNodeInput(workflow, adapterId, "ref_guidance", refGuidance(params));

  const seed = seedOf(params);
  setNodeInput(workflow, ksamplerId, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId,
      posTextId: pos,
      posTextInputName: "text",
      negTextId: neg,
      latentDimsId: latent,
      imageInputId: load,
    },
    seed,
  };
}

/** Pilot: LoadImage -> AnimaRefLatent -> AnimaRefGuider -> SamplerCustomAdvanced. */
function buildPilot(
  workflow: Workflow,
  imageRef: string,
  params: Record<string, unknown>,
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const loadId = nodeIdOf(workflow, "LoadImage");
  const latentId = nodeIdOf(workflow, "AnimaRefLatent");
  const guiderId = nodeIdOf(workflow, "AnimaRefGuider");
  const schedId = nodeIdOf(workflow, "BasicScheduler");
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  const posId = guiderId
    ? linkId(workflow[guiderId].inputs.positive)
    : undefined;
  const negId = guiderId
    ? linkId(workflow[guiderId].inputs.negative)
    : undefined;
  if (
    !loadId ||
    !latentId ||
    !guiderId ||
    !schedId ||
    !noiseId ||
    !posId ||
    !negId ||
    workflow[posId]?.class_type !== "CLIPTextEncode" ||
    workflow[negId]?.class_type !== "CLIPTextEncode"
  ) {
    throw new Error(
      `${ANIMA_REF_ACTION}: workflow needs LoadImage, AnimaRefLatent, AnimaRefGuider (CLIPTextEncode positive/negative), BasicScheduler and RandomNoise`,
    );
  }

  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(workflow, posId, "text", promptText(params));
  setNodeInput(workflow, negId, "text", animaNegative(params.negative));

  const { width, height } = animaDims(params, {
    width: ANIMA_PILOT_WIDTH,
    height: ANIMA_PILOT_HEIGHT,
  });
  setNodeInput(workflow, latentId, "width", width);
  setNodeInput(workflow, latentId, "height", height);

  setNodeInput(workflow, schedId, "steps", steps(params));
  setNodeInput(workflow, guiderId, "cfg", cfg(params));
  setNodeInput(workflow, guiderId, "ref_guidance", refGuidance(params));

  const seed = seedOf(params);
  setNodeInput(workflow, noiseId, "noise_seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: guiderId,
      posTextId: posId,
      posTextInputName: "text",
      negTextId: negId,
      latentDimsId: latentId,
      imageInputId: loadId,
    },
    seed,
  };
}
