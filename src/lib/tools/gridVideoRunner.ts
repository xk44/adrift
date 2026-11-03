/**
 * Grid Video executor: upload the source (clip or still) + music, seed a
 * text-only run, queue grid_video with the refs + detected beats in params,
 * poll history. Same plumbing as the stitch / pipeline runners, so it runs
 * under vitest with a mock fetch.
 */
import { pickFinalOutput } from "./pickOutput";
import {
  ToolApiError,
  audioUploadName,
  uploadDataUrl,
  uploadName,
  videoUploadName,
} from "./runTool";
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
import {
  GRID_STYLE_INFO,
  gridVideoParams,
  type GridVideoInputs,
  type GridVideoOptions,
} from "./gridVideo";

export interface GridVideoSource {
  kind: "video" | "image";
  dataUrl: string;
  label: string;
  /** Clip length in seconds (null for a still / unknown). */
  seconds: number | null;
}

export interface GridVideoMusic {
  dataUrl: string;
  label: string;
  seconds: number;
  beats: number[];
  bpm: number | null;
}

export interface GridVideoResult {
  runId: string;
  video: StepOutput;
}

/** Friendlier error when ComfyUI lacks the custom node. */
export function gridVideoError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/CJGridVideo/.test(msg))
    return new ToolApiError(
      "Grid Video needs the CJGridVideo node (comfy_nodes/cj_h3_tools) on the ComfyUI box; restart ComfyUI after installing it.",
    );
  return e instanceof Error ? e : new ToolApiError(msg);
}

export async function runGridVideo(
  source: GridVideoSource,
  music: GridVideoMusic,
  opts: GridVideoOptions,
  deps: RunnerDeps,
): Promise<GridVideoResult> {
  try {
    const sourceRef = await uploadDataUrl(
      deps.fetchImpl,
      source.dataUrl,
      source.kind === "video"
        ? videoUploadName(source.label)
        : uploadName("cj_grid"),
    );
    const audioRef = await uploadDataUrl(
      deps.fetchImpl,
      music.dataUrl,
      audioUploadName(music.label),
    );
    const inputs: GridVideoInputs = {
      source: sourceRef,
      sourceKind: source.kind,
      sourceSeconds: source.kind === "video" ? source.seconds : null,
      audio: audioRef,
      audioSeconds: music.seconds,
      beats: music.beats,
      bpm: music.bpm,
    };
    let params: Record<string, unknown>;
    try {
      params = gridVideoParams(inputs, opts);
    } catch (e) {
      throw new ToolApiError(e instanceof Error ? e.message : String(e));
    }
    if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
    const src = await seedText(
      deps,
      `grid video: ${GRID_STYLE_INFO[opts.style].label.toLowerCase()}`,
    );
    const run = await action(deps, src, "grid_video", params);
    const out = await waitForOutputs(deps, promptIdOf(run));
    const video = await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "grid video"),
      "video",
    );
    return { runId: run.run_id, video };
  } catch (e) {
    throw gridVideoError(e);
  }
}
