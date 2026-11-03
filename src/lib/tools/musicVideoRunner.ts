/**
 * Music video executor: upload the song + refs, seed one text-only run,
 * then queue the segments ONE AT A TIME (segment i+1 loads segment i's
 * last-frame sidecar, so they cannot overlap), then the assemble job.
 * Optional stems step (CJAudioStems) runs first when asked for. Same
 * plumbing as the grid / stitch runners, so it runs under vitest with a mock
 * fetch.
 */
import { pickFinalOutput } from "./pickOutput";
import {
  ToolApiError,
  audioUploadName,
  uploadDataUrl,
  uploadName,
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
  MUSIC_VIDEO_ACTION,
  MUSIC_VIDEO_ASSEMBLE_ACTION,
  MUSIC_VIDEO_STEMS_ACTION,
  MUSIC_VIDEO_STEMS_NODE,
  mvToken,
  segmentJobs,
  stemOf,
  type MvOptions,
  type MvPlan,
} from "./musicVideo";

export interface MvSong {
  dataUrl: string;
  label: string;
}

export interface MvStems {
  /** Window-relative stems (start at plan.start of the song). */
  drums: StepOutput | null;
  vocals: StepOutput | null;
  songRef: string;
}

export interface MvProgress {
  phase: "upload" | "stems" | "segment" | "assemble";
  /** Segment index (phase "segment"). */
  index?: number;
  total?: number;
  /** A finished segment clip. */
  clip?: StepOutput;
}

export interface MvResult {
  runId: string;
  video: StepOutput;
  segments: StepOutput[];
}

/** Friendlier errors for a missing node / pack. */
export function musicVideoError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (new RegExp(MUSIC_VIDEO_STEMS_NODE).test(msg))
    return new ToolApiError(
      "Stems need the CJAudioStems node (comfy_nodes/cj_stems) and models/demucs/hdemucs_high_trained.pt on the ComfyUI box.",
    );
  if (
    /MiniMaxH3|minimax_h3/.test(msg) &&
    /not found|does not exist|missing/i.test(msg)
  )
    return new ToolApiError(
      `Music video needs the MiniMax H3 pack models on the ComfyUI box (${msg.slice(0, 200)})`,
    );
  return e instanceof Error ? e : new ToolApiError(msg);
}

/** Upload the song once; reuse the ref for stems + render. */
export async function uploadSong(
  song: MvSong,
  deps: RunnerDeps,
): Promise<string> {
  return uploadDataUrl(
    deps.fetchImpl,
    song.dataUrl,
    audioUploadName(song.label),
  );
}

/** Split the song window into drums + vocals (optional step). */
export async function runMusicVideoStems(
  songRef: string,
  window: { start: number; seconds: number },
  deps: RunnerDeps,
): Promise<MvStems> {
  try {
    const src = await seedText(deps, "music video: stems");
    const run = await action(deps, src, MUSIC_VIDEO_STEMS_ACTION, {
      song: songRef,
      songStart: window.start,
      seconds: window.seconds,
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const pick = (which: "drums" | "vocals") => {
      const f = out.audios.find((a) => stemOf(a.filename) === which);
      return f ? outputOf(f, `${which} stem`) : null;
    };
    const drums = pick("drums");
    const vocals = pick("vocals");
    if (!drums && !vocals)
      throw new ToolApiError("The stems job saved no stems");
    return { drums, vocals, songRef };
  } catch (e) {
    throw musicVideoError(e);
  }
}

export async function runMusicVideo(
  input: {
    songRef: string;
    refs: { dataUrl: string }[];
    plan: MvPlan;
    vocalsRef?: string | null;
  },
  opts: MvOptions,
  deps: RunnerDeps,
  onProgress?: (p: MvProgress) => void,
): Promise<MvResult> {
  try {
    if (!input.refs.length)
      throw new ToolApiError("Add at least one character or style image.");
    onProgress?.({ phase: "upload" });
    const images: string[] = [];
    for (const r of input.refs)
      images.push(
        await uploadDataUrl(
          deps.fetchImpl,
          r.dataUrl,
          uploadName("cj_mtv_ref"),
        ),
      );
    const token = mvToken();
    const jobs = segmentJobs(
      input.plan,
      { song: input.songRef, images, vocals: input.vocalsRef ?? null },
      opts,
      token,
    );
    const src = await seedText(
      deps,
      `music video: ${opts.style || "music video"}`.slice(0, 200),
    );
    const segments: StepOutput[] = [];
    let lastRunId = "";
    for (const job of jobs) {
      if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
      onProgress?.({ phase: "segment", index: job.index, total: jobs.length });
      const run = await action(deps, src, MUSIC_VIDEO_ACTION, job);
      lastRunId = run.run_id;
      const out = await waitForOutputs(deps, promptIdOf(run));
      const clip = outputOf(
        pickFinalOutput(out.videos),
        `segment ${job.index + 1} clip`,
      );
      segments.push(clip);
      onProgress?.({
        phase: "segment",
        index: job.index,
        total: jobs.length,
        clip,
      });
    }
    if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
    onProgress?.({ phase: "assemble" });
    const run = await action(deps, src, MUSIC_VIDEO_ASSEMBLE_ACTION, {
      clips: segments.map((s) => s.ref),
      frames: input.plan.segments.map((s) => s.frames),
      song: input.songRef,
      songStart: input.plan.start,
      aspect: opts.aspect,
      token,
    });
    lastRunId = run.run_id || lastRunId;
    const out = await waitForOutputs(deps, promptIdOf(run));
    const video = await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "music video"),
      "video",
    );
    return { runId: lastRunId, video, segments };
  } catch (e) {
    throw musicVideoError(e);
  }
}
