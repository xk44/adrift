/**
 * Remove video background, engine "One named subject"
 * (packs/matanyone/subject_matte.json): SAM 3.1 looks for the named subject on
 * 32 evenly spaced frames, and MatAnyone2 turns the mask from the first frame
 * they are clear in into a soft matte for the whole clip, forward and back, so
 * one person can be kept out of several, even if they walk in later. BiRefNet (videoBgRemove.ts) stays
 * the default: it needs no prompt and matches MatAnyone2 on a single subject.
 * Weights are non-commercial (S-Lab License 1.0). No sampler or seed.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow, comfyImageRefFromViewUrl, setNodeInput } from "./engine";
import { isAlphaBackground, videoBgColor } from "./videoBgRemove";

export const SUBJECT_MATTE_ACTION = "subject_matte";
export const SUBJECT_MATTE_DEFAULT = "person";

const CHROMA = ["EmptyImage", "ImageCompositeMasked", "CreateVideo", "SaveVideo"];
const ALPHA = ["JoinImageWithAlpha", "SaveAnimatedPNG"];

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildSubjectMatteWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) {
    throw new Error(`${SUBJECT_MATTE_ACTION}: source run has no video`);
  }
  const load = nodeIdOf(workflow, "LoadVideo");
  const text = nodeIdOf(workflow, "CLIPTextEncode");
  const matte = nodeIdOf(workflow, "MatAnyone2");
  if (!load || !text || !matte) {
    throw new Error(
      `${SUBJECT_MATTE_ACTION}: workflow needs LoadVideo, CLIPTextEncode and MatAnyone2`,
    );
  }
  setNodeInput(workflow, load, "file", videoRef);
  const subject = typeof params.subject === "string" ? params.subject.trim() : "";
  setNodeInput(workflow, text, "text", subject || SUBJECT_MATTE_DEFAULT);

  // Both output branches hang off the matte; keep exactly one.
  const wantAlpha = isAlphaBackground(params.background);
  for (const id of Object.keys(workflow)) {
    const cls = workflow[id]?.class_type;
    if (cls && (wantAlpha ? CHROMA : ALPHA).includes(cls)) delete workflow[id];
  }
  if (!wantAlpha) {
    const fill = nodeIdOf(workflow, "EmptyImage");
    if (fill) setNodeInput(workflow, fill, "color", videoBgColor(params.background));
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: text,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: "",
      imageInputId: load,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
