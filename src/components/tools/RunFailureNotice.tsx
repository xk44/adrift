"use client";

import type { ReactNode } from "react";
import { AlertCircle, ExternalLink, RotateCcw } from "lucide-react";
import {
  START_COMFY_COMMAND,
  START_COMFY_README_ANCHOR,
  type RunFailure,
} from "@/lib/comfy/runFailure";
import { SetupToolButton, type SetupCardRef } from "./SetupDrawer";

/**
 * Public repo URL (NEXT_PUBLIC_CJ_REPO_URL, e.g. https://github.com/<org>/<repo>);
 * when set, the "start ComfyUI" help links to the README section on it.
 */
function readmeStartComfyUrl(): string | null {
  const repo = process.env.NEXT_PUBLIC_CJ_REPO_URL?.trim().replace(/\/+$/, "");
  if (!repo || !/^https:\/\//.test(repo)) return null;
  return `${repo}/blob/main/README.md${START_COMFY_README_ANCHOR}`;
}

/** How to start ComfyUI: the README quick-start command, inline. */
function StartComfyHelp() {
  const readme = readmeStartComfyUrl();
  return (
    <details className="group text-xs" data-testid="run-failure-start-comfy">
      <summary className="cursor-pointer select-none font-semibold text-red-700 underline-offset-2 hover:underline dark:text-red-300">
        How to start ComfyUI
      </summary>
      <div className="mt-1.5 space-y-1.5 text-light-600 dark:text-dark-500">
        <p>
          From the Adrift folder:{" "}
          <code className="rounded bg-black/5 px-1 py-px font-mono text-[11px] dark:bg-white/10">
            COMFY_DIR=/path/to/ComfyUI scripts/start-comfyui.sh
          </code>
          , or from the ComfyUI folder:
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-2 font-mono text-[11px] dark:bg-white/10">
          {START_COMFY_COMMAND}
        </pre>
        <p>
          ComfyUI 0.24+ needs{" "}
          <code className="font-mono">--enable-cors-header</code> set to the URL
          you open Adrift on. Then{" "}
          <a
            href="/api/health"
            target="_blank"
            rel="noopener noreferrer"
            className="text-splash underline"
          >
            check the connection
          </a>
          .
        </p>
        <p>
          {readme ? (
            <a
              href={readme}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-splash underline"
            >
              README: Start ComfyUI <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <>
              Full steps: README, section &ldquo;2. Start ComfyUI with a CORS
              origin&rdquo;.
            </>
          )}
        </p>
      </div>
    </details>
  );
}

/**
 * A failed run, explained: headline, one plain sentence, the next step
 * (retry, "Set up this tool", how to start ComfyUI) and the raw detail.
 */
export function RunFailureNotice({
  failure,
  card,
  onRetry,
  actions,
}: {
  failure: RunFailure;
  /** Enables the "Set up this tool" drawer for setup failures. */
  card?: SetupCardRef | null;
  /** Shown when the failure is retryable. */
  onRetry?: () => void;
  /** Extra next-step buttons (e.g. Create's "Open setup"). */
  actions?: ReactNode;
}) {
  const showRetry = failure.retryable && onRetry;
  const showSetup = failure.setup && card;
  const showActions = actions != null && actions !== false;
  return (
    <div
      role="alert"
      data-testid="run-failure"
      data-kind={failure.kind}
      className="space-y-1.5 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-red-600 dark:text-red-400"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-[13px] font-semibold">{failure.title}</p>
          <p className="break-words text-xs text-pretty opacity-90">
            {failure.message}
          </p>
        </div>
      </div>
      {(showRetry || showSetup || showActions) && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          {showRetry && (
            <button
              type="button"
              onClick={onRetry}
              data-testid="run-failure-retry"
              className="inline-flex items-center gap-1 rounded-lg bg-red-500/15 px-2 py-1 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </button>
          )}
          {showSetup && <SetupToolButton card={card} />}
          {showActions && actions}
        </div>
      )}
      {failure.startComfy && (
        <div className="pl-6">
          <StartComfyHelp />
        </div>
      )}
      {failure.detail && failure.detail !== failure.message && (
        <details className="pl-6 text-[11px]">
          <summary className="cursor-pointer select-none opacity-75">
            Details
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono opacity-85">
            {failure.detail}
          </pre>
        </details>
      )}
    </div>
  );
}
