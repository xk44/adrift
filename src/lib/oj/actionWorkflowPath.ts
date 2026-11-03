/**
 * Which graph file POST /api/jobs/action loads for an action: the client's
 * workflow_path, else the registry template resolved through the packs
 * (checkpoint / family / pack hints, video fallbacks). Shared by the route
 * and the golden graph snapshots so both resolve the same file.
 */
import path from "path";
import registry from "@/lib/oj/registry.json";
import { videoPacks } from "@/lib/comfy/backends";
import { defaultVideoPack } from "@/lib/oj/videoDefault";
import { VIDEO_EXPAND_ACTION, videoExpandTemplate } from "@/lib/oj/videoExpand";
import { resolveActionWorkflow } from "@/lib/oj/packs";
import { isUserToolSelection } from "@/lib/userTools/types";

const ACTION_TEMPLATE_MAP = registry.actions as Record<
  string,
  { template?: string }
>;

export function actionTemplate(action: string): string | undefined {
  return ACTION_TEMPLATE_MAP[action]?.template;
}

export function workflowFilePath(selection: string): string {
  if (
    selection.startsWith("saved:") ||
    isUserToolSelection(selection) ||
    path.isAbsolute(selection)
  ) {
    return selection;
  }
  return path.join(process.cwd(), "public/workflows", selection);
}

export function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveActionWorkflowPath(
  action: string,
  workflowPath?: string,
  params: Record<string, unknown> = {},
): string | undefined {
  const template = actionTemplate(action);
  if (!workflowPath && !template) return undefined;

  // Video templates the (default) pack lacks: the user's video model, then
  // LTX-2.5, then the video-backend pack list.
  const fallbackPacks =
    template === "i2v" || template === "t2v"
      ? [defaultVideoPack(stringParam(params.vmodel)), "ltx25", ...videoPacks()]
      : [];
  // Video Expand: one action, engine-specific graph (LTX unless "wan").
  const engineTemplate =
    action === VIDEO_EXPAND_ACTION
      ? videoExpandTemplate(params.engine)
      : undefined;
  const resolved = resolveActionWorkflow(
    {
      templateOrAction: engineTemplate ?? action,
      template: engineTemplate ?? template,
      userWorkflowPath: workflowPath,
      checkpointName:
        stringParam(params.model) ?? stringParam(params.checkpoint),
      modelFamily:
        stringParam(params.modelFamily) ?? stringParam(params.model_family),
      packId: stringParam(params.packId) ?? stringParam(params.pack_id),
    },
    fallbackPacks,
  );

  return workflowFilePath(resolved.workflowPath);
}
