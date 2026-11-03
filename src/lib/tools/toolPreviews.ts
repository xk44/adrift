/**
 * Tool card previews: optional still (.webp) or looping video (.webm/.mp4)
 * per hub card, served from public/tool-previews/. Presence comes from the
 * generated manifest (scripts/gen-tool-previews-manifest.mjs ->
 * toolPreviews.json), so cards never probe for files that are not there and
 * a card without an entry keeps its procedural gradient cover.
 *
 * Pure (no React) so the fallback and playback rules are unit-tested.
 */

import manifestJson from "./toolPreviews.json";

export interface ToolPreviewEntry {
  /** .webp file name: shown as-is, as the video poster, and under reduced motion. */
  still?: string;
  /** Video file names in source-preference order (webm before mp4). */
  video?: string[];
}

export interface ToolPreviewsManifest {
  previews: Record<string, ToolPreviewEntry>;
}

export const TOOL_PREVIEWS: ToolPreviewsManifest =
  manifestJson as ToolPreviewsManifest;

export const TOOL_PREVIEW_BASE = "/tool-previews/";

export type ToolPreview =
  | { kind: "none" }
  | { kind: "still"; src: string }
  | {
      kind: "video";
      sources: { src: string; type: string }[];
      poster: string | null;
    };

/** Hub card key -> file stem (":" -> "--"). Mirrors the generator script. */
export function toolPreviewSlug(key: string): string {
  return key.replace(/:/g, "--").replace(/[^A-Za-z0-9._-]/g, "_");
}

const VIDEO_TYPES: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
};

function url(file: string): string {
  return TOOL_PREVIEW_BASE + encodeURIComponent(file);
}

/**
 * Which preview a cover shows, if any.
 *  - no manifest entry: none (gradient cover)
 *  - size "sm" (tiny icon tiles): still only, never video
 *  - reduced motion: still when there is one; a video-only entry still
 *    renders, but the caller must never play it (see shouldPlayPreview)
 *  - otherwise: video when there is one, else the still
 */
export function resolveToolPreview(
  key: string,
  opts: {
    manifest?: ToolPreviewsManifest;
    size?: "sm" | "md" | "lg";
    reducedMotion?: boolean;
  } = {},
): ToolPreview {
  const manifest = opts.manifest ?? TOOL_PREVIEWS;
  const entry = manifest.previews[toolPreviewSlug(key)];
  if (!entry) return { kind: "none" };
  const still = entry.still ? url(entry.still) : null;
  const sources = (entry.video ?? []).flatMap((f) => {
    const type = VIDEO_TYPES[f.slice(f.lastIndexOf(".") + 1).toLowerCase()];
    return type ? [{ src: url(f), type }] : [];
  });
  if (opts.size === "sm" || (opts.reducedMotion && still)) {
    return still ? { kind: "still", src: still } : { kind: "none" };
  }
  if (sources.length) return { kind: "video", sources, poster: still };
  return still ? { kind: "still", src: still } : { kind: "none" };
}

/**
 * Video previews never autoplay on load. They play while the card is
 * hovered or focused on devices that can hover, and while scrolled into
 * view on touch devices; never under prefers-reduced-motion.
 */
export function shouldPlayPreview(s: {
  reducedMotion: boolean;
  canHover: boolean;
  hovered: boolean;
  inView: boolean;
}): boolean {
  if (s.reducedMotion) return false;
  return s.canHover ? s.hovered : s.inView;
}

/**
 * Previews made from the same demo input read as one repeated picture when
 * they sit side by side (four foxes on one row). Slug -> shared subject;
 * previews with a distinct look (restyles, grids, sketches) are left out.
 */
export const PREVIEW_SUBJECTS: Readonly<Record<string, string>> = {
  // ceramic fox on a desk
  "action--wan_motion": "fox",
  "action--wan_move": "fox",
  "catalog--qwen21-anything2real": "fox",
  "catalog--qwen21-camera": "fox",
  "catalog--qwen21-remove-bg": "fox",
  // night market street
  "action--camera_move": "market",
  "action--ltx25_animate": "market",
  "action--person_remove": "market",
  "action--remove_object": "market",
  "action--upscale": "market",
  "action--video_object_remove": "market",
  "action--video_remove_text": "market",
  "action--wan_camera": "market",
  "catalog--qwen21-next-scene": "market",
  "catalog--qwen21-pano360": "market",
  // portrait, yellow jacket, city bokeh
  "action--animate": "portrait",
  "action--interpolate": "portrait",
  "action--ltx25_transition": "portrait",
  "action--transition": "portrait",
  "action--vace_extend": "portrait",
  "action--vace_reframe": "portrait",
  "action--video_bg_change": "portrait",
  "action--video_bg_remove": "portrait",
  "catalog--outpaint": "portrait",
  "catalog--qwen21-realism": "portrait",
  "catalog--qwen21-restore": "portrait",
  "catalog--qwen21-unblur-background": "portrait",
  "template--batch_restyle": "portrait",
  "template--skin_enhancer": "portrait",
  // red-jacket edit of the same portrait reads as the same picture
  "action--video_edit": "portrait",
  "catalog--krea2-general-edit": "portrait",
  // product bottle on marble
  "action--bg_remove": "bottle",
  "action--orbit_360": "bottle",
  "action--upscale_seedvr2": "bottle",
  "catalog--flux3-camera": "bottle",
};

/**
 * Card keys (in display order) whose preview repeats a subject an earlier
 * sibling already shows. The first card per subject keeps its preview; the
 * rest fall back to their procedural cover.
 */
export function repeatedPreviews(
  keys: readonly string[],
  manifest: ToolPreviewsManifest = TOOL_PREVIEWS,
  subjects: Readonly<Record<string, string>> = PREVIEW_SUBJECTS,
): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const key of keys) {
    const slug = toolPreviewSlug(key);
    if (!manifest.previews[slug]) continue;
    const subject = subjects[slug];
    if (!subject) continue;
    if (seen.has(subject)) out.add(key);
    else seen.add(subject);
  }
  return out;
}
