"use client";

/**
 * Before / after wipe for a tool result: the cut that went into the tool
 * and the clip that came back, played in sync, with a draggable divider
 * (same wipe math and keys as the lightbox image compare).
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, Replace, X } from "lucide-react";
import { stepPercent, wipePercent } from "@/lib/compareSlider";
import { useVideoEditStore, type VideoResult } from "@/store/videoEditStore";
import { placeResult } from "./VideoPanels";

export function VideoCompare({ result }: { result: VideoResult }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const [pct, setPct] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [placing, setPlacing] = useState(false);
  // Work files are cleaned up after a while; say so instead of showing black.
  const [offline, setOffline] = useState({ before: false, after: false });
  const dragging = useRef(false);

  // The "after" clip leads; "before" follows it.
  useEffect(() => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a || !b) return;
    let raf = 0;
    const follow = () => {
      if (
        Math.abs(b.currentTime - a.currentTime) > 0.08 &&
        a.currentTime <= (b.duration || Infinity)
      )
        b.currentTime = a.currentTime;
      raf = requestAnimationFrame(follow);
    };
    const onPlay = () => {
      setPlaying(true);
      void b.play().catch(() => {});
    };
    const onPause = () => {
      setPlaying(false);
      b.pause();
      b.currentTime = a.currentTime;
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    raf = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, [result.id]);

  const toggle = () => {
    const a = afterRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  };

  const fromPointer = (clientX: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (r) setPct(wipePercent(clientX, r.left, r.width));
  };

  const close = () => useVideoEditStore.getState().setCompare(null);

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2"
      data-testid="video-compare"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-[var(--text-primary)]">
          Compare: {result.title}
        </span>
        <span className="text-[var(--text-muted)]">
          Before left, after right
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={placing}
            onClick={() => {
              setPlacing(true);
              void placeResult(result, "replace").then((ok) => {
                setPlacing(false);
                if (!ok) close();
              });
            }}
            className="flex h-8 items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2 text-white hover:opacity-90 disabled:opacity-60"
          >
            {placing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Replace className="h-3.5 w-3.5" aria-hidden />
            )}{" "}
            Replace range
          </button>
          <button
            type="button"
            aria-label="Close compare"
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={boxRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-lg bg-black"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        <video
          ref={afterRef}
          src={result.url}
          playsInline
          loop
          preload="auto"
          className="absolute inset-0 h-full w-full object-contain"
          aria-label={`After: ${result.title}`}
          onError={() => setOffline((o) => ({ ...o, after: true }))}
        />
        <video
          ref={beforeRef}
          src={result.cutUrl}
          muted
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-contain"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
          aria-label="Before"
          onError={() => setOffline((o) => ({ ...o, before: true }))}
        />
        {(offline.before || offline.after) && (
          <p role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-white/80 z-20 bg-black/60">
            Media offline: the {offline.before ? "original cut" : "result"} is
            no longer on the server (old files are cleaned up).
            {offline.before && !offline.after
              ? " You can still replace the range with the result."
              : ""}
          </p>
        )}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Compare divider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          onKeyDown={(e) => {
            const next = stepPercent(pct, e.key);
            if (next !== pct) {
              e.preventDefault();
              e.stopPropagation();
              setPct(next);
            }
          }}
          className="absolute inset-y-0 z-10 -ml-3 flex w-6 cursor-ew-resize justify-center outline-none focus-visible:[&>span]:bg-[var(--accent-primary)]"
          style={{ left: `${pct}%` }}
        >
          <span aria-hidden className="h-full w-0.5 bg-white shadow" />
        </div>
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          Before
        </span>
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          After
        </span>
      </div>
      <button
        type="button"
        onClick={toggle}
        className="flex h-9 items-center justify-center gap-1.5 self-center rounded-lg border border-[var(--border-secondary)] px-3 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      >
        {playing ? (
          <Pause className="h-4 w-4" aria-hidden />
        ) : (
          <Play className="h-4 w-4" aria-hidden />
        )}
        {playing ? "Pause both" : "Play both"}
      </button>
    </div>
  );
}
