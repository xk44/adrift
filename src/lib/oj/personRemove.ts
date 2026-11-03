/**
 * "Remove person from video" (packs/minimax/person_remove.json): the H3 Relay
 * Person Remover V1 recipe. SAM 3.1 finds the described person on frame 0
 * (text prompt), SAM3 tracks them through the clip, H3RelayGreenMask paints
 * them green (+16 px), and CJPersonRemoverAuto (cj_h3_tools: the
 * H3RelayPersonRemover window loop, MiniMax H3 Ref2VA + the
 * H3-Person-Remover-V1 LoRA, 12 steps, 22-frame windows with 18 frames of
 * history) rebuilds the background window by window. On real footage the
 * LoRA fails on roughly a third of windows at random (green fill copied
 * through, or the person regrown), so each window passes a gate that
 * resamples it with a new seed, up to 4 attempts, before the next starts; a
 * window still green after that is patched from a warped clean frame.
 *
 * The remover rebuilds far more reliably when its prompt names the
 * background. Qwen3-VL 8B (TextGenerate) captions the clean first frame and
 * the node splices the caption in; params.background (typed by the user)
 * replaces the caption and drops that branch.
 *
 * The relay needs a clean copy of frame 0. By default the graph makes one
 * with Qwen-Image-Edit-2509 + Lightning (4 steps); an uploaded clean frame
 * (params.secondRefImage) replaces that branch.
 *
 * Limits (relay docs): trained on 24 fps clips with dims on the 32-px grid.
 * LabsH3PrepareVideo (h3-relay) resamples any source to 24 fps, sizes it to
 * ~0.5 MP and trims it to PERSON_REMOVE_MAX_FRAMES. The output is silent (the
 * source voice would still be the removed person's).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import {
  applySmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";

export const PERSON_REMOVE_ACTION = "person_remove";
export const PERSON_REMOVE_LORA = "H3-Person-Remover-V1.safetensors";
/** ~5.2 s at 24 fps: the relay docs' recommended clip length. */
export const PERSON_REMOVE_MAX_FRAMES = 124;
export const PERSON_REMOVE_MAX_SECONDS = 5.2;
export const PERSON_REMOVE_DEFAULT_TARGET = "person";

/** Fixed node ids in packs/minimax/person_remove.json. */
export const PR_NODES = {
  loadVideo: "7",
  /** LabsH3PrepareVideo: 24 fps, 480-class size, length cap. */
  prep: "29",
  samModel: "11",
  samText: "17",
  /** Text-prompted SAM3_Detect (frame 0) -> SAM3_VideoTrack -> SAM3_TrackToMask. */
  samDetect: "13",
  samTrack: "14",
  samMask: "15",
  remover: "18",
  /** Qwen-Image-Edit clean-frame branch. */
  qwenBranch: [
    "40",
    "41",
    "42",
    "43",
    "44",
    "45",
    "46",
    "47",
    "48",
    "49",
    "50",
    "51",
    "52",
    "53",
  ],
  qwenPrompt: "46",
  qwenSampler: "51",
  qwenResize: "53",
  /** Qwen3-VL caption of the clean frame -> remover "background". */
  bgCaption: "70",
  bgClip: "72",
  /** CLIPTextEncode("hand") -> remover part_cond: every-frame limb/ghost check. */
  partCond: "74",
  /** User clean-frame branch. */
  userImage: "54",
  userResize: "55",
} as const;

function cleanTarget(value: unknown): string {
  const t =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, 120)
      : "";
  return t || PERSON_REMOVE_DEFAULT_TARGET;
}

/** User-typed background description, or "" (use the auto caption). */
export function cleanBackground(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 300)
    : "";
}

/** Qwen-Image-Edit instruction that makes the clean first frame. */
export function cleanFramePrompt(target?: unknown): string {
  return (
    `Remove the ${cleanTarget(target)} and their shadow from the image completely and reconstruct the background behind them. ` +
    "Keep everything else in the image exactly the same."
  );
}

export function buildPersonRemoveWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${PERSON_REMOVE_ACTION}: source run has no video`);
  for (const id of [
    PR_NODES.loadVideo,
    PR_NODES.remover,
    PR_NODES.samText,
    PR_NODES.prep,
  ]) {
    if (!workflow[id])
      throw new Error(
        `${PERSON_REMOVE_ACTION}: workflow is missing node ${id}`,
      );
  }

  setNodeInput(workflow, PR_NODES.loadVideo, "file", videoRef);
  setNodeInput(
    workflow,
    PR_NODES.prep,
    "duration_seconds",
    PERSON_REMOVE_MAX_SECONDS,
  );

  const target = cleanTarget(params.target);
  setNodeInput(workflow, PR_NODES.samText, "text", target);

  // Smart select: clicked + tracked person replaces the text-prompted SAM branch.
  const clicks = occurrencesInWindow(
    parseSmartTrack(params.smartTrack),
    PERSON_REMOVE_MAX_SECONDS,
    PERSON_REMOVE_ACTION,
  );
  if (clicks.length > 0) {
    for (const id of [PR_NODES.samModel, PR_NODES.samMask]) {
      if (!workflow[id])
        throw new Error(
          `${PERSON_REMOVE_ACTION}: workflow is missing node ${id}`,
        );
    }
    applySmartTrack(workflow, {
      sourceVideo: [PR_NODES.loadVideo, 0],
      frames: [PR_NODES.prep, 0],
      width: [PR_NODES.prep, 2],
      height: [PR_NODES.prep, 3],
      samModel: [PR_NODES.samModel, 0],
      occurrences: clicks,
      replace: [PR_NODES.samMask, 0],
      remove: [PR_NODES.samDetect, PR_NODES.samTrack, PR_NODES.samMask],
    });
  }

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, PR_NODES.remover, "seed", seed);

  const cleanRef =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (cleanRef) {
    if (!parseInputRef(cleanRef))
      throw new Error(
        `${PERSON_REMOVE_ACTION}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
      );
    setNodeInput(workflow, PR_NODES.userImage, "image", cleanRef);
    setNodeInput(workflow, PR_NODES.remover, "clean_first_frame", [
      PR_NODES.userResize,
      0,
    ]);
    if (workflow[PR_NODES.bgCaption])
      setNodeInput(workflow, PR_NODES.bgCaption, "image", [
        PR_NODES.userResize,
        0,
      ]);
    for (const id of PR_NODES.qwenBranch) delete workflow[id];
  } else {
    setNodeInput(
      workflow,
      PR_NODES.qwenPrompt,
      "prompt",
      cleanFramePrompt(target),
    );
    setNodeInput(workflow, PR_NODES.qwenSampler, "seed", seed);
    setNodeInput(workflow, PR_NODES.remover, "clean_first_frame", [
      PR_NODES.qwenResize,
      0,
    ]);
    delete workflow[PR_NODES.userImage];
    delete workflow[PR_NODES.userResize];
  }

  const background = cleanBackground(params.background);
  if (background) {
    setNodeInput(workflow, PR_NODES.remover, "background", background);
    delete workflow[PR_NODES.bgCaption];
    delete workflow[PR_NODES.bgClip];
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: PR_NODES.samText,
      posTextInputName: "text",
      negTextId: "",
      latentDimsId: "",
      imageInputId: cleanRef ? PR_NODES.userImage : PR_NODES.loadVideo,
    },
    seed,
  };
}
