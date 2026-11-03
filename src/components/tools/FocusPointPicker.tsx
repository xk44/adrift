"use client";

/**
 * Focus picker for Refocus (click the photo once) and Rack focus (scrub the
 * clip, click point A at its time, then point B at its time). Points are
 * normalized to the media (0..1); times are seconds into the clip.
 */
import { useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import type { FocusPoint } from "@/lib/oj/refocus";

interface ImageProps {
  mode: "image";
  src: string;
  value: FocusPoint[];
  onChange: (next: FocusPoint[]) => void;
}

interface VideoProps {
  mode: "video";
  src: string;
  /** Seconds the tool processes (clicks past it still work, focus just holds). */
  maxSeconds?: number;
  value: FocusPoint[];
  onChange: (next: FocusPoint[]) => void;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Click position inside the media element → normalized point, or null outside it. */
export function normalizedClick(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: round3(x), y: round3(y) };
}

const fmt = (t: number) => `${t.toFixed(2)} s`;

function Marker({ p, label }: { p: FocusPoint; label: string }) {
  return (
    <span
      className="pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-black/50 text-[10px] font-semibold text-white shadow"
      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
    >
      {label}
    </span>
  );
}

export function FocusPointPicker(props: ImageProps | VideoProps) {
  const mediaRef = useRef<HTMLImageElement & HTMLVideoElement>(null);
  const [slot, setSlot] = useState<0 | 1>(0);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const { value, onChange } = props;
  const video = props.mode === "video";

  const onClick = (e: React.MouseEvent) => {
    const el = mediaRef.current;
    if (!el) return;
    const pt = normalizedClick(
      e.clientX,
      e.clientY,
      el.getBoundingClientRect(),
    );
    if (!pt) return;
    if (!video) {
      onChange([pt]);
      return;
    }
    const next = [...value];
    next[slot] = { ...pt, t: Math.round(t * 100) / 100 };
    if (slot === 0 && !next[1]) setSlot(1);
    onChange(next.filter(Boolean));
  };

  const seek = (s: number) => {
    const el = mediaRef.current;
    const v = Math.max(0, Math.min(duration || s, s));
    setT(v);
    if (el) {
      el.pause();
      el.currentTime = v;
    }
  };

  const labels = ["A", "B"];
  const past =
    video && props.maxSeconds !== undefined && t > props.maxSeconds + 0.01;

  return (
    <section className="space-y-2" data-testid="focus-point-picker">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-light-primary dark:text-dark-primary">
          <Crosshair className="h-3.5 w-3.5" />
          {video ? "Focus points" : "Focus point"}
        </span>
        {video && (
          <div
            className="flex gap-1.5"
            role="radiogroup"
            aria-label="Focus point"
          >
            {labels.map((l, i) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={slot === i}
                onClick={() => {
                  setSlot(i as 0 | 1);
                  const at = value[i]?.t;
                  if (at !== undefined) seek(at);
                }}
                className={`rounded-lg border px-2 py-1 text-[11px] ${
                  slot === i
                    ? "border-splash bg-splash/10 text-splash"
                    : "border-light-100 text-light-500 dark:border-dark-750 dark:text-dark-400"
                }`}
              >
                {l}
                {value[i] ? ` · ${fmt(value[i].t ?? 0)}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        {video
          ? "Scrub to where focus should start and click the first subject (A), then scrub to where the pull should land and click the second (B)."
          : "Click what should be sharp; things nearer and farther blur by their depth."}
      </p>

      <div className="flex justify-center rounded-lg bg-black">
        <div
          className="relative inline-block cursor-crosshair select-none"
          onClick={onClick}
        >
          {video ? (
            <video
              ref={mediaRef}
              src={props.src}
              muted
              playsInline
              preload="auto"
              className="block max-h-[60vh] max-w-full"
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d)) setDuration(d);
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={mediaRef}
              src={props.src}
              alt="Click to set focus"
              draggable={false}
              className="block max-h-[60vh] max-w-full"
            />
          )}
          {value.map((p, i) =>
            p ? <Marker key={i} p={p} label={video ? labels[i] : "●"} /> : null,
          )}
        </div>
      </div>

      {video && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Scrub"
            className="flex-1 accent-[var(--accent-primary)]"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={t}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span className="w-16 text-right font-mono text-[11px] text-light-500 dark:text-dark-400">
            {fmt(t)}
          </span>
        </div>
      )}
      {past && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Only the first {props.maxSeconds?.toFixed(1)} s are processed.
        </p>
      )}
    </section>
  );
}
