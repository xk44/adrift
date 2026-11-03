/**
 * Video editor: browser calls to /api/video-edit/* (probe, filmstrip,
 * upload, render). Every call throws an Error with the server's message.
 */

import type { AudioSource, EditList, VideoSource } from "./editList";
import type { ExportSettings, RenderMode } from "./requests";
import type { RecentHistoryRun } from "@/lib/historyHydration";
import { AUDIO_SOURCE_EXT } from "./sourceRef";

export interface ProbeInfoDto {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface FilmstripDto {
  url: string;
  count: number;
  tileWidth: number;
  tileHeight: number;
}

export interface RenderResultDto {
  url: string;
  kind: "video" | "image";
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  run?: RecentHistoryRun;
  saveError?: string;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `request failed (${res.status})`,
    );
  return data as T;
}

export function toSource(url: string, info: ProbeInfoDto): VideoSource {
  return {
    url,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
  };
}

export async function probeVideo(url: string): Promise<VideoSource> {
  const data = await postJson<{ info: ProbeInfoDto }>("/api/video-edit/probe", {
    url,
  });
  if (!data.info || !(data.info.duration > 0))
    throw new Error("that video has no length");
  return toSource(url, data.info);
}

export async function fetchFilmstrip(
  url: string,
  count: number,
  height: number,
  signal?: AbortSignal,
): Promise<FilmstripDto> {
  const data = await postJson<{ strip: FilmstripDto }>(
    "/api/video-edit/thumbs",
    { url, count, height },
    signal,
  );
  return data.strip;
}

export interface WaveformDto {
  url: string;
  width: number;
  height: number;
  duration: number;
}

/** Whole-source waveform PNG; null when the source has no audio. */
export async function fetchWaveform(
  url: string,
  height: number,
  signal?: AbortSignal,
  audio = false,
): Promise<WaveformDto | null> {
  const data = await postJson<{ wave: WaveformDto | null }>(
    "/api/video-edit/thumbs",
    { url, height, kind: "wave", ...(audio ? { audio: true } : {}) },
    signal,
  );
  return data.wave;
}

export async function renderEdit(
  body: {
    mode: RenderMode;
    edit: EditList;
    start?: number;
    end?: number;
    t?: number;
    save?: boolean;
    label?: string;
    output?: ExportSettings;
  },
  signal?: AbortSignal,
): Promise<RenderResultDto> {
  const data = await postJson<{ result: RenderResultDto }>(
    "/api/video-edit/render",
    body,
    signal,
  );
  return data.result;
}

/** Upload a local video file; reports 0..1 progress. */
/** Sound of an audio (or video) file for the A2 lane. */
export async function probeAudio(url: string): Promise<AudioSource> {
  const data = await postJson<{ info: ProbeInfoDto }>("/api/video-edit/probe", {
    url,
    audio: true,
  });
  if (!data.info || !(data.info.duration > 0))
    throw new Error("that file has no sound");
  return { url, duration: data.info.duration };
}

export function uploadVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<VideoSource> {
  return uploadFile(file, onProgress).then((d) => toSource(d.url, d.info));
}

export function uploadAudio(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<AudioSource> {
  return uploadFile(file, onProgress).then((d) => ({
    url: d.url,
    duration: d.info.duration,
  }));
}

function uploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ url: string; info: ProbeInfoDto }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video-edit/upload");
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error("upload failed (network)"));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 400 || data.ok === false) {
        reject(
          new Error(
            typeof data.error === "string"
              ? data.error
              : `upload failed (${xhr.status})`,
          ),
        );
        return;
      }
      resolve({ url: String(data.url), info: data.info as ProbeInfoDto });
    };
    xhr.send(file);
  });
}

export const AUDIO_FILE_RE = AUDIO_SOURCE_EXT;

/** First audio file in a drop / file list, else null. */
export function firstAudioFile(
  files: FileList | File[] | null | undefined,
): File | null {
  if (!files) return null;
  for (const f of Array.from(files)) {
    if (f.type.startsWith("audio/") || AUDIO_FILE_RE.test(f.name)) return f;
  }
  return null;
}

/** First video file in a drop / file list, else null. */
export function firstVideoFile(
  files: FileList | File[] | null | undefined,
): File | null {
  if (!files) return null;
  for (const f of Array.from(files)) {
    if (
      f.type.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)
    )
      return f;
  }
  return null;
}

/**
 * Tell the server which uploads a project uses (empty list = release it),
 * so housekeeping keeps them. Best effort: errors are swallowed.
 */
export async function syncProjectRefs(
  projectId: string,
  files: string[],
): Promise<void> {
  try {
    await postJson("/api/video-edit/refs", { projectId, files });
  } catch {
    // Next sync retries; at worst an upload is evicted when the disk is full.
  }
}

/** Reverse a source range, or hold one frame as a still shot. */
export async function deriveClip(
  body:
    | { op: "reverse"; video: string; in: number; out: number }
    | { op: "freeze"; video: string; t: number; seconds: number; fps?: number },
): Promise<VideoSource> {
  const data = await postJson<{ url: string; info: ProbeInfoDto }>(
    "/api/video-edit/derive",
    body,
  );
  return toSource(data.url, data.info);
}

/**
 * Ready a tool result for the timeline: the cut's sound under it (`audio`)
 * and / or the edit's frame rate (`fps`). Returns the new source.
 */
export async function conformResult(body: {
  video: string;
  audio?: string;
  fps?: number;
}): Promise<VideoSource> {
  const data = await postJson<{ url: string; info: ProbeInfoDto }>(
    "/api/video-edit/conform",
    body,
  );
  return toSource(data.url, data.info);
}
