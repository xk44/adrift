"use client";

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Draco and KTX2 decoders default to Google's CDN. Adrift stays local, so these
 * point at a path that does not exist: such a file fails into the fallback (and
 * its download button) instead of phoning out. Leave the meshopt location unset:
 * it has no CDN default, and setting it awaits the script before EVERY load, so
 * a dead path would break plain GLBs too. A meshopt file just fails on its own.
 */
const NO_CDN = "/mesh-decoders-not-bundled/";

let viewerModule: Promise<void> | null = null;

/** Loaded on first use so only 3D results pay for the viewer and three.js. */
function loadViewer(): Promise<void> {
  viewerModule ??= import("@google/model-viewer").then(
    ({ ModelViewerElement }) => {
      ModelViewerElement.dracoDecoderLocation = NO_CDN;
      ModelViewerElement.ktx2TranscoderLocation = NO_CDN;
    },
  );
  return viewerModule;
}

interface MeshPreviewProps {
  src: string;
  label: string;
  poster?: string;
  /** Shown when the viewer or this file cannot load. */
  fallback: ReactNode;
}

export default function MeshPreview({
  src,
  label,
  poster,
  fallback,
}: MeshPreviewProps) {
  const [ready, setReady] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const viewer = useRef<HTMLElement | null>(null);
  const failed = failedSrc === src;

  useEffect(() => {
    let live = true;
    loadViewer().then(
      () => {
        if (live) setReady(true);
      },
      () => {
        if (live) setFailedSrc(src);
      },
    );
    return () => {
      live = false;
    };
  }, [src]);

  useEffect(() => {
    const el = viewer.current;
    if (!el) return;
    const onError = () => setFailedSrc(src);
    el.addEventListener("error", onError);
    return () => el.removeEventListener("error", onError);
  }, [ready, failed, src]);

  if (failed) return <>{fallback}</>;

  // Arrow keys orbit the focused model; keep them from also paging the lightbox.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key.startsWith("Arrow")) e.stopPropagation();
  };

  return (
    <div
      className="h-[70vh] w-[min(90vw,1000px)] max-w-full"
      onKeyDown={onKeyDown}
    >
      {ready &&
        createElement("model-viewer", {
          ref: viewer,
          src,
          poster,
          alt: label,
          "camera-controls": true,
          "interaction-prompt": "none",
          "shadow-intensity": "0.6",
          style: { width: "100%", height: "100%" },
        })}
    </div>
  );
}
