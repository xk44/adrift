/**
 * Music video (MiniMax H3 optional pack): a song + 1-3 character / style
 * reference images -> one continuous clip, rendered segment by segment.
 *
 *   1. Beats come from the browser detector (beats.ts) on the song, or on
 *      its drum stem when the optional CJAudioStems node (cj_stems, local
 *      Hybrid Demucs) has split it first.
 *   2. planMusicVideo cuts the chosen window of the song into segments near
 *      the target length, each boundary snapped to a beat (bar lines
 *      preferred), then frame-quantised at 24 fps.
 *   3. Each segment is one MiniMax H3 Ref2VA job (src/lib/oj/musicVideo.ts):
 *      the refs as <Picture i>, the segment's slice of the song frozen into
 *      the audio stream of the AV latent (so the picture is generated to the
 *      music), and from the second segment on the previous segment's last
 *      frame anchored at frame 0 (MiniMaxH3AddGuide). That overlap frame is
 *      dropped, so the cut is seamless in time. Turbo 4-step LoRA.
 *   4. An assemble job joins the kept frames and lays the original song
 *      window under them (the generated audio is never used).
 *
 * Lip-sync segments freeze the vocal stem (instead of the full mix) into the
 * audio stream, so the model hears the voice alone; the output still carries
 * the full song. Pure: planning, params and the hub card are unit-tested.
 */
import type { HubCard } from "./hub";
import type { EngineContext } from "./templates";
import { AUDIO_EXT, isSafeFileRef } from "./pipelines";
import { H3_MODEL_NAME } from "./h3License";

export const MUSIC_VIDEO_ACTION = "music_video";
export const MUSIC_VIDEO_ASSEMBLE_ACTION = "music_video_assemble";
export const MUSIC_VIDEO_STEMS_ACTION = "music_video_stems";
export const MUSIC_VIDEO_KEY = "special:music_video";
export const MUSIC_VIDEO_STEMS_NODE = "CJAudioStems";
export const MV_FPS = 24;
export const MV_MIN_SEGMENT_SECONDS = 3;
export const MV_MAX_SEGMENT_SECONDS = 15;
export const MV_DEFAULT_SEGMENT_SECONDS = 5;
export const MV_SEGMENT_CHOICES = [3, 5, 8, 10] as const;
export const MV_MIN_SECONDS = 2;
/** Every segment is a full H3 job; 60 s ~ 12 jobs at the default length. */
export const MV_MAX_SECONDS = 60;
export const MV_MAX_SEGMENTS = 16;
export const MV_MAX_REFS = 3;
export const MV_MAX_PROMPT = 600;
export const MV_DEFAULT_BPM = 120;
/** H3 max trained length (15 s); one segment never renders more. */
export const MV_MAX_RENDER_FRAMES = 362;
export const MV_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export const MV_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type MvAspect = (typeof MV_ASPECTS)[number];
/** ~0.4 MP, 32-px grid: sized so 15 s renders in one H3 pass. */
export const MV_SIZES: Record<MvAspect, { width: number; height: number }> = {
  "16:9": { width: 864, height: 480 },
  "9:16": { width: 480, height: 864 },
  "1:1": { width: 640, height: 640 },
};

/** Smallest valid H3 length (17k + 5 frames) holding `n` frames. */
export function h3Frames(n: number): number {
  const k = Math.max(0, Math.ceil((Math.max(5, Math.ceil(n)) - 5) / 17));
  return 17 * k + 5;
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function finite(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Prompt text: one line, no --flags / :: weights, capped. */
export function cleanPrompt(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/-{2,}/g, " ")
        .replace(/::/g, ":")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MV_MAX_PROMPT)
    : "";
}

/**
 * Beats inside (0, duration), sorted, de-duplicated; a steady grid at `bpm`
 * when fewer than two are usable.
 */
export function cleanBeats(
  beats: readonly number[],
  duration: number,
  bpm: number | null,
): number[] {
  const out: number[] = [];
  for (const b of [...beats]
    .filter((b) => Number.isFinite(b) && b > 0.05 && b < duration - 0.05)
    .sort((a, b) => a - b))
    if (!out.length || b - out[out.length - 1] >= 0.1) out.push(r3(b));
  if (out.length >= 2) return out;
  const period = 60 / (bpm && bpm > 0 ? bpm : MV_DEFAULT_BPM);
  const grid: number[] = [];
  for (let t = period; t < duration - 0.05; t += period) grid.push(r3(t));
  return grid;
}

/** Beat times relative to a window [start, start + seconds) of the song. */
export function windowBeats(
  beats: readonly number[],
  start: number,
  seconds: number,
): number[] {
  return beats.map((b) => r3(b - start)).filter((b) => b > 0 && b < seconds);
}

/**
 * Which beat index phase (0..3) is most likely the bar line: the one whose
 * beats collect the most onsets within 60 ms. 0 without onsets.
 */
export function barPhase(
  beats: readonly number[],
  onsets: readonly number[] = [],
): number {
  if (!onsets.length || beats.length < 4) return 0;
  const sorted = [...onsets].sort((a, b) => a - b);
  const near = (t: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < t - 0.06) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length && sorted[lo] <= t + 0.06;
  };
  const score = [0, 0, 0, 0];
  beats.forEach((b, i) => {
    if (near(b)) score[i % 4]++;
  });
  let best = 0;
  for (let p = 1; p < 4; p++) if (score[p] > score[best]) best = p;
  return best;
}

export interface MvSegment {
  index: number;
  /** Window seconds (frame-quantised). */
  start: number;
  end: number;
  /** First kept frame / kept frame count on the 24 fps output timeline. */
  startFrame: number;
  frames: number;
}

/**
 * Segment bounds over [0, seconds): each next cut is the beat nearest
 * prev + target (bar lines win ties up to 3/4 of a beat), never closer than
 * MV_MIN_SEGMENT_SECONDS nor further than MV_MAX_SEGMENT_SECONDS; a short
 * tail is merged into (or split evenly with) the segment before it.
 */
export function segmentTimes(
  seconds: number,
  beats: readonly number[],
  target: number,
  phase = 0,
): number[] {
  const minS = MV_MIN_SEGMENT_SECONDS;
  const maxS = MV_MAX_SEGMENT_SECONDS;
  const t = clamp(target, minS, maxS);
  if (seconds <= Math.max(maxS, t + minS) && seconds <= t * 1.5)
    return [0, r3(seconds)];
  const period =
    beats.length >= 2
      ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1)
      : 60 / MV_DEFAULT_BPM;
  const bounds = [0];
  for (let guard = 0; guard < MV_MAX_SEGMENTS * 4; guard++) {
    const prev = bounds[bounds.length - 1];
    const left = seconds - prev;
    if (left <= maxS && left < t + minS) break;
    const hi = Math.min(prev + maxS, seconds - minS);
    let best: number | null = null;
    let bestScore = Infinity;
    beats.forEach((b, i) => {
      if (b < prev + minS || b > hi) return;
      const onBar = (i - phase) % 4 === 0;
      const s = Math.abs(b - (prev + t)) + (onBar ? 0 : period * 0.75);
      if (s < bestScore) {
        bestScore = s;
        best = b;
      }
    });
    bounds.push(r3(best ?? Math.min(prev + t, hi)));
  }
  bounds.push(r3(seconds));
  const n = bounds.length;
  if (n > 2 && bounds[n - 1] - bounds[n - 2] < minS) {
    if (bounds[n - 1] - bounds[n - 3] <= maxS) bounds.splice(n - 2, 1);
    else bounds[n - 2] = r3((bounds[n - 3] + bounds[n - 1]) / 2);
  }
  return bounds;
}

export interface MvPlanInput {
  /** Song length in seconds. */
  duration: number;
  /** Window start in the song (s) and its length (capped). */
  start?: number;
  seconds?: number;
  /** Song-time beats (or window-time when `beatsInWindow`). */
  beats: readonly number[];
  beatsInWindow?: boolean;
  onsets?: readonly number[];
  bpm: number | null;
  target?: number;
}

export interface MvPlan {
  start: number;
  seconds: number;
  frames: number;
  segments: MvSegment[];
}

/** The song window and its frame-quantised segments. */
export function planMusicVideo(input: MvPlanInput): MvPlan {
  const duration = finite(input.duration) ?? 0;
  if (duration < MV_MIN_SECONDS)
    throw new Error(`The song is under ${MV_MIN_SECONDS} s.`);
  const start = clamp(finite(input.start) ?? 0, 0, duration - MV_MIN_SECONDS);
  const want = finite(input.seconds) ?? duration - start;
  const seconds = r3(
    clamp(Math.min(want, duration - start), MV_MIN_SECONDS, MV_MAX_SECONDS),
  );
  const frames = Math.round(seconds * MV_FPS);
  const raw = input.beatsInWindow
    ? windowBeats(input.beats, 0, seconds)
    : windowBeats(input.beats, start, seconds);
  const beats = cleanBeats(raw, seconds, input.bpm);
  const onsets = input.beatsInWindow
    ? (input.onsets ?? [])
    : (input.onsets ?? []).map((o) => o - start);
  const target = clamp(
    finite(input.target) ?? MV_DEFAULT_SEGMENT_SECONDS,
    MV_MIN_SEGMENT_SECONDS,
    MV_MAX_SEGMENT_SECONDS,
  );
  const times = segmentTimes(seconds, beats, target, barPhase(beats, onsets));
  const cuts = times.map((x) => Math.min(frames, Math.round(x * MV_FPS)));
  cuts[cuts.length - 1] = frames;
  const segments: MvSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const f = cuts[i + 1] - cuts[i];
    if (f <= 0) continue;
    segments.push({
      index: segments.length,
      start: r3(cuts[i] / MV_FPS),
      end: r3(cuts[i + 1] / MV_FPS),
      startFrame: cuts[i],
      frames: f,
    });
  }
  if (segments.length > MV_MAX_SEGMENTS)
    throw new Error(
      `${segments.length} segments is too many (max ${MV_MAX_SEGMENTS}); use longer segments or a shorter window.`,
    );
  return { start: r3(start), seconds, frames, segments };
}

/** Frames one segment renders: its kept frames + the overlap frame. */
export function renderFrames(seg: Pick<MvSegment, "index" | "frames">): number {
  return h3Frames(seg.frames + (seg.index > 0 ? 1 : 0));
}

/** "<Picture 1>, <Picture 2>" style tag list for the refs. */
export function refTags(n: number): string {
  return Array.from({ length: n }, (_, i) => `<Picture ${i + 1}>`).join(", ");
}

/** The H3 prompt of one segment. */
export function segmentPrompt(opts: {
  style: string;
  shot?: string;
  refs: number;
  lipsync?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.refs > 0)
    parts.push(
      `A music video starring the character${opts.refs > 1 ? "s" : ""} from ${refTags(opts.refs)}.`,
    );
  else parts.push("A music video.");
  const shot = cleanPrompt(opts.shot);
  const style = cleanPrompt(opts.style);
  if (shot) parts.push(shot.replace(/[.!]?$/, "."));
  if (style) parts.push(style.replace(/[.!]?$/, "."));
  if (opts.lipsync)
    parts.push("The singer sings the vocals on camera, lips in sync.");
  parts.push("Motion follows the rhythm of the music.");
  return parts.join(" ").slice(0, 1200);
}

export interface MvSegmentParams {
  [key: string]: unknown;
  song: string;
  songStart: number;
  index: number;
  startFrame: number;
  frames: number;
  refs: string[];
  prompt: string;
  aspect: MvAspect;
  token: string;
  seed: number;
  prevFrame?: string;
  vocals?: string;
}

/** Run token: one sidecar folder per music video. */
export function mvToken(rand: () => number = Math.random): string {
  return (
    Date.now().toString(36) + Math.floor(rand() * 36 ** 6).toString(36)
  ).replace(/[^a-z0-9]/g, "");
}

/** Sidecar folder + SaveImage prefix of a segment's last frame. */
export function lastFramePrefix(token: string, index: number): string {
  return `video/adrift_ctx/CJ_MTV_${token}/seg${String(index + 1).padStart(2, "0")}_last`;
}

/** The ref the next segment loads (first file of that prefix). */
export function lastFrameRef(token: string, index: number): string {
  return `${lastFramePrefix(token, index)}_00001_.png [output]`;
}

export function isMvToken(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9]{6,32}$/.test(v);
}

export function isAspect(v: unknown): v is MvAspect {
  return typeof v === "string" && (MV_ASPECTS as readonly string[]).includes(v);
}

/** Validates action params of one segment (throws). */
export function normalizeSegmentParams(
  params: Record<string, unknown>,
): MvSegmentParams {
  const A = MUSIC_VIDEO_ACTION;
  if (!isSafeFileRef(params.song, AUDIO_EXT))
    throw new Error(`${A}: params.song must be an audio file ref`);
  const refs = Array.isArray(params.refs) ? params.refs : [];
  if (refs.length < 1 || refs.length > MV_MAX_REFS)
    throw new Error(`${A}: 1-${MV_MAX_REFS} reference images`);
  for (const r of refs)
    if (!isSafeFileRef(r, MV_IMAGE_EXT))
      throw new Error(`${A}: bad reference image ref`);
  const index = finite(params.index);
  const startFrame = finite(params.startFrame);
  const frames = finite(params.frames);
  if (
    index === undefined ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= MV_MAX_SEGMENTS
  )
    throw new Error(`${A}: params.index out of range`);
  if (
    startFrame === undefined ||
    !Number.isInteger(startFrame) ||
    startFrame < 0
  )
    throw new Error(`${A}: params.startFrame must be a frame index`);
  if (
    frames === undefined ||
    !Number.isInteger(frames) ||
    frames < 1 ||
    h3Frames(frames + (index > 0 ? 1 : 0)) > MV_MAX_RENDER_FRAMES
  )
    throw new Error(`${A}: params.frames out of range`);
  if (!isMvToken(params.token)) throw new Error(`${A}: bad params.token`);
  const token = params.token;
  let prevFrame: string | undefined;
  if (index > 0) {
    if (params.prevFrame !== lastFrameRef(token, index - 1))
      throw new Error(
        `${A}: params.prevFrame must be segment ${index}'s last frame`,
      );
    prevFrame = params.prevFrame as string;
  }
  let vocals: string | undefined;
  if (
    params.vocals !== undefined &&
    params.vocals !== null &&
    params.vocals !== ""
  ) {
    if (!isSafeFileRef(params.vocals, AUDIO_EXT))
      throw new Error(`${A}: params.vocals must be an audio file ref`);
    vocals = params.vocals;
  }
  const seed = finite(params.seed);
  return {
    song: params.song,
    songStart: Math.max(0, finite(params.songStart) ?? 0),
    index,
    startFrame,
    frames,
    refs: refs as string[],
    prompt: cleanPrompt(params.prompt).slice(0, 1200) || "A music video.",
    aspect: isAspect(params.aspect) ? params.aspect : "16:9",
    token,
    seed:
      seed !== undefined && seed >= 0
        ? Math.floor(seed) % 2 ** 48
        : Math.floor(Math.random() * 2 ** 32),
    ...(prevFrame ? { prevFrame } : {}),
    ...(vocals ? { vocals } : {}),
  };
}

export interface MvSegmentState {
  plan: MvPlan;
  index: number;
}

export interface MvOptions {
  style: string;
  /** Per-segment shot notes (index-aligned; missing = style only). */
  shots?: string[];
  /** Per-segment lip-sync flags (needs the vocal stem). */
  lipsync?: boolean[];
  aspect: MvAspect;
  seed?: number;
}

/** Params of every segment job, given the uploaded refs and the plan. */
export function segmentJobs(
  plan: MvPlan,
  refs: { song: string; images: string[]; vocals?: string | null },
  opts: MvOptions,
  token: string,
): MvSegmentParams[] {
  const base = finite(opts.seed) ?? Math.floor(Math.random() * 2 ** 31);
  return plan.segments.map((seg) => {
    const lip = !!opts.lipsync?.[seg.index] && !!refs.vocals;
    return {
      song: refs.song,
      songStart: plan.start,
      index: seg.index,
      startFrame: seg.startFrame,
      frames: seg.frames,
      refs: refs.images,
      prompt: segmentPrompt({
        style: opts.style,
        shot: opts.shots?.[seg.index],
        refs: refs.images.length,
        lipsync: lip,
      }),
      aspect: opts.aspect,
      token,
      seed: base + seg.index,
      ...(seg.index > 0
        ? { prevFrame: lastFrameRef(token, seg.index - 1) }
        : {}),
      ...(lip ? { vocals: refs.vocals! } : {}),
    };
  });
}

export interface MvAssembleParams {
  [key: string]: unknown;
  clips: string[];
  frames: number[];
  song: string;
  songStart: number;
  aspect: MvAspect;
}

export function normalizeAssembleParams(
  params: Record<string, unknown>,
): MvAssembleParams {
  const A = MUSIC_VIDEO_ASSEMBLE_ACTION;
  const clips = Array.isArray(params.clips) ? params.clips : [];
  const frames = Array.isArray(params.frames) ? params.frames : [];
  if (clips.length < 1 || clips.length > MV_MAX_SEGMENTS)
    throw new Error(`${A}: 1-${MV_MAX_SEGMENTS} clips`);
  if (frames.length !== clips.length)
    throw new Error(`${A}: one frame count per clip`);
  for (const c of clips)
    if (!isSafeFileRef(c, /\.(mp4|webm|mov|mkv)$/i))
      throw new Error(`${A}: bad clip ref`);
  const fr = frames.map((f) => finite(f));
  if (fr.some((f) => f === undefined || !Number.isInteger(f) || f < 1))
    throw new Error(`${A}: bad frame counts`);
  const total = (fr as number[]).reduce((a, b) => a + b, 0);
  if (total > MV_MAX_SECONDS * MV_FPS + MV_FPS)
    throw new Error(`${A}: longer than ${MV_MAX_SECONDS} s`);
  if (!isSafeFileRef(params.song, AUDIO_EXT))
    throw new Error(`${A}: params.song must be an audio file ref`);
  return {
    clips: clips as string[],
    frames: fr as number[],
    song: params.song,
    songStart: Math.max(0, finite(params.songStart) ?? 0),
    aspect: isAspect(params.aspect) ? params.aspect : "16:9",
  };
}

export interface MvStemsParams {
  [key: string]: unknown;
  song: string;
  songStart: number;
  seconds: number;
}

export function normalizeStemsParams(
  params: Record<string, unknown>,
): MvStemsParams {
  const A = MUSIC_VIDEO_STEMS_ACTION;
  if (!isSafeFileRef(params.song, AUDIO_EXT))
    throw new Error(`${A}: params.song must be an audio file ref`);
  const seconds = finite(params.seconds);
  if (seconds === undefined || seconds < MV_MIN_SECONDS)
    throw new Error(`${A}: params.seconds missing`);
  return {
    song: params.song,
    songStart: Math.max(0, finite(params.songStart) ?? 0),
    seconds: r3(Math.min(seconds, MV_MAX_SECONDS)),
  };
}

export const MUSIC_VIDEO_MODEL_LINE = `${H3_MODEL_NAME} Ref2VA + Turbo 4-step`;

/** Missing files / nodes per action from /api/tools/model-status. */
export interface MvModelStatus {
  tools: Record<string, { missing: string[] }>;
  failed?: boolean;
}

/** Stems need the CJAudioStems node + weights (model-status says so). */
export function stemsAvailable(
  status: MvModelStatus | null | undefined,
): boolean {
  const s = status?.tools?.[MUSIC_VIDEO_STEMS_ACTION];
  return !!s && s.missing.length === 0;
}

/** Hub card: needs the MiniMax H3 optional pack (and its weights). */
export function musicVideoCard(
  ctx: EngineContext,
  status?: MvModelStatus | null,
): HubCard {
  const packsKnown = !!ctx.packIds;
  const hasPack = packsKnown && ctx.packIds!.has("minimax");
  const missing = status?.tools?.[MUSIC_VIDEO_ACTION]?.missing ?? [];
  const reason = !packsKnown
    ? null
    : !hasPack
      ? "The MiniMax H3 pack is not installed (optional pack)."
      : missing.length
        ? `Missing on the ComfyUI box: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`
        : null;
  return {
    key: MUSIC_VIDEO_KEY,
    kind: "special",
    id: MUSIC_VIDEO_ACTION,
    title: "Music Video",
    subtitle:
      "A song and your characters become a beat-cut music video, generated to the music",
    icon: "Music",
    hubCategory: "Video",
    available: hasPack && missing.length === 0,
    unavailableReason: reason,
    licenseNote: null,
    checking: !packsKnown,
    model: MUSIC_VIDEO_MODEL_LINE,
    nc: false,
    aliases: [
      "music video",
      "mtv",
      "song",
      "beat sync",
      "audio to video",
      "lip sync",
      "singer",
      "clip",
    ],
  };
}

/** Which saved stem a history file is (by its SaveAudio prefix). */
export function stemOf(filename: string): "drums" | "vocals" | null {
  if (/CJ_MTV_drums/.test(filename)) return "drums";
  if (/CJ_MTV_vocals/.test(filename)) return "vocals";
  return null;
}
