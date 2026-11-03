"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2, PlugZap, RefreshCw, X } from "lucide-react";
import { useFirstRunStatus } from "@/hooks/useFirstRunStatus";
import { CopyCommand } from "@/components/setup/CopyCommand";
import { ChangeConnectionButton } from "@/components/setup/FirstRunChecklist";
import { isLocalComfyUrl, startComfyCommand } from "@/lib/setup/firstRun";

/**
 * Shown as soon as Adrift knows ComfyUI is down, on every page and screen
 * size. Clears by itself when ComfyUI answers again (the status hook polls
 * while offline). Dismissal holds for the browser session (the page owns it).
 */
export function OfflineCard({
  dismissed,
  onDismiss,
  underPromptBar = false,
}: {
  dismissed: boolean;
  onDismiss: () => void;
  /** Inside the prompt bar's column, which already has side padding. */
  underPromptBar?: boolean;
}) {
  const { offline, status, loading, refresh } = useFirstRunStatus();
  const [origin, setOrigin] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  if (!offline || dismissed) return null;

  const comfyUrl = status?.comfy.url || undefined;
  const local = isLocalComfyUrl(comfyUrl);
  const retry = () => {
    void refresh();
    window.dispatchEvent(new Event("cj:ws-reconnect"));
  };

  return (
    <div
      className={
        underPromptBar
          ? "flex-shrink-0 pt-2"
          : "flex-shrink-0 px-3 pt-2 md:px-6 md:pt-3"
      }
      data-testid="offline-card"
    >
      <div
        role="status"
        aria-live="polite"
        className={`mx-auto w-full ${underPromptBar ? "" : "max-w-3xl "}rounded-xl bg-[var(--bg-secondary)] shadow-[inset_0_0_0_1px_var(--border-primary)] animate-fade-in`}
      >
        <div className="flex min-h-[44px] items-center gap-2 pl-3 pr-1 text-xs">
            <PlugZap
              className="h-4 w-4 flex-shrink-0 text-[var(--warning)]"
              aria-hidden
            />
            <span className="min-w-0 truncate">
              <span className="font-medium text-[var(--text-primary)]">
                ComfyUI isn&apos;t running
              </span>
              <span className="hidden text-[var(--text-secondary)] sm:inline">
                {local
                  ? " · Adrift needs it to make images."
                  : " · Adrift can't reach it."}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls="offline-card-help"
              data-testid="offline-card-toggle"
              className="ml-auto inline-flex min-h-[44px] flex-shrink-0 items-center gap-0.5 rounded-lg px-2 font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {local ? "How to start" : "Details"}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            <span className="flex flex-shrink-0 items-center">
              <button
                type="button"
                onClick={retry}
                disabled={loading}
                title="Check again"
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="sr-only sm:not-sr-only">Retry</span>
              </button>
              <button
                type="button"
                onClick={onDismiss}
                title="Hide for this session"
                aria-label="Hide the ComfyUI notice for this session"
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </span>
        </div>
        <div
          id="offline-card-help"
          hidden={!expanded}
          className="space-y-2 px-3 pb-3 pl-9"
        >
            <p className="text-xs leading-5 text-[var(--text-secondary)]">
              {local
                ? "Start it from the Adrift folder:"
                : `Adrift can't reach ComfyUI at ${comfyUrl}. Check that it's running there, or point Adrift at another one.`}
            </p>
            {!local && <ChangeConnectionButton />}
            {local && (
              <CopyCommand
                label="Start ComfyUI"
                command={startComfyCommand({
                  comfyRoot: status?.comfyRoot,
                  comfyUrl,
                  origin,
                })}
              />
            )}
            <p className="text-xs text-[var(--text-tertiary)]">
              This notice goes away by itself once ComfyUI is up.
            </p>
        </div>
      </div>
    </div>
  );
}

export default OfflineCard;
