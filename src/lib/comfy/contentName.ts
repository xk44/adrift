import { createHash } from "crypto";

/**
 * Give an upload name a content-hash suffix ("cj_ref.png" ->
 * "cj_ref_<sha256:16>.png"). ComfyUI's upload runs with overwrite=true, so a
 * fixed client name (e.g. the "cj_ref.png" fallback) let two concurrent jobs
 * clobber each other's input; a content-addressed name makes overwrite only
 * ever replace identical bytes.
 */
export function contentHashedName(filename: string, data: Uint8Array): string {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".png";
  if (stem.endsWith(`_${hash}`)) return filename;
  return `${stem.slice(0, 100)}_${hash}${ext}`;
}
