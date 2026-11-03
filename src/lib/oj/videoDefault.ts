/**
 * Default video engine, shared by server routes and client settings (no
 * imports: safe in client bundles). LTX-2.5 is the core video model a stock
 * install runs; the legacy LTX-Video 0.9.5 graphs need a 2B checkpoint the
 * reference backend does not ship, so they are opt-in (--vmodel ltxv).
 */

/** Video pack used when neither the request nor the server env picks one. */
export const DEFAULT_VIDEO_PACK = "ltx25";

/** Request value, else CJ_DEFAULT_VIDEO_PACK, else LTX-2.5. Blanks skip. */
export function defaultVideoPack(
  requested?: unknown,
  envValue: string | undefined = process.env.CJ_DEFAULT_VIDEO_PACK,
): string {
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  return envValue?.trim() || DEFAULT_VIDEO_PACK;
}

/**
 * Settings picker value. "ltxv" was the stored default before LTX-2.5 and
 * meant "server default" (it never emitted a flag), so it reads as default.
 */
export function settingsVideoModel<T extends string>(
  value: T | undefined,
): T | typeof DEFAULT_VIDEO_PACK {
  return !value || value === "ltxv" ? DEFAULT_VIDEO_PACK : value;
}

/** `--vmodel` value for the prompt, or undefined for the server default. */
export function videoModelFlag(value: string | undefined): string | undefined {
  const v = settingsVideoModel(value);
  return v === DEFAULT_VIDEO_PACK ? undefined : v;
}

/** Video variants per run offered in Settings (`--vb`). */
export const VIDEO_BATCH_OPTIONS = [1, 2, 4] as const;

/**
 * `--vb N` for the Settings "Variants" default, or undefined when it does not
 * apply: setting is 1, the prompt is not a `--video` prompt, or the prompt
 * already carries its own `--vb` / `--vbatch` (a typed flag wins).
 */
export function videoBatchFlag(
  prompt: string,
  setting: number | undefined,
): string | undefined {
  const n = Math.min(4, Math.round(Number(setting)));
  if (!Number.isFinite(n) || n <= 1) return undefined;
  if (!/(^|\s)--video(?=\s|$)/i.test(prompt)) return undefined;
  if (/(^|\s)--(vb|vbatch)(?=\s|$)/i.test(prompt)) return undefined;
  return `--vb ${n}`;
}
