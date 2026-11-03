/**
 * Restore (packs/ltx25/vfx_restore*.json): footage repair with the LTX-2.5
 * restoration IC-LoRAs from Lightricks on the distilled LTX-2.5 22B model,
 * core ComfyUI nodes only. The source clip is the in-context reference; one
 * pack per mode, so the mode picks the LoRA:
 *
 *   ltx_restore             Restore 1.0          archival repair + colour
 *   ltx_restore_deblur      Deblur 0.9           defocus blur -> sharp
 *   ltx_restore_decompress  Decompression 0.9    macroblocking/ringing -> clean
 *   ltx_restore_colorize    Colorization 0.9     black-and-white -> colour
 *   ltx_restore_refine      Refine-Details 1.0   soft -> fine texture
 *
 * The builder patches the source clip, frame count (8n+1 from the source
 * length, 24 fps), size (card training size in the source orientation),
 * prompt (model card template around the user's scene description), LoRA
 * strength and seed. Source audio is kept.
 * License: LTX-2.x Community License (base model and all five LoRAs, gated).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { ltxVfxFrames } from "./ltxVfx";

export const LTX_RESTORE_ACTION = "ltx_restore";
export const LTX_RESTORE_DEBLUR_ACTION = "ltx_restore_deblur";
export const LTX_RESTORE_DECOMPRESS_ACTION = "ltx_restore_decompress";
export const LTX_RESTORE_COLORIZE_ACTION = "ltx_restore_colorize";
export const LTX_RESTORE_REFINE_ACTION = "ltx_restore_refine";

export const LTX_RESTORE_FPS = 24;
export const LTX_RESTORE_MAX_FRAMES = 97;

interface RestoreMode {
  label: string;
  lora: string;
  /** Landscape size; portrait sources swap it. */
  width: number;
  height: number;
  /** Positive prompt for a scene description (may be empty). */
  prompt: (scene: string) => string;
}

const SAME =
  "Subject identity, framing, and background geometry are identical to the reference;";

export const LTX_RESTORE_MODES: Record<string, RestoreMode> = {
  [LTX_RESTORE_ACTION]: {
    label: "Restore",
    lora: "ltx25/ltx-2.5-22b-ic-lora-restore-1.0.safetensors",
    width: 960,
    height: 544,
    prompt: (s) =>
      `${s ? `${s}, ` : "Archival footage of the scene, "}natural colour, sharp photographic detail, natural grain, high resolution footage.`,
  },
  [LTX_RESTORE_DEBLUR_ACTION]: {
    label: "Deblur",
    lora: "ltx25/ltx-2.5-22b-ic-lora-deblur-0.9.safetensors",
    width: 960,
    height: 544,
    prompt: (s) =>
      `Reference shows ${s || "the scene"}, heavily out of focus with soft defocused blur and no fine detail. Edited shows the same scene in sharp focus with crisp detail and clean edges. DEBLUR ${s || "the scene"}. ${SAME} only focus and sharpness differ between reference and edited.`,
  },
  [LTX_RESTORE_DECOMPRESS_ACTION]: {
    label: "Decompress",
    lora: "ltx25/ltx-2.5-22b-ic-lora-decompression-0.9.safetensors",
    width: 960,
    height: 544,
    prompt: (s) =>
      `Reference shows ${s || "the scene"}, heavily compressed with visible macroblocking, chroma bleed, and ringing artifacts. Edited shows the same scene restored to high quality with sharp detail, clean edges, and no compression artifacts. ENHANCE QUALITY ${s || "the scene"}. ${SAME} only compression artifacts and image quality differ between reference and edited.`,
  },
  [LTX_RESTORE_COLORIZE_ACTION]: {
    label: "Colorize",
    lora: "ltx25/ltx-2.5-22b-ic-lora-colorization-0.9.safetensors",
    width: 960,
    height: 544,
    prompt: (s) =>
      `Reference shows a black-and-white shot of ${s || "the scene"}. Edited shows the same scene with natural colors restored. COLORIZE ${s ? `${s} in vivid, natural colors` : "the scene in vivid, natural, realistic colors"}. ${SAME} only color information differs between reference and edited.`,
  },
  [LTX_RESTORE_REFINE_ACTION]: {
    label: "Refine details",
    lora: "ltx25/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors",
    width: 1024,
    height: 576,
    prompt: (s) =>
      `${s ? `${s}, ` : ""}sharp photographic detail, crisp natural texture, fine surface detail, clean edges, natural film grain, high resolution footage`,
  },
};

export const LTX_RESTORE_ACTIONS = Object.keys(LTX_RESTORE_MODES);

export function isLtxRestoreAction(action: unknown): boolean {
  return typeof action === "string" && action in LTX_RESTORE_MODES;
}

function positive(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Scene text: whitespace collapsed, trailing period dropped, capped. */
function scene(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000)
        .replace(/[.\s]+$/, "")
    : "";
}

export function ltxRestorePrompt(action: string, text: unknown): string {
  const mode = LTX_RESTORE_MODES[action];
  if (!mode) throw new Error(`ltx_restore: unknown mode "${action}"`);
  return mode.prompt(scene(text));
}

/**
 * The cards run every LoRA at 1.0 (Restore acts like a switch below ~0.8);
 * allowed 0.5..1.5.
 */
export function ltxRestoreStrength(value: unknown): number {
  const v = positive(value);
  return v === undefined ? 1 : Math.min(1.5, Math.max(0.5, v));
}

export function ltxRestoreDims(
  action: string,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const mode = LTX_RESTORE_MODES[action];
  if (!mode) throw new Error(`ltx_restore: unknown mode "${action}"`);
  const portrait = !!width && !!height && height > width;
  return portrait
    ? { width: mode.height, height: mode.width }
    : { width: mode.width, height: mode.height };
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id]?.class_type === classType,
  );
}

export function buildLtxRestoreWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
  actionOverride?: string,
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action =
    actionOverride ?? (typeof params.action === "string" ? params.action : "");
  const mode = LTX_RESTORE_MODES[action];
  if (!mode) throw new Error(`ltx_restore: unknown mode "${action}"`);

  const workflow = cloneWorkflow(baseWorkflow);
  const ref = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.videos?.[0],
  );
  if (!ref) throw new Error(`${action}: source run has no video`);

  const load = nodeIdOf(workflow, "LoadVideo");
  const slice = nodeIdOf(workflow, "Video Slice");
  const sample = nodeIdOf(workflow, "VideoFrameSample");
  const scale = nodeIdOf(workflow, "ImageScale");
  const latent = nodeIdOf(workflow, "EmptyLTXVLatentVideo");
  const audio = nodeIdOf(workflow, "LTXVEmptyLatentAudio");
  const cond = nodeIdOf(workflow, "LTXVConditioning");
  const lora = nodeIdOf(workflow, "LoraLoaderModelOnly");
  const create = nodeIdOf(workflow, "CreateVideo");
  const pos = cond ? workflow[cond].inputs.positive : undefined;
  const neg = cond ? workflow[cond].inputs.negative : undefined;
  if (
    !load ||
    !slice ||
    !sample ||
    !scale ||
    !latent ||
    !audio ||
    !cond ||
    !lora ||
    !create ||
    !Array.isArray(pos) ||
    !Array.isArray(neg)
  ) {
    throw new Error(
      `${action}: workflow needs LoadVideo, Video Slice, VideoFrameSample, ImageScale, EmptyLTXVLatentVideo, LTXVEmptyLatentAudio, LTXVConditioning (wired prompts), LoraLoaderModelOnly and CreateVideo`,
    );
  }
  const posId = String(pos[0]);
  const negId = String(neg[0]);

  setNodeInput(workflow, load, "file", ref);

  const seconds = positive(
    params.video_seconds,
    sourceRun.params?.video_seconds,
  );
  const frames = ltxVfxFrames(seconds, LTX_RESTORE_FPS, LTX_RESTORE_MAX_FRAMES);
  setNodeInput(workflow, slice, "start_time", 0);
  setNodeInput(
    workflow,
    slice,
    "duration",
    Math.round((frames / LTX_RESTORE_FPS) * 10000) / 10000,
  );
  setNodeInput(workflow, sample, "num_frames", frames);

  const dims = ltxRestoreDims(action, sourceRun.width, sourceRun.height);
  setNodeInput(workflow, scale, "width", dims.width);
  setNodeInput(workflow, scale, "height", dims.height);
  setNodeInput(workflow, latent, "width", dims.width);
  setNodeInput(workflow, latent, "height", dims.height);
  setNodeInput(workflow, latent, "length", frames);
  setNodeInput(workflow, audio, "frames_number", frames);
  setNodeInput(workflow, audio, "frame_rate", LTX_RESTORE_FPS);
  setNodeInput(workflow, cond, "frame_rate", LTX_RESTORE_FPS);
  setNodeInput(workflow, create, "fps", LTX_RESTORE_FPS);

  // The mode's own LoRA even if a caller hands in another mode's pack.
  setNodeInput(workflow, lora, "lora_name", mode.lora);
  setNodeInput(
    workflow,
    lora,
    "strength_model",
    ltxRestoreStrength(params.strength),
  );
  setNodeInput(
    workflow,
    posId,
    "text",
    ltxRestorePrompt(action, params.prompt ?? params.text),
  );

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(Math.abs(params.seed))
      : Math.floor(Math.random() * 2 ** 32);
  const noise = nodeIdOf(workflow, "RandomNoise");
  if (noise) setNodeInput(workflow, noise, "noise_seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: posId,
      posTextInputName: "text",
      negTextId: negId,
      latentDimsId: "",
      imageInputId: load,
    },
    seed,
  };
}

type Builder = (
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
) => { workflow: Workflow; slots: WorkflowSlots; seed: number };

export const LTX_RESTORE_BUILDERS: Record<string, Builder> = Object.fromEntries(
  LTX_RESTORE_ACTIONS.map((action) => [
    action,
    ((base, run, idx, params) =>
      buildLtxRestoreWorkflow(base, run, idx, params, action)) as Builder,
  ]),
);
