"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eraser,
  Loader2,
  MousePointerClick,
  Paintbrush,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { maskSize, overlayToMaskPixels } from "@/lib/tools/toolsPage";
import {
  MASK_FEATHER_MAX,
  MASK_GROW_MAX,
  NO_MASK_ADJUST,
  adjustMaskPixels,
  type MaskAdjust,
} from "@/lib/tools/maskOps";

interface MaskPainterProps {
  imageUrl: string;
  /** Called after every stroke with a black/white PNG data URL (white = fill), or null when empty. */
  onChange: (maskDataUrl: string | null) => void;
  /**
   * Optional per-subject masks (same format, index = subject). Lets a caller
   * keep edits limited to one mask (e.g. polish one face, never blend two).
   */
  onSubjectsChange?: (masks: (string | null)[]) => void;
  /** Subject chips offered (default 2; 1 hides the chips). */
  subjects?: 1 | 2;
  /** Mode on open (subject tools start in Smart). */
  initialMode?: "brush" | "smart";
  /**
   * Mask to start from (black/white PNG data URL, white = fill), e.g. the
   * Edit page selection handed to a tool. Drawn into Subject 1 once the image
   * loads; Brush / Erase / Smart refine it from there.
   */
  initialMask?: string | null;
}

interface Pt {
  x: number;
  y: number;
}

/** Smart-select click in natural image pixels; neg = exclude. */
interface ClickPt extends Pt {
  neg: boolean;
}

type Mode = "brush" | "smart";

const SUBJECTS = [
  { label: "Subject 1", rgb: [236, 72, 153] as const, dot: "bg-pink-500" },
  { label: "Subject 2", rgb: [34, 211, 238] as const, dot: "bg-cyan-400" },
];
const TINT_ALPHA = 0.85;
const SMART_DEBOUNCE_MS = 250;

const rgba = (rgb: readonly number[], a = TINT_ALPHA) =>
  `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

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

/**
 * Compact mask painter for tools that need one (Krea 2 inpaint). Same idea as
 * the Edit tab's inpaint canvas (paint = area to regenerate) but self-contained:
 * it owns its canvas instead of writing to the editor store, so using a tool
 * never disturbs an open edit session.
 *
 * Smart mode: clicks become SAM3 include/exclude points (POST
 * /api/tools/smart-mask); the returned mask is drawn into the active
 * subject's overlay, so Brush/Erase can refine it afterwards. Each subject has
 * its own overlay + points; onChange gets the union.
 */
export function MaskPainter({
  imageUrl,
  onChange,
  onSubjectsChange,
  subjects = 2,
  initialMode = "brush",
  initialMask = null,
}: MaskPainterProps) {
  const overlays = useRef<(HTMLCanvasElement | null)[]>([]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [erase, setErase] = useState(false);
  const [brush, setBrush] = useState(8); // percent of the shorter side
  const [hasPaint, setHasPaint] = useState(false);
  const [active, setActive] = useState(0);
  const [points, setPoints] = useState<ClickPt[][]>(() =>
    SUBJECTS.map(() => []),
  );
  const [busy, setBusy] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);
  const drawing = useRef<Pt | null>(null);
  // Uploaded ComfyUI ref for the current image (reused across clicks).
  const imageRef = useRef<{ url: string; ref: string } | null>(null);
  const seq = useRef<number[]>(SUBJECTS.map(() => 0));
  const timers = useRef<(ReturnType<typeof setTimeout> | null)[]>([]);
  // Edge tools, applied on export (the overlay keeps the raw strokes).
  const [adjust, setAdjustState] = useState<MaskAdjust>(NO_MASK_ADJUST);
  const adjustRef = useRef<MaskAdjust>(NO_MASK_ADJUST);
  const adjustTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Load dimensions whenever the image changes; a new image clears the mask.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    setHasPaint(false);
    setPoints(SUBJECTS.map(() => []));
    setSmartError(null);
    imageRef.current = null;
    seq.current = seq.current.map((n) => n + 1); // drop in-flight results
    for (const c of overlays.current) {
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    }
    onChange(null);
    onSubjectsChange?.(SUBJECTS.map(() => null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(
    () => () => {
      for (const t of timers.current) if (t) clearTimeout(t);
    },
    [],
  );

  const size = natural ? maskSize(natural.w, natural.h) : null;

  // (Re)size the overlays to the export size when dimensions arrive.
  useEffect(() => {
    if (!size) return;
    for (const c of overlays.current) {
      if (!c) continue;
      c.width = size.width;
      c.height = size.height;
    }
  }, [size?.width, size?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const toPng = (data: Uint8ClampedArray, w: number, h: number) => {
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.putImageData(
      new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h),
      0,
      0,
    );
    return out.toDataURL("image/png");
  };

  const exportMask = useCallback(() => {
    const canvases = overlays.current.filter(
      (c): c is HTMLCanvasElement => !!c,
    );
    const first = canvases[0];
    if (!first) return;
    const { width: w, height: h } = first;
    // Union: any subject's painted pixel is on.
    const union = new Uint8ClampedArray(w * h * 4);
    const perSubject: (string | null)[] = [];
    for (const c of canvases) {
      const src = c.getContext("2d")?.getImageData(0, 0, w, h).data;
      if (!src) {
        perSubject.push(null);
        continue;
      }
      for (let i = 3; i < src.length; i += 4) {
        if (src[i] > union[i]) union[i] = src[i];
      }
      if (onSubjectsChange) {
        const { pixels, painted } = overlayToMaskPixels(src);
        perSubject.push(
          painted > 0
            ? toPng(adjustMaskPixels(pixels, w, h, adjustRef.current), w, h)
            : null,
        );
      }
    }
    const { pixels, painted } = overlayToMaskPixels(union);
    setHasPaint(painted > 0);
    onChange(
      painted > 0
        ? toPng(adjustMaskPixels(pixels, w, h, adjustRef.current), w, h)
        : null,
    );
    onSubjectsChange?.(perSubject);
  }, [onChange, onSubjectsChange]);

  // Smart select

  const paintSmartMask = async (subject: number, maskUrl: string) => {
    const c = overlays.current[subject];
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const img = await loadImage(maskUrl);
    const tmp = document.createElement("canvas");
    tmp.width = c.width;
    tmp.height = c.height;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.drawImage(img, 0, 0, c.width, c.height);
    const px = tctx.getImageData(0, 0, c.width, c.height);
    const [r, g, b] = SUBJECTS[subject].rgb;
    const a = Math.round(TINT_ALPHA * 255);
    for (let i = 0; i < px.data.length; i += 4) {
      const on = px.data[i] > 127;
      px.data[i] = r;
      px.data[i + 1] = g;
      px.data[i + 2] = b;
      px.data[i + 3] = on ? a : 0;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.putImageData(px, 0, 0);
  };

  // Seed Subject 1 with the hand-off mask once per (image, mask), after the
  // overlays are sized (the image-change effect has already cleared them).
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!initialMask || !size) return;
    const key = `${imageUrl}\n${initialMask}`;
    if (seeded.current === key) return;
    seeded.current = key;
    let cancelled = false;
    let finished = false;
    paintSmartMask(0, initialMask)
      .then(() => {
        finished = true;
        if (!cancelled) exportMask();
      })
      .catch(() => {
        finished = true;
        seeded.current = null;
      });
    return () => {
      cancelled = true;
      // Interrupted before painting landed: let the next run seed again.
      if (!finished) seeded.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMask, imageUrl, size?.width, size?.height]);

  const runSmart = async (subject: number, pts: ClickPt[]) => {
    const my = ++seq.current[subject];
    const include = pts.filter((p) => !p.neg).map(({ x, y }) => ({ x, y }));
    const exclude = pts.filter((p) => p.neg).map(({ x, y }) => ({ x, y }));
    if (include.length === 0) {
      // Nothing to select: clear this subject's overlay.
      const c = overlays.current[subject];
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      setBusy(false);
      exportMask();
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
      if (!res.ok || !data.ok || !data.mask) {
        throw new Error(data.error || `Smart select failed (${res.status})`);
      }
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
        // The uploaded copy may be gone (ComfyUI restart / input cleanup).
        imageRef.current = null;
        data = await request(await toDataUrl(url));
      }
      if (my !== seq.current[subject] || url !== imageUrl) return;
      if (data.image) imageRef.current = { url, ref: data.image };
      await paintSmartMask(subject, data.mask!);
      if (my !== seq.current[subject]) return;
      exportMask();
    } catch (e) {
      if (my !== seq.current[subject]) return;
      setSmartError(e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current[subject]) setBusy(false);
    }
  };

  const updatePoints = (subject: number, next: ClickPt[]) => {
    setPoints((prev) => prev.map((p, i) => (i === subject ? next : p)));
    const t = timers.current[subject];
    if (t) clearTimeout(t);
    setBusy(true);
    timers.current[subject] = setTimeout(() => {
      timers.current[subject] = null;
      void runSmart(subject, next);
    }, SMART_DEBOUNCE_MS);
  };

  // Pointer handling

  /** Pointer -> overlay pixels (the overlay spans the image exactly). */
  const point = (e: React.PointerEvent<HTMLElement>): Pt => {
    const c = overlays.current[active];
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * (c?.width ?? 1),
      y: ((e.clientY - r.top) / r.height) * (c?.height ?? 1),
    };
  };

  /** Pointer -> natural image pixels (for SAM3). */
  const naturalPoint = (e: React.PointerEvent<HTMLElement>): Pt | null => {
    if (!natural) return null;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return {
      x: Math.min(natural.w - 1, Math.round(fx * natural.w)),
      y: Math.min(natural.h - 1, Math.round(fy * natural.h)),
    };
  };

  const stroke = (from: Pt, to: Pt) => {
    const c = overlays.current[active];
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const color = rgba(SUBJECTS[active].rgb);
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (Math.min(c.width, c.height) * brush) / 100;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const setAdjust = (patch: Partial<MaskAdjust>) => {
    const next = { ...adjustRef.current, ...patch };
    adjustRef.current = next;
    setAdjustState(next);
    if (adjustTimer.current) clearTimeout(adjustTimer.current);
    adjustTimer.current = setTimeout(() => {
      adjustTimer.current = null;
      exportMask();
    }, 150);
  };

  // Import a black/white mask file (white = fill) into the active subject.
  const loadMaskFile = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Could not read that file"));
        r.readAsDataURL(file);
      });
      await paintSmartMask(active, url);
      exportMask();
    } catch {
      setLoadError("Couldn't load that mask. Use a black and white image.");
    }
  };

  const clear = () => {
    for (const t of timers.current) if (t) clearTimeout(t);
    seq.current = seq.current.map((n) => n + 1);
    for (const c of overlays.current) {
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    }
    setPoints(SUBJECTS.map(() => []));
    setBusy(false);
    setSmartError(null);
    setHasPaint(false);
    onChange(null);
    onSubjectsChange?.(SUBJECTS.map(() => null));
  };

  const activePts = points[active] ?? [];
  const anyPoints = points.some((p) => p.length > 0);
  const chip = (on: boolean) =>
    `flex items-center gap-1 rounded-lg px-2.5 py-1.5 border ${
      on
        ? "border-splash text-splash bg-splash/10"
        : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400"
    }`;

  return (
    <div className="space-y-2" data-testid="mask-painter">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div
          className="flex rounded-lg border border-light-100 dark:border-dark-750 p-0.5"
          role="group"
          aria-label="Mask mode"
        >
          {(["brush", "smart"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${
                mode === m
                  ? "bg-splash/10 text-splash"
                  : "text-light-500 dark:text-dark-400"
              }`}
            >
              {m === "brush" ? (
                <Paintbrush className="w-3.5 h-3.5" />
              ) : (
                <MousePointerClick className="w-3.5 h-3.5" />
              )}
              {m === "brush" ? "Brush" : "Smart"}
            </button>
          ))}
        </div>
        {subjects > 1 &&
          SUBJECTS.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={active === i}
              className={chip(active === i)}
            >
              <span className={`h-2 w-2 rounded-full ${s.dot}`} />
              {s.label}
            </button>
          ))}
        {mode === "brush" ? (
          <>
            <button
              type="button"
              onClick={() => setErase(false)}
              aria-pressed={!erase}
              className={chip(!erase)}
            >
              <Paintbrush className="w-3.5 h-3.5" /> Paint
            </button>
            <button
              type="button"
              onClick={() => setErase(true)}
              aria-pressed={erase}
              className={chip(erase)}
            >
              <Eraser className="w-3.5 h-3.5" /> Erase
            </button>
            <label className="flex items-center gap-2 text-light-500 dark:text-dark-400">
              Brush
              <input
                type="range"
                min={1}
                max={30}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                aria-label="Brush size"
              />
            </label>
          </>
        ) : (
          <button
            type="button"
            onClick={() => updatePoints(active, activePts.slice(0, -1))}
            disabled={activePts.length === 0}
            className={`${chip(false)} disabled:opacity-40`}
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo point
          </button>
        )}
        <button
          type="button"
          onClick={clear}
          disabled={!hasPaint && !anyPoints}
          className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 border border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 disabled:opacity-40"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-light-500 dark:text-dark-400"
        data-testid="mask-edge-tools"
      >
        <label className="flex items-center gap-2" title="Make the mask bigger (right) or smaller (left)">
          Grow / shrink
          <input
            type="range"
            min={-MASK_GROW_MAX}
            max={MASK_GROW_MAX}
            value={adjust.grow}
            onChange={(e) => setAdjust({ grow: Number(e.target.value) })}
            aria-label="Grow or shrink the mask"
          />
        </label>
        <label className="flex items-center gap-2" title="Blend the mask edge so the change fades in">
          Soft edge
          <input
            type="range"
            min={0}
            max={MASK_FEATHER_MAX}
            value={adjust.feather}
            onChange={(e) => setAdjust({ feather: Number(e.target.value) })}
            aria-label="Soften the mask edge"
          />
        </label>
        <button
          type="button"
          onClick={() => setAdjust({ invert: !adjust.invert })}
          aria-pressed={adjust.invert}
          className={chip(adjust.invert)}
          title="Change everything except what you painted"
        >
          Invert
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className={chip(false)}
          title="Load a black and white mask image (white = change)"
        >
          <Upload className="w-3.5 h-3.5" /> Load mask
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          data-testid="mask-file-input"
          onChange={(e) => {
            void loadMaskFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
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
          alt="Image to edit"
          className="absolute inset-0 h-full w-full object-fill select-none"
          draggable={false}
        />
        {SUBJECTS.map((s, i) => (
          <canvas
            key={s.label}
            ref={(el) => {
              overlays.current[i] = el;
            }}
            aria-hidden
            className={`pointer-events-none absolute inset-0 h-full w-full ${
              i === active ? "" : "opacity-60"
            }`}
          />
        ))}
        {/* Points are positioned in % of the natural image (same box as the canvases). */}
        {natural &&
          points.flatMap((pts, si) =>
            pts.map((p, pi) => (
              <span
                key={`${si}-${pi}`}
                className={`pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow ${
                  p.neg ? "bg-red-500" : "bg-green-500"
                } ${si === active ? "" : "opacity-40"}`}
                style={{
                  left: `${(p.x / natural.w) * 100}%`,
                  top: `${(p.y / natural.h) * 100}%`,
                }}
              />
            )),
          )}
        <div
          role="presentation"
          aria-label={
            mode === "smart"
              ? "Click to select: click = include, Alt/right-click = exclude"
              : "Mask canvas: paint the area to regenerate"
          }
          data-testid="mask-input"
          className="absolute inset-0 cursor-crosshair touch-none"
          onContextMenu={(e) => {
            if (mode === "smart") e.preventDefault();
          }}
          onPointerDown={(e) => {
            if (mode === "smart") {
              if (e.button !== 0 && e.button !== 2) return;
              const p = naturalPoint(e);
              if (!p) return;
              const neg = e.button === 2 || e.altKey;
              updatePoints(active, [...activePts, { ...p, neg }]);
              return;
            }
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = point(e);
            drawing.current = p;
            stroke(p, p);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = point(e);
            stroke(drawing.current, p);
            drawing.current = p;
          }}
          onPointerUp={() => {
            if (!drawing.current) return;
            drawing.current = null;
            exportMask();
          }}
          onPointerCancel={() => {
            if (!drawing.current) return;
            drawing.current = null;
            exportMask();
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
        {mode === "smart"
          ? "Click the subject to select it (add clicks to grow it). Alt/Option-click or right-click excludes. Switch to Brush to touch up."
          : "Paint the area to regenerate. The mask is sent as white on black."}
        {(adjust.grow !== 0 || adjust.feather > 0 || adjust.invert) &&
          " Edge settings change the mask that is sent; the colored overlay still shows what you painted."}
        {loadError && (
          <span className="block text-red-500" role="alert">
            {loadError}
          </span>
        )}
      </p>
    </div>
  );
}
