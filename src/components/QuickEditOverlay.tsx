"use client";

/**
 * Lightbox Quick edit: paint a mask (or pick an expand / upscale preset) on
 * the image in place and queue it through the existing tool paths:
 *
 *   Inpaint  catalog inpaint tool (submitCatalogTool), else the Edit page's
 *            own inpaint route (useInpaint)
 *   Remove   (mode "erase", chip "Object Remover") remove_object region-mask
 *            action (submitActionTool), else the catalog box-remove tool
 *   Expand   the Tools page outpaint backend (resolveOutpaintTool)
 *   Upscale  the upscale action
 *
 * Geometry, brush, history and tool choice live in lib/quickEdit.ts.
 * The mask canvas keeps the SOURCE resolution as its backing store and is
 * CSS-sized to the displayed image, so the exported PNG (white = edit, black
 * = keep) needs no resampling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brush,
  Contrast,
  Eraser,
  Loader2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { GalleryImage, ImagineRun } from "@/types";
import { showToast } from "@/components/Toast";
import { catalogToolTitle, toolTitle } from "@/lib/tools/toolNames";
import { useInpaint } from "@/hooks/useInpaint";
import {
  submitActionTool,
  submitCatalogTool,
  type ToolImage,
} from "@/lib/tools/runTool";
import type { CatalogTool, EditLoraListResponse } from "@/lib/tools/toolsPage";
import {
  UpscaleModelPicker,
  useUpscaleModelPref,
} from "@/components/upscale/UpscaleModelPicker";
import { imageUpscaleContent } from "@/lib/upscale/upscalerPref";
import {
  BRUSH_DEFAULT,
  BRUSH_MAX,
  BRUSH_MIN,
  EXPAND_DEFAULT,
  EXPAND_PRESETS,
  INVERT_COMPOSITE,
  QUICK_EDIT_MODES,
  UPSCALE_CHOICES,
  brushRadiusSource,
  clampBrush,
  displayToSource,
  expandPads,
  fitContain,
  maskFromAlpha,
  maskMaybePainted,
  planQuickEdit,
  pushMaskOp,
  quickEditMode,
  stepBrush,
  strokeRaster,
  undoMaskOp,
  type ExpandPresetId,
  type MaskOp,
  type MaskStroke,
  type Point,
  type QuickEditMode,
  type Size,
  type UpscaleChoice,
} from "@/lib/quickEdit";

/** Paint color on the mask canvas (shown at reduced opacity). */
const MASK_COLOR = "rgb(255, 72, 120)";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function drawStrokePath(ctx: CanvasRenderingContext2D, op: MaskStroke) {
  const r = strokeRaster(op);
  ctx.globalCompositeOperation = r.composite;
  ctx.lineWidth = r.lineWidth;
  ctx.lineCap = r.lineCap;
  ctx.lineJoin = r.lineJoin;
  ctx.strokeStyle = MASK_COLOR;
  ctx.fillStyle = MASK_COLOR;
  const [first, ...rest] = op.points;
  if (!first) return;
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, op.radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const p of rest) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function rasterize(canvas: HTMLCanvasElement, ops: readonly MaskOp[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const op of ops) {
    if (op.kind === "invert") {
      ctx.globalCompositeOperation = INVERT_COMPOSITE;
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawStrokePath(ctx, op);
    }
  }
  ctx.restore();
}

export interface QuickEditOverlayProps {
  image: GalleryImage;
  clientId: string;
  onClose: () => void;
  /** A job was queued (run is null when the inpaint hook already added it). */
  onQueued: (run: ImagineRun | null, label: string) => void;
}

export function QuickEditOverlay({
  image,
  clientId,
  onClose,
  onQueued,
}: QuickEditOverlayProps) {
  const [mode, setMode] = useState<QuickEditMode>("inpaint");
  const [prompt, setPrompt] = useState("");
  const [brush, setBrush] = useState(BRUSH_DEFAULT);
  const [eraser, setEraser] = useState(false);
  const [ops, setOps] = useState<MaskOp[]>([]);
  const [expand, setExpand] = useState<ExpandPresetId>(EXPAND_DEFAULT);
  const [upscale, setUpscale] = useState<UpscaleChoice>("upscale_subtle");
  const [upscaleModel] = useUpscaleModelPref();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [editLoras, setEditLoras] = useState<EditLoraListResponse | null>(null);
  const [natural, setNatural] = useState<Size>({
    width: image.width,
    height: image.height,
  });
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<MaskStroke | null>(null);

  const info = quickEditMode(mode);
  const { inpaint } = useInpaint();

  // Tool catalog + edit LoRAs decide which backend runs each mode.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      getJson<{ ok: boolean; tools: CatalogTool[] }>("/api/tools"),
      getJson<EditLoraListResponse>("/api/krea2-edit-loras"),
    ]).then(([tools, loras]) => {
      if (!alive) return;
      setCatalog(tools?.ok ? tools.tools : []);
      setEditLoras(loras ?? { families: {}, loras: [] });
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Stage size -> displayed image size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Backing store = source resolution; redraw whenever history changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !(natural.width > 0 && natural.height > 0)) return;
    if (c.width !== natural.width) c.width = natural.width;
    if (c.height !== natural.height) c.height = natural.height;
    rasterize(c, ops);
  }, [ops, natural]);

  const pads =
    mode === "expand"
      ? expandPads(expand, natural.width, natural.height)
      : null;
  const frame: Size = pads
    ? { width: pads.width, height: pads.height }
    : natural;
  const frameDisplay = fitContain(stage, frame);
  const frameScale = frame.width > 0 ? frameDisplay.width / frame.width : 0;
  const imageBox = {
    left: (pads?.left ?? 0) * frameScale,
    top: (pads?.top ?? 0) * frameScale,
    width: natural.width * frameScale,
    height: natural.height * frameScale,
  };

  const pointFor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const display = { width: rect.width, height: rect.height };
    return {
      display,
      pt: displayToSource(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        display,
        natural,
      ),
    };
  };

  const moveCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = cursorRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.style.opacity = "1";
    el.style.transform = `translate(${e.clientX - rect.left - brush / 2}px, ${e.clientY - rect.top - brush / 2}px)`;
  };

  const drawLive = (from: Point | null, to: Point, stroke: MaskStroke) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    drawStrokePath(ctx, { ...stroke, points: from ? [from, to] : [to] });
    ctx.restore();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!info.paints || busy || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { display, pt } = pointFor(e);
    const stroke: MaskStroke = {
      kind: "stroke",
      erase: eraser,
      radius: brushRadiusSource(brush, display, natural),
      points: [pt],
    };
    liveRef.current = stroke;
    drawLive(null, pt, stroke);
    setError(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    moveCursor(e);
    const stroke = liveRef.current;
    if (!stroke) return;
    const { pt } = pointFor(e);
    const last = stroke.points[stroke.points.length - 1];
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.5) return;
    stroke.points.push(pt);
    drawLive(last ?? null, pt, stroke);
  };

  const endStroke = () => {
    const stroke = liveRef.current;
    liveRef.current = null;
    if (stroke) setOps((o) => pushMaskOp(o, stroke));
  };

  const undo = useCallback(() => setOps((o) => undoMaskOp(o)), []);
  const clear = () => setOps([]);
  const invert = () => setOps((o) => pushMaskOp(o, { kind: "invert" }));

  // [ / ] brush size, Cmd/Ctrl+Z undo. Escape is the lightbox's (it closes
  // this overlay before the lightbox).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (typing) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        setBrush((b) => stepBrush(b, e.key === "]" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [undo]);

  const ctx = useMemo(() => ({ catalog, editLoras }), [catalog, editLoras]);
  // Which backend would run (for the caption), ignoring missing input.
  const preview = planQuickEdit(
    { mode, prompt: prompt || "-", hasMask: true, expand, upscale },
    ctx,
  );
  const via =
    "error" in preview
      ? null
      : preview.kind === "catalog"
        ? `${
            catalogToolTitle(preview.tool.id) ?? preview.tool.label
          } · ${preview.tool.baseLabel}`
        : preview.kind === "action"
          ? toolTitle(`action:${preview.spec.id}`, preview.spec.title)
          : "Editor inpaint";
  const expandPromptShown =
    mode === "expand" &&
    !("error" in preview) &&
    preview.kind === "catalog" &&
    preview.tool.promptMode !== "none";
  const promptShown =
    info.prompt === "required" ||
    (info.prompt === "optional" && expandPromptShown);

  const exportMask = (): string | null => {
    const c = canvasRef.current;
    const g = c?.getContext("2d");
    if (!c || !g || !c.width || !c.height) return null;
    const { pixels, painted } = maskFromAlpha(
      g.getImageData(0, 0, c.width, c.height).data,
    );
    if (painted === 0) return null;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    out
      .getContext("2d")
      ?.putImageData(
        new ImageData(
          pixels as Uint8ClampedArray<ArrayBuffer>,
          c.width,
          c.height,
        ),
        0,
        0,
      );
    return out.toDataURL("image/png");
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    const mask = info.paints ? exportMask() : null;
    const plan = planQuickEdit(
      { mode, prompt, hasMask: mask !== null, expand, upscale, upscaleModel },
      ctx,
    );
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    const toolImage: ToolImage = {
      id: image.id,
      source: "gallery",
      previewUrl: image.url,
      label: image.prompt,
      width: natural.width,
      height: natural.height,
      runId: image.runId,
      jobIndex: image.jobIndex,
    };
    const onWarnings = (warnings: string[]) =>
      warnings.forEach((w) => showToast(w, "info", 8000));
    setBusy(true);
    try {
      if (plan.kind === "inpaint") {
        const res = await inpaint(plan.prompt, image.url, mask);
        if (!res.ok) throw new Error(res.error ?? "Inpaint failed");
        onQueued(null, info.label);
      } else if (plan.kind === "catalog") {
        const run = await submitCatalogTool({
          fetchImpl: fetch,
          tool: plan.tool,
          settings: plan.settings,
          images: [toolImage],
          mask: plan.tool.needsMask ? mask : null,
          clientId,
          onWarnings,
        });
        onQueued(run, info.label);
      } else {
        const run = await submitActionTool({
          fetchImpl: fetch,
          spec: plan.spec,
          settings: plan.settings,
          editLoras,
          image: toolImage,
          secondImage: null,
          clientId,
          onWarnings,
          ...(plan.region && mask ? { subjectMasks: [mask], mask } : {}),
        });
        onQueued(run, info.label);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const painted = maskMaybePainted(ops);
  const blocked =
    busy ||
    (info.needsMask && !painted) ||
    (info.prompt === "required" && !prompt.trim());

  const chip = (active: boolean) =>
    `h-7 shrink-0 rounded-full px-3 text-xs font-medium transition-colors ${
      active
        ? "bg-[var(--text-primary)] text-[var(--bg-primary)]"
        : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    }`;
  const iconBtn =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-quick-edit
      role="group"
      aria-label="Quick edit"
      className="absolute inset-0 z-30 flex flex-col gap-2 bg-[var(--bg-primary)] px-3 pb-3 pt-2 outline-none md:px-6 md:pb-5 md:pt-4"
    >
      {/* Mode chips + close */}
      <div className="flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto noScrollbar"
          role="radiogroup"
          aria-label="Quick edit mode"
        >
          {QUICK_EDIT_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => {
                setMode(m.id);
                setError(null);
              }}
              className={chip(mode === m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className={iconBtn}
          aria-label="Close quick edit"
          title="Close quick edit (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {info.hint}
        {via && <span className="opacity-70"> · {via}</span>}
      </p>

      {/* Stage: the image with the mask canvas (or the expand frame) */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center"
      >
        <div
          className="relative"
          style={{ width: frameDisplay.width, height: frameDisplay.height }}
        >
          {pads && (
            <div
              className="absolute inset-0 rounded-md border border-dashed border-[var(--border-secondary)]"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(45deg, transparent 0 6px, color-mix(in srgb, var(--text-muted) 14%, transparent) 6px 12px)",
              }}
              aria-hidden
            />
          )}
          <div
            className="absolute overflow-hidden rounded-md"
            style={{
              left: imageBox.left,
              top: imageBox.top,
              width: imageBox.width,
              height: imageBox.height,
            }}
          >
            <img
              src={image.url}
              alt={image.prompt}
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth > 0 && el.naturalHeight > 0)
                  setNatural({
                    width: el.naturalWidth,
                    height: el.naturalHeight,
                  });
              }}
              className="pointer-events-none h-full w-full select-none object-fill"
            />
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={() => {
                if (cursorRef.current) cursorRef.current.style.opacity = "0";
              }}
              aria-label="Mask painting area"
              className={`absolute inset-0 h-full w-full touch-none opacity-55 ${
                info.paints ? "cursor-none" : "pointer-events-none hidden"
              }`}
            />
            {info.paints && (
              <div
                ref={cursorRef}
                aria-hidden
                className="pointer-events-none absolute left-0 top-0 rounded-full border border-white opacity-0 mix-blend-difference"
                style={{ width: brush, height: brush }}
              />
            )}
          </div>
        </div>
        {pads && (
          <span className="absolute bottom-1 right-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white/85">
            {natural.width}×{natural.height} → {pads.width}×{pads.height}
          </span>
        )}
      </div>

      {/* Mask tools */}
      {info.paints && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setEraser(false)}
            className={iconBtn}
            aria-pressed={!eraser}
            aria-label="Brush"
            title="Brush"
            style={
              !eraser
                ? {
                    background: "var(--bg-hover)",
                    color: "var(--text-primary)",
                  }
                : undefined
            }
          >
            <Brush className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setEraser(true)}
            className={iconBtn}
            aria-pressed={eraser}
            aria-label="Eraser"
            title="Eraser"
            style={
              eraser
                ? {
                    background: "var(--bg-hover)",
                    color: "var(--text-primary)",
                  }
                : undefined
            }
          >
            <Eraser className="h-4 w-4" />
          </button>
          <label className="flex min-w-[8rem] flex-1 items-center gap-2 px-1 text-xs text-[var(--text-muted)] md:max-w-[14rem]">
            <span className="sr-only">Brush size</span>
            <input
              type="range"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              value={brush}
              onChange={(e) => setBrush(clampBrush(Number(e.target.value)))}
              className="w-full accent-[var(--accent-primary)]"
              title="Brush size ([ and ])"
            />
            <span className="w-7 text-right tabular-nums">{brush}</span>
          </label>
          <button
            type="button"
            onClick={undo}
            disabled={ops.length === 0}
            className={iconBtn}
            aria-label="Undo stroke"
            title="Undo (Cmd/Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={invert}
            className={iconBtn}
            aria-label="Invert mask"
            title="Invert mask"
          >
            <Contrast className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={ops.length === 0}
            className={iconBtn}
            aria-label="Clear mask"
            title="Clear mask"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}

      {mode === "expand" && (
        <div
          className="flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-label="Expand by"
        >
          {EXPAND_PRESETS.map((p) => {
            const adds =
              expandPads(p.id, natural.width, natural.height) !== null;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={expand === p.id}
                disabled={!adds}
                title={adds ? undefined : "The image already has this shape"}
                onClick={() => setExpand(p.id)}
                className={`${chip(expand === p.id)} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {p.kind === "aspect" ? `To ${p.label}` : p.label}
              </button>
            );
          })}
        </div>
      )}

      {mode === "upscale" && (
        <div
          className="flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-label="Upscale style"
        >
          {UPSCALE_CHOICES.map((u) => (
            <button
              key={u.id}
              type="button"
              role="radio"
              aria-checked={upscale === u.id}
              onClick={() => setUpscale(u.id)}
              className={chip(upscale === u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>
      )}
      {mode === "upscale" && (
        <UpscaleModelPicker
          compact
          mode={upscale}
          content={imageUpscaleContent(image)}
        />
      )}

      {/* Prompt + submit */}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {promptShown ? (
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={500}
            placeholder={
              mode === "inpaint"
                ? "What goes in the painted area?"
                : "Optional: what the new edges show"
            }
            aria-label="Quick edit prompt"
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] focus:outline-none"
          />
        ) : (
          <div className="flex-1" />
        )}
        <button
          type="submit"
          disabled={blocked}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-4 text-sm font-medium text-white transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {info.action}
        </button>
      </form>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default QuickEditOverlay;
