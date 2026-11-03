/**
 * Dub video graph builders. The client-side plan (languages, prompt, step
 * graph) is src/lib/tools/dubVideo.ts; the executor is dubRunner.ts.
 *
 *   dub_transcribe  packs/audio/dub_transcribe.json  clip-sourced
 *                   (job.videos[0]): LoadAudio reads the clip's audio track,
 *                   TrimAudioDuration keeps the dubbed span, CJWhisperASR
 *                   (comfy_nodes/cj_whisper_asr) -> transcript + segments JSON.
 *   dub_transcribe_speakers  packs/audio/dub_transcribe_speakers.json  same,
 *                   with VibeVoice-ASR: segments carry a speaker label.
 *   dub_translate   packs/pipeline/script.json  text-only: Qwen3-VL 8B
 *                   TextGenerate with a length-matched translation prompt
 *                   compiled here from structured params (transcript,
 *                   target, source, seconds). LoadImage is dropped.
 *   dub_voice       packs/audio/dub_voice.json  clip-sourced: the clip's own
 *                   audio (first DUB_VOICE_REF_SECONDS) is the VibeVoice-1.5B
 *                   clone reference; params.text is the translated script.
 *                   params.speakers (DubSpeakerRef[]) cuts one reference per
 *                   speaker from the clip; params.text is then "[n] text" lines.
 *   dub_voice_chatterbox  packs/audio/dub_voice_chatterbox.json  same as
 *                   dub_voice with the Chatterbox multilingual engine
 *                   (ChatterboxMTLTTS, MIT); params.language = dub target.
 *                   params.clone === false drops the clip reference (the
 *                   node's built-in conds.pt voice speaks instead).
 *   dub_mux         packs/audio/dub_mux.json  clip-sourced + params.audioRef
 *                   (uploaded dubbed speech): frames at 25 fps under the new
 *                   audio. Frames are the clip (audio-only mode) or
 *                   params.framesRef (the uploaded lipsynced clip: lipsync
 *                   mode's mix step). params.background_db (-40..0) keeps the
 *                   clip's own soundtrack under the speech at that gain;
 *                   without it the soundtrack is replaced.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import { videoLipsyncSourceCap } from "./videoLipsync";
import { VOICEOVER_CLONE_MODEL } from "./voiceoverVoices";
import {
  CHATTERBOX_DUB_LANGS,
  DUB_AUDIO_MAX_SECONDS,
  DUB_BACKGROUND_MIN_DB,
  DUB_CHATTERBOX_MODEL_PACK,
  DUB_CHATTERBOX_MODEL_VERSION,
  DUB_CHATTERBOX_REF_SECONDS,
  DUB_LANGUAGES,
  DUB_LIPSYNC_MAX_SECONDS,
  DUB_RETRY_COPIES,
  DUB_RETRY_GAP_SECONDS,
  DUB_MUX_FPS,
  DUB_TRANSLATE_MAX_TOKENS,
  DUB_VOICE_REF_SECONDS,
  dubLanguage,
  dubTranslatePrompt,
  dubScriptLabels,
  dubVoiceScript,
  cleanSpeakerScript,
  DUB_MAX_SPEAKERS,
} from "@/lib/tools/dubVideo";

export const DUB_TRANSCRIBE_ACTION = "dub_transcribe";
export const DUB_TRANSCRIBE_SPEAKERS_ACTION = "dub_transcribe_speakers";
export const DUB_TRANSLATE_ACTION = "dub_translate";
export const DUB_VOICE_ACTION = "dub_voice";
export const DUB_VOICE_CHATTERBOX_ACTION = "dub_voice_chatterbox";
export const DUB_MUX_ACTION = "dub_mux";
// Relative to ComfyUI's `stt` model folder (models/stt); CJWhisperASR also accepts absolute dirs.
export const DUB_WHISPER_MODEL = "whisper/whisper-large-v3-turbo";

type Built = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function seedFrom(raw: unknown): number {
  const n = num(raw);
  return n !== undefined && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

function requireNode(workflow: Workflow, classType: string, action: string) {
  const id = Object.keys(workflow).find(
    (k) => workflow[k]?.class_type === classType,
  );
  if (!id) throw new Error(`${action}: workflow needs ${classType}`);
  return id;
}

function slots(
  id: string,
  input: string,
  imageInputId?: string,
): WorkflowSlots {
  return {
    ksamplerId: id,
    posTextId: id,
    posTextInputName: input,
    negTextId: "",
    latentDimsId: "",
    ...(imageInputId ? { imageInputId } : {}),
  };
}

function clipRef(run: ImagineRun, jobIndex: number, action: string): string {
  const ref = comfyImageRefFromViewUrl(run.jobs[jobIndex]?.videos?.[0]);
  if (!ref) throw new Error(`${action}: source run has no video`);
  return ref;
}

/** Dubbed span (seconds): params.seconds, else the clip length, clamped. */
export function dubSeconds(
  run: ImagineRun,
  params: Record<string, unknown>,
  max = DUB_AUDIO_MAX_SECONDS,
): number {
  const s =
    num(params.seconds) ??
    num(run.params?.video_seconds) ??
    DUB_LIPSYNC_MAX_SECONDS;
  return Math.round(Math.min(max, Math.max(1, s)) * 100) / 100;
}

export function buildDubTranscribeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_TRANSCRIBE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = clipRef(sourceRun, sourceJobIndex, A);
  const loadId = requireNode(workflow, "LoadAudio", A);
  const trimId = requireNode(workflow, "TrimAudioDuration", A);
  const asrId = requireNode(workflow, "CJWhisperASR", A);
  requireNode(workflow, "PreviewAny", A);

  const langId = text(params.language) || "auto";
  const lang =
    langId === "auto" ? undefined : DUB_LANGUAGES.find((l) => l.id === langId);
  if (langId !== "auto" && !lang)
    throw new Error(`${A}: unknown spoken language "${langId}"`);

  setNodeInput(workflow, loadId, "audio", ref);
  setNodeInput(workflow, trimId, "start_index", 0);
  setNodeInput(workflow, trimId, "duration", dubSeconds(sourceRun, params));
  setNodeInput(workflow, asrId, "language", lang ? lang.whisper : "auto");
  setNodeInput(workflow, asrId, "task", "transcribe");
  setNodeInput(workflow, asrId, "model_path", DUB_WHISPER_MODEL);
  setNodeInput(workflow, asrId, "return_timestamps", true);
  setNodeInput(workflow, asrId, "keep_loaded", false);
  // Whisper decoding here is greedy; the seed is bookkeeping only.
  return {
    workflow,
    slots: slots(asrId, "language"),
    seed: seedFrom(params.seed),
  };
}

export function buildDubTranscribeSpeakersWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_TRANSCRIBE_SPEAKERS_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = clipRef(sourceRun, sourceJobIndex, A);
  const loadId = requireNode(workflow, "LoadAudio", A);
  const trimId = requireNode(workflow, "TrimAudioDuration", A);
  const asrId = requireNode(workflow, "VibeVoiceASR", A);
  const repeatId = requireNode(workflow, "CJRepeatAudio", A);
  requireNode(workflow, "PreviewAny", A);
  const seconds = dubSeconds(sourceRun, params);
  setNodeInput(workflow, loadId, "audio", ref);
  setNodeInput(workflow, trimId, "start_index", 0);
  setNodeInput(workflow, trimId, "duration", seconds);
  setNodeInput(workflow, repeatId, "times", params.retry === true ? DUB_RETRY_COPIES : 1);
  setNodeInput(workflow, repeatId, "gap_seconds", DUB_RETRY_GAP_SECONDS);
  setNodeInput(workflow, repeatId, "copy_seconds", seconds);
  // Greedy decoding here (temperature 0); the seed is bookkeeping only.
  return {
    workflow,
    slots: slots(asrId, "context_info"),
    seed: seedFrom(params.seed),
  };
}

/** params.speakers -> validated references, or null for a one-voice dub. */
function speakerRefs(raw: unknown, A: string) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > DUB_MAX_SPEAKERS)
    throw new Error(`${A}: at most ${DUB_MAX_SPEAKERS} speakers`);
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const speaker = Number(o.speaker);
    const start = Number(o.start);
    const seconds = Number(o.seconds);
    if (
      !Number.isInteger(speaker) ||
      speaker < 1 ||
      speaker > DUB_MAX_SPEAKERS ||
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    )
      throw new Error(`${A}: bad speaker reference`);
    return {
      speaker,
      start,
      seconds: Math.min(DUB_VOICE_REF_SECONDS, seconds),
    };
  });
}

export function buildDubTranslateWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_TRANSLATE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const transcript = text(params.transcript);
  if (!transcript)
    throw new Error(`${A}: nothing to translate (empty transcript)`);
  const target = text(params.target);
  if (!dubLanguage(target))
    throw new Error(`${A}: unknown target language "${target}"`);
  const source = text(params.source);
  if (source && source !== "auto" && !dubLanguage(source))
    throw new Error(`${A}: unknown source language "${source}"`);

  const genId = requireNode(workflow, "TextGenerate", A);
  requireNode(workflow, "CLIPLoader", A);
  requireNode(workflow, "PreviewAny", A);
  const prompt = dubTranslatePrompt({
    transcript,
    target,
    source: source && source !== "auto" ? source : undefined,
    seconds: num(params.seconds),
  });
  const seed = seedFrom(params.seed);
  setNodeInput(workflow, genId, "prompt", prompt);
  setNodeInput(workflow, genId, "max_length", DUB_TRANSLATE_MAX_TOKENS);
  setNodeInput(workflow, genId, "sampling_mode.seed", seed);
  // Text-only: no image into the LLM.
  delete workflow[genId].inputs.image;
  for (const id of Object.keys(workflow)) {
    if (workflow[id]?.class_type === "LoadImage") delete workflow[id];
  }
  return { workflow, slots: slots(genId, "prompt"), seed };
}

export function buildDubVoiceWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_VOICE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = clipRef(sourceRun, sourceJobIndex, A);
  const refs = speakerRefs(params.speakers, A);
  const script = refs
    ? cleanSpeakerScript(text(params.text))
    : dubVoiceScript(text(params.text));
  if (!script) throw new Error(`${A}: translate the line first`);
  const loadId = requireNode(workflow, "LoadAudio", A);
  const trimId = requireNode(workflow, "TrimAudioDuration", A);
  const ttsId = requireNode(workflow, "VibeVoiceTTS", A);
  // VibeVoice treats seed 0 as random.
  const seed = Math.max(1, seedFrom(params.seed));
  setNodeInput(workflow, loadId, "audio", ref);
  setNodeInput(workflow, trimId, "start_index", 0);
  setNodeInput(workflow, trimId, "duration", DUB_VOICE_REF_SECONDS);
  setNodeInput(workflow, ttsId, "text", refs ? script : `[1] ${script}`);
  setNodeInput(workflow, ttsId, "model_name", VOICEOVER_CLONE_MODEL);
  setNodeInput(workflow, ttsId, "voice_preset", "None");
  setNodeInput(workflow, ttsId, "speaker_1_voice", [trimId, 0]);
  if (refs) {
    const known = new Set(refs.map((r) => r.speaker));
    const stray = dubScriptLabels(script).find((n) => !known.has(n));
    if (stray !== undefined)
      throw new Error(`${A}: no voice for speaker [${stray}]`);
    for (const r of refs) {
      const id = r.speaker === 1 ? trimId : `${trimId}${r.speaker}`;
      if (r.speaker !== 1) {
        workflow[id] = {
          class_type: "TrimAudioDuration",
          inputs: { audio: [loadId, 0] },
        };
        setNodeInput(workflow, ttsId, `speaker_${r.speaker}_voice`, [id, 0]);
      }
      setNodeInput(workflow, id, "start_index", r.start);
      setNodeInput(workflow, id, "duration", r.seconds);
    }
    if (!known.has(1)) throw new Error(`${A}: no voice for speaker [1]`);
  }
  setNodeInput(workflow, ttsId, "seed", seed);
  return { workflow, slots: slots(ttsId, "text", loadId), seed };
}

export function buildDubVoiceChatterboxWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_VOICE_CHATTERBOX_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = clipRef(sourceRun, sourceJobIndex, A);
  const script = dubVoiceScript(text(params.text));
  if (!script) throw new Error(`${A}: translate the line first`);
  const language = text(params.language);
  if (!CHATTERBOX_DUB_LANGS.has(language))
    throw new Error(`${A}: Chatterbox cannot speak "${language}"`);
  const loadId = requireNode(workflow, "LoadAudio", A);
  const trimId = requireNode(workflow, "TrimAudioDuration", A);
  const ttsId = requireNode(workflow, "ChatterboxMTLTTS", A);
  // ChatterboxMTLTTS treats seed 0 as random.
  const seed = Math.max(1, seedFrom(params.seed));
  if (params.clone !== undefined && typeof params.clone !== "boolean")
    throw new Error(`${A}: clone must be true or false`);
  const clone = params.clone !== false;
  setNodeInput(workflow, ttsId, "model_pack_name", DUB_CHATTERBOX_MODEL_PACK);
  setNodeInput(workflow, ttsId, "model_version", DUB_CHATTERBOX_MODEL_VERSION);
  setNodeInput(workflow, ttsId, "language", language);
  setNodeInput(workflow, ttsId, "text", script);
  setNodeInput(workflow, ttsId, "seed", seed);
  if (!clone) {
    // Stock voice: audio_prompt is optional; without it the node uses the
    // pack's conds.pt speaker.
    delete workflow[ttsId].inputs.audio_prompt;
    delete workflow[trimId];
    delete workflow[loadId];
    return { workflow, slots: slots(ttsId, "text"), seed };
  }
  setNodeInput(workflow, loadId, "audio", ref);
  setNodeInput(workflow, trimId, "start_index", 0);
  setNodeInput(workflow, trimId, "duration", DUB_CHATTERBOX_REF_SECONDS);
  setNodeInput(workflow, ttsId, "audio_prompt", [trimId, 0]);
  return { workflow, slots: slots(ttsId, "text", loadId), seed };
}

export function buildDubMuxWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = DUB_MUX_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = clipRef(sourceRun, sourceJobIndex, A);
  const audioRef = text(params.audioRef);
  if (!audioRef || !parseInputRef(audioRef, { allowAudio: true })) {
    throw new Error(
      `${A}: audioRef must be the uploaded dubbed speech ("name.mp3 [input]")`,
    );
  }
  const framesRef = text(params.framesRef);
  if (framesRef && !parseInputRef(framesRef, { allowVideo: true })) {
    throw new Error(
      `${A}: framesRef must be an uploaded clip ("name.mp4 [input]")`,
    );
  }
  const rawDb = params.background_db;
  const backgroundDb =
    rawDb === undefined || rawDb === null || rawDb === "" ? null : num(rawDb);
  if (
    backgroundDb === undefined ||
    (backgroundDb !== null &&
      (backgroundDb < DUB_BACKGROUND_MIN_DB || backgroundDb > 0))
  ) {
    throw new Error(
      `${A}: background_db must be ${DUB_BACKGROUND_MIN_DB}..0 dB`,
    );
  }
  const vhsId = requireNode(workflow, "VHS_LoadVideo", A);
  const createId = requireNode(workflow, "CreateVideo", A);
  const mergeId = requireNode(workflow, "AudioMerge", A);
  const volumeId = requireNode(workflow, "AudioAdjustVolume", A);
  const trimId = requireNode(workflow, "TrimAudioDuration", A);
  requireNode(workflow, "SaveVideo", A);
  // Speech = the LoadAudio feeding the merge's audio2; the other one is the
  // original soundtrack.
  const speechLink = workflow[mergeId].inputs.audio2;
  const speechId = Array.isArray(speechLink) ? String(speechLink[0]) : "";
  const origLink = workflow[trimId].inputs.audio;
  const origId = Array.isArray(origLink) ? String(origLink[0]) : "";
  if (workflow[speechId]?.class_type !== "LoadAudio")
    throw new Error(`${A}: AudioMerge.audio2 must come from LoadAudio`);
  if (workflow[origId]?.class_type !== "LoadAudio")
    throw new Error(`${A}: TrimAudioDuration must read a LoadAudio`);

  const seconds = dubSeconds(sourceRun, params);
  const cap = videoLipsyncSourceCap(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, vhsId, "video", framesRef || ref);
  setNodeInput(workflow, vhsId, "force_rate", DUB_MUX_FPS);
  setNodeInput(workflow, vhsId, "custom_width", cap.custom_width);
  setNodeInput(workflow, vhsId, "custom_height", cap.custom_height);
  setNodeInput(
    workflow,
    vhsId,
    "frame_load_cap",
    Math.ceil(seconds * DUB_MUX_FPS),
  );
  setNodeInput(workflow, speechId, "audio", audioRef);
  setNodeInput(workflow, createId, "fps", DUB_MUX_FPS);
  if (backgroundDb === null) {
    // Replace the soundtrack: speech straight into the video.
    setNodeInput(workflow, createId, "audio", [speechId, 0]);
    for (const id of [mergeId, volumeId, trimId, origId]) delete workflow[id];
  } else {
    // Original first (it sets the length: the frames' span), speech on top.
    setNodeInput(workflow, origId, "audio", ref);
    setNodeInput(workflow, trimId, "start_index", 0);
    setNodeInput(workflow, trimId, "duration", seconds);
    setNodeInput(workflow, volumeId, "volume", Math.round(backgroundDb));
    setNodeInput(workflow, mergeId, "merge_method", "add");
    setNodeInput(workflow, createId, "audio", [mergeId, 0]);
  }
  return {
    workflow,
    slots: slots(createId, "fps"),
    seed: seedFrom(params.seed),
  };
}
