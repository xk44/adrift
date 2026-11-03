/**
 * Video editor: request-body validation for /api/video-edit/* (route files
 * may only export handlers). Pure; every error is a user-facing message.
 */
import {
  EditListError,
  parseEditList,
  timelineDuration,
  type EditList,
} from "./editList";
import { AUDIO_SOURCE_EXT, parseSourceUrl, type SourceRef } from "./sourceRef";
import { MAX_FREEZE_SECONDS, MAX_REVERSE_SECONDS } from "./ffmpegArgs";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** `audio: true` probes a file's sound (A2 lane) instead of its video. */
export function parseProbeRequest(
  raw: unknown,
): Parsed<{ url: string; ref: SourceRef; audio: boolean }> {
  const o = asObject(raw);
  if (!o) return fail("body must be a JSON object");
  const audio = o.audio === true;
  const ref = parseSourceUrl(o.url, { audio });
  if (!ref)
    return fail(
      audio
        ? "url must be a gallery or uploaded audio or video file"
        : "url must be a gallery or uploaded video",
    );
  return { ok: true, value: { url: o.url as string, ref, audio } };
}

export const FILMSTRIP_MAX_TILES = 60;

export function parseThumbsRequest(raw: unknown): Parsed<{
  url: string;
  ref: SourceRef;
  audio: boolean;
  count: number;
  height: number;
  kind: "strip" | "wave";
}> {
  const base = parseProbeRequest(raw);
  if (!base.ok) return base;
  const o = raw as Record<string, unknown>;
  const count = o.count === undefined ? 24 : o.count;
  const height = o.height === undefined ? 54 : o.height;
  if (
    !Number.isInteger(count) ||
    (count as number) < 1 ||
    (count as number) > FILMSTRIP_MAX_TILES
  )
    return fail(`count must be 1-${FILMSTRIP_MAX_TILES}`);
  if (
    !Number.isInteger(height) ||
    (height as number) < 16 ||
    (height as number) > 240
  )
    return fail("height must be 16-240");
  const kind = o.kind === undefined ? "strip" : o.kind;
  if (kind !== "strip" && kind !== "wave")
    return fail("kind must be strip or wave");
  if (kind === "strip" && base.value.audio)
    return fail("an audio file has no filmstrip");
  return {
    ok: true,
    value: {
      ...base.value,
      count: count as number,
      height: height as number,
      kind,
    },
  };
}

export type RenderMode = "mp4" | "frame" | "range";

export const EXPORT_RESOLUTIONS = ["keep", "720", "1080", "2160"] as const;
export const EXPORT_FPS = [0, 24, 30, 60] as const;
export const EXPORT_QUALITIES = ["high", "balanced", "small"] as const;
/** mp4 = H.264/AAC, webm = VP9/Opus, prores = ProRes 422 HQ/PCM in .mov. */
export const EXPORT_FORMATS = ["mp4", "webm", "prores"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** File extension of a final in that format. */
export const EXPORT_EXT: Record<ExportFormat, string> = {
  mp4: "mp4",
  webm: "webm",
  prores: "mov",
};

/** Export settings for finals (range cuts and frames ignore them). */
export interface ExportSettings {
  /** Short side in px, or the source frame. */
  resolution: (typeof EXPORT_RESOLUTIONS)[number];
  /** 0 = the clips' own rate. */
  fps: (typeof EXPORT_FPS)[number];
  quality: (typeof EXPORT_QUALITIES)[number];
  format: ExportFormat;
  /** Normalise the mix to DEFAULT_LOUDNORM_LUFS (EBU R128). */
  loudnorm?: boolean;
  /** Duck the clips' sound under the A2 lane. */
  duck?: boolean;
}

export const DEFAULT_EXPORT: ExportSettings = {
  resolution: "keep",
  fps: 0,
  quality: "high",
  format: "mp4",
};

export function parseExportSettings(raw: unknown): Parsed<ExportSettings> {
  if (raw === undefined || raw === null)
    return { ok: true, value: { ...DEFAULT_EXPORT } };
  const o = asObject(raw);
  if (!o) return fail("output must be an object");
  const resolution = o.resolution ?? DEFAULT_EXPORT.resolution;
  const fps = o.fps ?? DEFAULT_EXPORT.fps;
  const quality = o.quality ?? DEFAULT_EXPORT.quality;
  const format = o.format ?? DEFAULT_EXPORT.format;
  if (!(EXPORT_RESOLUTIONS as readonly unknown[]).includes(resolution))
    return fail("output.resolution must be keep, 720, 1080 or 2160");
  if (!(EXPORT_FPS as readonly unknown[]).includes(fps))
    return fail("output.fps must be 0, 24, 30 or 60");
  if (!(EXPORT_QUALITIES as readonly unknown[]).includes(quality))
    return fail("output.quality must be high, balanced or small");
  if (!(EXPORT_FORMATS as readonly unknown[]).includes(format))
    return fail("output.format must be mp4, webm or prores");
  for (const k of ["loudnorm", "duck"] as const)
    if (o[k] !== undefined && typeof o[k] !== "boolean")
      return fail(`output.${k} must be true or false`);
  return {
    ok: true,
    value: {
      resolution: resolution as ExportSettings["resolution"],
      fps: fps as ExportSettings["fps"],
      quality: quality as ExportSettings["quality"],
      format: format as ExportFormat,
      ...(o.loudnorm === true ? { loudnorm: true } : {}),
      ...(o.duck === true ? { duck: true } : {}),
    },
  };
}

export interface RenderRequest {
  mode: RenderMode;
  edit: EditList;
  /** Timeline range (mp4 / range); whole timeline when absent. */
  start: number;
  end: number;
  /** Timeline time of the frame (frame mode). */
  t: number;
  /** Add the result to the gallery (mp4 / frame). */
  save: boolean;
  label: string;
  output: ExportSettings;
}

/** Longest range the "cut for a tool" mode makes (tools take seconds). */
export const MAX_RANGE_SECONDS = 120;

export function parseRenderRequest(raw: unknown): Parsed<RenderRequest> {
  const o = asObject(raw);
  if (!o) return fail("body must be a JSON object");
  const mode = o.mode;
  if (mode !== "mp4" && mode !== "frame" && mode !== "range")
    return fail("mode must be mp4, frame or range");
  let edit: EditList;
  try {
    edit = parseEditList(
      o.edit,
      (u) => parseSourceUrl(u) !== null,
      (u) => parseSourceUrl(u, { audio: true }) !== null,
    );
  } catch (e) {
    return fail(e instanceof EditListError ? e.message : "bad edit list");
  }
  const total = timelineDuration(edit);
  let start = 0;
  let end = total;
  if (o.start !== undefined || o.end !== undefined) {
    if (!finite(o.start) || !finite(o.end))
      return fail("start and end must be numbers");
    if (o.start < 0 || o.end > total + 0.05 || o.end - o.start < 0.04)
      return fail("start/end must be a range inside the timeline");
    start = o.start;
    end = Math.min(o.end, total);
  }
  if (mode === "range" && end - start > MAX_RANGE_SECONDS)
    return fail(`a tool range can be at most ${MAX_RANGE_SECONDS} s`);
  let t = 0;
  if (mode === "frame") {
    if (!finite(o.t) || o.t < 0 || o.t > total + 0.05)
      return fail("t must be a time inside the timeline");
    t = Math.min(o.t, total);
  }
  const output = parseExportSettings(o.output);
  if (!output.ok) return output;
  const label =
    typeof o.label === "string"
      ? o.label
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .trim()
          .slice(0, 200)
      : "";
  return {
    ok: true,
    value: {
      mode,
      edit,
      start,
      end,
      t,
      save: mode !== "range" && o.save !== false,
      label,
      output: output.value,
    },
  };
}

export interface ConformRequest {
  video: SourceRef;
  /** Take the sound from this source (the cut the tool was given). */
  audio: SourceRef | null;
  /** Re-time to this rate; 0 = keep the video's own. */
  fps: number;
}

export function parseConformRequest(raw: unknown): Parsed<ConformRequest> {
  const o = asObject(raw);
  if (!o) return fail("body must be a JSON object");
  const video = parseSourceUrl(o.video);
  if (!video) return fail("video must be a gallery or uploaded video");
  let audio: SourceRef | null = null;
  if (o.audio !== undefined && o.audio !== null) {
    audio = parseSourceUrl(o.audio);
    if (!audio) return fail("audio must be a gallery or uploaded video");
  }
  const fps = o.fps ?? 0;
  if (!finite(fps) || (fps !== 0 && (fps < 1 || fps > 120)))
    return fail("fps must be 0 or between 1 and 120");
  if (!audio && !fps) return fail("nothing to change");
  return { ok: true, value: { video, audio, fps } };
}

/** New media made from a clip: its [in, out) reversed, or one frame held. */
export type DeriveRequest =
  | { op: "reverse"; video: SourceRef; in: number; out: number }
  | { op: "freeze"; video: SourceRef; t: number; seconds: number; fps: number };

export function parseDeriveRequest(raw: unknown): Parsed<DeriveRequest> {
  const o = asObject(raw);
  if (!o) return fail("body must be a JSON object");
  const video = parseSourceUrl(o.video);
  if (!video) return fail("video must be a gallery or uploaded video");
  if (o.op === "reverse") {
    const a = o.in;
    const b = o.out;
    if (!finite(a) || !finite(b) || a < 0 || b <= a)
      return fail("in / out must be seconds with in < out");
    if (b - a > MAX_REVERSE_SECONDS + 1e-6)
      return fail(`reverse takes at most ${MAX_REVERSE_SECONDS} s`);
    return { ok: true, value: { op: "reverse", video, in: a, out: b } };
  }
  if (o.op === "freeze") {
    const t = o.t;
    const seconds = o.seconds;
    const fps = o.fps ?? 0;
    if (!finite(t) || t < 0) return fail("t must be seconds");
    if (!finite(seconds) || seconds < 0.1 || seconds > MAX_FREEZE_SECONDS)
      return fail(`seconds must be between 0.1 and ${MAX_FREEZE_SECONDS}`);
    if (!finite(fps) || (fps !== 0 && (fps < 1 || fps > 120)))
      return fail("fps must be 0 or between 1 and 120");
    return { ok: true, value: { op: "freeze", video, t, seconds, fps } };
  }
  return fail("op must be reverse or freeze");
}

/** Upload: file name from the X-Filename header → safe extension check. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;

export const AUDIO_UPLOAD_EXT = AUDIO_SOURCE_EXT;

export function uploadExtension(name: unknown): string | null {
  if (typeof name !== "string" || name.length > 255) return null;
  const m = UPLOAD_EXT.exec(name) ?? AUDIO_UPLOAD_EXT.exec(name);
  return m ? m[1].toLowerCase() : null;
}

export const isAudioExtension = (ext: string) =>
  AUDIO_UPLOAD_EXT.test(`.${ext}`);

/**
 * HTTP Range header → inclusive byte range for a file of `size` bytes.
 * null = no/ignored header (serve the whole file); "unsatisfiable" = 416.
 * Single ranges only (what <video> sends).
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size <= 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start)
    return "unsatisfiable";
  return { start, end };
}
