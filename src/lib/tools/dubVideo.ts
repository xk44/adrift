/**
 * Dub video: translate the speech of a clip into another language in the
 * speaker's own voice. Pure planning (catalog, limits, LLM prompt, output
 * parsing, step graph); the executor lives in dubRunner.ts and the graph
 * builders in src/lib/oj/dubVideo.ts.
 *
 *   transcribe  dub_transcribe: Whisper (CJWhisperASR) on the clip's audio,
 *               or dub_transcribe_speakers: VibeVoice-ASR with speaker labels
 *   translate   dub_translate: Qwen3-VL 8B TextGenerate, length-matched
 *   voice       dub_voice: VibeVoice-1.5B cloning the original speaker, or
 *               dub_voice_chatterbox (Chatterbox multilingual v3); "auto"
 *               picks per target language
 *   lipsync     video_lipsync: InfiniteTalk face-only re-render + paste-back
 *   mux         dub_mux (audio-only mode): new speech over the source frames,
 *               optionally over the original audio turned down
 *   mix         dub_mux on the lipsynced frames (lipsync mode, only when the
 *               original audio is kept under the dub)
 */
import type { StepOutput, StepStatus } from "./pipelines";

export type DubMode = "lipsync" | "audio";

export interface DubLanguage {
  id: string;
  label: string;
  /** Whisper's language name (CJWhisperASR `language`). */
  whisper: string;
}

/** Target languages (also the optional spoken-language hint for Whisper). */
export const DUB_LANGUAGES: readonly DubLanguage[] = [
  { id: "en", label: "English", whisper: "english" },
  { id: "es", label: "Spanish", whisper: "spanish" },
  { id: "fr", label: "French", whisper: "french" },
  { id: "de", label: "German", whisper: "german" },
  { id: "it", label: "Italian", whisper: "italian" },
  { id: "pt", label: "Portuguese", whisper: "portuguese" },
  { id: "nl", label: "Dutch", whisper: "dutch" },
  { id: "pl", label: "Polish", whisper: "polish" },
  { id: "ru", label: "Russian", whisper: "russian" },
  { id: "uk", label: "Ukrainian", whisper: "ukrainian" },
  { id: "tr", label: "Turkish", whisper: "turkish" },
  { id: "ar", label: "Arabic", whisper: "arabic" },
  { id: "hi", label: "Hindi", whisper: "hindi" },
  { id: "ja", label: "Japanese", whisper: "japanese" },
  { id: "ko", label: "Korean", whisper: "korean" },
  { id: "zh", label: "Chinese (Mandarin)", whisper: "chinese" },
  { id: "id", label: "Indonesian", whisper: "indonesian" },
  { id: "vi", label: "Vietnamese", whisper: "vietnamese" },
  // Chatterbox multilingual speaks these too (VibeVoice only with an accent).
  { id: "da", label: "Danish", whisper: "danish" },
  { id: "el", label: "Greek", whisper: "greek" },
  { id: "fi", label: "Finnish", whisper: "finnish" },
  { id: "he", label: "Hebrew", whisper: "hebrew" },
  { id: "ms", label: "Malay", whisper: "malay" },
  { id: "no", label: "Norwegian", whisper: "norwegian" },
  { id: "sv", label: "Swedish", whisper: "swedish" },
];

export const DUB_DEFAULT_TARGET = "es";
/** VibeVoice-1.5B was trained on English and Mandarin; others may sound accented. */
export const DUB_STRONG_VOICE_LANGS = new Set(["en", "zh"]);

/** A concrete TTS engine of the voice step. */
export type DubTtsEngine = "vibevoice" | "chatterbox";
/** Engine choice in the tool: "auto" resolves per target (dubResolveEngine). */
export type DubVoiceEngine = "auto" | DubTtsEngine;
export const DUB_DEFAULT_ENGINE: DubVoiceEngine = "auto";
export const DUB_VOICE_ENGINES: readonly {
  id: DubVoiceEngine;
  label: string;
}[] = [
  { id: "auto", label: "Auto" },
  { id: "vibevoice", label: "VibeVoice" },
  { id: "chatterbox", label: "Chatterbox" },
];
/**
 * Dub targets Chatterbox multilingual (t3_mtl23ls_v3, 23 languages) can
 * speak: all DUB_LANGUAGES except Ukrainian, Indonesian and Vietnamese.
 */
export const CHATTERBOX_DUB_LANGS: ReadonlySet<string> = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "tr",
  "ar",
  "hi",
  "ja",
  "ko",
  "zh",
  "da",
  "el",
  "fi",
  "he",
  "ms",
  "no",
  "sv",
]);
/** Seconds of the original speaker Chatterbox clones from. */
export const DUB_CHATTERBOX_REF_SECONDS = 10;
export const DUB_CHATTERBOX_MODEL_PACK = "chatterbox_local";
export const DUB_CHATTERBOX_MODEL_VERSION = "t3_mtl23ls_v3.safetensors";

export function dubEngineSupports(
  engine: DubVoiceEngine,
  target: string,
): boolean {
  return engine === "chatterbox" ? CHATTERBOX_DUB_LANGS.has(target) : true;
}

/**
 * Engine that actually voices `target`. Auto: VibeVoice for English and
 * Chinese (its training languages), Chatterbox multilingual for every other
 * language it was trained on, VibeVoice for the rest (uk / id / vi).
 */
export function dubResolveEngine(
  engine: DubVoiceEngine,
  target: string,
  clone = true,
): DubTtsEngine {
  // A stock (non-cloned) voice is Chatterbox's built-in speaker.
  if (!clone) return "chatterbox";
  if (engine !== "auto") return engine;
  if (DUB_STRONG_VOICE_LANGS.has(target)) return "vibevoice";
  return CHATTERBOX_DUB_LANGS.has(target) ? "chatterbox" : "vibevoice";
}

/**
 * Keep the original audio under the dub, in percent of its level (0 = replace
 * it). Without source separation the original voice stays in that bed too, so
 * low levels work best (room tone / music under the new speech).
 */
export const DUB_BACKGROUND_DEFAULT = 0;
export const DUB_BACKGROUND_MAX = 100;
/** Quietest gain the mix uses (AudioAdjustVolume takes whole dB). */
export const DUB_BACKGROUND_MIN_DB = -40;

/** Clamp a background level to 0..100 (whole percent). */
export function dubBackgroundLevel(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.round(Math.min(DUB_BACKGROUND_MAX, Math.max(0, n)));
}

/** Percent level -> whole-dB gain for AudioAdjustVolume; null = replace. */
export function dubBackgroundDb(level: number): number | null {
  const pct = dubBackgroundLevel(level);
  if (pct <= 0) return null;
  const db = Math.round(20 * Math.log10(pct / 100));
  return Math.max(DUB_BACKGROUND_MIN_DB, Math.min(0, db));
}

/**
 * Level the "Keep original audio" switch starts at: 12% = about -18 dB, low
 * enough that the original voice sits under the dub as room tone.
 */
export const DUB_BACKGROUND_KEEP_DEFAULT = 12;
/** Lowest level the slider offers while the switch is on. */
export const DUB_BACKGROUND_KEEP_MIN = 1;

/** Saved "Keep original audio" setting: switch + the level it mixes at. */
export interface DubBackgroundPref {
  keep: boolean;
  level: number;
}

export const DUB_BACKGROUND_STORAGE_KEY = "adrift.tools.dub.background.v1";

type DubStorage = Pick<Storage, "getItem" | "setItem">;

/** Level the mix uses: 0 (replace) when the switch is off. */
export function dubBackgroundFromPref(pref: DubBackgroundPref): number {
  return pref.keep ? dubBackgroundLevel(pref.level) : 0;
}

function keepLevel(raw: unknown): number {
  const level = dubBackgroundLevel(raw);
  return level >= DUB_BACKGROUND_KEEP_MIN ? level : DUB_BACKGROUND_KEEP_DEFAULT;
}

export function readDubBackground(
  storage: DubStorage | null,
): DubBackgroundPref {
  const fallback = { keep: false, level: DUB_BACKGROUND_KEEP_DEFAULT };
  try {
    const raw = storage?.getItem(DUB_BACKGROUND_STORAGE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) as { keep?: unknown; level?: unknown };
    return { keep: data?.keep === true, level: keepLevel(data?.level) };
  } catch {
    return fallback;
  }
}

export function writeDubBackground(
  storage: DubStorage | null,
  pref: DubBackgroundPref,
): void {
  try {
    storage?.setItem(
      DUB_BACKGROUND_STORAGE_KEY,
      JSON.stringify({ keep: pref.keep, level: keepLevel(pref.level) }),
    );
  } catch {
    /* private mode / blocked storage */
  }
}

/** InfiniteTalk span (= VIDEO_LIPSYNC_MAX_SECONDS, 369 frames at 25 fps). */
export const DUB_LIPSYNC_MAX_SECONDS = 14.76;
/** Audio-only span: frames are decoded at 25 fps / 1280 px for the mux. */
export const DUB_AUDIO_MAX_SECONDS = 30;
/** Seconds of the original speaker VibeVoice clones from. */
export const DUB_VOICE_REF_SECONDS = 20;
/** Fixed frame rate of the audio-only mux (dub_mux). */
export const DUB_MUX_FPS = 25;
/** Cap on transcript / translation text sent to the LLM and TTS. */
export const DUB_MAX_CHARS = 1200;
export const DUB_TRANSLATE_MAX_TOKENS = 1024;

export function dubLanguage(id: string): DubLanguage | undefined {
  return DUB_LANGUAGES.find((l) => l.id === id);
}

export function dubMaxSeconds(mode: DubMode): number {
  return mode === "lipsync" ? DUB_LIPSYNC_MAX_SECONDS : DUB_AUDIO_MAX_SECONDS;
}

/** Seconds of the clip that get dubbed: clip length capped by the mode. */
export function dubSpanSeconds(
  mode: DubMode,
  clipSeconds?: number | null,
): number {
  const cap = dubMaxSeconds(mode);
  const s =
    typeof clipSeconds === "number" &&
    Number.isFinite(clipSeconds) &&
    clipSeconds > 0
      ? Math.min(cap, clipSeconds)
      : cap;
  return Math.round(Math.max(0.5, s) * 100) / 100;
}

/** Speech may outlast the dubbed span by this much before we warn. */
export const DUB_OVERRUN_TOLERANCE = 0.3;

/**
 * Seconds of dubbed speech that lipsync / mux would cut (both trim the speech
 * to the span), or null when it fits. Translations often run longer than the
 * original (live en->es: 12.4 s of speech for a 10.6 s clip).
 */
export function dubOverrunSeconds(
  state: DubState,
  clipSeconds?: number | null,
): number | null {
  const voice = state.steps.voice;
  const said = voice?.status === "done" ? voice.output?.seconds : null;
  if (typeof said !== "number" || !(said > 0)) return null;
  const over = said - dubSpanSeconds(state.mode, clipSeconds);
  return over > DUB_OVERRUN_TOLERANCE ? Math.round(over * 10) / 10 : null;
}

export interface DubSegment {
  start: number;
  end: number;
  text: string;
  /** Speaker label from VibeVoice-ASR (Whisper has none). */
  speaker?: number;
}

/** "one": Whisper + one cloned voice. "several": a voice per detected speaker. */
export type DubSpeakers = "one" | "several";
export const DUB_DEFAULT_SPEAKERS: DubSpeakers = "one";
/** VibeVoiceTTS has four speaker_N_voice inputs. */
export const DUB_MAX_SPEAKERS = 4;

/** Where one speaker's clone reference sits in the clip. */
export interface DubSpeakerRef {
  /** 1-based label the script uses: [1], [2]... */
  speaker: number;
  start: number;
  seconds: number;
}

/** Shortest speech (s) a Several speakers clone is taken from. */
export const DUB_MIN_REF_SECONDS = 2;

/** A whole segment in brackets: VibeVoice-ASR's [Music], [Noise], [Silence]. */
const NON_SPEECH_SEGMENT = /^\[[^\]]*\]$/;

/** The segments somebody actually says: the rest must not be voiced or cloned. */
export function dubSpeechSegments(segments: DubSegment[]): DubSegment[] {
  return segments.filter((s) => !NON_SPEECH_SEGMENT.test(s.text.trim()));
}

/** A one-speaker result is retried on this many copies of the clip. */
export const DUB_RETRY_COPIES = 3;
/** Silence (s) between those copies. */
export const DUB_RETRY_GAP_SECONDS = 1;

/**
 * Segments from the repeated clip -> one copy's segments on the clip's own
 * timeline. Takes the copy with the most speech, since a copy can lose lines,
 * and renumbers speakers from 0 as a labelled copy may skip some.
 */
export function dubBestCopy(
  segments: DubSegment[],
  seconds: number,
  copies = DUB_RETRY_COPIES,
  gap = DUB_RETRY_GAP_SECONDS,
): DubSegment[] {
  const period = seconds + gap;
  const byCopy: DubSegment[][] = Array.from({ length: copies }, () => []);
  for (const s of segments) {
    const i = Math.floor(s.start / period);
    const start = s.start - i * period;
    if (i >= copies || start >= seconds) continue;
    byCopy[i].push({
      ...s,
      start,
      end: Math.min(seconds, s.end - i * period),
    });
  }
  const speech = (list: DubSegment[]) =>
    list.reduce((sum, s) => sum + s.end - s.start, 0);
  const best = byCopy.reduce((a, b) => (speech(b) > speech(a) ? b : a));
  const labels = new Map<number, number>();
  return best.map((s) => {
    const id = s.speaker ?? 0;
    if (!labels.has(id)) labels.set(id, labels.size);
    return { ...s, speaker: labels.get(id)! };
  });
}

/** Gap (s) above which one speaker's lines are not one stretch of speech. */
const DUB_REF_MAX_GAP = 0.5;

/**
 * Speech-only runs for a voice reference, numbered as speakerTurns numbers
 * them: a gap means something else may be in there (music, a filtered [Noise]).
 */
function unbrokenTurns(segments: DubSegment[]): DubSegment[] {
  const number = new Map<number, number>();
  for (const s of segments) {
    const id = s.speaker ?? 0;
    if (!number.has(id)) number.set(id, number.size + 1);
  }
  const raw = segments.filter((s) => typeof s.speaker === "number");
  const runs: DubSegment[] = [];
  for (const s of raw) {
    const speaker = number.get(s.speaker!) ?? s.speaker!;
    const last = runs[runs.length - 1];
    if (last && last.speaker === speaker && s.start - last.end <= DUB_REF_MAX_GAP) {
      last.end = Math.max(last.end, s.end);
    } else {
      runs.push({ ...s, speaker });
    }
  }
  return runs;
}

/** Consecutive segments of one speaker as one turn, labels 1.. by first appearance. */
function speakerTurns(segments: DubSegment[]): DubSegment[] {
  const ids = new Map<number, number>();
  const turns: DubSegment[] = [];
  for (const seg of segments) {
    const raw = seg.speaker ?? 0;
    if (!ids.has(raw)) ids.set(raw, ids.size + 1);
    const speaker = ids.get(raw)!;
    const last = turns[turns.length - 1];
    if (last?.speaker === speaker) {
      last.end = seg.end;
      last.text = `${last.text} ${seg.text}`;
    } else turns.push({ ...seg, speaker });
  }
  return turns;
}

export function dubSpeakerCount(segments: DubSegment[]): number {
  return new Set(segments.map((s) => s.speaker ?? 0)).size;
}

/** Segments -> editable script, one "[n] text" line per turn. */
export function dubSpeakerScript(segments: DubSegment[]): string {
  return speakerTurns(segments)
    .map((t) => `[${t.speaker}] ${t.text}`)
    .join("\n");
}

/** Each speaker's longest turn is their clone reference. */
export function dubSpeakerRefs(segments: DubSegment[]): DubSpeakerRef[] {
  const best = new Map<number, DubSegment>();
  for (const t of unbrokenTurns(segments)) {
    const cur = best.get(t.speaker!);
    if (!cur || t.end - t.start > cur.end - cur.start) best.set(t.speaker!, t);
  }
  return [...best.values()]
    .sort((a, b) => a.speaker! - b.speaker!)
    .map((t) => ({
      speaker: t.speaker!,
      start: t.start,
      seconds: Math.min(DUB_VOICE_REF_SECONDS, t.end - t.start),
    }));
}

const SPEAKER_LINE = /^\[([1-9])\]\s*:?\s*/;

/** True for a script whose every line opens with a speaker label. */
export function dubIsSpeakerScript(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => SPEAKER_LINE.test(l.trim()));
}

/** The labels of a script, line by line. */
export function dubScriptLabels(text: string): number[] {
  return text
    .split("\n")
    .map((l) => SPEAKER_LINE.exec(l.trim())?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
}

/**
 * LLM reply or user edit -> "[n] text" lines, capped. A line without a label
 * continues the one before it (models wrap long turns).
 */
export function cleanSpeakerScript(raw: string): string {
  const lines: string[] = [];
  const body = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "");
  for (const rawLine of body.split("\n")) {
    const line = oneLine(rawLine);
    if (!line) continue;
    const m = SPEAKER_LINE.exec(line);
    if (m) lines.push(`[${m[1]}] ${line.slice(m[0].length)}`);
    else if (lines.length) lines[lines.length - 1] += ` ${line}`;
  }
  return lines.join("\n").slice(0, DUB_MAX_CHARS).trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasCjk(text: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯]/.test(text);
}

/** "12 words" / "34 characters" (CJK has no spaces to count). */
export function lengthHint(text: string): string {
  const t = oneLine(text);
  if (hasCjk(t)) return `${t.replace(/\s/g, "").length} characters`;
  const words = t ? t.split(" ").length : 0;
  return `${words} word${words === 1 ? "" : "s"}`;
}

/**
 * LLM prompt for the translate step. Built on the server from structured
 * params (the client never sends a free-form prompt).
 */
export function dubTranslatePrompt(o: {
  transcript: string;
  target: string;
  source?: string;
  seconds?: number;
}): string {
  const target = dubLanguage(o.target);
  if (!target) throw new Error(`Unknown target language "${o.target}"`);
  const source = o.source ? dubLanguage(o.source) : undefined;
  if (dubIsSpeakerScript(o.transcript)) {
    const script = cleanSpeakerScript(o.transcript);
    return [
      `Translate this dialogue into ${target.label} for a video dub.`,
      "Rules:",
      "- Each line is one turn. It opens with a speaker label such as [1]. Keep every label exactly, in the same order, and reply with exactly one line per turn.",
      "- Keep the meaning, tone and register of each speaker.",
      `- Each line must take about as long to say as the original: keep a similar syllable count${
        typeof o.seconds === "number" && o.seconds > 0
          ? ` (about ${Math.round(o.seconds * 10) / 10} seconds in total)`
          : ""
      }, and shorten rather than pad.`,
      "- Keep names as they are. Write numbers the way a speaker says them.",
      `- Reply with only the labelled lines in ${target.label}, in its usual script. No quotes, no notes.`,
      "",
      `Original${source ? ` (${source.label})` : ""}:`,
      script,
    ].join("\n");
  }
  const text = oneLine(o.transcript).slice(0, DUB_MAX_CHARS);
  const timing =
    typeof o.seconds === "number" && o.seconds > 0
      ? `about ${Math.round(o.seconds * 10) / 10} seconds, ${lengthHint(text)}`
      : lengthHint(text);
  return [
    `Translate this spoken line into ${target.label} for a video dub.`,
    "Rules:",
    "- Keep the meaning, tone and register. The same person will say it on screen.",
    `- It must take about as long to say as the original (${timing}): keep a similar syllable count, and condense the wording rather than add to it.`,
    "- Keep names as they are. Write numbers the way a speaker says them.",
    `- Reply with only the translated line in ${target.label}, in its usual script. No quotes, labels, notes or explanations.`,
    "",
    `Original${source ? ` (${source.label})` : ""}:`,
    text,
  ].join("\n");
}

/** LLM reply -> the bare translated line. */
export function cleanTranslation(raw: string): string {
  let t = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "");
  t = oneLine(t)
    .replace(
      /^(translation|translated line|dub|output)\s*(\([^)]*\))?\s*:\s*/i,
      "",
    )
    .trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["“", "”"],
    ["«", "»"],
    ["「", "」"],
    ["'", "'"],
  ];
  for (const [a, b] of pairs) {
    if (t.length > 1 && t.startsWith(a) && t.endsWith(b)) {
      t = t.slice(a.length, t.length - b.length).trim();
      break;
    }
  }
  return t.slice(0, DUB_MAX_CHARS).trim();
}

/** Script handed to VibeVoice: one line, capped. */
export function dubVoiceScript(text: string): string {
  return oneLine(text).slice(0, DUB_MAX_CHARS).trim();
}

function toSegment(v: unknown): DubSegment | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? oneLine(o.text) : "";
  const start = Number(o.start);
  const end = Number(o.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const speaker = Number(o.speaker);
  return {
    start,
    end: Math.max(start, end),
    text,
    ...(o.speaker !== undefined && Number.isInteger(speaker) ? { speaker } : {}),
  };
}

/** dub_transcribe's two text outputs -> transcript + segments (any order). */
export function parseTranscription(texts: string[]): {
  transcript: string;
  segments: DubSegment[];
} {
  let transcript = "";
  let segments: DubSegment[] | null = null;
  for (const raw of texts) {
    const t = raw.trim();
    if (segments === null && t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) {
          segments = parsed
            .map(toSegment)
            .filter((s): s is DubSegment => s !== null);
          continue;
        }
      } catch {
        /* a transcript that happens to start with "[" */
      }
    }
    if (!transcript) transcript = oneLine(t);
  }
  const segs = segments ?? [];
  if (!transcript)
    transcript = segs
      .map((s) => s.text)
      .join(" ")
      .trim();
  return { transcript: transcript.slice(0, DUB_MAX_CHARS), segments: segs };
}

// Step graph (linear)

export type DubStepKind =
  "transcribe" | "translate" | "voice" | "lipsync" | "mux" | "mix";

export interface DubStep {
  id: DubStepKind;
  status: StepStatus;
  error?: string;
  runId?: string;
  jobIndex?: number;
  output?: StepOutput;
}

export interface DubState {
  mode: DubMode;
  /** Original audio kept under the dub, 0-100 % (0 = replace it). */
  background: number;
  order: DubStepKind[];
  steps: Record<string, DubStep>;
  transcript: string;
  segments: DubSegment[];
  /** Editable: the user may fix the translation before (re-)voicing. */
  translation: string;
}

/**
 * Steps for a mode. Audio-only mixes the original audio in its mux step; the
 * lipsync mode needs a separate mix step after the lipsync, and only when the
 * original audio is kept.
 */
export function dubOrder(mode: DubMode, background = 0): DubStepKind[] {
  if (mode === "audio") return ["transcribe", "translate", "voice", "mux"];
  const order: DubStepKind[] = ["transcribe", "translate", "voice", "lipsync"];
  if (dubBackgroundLevel(background) > 0) order.push("mix");
  return order;
}

export function dubDependencies(
  id: string,
  order: readonly string[],
): string[] {
  const i = order.indexOf(id);
  return i > 0 ? [order[i - 1]] : [];
}

export function initialDub(
  mode: DubMode,
  background = DUB_BACKGROUND_DEFAULT,
): DubState {
  const level = dubBackgroundLevel(background);
  const order = dubOrder(mode, level);
  const steps: Record<string, DubStep> = {};
  for (const id of order) steps[id] = { id, status: "idle" };
  return {
    mode,
    background: level,
    order,
    steps,
    transcript: "",
    segments: [],
    translation: "",
  };
}

/** Reset `id` and every later step; drops the text those steps produced. */
export function dubInvalidate(state: DubState, id: string): DubState {
  const i = state.order.indexOf(id as DubStepKind);
  if (i < 0) return state;
  const steps = { ...state.steps };
  for (const s of state.order.slice(i)) steps[s] = { id: s, status: "idle" };
  return {
    ...state,
    steps,
    ...(i <= 0 ? { transcript: "", segments: [] } : {}),
    ...(i <= 1 ? { translation: "" } : {}),
  };
}

export function dubUpdateStep(
  state: DubState,
  id: string,
  patch: Partial<DubStep>,
): DubState {
  const cur = state.steps[id] ?? { id: id as DubStepKind, status: "idle" };
  return { ...state, steps: { ...state.steps, [id]: { ...cur, ...patch } } };
}

export function dubNextRunnable(state: DubState): DubStepKind | null {
  for (const id of state.order) {
    const st = state.steps[id]?.status;
    if (st === "done" || st === "error") continue;
    return dubDependencies(id, state.order).every(
      (d) => state.steps[d]?.status === "done",
    )
      ? id
      : null;
  }
  return null;
}

export function dubCanRerun(state: DubState, id: string): boolean {
  return dubDependencies(id, state.order).every(
    (d) => state.steps[d]?.status === "done",
  );
}

export function dubProgress(state: DubState): { done: number; total: number } {
  return {
    done: state.order.filter((s) => state.steps[s]?.status === "done").length,
    total: state.order.length,
  };
}

/** User edit of the translation: later steps must be redone with it. */
export function withTranslation(state: DubState, text: string): DubState {
  const next = { ...state, translation: text.slice(0, DUB_MAX_CHARS) };
  return next.steps.voice?.status === "idle"
    ? next
    : dubInvalidate(next, "voice");
}

/**
 * User edit of the transcript (fix what Whisper misheard): the translation
 * and everything after it must be redone. The edited text is kept.
 */
export function withTranscript(state: DubState, text: string): DubState {
  const transcript = text.slice(0, DUB_MAX_CHARS);
  if (state.steps.translate?.status === "idle") return { ...state, transcript };
  return { ...dubInvalidate(state, "translate"), transcript };
}

/**
 * New background level. Lipsync mode adds or drops the mix step (finished
 * steps before it are kept); the step that mixes (mux / mix) is redone.
 */
export function withBackground(state: DubState, level: number): DubState {
  const background = dubBackgroundLevel(level);
  if (background === state.background) return state;
  const order = dubOrder(state.mode, background);
  const steps: Record<string, DubStep> = {};
  for (const id of order)
    steps[id] =
      id === "mux" || id === "mix"
        ? { id, status: "idle" }
        : (state.steps[id] ?? { id, status: "idle" });
  return { ...state, background, order, steps };
}
