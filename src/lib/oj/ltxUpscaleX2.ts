/**
 * Upscale video, engine "LTX x2" (packs/ltx25/upscale_x2.json): Lightricks'
 * LTX-2.5 Pixel Spatial Upscaler x2 IC-LoRA on the distilled LTX-2.5 22B,
 * core ComfyUI nodes only, wired like the LTX VFX IC-LoRA tools. The source
 * clip is the in-context reference at half the output's linear size
 * (reference_downscale_factor 2), so the output is always 2x a /32 fit of
 * the source (longer side at most 960 in, 1920 out). Sizing, 8n+1 padding,
 * the cut back to the source length and context windows for long clips all
 * happen in-graph; the builder sets the source and the seed.
 * License: LTX-2 / LTX-2.x Community License (gated on Hugging Face).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const LTX_UPSCALE_X2_ACTION = "ltx_upscale_x2";

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildLtxUpscaleX2Workflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const ref = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!ref)
    throw new Error(`${LTX_UPSCALE_X2_ACTION}: source run has no video`);

  const load = nodeIdOf(workflow, "LoadVideo");
  const noise = nodeIdOf(workflow, "RandomNoise");
  const guide = nodeIdOf(workflow, "LTXVAddGuide");
  const cond = nodeIdOf(workflow, "LTXVConditioning");
  const pos = cond ? workflow[cond].inputs.positive : undefined;
  const neg = cond ? workflow[cond].inputs.negative : undefined;
  if (
    !load ||
    !noise ||
    !guide ||
    !Array.isArray(workflow[guide].inputs.iclora_parameters) ||
    !Array.isArray(pos) ||
    !Array.isArray(neg)
  ) {
    throw new Error(
      `${LTX_UPSCALE_X2_ACTION}: workflow needs LoadVideo, RandomNoise, LTXVAddGuide (with IC-LoRA parameters) and LTXVConditioning (wired prompts)`,
    );
  }

  setNodeInput(workflow, load, "file", ref);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(Math.abs(params.seed))
      : typeof job?.seed === "number"
        ? job.seed
        : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, noise, "noise_seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: String(pos[0]),
      posTextInputName: "text",
      negTextId: String(neg[0]),
      latentDimsId: "",
      imageInputId: load,
    },
    seed,
  };
}
