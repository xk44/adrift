"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Check, X } from "lucide-react";
import {
  CROP_ASPECTS,
  CROP_HANDLES,
  cropOutputSize,
  isFullCrop,
  moveCropRect,
  resizeCropRect,
  screenDeltaToSource,
  type CropAspectId,
  type CropHandle,
  type CropRect,
  type CropSize,
} from "@/lib/editorCrop";

const HANDLE_POS: Record<CropHandle, string> = {
  nw: "left-0 top-0 cursor-nwse-resize",
  n: "left-1/2 top-0 cursor-ns-resize",
  ne: "left-full top-0 cursor-nesw-resize",
  e: "left-full top-1/2 cursor-ew-resize",
  se: "left-full top-full cursor-nwse-resize",
  s: "left-1/2 top-full cursor-ns-resize",
  sw: "left-0 top-full cursor-nesw-resize",
  w: "left-0 top-1/2 cursor-ew-resize",
};

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

interface OverlayProps {
  img: CropSize;
  /** On-screen size of the image (fit × zoom). */
  display: CropSize;
  rect: CropRect;
  ratio: number | null;
  onChange: (rect: CropRect) => void;
}

/** Crop frame over the image: drag inside to move, handles to resize. */
export function EditorCropOverlay({
  img,
  display,
  rect,
  ratio,
  onChange,
}: OverlayProps) {
  const dragRef = useRef<{
    id: number;
    handle: CropHandle | "move";
    x: number;
    y: number;
    start: CropRect;
  } | null>(null);

  const apply = (
    handle: CropHandle | "move",
    start: CropRect,
    sdx: number,
    sdy: number,
  ) => {
    const { dx, dy } = screenDeltaToSource(sdx, sdy, display, img);
    onChange(
      handle === "move"
        ? moveCropRect(start, dx, dy, img)
        : resizeCropRect(start, handle, dx, dy, img, ratio),
    );
  };

  const onDown = (handle: CropHandle | "move") => (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    dragRef.current = {
      id: e.pointerId,
      handle,
      x: e.clientX,
      y: e.clientY,
      start: rect,
    };
  };

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    apply(d.handle, d.start, e.clientX - d.x, e.clientY - d.y);
  };

  const onUp = (e: PointerEvent) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  // Arrow keys nudge one screen pixel (Shift: ten).
  const onKey = (handle: CropHandle | "move") => (e: KeyboardEvent) => {
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 10 : 1;
    apply(handle, rect, dir[0] * step, dir[1] * step);
  };

  const sx = display.width / img.width;
  const sy = display.height / img.height;
  const pointer = {
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    onLostPointerCapture: onUp,
  };

  return (
    <div
      className="absolute inset-0 overflow-hidden rounded-lg"
      data-testid="editor-crop-overlay"
    >
      <div
        className="absolute ring-1 ring-white/90"
        style={{
          left: rect.x * sx,
          top: rect.y * sy,
          width: rect.w * sx,
          height: rect.h * sy,
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Crop area. Drag or use the arrow keys to move it."
          data-crop-handle="move"
          className="absolute inset-0 grid cursor-move touch-none grid-cols-3 grid-rows-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          onPointerDown={onDown("move")}
          onKeyDown={onKey("move")}
          {...pointer}
        >
          {Array.from({ length: 9 }, (_, i) => (
            <div
              key={i}
              className="pointer-events-none border-[0.5px] border-white/25"
            />
          ))}
        </div>
        {CROP_HANDLES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-label={`Resize crop from the ${label}`}
            data-crop-handle={id}
            className={`absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center outline-none focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-[var(--accent-primary)] ${HANDLE_POS[id]}`}
            onPointerDown={onDown(id)}
            onKeyDown={onKey(id)}
            {...pointer}
          >
            <span className="h-2.5 w-2.5 rounded-sm border border-black/40 bg-white shadow" />
          </button>
        ))}
      </div>
    </div>
  );
}

interface BarProps {
  img: CropSize;
  rect: CropRect;
  aspect: CropAspectId;
  busy?: boolean;
  onAspect: (id: CropAspectId) => void;
  onApply: () => void;
  onCancel: () => void;
}

/** Aspect preset, live output size and Apply / Cancel. */
export function EditorCropBar({
  img,
  rect,
  aspect,
  busy,
  onAspect,
  onApply,
  onCancel,
}: BarProps) {
  const out = cropOutputSize(rect, img);
  return (
    <div
      role="group"
      aria-label="Crop"
      data-testid="editor-crop-bar"
      className="absolute z-10 right-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1.5 text-[var(--text-secondary)] shadow"
    >
      <select
        aria-label="Aspect ratio"
        value={aspect}
        onChange={(e) => onAspect(e.target.value as CropAspectId)}
        className="input h-8 w-auto py-0 text-xs"
      >
        {CROP_ASPECTS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <span
        data-testid="editor-crop-size"
        className="min-w-[6.5rem] px-1 text-center font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
        title="Size of the cropped image"
      >
        {out.width} × {out.height} px
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel crop (Esc)"
        title="Cancel (Esc)"
        className="btn-ghost btn-icon"
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onApply}
        disabled={busy || isFullCrop(rect, img)}
        aria-label="Apply crop (Enter)"
        title="Apply (Enter)"
        className="btn btn-primary flex h-8 items-center gap-1 px-2.5 text-xs disabled:opacity-40"
      >
        <Check className="h-3.5 w-3.5" />
        Apply
      </button>
    </div>
  );
}
