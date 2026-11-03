/**
 * Default engines that run on a stock install.
 *
 * - Video: LTX-2.5 (see videoDefault.ts). Opt into another engine with
 *   --vmodel / --pack or CJ_DEFAULT_VIDEO_PACK.
 * - Animate Low/High: on an LTX-2.5 graph the motion level becomes a prompt
 *   hint (LTX has no frame-count knob tied to "motion"); any other video
 *   graph keeps the generic 49/97-frame path.
 * - Make 3D: TRELLIS.2 (packs/trellis2). TripoSR (root i23d.json) is hidden;
 *   a user-picked TripoSR graph still goes through the generic builder.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { buildActionWorkflow } from "./engine";
import { isLtx25Workflow } from "./ltx25";
import { LTX25_ANIMATE_PROMPT, buildLtx25AnimateWorkflow } from "./ltx25Tools";
import { buildMake3dTrellisWorkflow } from "./trellis3d";

export { DEFAULT_VIDEO_PACK, defaultVideoPack } from "./videoDefault";

export const ANIMATE_MOTION_HINTS = {
  low: "Subtle, gentle motion; the camera stays almost still.",
  high: "Bold, energetic motion with a moving camera.",
} as const;

type Motion = keyof typeof ANIMATE_MOTION_HINTS;

type BuildResult = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Builder for animate_low / animate_high. */
export function animateBuilder(action: string, motion: Motion) {
  return (
    baseWorkflow: Workflow,
    sourceRun: ImagineRun,
    sourceJobIndex: number,
    params: Record<string, unknown> = {},
  ): BuildResult => {
    if (!isLtx25Workflow(baseWorkflow)) {
      return buildActionWorkflow(
        baseWorkflow,
        action,
        sourceRun,
        sourceJobIndex,
        params,
      );
    }
    const base =
      text(params.prompt) || text(sourceRun.prompt) || LTX25_ANIMATE_PROMPT;
    return buildLtx25AnimateWorkflow(baseWorkflow, sourceRun, sourceJobIndex, {
      ...params,
      prompt: `${base} ${ANIMATE_MOTION_HINTS[motion]}`,
    });
  };
}

/** A TRELLIS.2 / Pixal3D image-to-3D graph (packs/trellis2). */
export function isTrellisWorkflow(workflow: Workflow): boolean {
  return Object.values(workflow).some(
    (n) =>
      n?.class_type === "Trellis2Conditioning" ||
      n?.class_type === "EmptyTrellis2LatentStructure",
  );
}

/** Builder for make_3d: TRELLIS.2 graphs get the Trellis builder. */
export function buildMake3dWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  return isTrellisWorkflow(baseWorkflow)
    ? buildMake3dTrellisWorkflow(baseWorkflow, sourceRun, sourceJobIndex, params)
    : buildActionWorkflow(
        baseWorkflow,
        "make_3d",
        sourceRun,
        sourceJobIndex,
        params,
      );
}
