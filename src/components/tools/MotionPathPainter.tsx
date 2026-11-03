"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eraser,
  Loader2,
  MousePointerClick,
  Paintbrush,
  Pin,
  Spline,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  WAN_MOVE_DRAW_LIMITS,
  pathLength,
  sampleMaskSeeds,
  simplifyStroke,
  type DrawPoint,
  type WanMoveDraw,
} from "@/lib/oj/wanMoveDraw";

interface MotionPathPainterProps {
  imageUrl: string;
  /** Called on every change with the drawing (normalized), or undefined when empty. */
  onChange: (draw: WanMoveDraw | undefined) => void;
}

type Mode = "path" | "brush" | "smart" | "pin";

interface ClickPt extends DrawPoint {
  neg: boolean;
}

interface PathState {
  key: number;
  points: DrawPoint[];
  seeds: DrawPoint[];
  /** Smart select clicks, natural image pixels. */
  clicks: ClickPt[];
}

const COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [236, 72, 153],
  [34, 211, 238],
  [250, 204, 21],
  [132, 204, 22],
  [168, 85, 247],
  [249, 115, 22],
];
const MAX_PATHS = WAN_MOVE_DRAW_LIMITS.paths;
/** Region canvases only feed seed sampling: small is enough. */
const REGION_MAX_SIDE = 256;
const SMART_DEBOUNCE_MS = 250;
const PIN_HIT = 0.03;

const rgb = (c: readonly number[], a = 1) =>
  `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

async function toDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read image"));
    r.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode mask"));
    img.src = src;
  });
}

let nextKey = 1;
const emptyPath = (): PathState => ({
  key: nextKey++,
  points: [],
  seeds: [],
  clicks: [],
});

/**
 * Free-draw input for Trajectory motion (Wan-Move): draw paths over the
 * photo; optionally paint (Brush) or click (Smart select, SAM 3.1) the part
 * each path should move; drop pins to hold things still. Paths without a
 * region move a small cluster around where the stroke starts.
 */
export function MotionPathPainter({
  imageUrl,
  onChange,
}: MotionPathPainterProps) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>("path");
  const [erase, setErase] = useState(false);
  const [brush, setBrush] = useState(10);
  const [paths, setPaths] = useState<PathState[]>(() => [emptyPath()]);
  const [active, setActive] = useState(0);
  const [pins, setPins] = useState<DrawPoint[]>([]);
  const [live, setLive] = useState<DrawPoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);
  const regions = useRef(new Map<number, HTMLCanvasElement>());
  const painting = useRef<DrawPoint | null>(null);
  const stroke = useRef<DrawPoint[] | null>(null);
  const imageRef = useRef<{ url: string; ref: string } | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const regionSize = natural
    ? (() => {
        const s = Math.min(1, REGION_MAX_SIDE / Math.max(natural.w, natural.h));
        return {
          w: Math.max(1, Math.round(natural.w * s)),
          h: Math.max(1, Math.round(natural.h * s)),
        };
      })()
    : null;

  // New image: reset everything.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    setPaths([emptyPath()]);
    setActive(0);
    setPins([]);
    setSmartError(null);
    imageRef.current = null;
    seq.current++;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const usable = paths.filter((p) => p.points.length >= 2);
    if (usable.length === 0) {
      onChange(undefined);
      return;
    }
    onChange({
      paths: usable.map((p) =>
        p.seeds.length
          ? { points: p.points, seeds: p.seeds }
          : { points: p.points },
      ),
      ...(pins.length ? { pins } : {}),
    });
  }, [paths, pins, onChange]);

  const activePath = paths[active] ?? paths[0];

  const updatePath = useCallback((key: number, patch: Partial<PathState>) => {
    setPaths((prev) =>
      prev.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    );
  }, []);

  const resampleSeeds = useCallback(
    (key: number) => {
      const c = regions.current.get(key);
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      updatePath(key, { seeds: sampleMaskSeeds(data, c.width, c.height) });
    },
    [updatePath],
  );

  // Pointer -> coordinates

  const norm = (e: React.PointerEvent<HTMLElement>): DrawPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const paintSegment = (key: number, from: DrawPoint, to: DrawPoint) => {
    const c = regions.current.get(key);
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const color = rgb(
      COLORS[paths.findIndex((p) => p.key === key) % COLORS.length],
    );
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
    ctx.lineWidth = (Math.min(c.width, c.height) * brush) / 100;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x * c.width, from.y * c.height);
    ctx.lineTo(to.x * c.width, to.y * c.height);
    ctx.stroke();
  };

  // Smart select

  const runSmart = async (key: number, clicks: ClickPt[]) => {
    const my = ++seq.current;
    const c = regions.current.get(key);
    const include = clicks.filter((p) => !p.neg).map(({ x, y }) => ({ x, y }));
    const exclude = clicks.filter((p) => p.neg).map(({ x, y }) => ({ x, y }));
    if (!c || include.length === 0) {
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      setBusy(false);
      resampleSeeds(key);
      return;
    }
    setBusy(true);
    setSmartError(null);
    const request = async (image: string) => {
      const res = await fetch("/api/tools/smart-mask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          include,
          exclude,
          width: natural?.w,
          height: natural?.h,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        mask?: string;
        image?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.mask)
        throw new Error(data.error || `Smart select failed (${res.status})`);
      return data;
    };
    try {
      const url = imageUrl;
      const cached =
        imageRef.current?.url === url ? imageRef.current.ref : null;
      let data;
      try {
        data = await request(cached ?? (await toDataUrl(url)));
      } catch (e) {
        if (!cached) throw e;
        imageRef.current = null;
        data = await request(await toDataUrl(url));
      }
      if (my !== seq.current) return;
      if (data.image) imageRef.current = { url, ref: data.image };
      const img = await loadImage(data.mask!);
      if (my !== seq.current) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const tmp = document.createElement("canvas");
      tmp.width = c.width;
      tmp.height = c.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) return;
      tctx.drawImage(img, 0, 0, c.width, c.height);
      const px = tctx.getImageData(0, 0, c.width, c.height);
      const color =
        COLORS[paths.findIndex((p) => p.key === key) % COLORS.length];
      for (let i = 0; i < px.data.length; i += 4) {
        const on = px.data[i] > 127;
        px.data[i] = color[0];
        px.data[i + 1] = color[1];
        px.data[i + 2] = color[2];
        px.data[i + 3] = on ? 255 : 0;
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.putImageData(px, 0, 0);
      resampleSeeds(key);
    } catch (e) {
      if (my === seq.current)
        setSmartError(e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  const setClicks = (key: number, clicks: ClickPt[]) => {
    updatePath(key, { clicks });
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      void runSmart(key, clicks);
    }, SMART_DEBOUNCE_MS);
  };

  // Actions

  const finishStroke = (raw: DrawPoint[]) => {
    const pts = simplifyStroke(raw);
    if (pts.length < 2 || pathLength(pts) < WAN_MOVE_DRAW_LIMITS.minPathLength)
      return;
    if (activePath.points.length === 0) {
      updatePath(activePath.key, { points: pts });
      return;
    }
    if (paths.length >= MAX_PATHS) {
      // Full: redraw the active path instead of adding one.
      updatePath(activePath.key, { points: pts });
      return;
    }
    const p = { ...emptyPath(), points: pts };
    setPaths((prev) => [...prev, p]);
    setActive(paths.length);
  };

  const addPath = () => {
    if (paths.length >= MAX_PATHS || activePath.points.length === 0) return;
    setPaths((prev) => [...prev, emptyPath()]);
    setActive(paths.length);
    setMode("brush");
  };

  const removeActive = () => {
    seq.current++;
    regions.current.delete(activePath.key);
    if (paths.length <= 1) {
      setPaths([emptyPath()]);
      setActive(0);
      return;
    }
    setPaths((prev) => prev.filter((p) => p.key !== activePath.key));
    setActive((i) => Math.max(0, Math.min(i, paths.length - 2)));
  };

  const clearAll = () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    regions.current.clear();
    setPaths([emptyPath()]);
    setActive(0);
    setPins([]);
    setBusy(false);
    setSmartError(null);
  };

  const togglePin = (p: DrawPoint) => {
    const aspect = natural ? natural.w / natural.h : 1;
    const hit = pins.findIndex(
      (q) => Math.hypot((q.x - p.x) * aspect, q.y - p.y) < PIN_HIT,
    );
    if (hit >= 0) setPins(pins.filter((_, i) => i !== hit));
    else if (pins.length < WAN_MOVE_DRAW_LIMITS.pins)
      setPins([
        ...pins,
        { x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 },
      ]);
  };

  // Render

  const chip = (on: boolean) =>
    `flex items-center gap-1 rounded-lg px-2.5 py-1.5 border ${
      on
        ? "border-splash text-splash bg-splash/10"
        : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400"
    }`;
  const modes: Array<{ id: Mode; label: string; icon: typeof Spline }> = [
    { id: "path", label: "Path", icon: Spline },
    { id: "brush", label: "Region", icon: Paintbrush },
    { id: "smart", label: "Smart", icon: MousePointerClick },
    { id: "pin", label: "Pin", icon: Pin },
  ];
  const hint: Record<Mode, string> = {
    path: "Drag from the thing to move to where it should end up. Each stroke adds a path (up to 6).",
    brush:
      "Paint what the selected path moves (motion brush). Without a region, the area right where the path starts moves.",
    smart:
      "Click the object the selected path moves (Smart select). Alt/Option-click or right-click excludes.",
    pin: "Click to pin a point so it stays still (background, a hand on a table). Click a pin again to remove it.",
  };
  const vbW = natural?.w ?? 1000;
  const vbH = natural?.h ?? 1000;
  const sw = Math.max(vbW, vbH) / 220;
  const anyDrawing =
    pins.length > 0 || paths.some((p) => p.points.length || p.seeds.length);

  return (
    <div className="space-y-2" data-testid="motion-path-painter">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div
          className="flex rounded-lg border border-light-100 dark:border-dark-750 p-0.5"
          role="group"
          aria-label="Draw mode"
        >
          {modes.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              aria-pressed={mode === id}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${
                mode === id
                  ? "bg-splash/10 text-splash"
                  : "text-light-500 dark:text-dark-400"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
        {mode === "brush" && (
          <>
            <button
              type="button"
              onClick={() => setErase((v) => !v)}
              aria-pressed={erase}
              className={chip(erase)}
            >
              <Eraser className="w-3.5 h-3.5" /> Erase
            </button>
            <label className="flex items-center gap-2 text-light-500 dark:text-dark-400">
              Brush
              <input
                type="range"
                min={2}
                max={40}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                aria-label="Brush size"
              />
            </label>
          </>
        )}
        {mode === "smart" && (
          <button
            type="button"
            onClick={() =>
              setClicks(activePath.key, activePath.clicks.slice(0, -1))
            }
            disabled={activePath.clicks.length === 0}
            className={`${chip(false)} disabled:opacity-40`}
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo click
          </button>
        )}
        <button
          type="button"
          onClick={clearAll}
          disabled={!anyDrawing}
          className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 border border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 disabled:opacity-40"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5 text-xs"
        role="group"
        aria-label="Paths"
      >
        {paths.map((p, i) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={active === i}
            className={chip(active === i)}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: rgb(COLORS[i % COLORS.length]) }}
            />
            Path {i + 1}
            {p.points.length < 2
              ? " (draw)"
              : p.seeds.length
                ? " + region"
                : ""}
          </button>
        ))}
        <button
          type="button"
          onClick={addPath}
          disabled={paths.length >= MAX_PATHS || activePath.points.length === 0}
          className={`${chip(false)} disabled:opacity-40`}
        >
          + Path
        </button>
        <button
          type="button"
          onClick={removeActive}
          disabled={!activePath.points.length && !activePath.seeds.length}
          className={`${chip(false)} disabled:opacity-40`}
        >
          <Trash2 className="w-3.5 h-3.5" /> Remove path
        </button>
      </div>

      <div
        className="relative mx-auto max-h-[60vh] w-full overflow-hidden rounded-xl border border-light-100 dark:border-dark-750 bg-black/20"
        style={
          natural
            ? {
                aspectRatio: `${natural.w} / ${natural.h}`,
                maxWidth: "min(100%, 640px)",
              }
            : { aspectRatio: "1 / 1", maxWidth: 640 }
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt="First frame to draw motion on"
          className="absolute inset-0 h-full w-full object-fill select-none"
          draggable={false}
        />
        {regionSize &&
          paths.map((p, i) => (
            <canvas
              key={p.key}
              ref={(el) => {
                if (!el) return;
                if (el.width !== regionSize.w || el.height !== regionSize.h) {
                  el.width = regionSize.w;
                  el.height = regionSize.h;
                }
                regions.current.set(p.key, el);
              }}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ opacity: i === active ? 0.5 : 0.25 }}
            />
          ))}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${vbW} ${vbH}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            {COLORS.map((c, i) => (
              <marker
                key={i}
                id={`mpp-arrow-${i}`}
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill={rgb(c)} />
              </marker>
            ))}
          </defs>
          {paths.map((p, i) =>
            p.points.length >= 2 ? (
              <g key={p.key} opacity={i === active ? 1 : 0.6}>
                <polyline
                  points={p.points
                    .map((q) => `${q.x * vbW},${q.y * vbH}`)
                    .join(" ")}
                  fill="none"
                  stroke={rgb(COLORS[i % COLORS.length])}
                  strokeWidth={sw}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={`url(#mpp-arrow-${i % COLORS.length})`}
                />
                <circle
                  cx={p.points[0].x * vbW}
                  cy={p.points[0].y * vbH}
                  r={sw * 1.6}
                  fill={rgb(COLORS[i % COLORS.length])}
                  stroke="white"
                  strokeWidth={sw / 3}
                />
              </g>
            ) : null,
          )}
          {live && live.length > 1 && (
            <polyline
              points={live.map((q) => `${q.x * vbW},${q.y * vbH}`).join(" ")}
              fill="none"
              stroke="white"
              strokeOpacity={0.85}
              strokeWidth={sw}
              strokeDasharray={`${sw * 2} ${sw * 1.5}`}
              strokeLinecap="round"
            />
          )}
          {pins.map((q, i) => (
            <g key={i}>
              <circle cx={q.x * vbW} cy={q.y * vbH} r={sw * 2} fill="white" />
              <circle cx={q.x * vbW} cy={q.y * vbH} r={sw} fill="black" />
            </g>
          ))}
          {natural &&
            activePath.clicks.map((q, i) => (
              <circle
                key={`c${i}`}
                cx={q.x}
                cy={q.y}
                r={sw * 1.3}
                fill={q.neg ? "rgb(239,68,68)" : "rgb(34,197,94)"}
                stroke="white"
                strokeWidth={sw / 3}
              />
            ))}
        </svg>
        <div
          role="presentation"
          aria-label={hint[mode]}
          data-testid="motion-path-input"
          className="absolute inset-0 cursor-crosshair touch-none"
          onContextMenu={(e) => {
            if (mode === "smart") e.preventDefault();
          }}
          onPointerDown={(e) => {
            const p = norm(e);
            if (mode === "pin") {
              if (e.button === 0) togglePin(p);
              return;
            }
            if (mode === "smart") {
              if (!natural || (e.button !== 0 && e.button !== 2)) return;
              const neg = e.button === 2 || e.altKey;
              setClicks(activePath.key, [
                ...activePath.clicks,
                {
                  x: Math.min(natural.w - 1, Math.round(p.x * natural.w)),
                  y: Math.min(natural.h - 1, Math.round(p.y * natural.h)),
                  neg,
                },
              ]);
              return;
            }
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            if (mode === "path") {
              stroke.current = [p];
              setLive([p]);
            } else {
              painting.current = p;
              paintSegment(activePath.key, p, p);
            }
          }}
          onPointerMove={(e) => {
            const p = norm(e);
            if (stroke.current) {
              stroke.current.push(p);
              setLive([...stroke.current]);
            } else if (painting.current) {
              paintSegment(activePath.key, painting.current, p);
              painting.current = p;
            }
          }}
          onPointerUp={() => {
            if (stroke.current) {
              const raw = stroke.current;
              stroke.current = null;
              setLive(null);
              finishStroke(raw);
            } else if (painting.current) {
              painting.current = null;
              resampleSeeds(activePath.key);
            }
          }}
          onPointerCancel={() => {
            stroke.current = null;
            setLive(null);
            if (painting.current) {
              painting.current = null;
              resampleSeeds(activePath.key);
            }
          }}
        />
        {mode === "smart" && (busy || smartError) && (
          <div
            className={`pointer-events-none absolute left-2 top-2 flex max-w-[90%] items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-white ${
              smartError && !busy ? "bg-red-600/90" : "bg-black/70"
            }`}
            role="status"
          >
            {busy ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Selecting…
              </>
            ) : (
              smartError
            )}
          </div>
        )}
      </div>
      <p className="text-[11px] text-light-500 dark:text-dark-400">
        {hint[mode]}
      </p>
    </div>
  );
}
