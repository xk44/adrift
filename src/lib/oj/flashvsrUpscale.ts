/**
 * Upscale video, engine "FlashVSR" (packs/flashvsr/flashvsr_upscale.json):
 * FlashVSR v1.1 one-step video super-resolution on Wan2.1 T2V 1.3B through
 * ComfyUI-WanVideoWrapper's local nodes. The source frames are resized to the
 * target size (the model refines an already-upscaled clip), fitted to /16 and
 * padded to 4n+1 frames in-graph; the output is cut back to the source length
 * and muxed with the source fps and audio. Long clips run in context windows.
 * Size choices match Best (SeedVR2): 2x, 1080p, and 4K capped at 1080p.
 * The TCDecoder decodes every frame on the GPU at once with no tiling, so the
 * graph caps the clip at FLASHVSR_DECODE_PIXEL_FRAMES pixel-frames (240 frames
 * at 1080p); CreateVideo trims the audio to the kept frames.
 * "2x" is clamped in-graph so the short side stops at FLASHVSR_MAX_SHORT_SIDE:
 * the sampler's attention, not the decoder, is the limit there.
 * Weights: Apache-2.0 (FlashVSR v1.1, Wan2.1, umT5).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import {
  clampMultiplierToShortSide,
  seedvr2ResizeInputs,
  seedvr2Scale,
} from "./seedvr2Upscale";

export const FLASHVSR_UPSCALE_ACTION = "flashvsr_upscale";

/** Width x height x frames the template keeps (its "Frame cap" node). */
export const FLASHVSR_DECODE_PIXEL_FRAMES = 497_664_000;

/**
 * Short side "2x" stops at. Measured on a 24 GB 4090: 2560x1440 runs (135
 * frames, 270 s); 3840x2112 OOMs in WanVideoSampler even under the
 * pixel-frame cap, which only protects the decoder.
 */
export const FLASHVSR_MAX_SHORT_SIDE = 1440;

/** ResizeImageMaskNode inputs for a size pick (clips cap at 1080p). */
export function flashvsrResizeInputs(
  scale: unknown,
): Record<string, string | number> {
  return seedvr2ResizeInputs(seedvr2Scale(scale), true);
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildFlashvsrUpscaleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const ref = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!ref)
    throw new Error(`${FLASHVSR_UPSCALE_ACTION}: source run has no video`);

  const load = nodeIdOf(workflow, "LoadVideo");
  const sampler = nodeIdOf(workflow, "WanVideoSampler");
  // The target-size resize; the other one only fits the result to /16.
  const resize = Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === "ResizeImageMaskNode" &&
      workflow[id].inputs.resize_type !== "scale to multiple",
  );
  const missing = [
    ["LoadVideo", load],
    ["WanVideoSampler", sampler],
    ["ResizeImageMaskNode (target size)", resize],
    [
      "WanVideoAddFlashVSRInput",
      nodeIdOf(workflow, "WanVideoAddFlashVSRInput"),
    ],
  ]
    .filter(([, id]) => !id)
    .map(([cls]) => cls);
  if (missing.length) {
    throw new Error(
      `${FLASHVSR_UPSCALE_ACTION}: workflow is missing ${missing.join(", ")}`,
    );
  }

  setNodeInput(workflow, load!, "file", ref);
  const inputs = workflow[resize!].inputs;
  for (const key of Object.keys(inputs)) {
    if (key.startsWith("resize_type")) delete inputs[key];
  }
  Object.assign(inputs, flashvsrResizeInputs(params.scale));
  // "2x" = min(2, 1440 / source short side): 2x on <=720p clips, 1440p above.
  clampMultiplierToShortSide(workflow, resize!, FLASHVSR_MAX_SHORT_SIDE);

  const seed = typeof job?.seed === "number" ? job.seed : 0;
  setNodeInput(workflow, sampler!, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: sampler!,
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: load!,
    },
    seed,
  };
}
