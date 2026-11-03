/**
 * Queues an "Upscale after" plan's steps on the parent run's jobs through
 * the same /api/jobs/action path as the Upscale and Upscale video runners.
 * Pure async over an injected fetch.
 */
import type { ImagineRun } from "@/types";
import { submitActionTool, ToolApiError, type FetchLike } from "@/lib/tools/runTool";
import { defaultSettings, getActionTool } from "@/lib/tools/toolsPage";
import type { UpscaleStep } from "./upscaleAfter";

export async function queueUpscaleSteps(
  parentRunId: string,
  steps: readonly UpscaleStep[],
  deps: {
    fetchImpl: FetchLike;
    clientId: string;
    onWarnings?: (warnings: string[]) => void;
    /** Each run as soon as it is queued (so a later failure keeps it). */
    onRun?: (run: ImagineRun) => void;
  },
): Promise<ImagineRun[]> {
  const out: ImagineRun[] = [];
  for (const step of steps) {
    const spec = getActionTool(step.toolId);
    if (!spec) throw new ToolApiError(`Unknown tool ${step.toolId}`);
    const run = await submitActionTool({
      fetchImpl: deps.fetchImpl,
      spec,
      settings: { ...defaultSettings(spec), picks: { ...step.picks } },
      editLoras: null,
      image: {
        id: `upscale-after:${parentRunId}:${step.jobIndex}`,
        source: "gallery",
        previewUrl: "",
        label: "Upscale after",
        width: 0,
        height: 0,
        runId: parentRunId,
        jobIndex: step.jobIndex,
      },
      secondImage: null,
      clientId: deps.clientId,
      onWarnings: deps.onWarnings,
    });
    deps.onRun?.(run);
    out.push(run);
  }
  return out;
}
