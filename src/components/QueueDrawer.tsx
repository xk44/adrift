"use client";

/**
 * Global job queue drawer: every running/queued job from Create, Tools and
 * Edit, with live preview, progress, cancel and "jump to" (Create rows), then
 * the session's recent finished/failed jobs with retry for prompt runs.
 * Opened from the sidebar's job badge; Escape closes, focus stays inside.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Box,
  CornerDownRight,
  Film,
  ImageIcon,
  Loader2,
  Music,
  RotateCw,
  X,
} from "lucide-react";
import { shallow } from "zustand/shallow";
import { useGenerationStore, useUIStore } from "@/store";
import { useEditorStore } from "@/store/editorStore";
import { useVideoEditStore } from "@/store/videoEditStore";
import { useQueueDrawerStore } from "@/store/queueDrawerStore";
import { useUpscaleAfterStore } from "@/store/upscaleAfterStore";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useLivePreview } from "@/lib/comfy/livePreview";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/components/Toast";
import {
  buildQueueSnapshot,
  editRunIdSet,
  type QueueEntry,
  type QueueSource,
} from "@/lib/queue/queueEntries";
import { requestJobCancel } from "@/lib/queue/cancelJob";
import { retryPromptRun } from "@/lib/queue/retryRun";

const SOURCE_LABEL: Record<QueueSource, string> = {
  create: "Create",
  tools: "Tools",
  edit: "Edit",
};

export function QueueDrawer() {
  const open = useQueueDrawerStore((s) => s.open);
  if (!open || typeof document === "undefined") return null;
  return createPortal(<QueueDrawerPanel />, document.body);
}

function QueueDrawerPanel() {
  const setOpen = useQueueDrawerStore((s) => s.setOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, true, { onEscape: close });

  const runs = useGenerationStore((s) => s.runs);
  const { cancelJob, addError, addRun } = useGenerationStore(
    (s) => ({ cancelJob: s.cancelJob, addError: s.addError, addRun: s.addRun }),
    shallow,
  );
  const editorRuns = useEditorStore((s) => s.toolRuns);
  const videoRuns = useVideoEditStore((s) => s.toolRuns);
  const chains = useUpscaleAfterStore((s) => s.chains);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const { active, recent } = useMemo(
    () =>
      buildQueueSnapshot(
        runs,
        editRunIdSet(editorRuns, videoRuns),
        undefined,
        chains,
      ),
    [runs, editorRuns, videoRuns, chains],
  );

  const markBusy = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const handleCancel = async (entry: QueueEntry) => {
    if (entry.waiting) {
      useUpscaleAfterStore.getState().remove(entry.runId);
      return;
    }
    const promptId = entry.promptId;
    if (!promptId || busy.has(entry.key)) return;
    markBusy(entry.key, true);
    try {
      const outcome = await requestJobCancel(promptId, {
        confirmGlobalInterrupt: (version) =>
          confirm({
            title: "Interrupt the running job?",
            message:
              `ComfyUI ${version ?? "(unknown version)"} can't cancel a single job; ` +
              "this stops whatever is running now, which may be someone else's job.",
            confirmLabel: "Interrupt",
            danger: true,
          }),
      });
      if (outcome === "cancelled") cancelJob(promptId);
      else if (outcome === "not-found")
        showToast("ComfyUI no longer has that job queued.", "info");
    } catch (error) {
      addError({
        message:
          error instanceof Error ? error.message : "Failed to cancel job",
        category: "network",
      });
    } finally {
      markBusy(entry.key, false);
    }
  };

  const handleJump = () => {
    setActiveNav("create");
    close();
    // Active runs render as the first rows of the Create feed.
    requestAnimationFrame(() =>
      document
        .getElementById("pageScroll")
        ?.scrollTo({ top: 0, behavior: "smooth" }),
    );
  };

  const handleRetry = async (entry: QueueEntry) => {
    const run = runs.find((r) => r.run_id === entry.runId);
    if (!run || busy.has(entry.key)) return;
    markBusy(entry.key, true);
    try {
      const newRuns = await retryPromptRun(run.prompt, {
        clientId: useGenerationStore.getState().clientId,
        ui: useUIStore.getState(),
      });
      for (const r of newRuns) addRun(r);
      showToast("Queued again.", "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Retry failed",
        "error",
      );
    } finally {
      markBusy(entry.key, false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80]" data-testid="queue-drawer">
      <div
        className="absolute inset-0 bg-black/30 animate-fade-in"
        onMouseDown={close}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-drawer-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-[380px] flex-col bg-[var(--bg-secondary)] border-l border-[var(--border-primary)] shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 border-b border-[var(--border-primary)]">
          <h2
            id="queue-drawer-title"
            className="flex-1 text-sm font-semibold text-[var(--text-primary)]"
          >
            Queue
            {active.length > 0 && (
              <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)] tabular-nums">
                {active.length} active
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label="Close queue"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="microScrollbar flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {active.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--text-tertiary)]">
              Nothing running or queued.
            </p>
          ) : (
            <ul className="space-y-1" aria-label="Running and queued jobs">
              {active.map((entry) => (
                <QueueRow
                  key={entry.key}
                  entry={entry}
                  busy={busy.has(entry.key)}
                  onCancel={handleCancel}
                  onJump={handleJump}
                />
              ))}
            </ul>
          )}

          {recent.length > 0 && (
            <>
              <h3 className="mt-4 px-2 pb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
                Recent
              </h3>
              <ul className="space-y-1" aria-label="Recently finished jobs">
                {recent.map((entry) => (
                  <QueueRow
                    key={entry.key}
                    entry={entry}
                    busy={busy.has(entry.key)}
                    onRetry={handleRetry}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
        {confirmDialog}
      </div>
    </div>
  );
}

interface QueueRowProps {
  entry: QueueEntry;
  busy: boolean;
  onCancel?: (entry: QueueEntry) => void;
  onJump?: () => void;
  onRetry?: (entry: QueueEntry) => void;
}

export function queueStatusText(entry: QueueEntry): string {
  switch (entry.status) {
    case "running":
      return entry.nodeLabel
        ? `${entry.progress}% · ${entry.nodeLabel}`
        : `${entry.progress}%`;
    case "queued":
      return entry.waiting && entry.after
        ? `Waits for ${entry.after}`
        : "Queued";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return entry.error ? `Failed: ${entry.error}` : "Failed";
  }
}

const QueueRow = memo(function QueueRow({
  entry,
  busy,
  onCancel,
  onJump,
  onRetry,
}: QueueRowProps) {
  const isActive = entry.status === "running" || entry.status === "queued";
  const canRetry =
    !!onRetry &&
    entry.retryable &&
    (entry.status === "error" || entry.status === "cancelled");
  const iconBtn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50";

  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-[var(--bg-hover)]/50">
      <QueueThumb entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="truncate font-medium text-[var(--text-primary)]">
            {entry.label}
          </span>
          <span className="shrink-0 rounded px-1 py-px text-[10px] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)]">
            {SOURCE_LABEL[entry.source]}
          </span>
        </div>
        {entry.after && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-[var(--text-secondary)]">
            <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">After {entry.after}</span>
          </p>
        )}
        {entry.prompt && (
          <p
            className="mt-0.5 line-clamp-2 text-xs text-[var(--text-secondary)]"
            title={entry.prompt}
          >
            {entry.prompt}
          </p>
        )}
        <p
          className={`mt-1 truncate text-[11px] tabular-nums ${
            entry.status === "error"
              ? "text-[var(--error)]"
              : "text-[var(--text-tertiary)]"
          }`}
          title={entry.status === "error" ? entry.error : undefined}
        >
          {queueStatusText(entry)}
        </p>
        {entry.status === "running" && (
          <div
            className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={entry.progress}
            aria-label="Progress"
          >
            <div
              className="h-full bg-[var(--accent-primary)] transition-[width] duration-300"
              style={{ width: `${entry.progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {isActive && onJump && entry.jumpable && (
          <button
            type="button"
            onClick={onJump}
            className={iconBtn}
            aria-label="Jump to job in Create"
            title="Jump to Create"
          >
            <ArrowUpRight className="h-4 w-4" />
          </button>
        )}
        {isActive && onCancel && (entry.promptId || entry.waiting) && (
          <button
            type="button"
            onClick={() => onCancel(entry)}
            disabled={busy}
            className={iconBtn}
            aria-label={entry.waiting ? "Cancel upscale after" : "Cancel job"}
            title={entry.waiting ? "Don't upscale this one" : "Cancel job"}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={() => onRetry?.(entry)}
            disabled={busy}
            className={iconBtn}
            aria-label="Retry job"
            title="Run this prompt again"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </li>
  );
});

function QueueThumb({ entry }: { entry: QueueEntry }) {
  // Live latent preview while running (owned by the livePreviews registry).
  const live = useLivePreview(
    entry.status === "running" ? entry.promptId : undefined,
  );
  const src = live ?? entry.thumb;
  const box =
    "relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--bg-tertiary)] flex items-center justify-center text-[var(--text-tertiary)]";
  if (src) {
    return (
      <div className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  const Icon =
    entry.mediaKind === "video"
      ? Film
      : entry.mediaKind === "audio"
        ? Music
        : entry.mediaKind === "mesh"
          ? Box
          : entry.status === "running"
            ? Loader2
            : ImageIcon;
  return (
    <div className={box}>
      <Icon
        className={`h-4 w-4 ${entry.status === "running" && !entry.mediaKind ? "animate-spin" : ""}`}
        aria-hidden
      />
    </div>
  );
}
