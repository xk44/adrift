"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  resolveToolPreview,
  shouldPlayPreview,
  type ToolPreviewsManifest,
} from "@/lib/tools/toolPreviews";

function useMediaQuery(query: string, initial: boolean): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, [query]);
  return matches;
}

/**
 * Preview layer over ToolCover's gradient: a still or a muted looping video
 * from public/tool-previews/, listed in the generated manifest. Renders
 * nothing without an entry or when the file fails to load, so the gradient
 * cover underneath is always the fallback.
 *
 * Defaults are the safe side until the media queries resolve on the client
 * (reduced motion on, no hover), so server and first client render agree
 * and nothing plays before the viewer's preference is known.
 */
export function ToolPreviewMedia({
  cardKey,
  size = "md",
  manifest,
}: {
  cardKey: string;
  size?: "sm" | "md" | "lg";
  manifest?: ToolPreviewsManifest;
}) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", true);
  const canHover = useMediaQuery("(hover: hover) and (pointer: fine)", false);
  const preview = useMemo(
    () => resolveToolPreview(cardKey, { manifest, size, reducedMotion }),
    [cardKey, manifest, size, reducedMotion],
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = preview.kind === "video";
  const id =
    preview.kind === "none"
      ? null
      : preview.kind === "still"
        ? preview.src
        : preview.sources[0]!.src;

  // Hover/focus on the whole card (the nearest button or link), not just
  // the cover, so badges and the title overlay do not interrupt playback.
  useEffect(() => {
    const el = wrapRef.current;
    if (!isVideo || !el) return;
    const host = (el.closest("button, a") as HTMLElement | null) ?? el;
    const on = () => setHovered(true);
    const off = () => setHovered(false);
    host.addEventListener("pointerenter", on);
    host.addEventListener("pointerleave", off);
    host.addEventListener("focusin", on);
    host.addEventListener("focusout", off);
    return () => {
      host.removeEventListener("pointerenter", on);
      host.removeEventListener("pointerleave", off);
      host.removeEventListener("focusin", on);
      host.removeEventListener("focusout", off);
    };
  }, [isVideo]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!isVideo || canHover || !el || typeof IntersectionObserver === "undefined")
      return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(!!entry && entry.intersectionRatio >= 0.6),
      { threshold: [0, 0.6, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isVideo, canHover]);

  const play =
    isVideo && shouldPlayPreview({ reducedMotion, canHover, hovered, inView });

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true; // React does not reflect the muted prop as an attribute
    if (play) void v.play().catch(() => {});
    else v.pause();
  }, [play, id]);

  if (preview.kind === "none" || failed === id) return null;

  // A poster paints at once; otherwise fade in when the first frame is ready.
  const visible =
    loadedId === id || (preview.kind === "video" && !!preview.poster);
  const cls = `absolute inset-0 h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${
    visible ? "opacity-100" : "opacity-0"
  }`;
  const onLoad = () => setLoadedId(id);
  const onError = () => setFailed(id);

  return (
    <span
      ref={wrapRef}
      className="absolute inset-0"
      data-tool-preview={preview.kind}
    >
      {preview.kind === "still" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={id ?? undefined}
          src={preview.src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={onLoad}
          onError={onError}
          className={cls}
        />
      ) : (
        <video
          key={id ?? undefined}
          ref={videoRef}
          muted
          loop
          playsInline
          disablePictureInPicture
          preload={preview.poster ? "none" : "metadata"}
          poster={preview.poster ?? undefined}
          tabIndex={-1}
          onLoadedData={onLoad}
          onError={onError}
          className={cls}
        >
          {preview.sources.map((s, i) => (
            <source
              key={s.src}
              src={s.src}
              type={s.type}
              onError={i === preview.sources.length - 1 ? onError : undefined}
            />
          ))}
        </video>
      )}
    </span>
  );
}
