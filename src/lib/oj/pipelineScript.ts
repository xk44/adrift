/**
 * pipeline_script (packs/pipeline/script.json): the LLM step of the Shorts
 * Studio / Click to Ad pipelines. Core TextGenerate on Qwen3-VL 8B writes
 * the scene list as JSON (prompt compiled by scriptPrompt in
 * src/lib/tools/pipelines.ts from structured params, so the client can't
 * smuggle a free-form prompt past the length caps). The source run's first
 * image, when it has one (Click to Ad: the product photo), is wired into
 * TextGenerate's image input; text-only sources drop the LoadImage node.
 * Output: one text (PreviewAny) the client reads from /api/comfy/history.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import {
  SCRIPT_SCENES,
  clampScenes,
  scriptPrompt,
  type PipelineKind,
} from "@/lib/tools/pipelines";

export const PIPELINE_SCRIPT_ACTION = "pipeline_script";
/** Generation budget: ~8 scenes of JSON fit comfortably. */
export const PIPELINE_SCRIPT_MAX_TOKENS = 1536;
export const PIPELINE_SCRIPT_MODEL = "qwen3vl_8b_bf16.safetensors";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireNode(workflow: Workflow, classType: string): string {
  const id = Object.keys(workflow).find(
    (k) => workflow[k]?.class_type === classType,
  );
  if (!id)
    throw new Error(`${PIPELINE_SCRIPT_ACTION}: workflow needs ${classType}`);
  return id;
}

function seedFrom(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

export function buildPipelineScriptWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = PIPELINE_SCRIPT_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const kindParam = text(params.kind) || "shorts";
  if (kindParam !== "shorts" && kindParam !== "ad") {
    throw new Error(`${A}: unknown kind "${kindParam}"`);
  }
  const kind = kindParam as PipelineKind;
  const topic = text(params.topic);
  const imageRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (kind === "shorts" && !topic)
    throw new Error(`${A}: describe the topic first`);
  if (kind === "ad" && !imageRef)
    throw new Error(`${A}: add the product photo first`);

  const genId = requireNode(workflow, "TextGenerate");
  const loadId = requireNode(workflow, "LoadImage");
  requireNode(workflow, "CLIPLoader");
  requireNode(workflow, "PreviewAny");

  const prompt = scriptPrompt({
    kind,
    topic,
    scenes: clampScenes(params.scenes ?? SCRIPT_SCENES.default),
    preset: text(params.preset),
    presenter: params.presenter === true,
  });
  const seed = seedFrom(params.seed);
  setNodeInput(workflow, genId, "prompt", prompt);
  setNodeInput(workflow, genId, "max_length", PIPELINE_SCRIPT_MAX_TOKENS);
  setNodeInput(workflow, genId, "sampling_mode.seed", seed);
  if (imageRef) {
    setNodeInput(workflow, loadId, "image", imageRef);
  } else {
    delete workflow[genId].inputs.image;
    delete workflow[loadId];
  }
  return {
    workflow,
    slots: {
      ksamplerId: genId,
      posTextId: genId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: "",
      ...(imageRef ? { imageInputId: loadId } : {}),
    },
    seed,
  };
}
