/**
 * Live previews: ComfyUI's per-prompt `extra_data.preview_method`.
 *
 * ComfyUI (execution.py set_preview_method) reads this key per prompt and
 * streams binary PREVIEW_IMAGE frames over the WebSocket of the submitting
 * client_id while the sampler runs. Without it the server-wide default
 * applies, which is "none" on a stock install: no previews at all.
 *
 *   auto        TAESD when its decoder is installed, else latent2rgb
 *   latent2rgb  fast, low-detail colour preview (no extra model)
 *   none        no previews
 *
 * Client-safe: no fs / node imports.
 */
export const PREVIEW_METHODS = ["auto", "latent2rgb", "none"] as const;
export type PreviewMethod = (typeof PREVIEW_METHODS)[number];
export const DEFAULT_PREVIEW_METHOD: PreviewMethod = "auto";

export function parsePreviewMethod(v: unknown): PreviewMethod | null {
  return typeof v === "string" &&
    (PREVIEW_METHODS as readonly string[]).includes(v)
    ? (v as PreviewMethod)
    : null;
}

/**
 * Merge the preview method into a prompt's extra_data. A caller that already
 * set `preview_method` keeps it; other keys (pnginfo, ...) are kept as-is.
 */
export function withPreviewMethod(
  extraData: Record<string, unknown> | undefined,
  method: PreviewMethod,
): Record<string, unknown> {
  const base = extraData ?? {};
  if (typeof base.preview_method === "string") return base;
  return { ...base, preview_method: method };
}
