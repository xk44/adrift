/**
 * "Remove video background" (packs/utility/video_bg_remove.json): core
 * ComfyUI nodes only. BiRefNet masks every frame of the source clip and the
 * background is either filled with a solid chroma colour (mp4 via SaveVideo,
 * source audio + fps kept; H.264 carries no alpha) or, with
 * `background: "alpha"`, cut out to an RGBA animated PNG (SaveAnimatedPNG, no
 * audio). The graph carries both branches; the builder drops the unused one.
 * No sampler, prompt or seed.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow, comfyImageRefFromViewUrl, setNodeInput } from "./engine";

export const VIDEO_BG_REMOVE_ACTION = "video_bg_remove";

/** Chroma colours (EmptyImage `color`, 0xRRGGBB); first = default. */
export const VIDEO_BG_COLORS: Record<string, number> = {
  green: 0x00ff00,
  blue: 0x0000ff,
  black: 0x000000,
  white: 0xffffff,
};

export function isAlphaBackground(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["alpha", "transparent", "none"].includes(value.trim().toLowerCase())
  );
}

export function videoBgColor(value: unknown): number {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VIDEO_BG_COLORS[key] ?? VIDEO_BG_COLORS.green;
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildVideoBgRemoveWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) {
    throw new Error(`${VIDEO_BG_REMOVE_ACTION}: source run has no video`);
  }
  const videoId = nodeIdOf(workflow, "LoadVideo");
  if (!videoId || !nodeIdOf(workflow, "RemoveBackground")) {
    throw new Error(
      `${VIDEO_BG_REMOVE_ACTION}: workflow needs LoadVideo and RemoveBackground`,
    );
  }
  setNodeInput(workflow, videoId, "file", videoRef);

  // Two output branches share LoadVideo → RemoveBackground → InvertMask:
  // chroma = EmptyImage/ImageCompositeMasked/CreateVideo/SaveVideo,
  // alpha  = JoinImageWithAlpha/SaveAnimatedPNG. Keep exactly one.
  const chroma = ["EmptyImage", "ImageCompositeMasked", "CreateVideo", "SaveVideo"];
  const alpha = ["JoinImageWithAlpha", "SaveAnimatedPNG"];
  const wantAlpha = isAlphaBackground(params.background);
  if (wantAlpha && !nodeIdOf(workflow, "SaveAnimatedPNG")) {
    throw new Error(`${VIDEO_BG_REMOVE_ACTION}: workflow has no alpha (SaveAnimatedPNG) branch`);
  }
  for (const id of Object.keys(workflow)) {
    const cls = workflow[id]?.class_type;
    if (cls && (wantAlpha ? chroma : alpha).includes(cls)) delete workflow[id];
  }
  if (!wantAlpha) {
    const fillId = nodeIdOf(workflow, "EmptyImage");
    if (fillId) setNodeInput(workflow, fillId, "color", videoBgColor(params.background));
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: videoId,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
