/**
 * Relight "Match a reference" (packs/qwen-edit-2509/light_migration.json):
 * Qwen-Image-Edit-2509 + dx8152 Light-Migration LoRA + Lightning 4-step
 * (comfy.org workflow 4a4da321a45d). Picture 1 is the subject (the source
 * run's image), picture 2 the lighting reference (params.secondRefImage, an
 * uploaded "name.png [input]" ref). The positive prompt is the LoRA's fixed
 * Chinese instruction; optional details are appended after it, as the
 * template's notes ask.
 *
 * Face detail (params.faceDetail): "keep" (default) runs CJImagePasteBack
 * with SAM3 face protect in relight mode, so each face keeps the subject's
 * own detail under the new light; "model" removes the chain and saves the
 * raw edit.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { configurePasteBack } from "./imagePasteBack";

export const LIGHT_MIGRATION_ACTION = "light_migration";

/** The LoRA's instruction (keep verbatim; extra wording goes after it). */
export const LIGHT_MIGRATION_PROMPT =
  "参考色调，移除图1原有的光照并参考图2的光照和色调对图1重新照明";

export const LIGHT_MIGRATION_FACE_DETAIL = ["keep", "model"] as const;
export type LightMigrationFaceDetail =
  (typeof LIGHT_MIGRATION_FACE_DETAIL)[number];

/** Full positive prompt: the fixed instruction + optional details. */
export function lightMigrationPrompt(text: unknown): string {
  const extra = typeof text === "string" ? text.trim() : "";
  return extra ? `${LIGHT_MIGRATION_PROMPT}, ${extra}` : LIGHT_MIGRATION_PROMPT;
}

export function lightMigrationFaceDetail(
  value: unknown,
): LightMigrationFaceDetail {
  return value === "model" ? "model" : "keep";
}

type Link = [string, number];

function linkOf(v: unknown): Link | undefined {
  return Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
    ? [v[0], v[1]]
    : undefined;
}

/** Walk a ReferenceLatent chain back to the conditioning's text encoder. */
function encoderOf(workflow: Workflow, start: string | undefined) {
  let id = start;
  for (let hop = 0; id && hop < 6; hop++) {
    if (workflow[id]?.class_type !== "ReferenceLatent") break;
    id = linkOf(workflow[id].inputs.conditioning)?.[0];
  }
  return id && workflow[id]?.class_type === "TextEncodeQwenImageEditPlus"
    ? id
    : undefined;
}

/** LoadImage feeding an encoder image input (through the 1MP scale). */
function loadFor(
  workflow: Workflow,
  encoderId: string,
  input: "image1" | "image2",
): string | undefined {
  let id = linkOf(workflow[encoderId]?.inputs?.[input])?.[0];
  for (let hop = 0; id && hop < 3; hop++) {
    if (workflow[id]?.class_type === "LoadImage") return id;
    id = linkOf(workflow[id]?.inputs?.image)?.[0];
  }
  return undefined;
}

export function buildLightMigrationWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const subjectRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!subjectRef)
    throw new Error(`${LIGHT_MIGRATION_ACTION}: source run has no image`);
  const lightRef =
    typeof params.secondRefImage === "string"
      ? params.secondRefImage.trim()
      : "";
  if (!parseInputRef(lightRef)) {
    throw new Error(
      `${LIGHT_MIGRATION_ACTION}: a lighting reference (secondRefImage, "name.png [input]") is required`,
    );
  }

  const ksamplerId = Object.keys(workflow).find(
    (id) => workflow[id].class_type === "KSampler",
  );
  const posId = ksamplerId
    ? encoderOf(workflow, linkOf(workflow[ksamplerId].inputs.positive)?.[0])
    : undefined;
  const subjectId = posId ? loadFor(workflow, posId, "image1") : undefined;
  const lightId = posId ? loadFor(workflow, posId, "image2") : undefined;
  if (
    !ksamplerId ||
    !posId ||
    !subjectId ||
    !lightId ||
    subjectId === lightId
  ) {
    throw new Error(
      `${LIGHT_MIGRATION_ACTION}: workflow needs a KSampler and a TextEncodeQwenImageEditPlus positive with image1 = subject and image2 = light reference LoadImages`,
    );
  }
  setNodeInput(workflow, subjectId, "image", subjectRef);
  setNodeInput(workflow, lightId, "image", lightRef);
  setNodeInput(workflow, posId, "prompt", lightMigrationPrompt(params.text));

  configurePasteBack(workflow, {
    enabled: lightMigrationFaceDetail(params.faceDetail) === "keep",
    area: "",
    pose: false,
  });

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, ksamplerId, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId,
      posTextId: posId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: "",
      imageInputId: subjectId,
    },
    seed,
  };
}
