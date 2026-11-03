"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box,
  Download,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Package,
} from "lucide-react";
import { showToast } from "@/components/Toast";
import type { ImagineRun } from "@/types";
import {
  canvasSize,
  depthFromRgba,
  depthPreview,
  layerImageUrl,
  layerRunResolution,
  manifestBasename,
  manifestPathFromTexts,
  outputFileUrl,
  painterComposite,
  parseLayerManifest,
  partTint,
  SEE_THROUGH_CREDIT,
  zComposite,
  type CompositePart,
  type LayerManifest,
} from "@/lib/layers/seeThrough";
import { writePsd } from "@/lib/layers/psd";
import {
  layerBundleFiles,
  PSD_ORDER_NOTE,
  type LayerBundleKind,
  runAspect,
} from "@/lib/layers/bundle";
import { writeZipBytes } from "@/lib/layers/zip";

type View = "composite" | "depth" | "painter";

interface LoadedPart extends CompositePart {
  name: string;
  png: Uint8Array;
  depthPng: Uint8Array | null;
  thumbUrl: string;
}

interface Loaded {
  manifest: LayerManifest;
  width: number;
  height: number;
  /** Back to front. */
  parts: LoadedPart[];
}

const CHECKER =
  "bg-[length:16px_16px] bg-[linear-gradient(45deg,rgba(128,128,128,.18)_25%,transparent_25%,transparent_75%,rgba(128,128,128,.18)_75%),linear-gradient(45deg,rgba(128,128,128,.18)_25%,transparent_25%,transparent_75%,rgba(128,128,128,.18)_75%)] bg-[position:0_0,8px_8px]";
const BTN =
  "inline-flex items-center gap-1 text-xs text-splash underline disabled:opacity-60";
const TINT: [number, number, number] = [255, 90, 40];

async function fetchBytes(
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function decodeRgba(
  bytes: Uint8Array,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bmp = await createImageBitmap(
    new Blob([bytes as BlobPart], { type: "image/png" }),
    {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    },
  );
  try {
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No 2D canvas");
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { rgba: data, width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Object URLs it creates go into `urls`; the caller revokes them. */
async function loadLayers(
  manifestName: string,
  resolution: number | null,
  signal: AbortSignal,
  urls: string[],
): Promise<Loaded> {
  const res = await fetch(outputFileUrl(manifestName), { signal });
  if (!res.ok)
    throw new Error(`Couldn't load the layer list (HTTP ${res.status})`);
  const manifest = parseLayerManifest(await res.json());
  const { width, height } = canvasSize(manifest, resolution);
  const parts = await mapLimit(manifest.layers, 6, async (l) => {
    const png = await fetchBytes(layerImageUrl(l.filename), signal);
    const img = await decodeRgba(png);
    let depth: Uint8Array | null = null;
    let depthPng: Uint8Array | null = null;
    if (l.depthFilename) {
      try {
        depthPng = await fetchBytes(layerImageUrl(l.depthFilename), signal);
        const d = await decodeRgba(depthPng);
        const fullCanvas =
          d.width === width &&
          d.height === height &&
          (d.width !== img.width || d.height !== img.height);
        depth = depthFromRgba(
          d.rgba,
          d.width,
          d.height,
          img.width,
          img.height,
          fullCanvas ? { left: l.left, top: l.top } : undefined,
        );
      } catch (err) {
        if (signal.aborted) throw err;
        depthPng = null;
      }
    }
    signal.throwIfAborted();
    const thumbUrl = URL.createObjectURL(
      new Blob([png as BlobPart], { type: "image/png" }),
    );
    urls.push(thumbUrl);
    const part: LoadedPart = {
      name: l.name,
      rgba: img.rgba,
      depth,
      left: l.left,
      top: l.top,
      width: img.width,
      height: img.height,
      visible: true,
      depthMedian: l.depthMedian,
      png,
      depthPng,
      thumbUrl,
    };
    return part;
  });
  return { manifest, width, height, parts };
}

function saveBytes(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function encodePng(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Layer Split result: per-pixel depth composite of the see-through parts,
 * a layer list (visibility, solo, hover highlight) and client-built
 * downloads (zip, PSD, parts, Blender script). `fallback` shows on errors.
 */
export function SeeThroughResult({
  run,
  fallback,
}: {
  run: ImagineRun;
  fallback?: ReactNode;
}) {
  const job = run.jobs[0];
  const manifestName = useMemo(() => {
    const p = manifestPathFromTexts(job?.texts);
    return p ? manifestBasename(p) : null;
  }, [job?.texts]);
  const resolution = layerRunResolution(run.params);

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<View>("composite");
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!manifestName) return;
    const ctrl = new AbortController();
    const urls: string[] = [];
    setData(null);
    setError(null);
    setHidden(new Set());
    setSolo(null);
    loadLayers(manifestName, resolution, ctrl.signal, urls)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        ctrl.abort();
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      ctrl.abort();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [manifestName, resolution]);

  const isVisible = useCallback(
    (i: number) => (solo !== null ? i === solo : !hidden.has(i)),
    [solo, hidden],
  );

  useEffect(() => {
    const c = canvasRef.current;
    if (!data || !c) return;
    const parts = data.parts.map((p, i) => ({ ...p, visible: isVisible(i) }));
    const px =
      view === "depth"
        ? depthPreview(parts, data.width, data.height)
        : view === "painter"
          ? painterComposite(parts, data.width, data.height)
          : zComposite(parts, data.width, data.height);
    c.getContext("2d")?.putImageData(
      new ImageData(px, data.width, data.height),
      0,
      0,
    );
  }, [data, view, isVisible]);

  useEffect(() => {
    const c = overlayRef.current;
    const ctx = c?.getContext("2d");
    if (!data || !c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const p = hover !== null ? data.parts[hover] : null;
    if (!p || p.width === 0 || p.height === 0) return;
    ctx.putImageData(
      new ImageData(partTint(p, TINT), p.width, p.height),
      p.left,
      p.top,
    );
  }, [data, hover]);

  const exportBase = (
    data
      ? [data.manifest.prefix || "adrift_layers", data.manifest.timestamp]
          .filter(Boolean)
          .join("_")
      : "adrift_layers"
  ).replace(/[^A-Za-z0-9_-]+/g, "_");

  const buildPsd = (d: Loaded) => {
    const parts = d.parts.map((p, i) => ({ ...p, visible: isVisible(i) }));
    const composite = zComposite(parts, d.width, d.height);
    const psd = writePsd({
      width: d.width,
      height: d.height,
      composite,
      layers: parts.map((p) => ({
        name: p.name,
        left: p.left,
        top: p.top,
        width: p.width,
        height: p.height,
        rgba: p.rgba,
        hidden: !p.visible,
      })),
    });
    return { composite, psd };
  };

  const download = async (kind: LayerBundleKind | "psd") => {
    if (!data || busy) return;
    setBusy(kind);
    // Let the spinner paint before the synchronous composite/PSD work.
    await new Promise((r) => setTimeout(r, 0));
    try {
      if (kind === "psd") {
        const { psd } = buildPsd(data);
        saveBytes(psd, `${exportBase}.psd`, "image/vnd.adobe.photoshop");
        return;
      }
      let compositePng: Uint8Array | null = null;
      let psd: Uint8Array | null = null;
      if (kind === "all") {
        const built = buildPsd(data);
        psd = built.psd;
        compositePng = await encodePng(
          built.composite,
          data.width,
          data.height,
        );
      }
      const files = layerBundleFiles(kind, {
        manifest: data.manifest,
        canvas: { width: data.width, height: data.height },
        parts: data.parts,
        compositePng,
        psd,
        aspect: runAspect(run),
      });
      const suffix =
        kind === "all" ? "" : kind === "parts" ? "_parts" : "_blender";
      saveBytes(
        writeZipBytes(files),
        `${exportBase}${suffix}.zip`,
        "application/zip",
      );
    } catch (err) {
      showToast(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const toggle = (i: number, alt: boolean) => {
    if (alt) {
      setSolo((s) => (s === i ? null : i));
      return;
    }
    setSolo(null);
    setHidden((h) => {
      const next = new Set(h);
      // Soloing another part: this button says "Show", so keep it shown.
      if (solo !== null && i !== solo) next.delete(i);
      else if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  if (!manifestName) return <>{fallback}</>;

  if (error) {
    return (
      <div className="space-y-2" data-testid="see-through-result">
        <p className="text-xs text-red-500" role="alert">
          {`Couldn't load the layers: ${error}`}
        </p>
        {fallback}
      </div>
    );
  }

  if (!data) {
    return (
      <div data-testid="see-through-result">
        <p
          className="flex items-center justify-center gap-1.5 py-10 text-xs text-light-500 dark:text-dark-400"
          role="status"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading layers...
        </p>
      </div>
    );
  }

  const views: { id: View; label: string }[] = [
    { id: "composite", label: "Composite" },
    { id: "depth", label: "Depth" },
    ...(compare ? [{ id: "painter" as const, label: "Painter order" }] : []),
  ];
  const order = data.parts.map((_, i) => i).reverse();

  return (
    <div className="space-y-2" data-testid="see-through-result">
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-lg bg-light-100 p-0.5 dark:bg-dark-750"
              role="group"
              aria-label="Viewer mode"
            >
              {views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={view === v.id}
                  onClick={() => setView(v.id)}
                  className={`rounded-md px-2 py-0.5 text-xs ${
                    view === v.id
                      ? "bg-white text-light-700 shadow-sm dark:bg-dark-600 dark:text-white"
                      : "text-light-500 dark:text-dark-400"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400">
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => {
                  setCompare(e.target.checked);
                  if (!e.target.checked && view === "painter")
                    setView("composite");
                }}
              />
              Compare
            </label>
          </div>
          <div
            className={`relative mx-auto w-full max-w-[34rem] overflow-hidden rounded-lg ${CHECKER}`}
          >
            <canvas
              ref={canvasRef}
              width={data.width}
              height={data.height}
              className="block h-auto w-full"
              role="img"
              aria-label={
                view === "depth"
                  ? "Depth of the nearest part per pixel, near is bright"
                  : view === "painter"
                    ? "Parts drawn whole, back to front by median depth"
                    : "Parts composited with per-pixel depth"
              }
            />
            <canvas
              ref={overlayRef}
              width={data.width}
              height={data.height}
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden="true"
            />
          </div>
        </div>
        <div className="lg:w-60">
          <p className="mb-1 flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400">
            <Layers className="h-3 w-3" />
            {`${data.parts.length} layers, front first. Alt-click an eye to solo.`}
          </p>
          <ul
            className="max-h-[28rem] space-y-0.5 overflow-y-auto pr-1"
            aria-label="Layers"
            onMouseLeave={() => setHover(null)}
          >
            {order.map((i) => {
              const p = data.parts[i];
              const shown = isVisible(i);
              return (
                <li
                  key={i}
                  className={`flex items-center gap-2 rounded-md px-1 py-0.5 ${
                    hover === i ? "bg-light-100 dark:bg-dark-750" : ""
                  }`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.thumbUrl}
                    alt=""
                    className={`h-8 w-8 shrink-0 rounded object-contain ${CHECKER} ${shown ? "" : "opacity-40"}`}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                      shown
                        ? "text-light-700 dark:text-dark-200"
                        : "text-light-400 dark:text-dark-500"
                    }`}
                    title={`${p.name} (depth ${p.depthMedian.toFixed(3)})`}
                  >
                    {p.name}
                  </span>
                  <button
                    type="button"
                    aria-pressed={solo === i}
                    aria-label={
                      solo === i ? `Stop soloing ${p.name}` : `Solo ${p.name}`
                    }
                    onClick={() => toggle(i, true)}
                    className={`rounded px-1 text-[10px] font-medium ${
                      solo === i
                        ? "bg-splash text-white"
                        : "text-light-400 hover:text-light-700 dark:text-dark-500 dark:hover:text-dark-200"
                    }`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    aria-pressed={shown}
                    aria-label={shown ? `Hide ${p.name}` : `Show ${p.name}`}
                    onClick={(e) => toggle(i, e.altKey)}
                    className="text-light-500 hover:text-light-700 dark:text-dark-400 dark:hover:text-dark-200"
                  >
                    {shown ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={BTN}
          disabled={!!busy}
          onClick={() => void download("all")}
        >
          {busy === "all" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          Download ZIP
        </button>
        <button
          type="button"
          className={BTN}
          disabled={!!busy}
          onClick={() => void download("psd")}
        >
          {busy === "psd" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Layers className="h-3 w-3" />
          )}
          Download PSD
        </button>
        <button
          type="button"
          className={BTN}
          disabled={!!busy}
          onClick={() => void download("parts")}
        >
          {busy === "parts" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Package className="h-3 w-3" />
          )}
          Parts only
        </button>
        <button
          type="button"
          className={BTN}
          disabled={!!busy}
          onClick={() => void download("blender")}
        >
          {busy === "blender" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Box className="h-3 w-3" />
          )}
          Export for Blender
        </button>
      </div>
      <p className="text-[11px] leading-snug text-light-500 dark:text-dark-400">
        {PSD_ORDER_NOTE}
      </p>
      <p className="text-[10px] text-light-400 dark:text-dark-500">
        {SEE_THROUGH_CREDIT}
      </p>
    </div>
  );
}
