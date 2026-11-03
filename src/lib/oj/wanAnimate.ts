/**
 * "Animate character" (packs/wan-animate/wan_animate.json) — Wan Animate 2
 * motion transfer on open weights, core ComfyUI nodes only. The source clip's
 * frames drive WanAnimate2ToVideo as the pose video and the uploaded
 * character photo (params.secondRefImage) is the reference identity.
 *
 * Modes:
 *  - "animate" (default): the photo's character performs the clip's motion
 *    over the PHOTO's background (the model follows the reference image's
 *    background; the prompt cannot change it).
 *  - "replace": same generation, then a BiRefNet matte of the generated
 *    character is composited over the original clip frames, so the character
 *    stands in the source scene. Wan Animate 2 in core ComfyUI has no native
 *    replace/relight path (no per-person mask input), so this is a composite:
 *    the original performer can show where silhouettes differ, and there is
 *    no "who to replace" targeting — every clip is treated as one performer.
 *    Needs models/background_removal/birefnet.safetensors on the host.
 *
 * Speed: "fast" (default) = distilled int8 checkpoint, LCM 10 steps;
 * "quality" = full int8 checkpoint + lightx2v cfg/step-distill LoRA, LCM
 * 6 steps (the Comfy template recipe).
 *
 * Frames are taken 1:1 from the clip (output keeps its fps and audio), capped
 * at WAN_ANIMATE_MAX_FRAMES and floored to 4n+1 in-graph; ContextWindowsManual
 * covers clips longer than one 81-frame window.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";

export const WAN_ANIMATE_ACTION = "wan_animate";
export const WAN_ANIMATE_MAX_FRAMES = 241;
export const WAN_ANIMATE_FULL_UNET = "wan_animate_2_int8_convrot.safetensors";
export const WAN_ANIMATE_DISTILL_UNET =
  "wan_animate_2_distill_int8_convrot.safetensors";
export const WAN_ANIMATE_LORA =
  "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors";
export const WAN_ANIMATE_BG_MODEL = "birefnet.safetensors";
export const WAN_ANIMATE_MODES = ["animate", "replace"] as const;
export type WanAnimateMode = (typeof WAN_ANIMATE_MODES)[number];

const SHORT_EDGE = 480;
const MAX_LONG_EDGE = 832;

/** Node ids in the shipped graph (validated by class_type before use). */
const N = {
  clipFrames: "3",
  clipResize: "4",
  photo: "7",
  photoResize: "8",
  positive: "14",
  vae: "17",
  unet: "18",
  context: "19",
  animate: "22",
  scheduler: "24",
  sampler: "25",
  trimmed: "28",
  mux: "29",
} as const;

const EXPECT: Record<string, string> = {
  [N.clipFrames]: "ImageFromBatch",
  [N.clipResize]: "ResizeImageMaskNode",
  [N.photo]: "LoadImage",
  [N.photoResize]: "ResizeImageMaskNode",
  [N.positive]: "CLIPTextEncode",
  [N.unet]: "UNETLoader",
  [N.context]: "ContextWindowsManual",
  [N.animate]: "WanAnimate2ToVideo",
  [N.scheduler]: "BasicScheduler",
  [N.sampler]: "SamplerCustom",
  [N.trimmed]: "ImageFromBatch",
  [N.mux]: "CreateVideo",
};

export function wanAnimateMode(value: unknown): WanAnimateMode {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "replace" || v === "replace_in_video" ? "replace" : "animate";
}

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/** Output size: 480 short edge, source aspect, multiples of 16, long edge ≤ 832. */
export function wanAnimateDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = typeof width === "number" && width > 0 ? width : 9;
  const h = typeof height === "number" && height > 0 ? height : 16;
  const long = Math.min(
    MAX_LONG_EDGE,
    snap16((SHORT_EDGE * Math.max(w, h)) / Math.min(w, h)),
  );
  return w >= h
    ? { width: long, height: SHORT_EDGE }
    : { width: SHORT_EDGE, height: long };
}

/** Positive prompt; an optional character description sharpens identity. */
export function wanAnimatePrompt(character?: string): string {
  const who = character?.replace(/\s+/g, " ").trim().slice(0, 300);
  return (
    "Character appearance description: " +
    (who
      ? `${who}, exactly as in the reference image, keeping its look, colors and outfit.`
      : "the character in the reference image, keeping its exact look, colors and outfit.") +
    "\nBackground description: the background of the reference image."
  );
}

function numberOr(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function nextId(workflow: Workflow): () => string {
  let n = Math.max(
    0,
    ...Object.keys(workflow).map(Number).filter(Number.isFinite),
  );
  return () => String(++n);
}

export function buildWanAnimateWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];

  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${WAN_ANIMATE_ACTION}: source run has no video`);
  const photoRef =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (!parseInputRef(photoRef)) {
    throw new Error(
      `${WAN_ANIMATE_ACTION}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
    );
  }
  const videoId = Object.keys(workflow).find(
    (id) => workflow[id].class_type === "LoadVideo",
  );
  for (const [id, cls] of Object.entries(EXPECT)) {
    if (workflow[id]?.class_type !== cls || !videoId) {
      throw new Error(
        `${WAN_ANIMATE_ACTION}: workflow node ${id} should be ${cls} (graph out of sync)`,
      );
    }
  }

  setNodeInput(workflow, videoId!, "file", videoRef);
  setNodeInput(workflow, N.photo, "image", photoRef);
  setNodeInput(workflow, N.clipFrames, "length", WAN_ANIMATE_MAX_FRAMES);

  const dims = wanAnimateDims(sourceRun.width, sourceRun.height);
  for (const id of [N.clipResize, N.photoResize]) {
    setNodeInput(workflow, id, "resize_type.width", dims.width);
    setNodeInput(workflow, id, "resize_type.height", dims.height);
  }
  setNodeInput(workflow, N.animate, "width", dims.width);
  setNodeInput(workflow, N.animate, "height", dims.height);

  const character =
    typeof params.character === "string"
      ? params.character
      : typeof params.prompt === "string"
        ? params.prompt
        : undefined;
  setNodeInput(workflow, N.positive, "text", wanAnimatePrompt(character));

  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, N.sampler, "noise_seed", seed);

  const id = nextId(workflow);
  if (params.speed === "quality") {
    setNodeInput(workflow, N.unet, "unet_name", WAN_ANIMATE_FULL_UNET);
    const loraId = id();
    workflow[loraId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [N.unet, 0],
        lora_name: WAN_ANIMATE_LORA,
        strength_model: 1.0,
      },
      _meta: { title: "lightx2v Speed LoRA" },
    } as Workflow[string];
    setNodeInput(workflow, N.context, "model", [loraId, 0]);
    setNodeInput(workflow, N.scheduler, "steps", 6);
  } else {
    setNodeInput(workflow, N.unet, "unet_name", WAN_ANIMATE_DISTILL_UNET);
  }

  if (wanAnimateMode(params.mode) === "replace") {
    // Matte the generated character and paste it over the original frames.
    const bgModel = id();
    const matte = id();
    const grow = id();
    const size = id();
    const srcFrames = id();
    const comp = id();
    const add = (
      nid: string,
      class_type: string,
      inputs: Record<string, unknown>,
      title: string,
    ) => {
      workflow[nid] = {
        class_type,
        inputs,
        _meta: { title },
      } as Workflow[string];
    };
    add(
      bgModel,
      "LoadBackgroundRemovalModel",
      { bg_removal_name: WAN_ANIMATE_BG_MODEL },
      "BiRefNet",
    );
    add(
      matte,
      "RemoveBackground",
      { bg_removal_model: [bgModel, 0], image: [N.trimmed, 0] },
      "Character Matte",
    );
    add(
      grow,
      "GrowMask",
      { mask: [matte, 0], expand: 3, tapered_corners: true },
      "Grow Matte",
    );
    add(size, "GetImageSize", { image: [N.trimmed, 0] }, "Generated Size");
    add(
      srcFrames,
      "ImageFromBatch",
      { image: [N.clipResize, 0], batch_index: 0, length: [size, 2] },
      "Source Frames",
    );
    add(
      comp,
      "ImageCompositeMasked",
      {
        destination: [srcFrames, 0],
        source: [N.trimmed, 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: [grow, 0],
      },
      "Character Over Source",
    );
    setNodeInput(workflow, N.mux, "images", [comp, 0]);
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: N.positive,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: N.animate,
      imageInputId: N.photo,
    },
    seed,
  };
}
