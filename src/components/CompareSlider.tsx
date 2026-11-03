"use client";

import { useCallback, useRef, useState } from "react";

import { stepPercent, wipePercent } from "@/lib/compareSlider";

interface CompareSliderProps {
  leftUrl: string;
  rightUrl: string;
  leftAlt?: string;
  rightAlt?: string;
  leftLabel?: string;
  rightLabel?: string;
}

/**
 * Mouse/touch-driven wipe slider for comparing two images (openmodeldb-style).
 * Both images render in the same letterboxed frame; the right image is clipped
 * from the left by the divider. Drag anywhere, arrow keys on the handle,
 * double-click to reset to 50%.
 */
export function CompareSlider({
  leftUrl,
  rightUrl,
  leftAlt = "Left image",
  rightAlt = "Right image",
  leftLabel = "A",
  rightLabel = "B",
}: CompareSliderProps) {
  const [pct, setPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const updateFromPointer = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPct(wipePercent(clientX, rect.left, rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button / touch / pen only.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromPointer(e.clientX);
    },
    [updateFromPointer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      updateFromPointer(e.clientX);
    },
    [updateFromPointer],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    setPct((prev) => stepPercent(prev, e.key));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden rounded-lg"
      style={{ touchAction: "none", cursor: "col-resize" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setPct(50)}
    >
      {/* Left (base) image */}
      <img
        src={leftUrl}
        alt={leftAlt}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {/* Right image, clipped from the left by the divider */}
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${pct}%)` }}
      >
        <img
          src={rightUrl}
          alt={rightAlt}
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
        />
      </div>

      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
        {leftLabel}
      </span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
        {rightLabel}
      </span>

      {/* Divider + handle */}
      <div
        className="pointer-events-none absolute inset-y-0 z-10"
        style={{ left: `${pct}%` }}
      >
        <div className="absolute inset-y-0 -translate-x-1/2 w-0.5 bg-white/90 shadow-[0_0_6px_rgba(0,0,0,0.6)]" />
        <div
          role="slider"
          aria-label="Compare position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="pointer-events-auto absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-lg outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          style={{ cursor: "col-resize" }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M4.5 2.5 0.5 7l4 4.5M9.5 2.5 13.5 7l-4 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
