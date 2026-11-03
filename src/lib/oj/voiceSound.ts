/**
 * Voice + sound tools (pack "audio").
 *
 *   voiceover  packs/audio/voiceover.json  VibeVoice TTS
 *              (wildminder/ComfyUI-VibeVoice, VibeVoiceTTS). Text-only: the
 *              client seeds an empty text run and sends the script. Two
 *              engines (params.engine):
 *                stock  VibeVoice-Realtime-0.5B + one of Microsoft's 25 cached
 *                       voice prompts (params.voice, models/tts/VibeVoice/
 *                       voices/<id>.pt, MIT). Default: works with no upload.
 *                clone  VibeVoice-1.5B cloning an uploaded voice sample
 *                       (params.audioRef → LoadAudio → speaker_1_voice).
 *                kokoro Kokoro-82M (hexgrad, Apache-2.0) through
 *                       comfy_nodes/cj_kokoro_tts: the builder swaps node 2 to
 *                       CJKokoroTTS (params.voice from VOICEOVER_KOKORO_VOICES,
 *                       optional params.speed 0.5-2). CPU, no GPU needed.
 *              No engine + a voice sample (older clients) → clone. Output: MP3.
 *   add_sound  packs/audio/add_sound.json  MMAudio large 44k v2
 *              (kijai/ComfyUI-MMAudio) video-to-audio. Clip-sourced
 *              (job.videos[0]): optional prompt / negative prompt / seed,
 *              generated foley muxed over the source frames (source audio is
 *              replaced). Length = clip length, capped at ADD_SOUND_MAX_SECONDS.
 *              MMAudio weights are CC-BY-NC-4.0 (non-commercial).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import {
  VOICEOVER_CLONE_MODEL,
  VOICEOVER_DEFAULT_VOICE,
  VOICEOVER_KOKORO_DEFAULT_VOICE,
  VOICEOVER_KOKORO_NODE,
  VOICEOVER_KOKORO_VOICES,
  VOICEOVER_STOCK_MODEL,
  VOICEOVER_STOCK_VOICES,
  stockVoiceLabel,
  type VoiceoverEngine,
} from "./voiceoverVoices";

export const VOICEOVER_ACTION = "voiceover";
export const ADD_SOUND_ACTION = "add_sound";

/** Longest script sent to VibeVoice (characters, ~2 min of speech). */
export const VOICEOVER_MAX_CHARS = 2000;
/** Longest clip span scored (seconds). MMAudio was trained on 8 s clips. */
export const ADD_SOUND_MAX_SECONDS = 10;
/** MMAudio's synchformer frame rate; VHS_LoadVideo resamples to it. */
export const MMAUDIO_SYNC_FPS = 25;
export const ADD_SOUND_DEFAULT_NEGATIVE = "music, speech, voice, talking";

export {
  VOICEOVER_CLONE_MODEL,
  VOICEOVER_DEFAULT_VOICE,
  VOICEOVER_KOKORO_DEFAULT_VOICE,
  VOICEOVER_KOKORO_NODE,
  VOICEOVER_KOKORO_VOICES,
  VOICEOVER_STOCK_MODEL,
  VOICEOVER_STOCK_VOICES,
  stockVoiceLabel,
  type VoiceoverEngine,
};

/** Realtime CFG: the node lifts anything below 1.5 (syllable repeats). */
const STOCK_CFG = 1.5;
const CLONE_CFG = 1.3;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finitePositive(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function seedFrom(params: Record<string, unknown>): number {
  const raw = params.seed;
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

function requireNode(workflow: Workflow, classType: string, action: string) {
  const id = Object.keys(workflow).find(
    (k) => workflow[k].class_type === classType,
  );
  if (!id) throw new Error(`${action}: workflow needs ${classType}`);
  return id;
}

const slots = (
  ksamplerId: string,
  posTextId: string,
  posTextInputName: string,
  imageInputId?: string,
): WorkflowSlots => ({
  ksamplerId,
  posTextId,
  posTextInputName,
  negTextId: "",
  latentDimsId: "",
  ...(imageInputId ? { imageInputId } : {}),
});

/** Script text: params.script, else params.prompt; whitespace-normalised, capped. */
export function voiceoverScript(params: Record<string, unknown>): string {
  const raw = text(params.script) || text(params.prompt);
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, VOICEOVER_MAX_CHARS)
    .trim();
}

/** Uploaded / job voice sample ref, or null. Throws on a malformed audioRef. */
function voiceSampleRef(
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
): string | null {
  const explicit = text(params.audioRef);
  if (explicit) {
    if (!parseInputRef(explicit, { allowAudio: true })) {
      throw new Error(
        `${VOICEOVER_ACTION}: audioRef must be an uploaded audio ref ("name.wav [input]")`,
      );
    }
    return explicit;
  }
  return comfyImageRefFromViewUrl(sourceRun.jobs[sourceJobIndex]?.audios?.[0]);
}

export function buildVoiceoverWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const script = voiceoverScript(params);
  if (!script) throw new Error(`${VOICEOVER_ACTION}: write the script first`);

  const engineParam = text(params.engine);
  if (
    engineParam &&
    engineParam !== "stock" &&
    engineParam !== "clone" &&
    engineParam !== "kokoro"
  ) {
    throw new Error(`${VOICEOVER_ACTION}: unknown engine "${engineParam}"`);
  }
  const sample = voiceSampleRef(sourceRun, sourceJobIndex, params);
  // Older clients send only a sample (no engine): keep cloning it.
  const engine: VoiceoverEngine =
    (engineParam as VoiceoverEngine) || (sample ? "clone" : "stock");

  const ttsId = requireNode(workflow, "VibeVoiceTTS", VOICEOVER_ACTION);
  const loadId = requireNode(workflow, "LoadAudio", VOICEOVER_ACTION);
  // VibeVoice treats seed 0 as "random"; keep explicit seeds reproducible.
  const seed = Math.max(1, seedFrom(params));
  setNodeInput(workflow, ttsId, "text", script);
  setNodeInput(workflow, ttsId, "seed", seed);

  if (engine === "kokoro") {
    const voice = text(params.voice) || VOICEOVER_KOKORO_DEFAULT_VOICE;
    if (!VOICEOVER_KOKORO_VOICES.some((v) => v.id === voice)) {
      throw new Error(`${VOICEOVER_ACTION}: unknown Kokoro voice "${voice}"`);
    }
    const speed = finitePositive(params.speed) ?? 1;
    // Kokoro is deterministic (no sampling seed); keep the run's seed for bookkeeping.
    workflow[ttsId] = {
      class_type: VOICEOVER_KOKORO_NODE,
      inputs: {
        text: script,
        voice,
        speed: Math.round(Math.min(2, Math.max(0.5, speed)) * 100) / 100,
      },
      _meta: { title: "Kokoro TTS" },
    };
    delete workflow[loadId];
    return { workflow, slots: slots(ttsId, ttsId, "text"), seed };
  }

  if (engine === "stock") {
    const voice = text(params.voice) || VOICEOVER_DEFAULT_VOICE;
    if (!VOICEOVER_STOCK_VOICES.some((v) => v.id === voice)) {
      throw new Error(`${VOICEOVER_ACTION}: unknown stock voice "${voice}"`);
    }
    setNodeInput(workflow, ttsId, "model_name", VOICEOVER_STOCK_MODEL);
    setNodeInput(workflow, ttsId, "voice_preset", voice);
    setNodeInput(workflow, ttsId, "cfg_scale", STOCK_CFG);
    delete workflow[ttsId].inputs.speaker_1_voice;
    delete workflow[loadId];
    return { workflow, slots: slots(ttsId, ttsId, "text"), seed };
  }

  if (!sample) {
    throw new Error(
      `${VOICEOVER_ACTION}: add a voice sample (VibeVoice-1.5B clones a reference voice)`,
    );
  }
  setNodeInput(workflow, loadId, "audio", sample);
  setNodeInput(workflow, ttsId, "model_name", VOICEOVER_CLONE_MODEL);
  setNodeInput(workflow, ttsId, "voice_preset", "None");
  setNodeInput(workflow, ttsId, "cfg_scale", CLONE_CFG);
  setNodeInput(workflow, ttsId, "speaker_1_voice", [loadId, 0]);
  return { workflow, slots: slots(ttsId, ttsId, "text", loadId), seed };
}

/** Seconds of clip to score: clip length (if known) capped at the max. */
export function addSoundSeconds(...lengths: unknown[]): number {
  const known = finitePositive(...lengths);
  const s = known === undefined ? ADD_SOUND_MAX_SECONDS : known;
  return (
    Math.round(Math.min(ADD_SOUND_MAX_SECONDS, Math.max(0.5, s)) * 1000) / 1000
  );
}

export function buildAddSoundWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef)
    throw new Error(`${ADD_SOUND_ACTION}: source run has no video`);

  const loadId = requireNode(workflow, "LoadVideo", ADD_SOUND_ACTION);
  const sliceId = requireNode(workflow, "Video Slice", ADD_SOUND_ACTION);
  const vhsId = requireNode(workflow, "VHS_LoadVideo", ADD_SOUND_ACTION);
  const samplerId = requireNode(workflow, "MMAudioSampler", ADD_SOUND_ACTION);
  requireNode(workflow, "CreateVideo", ADD_SOUND_ACTION);

  const seconds = addSoundSeconds(
    params.video_seconds,
    sourceRun.params?.video_seconds,
  );
  const seed = seedFrom(params);
  const negative =
    params.negative_prompt === undefined
      ? ADD_SOUND_DEFAULT_NEGATIVE
      : text(params.negative_prompt);

  setNodeInput(workflow, loadId, "file", videoRef);
  setNodeInput(workflow, sliceId, "duration", seconds);
  setNodeInput(workflow, vhsId, "video", videoRef);
  setNodeInput(workflow, vhsId, "force_rate", MMAUDIO_SYNC_FPS);
  setNodeInput(
    workflow,
    vhsId,
    "frame_load_cap",
    Math.ceil(seconds * MMAUDIO_SYNC_FPS),
  );
  setNodeInput(workflow, samplerId, "duration", seconds);
  setNodeInput(workflow, samplerId, "prompt", text(params.prompt));
  setNodeInput(workflow, samplerId, "negative_prompt", negative);
  setNodeInput(workflow, samplerId, "seed", seed);

  return {
    workflow,
    slots: slots(samplerId, samplerId, "prompt", loadId),
    seed,
  };
}
