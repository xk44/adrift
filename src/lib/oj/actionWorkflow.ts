/**
 * Pure "action → final API-format prompt graph" step of POST /api/jobs/action:
 * custom builder (or the generic buildActionWorkflow), mask slots, then
 * workflow-control overrides — exactly what the route queues, minus I/O.
 * No fs, no network, no queueing: the caller loads the base graph and
 * resolves the source run / mask ref. Used by the route itself and by its
 * dry_run mode (ComfyUI overlay "Send to graph" for any action tool).
 */

import type { ImagineRun, Workflow } from "@/types";
import { actionBuilderFor } from "./actionBuilders";
import { buildActionWorkflow } from "./engine";
import { applyControlOverrides } from "./workflowControlSchema";
import { applyActionMask } from "@/lib/comfy/actionMask";
import {
  getSlotById,
  normalizeWorkflowActionId,
} from "@/lib/workflowAssignments";
import { applyUpscaleFinish } from "@/lib/upscale/upscaleFinish";
import {
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_SUBTLE_ACTION,
} from "@/lib/upscale/upscaleModels";
import { SEEDVR2_UPSCALE_ACTION } from "./seedvr2Upscale";
import { VOSR2_UPSCALE_ACTION } from "./vosr2Upscale";

/** Image upscalers that take the sharpen / strength finishing pass. */
export const UPSCALE_FINISH_ACTIONS = new Set<string>([
  UPSCALE_SUBTLE_ACTION,
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_REDETAIL_ACTION,
  SEEDVR2_UPSCALE_ACTION,
  VOSR2_UPSCALE_ACTION,
]);

export interface ActionWorkflowContext {
  /** Base graph for the action, already loaded (API format). Not mutated. */
  baseWorkflow: Workflow;
  /** Run whose job feeds the action (seeded upload or a finished run). */
  sourceRun: ImagineRun;
  /** Job of `sourceRun` to act on (default 0). */
  sourceJobIndex?: number;
  /** Mask slot node ids (checkActionMask) and the uploaded mask ref. */
  maskSlotIds?: string[];
  maskRef?: string;
  /** `${nodeId}.${input}` overrides; applied last (explicit wins). */
  overrides?: Record<string, unknown>;
}

export interface BuiltActionWorkflow {
  workflow: Workflow;
  seed: number;
  /** Canonical action id the graph was built for. */
  action: string;
  /** Which builder produced it. */
  builder: "custom" | "generic";
}

/**
 * Canonical action id, as the route resolves it: slot ids
 * ("single.vary_subtle") map to their legacy action, UI aliases
 * ("zoom_out_1_5x") to registry keys.
 */
export function canonicalActionId(action: string): string {
  if (!action.includes(".")) return normalizeWorkflowActionId(action);
  const slot = getSlotById(action);
  return normalizeWorkflowActionId(
    slot?.legacyActionId ?? action.split(".").pop() ?? action,
  );
}

/**
 * Build the final API-format workflow for any action tool without
 * submitting it. `action` should already be canonical (see
 * canonicalActionId); `params` are the /api/jobs/action body params.
 */
export function buildWorkflowForAction(
  action: string,
  params: Record<string, unknown>,
  ctx: ActionWorkflowContext,
): BuiltActionWorkflow {
  const jobIndex = ctx.sourceJobIndex ?? 0;
  const custom = actionBuilderFor(action);
  const built = custom
    ? custom(ctx.baseWorkflow, ctx.sourceRun, jobIndex, params)
    : buildActionWorkflow(
        ctx.baseWorkflow,
        action,
        ctx.sourceRun,
        jobIndex,
        params,
      );
  const workflow = built.workflow;
  if (UPSCALE_FINISH_ACTIONS.has(action)) applyUpscaleFinish(workflow, params);
  if (ctx.maskRef && ctx.maskSlotIds?.length) {
    applyActionMask(workflow, ctx.maskSlotIds, ctx.maskRef, params);
  }
  const overrides = ctx.overrides ?? {};
  return {
    workflow:
      Object.keys(overrides).length > 0
        ? applyControlOverrides(workflow, overrides)
        : workflow,
    seed: built.seed,
    action,
    builder: custom ? "custom" : "generic",
  };
}
