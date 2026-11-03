"use client";

/**
 * Video editor timeline: ruler (click / drag to scrub), clip blocks with
 * filmstrip thumbnails, audio waveform, speed / fade marks, trim handles,
 * drag to reorder, the in/out range and the playhead. Drags snap to cuts,
 * marks and the playhead (N toggles); Ctrl/⌘+wheel zooms. Every control
 * also works from the keyboard: clips are buttons (Alt+←/→ moves one), trim
 * handles and the playhead are sliders. Under the clips sits the A2 audio
 * lane (music / voice-over): drop audio files on it, drag to move, trim the
 * edges. Diamonds on the cuts add / pick transitions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Magnet,
  MoreHorizontal,
  Music,
  VolumeX,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  audioFades,
  audioLength,
  clipLength,
  DEFAULT_TRANSITION_SECONDS,
  effectiveFades,
  clipSpeed,
  clipStarts,
  formatTimecode,
  frameSeconds,
  moveAudioClip,
  moveClip,
  setTransition,
  snapToFrame,
  timelineDuration,
  transitionAt,
  trimAudio,
  trimClip,
  type AudioClip,
  type EditList,
  type VideoClip,
} from "@/lib/videoEdit/editList";
import { firstAudioFile } from "@/lib/videoEdit/client";
import {
  dropIndex,
  rulerLabel,
  rulerStep,
  rulerTicks,
  SNAP_PX,
  snapTargets,
  snapTime,
  stripSlots,
  waveSlice,
} from "@/lib/videoEdit/timelineLayout";
import { useVideoEditStore } from "@/store/videoEditStore";
import { useFilmstrip, useWaveform } from "./useFilmstrip";
import { VideoClipMenu, type ClipMenuAt } from "./VideoClipMenu";
import { addAudioFile } from "./openVideo";

const ROW_H = 48;
const LANE_H = 28;
const LANE_TOP = 28 + ROW_H + 6;
const CONTENT_H = LANE_TOP + LANE_H + 4;
const MAX_ZOOM = 32;

type Drag =
  | { kind: "scrub" }
  | { kind: "move"; index: number; x0: number; moved: boolean; to: number }
  | {
      kind: "trim";
      id: string;
      edge: "in" | "out";
      x0: number;
      in0: number;
      out0: number;
      /** Timeline start of the clip (ripple keeps it fixed). */
      start: number;
      /** Cuts before the clip (they do not move while trimming). */
      targets: number[];
      cur: { in: number; out: number };
    }
  | {
      kind: "amove";
      id: string;
      x0: number;
      start0: number;
      moved: boolean;
      cur: number;
    }
  | {
      kind: "atrim";
      id: string;
      edge: "in" | "out";
      x0: number;
      in0: number;
      out0: number;
      cur: { in: number; out: number };
    };

const WAVE_H = 16;

function ClipWave({ clip, pps }: { clip: VideoClip; pps: number }) {
  const wave = useWaveform(clip.src.url, clip.src.hasAudio && !clip.muted);
  if (!wave) return null;
  const { offset, size } = waveSlice(clip, wave.duration, pps);
  return (
    <span
      aria-hidden
      data-testid="clip-wave"
      className="absolute inset-x-0 bottom-0 opacity-70"
      style={{
        height: WAVE_H,
        backgroundImage: `url("${wave.url}")`,
        backgroundSize: `${size}px ${WAVE_H}px`,
        backgroundPosition: `${offset}px 0`,
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

/** Fade ramps drawn as dark wedges over a clip's ends. */
function FadeWedges({
  fades: { fadeIn, fadeOut },
  pps,
}: {
  fades: { fadeIn: number; fadeOut: number };
  pps: number;
}) {
  return (
    <>
      {fadeIn > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 h-full bg-black/45"
          style={{
            width: fadeIn * pps,
            clipPath: "polygon(0 0, 100% 0, 0 100%)",
          }}
        />
      )}
      {fadeOut > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 h-full bg-black/45"
          style={{
            width: fadeOut * pps,
            clipPath: "polygon(0 0, 100% 0, 100% 100%)",
          }}
        />
      )}
    </>
  );
}

function LaneWave({ clip, pps }: { clip: AudioClip; pps: number }) {
  const wave = useWaveform(clip.src.url, true, true);
  if (!wave) return null;
  const { offset, size } = waveSlice(clip, wave.duration, pps);
  return (
    <span
      aria-hidden
      data-testid="lane-wave"
      className="absolute inset-0 opacity-80"
      style={{
        backgroundImage: `url("${wave.url}")`,
        backgroundSize: `${size}px ${LANE_H}px`,
        backgroundPosition: `${offset}px 0`,
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

function ClipStrip({ clip, pps }: { clip: VideoClip; pps: number }) {
  const strip = useFilmstrip(clip.src.url, clip.src.duration);
  const slots = useMemo(
    () => (strip ? stripSlots(clip, pps, ROW_H, strip) : []),
    [strip, clip, pps],
  );
  if (!strip) return null;
  const slotW = (strip.tileWidth / strip.tileHeight) * ROW_H;
  return (
    <>
      {slots.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-0 h-full"
          style={{
            left: s.left,
            width: s.width,
            backgroundImage: `url("${strip.url}")`,
            backgroundSize: `${slotW * strip.count}px ${ROW_H}px`,
            backgroundPosition: `${-s.tile * slotW}px 0`,
            backgroundRepeat: "no-repeat",
          }}
        />
      ))}
    </>
  );
}

/**
 * The playhead line. It is the only part of the timeline that follows the
 * playhead, so playback re-renders this and not every clip.
 */
function PlayheadMarker({
  total,
  pps,
  pad,
  fps,
  zoom,
  scrollRef,
  height,
  onKeyDown,
  onPointerDown,
}: {
  height: number;
  total: number;
  pps: number;
  pad: number;
  fps: number;
  zoom: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const playhead = useVideoEditStore((s) => s.playhead);

  // Keep the playhead in view while playing / stepping when zoomed in.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1) return;
    const x = pad + playhead * pps;
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24)
      el.scrollLeft = Math.max(0, x - el.clientWidth / 3);
  }, [playhead, pps, zoom, pad, scrollRef]);

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round(total * 1000) / 1000}
      aria-valuenow={Math.round(playhead * 1000) / 1000}
      aria-valuetext={formatTimecode(playhead, fps)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className="absolute top-0 z-40 -ml-2 flex w-4 cursor-ew-resize touch-none justify-center outline-none focus-visible:[&>span]:bg-white"
      style={{
        left: pad + Math.min(total, playhead) * pps,
        height,
      }}
    >
      <span aria-hidden className="h-full w-0.5 bg-red-500" />
      <span
        aria-hidden
        className="absolute top-0 h-3 w-3 rotate-45 rounded-sm bg-red-500"
      />
    </div>
  );
}

export function VideoTimeline({ compact = false }: { compact?: boolean }) {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const inPoint = useVideoEditStore((s) => s.inPoint);
  const outPoint = useVideoEditStore((s) => s.outPoint);
  const selectedClipId = useVideoEditStore((s) => s.selectedClipId);
  const selectedAudioId = useVideoEditStore((s) => s.selectedAudioId);
  const [laneBusy, setLaneBusy] = useState<number | null>(null);
  const [laneOver, setLaneOver] = useState(false);
  const picks = useVideoEditStore((s) => s.picks);
  const snap = useVideoEditStore((s) => s.snap);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [menu, setMenu] = useState<ClipMenuAt | null>(null);
  const menuReturn = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(null);
    if (refocus) menuReturn.current?.focus();
  }, []);
  const openMenu = (clipId: string, x: number, y: number, from: HTMLElement) => {
    menuReturn.current = from;
    useVideoEditStore.getState().selectClip(clipId);
    useVideoEditStore.getState().setRate(0);
    setMenu({ clipId, x, y });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    setWidth(el.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  // Trim drags preview on a local copy; the store gets one undo step on drop.
  const shown = useMemo(() => {
    if (drag?.kind === "trim")
      return trimClip(edit, drag.id, drag.cur.in, drag.cur.out);
    if (drag?.kind === "amove") return moveAudioClip(edit, drag.id, drag.cur);
    if (drag?.kind === "atrim")
      return trimAudio(edit, drag.id, drag.cur.in, drag.cur.out);
    return edit;
  }, [edit, drag]);

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms around the pointer. Native
  // listener: React's wheel handler is passive and cannot preventDefault.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || compact) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const z0 = zoomRef.current;
      const z1 = Math.min(
        MAX_ZOOM,
        Math.max(1, z0 * Math.exp(-e.deltaY * 0.01)),
      );
      if (Math.abs(z1 - z0) < 1e-3) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const anchor = (el.scrollLeft + px) / z0;
      setZoom(z1);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, anchor * z1 - px);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [compact]);

  const total = Math.max(0.001, timelineDuration(shown));
  const pad = 12;
  const pps = Math.max(1, ((width - pad * 2) / total) * zoom);
  const contentW = total * pps + pad * 2;
  const starts = clipStarts(shown);
  const step = rulerStep(pps);
  const ticks = rulerTicks(total, step);
  const fps = shown.clips[0]?.src.fps || 24;
  const fades = effectiveFades(shown);
  const lane = shown.audio ?? [];

  const timeAt = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - pad;
    return Math.min(total, Math.max(0, x / pps));
  };

  const s = () => useVideoEditStore.getState();
  const snapTol = SNAP_PX / pps;

  /** Scrub target: snapped to cuts / marks when snapping is on (Shift: off). */
  const scrubTime = (e: React.PointerEvent) => {
    const t = timeAt(e.clientX);
    if (!snap || e.shiftKey) return snapToFrame(t, fps);
    const st = s();
    const targets = snapTargets(edit, null, st.inPoint, st.outPoint);
    const snapped = snapTime(t, targets, snapTol);
    return snapped === t ? snapToFrame(t, fps) : snapped;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "scrub") {
      s().seek(scrubTime(e));
    } else if (d.kind === "move") {
      const moved = d.moved || Math.abs(e.clientX - d.x0) > 4;
      setDrag({ ...d, moved, to: dropIndex(edit, d.index, timeAt(e.clientX)) });
    } else if (d.kind === "trim") {
      const clip = edit.clips.find((c) => c.id === d.id);
      const sp = clip ? clipSpeed(clip) : 1;
      // Pointer px are timeline seconds; in / out are source seconds.
      const delta = ((e.clientX - d.x0) / pps) * sp;
      let cur =
        d.edge === "in"
          ? { in: Math.max(0, d.in0 + delta), out: d.out0 }
          : { in: d.in0, out: d.out0 + delta };
      if (snap && !e.shiftKey) {
        // The clip's end on the timeline is what moves (ripple).
        const end = d.start + (cur.out - cur.in) / sp;
        const snapped = snapTime(end, d.targets, snapTol);
        if (snapped !== end) {
          const len = (snapped - d.start) * sp;
          cur =
            d.edge === "in"
              ? { in: Math.max(0, cur.out - len), out: cur.out }
              : { in: cur.in, out: cur.in + len };
        }
      }
      setDrag({ ...d, cur });
    } else if (d.kind === "amove") {
      const moved = d.moved || Math.abs(e.clientX - d.x0) > 4;
      let start = Math.max(0, d.start0 + (e.clientX - d.x0) / pps);
      if (snap && !e.shiftKey) {
        const c = edit.audio?.find((a) => a.id === d.id);
        const len = c ? audioLength(c) : 0;
        const targets = laneTargets(d.id);
        const a = snapTime(start, targets, snapTol);
        if (a !== start) start = a;
        else {
          const b = snapTime(start + len, targets, snapTol);
          if (b !== start + len) start = Math.max(0, b - len);
        }
      }
      setDrag({ ...d, moved, cur: start });
    } else if (d.kind === "atrim") {
      const delta = (e.clientX - d.x0) / pps;
      const c = edit.audio?.find((a) => a.id === d.id);
      let cur =
        d.edge === "in"
          ? { in: d.in0 + delta, out: d.out0 }
          : { in: d.in0, out: d.out0 + delta };
      if (c && snap && !e.shiftKey) {
        const at =
          d.edge === "in"
            ? c.start + (cur.in - c.in)
            : c.start + (cur.out - c.in);
        const snapped = snapTime(at, laneTargets(d.id), snapTol);
        if (snapped !== at)
          cur =
            d.edge === "in"
              ? { in: cur.in + snapped - at, out: cur.out }
              : { in: cur.in, out: cur.out + snapped - at };
      }
      setDrag({ ...d, cur });
    }
  };

  /** Snap targets for a lane clip: cuts, marks, playhead, other lane edges. */
  const laneTargets = (id: string) => {
    const st = s();
    const out = snapTargets(edit, st.playhead, st.inPoint, st.outPoint);
    for (const a of edit.audio ?? [])
      if (a.id !== id) out.push(a.start, a.start + audioLength(a));
    return out;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    if (d.kind === "move") {
      if (d.moved) {
        if (d.to !== d.index) s().apply((l) => moveClip(l, d.index, d.to));
      } else {
        s().selectClip(edit.clips[d.index]?.id ?? null);
        s().seek(scrubTime(e));
      }
    } else if (d.kind === "trim") {
      s().apply((l) => trimClip(l, d.id, d.cur.in, d.cur.out));
    } else if (d.kind === "amove") {
      s().selectAudio(d.id);
      if (d.moved) s().apply((l) => moveAudioClip(l, d.id, d.cur));
      else s().seek(scrubTime(e));
    } else if (d.kind === "atrim") {
      s().apply((l) => trimAudio(l, d.id, d.cur.in, d.cur.out));
    }
  };

  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    s().setRate(0);
    setDrag(d);
  };

  const clipKey = (e: React.KeyboardEvent, i: number, clip: VideoClip) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      openMenu(clip.id, r.left, r.bottom + 4, el);
    } else if (e.key === "Enter") {
      e.preventDefault();
      s().selectClip(clip.id);
      s().seek(starts[i]);
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      const to = e.key === "ArrowLeft" ? i - 1 : i + 1;
      if (to >= 0 && to < edit.clips.length) {
        s().apply((l) => moveClip(l, i, to));
        s().selectClip(clip.id);
      }
    }
  };

  const trimKey = (
    e: React.KeyboardEvent,
    clip: VideoClip,
    edge: "in" | "out",
  ) => {
    const dir =
      e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowUp"
          ? 1
          : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const d = dir * frameSeconds(clip.src.fps) * (e.shiftKey ? 10 : 1);
    s().apply((l) =>
      edge === "in"
        ? trimClip(l, clip.id, clip.in + d, clip.out)
        : trimClip(l, clip.id, clip.in, clip.out + d),
    );
  };

  const laneKey = (e: React.KeyboardEvent, clip: AudioClip) => {
    const dir =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (e.key === "Enter") {
      e.preventDefault();
      s().selectAudio(clip.id);
      s().seek(clip.start);
    } else if (dir && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 1 : frameSeconds(fps);
      s().apply((l) => moveAudioClip(l, clip.id, clip.start + dir * step));
      s().selectAudio(clip.id);
    }
  };

  const laneTrimKey = (
    e: React.KeyboardEvent,
    clip: AudioClip,
    edge: "in" | "out",
  ) => {
    const dir =
      e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowUp"
          ? 1
          : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const d = dir * frameSeconds(fps) * (e.shiftKey ? 10 : 1);
    s().apply((l) =>
      edge === "in"
        ? trimAudio(l, clip.id, clip.in + d, clip.out)
        : trimAudio(l, clip.id, clip.in, clip.out + d),
    );
  };

  const onLaneDrop = (e: React.DragEvent) => {
    setLaneOver(false);
    const f = firstAudioFile(e.dataTransfer.files);
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    if (laneBusy !== null) return;
    const at = snapToFrame(timeAt(e.clientX), fps);
    setLaneBusy(0);
    void addAudioFile(f, at, setLaneBusy).finally(() => setLaneBusy(null));
  };

  const pickTransition = (i: number) => {
    const clip = edit.clips[i];
    if (!clip) return;
    if (!clip.transitionIn)
      s().apply((l) =>
        setTransition(l, clip.id, {
          type: "crossfade",
          d: DEFAULT_TRANSITION_SECONDS,
        }),
      );
    s().selectClip(clip.id);
    s().setPanel("clip");
  };

  const playheadKey = (e: React.KeyboardEvent) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      const f = frameSeconds(fps) * (e.shiftKey ? Math.round(fps) : 1);
      s().setRate(0);
      s().seek(snapToFrame(s().playhead + map[e.key] * f, fps));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      s().seek(e.key === "Home" ? 0 : total);
    }
  };

  const markA = inPoint ?? (outPoint !== null ? 0 : null);
  const markB = outPoint ?? (inPoint !== null ? total : null);
  const moveTo = drag?.kind === "move" && drag.moved ? drag.to : null;
  const insertX =
    moveTo === null
      ? null
      : (() => {
          const others = shown.clips.filter(
            (_, j) => j !== (drag as { index: number }).index,
          );
          const t = others
            .slice(0, moveTo)
            .reduce((a, c) => a + clipLength(c), 0);
          return pad + t * pps;
        })();

  return (
    <div className="flex shrink-0 flex-col gap-1" data-testid="video-timeline">
      {!compact && (
        <div className="flex items-center justify-end gap-1 px-1">
          <button
            type="button"
            aria-label="Snapping"
            aria-pressed={snap}
            title="Snap to cuts, marks and the playhead (N; hold Shift to skip)"
            onClick={() => s().toggleSnap()}
            className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] ${
              snap
                ? "text-[var(--accent-primary)]"
                : "text-[var(--text-secondary)]"
            }`}
          >
            <Magnet className="h-3.5 w-3.5" />
          </button>
          <span
            className="min-w-[2.5rem] text-center text-[10px] tabular-nums text-[var(--text-muted)]"
            title="Ctrl/⌘ + scroll to zoom"
          >
            {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
          </span>
          <button
            type="button"
            aria-label="Zoom out timeline"
            title="Zoom out"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z / 2))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Zoom in timeline"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 2))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="relative overflow-x-auto overflow-y-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <div
          className="relative"
          style={{ width: contentW, height: CONTENT_H }}
        >
          {/* Ruler */}
          <div
            className="absolute inset-x-0 top-0 h-6 cursor-ew-resize border-b border-[var(--border-primary)]"
            onPointerDown={(e) => {
              startDrag(e, { kind: "scrub" });
              s().seek(scrubTime(e));
            }}
            aria-hidden
          >
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-0 h-full border-l border-[var(--border-secondary)] pl-1 text-[10px] leading-6 text-[var(--text-muted)]"
                style={{ left: pad + t * pps }}
              >
                {rulerLabel(t, step)}
              </span>
            ))}
            {picks.map((k, i) => (
              <span
                key={`pick${i}`}
                title="Smart selection pick"
                className="absolute bottom-0 h-2 w-2 -translate-x-1/2 rounded-full bg-emerald-500"
                style={{ left: pad + k.t * pps }}
              />
            ))}
          </div>

          {/* In / out range */}
          {markA !== null && markB !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-6 z-10 border-x-2 border-[var(--accent-primary)] bg-[var(--accent-primary)]/15"
              style={{
                left: pad + markA * pps,
                width: Math.max(2, (markB - markA) * pps),
                height: ROW_H + 8,
              }}
            />
          )}

          {/* Clips */}
          <ol
            className="absolute top-7 m-0 list-none p-0"
            style={{ left: pad, height: ROW_H }}
            aria-label="Clips"
          >
            {shown.clips.map((clip, i) => {
              const len = clipLength(clip);
              const sp = clipSpeed(clip);
              const w = Math.max(6, len * pps);
              const selected = clip.id === selectedClipId;
              const dragging =
                drag?.kind === "move" && drag.moved && drag.index === i;
              return (
                <li
                  key={clip.id}
                  className="absolute top-0"
                  style={{ left: starts[i] * pps, width: w, height: ROW_H }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`Clip ${i + 1}: ${clip.label}, ${len.toFixed(2)} seconds${sp !== 1 ? `, ${sp}x speed` : ""}${clip.muted ? ", muted" : ""}${clip.madeBy ? `, made with ${clip.madeBy}` : ""}`}
                    data-testid="video-clip"
                    onPointerDown={(e) =>
                      startDrag(e, {
                        kind: "move",
                        index: i,
                        x0: e.clientX,
                        moved: false,
                        to: i,
                      })
                    }
                    onKeyDown={(e) => clipKey(e, i, clip)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(
                        clip.id,
                        e.clientX,
                        e.clientY,
                        e.currentTarget as HTMLElement,
                      );
                    }}
                    className={`relative h-full w-full cursor-grab overflow-hidden rounded-md border bg-[var(--bg-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                      selected
                        ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]"
                        : "border-[var(--border-secondary)]"
                    } ${dragging ? "opacity-50" : ""}`}
                  >
                    <ClipStrip clip={clip} pps={pps} />
                    <ClipWave clip={clip} pps={pps} />
                    <FadeWedges fades={fades[i]} pps={pps} />
                    {sp !== 1 && (
                      <span className="pointer-events-none absolute right-1 top-0.5 rounded bg-black/70 px-1 text-[9px] font-semibold tabular-nums text-amber-300">
                        {sp}×
                      </span>
                    )}
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-0.5 pt-3 text-[10px] text-white">
                      {clip.muted && (
                        <VolumeX className="h-3 w-3 shrink-0" aria-hidden />
                      )}
                      {clip.madeBy && (
                        <Wand2 className="h-3 w-3 shrink-0" aria-hidden />
                      )}
                      <span className="truncate">{clip.label}</span>
                    </span>
                  </div>
                  {selected && w >= 40 && (
                    <button
                      type="button"
                      aria-label={`Actions for clip ${i + 1}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.clipId === clip.id}
                      title="AI tools and more for this clip (right-click)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        openMenu(clip.id, r.left, r.bottom + 4, e.currentTarget);
                      }}
                      className="absolute left-3.5 top-0.5 z-20 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] md:left-2.5"
                      data-testid="video-clip-menu-button"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                  {(["in", "out"] as const).map((edge) => (
                    <div
                      key={edge}
                      role="slider"
                      tabIndex={0}
                      aria-label={`Trim ${edge === "in" ? "start" : "end"} of clip ${i + 1}`}
                      aria-valuemin={0}
                      aria-valuemax={
                        Math.round(clip.src.duration * 1000) / 1000
                      }
                      aria-valuenow={
                        Math.round(
                          (edge === "in" ? clip.in : clip.out) * 1000,
                        ) / 1000
                      }
                      aria-valuetext={formatTimecode(
                        edge === "in" ? clip.in : clip.out,
                        clip.src.fps,
                      )}
                      onPointerDown={(e) =>
                        startDrag(e, {
                          kind: "trim",
                          id: clip.id,
                          edge,
                          x0: e.clientX,
                          in0: clip.in,
                          out0: clip.out,
                          start: starts[i],
                          targets: [
                            ...starts.slice(0, i),
                            s().playhead,
                            ...[s().inPoint, s().outPoint].filter(
                              (x): x is number => x !== null,
                            ),
                          ],
                          cur: { in: clip.in, out: clip.out },
                        })
                      }
                      onKeyDown={(e) => trimKey(e, clip, edge)}
                      className={`absolute top-0 z-20 flex h-full w-3 cursor-ew-resize touch-none items-center justify-center outline-none focus-visible:bg-[var(--accent-primary)]/60 md:w-2 ${
                        edge === "in"
                          ? "left-0 rounded-l-md"
                          : "right-0 rounded-r-md"
                      } ${selected ? "bg-[var(--accent-primary)]/70" : "bg-white/20 hover:bg-white/40"}`}
                    >
                      <span
                        aria-hidden
                        className="h-4 w-0.5 rounded bg-white/90"
                      />
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>

          {/* Transitions on the cuts */}
          {shown.clips.map((clip, i) => {
            if (i === 0) return null;
            const t = transitionAt(shown, i);
            const x = pad + starts[i] * pps;
            const room = Math.min(
              clipLength(clip),
              clipLength(shown.clips[i - 1]),
            ) * pps;
            if (!t && room < 28) return null;
            return (
              <div key={`tr${clip.id}`}>
                {t && (
                  <span
                    aria-hidden
                    data-testid="transition-band"
                    className="pointer-events-none absolute top-7 z-10"
                    style={{
                      left: x - (t.d * pps) / 2,
                      width: t.d * pps,
                      height: ROW_H,
                      background:
                        t.type === "crossfade"
                          ? "linear-gradient(90deg, transparent, rgba(255,255,255,0.35) 50%, transparent)"
                          : "linear-gradient(90deg, transparent, rgba(0,0,0,0.75) 50%, transparent)",
                    }}
                  />
                )}
                <button
                  type="button"
                  aria-label={
                    t
                      ? `${t.type === "crossfade" ? "Crossfade" : "Dip to black"} into clip ${i + 1}, ${t.d.toFixed(2)} seconds`
                      : `Add a crossfade into clip ${i + 1}`
                  }
                  title={t ? "Edit the transition" : "Add a crossfade"}
                  data-testid="transition-marker"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => pickTransition(i)}
                  className={`absolute top-[26px] z-30 h-3 w-3 -translate-x-1/2 rotate-45 rounded-sm border outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                    t
                      ? "border-white bg-[var(--accent-primary)]"
                      : "border-white/60 bg-black/50 opacity-60 hover:opacity-100"
                  }`}
                  style={{ left: x }}
                />
              </div>
            );
          })}

          {/* A2 audio lane */}
          <div
            className={`absolute inset-x-0 border-t border-dashed ${
              laneOver
                ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
                : "border-[var(--border-secondary)]"
            }`}
            style={{ top: LANE_TOP - 3, height: LANE_H + 6 }}
            data-testid="audio-lane"
            aria-label="Audio lane"
            onDragOver={(e) => {
              if (!Array.from(e.dataTransfer.types).includes("Files")) return;
              e.preventDefault();
              setLaneOver(true);
            }}
            onDragLeave={() => setLaneOver(false)}
            onDrop={onLaneDrop}
            onPointerDown={(e) => {
              if (e.target !== e.currentTarget) return;
              s().selectAudio(null);
              startDrag(e, { kind: "scrub" });
              s().seek(scrubTime(e));
            }}
          >
            {lane.length === 0 && (
              <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-[10px] text-[var(--text-muted)]">
                <Music className="h-3 w-3" aria-hidden />
                {laneBusy !== null
                  ? `Uploading ${Math.round(laneBusy * 100)}%`
                  : "Drop music or voice-over here"}
              </span>
            )}
            {lane.length > 0 && laneBusy !== null && (
              <span className="pointer-events-none absolute right-2 top-0 text-[10px] text-[var(--text-muted)]">
                Uploading {Math.round(laneBusy * 100)}%
              </span>
            )}
          </div>
          <ol
            className="pointer-events-none absolute m-0 list-none p-0"
            style={{ left: pad, top: LANE_TOP, height: LANE_H }}
            aria-label="Audio clips"
          >
            {lane.map((a, i) => {
              const len = audioLength(a);
              const w = Math.max(6, len * pps);
              const sel = a.id === selectedAudioId;
              const af = audioFades(a);
              const past = a.start + len > total + 1e-6;
              return (
                <li
                  key={a.id}
                  className="pointer-events-auto absolute top-0"
                  style={{ left: a.start * pps, width: w, height: LANE_H }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    title={past ? "Past the end of the video: not exported" : undefined}
                    aria-label={`Audio ${i + 1}: ${a.label}, at ${a.start.toFixed(2)} seconds, ${len.toFixed(2)} seconds${a.muted ? ", muted" : ""}`}
                    data-testid="audio-clip"
                    onPointerDown={(e) =>
                      startDrag(e, {
                        kind: "amove",
                        id: a.id,
                        x0: e.clientX,
                        start0: a.start,
                        moved: false,
                        cur: a.start,
                      })
                    }
                    onKeyDown={(e) => laneKey(e, a)}
                    className={`relative h-full w-full cursor-grab overflow-hidden rounded-md border bg-emerald-900/50 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                      sel
                        ? "border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]"
                        : "border-emerald-700/60"
                    } ${a.muted ? "opacity-50" : ""}`}
                  >
                    <LaneWave clip={a} pps={pps} />
                    <FadeWedges fades={af} pps={pps} />
                    {past && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute top-0 h-full bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.5)_0_4px,transparent_4px_8px)]"
                        style={{
                          left: Math.max(0, (total - a.start) * pps),
                          right: 0,
                        }}
                      />
                    )}
                    <span className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 truncate px-1.5 text-[10px] leading-4 text-white">
                      {a.muted ? (
                        <VolumeX className="h-3 w-3 shrink-0" aria-hidden />
                      ) : (
                        <Music className="h-3 w-3 shrink-0" aria-hidden />
                      )}
                      <span className="truncate">{a.label}</span>
                    </span>
                  </div>
                  {(["in", "out"] as const).map((edge) => (
                    <div
                      key={edge}
                      role="slider"
                      tabIndex={0}
                      aria-label={`Trim ${edge === "in" ? "start" : "end"} of audio ${i + 1}`}
                      aria-valuemin={0}
                      aria-valuemax={Math.round(a.src.duration * 1000) / 1000}
                      aria-valuenow={
                        Math.round((edge === "in" ? a.in : a.out) * 1000) / 1000
                      }
                      onPointerDown={(e) =>
                        startDrag(e, {
                          kind: "atrim",
                          id: a.id,
                          edge,
                          x0: e.clientX,
                          in0: a.in,
                          out0: a.out,
                          cur: { in: a.in, out: a.out },
                        })
                      }
                      onKeyDown={(e) => laneTrimKey(e, a, edge)}
                      className={`absolute top-0 z-20 h-full w-2.5 cursor-ew-resize touch-none outline-none focus-visible:bg-[var(--accent-primary)]/60 md:w-1.5 ${
                        edge === "in" ? "left-0 rounded-l-md" : "right-0 rounded-r-md"
                      } ${sel ? "bg-[var(--accent-primary)]/70" : "bg-white/15 hover:bg-white/40"}`}
                    />
                  ))}
                </li>
              );
            })}
          </ol>

          {insertX !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-6 z-30 w-0.5 bg-[var(--accent-primary)]"
              style={{ left: insertX, height: ROW_H + 8 }}
            />
          )}

          <PlayheadMarker
            total={total}
            pps={pps}
            pad={pad}
            fps={fps}
            zoom={zoom}
            scrollRef={scrollRef}
            height={CONTENT_H}
            onKeyDown={playheadKey}
            onPointerDown={(e) => startDrag(e, { kind: "scrub" })}
          />
        </div>
      </div>
      {menu && <VideoClipMenu at={menu} onClose={closeMenu} />}
    </div>
  );
}
