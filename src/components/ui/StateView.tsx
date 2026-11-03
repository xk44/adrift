"use client";

import type { ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, RefreshCw } from "lucide-react";

/**
 * Shared loading / empty / error block. Every list page renders its
 * non-content states through this so they look and behave the same:
 * errors are never shown as empty and always offer Retry when the page
 * can reload.
 *
 * Pick the status with viewStatus() from lib/ui/viewState.ts.
 */
export interface StateViewProps {
  status: "loading" | "empty" | "error";
  /** Headline. Defaults: "Loading…" / "Nothing here yet" / "Couldn't load this". */
  title?: string;
  /** Detail line (error message, empty-state hint). */
  message?: ReactNode;
  /** Error state: shows a Retry button. */
  onRetry?: () => void;
  /** Empty state: a primary action ("Create your first moodboard"). */
  action?: { label: string; onClick: () => void };
  /** Replace the default icon. */
  icon?: ReactNode;
  /** Loading state: render this (e.g. a skeleton grid) instead of the spinner row. */
  skeleton?: ReactNode;
  /** Smaller padding for panels and sections. */
  compact?: boolean;
  className?: string;
  testId?: string;
}

const DEFAULT_TITLE = {
  loading: "Loading…",
  empty: "Nothing here yet",
  error: "Couldn't load this",
} as const;

export function StateView({
  status,
  title,
  message,
  onRetry,
  action,
  icon,
  skeleton,
  compact = false,
  className = "",
  testId,
}: StateViewProps) {
  const dataTestId = testId ?? `state-view-${status}`;
  if (status === "loading" && skeleton) {
    return (
      <div
        role="status"
        aria-label={title ?? DEFAULT_TITLE.loading}
        data-testid={dataTestId}
        className={className}
      >
        {skeleton}
        <span className="sr-only">{title ?? DEFAULT_TITLE.loading}</span>
      </div>
    );
  }
  const pad = compact ? "py-6 px-4 gap-2" : "py-14 px-6 gap-3";
  const isError = status === "error";
  const Icon =
    icon ??
    (status === "loading" ? (
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    ) : isError ? (
      <AlertCircle className="h-6 w-6" aria-hidden />
    ) : (
      <Inbox className="h-6 w-6" aria-hidden />
    ));
  return (
    <div
      role={isError ? "alert" : "status"}
      data-testid={dataTestId}
      className={`flex flex-col items-center justify-center text-center ${pad} ${className}`}
    >
      <span
        className={
          isError ? "text-[var(--error)]" : "text-[var(--text-tertiary)]"
        }
      >
        {Icon}
      </span>
      <p className="text-sm font-medium text-[var(--text-primary)]">
        {title ?? DEFAULT_TITLE[status]}
      </p>
      {message ? (
        <p className="max-w-sm text-xs text-pretty text-[var(--text-tertiary)] break-words">
          {message}
        </p>
      ) : null}
      {isError && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-xs font-medium text-[var(--text-primary)] ring-1 ring-[var(--border-primary)] transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
        </button>
      ) : null}
      {status === "empty" && action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 inline-flex h-9 items-center rounded-full bg-[var(--accent-primary)] px-4 text-xs font-medium text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export default StateView;
