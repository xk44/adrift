/**
 * Pure helpers for the editor start screen (shown before an image is loaded).
 * Kept free of React so the filtering/validation rules are unit-testable.
 */

import type { GalleryImage } from "@/types";
import { isEditableVideoUrl, parseSourceUrl } from "@/lib/videoEdit/sourceRef";

export type EditorGenerationFilter = "all" | "liked";

export interface EditorPickableImage {
  id: string;
  url: string;
  label: string;
}

/**
 * Normalize a user-typed image link. Accepts absolute http(s) URLs, same-origin
 * paths ("/api/..."), and inline image data URIs. A bare host like
 * "example.com/cat.png" is upgraded to https. Returns null when the input
 * can't be an image location.
 */
export function normalizeImageLinkInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value;

  if (value.startsWith("/") && !value.startsWith("//")) return value;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : `https://${value.replace(/^\/\//, "")}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      if (parsed.hostname !== "localhost") return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isStillImage(image: GalleryImage): boolean {
  return (
    !image.hidden &&
    !image.external &&
    !image.videoUrl &&
    !image.audioUrl &&
    !image.meshUrl &&
    typeof image.url === "string" &&
    image.url.length > 0
  );
}

function createdAtMs(image: GalleryImage): number {
  const ms = Date.parse(image.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Recent generations for the start screen: still images only, newest first,
 * optionally restricted to liked images and to prompts matching `query`
 * (case-insensitive; every whitespace-separated term must match).
 */
export function selectEditorGenerations(
  gallery: readonly GalleryImage[],
  options: { filter: EditorGenerationFilter; query: string },
): GalleryImage[] {
  const terms = options.query.toLowerCase().split(/\s+/).filter(Boolean);

  return gallery
    .filter((image) => {
      if (!isStillImage(image)) return false;
      if (options.filter === "liked" && !image.liked) return false;
      if (terms.length === 0) return true;
      const haystack =
        `${image.prompt ?? ""} ${image.fullPrompt ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

/**
 * Reference images the user previously attached to generations, newest first
 * and de-duplicated by URL. Blob URLs are skipped: they die with the tab that
 * created them, so they can't be reopened from persisted history.
 */
export function collectEditorUploads(
  gallery: readonly GalleryImage[],
): EditorPickableImage[] {
  const seen = new Set<string>();
  const uploads: EditorPickableImage[] = [];
  const newestFirst = [...gallery].sort(
    (a, b) => createdAtMs(b) - createdAtMs(a),
  );

  for (const image of newestFirst) {
    for (const source of image.sourceImages ?? []) {
      const url = source?.url;
      if (!url || url.startsWith("blob:") || seen.has(url)) continue;
      seen.add(url);
      uploads.push({
        id: source.id || url,
        url,
        label: source.filename || "Uploaded image",
      });
    }
  }

  return uploads;
}

/** First image file in a drop/paste payload, if any. */
export function firstImageFile(
  files: ArrayLike<File> | null | undefined,
): File | null {
  if (!files) return null;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file && file.type.startsWith("image/")) return file;
  }
  return null;
}

/** URL the video editor can open for a gallery item, else null. */
export function editableVideoUrl(image: GalleryImage): string | null {
  if (image.hidden || image.external) return null;
  if (image.videoUrl && isEditableVideoUrl(image.videoUrl)) return image.videoUrl;
  // Server-hydrated history keeps the clip in `url` without `videoUrl`.
  if (isEditableVideoUrl(image.url)) return image.url;
  return null;
}

/** Recent videos for the start screen's "Edit a video" row, newest first. */
export function selectEditorVideos(
  gallery: GalleryImage[],
  limit = 12,
): { id: string; url: string; prompt: string }[] {
  const out: { id: string; url: string; prompt: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const g of gallery) {
    const url = editableVideoUrl(g);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ id: g.id, url, prompt: g.prompt ?? "", at: createdAtMs(g) });
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ id, url, prompt }) => ({ id, url, prompt }));
}

/** Recent gallery audio (music, speech) the video editor can lay on its A2 lane. */
export function selectEditorAudio(
  gallery: GalleryImage[],
  limit = 8,
): { id: string; url: string; prompt: string }[] {
  const out: { id: string; url: string; prompt: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const g of gallery) {
    const url = g.audioUrl;
    if (g.hidden || g.external || !url || seen.has(url)) continue;
    if (!parseSourceUrl(url, { audio: true })) continue;
    seen.add(url);
    out.push({ id: g.id, url, prompt: g.prompt ?? "", at: createdAtMs(g) });
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ id, url, prompt }) => ({ id, url, prompt }));
}
