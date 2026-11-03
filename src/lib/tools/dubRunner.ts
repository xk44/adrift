/**
 * Dub video executor. Each step queues one ordinary Adrift run through the
 * job routes and polls history for its output (same plumbing as the Shorts
 * Studio / ClipCut runners), so the whole flow runs under vitest with a mock
 * fetch.
 *
 *   transcribe  clip run -> dub_transcribe -> transcript + segments, or
 *               dub_transcribe_speakers -> "[n] text" script + labelled segments
 *   translate   text-only seed -> dub_translate -> translation (editable)
 *   voice       clip run -> dub_voice (clip audio = clone reference) -> MP3,
 *               or dub_voice_chatterbox with the Chatterbox engine ("auto"
 *               picks per target, dubResolveEngine)
 *   lipsync     voice MP3 re-uploaded as an input -> video_lipsync on the clip
 *   mux         voice MP3 re-uploaded as an input -> dub_mux on the clip
 *               (original soundtrack kept at state.background, if any)
 *   mix         lipsync mode with the original kept: the lipsynced clip is
 *               re-uploaded and dub_mux lays speech + turned-down original
 *               over its frames
 */
import { pickFinalOutput } from "./pickOutput";
import {
  ToolApiError,
  audioUploadName,
  seedRun,
  uploadDataUrl,
  videoUploadName,
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
import {
  DUB_DEFAULT_ENGINE,
  DUB_MAX_SPEAKERS,
  cleanSpeakerScript,
  cleanTranslation,
  dubBackgroundDb,
  dubEngineSupports,
  dubIsSpeakerScript,
  dubLanguage,
  dubNextRunnable,
  dubOverrunSeconds,
  dubBestCopy,
  dubSpeechSegments,
  DUB_MIN_REF_SECONDS,
  dubResolveEngine,
  dubScriptLabels,
  dubSpanSeconds,
  dubSpeakerCount,
  dubSpeakerRefs,
  dubSpeakerScript,
  dubUpdateStep,
  parseTranscription,
  type DubMode,
  type DubSegment,
  type DubSpeakers,
  type DubState,
  type DubStepKind,
  type DubVoiceEngine,
} from "./dubVideo";
import type { StepOutput } from "./pipelines";

export interface DubInputs {
  video: ToolVideo;
  mode: DubMode;
  /** DUB_LANGUAGES id. */
  target: string;
  /** Spoken language hint (DUB_LANGUAGES id) or "auto". */
  source?: string;
  /** Lipsync: which face to re-animate (default "face"). */
  faceTarget?: string;
  /** TTS engine of the voice step (default "auto": per target language). */
  engine?: DubVoiceEngine;
  /**
   * Clone the speaker from the clip (default true). false = Chatterbox's
   * built-in stock voice in the target language (engine is ignored).
   */
  clone?: boolean;
  /** "several": VibeVoice-ASR finds the speakers, each gets a cloned voice. */
  speakers?: DubSpeakers;
  seed?: number;
}

export interface DubDeps extends RunnerDeps {
  /** Clip seeded once per dub (reused by every clip-sourced step). */
  clip?: { runId: string; jobIndex: number };
  /** Output URL -> its re-uploaded input ref (speech reused by lipsync + mix). */
  uploads?: Record<string, string>;
  /**
   * Stop before this step when earlier steps ran in this call (script
   * review: pause before "voice" so the transcript/translation can be
   * edited). A call that starts at it runs straight through.
   */
  pauseBefore?: DubStepKind;
  /**
   * Stop after a voice step (run in this call) whose speech outlasts the
   * clip (dubOverrunSeconds), so the line can be shortened before the slow
   * lipsync cuts its end. Default true; a call that starts after the voice
   * step runs straight through.
   */
  pauseOnOverrun?: boolean;
}

export interface DubStepResult {
  output?: StepOutput;
  runId?: string;
  jobIndex?: number;
  transcript?: string;
  segments?: DubSegment[];
  translation?: string;
}

async function clipRun(deps: DubDeps, inputs: DubInputs) {
  if (deps.clip) return deps.clip;
  const v = inputs.video;
  const ref = await uploadDataUrl(
    deps.fetchImpl,
    v.dataUrl,
    videoUploadName(v.label),
  );
  deps.clip = await seedRun(
    deps.fetchImpl,
    ref,
    v.width,
    v.height,
    "dub video",
    v.duration,
  );
  return deps.clip;
}

/** Re-upload a step output as an input (once per output URL). */
async function reupload(
  deps: DubDeps,
  out: StepOutput,
  kind: "audio" | "video",
): Promise<string> {
  const cached = deps.uploads?.[out.url];
  if (cached) return cached;
  if (!deps.toDataUrl)
    throw new ToolApiError(
      kind === "audio"
        ? "Cannot re-upload the dubbed speech here"
        : "Cannot re-upload the lipsynced clip here",
    );
  const ref = await uploadDataUrl(
    deps.fetchImpl,
    await deps.toDataUrl(out.url),
    kind === "audio"
      ? audioUploadName("dub_voice.mp3")
      : videoUploadName("dub_lipsync.mp4"),
  );
  deps.uploads = { ...(deps.uploads ?? {}), [out.url]: ref };
  return ref;
}

function seedParam(inputs: DubInputs) {
  return typeof inputs.seed === "number" ? { seed: inputs.seed } : {};
}

export async function executeDubStep(
  state: DubState,
  id: DubStepKind,
  inputs: DubInputs,
  deps: DubDeps,
): Promise<DubStepResult> {
  if (!dubLanguage(inputs.target))
    throw new ToolApiError("Pick a target language");
  const seconds = dubSpanSeconds(state.mode, inputs.video.duration);

  if (id === "transcribe" && inputs.speakers === "several") {
    const src = await clipRun(deps, inputs);
    const diarize = async (retry: boolean) => {
      const run = await action(deps, src, "dub_transcribe_speakers", {
        seconds,
        retry,
        ...seedParam(inputs),
      });
      const out = await waitForOutputs(deps, promptIdOf(run));
      const found = dubSpeechSegments(
        parseTranscription(out.texts.map((t) => t.text)).segments,
      );
      return { run, segments: retry ? dubBestCopy(found, seconds) : found };
    };
    // On long music with no talking the model can loop until its token limit
    // (about 12 min on a 4090), then fail on its own cut-off output.
    let { run, segments } = await diarize(false).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Transcription failed"))
        throw new ToolApiError(
          "The speech model got stuck on this clip and returned no script. Long music with no talking can cause this; try a part of the clip with talking.",
        );
      throw error;
    });
    if (!segments.length)
      throw new ToolApiError("No speech found in the clip's audio");
    // Short clips can merge two people. Retry only then: repeating the clip
    // makes things worse on clips that already split.
    if (dubSpeakerCount(segments) < 2) {
      try {
        const retried = await diarize(true);
        if (dubSpeakerCount(retried.segments) >= 2)
          ({ run, segments } = retried);
      } catch (error) {
        // A failed retry leaves the one-speaker result, which stops below.
        if (deps.isCancelled?.()) throw error;
      }
    }
    const count = dubSpeakerCount(segments);
    if (count < 2)
      throw new ToolApiError(
        "Only one speaker found. Fast exchanges and film audio can merge into one; for this clip use One speaker.",
      );
    if (count > DUB_MAX_SPEAKERS)
      throw new ToolApiError(
        `Found ${count} speakers; up to ${DUB_MAX_SPEAKERS} can be voiced. Use a shorter clip.`,
      );
    const thin = dubSpeakerRefs(segments).find(
      (r) => r.seconds < DUB_MIN_REF_SECONDS,
    );
    if (thin)
      throw new ToolApiError(
        `Speaker ${thin.speaker} has under ${DUB_MIN_REF_SECONDS} s of unbroken speech, too little to clone and often a wrong label. Use One speaker, or a clip where each person talks longer.`,
      );
    return {
      runId: run.run_id,
      jobIndex: 0,
      transcript: dubSpeakerScript(segments),
      segments,
    };
  }

  if (id === "transcribe") {
    const src = await clipRun(deps, inputs);
    const run = await action(deps, src, "dub_transcribe", {
      seconds,
      language: inputs.source || "auto",
      ...seedParam(inputs),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const { transcript, segments } = parseTranscription(
      out.texts.map((t) => t.text),
    );
    if (!transcript)
      throw new ToolApiError("No speech found in the clip's audio");
    return { runId: run.run_id, jobIndex: 0, transcript, segments };
  }

  if (id === "translate") {
    if (!state.transcript.trim())
      throw new ToolApiError("Transcribe the clip first");
    const src = await seedText(deps, "dub video translation");
    const run = await action(deps, src, "dub_translate", {
      transcript: state.transcript,
      target: inputs.target,
      source: inputs.source || "auto",
      seconds,
      ...seedParam(inputs),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const dialogue = dubIsSpeakerScript(state.transcript);
    const translation = dialogue
      ? cleanSpeakerScript(out.texts[0]?.text ?? "")
      : cleanTranslation(out.texts[0]?.text ?? "");
    if (!translation) throw new ToolApiError("The translation came back empty");
    if (
      dialogue &&
      dubScriptLabels(translation).join() !==
        dubScriptLabels(state.transcript).join()
    )
      throw new ToolApiError(
        "The translation changed who speaks when. Run the step again.",
      );
    return { runId: run.run_id, jobIndex: 0, translation };
  }

  if (id === "voice") {
    if (!state.translation.trim())
      throw new ToolApiError("Translate the line first");
    const several = inputs.speakers === "several";
    const refs = several ? dubSpeakerRefs(state.segments) : [];
    if (several && !refs.length)
      throw new ToolApiError("Transcribe the clip first");
    if (several) {
      const labels = dubScriptLabels(cleanSpeakerScript(state.translation));
      if (!labels.length || labels.some((n) => !refs.some((r) => r.speaker === n)))
        throw new ToolApiError(
          `Each line must start with its speaker label. Labels available: ${refs.map((r) => `[${r.speaker}]`).join(", ")}.`,
        );
    }
    const choice = inputs.engine ?? DUB_DEFAULT_ENGINE;
    const clone = several || inputs.clone !== false;
    // Only VibeVoice takes several voices in one script.
    const engine = several
      ? "vibevoice"
      : dubResolveEngine(choice, inputs.target, clone);
    if (!dubEngineSupports(engine, inputs.target))
      throw new ToolApiError(
        clone
          ? `Chatterbox cannot speak ${dubLanguage(inputs.target)?.label}; use VibeVoice`
          : `No stock voice speaks ${dubLanguage(inputs.target)?.label}; turn voice cloning on`,
      );
    const src = await clipRun(deps, inputs);
    const run =
      engine === "chatterbox"
        ? await action(deps, src, "dub_voice_chatterbox", {
            text: state.translation,
            language: inputs.target,
            ...(clone ? {} : { clone: false }),
            ...seedParam(inputs),
          })
        : await action(deps, src, "dub_voice", {
            text: state.translation,
            ...(several ? { speakers: refs } : {}),
            ...seedParam(inputs),
          });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const voice = await measured(
      deps,
      outputOf(pickFinalOutput(out.audios), "dubbed speech"),
      "audio",
    );
    return { runId: run.run_id, jobIndex: 0, output: voice };
  }

  const voice = state.steps.voice?.output;
  if (!voice) throw new ToolApiError("Generate the dubbed voice first");
  const src = await clipRun(deps, inputs);
  const audioRef = await reupload(deps, voice, "audio");
  const backgroundDb = dubBackgroundDb(state.background);
  const background =
    backgroundDb === null ? {} : { background_db: backgroundDb };

  if (id === "mix") {
    const lipsynced = state.steps.lipsync?.output;
    if (!lipsynced) throw new ToolApiError("Lipsync the clip first");
    if (backgroundDb === null)
      throw new ToolApiError("Nothing to mix: the original audio is off");
    const framesRef = await reupload(deps, lipsynced, "video");
    const run = await action(deps, src, "dub_mux", {
      audioRef,
      framesRef,
      seconds:
        typeof lipsynced.seconds === "number" && lipsynced.seconds > 0
          ? Math.min(seconds, lipsynced.seconds)
          : seconds,
      ...background,
      ...seedParam(inputs),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const clip = await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "dubbed clip"),
      "video",
    );
    return { runId: run.run_id, jobIndex: 0, output: clip };
  }

  if (id === "lipsync") {
    const run = await action(deps, src, "video_lipsync", {
      audioRef,
      ...(typeof voice.seconds === "number"
        ? { audio_seconds: voice.seconds }
        : {}),
      ...(typeof inputs.video.duration === "number"
        ? { video_seconds: inputs.video.duration }
        : {}),
      ...(inputs.faceTarget?.trim()
        ? { target: inputs.faceTarget.trim() }
        : {}),
      ...seedParam(inputs),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    const clip = await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "lipsynced clip"),
      "video",
    );
    return { runId: run.run_id, jobIndex: 0, output: clip };
  }

  const run = await action(deps, src, "dub_mux", {
    audioRef,
    seconds,
    ...background,
    ...seedParam(inputs),
  });
  const out = await waitForOutputs(deps, promptIdOf(run));
  const clip = await measured(
    deps,
    outputOf(pickFinalOutput(out.videos), "dubbed clip"),
    "video",
  );
  return { runId: run.run_id, jobIndex: 0, output: clip };
}

/**
 * Run pending steps in order until done, a step fails, the run is
 * cancelled, or it reaches deps.pauseBefore after running something.
 * A failed step stays failed until re-run (dubInvalidate).
 */
export async function runDub(
  initial: DubState,
  inputs: DubInputs,
  deps: DubDeps,
  onState: (state: DubState) => void,
): Promise<DubState> {
  let state = initial;
  const commit = (s: DubState) => {
    state = s;
    onState(s);
  };
  let ran = 0;
  let voiced = false;
  for (;;) {
    if (deps.isCancelled?.()) return state;
    const id = dubNextRunnable(state);
    if (!id) return state;
    if (ran > 0 && id === deps.pauseBefore) return state;
    if (
      voiced &&
      deps.pauseOnOverrun !== false &&
      dubOverrunSeconds(state, inputs.video.duration) !== null
    )
      return state;
    ran++;
    commit(dubUpdateStep(state, id, { status: "running", error: undefined }));
    try {
      const res = await executeDubStep(state, id, inputs, deps);
      let next = state;
      if (res.transcript !== undefined)
        next = {
          ...next,
          transcript: res.transcript,
          segments: res.segments ?? [],
        };
      if (res.translation !== undefined)
        next = { ...next, translation: res.translation };
      commit(
        dubUpdateStep(next, id, {
          status: "done",
          runId: res.runId,
          jobIndex: res.jobIndex,
          ...(res.output ? { output: res.output } : {}),
        }),
      );
      voiced = id === "voice";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (deps.isCancelled?.()) {
        commit(dubUpdateStep(state, id, { status: "idle" }));
        return state;
      }
      commit(dubUpdateStep(state, id, { status: "error", error: message }));
      return state;
    }
  }
}
