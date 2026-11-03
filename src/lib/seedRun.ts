/** Helpers for POST /api/jobs/seed-run (Next route files may only export handlers). */
import type { ImagineRun } from "@/types";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|flac)$/i;

/** True for the video containers seed-run / upload accept (mp4, mov, m4v, webm). */
export function isVideoFilename(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** True for the audio files seed-run / upload accept (wav, mp3, m4a, flac). */
export function isAudioFilename(name: string): boolean {
  return AUDIO_EXT.test(name);
}

/**
 * "sub/dir/name.png [input]" → view-URL parts. Input-dir uploads only, and
 * no traversal: every path segment must be a plain name. Images always;
 * videos only with `{ allowVideo: true }` (seed-run for video tools), audio
 * only with `{ allowAudio: true }` (lipsync speech).
 */
export function parseInputRef(
  raw: unknown,
  opts: { allowVideo?: boolean; allowAudio?: boolean } = {},
): { filename: string; subfolder: string } | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const match = /^(.+) \[input\]$/.exec(raw.trim());
  if (!match) return null;
  const segments = match[1].split("/");
  const name = segments[segments.length - 1];
  if (
    segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..") ||
    !(
      IMAGE_EXT.test(name) ||
      (opts.allowVideo && VIDEO_EXT.test(name)) ||
      (opts.allowAudio && AUDIO_EXT.test(name))
    )
  ) {
    return null;
  }
  return {
    filename: name,
    subfolder: segments.slice(0, -1).join("/"),
  };
}

/** Clip duration (seconds) a client may attach to a seeded video; null if absent/invalid. */
export function parseSeedDuration(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0.2 || raw > 60) return null;
  return Math.round(raw * 1000) / 1000;
}

/**
 * Text-only seed (music / sfx tools): a finished run with one empty job, so
 * POST /api/jobs/action has a (run, job) to hang the generation on. The
 * prompt is kept as the run prompt (feed caption).
 */
export function textOnlySeedRun(
  runId: string,
  prompt: string,
  createdAt: string = new Date().toISOString(),
): ImagineRun {
  return {
    run_id: runId,
    prompt,
    parsedPrompt: prompt,
    width: 1024,
    height: 1024,
    createdAt,
    status: "done",
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images: [] }],
    params: { seed_upload: true, text_only: true },
  };
}
