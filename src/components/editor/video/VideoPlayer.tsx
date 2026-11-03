"use client";

/**
 * Video editor viewer: plays the edit list. One <video> per source file stays
 * mounted (so a cut between clips of the same file, or back to a file
 * already loaded, needs no reload); the one under the playhead is shown. A
 * requestAnimationFrame loop drives it: forward playback runs the element
 * natively and follows its clock across cuts, reverse (J) and scrubbing seek
 * frame by frame. Clip speed, volume (up to 100%; louder is export-only) and
 * fades preview live; the export frame shows as a crop guide. In "select"
 * mode a click adds a subject point instead. A crossfade shows the other
 * clip in a second element on top; A2 lane clips play from <audio>
 * elements alongside.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  aspectRatio,
  audioFades,
  audioGain,
  audioLength,
  clipAt,
  clipFades,
  clipLength,
  clipSpeed,
  clipVolume,
  effectiveFades,
  frameSeconds,
  timelineDuration,
  transitionAt,
  type ClipPosition,
  type EditList,
  type OutputFrame,
  type VideoClip,
} from "@/lib/videoEdit/editList";
import { addPickPoint } from "@/lib/videoEdit/videoTools";
import { activeRange, useVideoEditStore } from "@/store/videoEditStore";

/** Displayed picture rect inside an object-contain element. */
export function containRect(
  boxW: number,
  boxH: number,
  mediaW: number,
  mediaH: number,
): { x: number; y: number; w: number; h: number } {
  if (!mediaW || !mediaH || !boxW || !boxH)
    return { x: 0, y: 0, w: boxW, h: boxH };
  const k = Math.min(boxW / mediaW, boxH / mediaH);
  const w = mediaW * k;
  const h = mediaH * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Crop rect of an output aspect inside a picture rect, placed by focus x/y. */
export function frameRect(
  pic: { x: number; y: number; w: number; h: number },
  frame: OutputFrame,
): { x: number; y: number; w: number; h: number } {
  const a = aspectRatio(frame.aspect);
  let w = pic.w;
  let h = pic.h;
  if (w / h > a) w = h * a;
  else h = w / a;
  return {
    x: pic.x + (pic.w - w) * frame.x,
    y: pic.y + (pic.h - h) * frame.y,
    w,
    h,
  };
}

/** 0..1 fade gain at `offset` timeline seconds into a clip. */
export function fadeGain(
  clip: Parameters<typeof clipFades>[0],
  offset: number,
  fades: { fadeIn: number; fadeOut: number } = clipFades(clip),
): number {
  const { fadeIn, fadeOut } = fades;
  const len = clipLength(clip);
  let g = 1;
  if (fadeIn > 0) g = Math.min(g, offset / fadeIn);
  if (fadeOut > 0) g = Math.min(g, (len - offset) / fadeOut);
  return Math.max(0, Math.min(1, g));
}

/**
 * The other clip of a crossfade the playhead is inside: which clip, where
 * in its source, and its weight (0..1) in the blend. Each side plays on
 * past its edge (frozen on the edge frame where the source ends), as the
 * export renders it.
 */
export function crossfadePartner(
  edit: EditList,
  pos: ClipPosition,
): { clip: VideoClip; sourceTime: number; weight: number } | null {
  const len = clipLength(pos.clip);
  const next = transitionAt(edit, pos.index + 1);
  if (next?.type === "crossfade" && pos.offset > len - next.d / 2) {
    const b = edit.clips[pos.index + 1];
    const before = len - pos.offset;
    return {
      clip: b,
      sourceTime: Math.max(0, b.in - before * clipSpeed(b)),
      weight: Math.min(1, Math.max(0, 0.5 - before / next.d)),
    };
  }
  const prev = transitionAt(edit, pos.index);
  if (prev?.type === "crossfade" && pos.offset < prev.d / 2) {
    const a = edit.clips[pos.index - 1];
    return {
      clip: a,
      sourceTime: Math.min(
        Math.max(0, a.src.duration - 0.04),
        a.out + pos.offset * clipSpeed(a),
      ),
      weight: Math.min(1, Math.max(0, 0.5 - pos.offset / prev.d)),
    };
  }
  return null;
}

const MIN_RATE = 0.0625;
const MAX_RATE = 16;

export function VideoPlayer() {
  const edit = useVideoEditStore((s) => s.edit);
  const selecting = useVideoEditStore((s) => s.selecting);
  // Narrow selectors: these only change when the frame crosses a clip or a
  // pick, so the player does not re-render on every playback tick.
  const here = useVideoEditStore((s) => {
    const c = s.edit ? clipAt(s.edit, s.playhead) : null;
    const f = frameSeconds(c?.clip.src.fps ?? 24);
    return s.picks.find((k) => Math.abs(k.t - s.playhead) < f / 2) ?? null;
  });
  const posClip = useVideoEditStore((s) =>
    s.edit ? (clipAt(s.edit, s.playhead)?.clip ?? null) : null,
  );
  const frame = useVideoEditStore((s) => s.edit?.frame ?? null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const partnerRef = useRef<HTMLVideoElement>(null);
  const lanes = useRef(new Map<string, HTMLAudioElement>());
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [offline, setOffline] = useState<ReadonlySet<string>>(new Set());
  const videos = useRef(new Map<string, HTMLVideoElement>());

  const urls = useMemo(
    () => Array.from(new Set((edit?.clips ?? []).map((c) => c.src.url))),
    [edit],
  );
  const laneUrls = useMemo(
    () => Array.from(new Set((edit?.audio ?? []).map((c) => c.src.url))),
    [edit],
  );

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() =>
      setBox({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastClipId: string | null = null;
    let lastSeq = -1;
    let lastRate = 0;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const s = useVideoEditStore.getState();
      if (!s.edit) return;
      const pos = clipAt(s.edit, s.playhead);
      if (!pos) return;
      const v = videos.current.get(pos.clip.src.url);
      if (!v) return;
      const total = timelineDuration(s.edit);
      const range = activeRange(s.edit, s.inPoint, s.outPoint, null);
      const loopStart = s.loop && range.source === "marks" ? range.start : 0;
      const loopEnd = s.loop && range.source === "marks" ? range.end : total;
      const half = frameSeconds(pos.clip.src.fps) / 2;

      // Show only the active element; pause the rest.
      videos.current.forEach((el) => {
        const on = el === v;
        el.style.opacity = on ? "1" : "0";
        if (!on && !el.paused) el.pause();
      });
      v.muted = pos.clip.muted;
      const sp = clipSpeed(pos.clip);
      const gain = fadeGain(pos.clip, pos.offset, effectiveFades(s.edit)[pos.index]);
      const partner = crossfadePartner(s.edit, pos);
      syncPartner(partnerRef.current, partner, s.rate);
      syncLane(lanes.current, s.edit, s.playhead, s.rate);
      v.volume =
        Math.min(1, clipVolume(pos.clip)) * gain * (1 - (partner?.weight ?? 0));
      if (fadeRef.current) fadeRef.current.style.opacity = String(1 - gain);
      const elRate = Math.min(MAX_RATE, Math.max(MIN_RATE, s.rate * sp));

      const userSeek = s.seekSeq !== lastSeq;
      const clipChanged = pos.clip.id !== lastClipId;
      lastSeq = s.seekSeq;
      lastClipId = pos.clip.id;

      if (s.rate > 0) {
        if (v.readyState < 1) return;
        if (v.paused || userSeek || clipChanged || lastRate <= 0) {
          if (Math.abs(v.currentTime - pos.sourceTime) > half)
            v.currentTime = pos.sourceTime;
          v.playbackRate = elRate;
          if (v.paused)
            void v.play().catch(() => useVideoEditStore.getState().setRate(0));
        } else if (v.playbackRate !== elRate) {
          v.playbackRate = elRate;
        }
        lastRate = s.rate;
        if (v.seeking) return;
        const src = Math.min(v.currentTime, pos.clip.out);
        let t = pos.start + (src - pos.clip.in) / sp;
        const atClipEnd = v.ended || v.currentTime >= pos.clip.out - 1e-3;
        if (atClipEnd) t = pos.start + clipLength(pos.clip);
        if (t >= loopEnd - 1e-3 && (s.loop || t >= total - 1e-3)) {
          if (s.loop) {
            s.seek(loopStart);
          } else {
            v.pause();
            s.setRate(0);
            s.tick(total);
          }
          return;
        }
        s.tick(t);
        return;
      }

      if (!v.paused) v.pause();
      lastRate = s.rate;
      if (s.rate < 0) {
        let t = s.playhead + s.rate * dt;
        if (t <= loopStart + 1e-3) {
          if (s.loop) t = loopEnd - half * 2;
          else {
            s.setRate(0);
            t = loopStart;
          }
        }
        s.tick(Math.max(0, t));
      }
      if (v.readyState >= 1 && !v.seeking) {
        const want = clipAt(s.edit, useVideoEditStore.getState().playhead);
        if (want && want.clip.src.url === pos.clip.src.url) {
          if (Math.abs(v.currentTime - want.sourceTime) > half * 0.9)
            v.currentTime = want.sourceTime;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    const laneEls = lanes.current;
    return () => {
      cancelAnimationFrame(raf);
      laneEls.forEach((el) => el.pause());
    };
  }, []);


  const onPicture = (
    e: React.MouseEvent<HTMLDivElement>,
    negative: boolean,
  ) => {
    const s = useVideoEditStore.getState();
    if (!s.edit) return;
    if (!s.selecting) {
      if (!negative) s.togglePlay();
      return;
    }
    e.preventDefault();
    const box = boxRef.current?.getBoundingClientRect();
    const cur = clipAt(s.edit, s.playhead);
    if (!box || !cur) return;
    const r = containRect(
      box.width,
      box.height,
      cur.clip.src.width,
      cur.clip.src.height,
    );
    const x = (e.clientX - box.left - r.x) / r.w;
    const y = (e.clientY - box.top - r.y) / r.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    s.setPicks(
      addPickPoint(
        s.picks,
        s.playhead,
        { x, y },
        negative || e.altKey || e.shiftKey,
        frameSeconds(cur.clip.src.fps),
      ),
    );
  };

  const dot = (p: { x: number; y: number }, negative: boolean, i: number) => {
    const box = boxRef.current;
    const r = containRect(
      box?.clientWidth ?? 0,
      box?.clientHeight ?? 0,
      posClip?.src.width ?? 0,
      posClip?.src.height ?? 0,
    );
    return (
      <span
        key={`${negative ? "n" : "p"}${i}`}
        aria-hidden
        className={`pointer-events-none absolute -ml-2 -mt-2 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold leading-none text-white shadow ${
          negative ? "bg-red-500" : "bg-emerald-500"
        }`}
        style={{ left: r.x + p.x * r.w, top: r.y + p.y * r.h }}
      >
        {negative ? "-" : "+"}
      </span>
    );
  };

  return (
    <div
      ref={boxRef}
      data-testid="video-player"
      className={`relative h-full w-full select-none overflow-hidden bg-black ${
        selecting ? "cursor-crosshair" : "cursor-pointer"
      }`}
      onClick={(e) => onPicture(e, false)}
      onContextMenu={(e) => {
        if (useVideoEditStore.getState().selecting) onPicture(e, true);
      }}
      role="presentation"
    >
      {urls.map((url) => (
        <video
          key={url}
          ref={(el) => {
            if (el) videos.current.set(url, el);
            else videos.current.delete(url);
          }}
          src={url}
          preload="auto"
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: 0 }}
          onError={() => setOffline((o) => new Set(o).add(url))}
        />
      ))}
      <video
        ref={partnerRef}
        aria-hidden
        data-testid="crossfade-partner"
        preload="auto"
        playsInline
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        style={{ opacity: 0 }}
      />
      {laneUrls.map((url) => (
        <audio
          key={url}
          ref={(el) => {
            if (el) lanes.current.set(url, el);
            else lanes.current.delete(url);
          }}
          src={url}
          preload="auto"
        />
      ))}
      <div
        ref={fadeRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      {frame && !selecting && posClip && box.w > 0 && (() => {
        const r = frameRect(
          containRect(box.w, box.h, posClip.src.width, posClip.src.height),
          frame,
        );
        return (
          <div
            aria-hidden
            data-testid="frame-guide"
            className="pointer-events-none absolute border border-white/80"
            style={{
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            }}
          >
            <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">
              {frame.aspect}
            </span>
          </div>
        );
      })()}
      {posClip && offline.has(posClip.src.url) && (
        <p role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-white/80">
          Media offline: this clip&apos;s file is no longer on the server. Open
          the video again from the gallery, or remove the clip.
        </p>
      )}
      {here?.positive.map((p, i) => dot(p, false, i))}
      {here?.negative.map((p, i) => dot(p, true, i))}
      {selecting && (
        <p className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-xs text-white">
          Click the subject. Alt-click or right-click marks what to leave out.
        </p>
      )}
    </div>
  );
}

/** Drive the crossfade element: the partner clip at its weight, or hidden. */
function syncPartner(
  el: HTMLVideoElement | null,
  partner: ReturnType<typeof crossfadePartner>,
  rate: number,
) {
  if (!el) return;
  if (!partner || partner.weight <= 0.001) {
    el.style.opacity = "0";
    if (!el.paused) el.pause();
    return;
  }
  const url = partner.clip.src.url;
  if (el.getAttribute("src") !== url) el.src = url;
  el.style.opacity = String(partner.weight);
  el.muted = partner.clip.muted;
  el.volume = Math.min(1, clipVolume(partner.clip)) * partner.weight;
  if (el.readyState < 1 || el.seeking) return;
  const sp = clipSpeed(partner.clip);
  // Held edge frame (before the source's start / past its end): stay put.
  const frozen =
    partner.sourceTime <= 0.001 ||
    partner.sourceTime >= partner.clip.src.duration - 0.05;
  if (rate > 0 && !frozen) {
    const r = Math.min(MAX_RATE, Math.max(MIN_RATE, rate * sp));
    if (el.playbackRate !== r) el.playbackRate = r;
    if (Math.abs(el.currentTime - partner.sourceTime) > 0.15)
      el.currentTime = partner.sourceTime;
    if (el.paused) void el.play().catch(() => undefined);
    return;
  }
  if (!el.paused) el.pause();
  if (Math.abs(el.currentTime - partner.sourceTime) > 0.02)
    el.currentTime = partner.sourceTime;
}

/** Play the A2 lane clips under the playhead (one per file), pause the rest. */
function syncLane(
  els: Map<string, HTMLAudioElement>,
  edit: EditList,
  t: number,
  rate: number,
) {
  const live = new Set<string>();
  for (const c of edit.audio ?? []) {
    const el = els.get(c.src.url);
    if (!el || live.has(c.src.url)) continue;
    const off = t - c.start;
    const len = audioLength(c);
    if (off < 0 || off >= len) continue;
    live.add(c.src.url);
    const { fadeIn, fadeOut } = audioFades(c);
    let g = 1;
    if (fadeIn > 0) g = Math.min(g, off / fadeIn);
    if (fadeOut > 0) g = Math.min(g, (len - off) / fadeOut);
    el.volume = Math.min(1, audioGain(c)) * Math.max(0, Math.min(1, g));
    const want = c.in + off;
    if (rate > 0) {
      const r = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
      if (el.playbackRate !== r) el.playbackRate = r;
      if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.2)
        el.currentTime = want;
      if (el.paused) void el.play().catch(() => undefined);
    } else if (!el.paused) {
      el.pause();
    }
  }
  els.forEach((el, url) => {
    if (!live.has(url) && !el.paused) el.pause();
  });
}
