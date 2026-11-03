import type { ImageAttachment, ImageMode } from "@/types";

/** True when a drag carries files (not text or an in-app thumbnail move). */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return Boolean(types && Array.from(types).includes("Files"));
}

/** The image files out of a drop or paste (other files are ignored). */
export function pickImageFiles(
  files: ArrayLike<File> | null | undefined,
): File[] {
  return Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Prompt-bar attachments for dropped or pasted image files, shaped like the
 * ones the image selector adds (blob URL + the File for upload).
 */
export function imageFilesToAttachments(
  files: readonly File[],
  mode: ImageMode,
  {
    makeUrl = (f: File) => URL.createObjectURL(f),
    makeId = () => crypto.randomUUID(),
  }: { makeUrl?: (f: File) => string; makeId?: () => string } = {},
): ImageAttachment[] {
  return files.map((file) => ({
    id: makeId(),
    url: makeUrl(file),
    file,
    filename: file.name || undefined,
    mode,
    weight: 1.0,
  }));
}
