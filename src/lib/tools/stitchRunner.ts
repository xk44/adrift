/**
 * Stitch clips executor: text-only seed run -> stitch_clips (refs in params)
 * -> history polling, same plumbing as the pipeline runner, so it runs under
 * vitest with a mock fetch.
 *
 * Reusable: Cinema multi-shot / Board lanes pass the StepOutputs (ref, url,
 * seconds) of finished shots in timeline order.
 */
import { pickFinalOutput } from "./pickOutput";
import { ToolApiError } from "./runTool";
import {
  action,
  measured,
  outputOf,
  promptIdOf,
  seedText,
  waitForOutputs,
  type RunnerDeps,
} from "./pipelineRunner";
import type { StepOutput } from "./pipelines";
import { mp4VideoFps } from "@/lib/videoFps";
import {
  STITCH_CLIPS_ACTION,
  STITCH_SOURCE_FPS,
  stitchParams,
  type StitchClip,
  type StitchOptions,
} from "./stitchClips";

export interface StitchResult {
  runId: string;
  video: StepOutput;
}

/** Fill unknown clip lengths from deps.measure (needs a playable url). */
export async function measureClips(
  clips: StitchClip[],
  deps: RunnerDeps,
): Promise<StitchClip[]> {
  return Promise.all(
    clips.map(async (c) => {
      if ((typeof c.seconds === "number" && c.seconds > 0) || !c.url) return c;
      const out = await measured(deps, { url: c.url, ref: c.ref }, "video");
      return { ...c, seconds: out.seconds ?? null };
    }),
  );
}

/** A clip's own fps read from its file (MP4 / MOV), null when unknown. */
export async function fetchClipFps(
  url: string,
  fetchFn: (url: string) => Promise<Response> = fetch,
): Promise<number | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return mp4VideoFps(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fill the first clip's fps when the run copies it ("source"). */
export async function withSourceClipFps(
  clips: StitchClip[],
  opts: StitchOptions,
  probeFps: (url: string) => Promise<number | null>,
): Promise<StitchClip[]> {
  const first = clips[0];
  if (opts.fps !== STITCH_SOURCE_FPS || !first?.url) return clips;
  if (typeof first.fps === "number" && first.fps > 0) return clips;
  const fps = await probeFps(first.url);
  return [{ ...first, fps }, ...clips.slice(1)];
}

export async function runStitch(
  clips: StitchClip[],
  opts: StitchOptions,
  deps: RunnerDeps,
  probeFps: (url: string) => Promise<number | null> = fetchClipFps,
): Promise<StitchResult> {
  const known = await measureClips(
    await withSourceClipFps(clips, opts, probeFps),
    deps,
  );
  let params: Record<string, unknown>;
  try {
    params = stitchParams(known, opts);
  } catch (e) {
    throw new ToolApiError(e instanceof Error ? e.message : String(e));
  }
  if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
  const src = await seedText(deps, "stitch clips");
  const run = await action(deps, src, STITCH_CLIPS_ACTION, params);
  const out = await waitForOutputs(deps, promptIdOf(run));
  const video = await measured(
    deps,
    outputOf(pickFinalOutput(out.videos), "stitched clip"),
    "video",
  );
  return { runId: run.run_id, video };
}
