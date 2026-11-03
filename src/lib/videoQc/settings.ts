/**
 * Video QC settings (data/runtime_settings.json `videoQc`). Pure: shared by
 * the server (runtimeSettings, QC runner) and the settings card.
 */

export interface VideoQcThresholds {
  /** Shortest black span reported (s). */
  blackMinSec: number;
  /** Luma threshold for a "black" pixel (0-1, blackdetect pix_th). */
  blackPixel: number;
  /** Black spans covering at least this share of the clip fail it. */
  blackFailFraction: number;
  /** Shortest frozen span reported (s). */
  freezeMinSec: number;
  /** Frame-difference noise floor in dB (freezedetect n). */
  freezeNoiseDb: number;
  /** Frozen spans covering at least this share of the clip fail it. */
  freezeFailFraction: number;
  /** scdet score (0-100) above which a frame change counts as a sudden jump. */
  jumpScore: number;
  /** This many sudden jumps fail the clip (fewer only warn). */
  jumpFailCount: number;
  /** Shortest silent span reported for clips that should have sound (s). */
  silenceMinSec: number;
  /** Silence floor in dB (silencedetect noise). */
  silenceDb: number;
  /** Silence covering at least this share of a should-have-audio clip fails it. */
  silenceFailFraction: number;
  /** Allowed relative difference from the requested duration / fps. */
  durationTolerance: number;
}

export interface VideoQcSettings extends VideoQcThresholds {
  /** Run QC on finished video outputs. */
  enabled: boolean;
  /** Resubmit a failed clip with a new seed automatically. */
  autoReroll: boolean;
  /** Most automatic re-rolls per original clip. */
  maxTries: number;
}

export const DEFAULT_VIDEO_QC: VideoQcSettings = {
  enabled: true,
  autoReroll: false,
  maxTries: 2,
  blackMinSec: 0.3,
  blackPixel: 0.1,
  blackFailFraction: 0.3,
  freezeMinSec: 1,
  freezeNoiseDb: -60,
  freezeFailFraction: 0.5,
  jumpScore: 14,
  jumpFailCount: 3,
  silenceMinSec: 2,
  silenceDb: -50,
  silenceFailFraction: 0.9,
  durationTolerance: 0.15,
};

type NumKey = Exclude<keyof VideoQcSettings, "enabled" | "autoReroll">;

/** Inclusive bounds; integer keys are rounded. */
export const VIDEO_QC_BOUNDS: Record<
  NumKey,
  { min: number; max: number; int?: boolean }
> = {
  maxTries: { min: 1, max: 5, int: true },
  blackMinSec: { min: 0.05, max: 10 },
  blackPixel: { min: 0.01, max: 0.5 },
  blackFailFraction: { min: 0.01, max: 1 },
  freezeMinSec: { min: 0.2, max: 30 },
  freezeNoiseDb: { min: -90, max: -20 },
  freezeFailFraction: { min: 0.05, max: 1 },
  jumpScore: { min: 1, max: 100 },
  jumpFailCount: { min: 1, max: 50, int: true },
  silenceMinSec: { min: 0.2, max: 30 },
  silenceDb: { min: -90, max: -10 },
  silenceFailFraction: { min: 0.05, max: 1 },
  durationTolerance: { min: 0.01, max: 1 },
};

/**
 * Only the keys that differ from the defaults and are valid; null when
 * nothing is left (the setting is then absent from the file).
 */
export function sanitizeVideoQcSettings(
  raw: unknown,
): Partial<VideoQcSettings> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<VideoQcSettings> = {};
  if (typeof r.enabled === "boolean" && r.enabled !== DEFAULT_VIDEO_QC.enabled)
    out.enabled = r.enabled;
  if (
    typeof r.autoReroll === "boolean" &&
    r.autoReroll !== DEFAULT_VIDEO_QC.autoReroll
  )
    out.autoReroll = r.autoReroll;
  for (const key of Object.keys(VIDEO_QC_BOUNDS) as NumKey[]) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const b = VIDEO_QC_BOUNDS[key];
    let n = Math.min(b.max, Math.max(b.min, v));
    if (b.int) n = Math.round(n);
    if (n !== DEFAULT_VIDEO_QC[key]) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function resolveVideoQcSettings(
  stored: Partial<VideoQcSettings> | null | undefined,
): VideoQcSettings {
  return { ...DEFAULT_VIDEO_QC, ...(sanitizeVideoQcSettings(stored) ?? {}) };
}
