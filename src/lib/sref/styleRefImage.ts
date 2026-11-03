/**
 * Style-reference image helpers for the --sv2 (Ostris image style-ref) path.
 *
 * Moodboard "Apply to Prompt" writes board image URLs into --sref as
 * server-relative paths (/api/moodboards/krea?..., /api/moodboards/upload?...).
 * Those are neither style codes nor http(s) URLs, so they are read straight
 * from disk through the traversal-safe moodboard resolvers —
 * never via an HTTP self-fetch, which would also trip admin auth.
 */
import { readImageBytes, resolveImageSource } from "@/lib/moodboards/resolve";

const MOODBOARD_PATHS = ["/api/moodboards/krea", "/api/moodboards/upload"];

/** A moodboard image URL (relative, or absolute on any host) served from local disk. */
export function isMoodboardLocalUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 4096) return false;
  try {
    const url = new URL(u, "http://localhost");
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      MOODBOARD_PATHS.includes(url.pathname) ||
      url.pathname.startsWith("/data/moodboard-uploads/")
    );
  } catch {
    return false;
  }
}

/**
 * A style-ref URL the SERVER can turn into bytes: http(s), data:, a ComfyUI
 * /view output, or a local moodboard image. Blob URLs (client object URLs)
 * are unusable server-side.
 */
export function isFetchableImageUrl(u: unknown): u is string {
  return (
    typeof u === "string" &&
    (/^https?:\/\//i.test(u) ||
      u.startsWith("data:image") ||
      u.includes("/view?") ||
      isMoodboardLocalUrl(u))
  );
}

/**
 * First image token in a raw --sref value. Tokens are whitespace-separated and
 * may carry a `::weight` suffix (`url::1.5 url2 --sw` form emitted by
 * the web style store); the weight is stripped.
 */
export function firstStyleRefImage(sref: unknown): string | undefined {
  if (typeof sref !== "string") return undefined;
  for (const raw of sref.split(/\s+/)) {
    const token = raw.replace(/::\d+(?:\.\d+)?$/, "");
    if (token && isFetchableImageUrl(token)) return token;
  }
  return undefined;
}

/** Bytes for a moodboard-local image, or null if it doesn't resolve on disk. */
export async function readMoodboardLocalImage(
  u: string,
): Promise<Buffer | null> {
  if (!isMoodboardLocalUrl(u)) return null;
  const source = await resolveImageSource(
    new URL(u, "http://localhost").pathname +
      new URL(u, "http://localhost").search,
  );
  if (!source || source.kind !== "local") return null;
  return readImageBytes(source);
}
