/**
 * One-click "Upscale result" for a finished output (tool results, Lightbox):
 * Faithful for a still, the per-frame video upscale for a clip, both with the
 * user's default upscaler (or the page's per-run override for stills).
 */
import { upscaleActionParams } from "./upscalePrefs";
import { UPSCALE_SUBTLE_ACTION, VIDEO_UPSCALE_ACTION } from "./upscaleModels";

export type UpscaleResultKind = "image" | "video";

export function upscaleResultAction(kind: UpscaleResultKind): string {
  return kind === "video" ? VIDEO_UPSCALE_ACTION : UPSCALE_SUBTLE_ACTION;
}

/** /api/jobs/action body for upscaling job `jobIndex` of `runId`. */
export function upscaleResultRequest(opts: {
  runId: string;
  jobIndex: number;
  kind: UpscaleResultKind;
  clientId: string;
  workflowPath?: string;
}): Record<string, unknown> {
  const action = upscaleResultAction(opts.kind);
  return {
    run_id: opts.runId,
    job_index: opts.jobIndex,
    action,
    client_id: opts.clientId,
    ...(opts.workflowPath ? { workflow_path: opts.workflowPath } : {}),
    params: upscaleActionParams(action) ?? {},
  };
}
