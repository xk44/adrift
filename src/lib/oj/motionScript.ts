/**
 * motion_script (packs/pipeline/script.json, reused): the AI step of the
 * Motion Designer tool. Core TextGenerate on Qwen3-VL 8B — the same model and
 * graph pipeline_script uses, no new weights — writes a short scene outline
 * as JSON. The prompt is compiled here from structured params (brief, scene
 * count, tone) by motionPrompt, so the client can't send a free-form prompt.
 * The image input is never used: LoadImage is dropped.
 * Output: one text (PreviewAny) the client reads from /api/comfy/history and
 * compiles into a MotionSpec in the browser (src/lib/motion/templates.ts).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow, setNodeInput } from "./engine";
import {
  clampMotionScenes,
  cleanBrief,
  motionPrompt,
} from "@/lib/motion/prompt";

export const MOTION_SCRIPT_ACTION = "motion_script";
/** ~10 outline scenes of JSON fit comfortably. */
export const MOTION_SCRIPT_MAX_TOKENS = 1400;

function requireNode(workflow: Workflow, classType: string): string {
  const id = Object.keys(workflow).find(
    (k) => workflow[k]?.class_type === classType,
  );
  if (!id)
    throw new Error(`${MOTION_SCRIPT_ACTION}: workflow needs ${classType}`);
  return id;
}

function seedFrom(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

export function buildMotionScriptWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const brief = cleanBrief(params.brief);
  if (!brief)
    throw new Error(`${MOTION_SCRIPT_ACTION}: describe the video first`);
  const workflow = cloneWorkflow(baseWorkflow);
  const genId = requireNode(workflow, "TextGenerate");
  requireNode(workflow, "CLIPLoader");
  requireNode(workflow, "PreviewAny");
  const prompt = motionPrompt({
    brief,
    scenes: clampMotionScenes(params.scenes),
    tone: typeof params.tone === "string" ? params.tone : undefined,
    whiteboard: params.whiteboard === true,
  });
  const seed = seedFrom(params.seed);
  setNodeInput(workflow, genId, "prompt", prompt);
  setNodeInput(workflow, genId, "max_length", MOTION_SCRIPT_MAX_TOKENS);
  setNodeInput(workflow, genId, "sampling_mode.seed", seed);
  delete workflow[genId].inputs.image;
  for (const id of Object.keys(workflow)) {
    if (workflow[id]?.class_type === "LoadImage") delete workflow[id];
  }
  return {
    workflow,
    slots: {
      ksamplerId: genId,
      posTextId: genId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: "",
    },
    seed,
  };
}
