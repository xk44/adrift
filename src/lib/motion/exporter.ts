/**
 * Browser export: plays the spec in real time onto an offscreen canvas,
 * captures it with canvas.captureStream + MediaRecorder (mp4 when the browser
 * can record it, else webm) and mixes optional narration / music cues in with
 * WebAudio. Pure helpers (mime choice, ducking envelope) are exported for
 * tests; recordSpec itself needs a real browser.
 */

import { ASPECTS, type MotionSpec } from "./spec";
import { renderFrame, type RenderAssets } from "./render";
import { totalDuration } from "./timeline";
import { smoothContext } from "@/lib/canvasResample";
import type { AudioCue } from "./client";

export const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/** First recordable type, preferring mp4 (null = MediaRecorder unusable). */
export function pickMimeType(
  isSupported: (t: string) => boolean,
  preferWebm = false,
): string | null {
  const list = preferWebm
    ? [
        ...MIME_CANDIDATES.filter((m) => m.includes("webm")),
        ...MIME_CANDIDATES.filter((m) => m.includes("mp4")),
      ]
    : [...MIME_CANDIDATES];
  for (const m of list) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* some browsers throw on unknown codecs */
    }
  }
  return null;
}

export function extensionFor(mime: string): "mp4" | "webm" {
  return mime.includes("mp4") ? "mp4" : "webm";
}

/** Export size: the aspect's native frame scaled to `scale` (even pixels). */
export function exportSize(
  spec: MotionSpec,
  scale = 1,
): { width: number; height: number } {
  const a = ASPECTS[spec.aspect];
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(a.width), height: even(a.height) };
}

/**
 * Music gain at time t: ducks to `low` while any narration cue plays (with
 * a short ramp), `high` otherwise.
 */
export function duckGain(
  t: number,
  voice: { at: number; seconds: number }[],
  high = 0.32,
  low = 0.12,
  ramp = 0.25,
): number {
  let g = high;
  for (const v of voice) {
    const a = v.at - ramp;
    const b = v.at + v.seconds + ramp;
    if (t <= a || t >= b) continue;
    const k = Math.min(1, (t - a) / ramp, (b - t) / ramp);
    g = Math.min(g, high + (low - high) * k);
  }
  return g;
}

export interface RecordOptions {
  scale?: number;
  assets?: RenderAssets;
  /** Video element to restart in sync (lower-third background). */
  video?: HTMLVideoElement | null;
  voice?: AudioCue[];
  music?: AudioCue | null;
  preferWebm?: boolean;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

async function decode(ac: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load audio (${res.status})`);
  return ac.decodeAudioData(await res.arrayBuffer());
}

export async function recordSpec(
  spec: MotionSpec,
  opts: RecordOptions = {},
): Promise<{ blob: Blob; mime: string }> {
  if (typeof MediaRecorder === "undefined")
    throw new Error("This browser can't record video (no MediaRecorder).");
  const mime = pickMimeType(
    (t) => MediaRecorder.isTypeSupported(t),
    opts.preferWebm,
  );
  if (!mime) throw new Error("This browser can't record mp4 or webm.");
  const { width, height } = exportSize(spec, opts.scale ?? 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable.");
  // Scaled stills / clips in the frame resample sharply, not "low".
  smoothContext(ctx);
  const duration = totalDuration(spec);
  const stream = canvas.captureStream(spec.fps);

  // Audio graph (optional).
  let ac: AudioContext | null = null;
  const sources: AudioScheduledSourceNode[] = [];
  const voice = opts.voice ?? [];
  if (voice.length || opts.music) {
    ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const voiceBufs = await Promise.all(voice.map((v) => decode(ac!, v.url)));
    const musicBuf = opts.music ? await decode(ac, opts.music.url) : null;
    const t0 = ac.currentTime + 0.15;
    voiceBufs.forEach((buf, i) => {
      const src = ac!.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(t0 + voice[i].at);
      sources.push(src);
    });
    if (musicBuf) {
      const src = ac.createBufferSource();
      src.buffer = musicBuf;
      src.loop = musicBuf.duration < duration;
      const gain = ac.createGain();
      const spans = voice.map((v, i) => ({
        at: v.at,
        seconds: voiceBufs[i].duration,
      }));
      // Pre-bake the ducking envelope at 10 Hz.
      for (let t = 0; t <= duration + 0.05; t += 0.1) {
        gain.gain.setValueAtTime(duckGain(t, spans), t0 + t);
      }
      // Fade out over the last second.
      gain.gain.setValueAtTime(
        duckGain(Math.max(0, duration - 1), spans),
        t0 + Math.max(0, duration - 1),
      );
      gain.gain.linearRampToValueAtTime(0, t0 + duration);
      src.connect(gain).connect(dest);
      src.start(t0);
      src.stop(t0 + duration + 0.1);
      sources.push(src);
    }
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: Math.round(width * height * spec.fps * 0.14),
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Recording failed."));
  });

  renderFrame(ctx, spec, 0, opts.assets);
  if (opts.video) {
    opts.video.currentTime = 0;
    await opts.video.play().catch(() => undefined);
  }
  recorder.start(250);
  const start = performance.now() + (ac ? 150 : 0);
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (opts.signal?.aborted) return resolve();
      const t = Math.max(0, (performance.now() - start) / 1000);
      renderFrame(ctx, spec, Math.min(t, duration), opts.assets);
      opts.onProgress?.(Math.min(1, t / duration));
      if (t >= duration + 0.1) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  recorder.stop();
  await done;
  sources.forEach((s) => {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  });
  stream.getTracks().forEach((t) => t.stop());
  await ac?.close().catch(() => undefined);
  if (opts.signal?.aborted) throw new Error("Export cancelled.");
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the video."));
    r.readAsDataURL(blob);
  });
}
