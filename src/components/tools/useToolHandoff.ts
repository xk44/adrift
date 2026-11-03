"use client";

/**
 * Runner side of the lightbox -> Tools hand-off: on mount, take the pending
 * hand-off for this card (if any) and preload it as the first input.
 * Local gallery images go in by run/job (no pixel fetch); external images and
 * clips are fetched into a data URL like a manual upload.
 */

import { useEffect, useRef } from "react";
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  type ToolAudio,
  type ToolImage,
  type ToolVideo,
} from "@/lib/tools/runTool";
import {
  galleryToolImage,
  type HandoffImage,
  type ToolHandoff,
} from "@/lib/tools/toolHandoff";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { readFileAsDataUrl, urlToDataUrl } from "./ToolImageInput";
import { probeVideo } from "./ToolVideoInput";
import { probeDuration } from "./ToolAudioInput";
import { handoffAudioFileName } from "@/lib/tools/audioHandoff";
import { mp4VideoFps } from "@/lib/videoFps";

export interface ToolHandoffTargets {
  onImage?: (img: ToolImage) => void;
  /** Image for slot `slot` (1, 2, ...) from the hand-off's moreImages. */
  onMoreImage?: (slot: number, img: ToolImage) => void;
  onVideo?: (video: ToolVideo) => void;
  onAudio?: (audio: ToolAudio) => void;
  onError?: (message: string) => void;
  /** The raw hand-off, right after it is taken (origin, mask). */
  onHandoff?: (handoff: ToolHandoff) => void;
}

async function loadHandoffImage(h: ToolHandoff): Promise<ToolImage> {
  const direct = galleryToolImage(h);
  if (direct) return direct;
  const dataUrl = await urlToDataUrl(h.url);
  return {
    id: `handoff:${h.itemId}`,
    source: "upload",
    previewUrl: dataUrl,
    dataUrl,
    label: h.label,
    width: h.width,
    height: h.height,
  };
}

async function loadMoreImage(
  h: ToolHandoff,
  m: HandoffImage,
  slot: number,
): Promise<ToolImage> {
  const dataUrl = await urlToDataUrl(m.url);
  return {
    id: `handoff:${h.itemId}:${slot}`,
    source: "upload",
    previewUrl: dataUrl,
    dataUrl,
    label: m.label,
    width: m.width,
    height: m.height,
  };
}

async function loadHandoffVideo(h: ToolHandoff): Promise<ToolVideo> {
  const res = await fetch(h.url);
  if (!res.ok) throw new Error(`clip fetch ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_VIDEO_UPLOAD_BYTES) {
    throw new Error(
      `the clip is ${Math.round(blob.size / 1048576)} MB; the limit is ${MAX_VIDEO_UPLOAD_BYTES / 1048576} MB`,
    );
  }
  const dataUrl = await readFileAsDataUrl(
    new File([blob], "clip.mp4", { type: blob.type || "video/mp4" }),
  );
  const meta = await probeVideo(dataUrl);
  // Same fps probe as an upload (MP4 / MOV only; null otherwise).
  const fps = await blob
    .arrayBuffer()
    .then(mp4VideoFps)
    .catch(() => null);
  return {
    id: `handoff:${h.itemId}`,
    previewUrl: dataUrl,
    dataUrl,
    label: h.label,
    ...meta,
    fps,
    // The untouched gallery clip (not an editor cut): Extend video looks for
    // its lossless tail next to it.
    ...(h.origin ? {} : { sourceUrl: h.url }),
  };
}

async function loadHandoffAudio(h: ToolHandoff): Promise<ToolAudio> {
  const res = await fetch(h.url);
  if (!res.ok) throw new Error(`audio fetch ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error(
      `the audio is ${Math.round(blob.size / 1048576)} MB; the limit is ${MAX_AUDIO_UPLOAD_BYTES / 1048576} MB`,
    );
  }
  const name = handoffAudioFileName(h.url);
  const dataUrl = await readFileAsDataUrl(
    new File([blob], name, { type: blob.type || "audio/mpeg" }),
  );
  return {
    id: `handoff:${h.itemId}`,
    previewUrl: dataUrl,
    dataUrl,
    label: name,
    duration: await probeDuration(dataUrl),
  };
}

/** Preload the lightbox hand-off for `toolKey` once, on mount. */
export function useToolHandoff(
  toolKey: string,
  targets: ToolHandoffTargets,
): void {
  const callbacks = useRef(targets);
  callbacks.current = targets;
  // Component-level liveness (survives StrictMode's effect re-run, unlike a
  // per-effect flag, so the one-shot take still lands).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const { onImage, onVideo, onAudio } = callbacks.current;
    // Only take what this runner can use; leave anything else pending.
    const pending = useToolHandoffStore.getState().pending;
    if (!pending || pending.toolKey !== toolKey) return;
    if (pending.media === "image" && !onImage) return;
    if (pending.media === "video" && !onVideo) return;
    if (pending.media === "audio" && !onAudio) return;
    const h = useToolHandoffStore.getState().take(toolKey);
    if (!h) return;
    callbacks.current.onHandoff?.(h);
    const load: Promise<unknown> =
      h.media === "audio"
        ? loadHandoffAudio(h).then((a) => {
            if (alive.current) callbacks.current.onAudio?.(a);
          })
        : h.media === "video"
        ? loadHandoffVideo(h).then((v) => {
            if (alive.current) callbacks.current.onVideo?.(v);
          })
        : Promise.all([
            loadHandoffImage(h).then((i) => {
              if (alive.current) callbacks.current.onImage?.(i);
            }),
            ...(callbacks.current.onMoreImage
              ? (h.moreImages ?? []).map((m, i) =>
                  loadMoreImage(h, m, i + 1).then((img) => {
                    if (alive.current)
                      callbacks.current.onMoreImage?.(i + 1, img);
                  }),
                )
              : []),
          ]);
    load.catch((e: unknown) => {
      if (!alive.current) return;
      callbacks.current.onError?.(
        `Couldn't load that ${h.media === "video" ? "clip" : h.media === "audio" ? "audio" : "image"}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, [toolKey]);
}
