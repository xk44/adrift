/** Filename + MIME rules for POST /api/comfy/upload (route files may only export handlers). */

const UPLOAD_EXT = /\.(png|jpe?g|webp|mp4|mov|m4v|webm|wav|mp3|m4a|flac)$/i;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};

/**
 * Plain basename, safe chars only, image / video / audio extension enforced
 * (anything else falls back to "cj_ref.png").
 */
export function safeUploadName(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "cj_ref.png";
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!cleaned || !UPLOAD_EXT.test(cleaned)) return "cj_ref.png";
  if (cleaned.length <= 128) return cleaned;
  // Keep the extension when trimming so video/audio uploads keep their type.
  const ext = cleaned.slice(cleaned.lastIndexOf("."));
  return cleaned.slice(0, 128 - ext.length) + ext;
}

/** Content type for an upload filename (defaults to image/png). */
export function uploadMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "image/png";
}

/** Input subfolders an upload may target (audio LoRA training clips only). */
const UPLOAD_SUBFOLDER = /^sa3_train\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Optional `subfolder` for POST /api/comfy/upload. Absent/empty -> "" (the
 * input root); anything outside the allowlist -> null (reject).
 */
export function safeUploadSubfolder(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return null;
  return UPLOAD_SUBFOLDER.test(raw) ? raw : null;
}
