/**
 * cj_image_tools actions (packs/image-tools/*):
 *
 * - "vectorize": CJVectorize traces the image into an SVG (OpenCV tracer,
 *   vtracer when installed). The preview PNG is the job image; the .svg is a
 *   file output (ui key "svg") offered as a download.
 * - "breakdown": one CLIPTextEncode + SAM3_Detect (individual_masks) per
 *   part, all feeding CJCutouts, which dedupes overlapping instances and
 *   saves a labelled contact sheet plus one RGBA cutout per instance.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const VECTORIZE_ACTION = "vectorize";
export const BREAKDOWN_ACTION = "breakdown";

export const VECTORIZE_PRESETS = ["logo", "illustration", "poster"] as const;
export type VectorizePreset = (typeof VECTORIZE_PRESETS)[number];

export const BREAKDOWN_DEFAULT_PARTS =
  "person, clothing, bag, background objects";
export const BREAKDOWN_MAX_PARTS = 8;
/** Max detections per part when the user gives no ":N" suffix. */
export const BREAKDOWN_DEFAULT_PER_PART = 4;

export function vectorizePreset(value: unknown): VectorizePreset {
  return (VECTORIZE_PRESETS as readonly unknown[]).includes(value)
    ? (value as VectorizePreset)
    : "logo";
}

/** 0 = the preset's own palette size; otherwise 2..64. */
export function vectorizeColors(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(64, Math.max(2, Math.round(n)));
}

export function vectorizeDetail(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(0.25, n));
}

export interface BreakdownPart {
  /** Display name (no ":N"). */
  label: string;
  /** SAM3 prompt text, always with a ":N" max-detections suffix. */
  prompt: string;
}

/** "person, bag:2, x" -> sanitized parts (max 8, deduped, default list when empty). */
export function breakdownParts(value: unknown): BreakdownPart[] {
  const raw =
    typeof value === "string" && value.trim() ? value : BREAKDOWN_DEFAULT_PARTS;
  const seen = new Set<string>();
  const out: BreakdownPart[] = [];
  for (const piece of raw.split(/[,\n;]/)) {
    const m = piece.trim().match(/^(.*?)(?::\s*(\d+))?$/);
    const label = (m?.[1] ?? "")
      .replace(/[^A-Za-z0-9 _\-/&']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28)
      .trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const n = m?.[2]
      ? Math.min(16, Math.max(1, Number(m[2])))
      : BREAKDOWN_DEFAULT_PER_PART;
    out.push({ label, prompt: `${label}:${n}` });
    if (out.length >= BREAKDOWN_MAX_PARTS) break;
  }
  return out.length ? out : breakdownParts(BREAKDOWN_DEFAULT_PARTS);
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === classType)
    .sort((a, b) => Number(a) - Number(b));
}

function sourceImageRef(
  action: string,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
): string {
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${action}: source run has no image`);
  return imageRef;
}

const noSampler = (imageInputId: string): WorkflowSlots => ({
  ksamplerId: "",
  posTextId: "",
  posTextInputName: "text",
  negTextId: "",
  latentDimsId: "",
  imageInputId,
});

export function buildVectorizeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageRef = sourceImageRef(VECTORIZE_ACTION, sourceRun, sourceJobIndex);
  const [loadId] = nodeIdsOf(workflow, "LoadImage");
  const [vecId] = nodeIdsOf(workflow, "CJVectorize");
  if (!loadId || !vecId) {
    throw new Error(
      `${VECTORIZE_ACTION}: workflow needs LoadImage and CJVectorize`,
    );
  }
  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(workflow, vecId, "preset", vectorizePreset(params.preset));
  setNodeInput(workflow, vecId, "colors", vectorizeColors(params.colors));
  setNodeInput(workflow, vecId, "detail", vectorizeDetail(params.detail));
  return { workflow, slots: noSampler(loadId), seed: 0 };
}

export function buildBreakdownWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageRef = sourceImageRef(BREAKDOWN_ACTION, sourceRun, sourceJobIndex);
  const [loadId] = nodeIdsOf(workflow, "LoadImage");
  const [cutId] = nodeIdsOf(workflow, "CJCutouts");
  const masks = cutId ? workflow[cutId].inputs.masks : undefined;
  const detId = Array.isArray(masks) ? String(masks[0]) : "";
  const cond = workflow[detId]?.inputs.conditioning;
  const textId = Array.isArray(cond) ? String(cond[0]) : "";
  if (
    !loadId ||
    !cutId ||
    workflow[detId]?.class_type !== "SAM3_Detect" ||
    workflow[textId]?.class_type !== "CLIPTextEncode"
  ) {
    throw new Error(
      `${BREAKDOWN_ACTION}: workflow needs LoadImage and CJCutouts whose masks come from SAM3_Detect(CLIPTextEncode)`,
    );
  }
  setNodeInput(workflow, loadId, "image", imageRef);

  const parts = breakdownParts(params.parts ?? params.text);
  setNodeInput(workflow, textId, "text", parts[0].prompt);
  let next =
    Math.max(...Object.keys(workflow).map(Number).filter(Number.isFinite)) + 1;
  for (let i = 1; i < parts.length; i++) {
    const t = String(next++);
    const d = String(next++);
    workflow[t] = JSON.parse(JSON.stringify(workflow[textId]));
    workflow[t].inputs.text = parts[i].prompt;
    workflow[d] = JSON.parse(JSON.stringify(workflow[detId]));
    workflow[d].inputs.conditioning = [t, 0];
    workflow[cutId].inputs[`masks_${i + 1}`] = [d, 0];
  }
  setNodeInput(workflow, cutId, "labels", parts.map((p) => p.label).join(", "));
  return { workflow, slots: noSampler(loadId), seed: 0 };
}
