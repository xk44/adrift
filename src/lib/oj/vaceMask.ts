/**
 * VACE mask timing for the masked video graphs (video_object_remove,
 * video_remove_text, video_object_swap).
 *
 * Why a second, wider temporal dilation: WanVaceToVideo greys the control
 * video with the per-FRAME mask, but it squeezes control_masks to the latent
 * timeline with nearest-exact sampling (73 frames -> 19 latents), so each
 * latent keeps the mask of ONE frame while its VAE group covers four. When a
 * fast limb is masked (and greyed) in some frames of a group but not in the
 * sampled one, VACE reads that patch as "keep the control video" and copies
 * the grey fill: the grey smear the limb leaves behind. Feeding control_masks
 * (and the paste-back's allowed area) a mask dilated in time by at least the
 * worst frame-to-sample distance makes every greyed pixel masked at its
 * latent's sampled frame, so it is always regenerated.
 */

/** Wan 2.x VAE: frame 0 alone, then groups of 4 frames per latent. */
export const WAN_VAE_TEMPORAL_STRIDE = 4;
/** CJMaskTemporal radius limit (object_info: max 12). */
export const MASK_TEMPORAL_MAX = 12;

/**
 * Largest distance (frames) between any frame and the frame
 * WanVaceToVideo samples for its latent's mask (torch nearest-exact).
 */
export function vaceMaskAliasRadius(length: number): number {
  const L = Math.max(1, Math.floor(length));
  const N = Math.floor((L - 1) / WAN_VAE_TEMPORAL_STRIDE) + 1;
  const scale = L / N;
  let worst = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.min(L - 1, Math.floor((i + 0.5) * scale));
    const first = i === 0 ? 0 : WAN_VAE_TEMPORAL_STRIDE * (i - 1) + 1;
    const last = Math.min(L - 1, i === 0 ? 0 : WAN_VAE_TEMPORAL_STRIDE * i);
    worst = Math.max(worst, Math.abs(s - first), Math.abs(s - last));
  }
  return worst;
}

/**
 * Temporal radius k for the mask that greys the control video: the builder's
 * default unless params.temporalRadius is a number (clamped to 0..12).
 */
export function maskTemporalRadius(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(MASK_TEMPORAL_MAX, Math.round(n)));
}
