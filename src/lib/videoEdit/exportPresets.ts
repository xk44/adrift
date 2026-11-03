/** One-click export settings for common destinations. */

import type { OutputAspect, OutputFrame } from "./editList";
import type { ExportFormat, ExportSettings } from "./requests";

export interface ExportPreset {
  id: string;
  label: string;
  hint: string;
  settings: ExportSettings;
  /** Also crop the edit to this frame. */
  aspect?: OutputAspect;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: "web",
    label: "Web 1080p",
    hint: "H.264 MP4 that plays everywhere.",
    settings: { format: "mp4", resolution: "1080", fps: 0, quality: "high" },
  },
  {
    id: "vertical",
    label: "Vertical 9:16",
    hint: "1080 x 1920 at 30 fps for Reels, Shorts and TikTok. Set the focus to keep the subject in frame.",
    settings: { format: "mp4", resolution: "1080", fps: 30, quality: "high" },
    aspect: "9:16",
  },
  {
    id: "4k",
    label: "4K",
    hint: "2160p H.264. Smaller sources are resampled; run Upscale first for real detail.",
    settings: { format: "mp4", resolution: "2160", fps: 0, quality: "high" },
  },
  {
    id: "share",
    label: "Quick share",
    hint: "Small 720p file for chat and review.",
    settings: { format: "mp4", resolution: "720", fps: 30, quality: "small" },
  },
  {
    id: "webm",
    label: "WebM",
    hint: "VP9 / Opus for web pages. Slower to encode.",
    settings: { format: "webm", resolution: "1080", fps: 0, quality: "balanced" },
  },
  {
    id: "prores",
    label: "ProRes master",
    hint: "ProRes 422 HQ .mov at source size for Resolve, Premiere or Final Cut. Large, and most browsers cannot play it.",
    settings: { format: "prores", resolution: "keep", fps: 0, quality: "high" },
  },
];

/** The preset the current settings (and frame) amount to, if any. */
export function matchExportPreset(
  settings: ExportSettings,
  aspect: OutputAspect | null,
): ExportPreset | null {
  return (
    EXPORT_PRESETS.find(
      (p) =>
        p.settings.format === settings.format &&
        p.settings.resolution === settings.resolution &&
        p.settings.fps === settings.fps &&
        (p.settings.format === "prores" ||
          p.settings.quality === settings.quality) &&
        (p.aspect === undefined || p.aspect === aspect),
    ) ?? null
  );
}

/**
 * The frame after picking `next` while `current` was matched: the preset's
 * crop, or none when leaving a preset that set one (Vertical, then Web).
 * Undefined = leave the frame as it is.
 */
export function presetFrame(
  next: ExportPreset,
  current: ExportPreset | null,
  frame: OutputFrame | null,
): OutputFrame | null | undefined {
  if (next.aspect)
    return frame?.aspect === next.aspect
      ? undefined
      : { aspect: next.aspect, x: frame?.x ?? 0.5, y: frame?.y ?? 0.5 };
  if (current?.aspect && frame?.aspect === current.aspect) return null;
  return undefined;
}

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  mp4: "MP4 (H.264)",
  webm: "WebM (VP9)",
  prores: "ProRes 422 HQ",
};

export const FORMAT_SHORT: Record<ExportFormat, string> = {
  mp4: "MP4",
  webm: "WebM",
  prores: "ProRes .mov",
};

export const FORMAT_NOTE: Record<ExportFormat, string> = {
  mp4: "H.264 / AAC MP4",
  webm: "VP9 / Opus WebM",
  prores: "ProRes 422 HQ / PCM .mov (10-bit)",
};
