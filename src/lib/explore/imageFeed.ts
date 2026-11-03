/**
 * Explore image/video feed helpers (pure, unit-tested).
 *
 * Safety default: the Explore image feed has no Civitai Red picker, so it
 * always asks the server for the SFW civitai.com feed explicitly. Without
 * `nsfw`/`source` the route falls back to the account-level NSFW toggle and
 * the default Trending feed would silently become Civitai Red on shared screens.
 */

export interface ExploreImageQuery {
  query?: string;
  cursor?: string;
  limit?: number;
  sort?: string;
  period?: string;
  video?: boolean;
}

export function buildExploreImageQuery({
  query,
  cursor,
  limit = 24,
  sort,
  period,
  video,
}: ExploreImageQuery): URLSearchParams {
  const p = new URLSearchParams();
  const q = query?.trim();
  if (q) p.set("q", q);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  if (sort) p.set("sort", sort);
  if (period) p.set("period", period);
  if (video) p.set("type", "video");
  p.set("nsfw", "false");
  p.set("source", "com");
  return p;
}

/**
 * Civitai nsfwLevel: numeric bitmask (1 PG, 2 PG-13, 4 R, 8 X, 16 XXX,
 * 32 blocked) on newer endpoints, string ("None" | "Soft" | "Mature" | "X")
 * on the images endpoint. R and up / Mature and up count as mature.
 */
export type CivitaiNsfwLevel = number | string | null | undefined;

export function isMatureLevel(level: CivitaiNsfwLevel): boolean | null {
  if (level == null || level === "") return null;
  if (typeof level === "number") {
    if (!Number.isFinite(level) || level <= 0) return null;
    return level >= 4;
  }
  const s = level.toLowerCase();
  if (s === "none" || s === "pg" || s === "soft" || s === "pg13") return false;
  if (s === "mature" || s === "x" || s === "r" || s === "xxx") return true;
  return null;
}

/**
 * Should a thumbnail start blurred? Mature-flagged media always does; media
 * with no rating does when it came from a feed that allowed mature results.
 */
export function shouldBlurMedia(
  media: { nsfw?: boolean; nsfwLevel?: CivitaiNsfwLevel } | null | undefined,
  feedAllowsMature = false,
): boolean {
  if (!media) return false;
  const byLevel = isMatureLevel(media.nsfwLevel);
  if (byLevel !== null) return byLevel;
  if (media.nsfw === true) return true;
  return feedAllowsMature;
}

const CIVITAI_IMAGE_HOST = /(^|\.)civitai\.com$/;
const CIVITAI_SIZE_SEG = /^(?:[a-z]+=[^/,]+)(?:,[a-z]+=[^/,]+)*$/i;

/**
 * Civitai CDN URL → a resized variant (`/width=450/`). Civitai image URLs look
 * like `https://image.civitai.com/<key>/<uuid>/<options>/<file>` where the
 * options segment is optional (`original=true`, `width=1024`, …). Anything
 * that doesn't match is returned unchanged.
 */
export function civitaiThumbUrl(url: string, width = 450): string {
  if (!url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!CIVITAI_IMAGE_HOST.test(u.hostname) || !u.hostname.startsWith("image."))
    return url;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 4 && CIVITAI_SIZE_SEG.test(segs[2])) {
    segs[2] = `width=${width}`;
  } else if (segs.length === 3) {
    segs.splice(2, 0, `width=${width}`);
  } else {
    return url;
  }
  u.pathname = `/${segs.join("/")}`;
  return u.toString();
}

/**
 * Cap the in-memory image feed: endless scrolling otherwise grows `images`
 * without bound (every tile a decoded image / live <video>). At the cap the
 * feed stops paginating and asks the user to refresh or narrow the search.
 */
export const MAX_FEED_ITEMS = 480;

export function appendCapped<T extends { id: number | string }>(
  prev: T[],
  page: T[],
  max = MAX_FEED_ITEMS,
): T[] {
  const seen = new Set(prev.map((x) => x.id));
  const merged = [...prev, ...page.filter((x) => !seen.has(x.id))];
  return merged.length > max ? merged.slice(0, max) : merged;
}

/** Accessible name for a card's Open button: kind, author, then a prompt snippet. */
export function exploreOpenLabel(
  kind: "image" | "video" | "liked image",
  username?: string | null,
  prompt?: string | null,
): string {
  const who = username?.trim() ? ` by ${username.trim()}` : "";
  const text = (prompt ?? "").replace(/\s+/g, " ").trim();
  const snippet = text.length > 80 ? `${text.slice(0, 79)}\u2026` : text;
  return `Open ${kind}${who}${snippet ? `: ${snippet}` : ""}`;
}
