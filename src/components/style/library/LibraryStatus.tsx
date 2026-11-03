"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, FolderPlus, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import { svFetch, svPost, useLatestRequest } from "./shared";

export const SETUP_COMMAND = "bash scripts/stylevault.sh setup";
export const START_COMMAND = "bash scripts/stylevault.sh start";
const POLL_FAILURES_BEFORE_OFFLINE = 3;

export interface LibraryHealth {
  /** Missing on an older service that can't index from here. */
  assets?: number;
  embedder?: string;
}

export interface IndexStatus {
  state: "idle" | "running" | "done" | "error";
  step?: string;
  done?: number;
  total?: number;
  error?: string | null;
  assets?: number;
}

/** Service not reachable: what to run, and a retry. */
export function ServiceOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-24"
      data-testid="library-offline"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-light-50 dark:bg-dark-750">
        <WifiOff className="h-10 w-10 text-light-300 dark:text-dark-500" />
      </div>
      <p className="mt-4 text-sm font-medium text-light-primary dark:text-dark-primary">
        The style library service isn&apos;t running
      </p>
      <p className="mt-1 max-w-sm text-center text-xs text-light-400 dark:text-dark-500">
        Map, Clusters and Images use a small local service. Run these from the
        Adrift folder, then retry.
      </p>
      <code className="mt-3 flex flex-col gap-1 rounded-lg bg-light-50 px-3 py-2 font-mono text-[11px] text-light-600 dark:bg-dark-800 dark:text-dark-400">
        <span>{SETUP_COMMAND}</span>
        <span>{START_COMMAND}</span>
      </code>
      <button
        onClick={onRetry}
        className="mt-4 flex items-center gap-1.5 rounded-lg bg-splash px-4 py-2 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96]"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Retry
      </button>
    </div>
  );
}

export function IndexProgress({ job }: { job: IndexStatus }) {
  if (job.state === "error") {
    return (
      <div
        className="flex items-start gap-1.5 rounded-xl bg-red-500/8 px-3 py-2.5 text-xs text-red-600 dark:text-red-400"
        data-testid="library-index-error"
      >
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        Indexing failed: {job.error || "unknown error"}
      </div>
    );
  }
  if (job.state !== "running") return null;
  const total = job.total ?? 0;
  const done = job.done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="space-y-1.5" data-testid="library-index-progress">
      <p className="flex items-center gap-1.5 text-xs text-light-500 dark:text-dark-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {job.step || "Working"}
        {total > 0 ? ` (${done} of ${total})` : ""}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
        <div
          className={`h-full rounded-full bg-splash ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Folder input + one-click ComfyUI outputs. Starts a background index job. */
export function AddFolderForm({
  busy,
  error,
  onIndex,
}: {
  busy: boolean;
  error: string | null;
  onIndex: (body: { folder: string } | { source: "comfy-output" }) => void;
}) {
  const [folder, setFolder] = useState("");
  const trimmed = folder.trim();
  return (
    <div className="space-y-2" data-testid="library-add-folder">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-light-400 dark:text-dark-500">
          Add a folder
        </span>
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="/path/to/images"
          className="w-full rounded-xl border border-light-100 bg-light-input px-3 py-2 text-sm text-light-primary placeholder:text-light-400 transition-[border-color] duration-150 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-500"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onIndex({ folder: trimmed })}
          disabled={busy || !trimmed}
          className="flex items-center gap-1.5 rounded-lg bg-splash px-3 py-1.5 text-xs font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          Add folder
        </button>
        <button
          onClick={() => onIndex({ source: "comfy-output" })}
          disabled={busy}
          className="rounded-lg bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
        >
          Use my ComfyUI outputs
        </button>
      </div>
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** First-run panel: the service is up and the library is empty. */
export function EmptyLibrary({
  job,
  busy,
  error,
  onIndex,
}: {
  job: IndexStatus | null;
  busy: boolean;
  error: string | null;
  onIndex: (body: { folder: string } | { source: "comfy-output" }) => void;
}) {
  return (
    <div
      className="mx-auto max-w-lg space-y-3 rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
      data-testid="library-empty"
    >
      <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
        Your style library is empty
      </p>
      <p className="text-xs text-light-500 dark:text-dark-400">
        Add a folder of images. Adrift reads them, groups them by look and
        builds the map. The first run may download the embedding model.
      </p>
      {job?.state === "done" && (
        <p className="text-xs text-light-500 dark:text-dark-400">
          The last run found no images in that folder.
        </p>
      )}
      {job && <IndexProgress job={job} />}
      <AddFolderForm busy={busy} error={error} onIndex={onIndex} />
    </div>
  );
}

/**
 * Wraps Map, Clusters and Images. Shows the setup commands when the service
 * is down and the add-folder panel when it has no images, and remounts the
 * view when an index job finishes so it loads the new data.
 */
export function LibraryStatus({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [offline, setOffline] = useState(false);
  const [health, setHealth] = useState<LibraryHealth | null>(null);
  const [job, setJob] = useState<IndexStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const req = useLatestRequest();

  const refresh = useCallback(async () => {
    const g = req.next();
    try {
      const nextHealth = await svFetch<LibraryHealth>("health");
      // An older service has no status route; that isn't an outage.
      const nextJob = await svFetch<IndexStatus>("library/index/status").catch(
        () => null,
      );
      if (!req.isCurrent(g)) return;
      setHealth(nextHealth);
      setJob(nextJob);
      setOffline(false);
    } catch {
      if (req.isCurrent(g)) setOffline(true);
    } finally {
      if (req.isCurrent(g)) setChecking(false);
    }
  }, [req]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    let failures = 0;
    const timer = setInterval(() => {
      const g = req.current();
      svFetch<IndexStatus>("library/index/status")
        .then((next) => {
          if (!req.isCurrent(g)) return;
          failures = 0;
          setJob(next);
          if (next.state !== "running") {
            setDataVersion((v) => v + 1);
            setShowAdd(false);
            void refresh();
          }
        })
        .catch(() => {
          // A service that stopped mid-index never reports done.
          failures += 1;
          if (failures < POLL_FAILURES_BEFORE_OFFLINE || !req.isCurrent(g)) return;
          setJob(null);
          setOffline(true);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [refresh, req, running]);

  const startIndex = useCallback(
    async (body: { folder: string } | { source: "comfy-output" }) => {
      setStarting(true);
      setStartError(null);
      try {
        await svPost("library/index", body);
        setJob({ state: "running", step: "Starting" });
      } catch (e) {
        setStartError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    },
    [],
  );

  if (checking) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" rounded="xl" />
        ))}
      </div>
    );
  }

  if (offline) return <ServiceOffline onRetry={() => void refresh()} />;

  if (health?.assets === 0) {
    return (
      <EmptyLibrary
        job={job}
        busy={starting || running}
        error={startError}
        onIndex={startIndex}
      />
    );
  }

  return (
    <div className="space-y-4">
      {health?.assets != null && (
        <div className="space-y-3" data-testid="library-summary">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
              {health.assets.toLocaleString()} image
              {health.assets === 1 ? "" : "s"}
              {health.embedder ? ` · ${health.embedder}` : ""}
            </p>
            <button
              onClick={() => setShowAdd((s) => !s)}
              className="flex items-center gap-1.5 rounded-lg bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Add a folder
            </button>
          </div>
          {showAdd && (
            <AddFolderForm
              busy={starting || running}
              error={startError}
              onIndex={startIndex}
            />
          )}
          {job && <IndexProgress job={job} />}
        </div>
      )}
      <div key={dataVersion}>{children}</div>
    </div>
  );
}
