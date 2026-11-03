/**
 * `--duration` for the prompt bar's `--audio` graphs: Stable Audio length
 * lives on EmptyLatentAudio `seconds`. Kept free of engine imports so
 * engine.ts can use it without an import cycle.
 */
import type { Workflow } from "@/types";

/** SA3 medium trains up to ~380 s (HF card); the CJ node caps at 384. */
export const SA3_DURATION = { min: 1, max: 380, default: 30 };
/** Small SFX model: short clips only (matches audioGen SFX_DURATION). */
export const SA3_SFX_DURATION = { min: 1, max: 30, default: 10 };

type Range = { min: number; max: number; default: number };

export function clampSeconds(value: unknown, range: Range): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * Write `duration` into every EmptyLatentAudio `seconds`, clamped to what the
 * graph's checkpoint supports (small SFX: 30 s, medium: 380 s), and drop
 * the image width/height --ar wrote there. No-op without the node.
 */
export function injectAudioDuration(
  workflow: Workflow,
  duration: unknown,
): void {
  const ckpt = Object.values(workflow).find(
    (n) => n.class_type === "CheckpointLoaderSimple",
  )?.inputs?.ckpt_name;
  const range =
    typeof ckpt === "string" && /small_sfx/i.test(ckpt)
      ? SA3_SFX_DURATION
      : SA3_DURATION;
  const seconds = clampSeconds(duration, range);
  for (const node of Object.values(workflow)) {
    if (node.class_type === "EmptyLatentAudio") {
      // --ar dims land on the latent slot; an audio latent has none.
      const { width: _w, height: _h, ...rest } = node.inputs ?? {};
      node.inputs = { ...rest, seconds };
    }
  }
}
