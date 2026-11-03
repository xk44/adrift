import { pickFinalOutput } from "./pickOutput";
import type { ImagineRun } from "@/types";
import { ToolApiError, type ToolImage } from "./runTool";
import { promptIdOf, waitForOutputs, type RunnerDeps } from "./pipelineRunner";
import { avatarImagePrompt, type AvatarPreset } from "./avatarPresets";

/**
 * Generate the avatar portrait (text-to-image) and hand it back as a gallery
 * source image for the talking step.
 */
export async function generateAvatar(
  deps: RunnerDeps,
  preset: AvatarPreset,
  extra?: string,
): Promise<ToolImage> {
  const res = await deps.fetchImpl("/api/jobs/imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: avatarImagePrompt(preset, extra),
      client_id: deps.clientId,
      batch_size: 1,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    runs?: ImagineRun[];
    error?: string;
  };
  if (!res.ok)
    throw new ToolApiError(data.error ?? `Request failed (${res.status})`);
  const run = data.runs?.[0];
  if (!run) throw new ToolApiError("Server returned no run");
  deps.onRun?.(run);
  const out = await waitForOutputs(deps, promptIdOf(run));
  const file = pickFinalOutput(out.images);
  if (!file) throw new ToolApiError("The avatar finished without an image.");
  return {
    id: `avatar-${run.run_id}`,
    source: "gallery",
    previewUrl: file.url,
    label: preset.label,
    // 9:16 portrait; the talking step reads the real pixels server-side.
    width: 768,
    height: 1344,
    runId: run.run_id,
    jobIndex: run.jobs[0]?.index ?? 0,
  };
}
