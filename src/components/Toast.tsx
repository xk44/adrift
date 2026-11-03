"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { nodeWarningsOf } from "@/lib/comfy/nodeWarnings";

export interface ToastItem {
  id: string;
  message: string;
  type?: "success" | "error" | "info";
  duration?: number;
}

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const colors = {
  success:
    "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
  error: "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",
  info: "border-[var(--border-secondary)] bg-[var(--bg-secondary)]/95 text-[var(--text-primary)]",
};

/** Default on-screen time for success/info toasts. */
export const TOAST_DEFAULT_MS = 4000;
/** Errors stay long enough to read (WCAG 2.2.1); callers may ask for longer. */
export const TOAST_ERROR_MIN_MS = 10000;
/** Visible stack cap; the oldest toast drops off first. */
export const TOAST_MAX_VISIBLE = 4;

/** On-screen time for a toast: errors never shorter than TOAST_ERROR_MIN_MS. */
export function toastDuration(
  type: NonNullable<ToastItem["type"]>,
  requested?: number,
): number {
  if (type === "error") {
    return Math.max(requested ?? 0, TOAST_ERROR_MIN_MS);
  }
  return requested ?? TOAST_DEFAULT_MS;
}

/** Append a toast, keeping at most `max` (oldest dropped first). */
export function enqueueToast(
  queue: ToastItem[],
  item: ToastItem,
  max = TOAST_MAX_VISIBLE,
): ToastItem[] {
  const next = [...queue, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

let toastListeners: Array<(toasts: ToastItem[]) => void> = [];
let toastQueue: ToastItem[] = [];

export function showToast(
  message: string,
  type: ToastItem["type"] = "info",
  duration?: number,
) {
  const kind = type ?? "info";
  const item: ToastItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    message,
    type: kind,
    duration: toastDuration(kind, duration),
  };
  toastQueue = enqueueToast(toastQueue, item);
  toastListeners.forEach((fn) => fn(toastQueue));
}

/** Toast the optional-node bypass warnings a job route returned (if any). */
export function toastNodeWarnings(data: unknown) {
  for (const w of nodeWarningsOf(data)) showToast(w, "info", 8000);
}

function removeToast(id: string) {
  toastQueue = toastQueue.filter((t) => t.id !== id);
  toastListeners.forEach((fn) => fn(toastQueue));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    toastListeners.push(setToasts);
    setToasts(toastQueue);
    return () => {
      toastListeners = toastListeners.filter((fn) => fn !== setToasts);
    };
  }, []);

  const errors = toasts.filter((t) => t.type === "error");
  const others = toasts.filter((t) => t.type !== "error");

  // Bottom-right stack. Below md it clears the h-14 mobile tab bar (and the
  // home-indicator inset) instead of covering it.
  return (
    <div className="pointer-events-none fixed bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col-reverse gap-2 sm:right-6 sm:w-full md:bottom-6">
      {/* Always-mounted live regions so screen readers announce toasts (most
          action feedback in the app is toast-only). Errors are assertive. */}
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col-reverse gap-2"
      >
        {others.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col-reverse gap-2"
      >
        {errors.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const type = toast.type ?? "info";
  const Icon = icons[type];

  const dismiss = useCallback(() => removeToast(toast.id), [toast.id]);

  // Auto-dismiss, paused while hovered or focused (WCAG 2.2.1 Timing).
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration ?? TOAST_DEFAULT_MS);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(dismiss, remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(
        1000,
        remainingRef.current - (Date.now() - startedAt),
      );
    };
  }, [paused, dismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
      className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur-sm animate-slide-up ${colors[type]}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">{toast.message}</p>
      <button
        onClick={dismiss}
        className="shrink-0 rounded p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default ToastContainer;
