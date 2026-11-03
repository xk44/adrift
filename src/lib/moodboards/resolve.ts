/**
 * Shared, path-traversal-safe resolution of moodboard image URLs to local
 * files or remote URLs. Used by the train route (materialize to a dataset
 * dir) and the caption route (read bytes for the captioner).
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import {
  IMAGE_EXTENSIONS,
  MOODBOARD_UPLOAD_DIR,
  expandHome,
  invalidPart,
  isInside,
  realpath,
} from "./files";
import { safeFetchBytes } from "@/lib/net/safeFetch";

export const BOARD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*_images$/;
export const FILE_RE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;

export function kreaRoot(): string {
  return expandHome(
    process.env.KREA_MOODBOARDS_DIR ||
      path.join(os.homedir(), "krea-moodboards"),
  );
}

export function extFromUrl(url: URL): string {
  const ext = path.extname(url.pathname).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : ".jpg";
}

export async function resolveKreaUrl(url: URL): Promise<string | null> {
  const board = url.searchParams.get("board");
  const file = url.searchParams.get("file");
  if (invalidPart(board, BOARD_RE) || invalidPart(file, FILE_RE)) return null;

  const root = path.resolve(kreaRoot());
  // Boards reference the original PNGs; a machine may instead hold the
  // downscaled WebP mirror (same stem), so fall back to that.
  const stem = file!.slice(0, file!.length - path.extname(file!).length);
  const candidates = [file!, ...(/\.webp$/i.test(file!) ? [] : [`${stem}.webp`])];
  for (const candidate of candidates) {
    const filePath = path.resolve(path.join(root, board!, candidate));
    if (!isInside(root, filePath)) return null;
    try {
      const realRoot = await realpath(root);
      const realFile = await realpath(filePath);
      if (!isInside(realRoot, realFile)) return null;
      return realFile;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function resolveUploadUrl(url: URL): Promise<string | null> {
  const prefix = "/data/moodboard-uploads/";
  const file =
    url.pathname === "/api/moodboards/upload"
      ? url.searchParams.get("file")
      : url.pathname.startsWith(prefix)
        ? decodeURIComponent(url.pathname.slice(prefix.length))
        : null;
  if (
    !file ||
    file.includes("\0") ||
    file.includes("..") ||
    file.includes("/") ||
    file.includes("\\")
  ) {
    return null;
  }
  const filePath = path.resolve(path.join(MOODBOARD_UPLOAD_DIR, file));
  const root = path.resolve(MOODBOARD_UPLOAD_DIR);
  if (!isInside(root, filePath)) return null;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(filePath);
    if (!isInside(realRoot, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}

export async function resolveAllowedAbsolutePath(
  value: string,
): Promise<string | null> {
  if (
    !path.isAbsolute(value) ||
    !IMAGE_EXTENSIONS.has(path.extname(value).toLowerCase())
  ) {
    return null;
  }

  try {
    const realFile = await realpath(value);
    const roots = [MOODBOARD_UPLOAD_DIR, kreaRoot()];
    for (const root of roots) {
      const resolvedRoot = path.resolve(root);
      if (!isInside(resolvedRoot, path.resolve(value))) continue;
      const realRoot = await realpath(resolvedRoot);
      if (isInside(realRoot, realFile)) return realFile;
    }
  } catch {
    return null;
  }

  return null;
}

export type ResolvedImageSource =
  { kind: "local"; path: string } | { kind: "remote"; url: URL };

/** Resolve a stored image URL to a trusted local file or a remote URL. */
export async function resolveImageSource(
  urlValue: string,
): Promise<ResolvedImageSource | null> {
  try {
    const url = new URL(urlValue, "http://localhost");
    if (url.pathname === "/api/moodboards/krea") {
      const source = await resolveKreaUrl(url);
      return source ? { kind: "local", path: source } : null;
    }
    if (
      url.pathname === "/api/moodboards/upload" ||
      url.pathname.startsWith("/data/moodboard-uploads/")
    ) {
      const source = await resolveUploadUrl(url);
      return source ? { kind: "local", path: source } : null;
    }
    if (url.origin === "http://localhost" && path.isAbsolute(urlValue)) {
      const source = await resolveAllowedAbsolutePath(urlValue);
      return source ? { kind: "local", path: source } : null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "remote", url };
    }
    // Windows drive paths ("C:\\...") parse as a "c:" URL scheme.
    if (path.isAbsolute(urlValue)) {
      const source = await resolveAllowedAbsolutePath(urlValue);
      return source ? { kind: "local", path: source } : null;
    }
  } catch {
    const source = await resolveAllowedAbsolutePath(urlValue);
    return source ? { kind: "local", path: source } : null;
  }
  return null;
}

/** Hard cap on remote image bytes — a stored URL pointing at a huge or
 * endless response would otherwise be buffered wholesale into memory. */
export const MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;

/** Backends a stored moodboard URL may point at even though they are local. */
function trustedImageHosts(): string[] {
  return [
    process.env.COMFY_HTTP_URL?.trim() || "http://127.0.0.1:8188",
    process.env.STYLEVAULT_API_URL?.trim() || "http://127.0.0.1:8000",
  ];
}

/** Read image bytes for a resolved source (SSRF-guarded, 30s timeout + size cap on remote). */
export async function readImageBytes(
  source: ResolvedImageSource,
): Promise<Buffer | null> {
  try {
    if (source.kind === "local") return await fs.readFile(source.path);
    const { bytes } = await safeFetchBytes(source.url, {
      maxBytes: MAX_REMOTE_IMAGE_BYTES,
      timeoutMs: 30000,
      allowHosts: trustedImageHosts(),
    });
    return bytes;
  } catch {
    return null;
  }
}
