"use client";

/**
 * Smart select for video tools: scrub the clip, click the subject (include),
 * Alt/right-click to exclude, add more occurrences on other frames where it
 * re-appears, preview the full track. The occurrences ride on the tool request
 * (params.smartTrack) and replace the text-prompted SAM branch server-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, Minus, Plus, Trash2 } from "lucide-react";
import {
  SMART_TRACK_FPS,
  SMART_TRACK_MAX_OCCURRENCES,
  SMART_TRACK_MAX_POINTS,
  clientToNatural,
  contentRect,
  frameIndexAt,
  type SmartTrackOccurrence,
  type SmartTrackPoint,
} from "@/lib/tools/smartTrack";
import {
  uploadDataUrl,
  videoUploadName,
  type ToolVideo,
} from "@/lib/tools/runTool";

interface Props {
  video: ToolVideo;
  /** The tool only processes the first N seconds (clicks after it are ignored). */
  maxSeconds: number;
  value: SmartTrackOccurrence[];
  onChange: (next: SmartTrackOccurrence[]) => void;
}

const sig = (o: SmartTrackOccurrence) =>
  `${frameIndexAt(o.t)}|${o.positive.map((p) => `${p.x},${p.y}`).join(";")}|${o.negative
    .map((p) => `${p.x},${p.y}`)
    .join(";")}`;

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
};

async function postTrack(body: Record<string, unknown>) {
  const res = await fetch("/api/tools/smart-track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false)
    throw new Error(
      typeof data.error === "string" ? data.error : `smart-track ${res.status}`,
    );
  return data;
}

/** White-on-black mask PNG -> tinted, alpha-keyed overlay on a canvas. */
function paintMask(canvas: HTMLCanvasElement, src: string) {
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const on = px[i] > 127;
      px[i] = 34;
      px[i + 1] = 197;
      px[i + 2] = 94;
      px[i + 3] = on ? 120 : 0;
    }
    ctx.putImageData(d, 0, 0);
  };
  img.src = src;
}

export function VideoMaskPicker({ video, maxSeconds, value, onChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refPromise = useRef<{ id: string; p: Promise<string> } | null>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(video.duration ?? 0);
  const [natural, setNatural] = useState({ w: video.width, h: video.height });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [exclude, setExclude] = useState(false);
  const [masks, setMasks] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New clip: forget masks / preview.
  useEffect(() => {
    setMasks({});
    setTrackUrl(null);
    setError(null);
    setT(0);
  }, [video.id]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setBox({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ensureRef = useCallback(() => {
    if (!refPromise.current || refPromise.current.id !== video.id) {
      const p = uploadDataUrl(
        fetch,
        video.dataUrl,
        videoUploadName(video.label),
      );
      refPromise.current = { id: video.id, p };
      p.catch(() => {
        if (refPromise.current?.p === p) refPromise.current = null;
      });
    }
    return refPromise.current.p;
  }, [video]);

  const k = frameIndexAt(t);
  const current = value.find((o) => frameIndexAt(o.t) === k);
  const currentMask = current ? masks[sig(current)] : undefined;
  const rect = useMemo(
    () =>
      box.w && natural.w
        ? contentRect(box.w, box.h, natural.w, natural.h)
        : null,
    [box, natural],
  );

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (currentMask) paintMask(c, currentMask);
    else c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [currentMask]);

  const fetchMask = useCallback(
    (occ: SmartTrackOccurrence) => {
      if (occ.positive.length === 0) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(async () => {
        setPending((n) => n + 1);
        setError(null);
        try {
          const ref = await ensureRef();
          const data = await postTrack({
            mode: "frame",
            video: ref,
            t: occ.t,
            positive: occ.positive,
            negative: occ.negative,
          });
          if (typeof data.mask === "string")
            setMasks((m) => ({ ...m, [sig(occ)]: data.mask as string }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setPending((n) => n - 1);
        }
      }, 250);
    },
    [ensureRef],
  );

  const seek = (next: number) => {
    const el = videoRef.current;
    const max = duration > 0 ? duration - 1 / SMART_TRACK_FPS : next;
    // Snap to the 24 fps grid the tools resample to.
    const snapped =
      Math.round(Math.max(0, Math.min(max, next)) * SMART_TRACK_FPS) /
      SMART_TRACK_FPS;
    setT(snapped);
    if (el) {
      el.pause();
      el.currentTime = snapped;
    }
  };

  const addPoint = (pt: SmartTrackPoint, neg: boolean) => {
    const at = k / SMART_TRACK_FPS;
    let occ: SmartTrackOccurrence;
    let next: SmartTrackOccurrence[];
    if (current) {
      const list = neg ? current.negative : current.positive;
      if (list.length >= SMART_TRACK_MAX_POINTS) return;
      occ = {
        ...current,
        positive: neg ? current.positive : [...current.positive, pt],
        negative: neg ? [...current.negative, pt] : current.negative,
      };
      next = value.map((o) => (o === current ? occ : o));
    } else {
      if (value.length >= SMART_TRACK_MAX_OCCURRENCES) {
        setError(`At most ${SMART_TRACK_MAX_OCCURRENCES} occurrences.`);
        return;
      }
      occ = {
        t: at,
        positive: neg ? [] : [pt],
        negative: neg ? [pt] : [],
      };
      next = [...value, occ].sort((a, b) => a.t - b.t);
    }
    setTrackUrl(null);
    onChange(next);
    fetchMask(occ);
  };

  const onPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = videoRef.current;
    if (!el || !rect) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const pt = clientToNatural(
      e.clientX - r.left,
      e.clientY - r.top,
      r.width,
      r.height,
      natural.w,
      natural.h,
    );
    if (!pt) return;
    addPoint(pt, exclude || e.altKey || e.button === 2);
  };

  const removeOcc = (o: SmartTrackOccurrence) => {
    setTrackUrl(null);
    onChange(value.filter((x) => x !== o));
  };
  const undoLast = () => {
    if (!current) return;
    // Drop the most recent kind of point (excludes first, they are the refinements).
    const occ = current.negative.length
      ? { ...current, negative: current.negative.slice(0, -1) }
      : { ...current, positive: current.positive.slice(0, -1) };
    if (!occ.positive.length && !occ.negative.length) return removeOcc(current);
    setTrackUrl(null);
    onChange(value.map((o) => (o === current ? occ : o)));
    fetchMask(occ);
  };

  const previewTrack = async () => {
    setTracking(true);
    setError(null);
    setTrackUrl(null);
    try {
      const ref = await ensureRef();
      const data = await postTrack({
        mode: "track",
        video: ref,
        occurrences: value,
        seconds: maxSeconds,
      });
      if (typeof data.video === "string") setTrackUrl(data.video);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTracking(false);
    }
  };

  const usable = value.filter((o) => o.positive.length > 0);
  const pastWindow = t > maxSeconds + 0.5 / SMART_TRACK_FPS;
  const dot = (p: SmartTrackPoint, neg: boolean, i: number) =>
    rect && (
      <span
        key={`${neg ? "n" : "p"}${i}`}
        className={`pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${
          neg ? "bg-red-500" : "bg-green-500"
        }`}
        style={{
          left: rect.left + p.x * rect.scale,
          top: rect.top + p.y * rect.scale,
        }}
      />
    );

  return (
    <section className="space-y-2" data-testid="video-mask-picker">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-light-primary dark:text-dark-primary">
          <Crosshair className="h-3.5 w-3.5" /> Smart select (optional)
        </span>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Click mode">
          {[false, true].map((neg) => (
            <button
              key={String(neg)}
              type="button"
              role="radio"
              aria-checked={exclude === neg}
              onClick={() => setExclude(neg)}
              className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] ${
                exclude === neg
                  ? "border-splash bg-splash/10 text-splash"
                  : "border-light-100 text-light-500 dark:border-dark-750 dark:text-dark-400"
              }`}
            >
              {neg ? (
                <Minus className="h-3 w-3" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              {neg ? "Exclude" : "Include"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        Click the subject on any frame (Alt/right-click excludes). If it leaves
        and comes back, scrub there and click it again. Clicks win over the text
        prompt.
      </p>

      <div
        className="relative w-full select-none overflow-hidden rounded-lg bg-black"
        onClick={onPointer}
        onContextMenu={onPointer}
      >
        <video
          ref={videoRef}
          src={video.previewUrl}
          muted
          playsInline
          preload="auto"
          className="block max-h-[60vh] w-full cursor-crosshair object-contain"
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            if (Number.isFinite(el.duration)) setDuration(el.duration);
            if (el.videoWidth)
              setNatural({ w: el.videoWidth, h: el.videoHeight });
            setBox({ w: el.clientWidth, h: el.clientHeight });
          }}
        />
        {rect && (
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            }}
          />
        )}
        {current?.positive.map((p, i) => dot(p, false, i))}
        {current?.negative.map((p, i) => dot(p, true, i))}
        {pending > 0 && (
          <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-white" />
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous frame"
          className="rounded border border-light-100 px-1.5 text-xs dark:border-dark-750"
          onClick={() => seek(t - 1 / SMART_TRACK_FPS)}
        >
          ‹
        </button>
        <input
          type="range"
          aria-label="Scrub"
          className="flex-1 accent-[var(--accent-primary)]"
          min={0}
          max={Math.max(duration, 1 / SMART_TRACK_FPS)}
          step={1 / SMART_TRACK_FPS}
          value={t}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <button
          type="button"
          aria-label="Next frame"
          className="rounded border border-light-100 px-1.5 text-xs dark:border-dark-750"
          onClick={() => seek(t + 1 / SMART_TRACK_FPS)}
        >
          ›
        </button>
        <span className="w-36 text-right font-mono text-[11px] text-light-500 dark:text-dark-400">
          {fmt(t)} · f{k}
        </span>
      </div>
      {pastWindow && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This tool only processes the first {maxSeconds} s; clicks here are
          ignored.
        </p>
      )}

      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((o) => (
            <li
              key={sig(o)}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-[11px] ${
                o === current
                  ? "border-splash/60"
                  : "border-light-100 dark:border-dark-750"
              }`}
            >
              <button
                type="button"
                className="flex-1 text-left font-mono"
                onClick={() => seek(o.t)}
              >
                {fmt(o.t)} · f{frameIndexAt(o.t)} · +{o.positive.length} / −
                {o.negative.length}
                {o.t > maxSeconds + 0.5 / SMART_TRACK_FPS &&
                  " · outside window"}
              </button>
              <button
                type="button"
                aria-label="Remove occurrence"
                onClick={() => removeOcc(o)}
                className="text-light-500 hover:text-red-500 dark:text-dark-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!current}
          onClick={undoLast}
          className="rounded-lg border border-light-100 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-dark-750"
        >
          Undo point
        </button>
        <button
          type="button"
          disabled={usable.length === 0 || tracking}
          onClick={previewTrack}
          className="flex items-center gap-1 rounded-lg border border-splash/60 px-2.5 py-1 text-xs text-splash disabled:opacity-40"
        >
          {tracking && <Loader2 className="h-3 w-3 animate-spin" />}
          Preview track
        </button>
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setTrackUrl(null);
              onChange([]);
            }}
            className="text-xs text-light-500 hover:text-red-500 dark:text-dark-400"
          >
            Clear all
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
      {trackUrl && (
        <video
          src={trackUrl}
          controls
          loop
          autoPlay
          muted
          playsInline
          className="max-h-[50vh] w-full rounded-lg bg-black object-contain"
        />
      )}
    </section>
  );
}
