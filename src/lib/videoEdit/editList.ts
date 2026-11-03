/**
 * Video editor: the non-destructive edit list.
 *
 * A project is an ordered list of clips; each clip points at a source file
 * (gallery output, upload, or a tool result) and plays its [in, out) range.
 * Timeline time is the clips laid end to end. Every operation here returns
 * a new list (the store keeps them for undo), never mutates, and is pure so
 * it runs the same on the client and in the render route.
 */

/** Source media for a clip: a same-origin URL the server knows how to read. */
export interface VideoSource {
  /**
   * "/api/comfy/image?filename=..&subfolder=..&type=output|input|temp" or
   * "/api/video-edit/media?f=<work file>".
   */
  url: string;
  /** Full source length in seconds. */
  duration: number;
  width: number;
  height: number;
  /** Frames per second (probe); 0 = unknown. */
  fps: number;
  hasAudio: boolean;
}

export interface VideoClip {
  id: string;
  src: VideoSource;
  /** Source seconds, 0 <= in < out <= src.duration. */
  in: number;
  out: number;
  muted: boolean;
  label: string;
  /** Tool that made this clip (a result that replaced a range). */
  madeBy?: string;
  /** Playback speed, MIN_SPEED..MAX_SPEED (absent = 1). */
  speed?: number;
  /** Audio gain, 0..MAX_VOLUME (absent = 1). */
  volume?: number;
  /** Fade from / to black and silence, timeline seconds (absent = 0). */
  fadeIn?: number;
  fadeOut?: number;
  /** Transition from the previous clip into this one (ignored on the first). */
  transitionIn?: Transition;
}

export const TRANSITION_TYPES = ["crossfade", "dip"] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/**
 * A transition centred on a cut, `d` timeline seconds long. Crossfade
 * blends the two clips (the render reads a little past each clip's edge,
 * holding the edge frame when the source has no more); dip fades to black
 * and back. Neither changes the timeline's length.
 */
export interface Transition {
  type: TransitionType;
  d: number;
}

/** Audio file on the A2 lane (music, voice-over). */
export interface AudioSource {
  url: string;
  duration: number;
}

/** A piece of an audio file placed at timeline time `start`. */
export interface AudioClip {
  id: string;
  src: AudioSource;
  start: number;
  /** Source seconds, 0 <= in < out <= src.duration. */
  in: number;
  out: number;
  /** 0..MAX_VOLUME (absent = 1). */
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  muted?: boolean;
  label: string;
}

export const OUTPUT_ASPECTS = [
  "16:9",
  "9:16",
  "1:1",
  "4:5",
  "4:3",
  "21:9",
] as const;
export type OutputAspect = (typeof OUTPUT_ASPECTS)[number];

/**
 * Export frame: crop every clip to `aspect`, keeping the point (x, y) of the
 * picture (0..1, 0.5 = centre) in view. Absent = the first clip's frame,
 * other sizes letterboxed into it.
 */
export interface OutputFrame {
  aspect: OutputAspect;
  x: number;
  y: number;
}

export interface EditList {
  v: 1;
  clips: VideoClip[];
  frame?: OutputFrame;
  /** A2 lane, mixed under the clips' own sound (absent = empty). */
  audio?: AudioClip[];
}

/** Shortest clip a trim / split may leave (about two frames at 24 fps). */
export const MIN_CLIP_SECONDS = 0.08;
export const MAX_CLIPS = 64;
/** Longest timeline the render route accepts (10 min). */
export const MAX_TIMELINE_SECONDS = 600;
export const DEFAULT_FPS = 24;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const MAX_VOLUME = 2;
/** Longest fade a clip may ask for (the render also caps it at half the clip). */
export const MAX_FADE_SECONDS = 10;
export const MIN_TRANSITION_SECONDS = 0.1;
export const MAX_TRANSITION_SECONDS = 3;
export const DEFAULT_TRANSITION_SECONDS = 0.5;
export const MAX_AUDIO_CLIPS = 32;

export const emptyEditList = (): EditList => ({ v: 1, clips: [] });

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

type Timed = Pick<VideoClip, "in" | "out"> & { speed?: number };

export function clipSpeed(c: { speed?: number }): number {
  const v = c.speed;
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? clamp(v, MIN_SPEED, MAX_SPEED)
    : 1;
}

export function clipVolume(c: { volume?: number }): number {
  const v = c.volume;
  return typeof v === "number" && Number.isFinite(v)
    ? clamp(v, 0, MAX_VOLUME)
    : 1;
}

/** Timeline seconds a clip plays for: its source range over its speed. */
export function clipLength(c: Timed): number {
  return Math.max(0, c.out - c.in) / clipSpeed(c);
}

/** Fades as they play: each at most half the clip, never negative. */
export function clipFades(c: Timed & Pick<VideoClip, "fadeIn" | "fadeOut">): {
  fadeIn: number;
  fadeOut: number;
} {
  const half = clipLength(c) / 2;
  const f = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? r6(Math.min(v, half, MAX_FADE_SECONDS))
      : 0;
  return { fadeIn: f(c.fadeIn), fadeOut: f(c.fadeOut) };
}

export function timelineDuration(list: EditList): number {
  return r6(list.clips.reduce((s, c) => s + clipLength(c), 0));
}

/**
 * The transition into clip `index` as it plays: none on the first clip, and
 * never longer than either clip (so it fits however short they are trimmed).
 */
export function transitionAt(list: EditList, index: number): Transition | null {
  const c = list.clips[index];
  const t = c?.transitionIn;
  if (index < 1 || !t || !TRANSITION_TYPES.includes(t.type)) return null;
  const d = r6(
    Math.min(
      Number.isFinite(t.d) ? t.d : 0,
      MAX_TRANSITION_SECONDS,
      clipLength(c),
      clipLength(list.clips[index - 1]),
    ),
  );
  return d >= 0.02 ? { type: t.type, d } : null;
}

/**
 * Fades of every clip as they play: a dip widens the fades on both sides of
 * its cut to half its length, a crossfade replaces them.
 */
export function effectiveFades(
  list: EditList,
): { fadeIn: number; fadeOut: number }[] {
  const out = list.clips.map((c) => clipFades(c));
  for (let i = 1; i < list.clips.length; i += 1) {
    const t = transitionAt(list, i);
    if (!t) continue;
    if (t.type === "crossfade") {
      out[i - 1].fadeOut = 0;
      out[i].fadeIn = 0;
    } else {
      const h = r6(t.d / 2);
      out[i - 1].fadeOut = Math.max(out[i - 1].fadeOut, h);
      out[i].fadeIn = Math.max(out[i].fadeIn, h);
    }
  }
  return out;
}

/** Set (or clear, with null) the transition into a clip. */
export function setTransition(
  list: EditList,
  id: string,
  t: Transition | null,
): EditList {
  let changed = false;
  const clips = list.clips.map((c) => {
    if (c.id !== id) return c;
    if (!t || !TRANSITION_TYPES.includes(t.type) || !Number.isFinite(t.d)) {
      if (!c.transitionIn) return c;
      changed = true;
      return withoutKey(c, "transitionIn");
    }
    const d = r6(
      clamp(round(t.d, 0.05), MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS),
    );
    if (c.transitionIn?.type === t.type && c.transitionIn.d === d) return c;
    changed = true;
    return { ...c, transitionIn: { type: t.type, d } };
  });
  return changed ? { ...list, clips } : list;
}

/** Start time of each clip on the timeline (same order as clips). */
export function clipStarts(list: EditList): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of list.clips) {
    out.push(r6(t));
    t += clipLength(c);
  }
  return out;
}

export interface ClipPosition {
  index: number;
  clip: VideoClip;
  /** Timeline start of the clip. */
  start: number;
  /** Seconds into the clip (0 .. length). */
  offset: number;
  /** Source time to seek to. */
  sourceTime: number;
}

/**
 * Clip under timeline time `t`. A time exactly on a cut belongs to the
 * clip that starts there; the very end belongs to the last clip.
 */
export function clipAt(list: EditList, t: number): ClipPosition | null {
  if (list.clips.length === 0) return null;
  const total = timelineDuration(list);
  const time = clamp(t, 0, total);
  let start = 0;
  for (let i = 0; i < list.clips.length; i += 1) {
    const clip = list.clips[i];
    const len = clipLength(clip);
    const last = i === list.clips.length - 1;
    if (time < start + len - 1e-9 || last) {
      const offset = clamp(time - start, 0, len);
      return {
        index: i,
        clip,
        start: r6(start),
        offset: r6(offset),
        sourceTime: r6(Math.min(clip.out, clip.in + offset * clipSpeed(clip))),
      };
    }
    start += len;
  }
  return null;
}

/** Cut points (clip boundaries) including 0 and the end. */
export function editPoints(list: EditList): number[] {
  const starts = clipStarts(list);
  return [...starts, timelineDuration(list)];
}

export function newClipId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `c_${rnd}`;
}

/** Whole-source clip. */
export function clipFromSource(
  src: VideoSource,
  label: string,
  id: string = newClipId(),
): VideoClip {
  return { id, src, in: 0, out: r6(src.duration), muted: false, label };
}

export function addClip(
  list: EditList,
  clip: VideoClip,
  index: number = list.clips.length,
): EditList {
  if (list.clips.length >= MAX_CLIPS) return list;
  const clips = [...list.clips];
  clips.splice(clamp(index, 0, clips.length), 0, clip);
  return { ...list, clips };
}

export function removeClip(list: EditList, id: string): EditList {
  const clips = list.clips.filter((c) => c.id !== id);
  if (clips.length === list.clips.length) return list;
  return withRipple(list, { ...list, clips }, clipEnd(list, id));
}

export function moveClip(list: EditList, from: number, to: number): EditList {
  const n = list.clips.length;
  if (from < 0 || from >= n || from === to) return list;
  const clips = [...list.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(clamp(to, 0, n - 1), 0, c);
  return { ...list, clips };
}

/**
 * Trim a clip to [inPoint, outPoint] source seconds. Clamped to the source
 * and to MIN_CLIP_SECONDS; no-op for an unknown id.
 */
export function trimClip(
  list: EditList,
  id: string,
  inPoint: number,
  outPoint: number,
): EditList {
  let changed = false;
  const clips = list.clips.map((c) => {
    if (c.id !== id) return c;
    const max = c.src.duration;
    // Edges on the source frame grid (the very end of the file stays).
    const fps = c.src.fps;
    let a = clamp(snapToFrame(inPoint, fps), 0, max);
    let b = clamp(
      outPoint >= max - 1e-6 ? max : snapToFrame(outPoint, fps),
      0,
      max,
    );
    // MIN_CLIP_SECONDS is timeline time; in / out are source seconds.
    const minSrc = MIN_CLIP_SECONDS * clipSpeed(c);
    if (b - a < minSrc) {
      // Keep the edge that moved; push the other one.
      if (a !== c.in) a = Math.max(0, b - minSrc);
      else b = Math.min(max, a + minSrc);
    }
    a = r6(a);
    b = r6(b);
    if (a === c.in && b === c.out) return c;
    changed = true;
    return { ...c, in: a, out: b };
  });
  return changed
    ? withRipple(list, { ...list, clips }, clipEnd(list, id))
    : list;
}

/**
 * Split the clip under timeline time `t` into two. No-op when `t` is on a
 * cut already or would leave a piece shorter than MIN_CLIP_SECONDS.
 */
export function splitAt(
  list: EditList,
  t: number,
  makeId: () => string = newClipId,
): EditList {
  const pos = clipAt(list, t);
  if (!pos) return list;
  const len = clipLength(pos.clip);
  if (pos.offset < MIN_CLIP_SECONDS || len - pos.offset < MIN_CLIP_SECONDS)
    return list;
  // Cut on the source's frame grid (never past the clip's ends).
  const minSrc = MIN_CLIP_SECONDS * clipSpeed(pos.clip);
  const cut = clamp(
    snapToFrame(pos.sourceTime, pos.clip.src.fps),
    pos.clip.in + minSrc,
    pos.clip.out - minSrc,
  );
  // The fade-out stays with the clip's end, the fade-in with its start.
  const left = withoutKey({ ...pos.clip, out: cut }, "fadeOut");
  const right = withoutKey(
    withoutKey({ ...pos.clip, id: makeId(), in: cut }, "fadeIn"),
    "transitionIn",
  );
  const clips = [...list.clips];
  clips.splice(pos.index, 1, left, right);
  return { ...list, clips };
}

export function setClipMuted(
  list: EditList,
  id: string,
  muted: boolean,
): EditList {
  let changed = false;
  const clips = list.clips.map((c) => {
    if (c.id !== id || c.muted === muted) return c;
    changed = true;
    return { ...c, muted };
  });
  return changed ? { ...list, clips } : list;
}

export function setAllMuted(list: EditList, muted: boolean): EditList {
  if (list.clips.every((c) => c.muted === muted)) return list;
  return { ...list, clips: list.clips.map((c) => ({ ...c, muted })) };
}

function withoutKey<K extends keyof VideoClip>(c: VideoClip, k: K): VideoClip {
  if (!(k in c)) return c;
  const out = { ...c };
  delete out[k];
  return out;
}

/** A piece of one source that a render plays, in timeline order. */
export interface RenderSegment {
  url: string;
  /** Source seconds. */
  in: number;
  out: number;
  muted: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  speed: number;
  volume: number;
  /** Fades (output seconds) when the piece holds that end of its clip. */
  fadeIn: number;
  fadeOut: number;
  /** Crossfade (seconds) with the previous segment, centred on the cut. */
  xfadeIn?: number;
}

/**
 * Pieces of sources covering timeline [start, end) (whole timeline when
 * omitted), for the render route. Empty when the range is empty.
 */
export function rangeSegments(
  list: EditList,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): RenderSegment[] {
  const total = timelineDuration(list);
  const a = clamp(start, 0, total);
  const b = clamp(end, 0, total);
  if (b - a <= 1e-6) return [];
  const out: RenderSegment[] = [];
  const allFades = effectiveFades(list);
  let t = 0;
  let prevTail = false;
  list.clips.forEach((c, i) => {
    const len = clipLength(c);
    const s = Math.max(a, t);
    const e = Math.min(b, t + len);
    const inRange = e - s > 1e-6;
    const head = s - t < 1e-6;
    const tail = t + len - e < 1e-6;
    if (inRange) {
      const sp = clipSpeed(c);
      const fades = allFades[i];
      const pieceLen = e - s;
      const tr = head && prevTail ? transitionAt(list, i) : null;
      out.push({
        url: c.src.url,
        in: r6(c.in + (s - t) * sp),
        out: r6(Math.min(c.out, c.in + (e - t) * sp)),
        muted: c.muted,
        hasAudio: c.src.hasAudio,
        width: c.src.width,
        height: c.src.height,
        fps: c.src.fps,
        speed: sp,
        volume: clipVolume(c),
        fadeIn: head ? r6(Math.min(fades.fadeIn, pieceLen / 2)) : 0,
        fadeOut: tail ? r6(Math.min(fades.fadeOut, pieceLen / 2)) : 0,
        ...(tr?.type === "crossfade" ? { xfadeIn: tr.d } : {}),
      });
    }
    prevTail = inRange && tail;
    t += len;
  });
  return out;
}

/**
 * The clips before and after timeline [start, end). Clips that straddle the
 * edges are cut exactly at the range (no minimum piece length, so nothing
 * around it is dropped or repeated); only leftovers shorter than half a
 * frame are discarded.
 */
function aroundRange(
  list: EditList,
  start: number,
  end: number,
  makeId: () => string,
): { before: VideoClip[]; after: VideoClip[] } {
  const total = timelineDuration(list);
  const a = clamp(Math.min(start, end), 0, total);
  const b = clamp(Math.max(start, end), 0, total);
  const before: VideoClip[] = [];
  const after: VideoClip[] = [];
  let t = 0;
  for (const c of list.clips) {
    const len = clipLength(c);
    const sp = clipSpeed(c);
    const s = t;
    const e = t + len;
    t = e;
    const sliver = frameSeconds(c.src.fps) / 2;
    // Part before the range.
    const keepA = Math.min(e, a) - s;
    if (keepA >= sliver) {
      before.push(
        keepA >= len - 1e-9
          ? c
          : withoutKey({ ...c, out: r6(c.in + keepA * sp) }, "fadeOut"),
      );
    }
    // Part after the range.
    const fromB = Math.max(s, b) - s;
    if (len - fromB >= sliver) {
      if (fromB <= 1e-9) after.push(c);
      else
        after.push(
          withoutKey(
            withoutKey(
              {
                ...c,
                // A clip that also kept its head needs a second id.
                id: keepA >= sliver ? makeId() : c.id,
                in: r6(c.in + fromB * sp),
              },
              "fadeIn",
            ),
            "transitionIn",
          ),
        );
    }
  }
  return { before, after };
}

/**
 * Replace timeline [start, end) with `clip` (a tool result for that range).
 * The new clip lands where the range began; the timeline length changes
 * when the result's does.
 */
export function replaceRange(
  list: EditList,
  start: number,
  end: number,
  clip: VideoClip,
  makeId: () => string = newClipId,
): EditList {
  const { before, after } = aroundRange(list, start, end, makeId);
  return withRipple(
    list,
    { ...list, clips: [...before, clip, ...after] },
    rangeEnd(list, start, end),
  );
}

/**
 * Ripple delete: remove timeline [start, end) and close the gap. No-op for
 * an empty range or one that covers everything (a project keeps a clip).
 */
export function rippleDelete(
  list: EditList,
  start: number,
  end: number,
  makeId: () => string = newClipId,
): EditList {
  if (Math.abs(end - start) < 1e-6) return list;
  const { before, after } = aroundRange(list, start, end, makeId);
  const clips = [...before, ...after];
  if (clips.length === 0) return list;
  const same =
    clips.length === list.clips.length &&
    clips.every((c, i) => c === list.clips[i]);
  return same
    ? list
    : withRipple(list, { ...list, clips }, rangeEnd(list, start, end));
}

/** Per-clip settings the clip panel edits. */
export type ClipFx = Partial<
  Pick<VideoClip, "speed" | "volume" | "fadeIn" | "fadeOut" | "muted" | "label">
>;

const round = (n: number, step: number) => Math.round(n / step) * step;

/**
 * Set a clip's speed / volume / fades / mute / label. Values are clamped
 * and rounded; defaults (speed 1, volume 1, fade 0) are stored as absent.
 */
export function updateClip(list: EditList, id: string, fx: ClipFx): EditList {
  let changed = false;
  const clips = list.clips.map((c) => {
    if (c.id !== id) return c;
    const next: VideoClip = { ...c };
    if (fx.speed !== undefined && Number.isFinite(fx.speed))
      next.speed = r6(clamp(round(fx.speed, 0.01), MIN_SPEED, MAX_SPEED));
    if (fx.volume !== undefined && Number.isFinite(fx.volume))
      next.volume = r6(clamp(round(fx.volume, 0.01), 0, MAX_VOLUME));
    if (fx.fadeIn !== undefined && Number.isFinite(fx.fadeIn))
      next.fadeIn = r6(clamp(round(fx.fadeIn, 0.01), 0, MAX_FADE_SECONDS));
    if (fx.fadeOut !== undefined && Number.isFinite(fx.fadeOut))
      next.fadeOut = r6(clamp(round(fx.fadeOut, 0.01), 0, MAX_FADE_SECONDS));
    if (fx.muted !== undefined) next.muted = fx.muted;
    if (fx.label !== undefined) next.label = fx.label.slice(0, 120);
    if (next.speed === 1) delete next.speed;
    if (next.volume === 1) delete next.volume;
    if (next.fadeIn === 0) delete next.fadeIn;
    if (next.fadeOut === 0) delete next.fadeOut;
    const keys = new Set([...Object.keys(c), ...Object.keys(next)]);
    const same = [...keys].every(
      (k) => c[k as keyof VideoClip] === next[k as keyof VideoClip],
    );
    if (same) return c;
    changed = true;
    return next;
  });
  return changed
    ? withRipple(list, { ...list, clips }, clipEnd(list, id))
    : list;
}

/** Set (or clear, with null) the export frame. */
export function setOutputFrame(
  list: EditList,
  frame: OutputFrame | null,
): EditList {
  if (!frame) {
    if (!list.frame) return list;
    const out = { ...list };
    delete out.frame;
    return out;
  }
  const next: OutputFrame = {
    aspect: frame.aspect,
    x: r6(clamp(frame.x, 0, 1)),
    y: r6(clamp(frame.y, 0, 1)),
  };
  const f = list.frame;
  if (f && f.aspect === next.aspect && f.x === next.x && f.y === next.y)
    return list;
  return { ...list, frame: next };
}

/** Width / height of an aspect name ("9:16" -> 0.5625). */
export function aspectRatio(a: OutputAspect): number {
  const [w, h] = a.split(":").map(Number);
  return w / h;
}

/** Frame duration for stepping (source fps, else the default). */
export function frameSeconds(fps: number | null | undefined): number {
  const f = fps && fps > 0 && fps <= 240 ? fps : DEFAULT_FPS;
  return 1 / f;
}

/** "HH:MM:SS:FF" (frames at `fps`), or "MM:SS.mmm" when fps is 0. */
export function formatTimecode(seconds: number, fps: number): string {
  const t = Math.max(0, seconds);
  if (!fps || fps <= 0) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  }
  const f = Math.round(fps);
  const totalFrames = Math.round(t * fps);
  const ff = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  const f = fps > 0 ? fps : DEFAULT_FPS;
  return r6(Math.round(t * f) / f);
}

// A2 audio lane

export function audioLength(c: Pick<AudioClip, "in" | "out">): number {
  return Math.max(0, c.out - c.in);
}

export function audioGain(c: Pick<AudioClip, "gain" | "muted">): number {
  if (c.muted) return 0;
  return clipVolume({ volume: c.gain });
}

/** Lane fades as they play: each at most half the clip. */
export function audioFades(
  c: Pick<AudioClip, "in" | "out" | "fadeIn" | "fadeOut">,
): { fadeIn: number; fadeOut: number } {
  return clipFades({
    in: c.in,
    out: c.out,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
  });
}

export function audioClipFromSource(
  src: AudioSource,
  label: string,
  start: number,
  id: string = newClipId().replace(/^c_/, "a_"),
): AudioClip {
  return {
    id,
    src,
    start: r6(clamp(start, 0, MAX_TIMELINE_SECONDS)),
    in: 0,
    out: r6(Math.min(src.duration, MAX_TIMELINE_SECONDS)),
    label,
  };
}

const laneOf = (list: EditList) => list.audio ?? [];

function mapAudio(
  list: EditList,
  id: string,
  fn: (c: AudioClip) => AudioClip,
): EditList {
  let changed = false;
  const audio = laneOf(list).map((c) => {
    if (c.id !== id) return c;
    const next = fn(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...list, audio } : list;
}

export function addAudioClip(list: EditList, clip: AudioClip): EditList {
  if (laneOf(list).length >= MAX_AUDIO_CLIPS) return list;
  return { ...list, audio: [...laneOf(list), clip] };
}

export function removeAudioClip(list: EditList, id: string): EditList {
  const lane = laneOf(list);
  const audio = lane.filter((c) => c.id !== id);
  if (audio.length === lane.length) return list;
  const out: EditList = { ...list, audio };
  if (audio.length === 0) delete out.audio;
  return out;
}

/** Place a lane clip at timeline `start` (never before 0). */
export function moveAudioClip(
  list: EditList,
  id: string,
  start: number,
): EditList {
  if (!Number.isFinite(start)) return list;
  const s = r6(clamp(start, 0, MAX_TIMELINE_SECONDS));
  return mapAudio(list, id, (c) => (c.start === s ? c : { ...c, start: s }));
}

/**
 * Trim a lane clip to [inPoint, outPoint] source seconds. Moving the in
 * edge moves the clip's start with it, so the sound stays where it was.
 */
export function trimAudio(
  list: EditList,
  id: string,
  inPoint: number,
  outPoint: number,
): EditList {
  return mapAudio(list, id, (c) => {
    const max = c.src.duration;
    // The in edge cannot pull the start before 0.
    let a = clamp(inPoint, Math.max(0, c.in - c.start), max);
    let b = clamp(outPoint, 0, max);
    if (b - a < MIN_CLIP_SECONDS) {
      if (a !== c.in) a = Math.max(0, b - MIN_CLIP_SECONDS);
      else b = Math.min(max, a + MIN_CLIP_SECONDS);
    }
    a = r6(a);
    b = r6(b);
    if (a === c.in && b === c.out) return c;
    return { ...c, in: a, out: b, start: r6(Math.max(0, c.start + a - c.in)) };
  });
}

export type AudioFx = Partial<
  Pick<AudioClip, "gain" | "fadeIn" | "fadeOut" | "muted" | "label">
>;

export function updateAudioClip(
  list: EditList,
  id: string,
  fx: AudioFx,
): EditList {
  return mapAudio(list, id, (c) => {
    const next: AudioClip = { ...c };
    if (fx.gain !== undefined && Number.isFinite(fx.gain))
      next.gain = r6(clamp(round(fx.gain, 0.01), 0, MAX_VOLUME));
    if (fx.fadeIn !== undefined && Number.isFinite(fx.fadeIn))
      next.fadeIn = r6(clamp(round(fx.fadeIn, 0.01), 0, MAX_FADE_SECONDS));
    if (fx.fadeOut !== undefined && Number.isFinite(fx.fadeOut))
      next.fadeOut = r6(clamp(round(fx.fadeOut, 0.01), 0, MAX_FADE_SECONDS));
    if (fx.muted !== undefined) next.muted = fx.muted;
    if (fx.label !== undefined) next.label = fx.label.slice(0, 120);
    if (next.gain === 1) delete next.gain;
    if (next.fadeIn === 0) delete next.fadeIn;
    if (next.fadeOut === 0) delete next.fadeOut;
    if (next.muted === false) delete next.muted;
    const keys = new Set([...Object.keys(c), ...Object.keys(next)]);
    const same = [...keys].every(
      (k) => c[k as keyof AudioClip] === next[k as keyof AudioClip],
    );
    return same ? c : next;
  });
}

/** Split a lane clip at timeline time `t` (no-op off the clip or too close to an edge). */
export function splitAudioAt(
  list: EditList,
  id: string,
  t: number,
  makeId: () => string = () => newClipId().replace(/^c_/, "a_"),
): EditList {
  const lane = laneOf(list);
  const i = lane.findIndex((c) => c.id === id);
  if (i < 0 || lane.length >= MAX_AUDIO_CLIPS) return list;
  const c = lane[i];
  const off = t - c.start;
  if (off < MIN_CLIP_SECONDS || audioLength(c) - off < MIN_CLIP_SECONDS)
    return list;
  const cut = r6(c.in + off);
  const left: AudioClip = { ...c, out: cut };
  delete left.fadeOut;
  const right: AudioClip = { ...c, id: makeId(), in: cut, start: r6(t) };
  delete right.fadeIn;
  const audio = [...lane];
  audio.splice(i, 1, left, right);
  return { ...list, audio };
}

/** A piece of a lane clip a render mixes in. */
export interface AudioSegment {
  url: string;
  /** Source seconds. */
  in: number;
  out: number;
  /** Output seconds from the start of the render. */
  at: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * Audible lane pieces inside timeline [start, end) (clipped to the video:
 * sound past the last clip is not rendered).
 */
export function audioSegments(
  list: EditList,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): AudioSegment[] {
  const total = timelineDuration(list);
  const a = clamp(start, 0, total);
  const b = clamp(end, 0, total);
  if (b - a <= 1e-6) return [];
  const out: AudioSegment[] = [];
  for (const c of laneOf(list)) {
    const gain = audioGain(c);
    const len = audioLength(c);
    if (gain <= 0 || len <= 0) continue;
    const s = Math.max(a, c.start);
    const e = Math.min(b, c.start + len);
    if (e - s <= 1e-3) continue;
    const fades = audioFades(c);
    const pieceLen = e - s;
    const head = s - c.start < 1e-6;
    const tail = c.start + len - e < 1e-6;
    out.push({
      url: c.src.url,
      in: r6(c.in + (s - c.start)),
      out: r6(c.in + (e - c.start)),
      at: r6(s - a),
      gain,
      fadeIn: head ? r6(Math.min(fades.fadeIn, pieceLen / 2)) : 0,
      fadeOut: tail ? r6(Math.min(fades.fadeOut, pieceLen / 2)) : 0,
    });
  }
  return out;
}

function clipEnd(list: EditList, id: string): number {
  let t = 0;
  for (const c of list.clips) {
    t += clipLength(c);
    if (c.id === id) return t;
  }
  return t;
}

function rangeEnd(list: EditList, start: number, end: number): number {
  return clamp(Math.max(start, end), 0, timelineDuration(list));
}

function withRipple(prev: EditList, next: EditList, at: number): EditList {
  return rippleAudio(next, at, timelineDuration(next) - timelineDuration(prev));
}

/**
 * Keep the A2 lane in step with a V1 edit that ended at timeline `at` and
 * changed the timeline by `delta` seconds (negative: [at + delta, at) was
 * removed). Lane clips that start at or after the removed span's start
 * move by `delta`, never before that point.
 */
export function rippleAudio(
  list: EditList,
  at: number,
  delta: number,
): EditList {
  const lane = laneOf(list);
  if (!lane.length || !Number.isFinite(delta) || Math.abs(delta) < 1e-6)
    return list;
  const cut = Math.max(0, at + Math.min(0, delta));
  const moves = (c: AudioClip) => c.start >= cut - 1e-6;
  const shifted = lane.map((c) =>
    moves(c)
      ? r6(
          clamp(
            c.start >= at - 1e-6 ? c.start + delta : cut,
            cut,
            MAX_TIMELINE_SECONDS,
          ),
        )
      : c.start,
  );
  let changed = false;
  const audio = lane.map((c, i) => {
    let next = c;
    if (shifted[i] !== c.start) next = { ...c, start: shifted[i] };
    if (delta < 0 && !moves(c)) {
      // A clip spanning the cut keeps its start; it is cut short where a moved clip it did not overlap before now begins.
      const end = c.start + audioLength(c);
      const limit = Math.min(
        ...lane.map((o, j) =>
          moves(o) && o.start >= end - 1e-6 ? shifted[j] : Infinity,
        ),
      );
      if (limit < end - 1e-6) {
        const out = r6(c.in + Math.max(MIN_CLIP_SECONDS, limit - c.start));
        if (out < c.out) next = { ...next, out };
      }
    }
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...list, audio } : list;
}

/** One source frame a still is made of. */
export interface FrameLayer {
  url: string;
  /** Source seconds (held at the file's ends, like the render). */
  time: number;
  /** Share of the blend, 0..1 (layers sum to 1). */
  weight: number;
  /** Brightness after fades / dips, 0 (black) .. 1. */
  level: number;
}

/**
 * What the export shows at timeline `t`: the clip there (first), plus the
 * other clip of a crossfade around it, each darkened by its fades (a dip
 * is a pair of fades) the way the mp4 render draws them.
 */
export function frameLayers(list: EditList, t: number): FrameLayer[] {
  const total = timelineDuration(list);
  const pos = clipAt(list, Math.min(t, Math.max(0, total - 0.001)));
  if (!pos) return [];
  const starts = clipStarts(list);
  const fades = effectiveFades(list);
  const time = starts[pos.index] + pos.offset;
  const layer = (i: number, weight: number): FrameLayer => {
    const c = list.clips[i];
    const off = time - starts[i];
    const len = clipLength(c);
    const f = fades[i];
    let level = 1;
    if (f.fadeIn > 0) level = Math.min(level, off / f.fadeIn);
    if (f.fadeOut > 0) level = Math.min(level, (len - off) / f.fadeOut);
    return {
      url: c.src.url,
      time: r6(clamp(c.in + off * clipSpeed(c), 0, c.src.duration)),
      weight: r6(weight),
      level: r6(clamp(level, 0, 1)),
    };
  };
  const i = pos.index;
  const len = clipLength(pos.clip);
  const into = transitionAt(list, i);
  if (into?.type === "crossfade" && pos.offset < into.d / 2) {
    const p = (pos.offset + into.d / 2) / into.d;
    return [layer(i, p), layer(i - 1, 1 - p)];
  }
  const outOf = transitionAt(list, i + 1);
  if (outOf?.type === "crossfade" && len - pos.offset < outOf.d / 2) {
    const p = (pos.offset - (len - outOf.d / 2)) / outOf.d;
    return [layer(i, 1 - p), layer(i + 1, p)];
  }
  return [layer(i, 1)];
}

// validation (render route)

export class EditListError extends Error {}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Parse an untrusted edit list (request body). Throws EditListError with a
 * user-facing message. `isAllowedUrl` vets every source URL (the route
 * checks they point at files it may read).
 */
export function parseEditList(
  raw: unknown,
  isAllowedUrl: (url: string) => boolean,
  isAllowedAudioUrl?: (url: string) => boolean,
): EditList {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new EditListError("edit list must be an object");
  const clipsRaw = (raw as { clips?: unknown }).clips;
  if (!Array.isArray(clipsRaw) || clipsRaw.length === 0)
    throw new EditListError("edit list has no clips");
  if (clipsRaw.length > MAX_CLIPS)
    throw new EditListError(`at most ${MAX_CLIPS} clips`);
  const clips: VideoClip[] = clipsRaw.map((c, i) => {
    if (!c || typeof c !== "object")
      throw new EditListError(`clip ${i + 1} is not an object`);
    const o = c as Record<string, unknown>;
    const src = o.src as Record<string, unknown> | undefined;
    if (!src || typeof src !== "object")
      throw new EditListError(`clip ${i + 1} has no source`);
    const url = typeof src.url === "string" ? src.url : "";
    if (!url || url.length > 2048 || !isAllowedUrl(url))
      throw new EditListError(`clip ${i + 1} has an unsupported source`);
    const duration = num(src.duration);
    const a = num(o.in);
    const b = num(o.out);
    if (duration === null || duration <= 0 || duration > 6 * 3600)
      throw new EditListError(`clip ${i + 1} has a bad source duration`);
    if (a === null || b === null || a < 0 || b <= a || b > duration + 0.05)
      throw new EditListError(`clip ${i + 1} has a bad in/out range`);
    const width = num(src.width) ?? 0;
    const height = num(src.height) ?? 0;
    const fps = num(src.fps) ?? 0;
    const fx: ClipFx = {};
    const opt = (
      key: "speed" | "volume" | "fadeIn" | "fadeOut",
      lo: number,
      hi: number,
      what: string,
    ) => {
      if (o[key] === undefined) return;
      const v = num(o[key]);
      if (v === null || v < lo || v > hi)
        throw new EditListError(`clip ${i + 1}: ${what} must be ${lo}-${hi}`);
      fx[key] = v;
    };
    opt("speed", MIN_SPEED, MAX_SPEED, "speed");
    opt("volume", 0, MAX_VOLUME, "volume");
    opt("fadeIn", 0, MAX_FADE_SECONDS, "fade in");
    opt("fadeOut", 0, MAX_FADE_SECONDS, "fade out");
    let transitionIn: Transition | undefined;
    if (o.transitionIn !== undefined && o.transitionIn !== null) {
      const t = o.transitionIn as Record<string, unknown>;
      const d = num(t?.d);
      if (
        typeof t !== "object" ||
        !TRANSITION_TYPES.includes(t.type as TransitionType) ||
        d === null ||
        d < MIN_TRANSITION_SECONDS ||
        d > MAX_TRANSITION_SECONDS
      )
        throw new EditListError(`clip ${i + 1} has a bad transition`);
      transitionIn = { type: t.type as TransitionType, d };
    }
    return {
      ...fx,
      ...(transitionIn ? { transitionIn } : {}),
      id: typeof o.id === "string" ? o.id.slice(0, 64) : `c${i}`,
      src: {
        url,
        duration,
        width: clamp(Math.round(width), 0, 8192),
        height: clamp(Math.round(height), 0, 8192),
        fps: clamp(fps, 0, 240),
        hasAudio: src.hasAudio === true,
      },
      in: a,
      out: Math.min(b, duration),
      muted: o.muted === true,
      label: typeof o.label === "string" ? o.label.slice(0, 120) : "",
    };
  });
  const list: EditList = { v: 1, clips };
  const frameRaw = (raw as { frame?: unknown }).frame;
  if (frameRaw !== undefined && frameRaw !== null) {
    const f = frameRaw as Record<string, unknown>;
    const x = num(f.x);
    const y = num(f.y);
    if (
      typeof f !== "object" ||
      !OUTPUT_ASPECTS.includes(f.aspect as OutputAspect) ||
      x === null ||
      y === null ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1
    )
      throw new EditListError("bad output frame");
    list.frame = { aspect: f.aspect as OutputAspect, x, y };
  }
  const audio = parseAudioLane(
    (raw as { audio?: unknown }).audio,
    isAllowedAudioUrl ?? isAllowedUrl,
  );
  if (audio.length) list.audio = audio;
  if (timelineDuration(list) > MAX_TIMELINE_SECONDS)
    throw new EditListError(
      `the timeline is longer than ${MAX_TIMELINE_SECONDS / 60} minutes`,
    );
  return list;
}

function parseAudioLane(
  raw: unknown,
  isAllowedUrl: (url: string) => boolean,
): AudioClip[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new EditListError("audio lane must be a list");
  if (raw.length > MAX_AUDIO_CLIPS)
    throw new EditListError(`at most ${MAX_AUDIO_CLIPS} audio clips`);
  return raw.map((c, i) => {
    const bad = (what: string) =>
      new EditListError(`audio clip ${i + 1} has ${what}`);
    if (!c || typeof c !== "object") throw bad("no data");
    const o = c as Record<string, unknown>;
    const src = o.src as Record<string, unknown> | undefined;
    const url = src && typeof src.url === "string" ? src.url : "";
    if (!url || url.length > 2048 || !isAllowedUrl(url))
      throw bad("an unsupported source");
    const duration = num(src?.duration);
    if (duration === null || duration <= 0 || duration > 6 * 3600)
      throw bad("a bad source duration");
    const a = num(o.in);
    const b = num(o.out);
    const start = num(o.start);
    if (a === null || b === null || a < 0 || b <= a || b > duration + 0.05)
      throw bad("a bad in/out range");
    if (start === null || start < 0 || start > MAX_TIMELINE_SECONDS)
      throw bad("a bad start");
    const fx: AudioFx = {};
    const opt = (key: "gain" | "fadeIn" | "fadeOut", hi: number) => {
      if (o[key] === undefined) return;
      const v = num(o[key]);
      if (v === null || v < 0 || v > hi) throw bad(`a bad ${key}`);
      fx[key] = v;
    };
    opt("gain", MAX_VOLUME);
    opt("fadeIn", MAX_FADE_SECONDS);
    opt("fadeOut", MAX_FADE_SECONDS);
    return {
      ...fx,
      ...(o.muted === true ? { muted: true } : {}),
      id: typeof o.id === "string" ? o.id.slice(0, 64) : `a${i}`,
      src: { url, duration },
      start,
      in: a,
      out: Math.min(b, duration),
      label: typeof o.label === "string" ? o.label.slice(0, 120) : "",
    };
  });
}
