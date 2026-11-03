/**
 * Lightbox -> Tools page input hand-off.
 *
 * "Open in Tools" from the lightbox stores one pending hand-off (tool key +
 * the open image/clip); the Tools page opens that card (overlayToolsStore's
 * pendingToolKey) and the card's runner takes the hand-off once on mount and
 * preloads it as its first input. Pure (no React) so the rules are tested.
 */

import type { GalleryImage } from "@/types";
import type { ToolImage } from "./runTool";
import type { ToolPrefillSettings } from "./provenanceTool";
import type { SmartTrackOccurrence } from "./smartTrack";

/** A hand-off older than this is ignored (the user went somewhere else). */
export const HANDOFF_TTL_MS = 2 * 60_000;

export type HandoffMedia = "image" | "video" | "audio";

export interface ToolHandoff {
  /** Hub card key the runner must match ("action:upscale", "app:<id>", ...). */
  toolKey: string;
  media: HandoffMedia;
  /** Gallery item id (image) — reused as the ToolImage id. */
  itemId: string;
  /** Still image URL, or the clip / audio URL for media "video" / "audio". */
  url: string;
  label: string;
  width: number;
  height: number;
  /** Local run behind the item (gallery images run without an upload). */
  runId?: string;
  jobIndex?: number;
  /**
   * Who offered it: "editor" = the Edit page's image editor, "video-editor" =
   * its video mode (results return there either way).
   */
  origin?: "editor" | "video-editor";
  /**
   * Editor selection for tools that take a mask: black/white PNG data URL
   * (white = selected), preloaded into the tool's mask painter.
   */
  mask?: string;
  /**
   * Video editor smart selection: subject clicks (seconds into the clip,
   * natural pixels) preloaded into a mask-aware video tool's Smart select.
   */
  smartTrack?: SmartTrackOccurrence[];
  /**
   * Images for the slots after the first (image media only), e.g. the end
   * frame of a start/end-frame tool. Loaded like an external image.
   */
  moreImages?: HandoffImage[];
  /** Date.now() when offered. */
  at: number;
}

export interface HandoffImage {
  url: string;
  label: string;
  width: number;
  height: number;
}

/**
 * Hand-off for the open gallery item, or null when the item has nothing a
 * tool can take (3D, missing URL). Audio goes to audio-in tools
 * (ActionToolSpec.audioHandoff).
 */
export function handoffFromGalleryItem(
  item: GalleryImage,
  toolKey: string,
  now: number,
): ToolHandoff | null {
  if (item.meshUrl) return null;
  // A clip that also carries audio is a video (matches lightboxMediaKind).
  if (item.audioUrl && !item.videoUrl) {
    return {
      toolKey,
      media: "audio",
      itemId: item.id,
      url: item.audioUrl,
      label: item.prompt?.slice(0, 60) || "Audio",
      width: 0,
      height: 0,
      at: now,
    };
  }
  const media: HandoffMedia = item.videoUrl ? "video" : "image";
  const url = media === "video" ? item.videoUrl : item.url;
  if (!url) return null;
  return {
    toolKey,
    media,
    itemId: item.id,
    url,
    label: item.prompt?.slice(0, 60) || (media === "video" ? "Clip" : "Image"),
    width: item.width || 0,
    height: item.height || 0,
    ...(item.runId ? { runId: item.runId, jobIndex: item.jobIndex ?? 0 } : {}),
    at: now,
  };
}

/**
 * Take the pending hand-off for `toolKey`: returns it when it matches and is
 * fresh. `remaining` is what the store keeps (a match or a stale entry is
 * dropped; another tool's fresh hand-off is left alone).
 */
export function takeHandoff<T extends { toolKey: string; at: number }>(
  pending: T | null,
  toolKey: string,
  now: number,
): { handoff: T | null; remaining: T | null } {
  if (!pending) return { handoff: null, remaining: null };
  const fresh = now - pending.at <= HANDOFF_TTL_MS && now >= pending.at;
  if (!fresh) return { handoff: null, remaining: null };
  if (pending.toolKey !== toolKey) return { handoff: null, remaining: pending };
  return { handoff: pending, remaining: null };
}

/**
 * Settings hand-off: the "Made with" chip reopens the card that made a run
 * with that run's settings (lib/tools/provenanceTool.ts). Same TTL and
 * one-shot take as the media hand-off.
 */
export interface ToolPrefill {
  toolKey: string;
  settings: ToolPrefillSettings;
  /** Date.now() when offered. */
  at: number;
}

/**
 * ToolImage for an image hand-off that needs no pixel fetch: a local run is
 * referenced by run/job (same shape as the gallery picker). Null for clips
 * and for external images, which the runner loads into a data URL first.
 */
export function galleryToolImage(h: ToolHandoff): ToolImage | null {
  if (h.media !== "image" || !h.runId) return null;
  return {
    id: h.itemId,
    source: "gallery",
    previewUrl: h.url,
    label: h.label,
    width: h.width,
    height: h.height,
    runId: h.runId,
    jobIndex: h.jobIndex ?? 0,
  };
}
