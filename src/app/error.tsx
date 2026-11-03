"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

/**
 * Route-level error boundary (Next.js app router). Catches anything the
 * in-page ErrorBoundaries miss so a render error never blanks the app.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Adrift] route error:", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex min-h-screen w-full items-center justify-center bg-[var(--bg-primary)] px-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-[var(--error)]" />
          <h1 className="text-base font-medium text-[var(--text-primary)]">
            Adrift hit an unexpected error
          </h1>
        </div>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          Your images and settings are safe. Try again, or reload the page if
          it keeps happening.
        </p>
        {error.message && (
          <pre className="mb-4 max-h-32 overflow-auto rounded-lg bg-[var(--bg-tertiary)] p-3 text-xs text-[var(--text-muted)]">
            {error.message}
          </pre>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-[var(--border-primary)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
