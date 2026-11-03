"use client";

import { AlertCircle, KeyRound, RefreshCw } from "lucide-react";
import { navigateTo } from "@/lib/navUrlSync";
import {
  describeFeedError,
  type FeedErrorSource,
} from "@/lib/explore/civitaiErrors";

/**
 * Error state for the Explore feeds: a plain-language reason, Retry, and,
 * when Civitai refused for lack of a key, a link to Settings where the
 * Civitai API key is entered. `compact` is the inline variant (load-more
 * errors, or above a fallback grid); `lead` prefixes its message.
 */
export function FeedErrorState({
  error,
  source = "civitai",
  onRetry,
  compact = false,
  lead = "Couldn't load more.",
}: {
  error: string;
  source?: FeedErrorSource;
  onRetry: () => void;
  compact?: boolean;
  lead?: string;
}) {
  const info = describeFeedError(error, source);
  const settingsLink = info.needsKey ? (
    <button
      type="button"
      onClick={() => navigateTo("account-settings")}
      data-testid="feed-error-settings"
      className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-[transform,background-color] hover:bg-[var(--bg-hover)] active:scale-[0.96]"
    >
      <KeyRound className="h-3.5 w-3.5" />
      Open Settings
    </button>
  ) : null;
  const retry = (
    <button
      type="button"
      onClick={onRetry}
      className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-[transform,background-color] hover:bg-[var(--bg-hover)] active:scale-[0.96]"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      Retry
    </button>
  );

  if (compact) {
    return (
      <div
        role="alert"
        data-testid="feed-error"
        className="flex flex-wrap items-center justify-center gap-3 py-6 text-center text-xs text-[var(--text-muted)]"
      >
        <span>{lead ? `${lead} ${info.message}` : info.message}</span>
        {settingsLink}
        {retry}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="feed-error"
      className="flex min-h-[40vh] flex-col items-center justify-center px-6 text-center"
    >
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--error)] shadow-[inset_0_0_0_1px_var(--border-primary)]">
        <AlertCircle className="h-5 w-5" />
      </div>
      <p className="max-w-sm text-sm text-[var(--text-primary)] [text-wrap:pretty]">
        {info.message}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {settingsLink}
        {retry}
      </div>
    </div>
  );
}
