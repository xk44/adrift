/**
 * Tool image uploads: keep the user's original file whenever possible.
 *
 * An upload within TOOL_UPLOAD_MAX_SIDE goes to ComfyUI byte for byte (no
 * canvas, no re-encode). Only a larger image is resampled down to the cap,
 * once, with high-quality smoothing, in its own format (a PNG stays a
 * lossless PNG; a JPEG / WebP source is already lossy and stays that format
 * at near-lossless quality). The cap matches the mask export cap
 * (MASK_MAX_SIDE) so a painted mask lines up with the image pixel for pixel,
 * and keeps huge phone photos from reaching graphs that VAE-encode the
 * input at its own size.
 *
 * Pure helpers (no DOM) so the rules are unit tested; the canvas work lives
 * in lib/canvasResample.ts.
 */

/**
 * Longest side of a tool upload; larger images are resampled down to it.
 * Equal to toolsPage MASK_MAX_SIDE (a test pins the two together).
 */
export const TOOL_UPLOAD_MAX_SIDE = 4096;

/** Encoder quality for a lossy source that has to be resampled. */
export const LOSSY_RESAMPLE_QUALITY = 0.95;

export interface UploadResizePlan {
  width: number;
  height: number;
  /** Output type: the source's own when the browser can encode it. */
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** toDataURL quality (lossy types only). */
  quality?: number;
}

/** MIME type of a data: URL ("" when it is not one). */
export function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return m ? m[1].toLowerCase() : "";
}

/**
 * How to bring an upload within `maxSide`, or null to keep the original
 * bytes (within the cap, size unknown, or `maxSide` null = no cap).
 */
export function uploadResizePlan(
  width: number,
  height: number,
  mime: string,
  maxSide: number | null = TOOL_UPLOAD_MAX_SIDE,
): UploadResizePlan | null {
  if (maxSide === null || !(maxSide > 0)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  const long = Math.max(width, height);
  if (long <= maxSide) return null;
  const scale = maxSide / long;
  const size = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  const type = mime.toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg")
    return { ...size, mime: "image/jpeg", quality: LOSSY_RESAMPLE_QUALITY };
  if (type === "image/webp")
    return { ...size, mime: "image/webp", quality: LOSSY_RESAMPLE_QUALITY };
  // PNG, GIF, BMP, AVIF, ...: lossless PNG keeps every pixel (and alpha).
  return { ...size, mime: "image/png" };
}
