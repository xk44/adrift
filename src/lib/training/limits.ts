/**
 * LoRA training parameter limits, shared by the train route and the start
 * dialog. Defaults (steps 1500, rank 16, resolution 1024, lr 5e-5/1e-4) all
 * sit inside these ranges.
 */

export interface NumericLimit {
  min: number;
  max: number;
  /** Value must be a multiple of this (resolution buckets). */
  multipleOf?: number;
  integer?: boolean;
}

export const TRAIN_PARAM_LIMITS = {
  steps: { min: 100, max: 50_000, integer: true },
  rank: { min: 1, max: 256, integer: true },
  resolution: { min: 512, max: 2048, multipleOf: 64, integer: true },
  lr: { min: 1e-6, max: 1e-2 },
} as const satisfies Record<string, NumericLimit>;

export type TrainParamName = keyof typeof TRAIN_PARAM_LIMITS;

/** Fewer usable images than this aborts the run (capped at the board size). */
export const MIN_USABLE_TRAINING_IMAGES = 5;
/** Warn when more than this share of the board failed to materialize. */
export const MISSING_IMAGES_WARN_SHARE = 0.2;

export function describeLimit(name: TrainParamName): string {
  const l: NumericLimit = TRAIN_PARAM_LIMITS[name];
  const range = `${l.min}–${l.max}`;
  return l.multipleOf ? `${range}, multiple of ${l.multipleOf}` : range;
}

/** Human error for one value, or null when it is within limits. */
export function trainParamError(
  name: TrainParamName,
  value: number,
): string | null {
  const l: NumericLimit = TRAIN_PARAM_LIMITS[name];
  const ok =
    Number.isFinite(value) &&
    value >= l.min &&
    value <= l.max &&
    (!l.integer || Number.isInteger(value)) &&
    (!l.multipleOf || value % l.multipleOf === 0);
  return ok ? null : `${name} must be ${describeLimit(name)} (got ${value})`;
}

/** First out-of-range param among the provided ones, or null. */
export function validateTrainParams(
  params: Partial<Record<TrainParamName, number | undefined>>,
): string | null {
  for (const name of Object.keys(TRAIN_PARAM_LIMITS) as TrainParamName[]) {
    const value = params[name];
    if (value === undefined) continue;
    const error = trainParamError(name, value);
    if (error) return error;
  }
  return null;
}

export interface MaterializeOutcome {
  /** Abort the run with this message. */
  error?: string;
  /** Non-blocking notice for the caller. */
  warning?: string;
  skipped: number;
}

export function assessMaterialized(
  total: number,
  materialized: number,
): MaterializeOutcome {
  const skipped = Math.max(0, total - materialized);
  if (materialized < 1)
    return { skipped, error: "No moodboard images could be materialized" };
  const needed = Math.min(MIN_USABLE_TRAINING_IMAGES, total);
  if (materialized < needed)
    return {
      skipped,
      error: `Only ${materialized} of ${total} images could be read; at least ${needed} are needed to train (${skipped} missing or unreadable).`,
    };
  if (total > 0 && skipped / total > MISSING_IMAGES_WARN_SHARE)
    return {
      skipped,
      warning: `${skipped} of ${total} images were skipped (missing or unreadable); training on ${materialized}.`,
    };
  return { skipped };
}
