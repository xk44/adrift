/**
 * Text-only audio generators (pack "audio"), core ComfyUI nodes only.
 *
 *   music  packs/audio/music.json  ACE-Step 1.5 turbo (converted from
 *          audio_ace_step_1_5_split): tags + optional lyrics, duration,
 *          bpm, key → SaveAudioMP3.
 *   sfx    packs/audio/sfx.json    Stable Audio 3 small SFX (the
 *          audio_stable_audio_3_medium subgraph flattened, LLM reprompt
 *          dropped): prompt + duration → SaveAudioMP3.
 *
 * Neither reads source media: the client seeds an empty text run
 * (POST /api/jobs/seed-run { text_only: true }) and queues the action on it.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow, setNodeInput } from "./engine";

export const MUSIC_ACTION = "music";
export const SFX_ACTION = "sfx";

/** Actions that take no source image or clip (text in, media out). */
export const TEXT_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  MUSIC_ACTION,
  SFX_ACTION,
  "voiceover", // voiceSound.ts VOICEOVER_ACTION (text + voice sample)
]);

export const MUSIC_DURATION = { min: 10, max: 240, default: 30 };
export const SFX_DURATION = { min: 1, max: 30, default: 8 };
/**
 * ACE-Step 1.5 turbo ends ~13-18% early with a silent tail (silence from
 * 24.5 s of 30 s, 52 s of 60 s). Generate 4/3 of the requested length and
 * TrimAudioDuration back to it, which measured silence-free at 30 s.
 */
export const MUSIC_OVERGENERATE = 4 / 3;

export const MUSIC_BPM = { min: 40, max: 220, default: 120 };
export const MUSIC_DEFAULT_KEY = "C major";
/** Lyrics sent when the user leaves them empty (ACE-Step's no-vocals tag). */
export const INSTRUMENTAL_LYRICS = "[Instrumental]";

const KEY_NOTES = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
];
/** The TextEncodeAceStepAudio1.5 `keyscale` enum. */
export const MUSIC_KEYS: readonly string[] = [
  ...KEY_NOTES.map((n) => `${n} major`),
  ...KEY_NOTES.map((n) => `${n} minor`),
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function clampRange(
  value: unknown,
  range: { min: number; max: number; default: number },
): number {
  const n = num(value);
  if (n === undefined) return range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

/** "a minor" / "A Minor" / "Am" → "A minor"; unknown → default key. */
export function musicKey(value: unknown): string {
  const raw = text(value);
  if (!raw) return MUSIC_DEFAULT_KEY;
  const m = /^([A-Ga-g])([#b]?)\s*(maj(?:or)?|min(?:or)?|m)?$/.exec(raw);
  if (!m) return MUSIC_DEFAULT_KEY;
  const note = `${m[1].toUpperCase()}${m[2]}`;
  const minor = m[3] !== undefined && /^m(in(or)?)?$/i.test(m[3]);
  const key = `${note} ${minor ? "minor" : "major"}`;
  return MUSIC_KEYS.includes(key) ? key : MUSIC_DEFAULT_KEY;
}

function seedFrom(params: Record<string, unknown>): number {
  const n = num(params.seed);
  return n !== undefined && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function requireNode(workflow: Workflow, classType: string, action: string) {
  const id = nodeIdOf(workflow, classType);
  if (!id) throw new Error(`${action}: workflow needs ${classType}`);
  return id;
}

const EMPTY_SLOTS = (ksamplerId: string, posTextId: string, input: string) => ({
  ksamplerId,
  posTextId,
  posTextInputName: input,
  negTextId: "",
  latentDimsId: "",
});

export function buildMusicWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const tags = text(params.prompt) || text(params.tags);
  if (!tags) throw new Error(`${MUSIC_ACTION}: describe the music (prompt)`);
  const encodeId = requireNode(
    workflow,
    "TextEncodeAceStepAudio1.5",
    MUSIC_ACTION,
  );
  const latentId = requireNode(
    workflow,
    "EmptyAceStep1.5LatentAudio",
    MUSIC_ACTION,
  );
  const samplerId = requireNode(workflow, "KSampler", MUSIC_ACTION);

  const seconds = clampRange(params.duration, MUSIC_DURATION);
  const seed = seedFrom(params);
  setNodeInput(workflow, encodeId, "tags", tags);
  setNodeInput(
    workflow,
    encodeId,
    "lyrics",
    text(params.lyrics) || INSTRUMENTAL_LYRICS,
  );
  setNodeInput(
    workflow,
    encodeId,
    "bpm",
    Math.round(clampRange(params.bpm, MUSIC_BPM)),
  );
  setNodeInput(workflow, encodeId, "keyscale", musicKey(params.key));
  const trimId = nodeIdOf(workflow, "TrimAudioDuration");
  const genSeconds = trimId
    ? Math.round(seconds * MUSIC_OVERGENERATE * 10) / 10
    : seconds;
  setNodeInput(workflow, encodeId, "duration", genSeconds);
  setNodeInput(workflow, encodeId, "seed", seed);
  setNodeInput(workflow, latentId, "seconds", genSeconds);
  if (trimId) {
    setNodeInput(workflow, trimId, "start_index", 0);
    setNodeInput(workflow, trimId, "duration", seconds);
  }
  setNodeInput(workflow, samplerId, "seed", seed);

  return {
    workflow,
    slots: EMPTY_SLOTS(samplerId, encodeId, "tags"),
    seed,
  };
}

export function buildSfxWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const prompt = text(params.prompt);
  if (!prompt) throw new Error(`${SFX_ACTION}: describe the sound (prompt)`);
  const samplerId = requireNode(workflow, "KSampler", SFX_ACTION);
  const latentId = requireNode(workflow, "EmptyLatentAudio", SFX_ACTION);
  const pos = workflow[samplerId].inputs.positive;
  const posId = Array.isArray(pos) ? String(pos[0]) : "";
  if (workflow[posId]?.class_type !== "CLIPTextEncode") {
    throw new Error(
      `${SFX_ACTION}: KSampler positive must be a CLIPTextEncode`,
    );
  }
  const seed = seedFrom(params);
  setNodeInput(workflow, posId, "text", prompt);
  setNodeInput(
    workflow,
    latentId,
    "seconds",
    clampRange(params.duration, SFX_DURATION),
  );
  setNodeInput(workflow, samplerId, "seed", seed);

  return {
    workflow,
    slots: EMPTY_SLOTS(samplerId, posId, "text"),
    seed,
  };
}
