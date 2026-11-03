/**
 * FIBO 2.0 Edit (Bria, CC-BY-NC-4.0): packs/fibo2/edit.json (Edit Turbo,
 * 4 steps CFG 1) and edit_dev.json (Dev, 30 steps CFG 5).
 *
 * TextEncodeFibo2 grounds the instruction on the source image and emits
 * positive / negative / latent (~1 MP for the source aspect, centre-cropped).
 * Both graphs end in CJImagePasteBack (fit crop) onto the original LoadImage,
 * so the result keeps the original's resolution and its pixels outside the
 * edit. Params:
 *   prompt        edit instruction (required)
 *   negativePrompt optional
 *   pasteBack     default on; false/"off" removes the paste-back chain
 *   pasteBackArea SAM3 text for the region ("the umbrella"); empty = diff-only
 *                 (region SAM node pruned, faces still protected)
 *   pasteBackPose pose change: subject = SAM3 "person" on the original +
 *                 new_content = SAM3 "person" on the edit (default off = pruned)
 *   seed          optional
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { configurePasteBack, pasteBackRequest } from "./imagePasteBack";

export const FIBO_EDIT_ACTION = "edit_fibo";
export const FIBO_EDIT_DEV_ACTION = "edit_fibo_dev";

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildFiboEditWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!imageRef)
    throw new Error(`${FIBO_EDIT_ACTION}: source run has no image`);
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt)
    throw new Error(`${FIBO_EDIT_ACTION}: an edit instruction is required`);

  const encId = nodeIdOf(workflow, "TextEncodeFibo2");
  const ksamplerId = nodeIdOf(workflow, "KSampler");
  const enc = encId ? workflow[encId] : undefined;
  const src = enc?.inputs["images.image_1"];
  const loadId = Array.isArray(src) ? (src[0] as string) : undefined;
  if (
    !encId ||
    !ksamplerId ||
    !loadId ||
    workflow[loadId]?.class_type !== "LoadImage"
  )
    throw new Error(
      `${FIBO_EDIT_ACTION}: workflow needs TextEncodeFibo2 (images.image_1 = LoadImage) and KSampler`,
    );

  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(workflow, encId, "prompt", prompt);
  setNodeInput(
    workflow,
    encId,
    "negative_prompt",
    typeof params.negativePrompt === "string"
      ? params.negativePrompt.trim()
      : "",
  );
  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, ksamplerId, "seed", seed);

  configurePasteBack(workflow, pasteBackRequest(params, true));

  return {
    workflow,
    slots: {
      ksamplerId,
      posTextId: encId,
      posTextInputName: "prompt",
      negTextId: encId,
      negTextInputName: "negative_prompt",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed,
  };
}
