/**
 * Server half of the first-run checklist: can Create's default graph find a
 * model on this ComfyUI? Pure over (workflow, object_info) so it is testable
 * without a backend; the route supplies both.
 */
import type { Workflow } from "@/types";
import { comboOptions } from "@/lib/comfy/validatePrompt";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import type { CheckState } from "@/lib/setup/firstRun";

/**
 * Loader inputs Create fills at submit time when the graph leaves them empty
 * (imagine route: COMFY_DEFAULT_CHECKPOINT, else the first checkpoint listed).
 */
const AUTOFILL_INPUTS: Record<string, [input: string, folder: string]> = {
  CheckpointLoaderSimple: ["ckpt_name", "checkpoints"],
  UNETLoader: ["unet_name", "diffusion_models"],
};

type NodeInfo = {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
};

function options(
  objectInfo: Record<string, unknown>,
  classType: string,
  input: string,
): string[] {
  const info = objectInfo[classType] as NodeInfo | undefined;
  const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
  if (!Array.isArray(spec)) return [];
  const opts = comboOptions(spec);
  return Array.isArray(opts) ? opts.map(String) : [];
}

const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();

export interface CreateModelAssessment {
  state: CheckState;
  using?: string;
  missing: string[];
}

export interface AssessOptions {
  /** COMFY_DEFAULT_CHECKPOINT. */
  preferredCheckpoint?: string;
  /** The model the user picked in Settings (store defaultModel). */
  pickedModel?: string;
}

/**
 * Will Create's default graph run on this ComfyUI as far as models and
 * nodes go? A user-picked model is checked on its own (any checkpoint or
 * diffusion-model list may hold it); otherwise empty loader inputs need the
 * preferred checkpoint, or at least one file in their folder.
 */
export function assessCreateModel(
  workflow: Workflow,
  objectInfo: Record<string, unknown>,
  opts: AssessOptions = {},
): CreateModelAssessment {
  const picked = opts.pickedModel?.trim();
  if (picked) {
    const all = [
      ...options(objectInfo, "CheckpointLoaderSimple", "ckpt_name"),
      ...options(objectInfo, "UNETLoader", "unet_name"),
    ];
    const hit = all.find((o) => norm(o) === norm(picked));
    return hit
      ? { state: "ok", using: hit, missing: [] }
      : { state: "fail", missing: [`checkpoints/${picked}`] };
  }

  const missing = missingAgainstObjectInfo(workflow, objectInfo);
  let using: string | undefined;
  for (const node of Object.values(workflow)) {
    const auto = node?.class_type ? AUTOFILL_INPUTS[node.class_type] : null;
    if (!auto) continue;
    const [input, folder] = auto;
    const value = node.inputs?.[input];
    if (typeof value === "string" && value.trim()) {
      using ??= value;
      continue;
    }
    if (!(node.class_type in objectInfo)) continue; // already "node:<Class>"
    const list = options(objectInfo, node.class_type, input);
    const preferred =
      node.class_type === "CheckpointLoaderSimple"
        ? opts.preferredCheckpoint?.trim()
        : undefined;
    if (preferred) {
      const hit = list.find((o) => norm(o) === norm(preferred));
      if (hit) using ??= hit;
      else missing.push(`${folder}/${preferred}`);
    } else if (list.length > 0) {
      using ??= list[0];
    } else {
      missing.push(`${folder}/*`);
    }
  }
  return {
    state: missing.length === 0 ? "ok" : "fail",
    ...(using ? { using } : {}),
    missing,
  };
}
