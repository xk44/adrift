"use client";

import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  type PointerEvent,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { useEditorStore } from "@/store/editorStore";
import { useUIStore } from "@/store";
import { showToast } from "@/components/Toast";
import { applyEditorMaskOp, mergeSmartMaskPixels } from "@/lib/editorMask";
import { isTypingTarget } from "@/lib/ui/typingTarget";
import { smartSelectFailureMessage } from "@/lib/ui/editErrors";
import { fitCanvasDisplay, nextBrushSize } from "./editorCanvasLayout";
import { requestSmartMask, type SmartPoint } from "./editorSmartSelect";
import { EditorCropBar, EditorCropOverlay } from "./EditorCropOverlay";
import {
  cropAspectRatio,
  cropPixelRect,
  fitAspectRect,
  fullCropRect,
  isFullCrop,
  type CropAspectId,
  type CropRect,
} from "@/lib/editorCrop";
import {
  EDITOR_CANVAS_LABEL,
  editorCropKey,
  editorKeyAction,
  nextZoom,
  ZOOM_STEPS,
  type EditorKeyAction,
} from "./editorKeys";

interface Point {
  x: number;
  y: number;
}

type LoadState = "loading" | "ready" | "error";
type HistoryEntry = ReturnType<
  typeof useEditorStore.getState
>["history"][number];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = src;
  });
}

export { EDITOR_CANVAS_LABEL };

/** Keys the canvas ignores: typing, an open dialog, or the lightbox on top. */
function ignoreEditorKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || isTypingTarget(e.target)) return true;
  const el = e.target as HTMLElement | null;
  if (el?.closest?.('[role="dialog"],[aria-modal="true"]')) return true;
  return Boolean(useUIStore.getState().lightbox);
}

export function EditorCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);

  const sourceImage = useEditorStore((s) => s.sourceImage);
  const sourceDimensions = useEditorStore((s) => s.sourceDimensions);
  const setSourceDimensions = useEditorStore((s) => s.setSourceDimensions);
  const clearSourceImage = useEditorStore((s) => s.clearSourceImage);
  const activeTool = useEditorStore((s) => s.activeTool);
  const paintMode = useEditorStore((s) => s.paintMode);
  const brushSize = useEditorStore((s) => s.brushSize);
  const showMask = useEditorStore((s) => s.showMask);
  const maskOpacity = useEditorStore((s) => s.maskOpacity);
  const setMaskCanvas = useEditorStore((s) => s.setMaskCanvas);
  const saveToHistory = useEditorStore((s) => s.saveToHistory);
  const history = useEditorStore((s) => s.history);
  const historyIndex = useEditorStore((s) => s.historyIndex);
  const isProcessing = useEditorStore((s) => s.isProcessing);
  const processingMessage = useEditorStore((s) => s.processingMessage);

  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [cursorPos, setCursorPos] = useState<Point | null>(null);
  const [smartBusy, setSmartBusy] = useState(false);
  // 1 = fit the stage; larger zooms scroll (pan) inside the stage.
  const [zoom, setZoom] = useState(1);
  // Where the view was centered before a zoom, as a 0..1 fraction.
  const zoomCenterRef = useRef<{ x: number; y: number } | null>(null);
  // Brief centered brush ring after a size change with no cursor on the canvas.
  const [sizePreview, setSizePreview] = useState(false);
  const firstBrushRef = useRef(true);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Active stroke (pointer id + last point); refs so moves don't re-render.
  const strokeRef = useRef<{ id: number; last: Point } | null>(null);
  // History entry this canvas just wrote: its index change is not an undo.
  const ownEntryRef = useRef<HistoryEntry | null>(null);
  // Bumped by every local mask change so a slower async restore can't
  // overwrite newer paint.
  const maskSeqRef = useRef(0);
  // Smart select session: clicks so far + the mask before the first click.
  const smartRef = useRef<{
    include: SmartPoint[];
    exclude: SmartPoint[];
    base: Uint8ClampedArray | null;
  } | null>(null);
  const smartSeqRef = useRef(0);
  const uploadedRef = useRef<{ url: string; ref: string } | null>(null);
  // Crop session (frame in source pixels); null outside the crop tool.
  const [crop, setCrop] = useState<{
    rect: CropRect;
    aspect: CropAspectId;
  } | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const prevToolRef = useRef<typeof activeTool>("paint");

  const resetSmartSession = useCallback(() => {
    smartRef.current = null;
    smartSeqRef.current++;
    setSmartBusy(false);
  }, []);

  /** Snapshot the mask into undo history (and remember it as ours). */
  const commit = useCallback(() => {
    saveToHistory();
    const s = useEditorStore.getState();
    ownEntryRef.current = s.history[s.historyIndex] ?? null;
  }, [saveToHistory]);

  /** Paint a history entry's mask back onto the mask canvas. */
  const restoreMask = useCallback(async (entry: HistoryEntry | undefined) => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    const seq = ++maskSeqRef.current;
    const data = entry?.maskData;
    let img: HTMLImageElement | null = null;
    if (data) {
      try {
        img = await loadImage(data);
      } catch {
        return;
      }
    }
    if (seq !== maskSeqRef.current) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }, []);

  // Stage size, re-measured on every resize (first render has no layout).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sourceImage]);

  // Load image and set dimensions
  useEffect(() => {
    if (!sourceImage) return;

    // A slow earlier load must not overwrite a newer image's canvas/dimensions
    let cancelled = false;
    setLoadState("loading");
    resetSmartSession();
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      setSourceDimensions({
        width: img.width,
        height: img.height,
        originalWidth: img.width,
        originalHeight: img.height,
      });

      if (canvasRef.current && maskCanvasRef.current) {
        canvasRef.current.width = img.width;
        canvasRef.current.height = img.height;
        maskCanvasRef.current.width = img.width;
        maskCanvasRef.current.height = img.height;

        const ctx = canvasRef.current.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0);

        // Resizing cleared the mask; bring back this version's mask (undo
        // to an earlier canvas version), else start empty.
        maskSeqRef.current++;
        setMaskCanvas(maskCanvasRef.current);
        const st = useEditorStore.getState();
        const entry = st.history[st.historyIndex];
        if (entry && (entry.sourceImage ?? sourceImage) === sourceImage) {
          void restoreMask(entry);
        } else if (st.history.length === 0) {
          // Baseline so the first stroke can be undone.
          commit();
        }
      }
      setLoadState("ready");
    };
    img.onerror = () => {
      if (cancelled) return;
      setLoadState("error");
    };
    img.src = sourceImage;
    return () => {
      cancelled = true;
    };
  }, [
    sourceImage,
    reloadKey,
    setSourceDimensions,
    setMaskCanvas,
    restoreMask,
    commit,
    resetSmartSession,
  ]);

  // Undo/redo (toolbar or keys): show that entry's mask.
  useEffect(() => {
    const entry = history[historyIndex];
    if (!entry || entry === ownEntryRef.current) return;
    ownEntryRef.current = entry;
    if ((entry.sourceImage ?? sourceImage) !== sourceImage) return; // reload restores
    resetSmartSession();
    void restoreMask(entry);
  }, [history, historyIndex, sourceImage, restoreMask, resetSmartSession]);

  // Leaving Smart Select ends its session.
  useEffect(() => {
    if (activeTool !== "smartSelect") resetSmartSession();
    if (activeTool !== "crop") prevToolRef.current = activeTool;
  }, [activeTool, resetSmartSession]);

  // Entering crop (or a new image while cropping) starts from the full frame.
  useEffect(() => {
    setCrop(
      activeTool === "crop" && loadState === "ready" && sourceDimensions
        ? { rect: fullCropRect(sourceDimensions), aspect: "free" }
        : null,
    );
  }, [activeTool, loadState, sourceDimensions]);

  const exitCrop = useCallback(() => {
    useEditorStore.getState().setActiveTool(prevToolRef.current);
  }, []);

  const setCropAspect = useCallback(
    (aspect: CropAspectId) => {
      if (!sourceDimensions) return;
      setCrop((c) =>
        c && aspect === "free"
          ? { ...c, aspect }
          : {
              aspect,
              rect: fitAspectRect(
                sourceDimensions,
                cropAspectRatio(aspect, sourceDimensions),
              ),
            },
      );
    },
    [sourceDimensions],
  );

  const applyCrop = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!crop || !sourceDimensions || !canvas || cropBusy) return;
    if (isFullCrop(crop.rect, sourceDimensions)) return exitCrop();
    const p = cropPixelRect(crop.rect, sourceDimensions);
    const cut = (src: HTMLCanvasElement) => {
      const out = document.createElement("canvas");
      out.width = p.w;
      out.height = p.h;
      out.getContext("2d")?.drawImage(src, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
      return out;
    };
    setCropBusy(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        cut(canvas).toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("Could not encode the crop");
      const mask = maskCanvasRef.current;
      const maskData = mask && mask.width > 0 ? cut(mask).toDataURL() : null;
      useEditorStore.getState().applyCrop(URL.createObjectURL(blob), maskData);
      exitCrop();
    } catch (e) {
      showToast(
        `Crop failed: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setCropBusy(false);
    }
  }, [crop, sourceDimensions, cropBusy, exitCrop]);

  const getCanvasPoint = useCallback(
    (e: { clientX: number; clientY: number }): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
      };
    },
    [],
  );

  const drawOnMask = useCallback(
    (from: Point, to: Point) => {
      const maskCtx = maskCanvasRef.current?.getContext("2d");
      if (!maskCtx) return;
      maskCtx.globalCompositeOperation =
        paintMode === "erase" ? "source-over" : "destination-out";
      maskCtx.strokeStyle = paintMode === "erase" ? "#ff0000" : "#000000";
      maskCtx.lineWidth = brushSize;
      maskCtx.lineCap = "round";
      maskCtx.lineJoin = "round";
      maskCtx.beginPath();
      maskCtx.moveTo(from.x, from.y);
      maskCtx.lineTo(to.x, to.y);
      maskCtx.stroke();
    },
    [paintMode, brushSize],
  );

  const runSmartSelect = useCallback(
    async (point: Point, exclude: boolean) => {
      const canvas = maskCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!sourceImage || !canvas || !ctx || canvas.width === 0) return;
      if (!smartRef.current) {
        smartRef.current = {
          include: [],
          exclude: [],
          base: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      }
      const session = smartRef.current;
      const pt = { x: Math.round(point.x), y: Math.round(point.y) };
      (exclude ? session.exclude : session.include).push(pt);
      if (session.include.length === 0) {
        showToast(
          "Click the subject first, then Shift-click to exclude.",
          "info",
        );
        session.exclude.pop();
        return;
      }
      const seq = ++smartSeqRef.current;
      const url = sourceImage;
      setSmartBusy(true);
      try {
        const res = await requestSmartMask({
          imageUrl: url,
          include: [...session.include],
          exclude: [...session.exclude],
          width: canvas.width,
          height: canvas.height,
          cachedRef:
            uploadedRef.current?.url === url ? uploadedRef.current.ref : null,
        });
        if (res.ref) uploadedRef.current = { url, ref: res.ref };
        const maskImg = await loadImage(res.mask);
        if (seq !== smartSeqRef.current || smartRef.current !== session) return;
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const tctx = tmp.getContext("2d");
        if (!tctx) return;
        tctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        const sam = tctx.getImageData(0, 0, canvas.width, canvas.height);
        const merged = mergeSmartMaskPixels(session.base, sam.data);
        maskSeqRef.current++;
        ctx.globalCompositeOperation = "source-over";
        ctx.putImageData(
          new ImageData(
            merged as Uint8ClampedArray<ArrayBuffer>,
            canvas.width,
            canvas.height,
          ),
          0,
          0,
        );
        commit();
      } catch (e) {
        if (seq !== smartSeqRef.current) return;
        // Drop the failed point so the next click doesn't resend it.
        (exclude ? session.exclude : session.include).pop();
        showToast(smartSelectFailureMessage(e), "error");
      } finally {
        if (seq === smartSeqRef.current) setSmartBusy(false);
      }
    },
    [sourceImage, commit],
  );

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (loadState !== "ready") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const point = getCanvasPoint(e);
      if (!point) return;
      // preventDefault below blocks the default focus; keys need it.
      e.currentTarget.focus({ preventScroll: true });
      if (activeTool === "smartSelect") {
        e.preventDefault();
        void runSmartSelect(point, e.shiftKey || e.altKey);
        return;
      }
      if (activeTool !== "paint" || strokeRef.current) return;
      e.preventDefault();
      // Keep receiving moves when the pointer leaves the image mid-stroke.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      resetSmartSession();
      maskSeqRef.current++;
      strokeRef.current = { id: e.pointerId, last: point };
      drawOnMask(point, point);
    },
    [
      loadState,
      activeTool,
      getCanvasPoint,
      runSmartSelect,
      resetSmartSession,
      drawOnMask,
    ],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (activeTool !== "paint") return;
      const point = getCanvasPoint(e);
      if (e.pointerType !== "touch") setCursorPos(point);
      const stroke = strokeRef.current;
      if (!stroke || stroke.id !== e.pointerId || !point) return;
      drawOnMask(stroke.last, point);
      stroke.last = point;
    },
    [activeTool, getCanvasPoint, drawOnMask],
  );

  const endStroke = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const stroke = strokeRef.current;
      if (!stroke || stroke.id !== e.pointerId) return;
      strokeRef.current = null;
      commit();
    },
    [commit],
  );

  /** Change zoom, keeping the point at the middle of the view in place. */
  const zoomTo = useCallback((next: number) => {
    const el = containerRef.current;
    if (el && el.scrollWidth > 0 && el.scrollHeight > 0) {
      zoomCenterRef.current = {
        x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
        y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
      };
    }
    setZoom(next);
  }, []);

  const runKeyAction = useCallback(
    (a: EditorKeyAction) => {
      const st = useEditorStore.getState();
      const maskOp = (op: "clear" | "fill" | "invert") => {
        resetSmartSession();
        maskSeqRef.current++;
        if (applyEditorMaskOp(maskCanvasRef.current, op)) commit();
      };
      switch (a.kind) {
        case "undo":
          return st.undo();
        case "redo":
          return st.redo();
        case "brush":
          return st.setBrushSize(nextBrushSize(st.brushSize, a.dir));
        case "tool":
          return st.setActiveTool(a.tool);
        case "swapPaintMode":
          st.setActiveTool("paint");
          return st.setPaintMode(st.paintMode === "erase" ? "restore" : "erase");
        case "toggleMask":
          return st.setShowMask(!st.showMask);
        case "mask":
          return maskOp(a.op);
        case "zoom":
          return zoomTo(nextZoom(zoomRef.current, a.dir));
        case "zoomFit":
          return zoomTo(1);
      }
    },
    [commit, resetSmartSession, zoomTo],
  );

  // Shortcuts work anywhere on the Edit page (not only with the canvas
  // focused), except while typing or with a dialog / the lightbox on top.
  useEffect(() => {
    if (!sourceImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (ignoreEditorKey(e)) return;
      const cropKey = crop ? editorCropKey(e) : null;
      if (cropKey) {
        // Enter on a toolbar button presses it; on the crop frame it applies.
        const el = e.target as HTMLElement | null;
        if (cropKey === "apply" && el?.closest?.("button,a,select") && !el.closest("[data-crop-handle]")) return;
        e.preventDefault();
        if (cropKey === "apply") void applyCrop();
        else exitCrop();
        return;
      }
      const action = editorKeyAction(e);
      if (!action) return;
      e.preventDefault();
      runKeyAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourceImage, runKeyAction, crop, applyCrop, exitCrop]);

  // New image: back to fit.
  useEffect(() => {
    setZoom(1);
  }, [sourceImage]);

  // After a zoom, scroll so the old view center stays centered.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const c = zoomCenterRef.current;
    zoomCenterRef.current = null;
    if (!el || !c) return;
    el.scrollLeft = c.x * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = c.y * el.scrollHeight - el.clientHeight / 2;
  }, [zoom]);

  // Pinch / Ctrl+wheel zooms the canvas instead of the page.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(nextZoom(zoomRef.current, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [sourceImage, zoomTo]);

  // Show the new brush size in the middle of the image for a moment.
  useEffect(() => {
    if (firstBrushRef.current) {
      firstBrushRef.current = false;
      return;
    }
    setSizePreview(true);
    const t = setTimeout(() => setSizePreview(false), 700);
    return () => clearTimeout(t);
  }, [brushSize]);

  const fit = fitCanvasDisplay(stage, sourceDimensions);
  const displayDims = {
    width: fit.width * zoom,
    height: fit.height * zoom,
    scale: fit.scale * zoom,
  };
  const zoomPercent = Math.round(displayDims.scale * 100);
  const brushPx = brushSize * displayDims.scale;
  const brushRing =
    activeTool === "paint" && loadState === "ready"
      ? cursorPos
        ? { x: cursorPos.x * displayDims.scale, y: cursorPos.y * displayDims.scale }
        : sizePreview
          ? { x: displayDims.width / 2, y: displayDims.height / 2 }
          : null
      : null;

  if (!sourceImage) {
    return null;
  }

  const showHint =
    loadState === "ready" &&
    activeTool === "paint" &&
    historyIndex <= 0 &&
    !isProcessing;

  return (
    <div className="flex-1 min-h-0 relative flex flex-col bg-[var(--bg-primary)]">
      <div
        ref={containerRef}
        data-testid="editor-canvas-stage"
        className="flex-1 min-h-0 flex overflow-auto"
      >
        {/* m-auto (not justify-center) keeps a zoomed image fully scrollable */}
        <div
          className={`relative m-auto shrink-0 ${loadState === "error" ? "invisible" : ""}`}
          style={{ width: displayDims.width, height: displayDims.height }}
        >
          {/* Main image canvas */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full rounded-lg shadow-2xl"
          />

          {/* Mask overlay: plain blend so the selection reads on dark images */}
          <canvas
            ref={maskCanvasRef}
            data-testid="editor-mask-overlay"
            className="absolute inset-0 w-full h-full rounded-lg pointer-events-none"
            style={{ opacity: showMask ? maskOpacity : 0 }}
          />

          {/* Interactive overlay: pointer events cover mouse, touch and pen */}
          <div
            role="application"
            aria-label={EDITOR_CANVAS_LABEL}
            aria-busy={smartBusy || undefined}
            tabIndex={0}
            data-testid="editor-canvas-surface"
            className="absolute inset-0 w-full h-full rounded-lg touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{
              cursor:
                activeTool === "paint"
                  ? "none"
                  : activeTool === "smartSelect"
                    ? smartBusy
                      ? "progress"
                      : "crosshair"
                    : "default",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onLostPointerCapture={endStroke}
            onPointerLeave={() => setCursorPos(null)}
          />

          {crop && sourceDimensions && (
            <EditorCropOverlay
              img={sourceDimensions}
              display={displayDims}
              rect={crop.rect}
              ratio={cropAspectRatio(crop.aspect, sourceDimensions)}
              onChange={(rect) => setCrop((c) => (c ? { ...c, rect } : c))}
            />
          )}

          {/* Brush ring: follows the pointer, or shows a new size centered */}
          {brushRing && (
            <div
              data-testid="editor-brush-ring"
              className="pointer-events-none absolute rounded-full border-2 border-white shadow-lg"
              style={{
                width: brushPx,
                height: brushPx,
                left: brushRing.x - brushPx / 2,
                top: brushRing.y - brushPx / 2,
                backgroundColor:
                  paintMode === "erase"
                    ? "rgba(255, 0, 0, 0.3)"
                    : "rgba(0, 255, 0, 0.3)",
              }}
            />
          )}
        </div>
      </div>

      {loadState === "error" && (
        <div
          role="alert"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-sm text-[var(--text-primary)]">
            Couldn&apos;t load this image.
          </p>
          <p className="text-xs text-[var(--text-secondary)]">
            The file may have moved, or the server is unreachable.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary text-sm"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={clearSourceImage}
            >
              Choose another image
            </button>
          </div>
        </div>
      )}
      {loadState === "loading" && (
        <p
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-[var(--text-secondary)]"
          aria-live="polite"
        >
          Loading image…
        </p>
      )}

      {/* Status chips: smart select and a running edit */}
      <div
        className="pointer-events-none absolute z-10 left-2 top-2 flex flex-col items-start gap-1"
        aria-live="polite"
      >
        {smartBusy && (
          <span className="rounded-md bg-black/70 px-2 py-1 text-xs text-white">
            Selecting…
          </span>
        )}
        {isProcessing && (
          <span
            data-testid="editor-processing"
            className="flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 text-xs text-white"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent-primary)]" />
            {processingMessage || "Working…"}
          </span>
        )}
      </div>

      {crop && sourceDimensions && (
        <EditorCropBar
          img={sourceDimensions}
          rect={crop.rect}
          aspect={crop.aspect}
          busy={cropBusy}
          onAspect={setCropAspect}
          onApply={() => void applyCrop()}
          onCancel={exitCrop}
        />
      )}

      {showHint && (
        <p
          data-testid="editor-canvas-hint"
          className="pointer-events-none absolute z-10 bottom-2 left-1/2 hidden sm:block max-w-[calc(100%-7rem)] -translate-x-1/2 rounded-md bg-black/70 px-2.5 py-1 text-center text-xs text-white"
        >
          Paint over what you want to change, then describe it above. Press ?
          for shortcuts.
        </p>
      )}

      {loadState === "ready" && (
        <div
          role="group"
          aria-label="Zoom"
          className="absolute z-10 bottom-2 right-2 flex items-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] shadow"
        >
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={zoom <= ZOOM_STEPS[0]}
            onClick={() => zoomTo(nextZoom(zoom, -1))}
            className="flex h-8 w-8 items-center justify-center rounded-l-lg hover:bg-[var(--bg-hover)] disabled:opacity-35"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span
            data-testid="editor-zoom-level"
            className="min-w-[3rem] text-center font-mono text-[11px] tabular-nums"
            title="Shown size vs. the image's real pixels"
          >
            {zoomPercent}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => zoomTo(nextZoom(zoom, 1))}
            className="flex h-8 w-8 items-center justify-center hover:bg-[var(--bg-hover)] disabled:opacity-35"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Fit to screen"
            title="Fit to screen (0)"
            disabled={zoom === 1}
            onClick={() => zoomTo(1)}
            className="flex h-8 w-8 items-center justify-center rounded-r-lg border-l border-[var(--border-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-35"
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export default EditorCanvas;
