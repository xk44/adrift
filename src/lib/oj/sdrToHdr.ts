/**
 * SDR to HDR (packs/image-tools/sdr_to_hdr.json): core ImageSDRToHDR turns
 * an sRGB image into HLG-encoded Rec.2020, then two core SaveImageAdvanced
 * nodes write a 10-bit HLG AVIF (the job image) and a scene-linear EXR
 * master (adrift_master/, a download). No models.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const SDR_TO_HDR_ACTION = "sdr_to_hdr";

/** ImageSDRToHDR target_luminance: default, and the node's range (nits). */
export const SDR_TO_HDR_DEFAULT_PEAK = 650;
export const SDR_TO_HDR_MAX_PEAK = 10000;

export const SDR_TO_HDR_EXR_DEPTHS: Record<string, string> = {
  half: "16-bit float",
  float: "32-bit float",
};

/** Peak-white target in nits, clamped to the node range; 0 = calibrated. */
export function sdrToHdrPeak(value: unknown): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n))
    return SDR_TO_HDR_DEFAULT_PEAK;
  return Math.round(Math.min(SDR_TO_HDR_MAX_PEAK, Math.max(0, n)));
}

export function sdrToHdrExrDepth(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  return SDR_TO_HDR_EXR_DEPTHS[key] ?? SDR_TO_HDR_EXR_DEPTHS.half;
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === classType)
    .sort((a, b) => Number(a) - Number(b));
}

export function buildSdrToHdrWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${SDR_TO_HDR_ACTION}: source run has no image`);
  const [loadId] = nodeIdsOf(workflow, "LoadImage");
  const [hdrId] = nodeIdsOf(workflow, "ImageSDRToHDR");
  if (!loadId || !hdrId)
    throw new Error(
      `${SDR_TO_HDR_ACTION}: workflow needs LoadImage and ImageSDRToHDR`,
    );
  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(workflow, hdrId, "algorithm", "lottes");
  setNodeInput(
    workflow,
    hdrId,
    "algorithm.target_luminance",
    sdrToHdrPeak(params.peak),
  );
  const depth = sdrToHdrExrDepth(params.exr);
  for (const id of nodeIdsOf(workflow, "SaveImageAdvanced")) {
    if (workflow[id].inputs?.format === "exr")
      setNodeInput(workflow, id, "format.bit_depth", depth);
  }
  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed: 0,
  };
}
