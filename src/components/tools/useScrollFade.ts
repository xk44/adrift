"use client";

import { useEffect, useState } from "react";

/** Which horizontal edges of a scroller still hide content. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

/** 1px slack so sub-pixel layouts don't leave a fade at a reached edge. */
export function scrollEdges(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): ScrollEdges {
  const max = el.scrollWidth - el.clientWidth;
  return {
    start: el.scrollLeft > 1,
    end: max > 1 && el.scrollLeft < max - 1,
  };
}

/**
 * Edge-fade mask for a horizontal scroller: a soft 24px fade only on the
 * side(s) that still have content to scroll to (`width` px, default 24).
 */
export function fadeMaskStyle(
  edges: ScrollEdges,
  width = 24,
): React.CSSProperties {
  if (!edges.start && !edges.end) return {};
  const from = edges.start ? `transparent 0, #000 ${width}px` : "#000 0";
  const to = edges.end
    ? `#000 calc(100% - ${width}px), transparent 100%`
    : "#000 100%";
  const mask = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** Minimal element surface the fade listens to (real DOM or a test fake). */
export interface ScrollFadeTarget {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  children: ArrayLike<unknown>;
  addEventListener(type: "scroll", fn: () => void, opts?: unknown): void;
  removeEventListener(type: "scroll", fn: () => void): void;
}

/**
 * Wire scroll + resize tracking onto one scroller element and return the
 * teardown. Children are (re)observed whenever the child list changes, so
 * chips that mount later (or change width after counts load) still update
 * the fade.
 */
export function attachScrollFade(
  el: ScrollFadeTarget,
  update: () => void,
): () => void {
  update();
  el.addEventListener("scroll", update, { passive: true });
  const ro =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
  const observeAll = () => {
    if (!ro) return;
    ro.disconnect();
    ro.observe(el as unknown as Element);
    Array.from(el.children).forEach((c) => ro.observe(c as Element));
  };
  observeAll();
  const mo =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          observeAll();
          update();
        })
      : null;
  mo?.observe(el as unknown as Node, { childList: true });
  return () => {
    el.removeEventListener("scroll", update);
    ro?.disconnect();
    mo?.disconnect();
  };
}

const NO_EDGES: ScrollEdges = { start: false, end: false };

/**
 * Track a horizontal scroller's edges (scroll + resize). `ref` is a callback
 * ref: the tracked element lives in state, so the listeners follow the node
 * across unmount/remount (hub <-> runner, deep links that open the runner
 * first, conditionally rendered sections) instead of binding once.
 */
export function useScrollFade<T extends HTMLElement>(width = 24) {
  const [el, setEl] = useState<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);
  useEffect(() => {
    if (!el) {
      setEdges(NO_EDGES);
      return;
    }
    const update = () => {
      const next = scrollEdges(el);
      setEdges((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next,
      );
    };
    return attachScrollFade(el, update);
  }, [el]);
  return { ref: setEl, style: fadeMaskStyle(edges, width), edges };
}

/**
 * scrollLeft that brings a child fully into view inside a horizontal
 * scroller, leaving `pad` px (the fade width) beside it, or null when it is
 * already visible. Offsets are relative to the scroller's content box.
 */
export function revealScrollLeft(
  scroller: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  child: { offsetLeft: number; offsetWidth: number },
  pad = 0,
): number | null {
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const view0 = scroller.scrollLeft;
  const view1 = view0 + scroller.clientWidth;
  const start = child.offsetLeft - pad;
  const end = child.offsetLeft + child.offsetWidth + pad;
  let next: number | null = null;
  if (start < view0) next = start;
  else if (end > view1) next = end - scroller.clientWidth;
  if (next === null) return null;
  next = Math.min(max, Math.max(0, next));
  return Math.abs(next - view0) < 1 ? null : next;
}

/** Arrow / Home / End move focus between a chip row's enabled buttons. */
export function chipRowKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const buttons = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  if (!buttons.length) return;
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? buttons.length - 1
        : e.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : Math.min(buttons.length - 1, at + 1);
  e.preventDefault();
  buttons[next]?.focus();
}
