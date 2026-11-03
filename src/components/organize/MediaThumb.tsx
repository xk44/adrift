"use client";

import { useState } from "react";
import { Box, ImageOff, Music, Play } from "lucide-react";
import { thumbKind, type MediaLike } from "@/lib/organize/organizeView";

interface MediaThumbProps {
  item: MediaLike;
  className?: string;
  /** Show the small type badge (video/audio/3D) in the corner. */
  badge?: boolean;
  /** Smaller icon sizing for list rows. */
  compact?: boolean;
}

/**
 * Archive tile media. Videos render a muted first-frame <video> (never an
 * <img> pointed at an .mp4), audio/3D get a neutral tile, and a failed load
 * swaps to a quiet placeholder instead of the browser's broken-image glyph
 * plus alt-text spill.
 */
export function MediaThumb({
  item,
  className = "",
  badge = true,
  compact = false,
}: MediaThumbProps) {
  const [failed, setFailed] = useState(false);
  const kind = thumbKind(item);
  const icon = compact ? "h-4 w-4" : "h-6 w-6";
  const fill = `absolute inset-0 h-full w-full object-cover ${className}`;

  if (failed || kind === "none") {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
        aria-hidden="true"
      >
        <ImageOff className={`${icon} opacity-60`} />
      </div>
    );
  }

  if (kind === "audio" || kind === "mesh") {
    const Icon = kind === "audio" ? Music : Box;
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[var(--bg-tertiary)]"
        aria-hidden="true"
      >
        <Icon className={`${icon} text-[var(--accent-primary)]`} />
        {!compact && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {kind === "audio" ? "Audio" : "3D"}
          </span>
        )}
      </div>
    );
  }

  if (kind === "video") {
    const src = item.videoUrl || item.url;
    return (
      <>
        <video
          src={src}
          className={fill}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          aria-hidden="true"
        />
        {badge && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="h-2.5 w-2.5 translate-x-px" fill="currentColor" />
          </span>
        )}
      </>
    );
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className={fill}
        onError={() => setFailed(true)}
      />
      {badge && item.meshUrl && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <Box className="h-3 w-3" /> 3D
        </span>
      )}
    </>
  );
}
