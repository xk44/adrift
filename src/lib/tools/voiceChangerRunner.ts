/**
 * Voice changer executor: one ordinary Adrift run through the job routes,
 * then history polling for its outputs (same plumbing as the Dub runner), so
 * it runs under vitest with a mock fetch.
 *
 *   audio  upload speech -> text-only seed -> voice_change -> MP3
 *   video  upload clip -> seed run -> voice_change_video -> MP3 + remuxed clip
 *
 * The optional target voice sample is uploaded first and passed as audioRef.
 */
import { pickFinalOutput } from "./pickOutput";
import {
  ToolApiError,
  audioUploadName,
  seedRun,
  uploadDataUrl,
  videoUploadName,
  type ToolAudio,
  type ToolVideo,
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
  voiceChangeSpan,
  type VoiceChangeMatch,
  type VoiceChangeQuality,
  type VoiceChangeSource,
} from "./voiceChanger";

export interface VoiceChangeInputs {
  source: VoiceChangeSource;
  /** Speech to convert (source "audio"). */
  audio?: ToolAudio | null;
  /** Clip whose soundtrack is converted (source "video"). */
  video?: ToolVideo | null;
  /** Target voice sample; none = the model pack's built-in voice. */
  target?: ToolAudio | null;
  quality?: VoiceChangeQuality;
  match?: VoiceChangeMatch;
  seed?: number;
}

export interface VoiceChangeResult {
  runId: string;
  /** Converted speech (MP3). */
  audio: StepOutput;
  /** Source "video": the clip with the converted speech. */
  video?: StepOutput;
}

export async function runVoiceChange(
  inputs: VoiceChangeInputs,
  deps: RunnerDeps,
): Promise<VoiceChangeResult> {
  const knobs = {
    ...(inputs.quality ? { quality: inputs.quality } : {}),
    ...(inputs.match ? { match: inputs.match } : {}),
    ...(typeof inputs.seed === "number" ? { seed: inputs.seed } : {}),
  };
  if (inputs.source === "audio" && !inputs.audio)
    throw new ToolApiError("Add the speech to convert");
  if (inputs.source === "video" && !inputs.video)
    throw new ToolApiError("Add a clip with speech");

  const audioRef = inputs.target
    ? await uploadDataUrl(
        deps.fetchImpl,
        inputs.target.dataUrl,
        audioUploadName(inputs.target.label),
      )
    : undefined;
  const targetParam = audioRef ? { audioRef } : {};

  if (inputs.source === "audio") {
    const a = inputs.audio!;
    const sourceAudioRef = await uploadDataUrl(
      deps.fetchImpl,
      a.dataUrl,
      audioUploadName(a.label),
    );
    const src = await seedText(deps, "voice changer");
    const run = await action(deps, src, "voice_change", {
      sourceAudioRef,
      seconds: voiceChangeSpan("audio", a.duration),
      ...targetParam,
      ...knobs,
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const audio = await measured(
      deps,
      outputOf(pickFinalOutput(out.audios), "converted speech"),
      "audio",
    );
    return { runId: run.run_id, audio };
  }

  const v = inputs.video!;
  const ref = await uploadDataUrl(
    deps.fetchImpl,
    v.dataUrl,
    videoUploadName(v.label),
  );
  const src = await seedRun(
    deps.fetchImpl,
    ref,
    v.width,
    v.height,
    "voice changer",
    v.duration,
  );
  const run = await action(deps, src, "voice_change_video", {
    seconds: voiceChangeSpan("video", v.duration),
    ...targetParam,
    ...knobs,
  });
  const out = await waitForOutputs(deps, promptIdOf(run));
  const audio = await measured(
    deps,
    outputOf(pickFinalOutput(out.audios), "converted speech"),
    "audio",
  );
  const video = await measured(
    deps,
    outputOf(pickFinalOutput(out.videos), "re-voiced clip"),
    "video",
  );
  return { runId: run.run_id, audio, video };
}
