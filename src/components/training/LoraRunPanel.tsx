"use client";

/**
 * LoraRunPanel — reusable LoRA training panel for any board-like dataset
 * (moodboards, character datasets, style datasets).
 *
 * Owns the full training lifecycle UI:
 * - "Train LoRA vN" action + start dialog (trigger word, steps, auto-caption,
 *   version picker, advanced musubi params)
 * - live status of the active run (poll via StyleVault proxy): progress bar,
 *   step counter, loss, collapsible log tail
 * - results on completion: output path, deploy-to-ComfyUI, divergence warning
 * - per-version run history (v1/v2/v3/...) with retrain buttons
 *
 * Server contract:
 * - POST /api/moodboards/[id]/train        (trainMoodboard: version optional)
 * - GET  /api/moodboards/[id]/train        (getMoodboardTrainingRuns)
 * - GET  /api/vault/training/jobs/{id}     (getTrainingJob)
 * - POST /api/vault/training/jobs/{id}/cancel|deploy
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelTrainingJob,
  deployTrainingJob,
  getMoodboardTrainingRuns,
  getTrainingJob,
  trainMoodboard,
  type MoodboardTrainingRunRecord,
  type TrainingJobDetail,
} from "@/lib/sref/apiClient";
import { showToast } from "@/components/Toast";
import { getTrainerStatus } from "@/lib/training/identitySubmit";
import { TrainerSetupLink } from "@/components/settings/TrainerSetupLink";
import { useStyleStore } from "@/store/styleStore";
import {
  Cpu,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
  Rocket,
  OctagonX,
  Copy,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import type { Moodboard } from "@/types";
import {
  TRAIN_PARAM_LIMITS,
  describeLimit,
  validateTrainParams,
  type TrainParamName,
} from "@/lib/training/limits";

const POLL_INTERVAL_MS = 3500;
const TERMINAL = new Set(["done", "error"]);
const MIN_RECOMMENDED_IMAGES = 12;

type LoraRunPanelImage = {
  url: string;
  caption?: string;
};

export interface LoraRunPanelProps {
  board: Pick<Moodboard, "id" | "name" | "kind" | "captionSettings"> & {
    images: LoraRunPanelImage[];
  };
  /** Poll only while the owning page is visible. */
  active: boolean;
  /** Optional extra class for the outer wrapper. */
  className?: string;
}

function statusLabel(status?: string): string {
  switch (status) {
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    case "running":
      return "Running";
    default:
      return "Queued";
  }
}

function statusColor(status?: string): string {
  switch (status) {
    case "done":
      return "text-emerald-600 dark:text-emerald-400";
    case "error":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-[var(--accent-primary)]";
  }
}

function formatEta(seconds: number): string {
  return `~${Math.max(1, Math.ceil(seconds / 60))}m remaining`;
}

function LossSparkline({ history }: { history: number[] }) {
  const width = 120;
  const height = 28;
  const padding = 2;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min;
  const points = history
    .map((loss, index) => {
      const x =
        padding +
        (index / Math.max(1, history.length - 1)) * (width - padding * 2);
      const normalized = range === 0 ? 0.5 : (loss - min) / range;
      const y = padding + (1 - normalized) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const title = `loss ${min.toFixed(4)}..${max.toFixed(4)}`;

  return (
    <span className="inline-flex shrink-0" title={title}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border-primary)"
          strokeDasharray="2 3"
          opacity="0.7"
        />
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent-primary)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function LoraRunPanel({ board, active, className }: LoraRunPanelProps) {
  const hasImages = board.images.length > 0;
  const saveLoRAShortcode = useStyleStore((s) => s.saveLoRAShortcode);
  const [needsTrainer, setNeedsTrainer] = useState(false);

  // Run history (persisted server-side on the board record)
  const [runs, setRuns] = useState<MoodboardTrainingRunRecord[]>([]);
  const [nextVersion, setNextVersion] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Start dialog
  const [showDialog, setShowDialog] = useState(false);
  const [triggerWord, setTriggerWord] = useState("");
  const [steps, setSteps] = useState("");
  const [autoCaption, setAutoCaption] = useState(true);
  const [captionExt, setCaptionExt] = useState<"txt" | "caption">("txt");
  const [version, setVersion] = useState<number | null>(null); // null = next
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lr, setLr] = useState("");
  const [rank, setRank] = useState("");
  const [resolution, setResolution] = useState("");
  const [blocksToSwap, setBlocksToSwap] = useState("");
  const [excludeShared, setExcludeShared] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [datasetWarning, setDatasetWarning] = useState<{
    jobId: string;
    text: string;
  } | null>(null);

  // Active run tracking
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrainingJobDetail | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [etaSecondsRemaining, setEtaSecondsRemaining] = useState<number | null>(
    null,
  );
  const completedToastRef = useRef<string | null>(null);
  // Always holds the currently-mounted board id, so in-flight async work from a
  // previous board's closure can detect it's stale.
  const liveBoardIdRef = useRef(board.id);
  liveBoardIdRef.current = board.id;
  const logRef = useRef<HTMLPreElement | null>(null);
  const etaRef = useRef<
    Record<
      string,
      {
        firstSeenAt: number;
        firstSeenStep: number;
        progressPolls: number;
        lastStep: number;
      }
    >
  >({});

  const refreshRuns = useCallback(async () => {
    try {
      const res = await getMoodboardTrainingRuns(board.id);
      // Ignore a slow response for a board we've since navigated away from,
      // so board A's runs never render in board B's panel. board.id here is
      // this closure's (possibly stale) board; liveBoardIdRef is always current.
      if (board.id !== liveBoardIdRef.current) return;
      if (!res.ok) return;
      setRuns(res.runs);
      setNextVersion(res.nextVersion);
      // Auto-watch the newest non-terminal run so a reload resumes tracking.
      setWatchedJobId((current) => {
        if (current) return current;
        const live = [...res.runs]
          .reverse()
          .find((r) => !TERMINAL.has(r.status ?? ""));
        return live?.jobId ?? null;
      });
    } catch {
      // history is non-critical; the start/status paths surface real errors
    }
  }, [board.id]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void getTrainerStatus().then((s) => {
      if (live) setNeedsTrainer(!!s.local && !s.families.includes("krea2"));
    });
    return () => {
      live = false;
    };
  }, [active]);

  useEffect(() => {
    setRuns([]);
    setNextVersion(1);
    setWatchedJobId(null);
    setDetail(null);
    setStatusError(null);
    setDatasetWarning(null);
    setEtaSecondsRemaining(null);
    etaRef.current = {};
    completedToastRef.current = null;
    // Trigger word is board-specific — clear A's value when switching to B so
    // the auto-fill effect can repopulate from B's own run history (or blank).
    setTriggerWord("");
    if (active) void refreshRuns();
  }, [board.id, active, refreshRuns]);

  const watchedRun = useMemo(
    () => runs.find((r) => r.jobId === watchedJobId) ?? null,
    [runs, watchedJobId],
  );

  const updateEta = useCallback((jobId: string, d: TrainingJobDetail) => {
    if (
      d.status !== "running" ||
      d.step == null ||
      !d.total_steps ||
      d.step >= d.total_steps
    ) {
      setEtaSecondsRemaining(null);
      return;
    }

    const now = Date.now();
    const current = etaRef.current[jobId];
    if (!current) {
      etaRef.current[jobId] = {
        firstSeenAt: now,
        firstSeenStep: d.step,
        progressPolls: 1,
        lastStep: d.step,
      };
      setEtaSecondsRemaining(null);
      return;
    }

    if (d.step > current.lastStep) {
      current.progressPolls += 1;
      current.lastStep = d.step;
    }

    const elapsedSeconds = (now - current.firstSeenAt) / 1000;
    const latestStep = d.step;
    const rate =
      elapsedSeconds > 0
        ? (latestStep - current.firstSeenStep) / elapsedSeconds
        : 0;
    if (current.progressPolls < 2 || rate <= 0) {
      setEtaSecondsRemaining(null);
      return;
    }
    const remaining = (d.total_steps - d.step) / rate;
    setEtaSecondsRemaining(Number.isFinite(remaining) ? remaining : null);
  }, []);

  const handleCopyTriggerWord = useCallback(async (word: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      showToast("Clipboard is unavailable.", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(word);
      showToast(`Copied trigger word "${word}".`, "success");
    } catch {
      showToast("Could not copy trigger word.", "error");
    }
  }, []);

  // Poll the watched job while it's live.
  useEffect(() => {
    if (!active || !watchedJobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const d = await getTrainingJob(watchedJobId);
        if (cancelled) return;
        setDetail(d);
        updateEta(watchedJobId, d);
        setStatusError(null);
        if (TERMINAL.has(d.status)) {
          if (completedToastRef.current !== watchedJobId) {
            completedToastRef.current = watchedJobId;
            if (d.status === "done") {
              showToast(`LoRA training completed for ${board.name}`, "success");
            } else if (d.status === "error") {
              // Toast the failure so it surfaces even while the log is collapsed.
              const reason =
                d.log_tail?.trim()?.split("\n").pop()?.slice(0, 120) ||
                "see the log for details";
              showToast(
                `LoRA training failed for ${board.name}: ${reason}`,
                "error",
              );
            }
          }
          void refreshRuns(); // sync terminal status + output path to server record
        }
      } catch {
        if (!cancelled) setStatusError("Could not load training status.");
      }
    };

    void poll();
    if (detail && TERMINAL.has(detail.status)) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    active,
    watchedJobId,
    detail?.status,
    board.name,
    refreshRuns,
    updateEta,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll log tail.
  useEffect(() => {
    if (logOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logOpen, detail?.log_tail]);

  const openDialog = useCallback(
    (forVersion?: number) => {
      setStartError(null);
      setVersion(forVersion ?? null);
      // Prefill trigger word: the dataset's saved one, else the latest run's.
      const saved = board.captionSettings?.triggerWord?.trim();
      if (!triggerWord && saved) {
        setTriggerWord(saved);
      } else if (!triggerWord && runs.length) {
        setTriggerWord(runs[runs.length - 1]!.triggerWord);
      }
      setShowDialog(true);
    },
    [board.captionSettings?.triggerWord, runs, triggerWord],
  );

  const paramError = useMemo(() => {
    const num = (v: string) => (v.trim() ? Number(v) : undefined);
    return validateTrainParams({
      steps: num(steps),
      lr: num(lr),
      rank: num(rank),
      resolution: num(resolution),
    });
  }, [lr, rank, resolution, steps]);

  const handleStart = useCallback(async () => {
    if (!triggerWord.trim() || paramError) return;
    setStarting(true);
    setStartError(null);
    try {
      const req: Parameters<typeof trainMoodboard>[1] = {
        trigger_word: triggerWord.trim(),
        exclude_shared: excludeShared,
        auto_caption: autoCaption,
        caption_ext: captionExt,
      };
      if (steps.trim()) req.steps = Number(steps);
      if (lr.trim()) req.lr = Number(lr);
      if (rank.trim()) req.rank = Number(rank);
      if (resolution.trim()) req.resolution = Number(resolution);
      if (blocksToSwap.trim()) req.blocks_to_swap = Number(blocksToSwap);
      if (version != null) req.version = version;

      const res = await trainMoodboard(board.id, req);
      if (!res.job_id) {
        if ((res as { setup?: boolean }).setup) setNeedsTrainer(true);
        setStartError(
          (res as { error?: string }).error ?? "Training failed to start.",
        );
        return;
      }
      setShowDialog(false);
      setDetail(null);
      setEtaSecondsRemaining(null);
      setStatusError(null);
      completedToastRef.current = null;
      setWatchedJobId(String(res.job_id));
      setDatasetWarning(
        res.warning ? { jobId: String(res.job_id), text: res.warning } : null,
      );
      showToast(
        `Training v${res.version} started (${res.materialized} images${
          res.skipped ? `, ${res.skipped} skipped` : ""
        }).`,
        res.warning ? "info" : "success",
      );
      await refreshRuns();
    } catch {
      setStartError("Training failed to start. Please try again.");
    } finally {
      setStarting(false);
    }
  }, [
    autoCaption,
    blocksToSwap,
    board.id,
    captionExt,
    excludeShared,
    lr,
    paramError,
    rank,
    refreshRuns,
    resolution,
    steps,
    triggerWord,
    version,
  ]);

  const handleCancel = useCallback(async () => {
    if (!watchedJobId) return;
    setCancelling(true);
    try {
      await cancelTrainingJob(watchedJobId);
      showToast("Training cancelled.", "info");
      await refreshRuns();
    } catch {
      showToast("Could not cancel training.", "error");
    } finally {
      setCancelling(false);
    }
  }, [watchedJobId, refreshRuns]);

  const handleDeploy = useCallback(
    async (jobId: string, runName: string, runTriggerWord: string) => {
      setDeploying(true);
      try {
        const res = await deployTrainingJob(jobId, { name: runName });
        const loraName = res.lora_name.trim();
        const trigger = runTriggerWord.trim();
        saveLoRAShortcode({
          shortcode: loraName,
          filename: res.deployed_path || loraName,
          displayName: runName,
          triggers: trigger ? [trigger] : undefined,
          // The prompt bar's Character pick-list finds trainer LoRAs by tag.
          tags:
            board.kind === "character" || board.kind === "style"
              ? [board.kind]
              : undefined,
          defaultStrength: 1.0,
        });
        showToast(
          `Deployed as ${loraName} — type --lora ${loraName} or the trigger word`,
          "success",
        );
      } catch {
        showToast("Deploy failed — is the LoRA output present?", "error");
      } finally {
        setDeploying(false);
      }
    },
    [saveLoRAShortcode, board.kind],
  );

  const activeStatus = detail?.status ?? watchedRun?.status;
  const showStatus = watchedJobId != null;
  const progress =
    detail?.progress != null
      ? Math.max(0, Math.min(100, detail.progress * 100))
      : null;
  const stepText =
    detail?.step != null && detail?.total_steps
      ? `${detail.step}/${detail.total_steps} steps`
      : detail?.step != null
        ? `Step ${detail.step}`
        : null;
  const etaText =
    activeStatus === "running" && etaSecondsRemaining != null
      ? formatEta(etaSecondsRemaining)
      : null;
  const showLossSparkline = (detail?.loss_history?.length ?? 0) >= 2;
  const deployBlockedByDivergence = detail?.diverged === true;
  const divergenceDeployTitle =
    "Training diverged — retrain with lower LR before deploying";
  // Deploy needs a known output LoRA path — either from the live detail poll or
  // the persisted run record. Without one, deploy would only fail after click.
  const deployHasOutput = Boolean(
    detail?.output_lora_path || watchedRun?.outputLoraPath,
  );
  const datasetCheck = useMemo(() => {
    const total = board.images.length;
    const captioned = board.images.filter((image) =>
      image.caption?.trim(),
    ).length;
    const missingCaptions = total - captioned;
    const shortCaptions = board.images.filter((image) => {
      const caption = image.caption?.trim();
      return caption != null && caption.length > 0 && caption.length < 12;
    }).length;
    const duplicateUrls =
      total - new Set(board.images.map((image) => image.url)).size;
    const captionPercent =
      total > 0 ? Math.round((captioned / total) * 100) : 0;
    const warnings: string[] = [];

    if (total < MIN_RECOMMENDED_IMAGES) {
      warnings.push(
        `${MIN_RECOMMENDED_IMAGES}+ images is a safer floor; this board has ${total}.`,
      );
    }
    if (!autoCaption && missingCaptions > 0) {
      warnings.push(
        `${missingCaptions} image${missingCaptions === 1 ? "" : "s"} will train without a caption.`,
      );
    }
    if (shortCaptions > 0) {
      warnings.push(
        `${shortCaptions} caption${shortCaptions === 1 ? "" : "s"} look very short.`,
      );
    }
    if (duplicateUrls > 0) {
      warnings.push(
        `${duplicateUrls} duplicate image${duplicateUrls === 1 ? "" : "s"} detected.`,
      );
    }

    return {
      total,
      captioned,
      missingCaptions,
      duplicateUrls,
      captionPercent,
      warnings,
    };
  }, [autoCaption, board.images]);

  const dialog = showDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-light-100 bg-light-input p-6 shadow-lg dark:border-dark-750 dark:bg-dark-input">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            Train LoRA v{version ?? nextVersion}
          </h2>
          <button
            onClick={() => setShowDialog(false)}
            disabled={starting}
            className="rounded-lg p-1 text-light-400 hover:text-light-primary disabled:opacity-40 dark:text-dark-500 dark:hover:text-dark-primary"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Trigger word
            </label>
            <input
              type="text"
              value={triggerWord}
              onChange={(e) => setTriggerWord(e.target.value)}
              placeholder={board.kind === "character" ? "my_oc" : "my_style"}
              disabled={starting}
              className="input w-full text-sm disabled:opacity-60"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && triggerWord.trim() && !paramError)
                  void handleStart();
              }}
            />
            <p className="mt-1 text-[10px] text-light-400 dark:text-dark-500">
              Caption prefix / activation token for the LoRA.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
                Steps{" "}
                <span className="text-light-300 dark:text-dark-600">
                  (optional)
                </span>
              </label>
              <input
                type="number"
                min={TRAIN_PARAM_LIMITS.steps.min}
                max={TRAIN_PARAM_LIMITS.steps.max}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder="1500"
                title={`Allowed: ${describeLimit("steps")}`}
                disabled={starting}
                className="input w-full text-sm disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
                Version
              </label>
              <select
                value={version ?? nextVersion}
                onChange={(e) => setVersion(Number(e.target.value))}
                disabled={starting}
                className="input w-full text-sm disabled:opacity-60"
              >
                {Array.from(
                  { length: Math.max(nextVersion, 1) },
                  (_, i) => i + 1,
                ).map((v) => (
                  <option key={v} value={v}>
                    v{v}
                    {v === nextVersion ? " (new)" : " (retrain)"}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-start justify-between gap-3">
            <label className="flex items-start gap-2 text-xs text-light-500 dark:text-dark-400">
              <input
                type="checkbox"
                checked={autoCaption}
                onChange={(e) => setAutoCaption(e.target.checked)}
                disabled={starting}
                className="mt-0.5 accent-[var(--accent-primary)]"
              />
              <span>
                Auto-caption images
                <span className="block text-[10px] text-light-400 dark:text-dark-500">
                  Fills caption sidecars for images without one. Manual captions
                  on images always win.
                </span>
              </span>
            </label>
            <label className="flex flex-col items-end gap-1 text-xs text-light-500 dark:text-dark-400">
              Caption format
              <select
                value={captionExt}
                onChange={(e) =>
                  setCaptionExt(e.target.value as "txt" | "caption")
                }
                disabled={starting}
                className="input text-sm disabled:opacity-60"
                title="Sidecar extension read by the trainer (kohya/musubi/ai-toolkit style)"
              >
                <option value="txt">.txt</option>
                <option value="caption">.caption</option>
              </select>
            </label>
          </div>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs font-medium text-[var(--accent-primary)] hover:opacity-80"
            disabled={starting}
          >
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-[var(--border-primary)] p-3">
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ["lr", lr, setLr, "any"],
                    ["rank", rank, setRank, undefined],
                    [
                      "resolution",
                      resolution,
                      setResolution,
                      TRAIN_PARAM_LIMITS.resolution.multipleOf,
                    ],
                    [
                      "blocks_to_swap",
                      blocksToSwap,
                      setBlocksToSwap,
                      undefined,
                    ],
                  ] as const
                ).map(([label, value, setter, step]) => (
                  <div key={label}>
                    <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
                      {label}
                    </label>
                    <input
                      type="number"
                      step={step}
                      {...(label in TRAIN_PARAM_LIMITS
                        ? {
                            min: TRAIN_PARAM_LIMITS[label as TrainParamName].min,
                            max: TRAIN_PARAM_LIMITS[label as TrainParamName].max,
                            title: `Allowed: ${describeLimit(label as TrainParamName)}`,
                          }
                        : {})}
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      disabled={starting}
                      className="input w-full text-sm disabled:opacity-60"
                    />
                  </div>
                ))}
              </div>
              <label className="flex items-start gap-2 text-xs text-light-500 dark:text-dark-400">
                <input
                  type="checkbox"
                  checked={excludeShared}
                  onChange={(e) => setExcludeShared(e.target.checked)}
                  disabled={starting}
                  className="mt-0.5 accent-[var(--accent-primary)]"
                />
                <span>
                  exclude_shared
                  <span className="block text-[10px] text-light-400 dark:text-dark-500">
                    Recommended: excludes shared conditioning layers to prevent
                    divergence.
                  </span>
                </span>
              </label>
            </div>
          )}
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                {datasetCheck.warnings.length ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                )}
                Dataset check
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  datasetCheck.warnings.length
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-300"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                }`}
              >
                {datasetCheck.warnings.length
                  ? `${datasetCheck.warnings.length} warning${
                      datasetCheck.warnings.length === 1 ? "" : "s"
                    }`
                  : "Ready"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
              <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {datasetCheck.total}
                </div>
                <div className="text-[var(--text-muted)]">images</div>
              </div>
              <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {datasetCheck.captioned}
                  <span className="ml-1 text-[10px] font-medium text-[var(--text-muted)]">
                    {datasetCheck.captionPercent}%
                  </span>
                </div>
                <div className="text-[var(--text-muted)]">captioned</div>
              </div>
              <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {datasetCheck.missingCaptions}
                </div>
                <div className="text-[var(--text-muted)]">missing</div>
              </div>
            </div>
            {datasetCheck.warnings.length > 0 ? (
              <ul className="mt-2 space-y-1 text-[10px] leading-4 text-amber-600 dark:text-amber-300">
                {datasetCheck.warnings.map((warning) => (
                  <li key={warning} className="flex gap-1.5">
                    <span aria-hidden="true">-</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[10px] text-[var(--text-muted)]">
                Image count and captions look reasonable for a first pass.
              </p>
            )}
          </div>
          {paramError && <p className="text-xs text-rose-500">{paramError}</p>}
          {startError && <p className="text-xs text-rose-500">{startError}</p>}
          {needsTrainer && <TrainerSetupLink className="text-xs" />}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setShowDialog(false)}
              disabled={starting}
              className="rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color] duration-150 hover:bg-light-100 disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
            >
              Cancel
            </button>
            <button
              onClick={handleStart}
              disabled={!triggerWord.trim() || !!paramError || starting}
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {starting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cpu className="h-4 w-4" />
              )}
              Start training
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => openDialog()}
          disabled={!hasImages || needsTrainer}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-[var(--text-primary)] text-sm font-medium hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-40"
          title={
            needsTrainer
              ? "Set up a trainer in Settings → Training"
              : hasImages
                ? `Train this dataset as a LoRA (v${nextVersion})`
                : "Add images before training"
          }
        >
          <Cpu className="w-4 h-4" /> Train LoRA v{nextVersion}
        </button>
        {needsTrainer && <TrainerSetupLink className="text-xs" />}
        {runs.length > 0 && (
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            {historyOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {datasetWarning && datasetWarning.jobId === watchedJobId && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {datasetWarning.text}
        </p>
      )}

      {/* Active run status */}
      {showStatus && (
        <div className="mt-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`font-semibold ${statusColor(activeStatus)}`}>
                {statusLabel(activeStatus)}
              </span>
              {watchedRun && (
                <span className="font-medium text-[var(--text-primary)]">
                  {watchedRun.runName}
                </span>
              )}
              <span className="font-mono text-[var(--text-muted)]">
                job {watchedJobId}
              </span>
              {stepText && (
                <span className="text-[var(--text-muted)]">
                  {stepText}
                  {etaText ? ` ${etaText}` : ""}
                </span>
              )}
              {progress != null && (
                <span className="font-mono text-[var(--text-muted)]">
                  {Math.round(progress)}%
                </span>
              )}
              {detail?.last_loss != null && (
                <span className="font-mono text-[var(--text-muted)]">
                  loss {detail.last_loss.toFixed(4)}
                </span>
              )}
              {showLossSparkline && detail?.loss_history && (
                <LossSparkline history={detail.loss_history} />
              )}
              {watchedRun?.triggerWord && (
                <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                  <span>{watchedRun.triggerWord}</span>
                  <button
                    onClick={() =>
                      void handleCopyTriggerWord(watchedRun.triggerWord)
                    }
                    className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    title="Copy trigger word"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </span>
              )}
              {detail?.diverged && (
                <span className="font-semibold text-rose-500">DIVERGED</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {activeStatus === "done" && (
                <button
                  onClick={() =>
                    watchedRun &&
                    handleDeploy(
                      watchedRun.jobId,
                      watchedRun.runName,
                      watchedRun.triggerWord,
                    )
                  }
                  disabled={
                    deploying || deployBlockedByDivergence || !deployHasOutput
                  }
                  title={
                    deployBlockedByDivergence
                      ? divergenceDeployTitle
                      : !deployHasOutput
                        ? "No trained LoRA output yet"
                        : "Deploy to ComfyUI"
                  }
                  className="flex items-center gap-1 rounded-lg border border-[var(--border-primary)] px-2 py-1 text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-primary)] transition-colors disabled:opacity-40"
                >
                  {deploying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Rocket className="h-3.5 w-3.5" />
                  )}
                  Deploy to ComfyUI
                </button>
              )}
              {activeStatus != null && !TERMINAL.has(activeStatus) && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="flex items-center gap-1 rounded-lg border border-[var(--border-primary)] px-2 py-1 text-xs font-medium text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
                >
                  <OctagonX className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
              <button
                onClick={() => setLogOpen((v) => !v)}
                className="rounded-lg border border-[var(--border-primary)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                {logOpen ? "Hide log" : "Show log"}
              </button>
            </div>
          </div>
          {statusError && (
            <p className="mt-1 text-xs text-rose-500">{statusError}</p>
          )}
          {progress != null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-primary)]">
              <div
                className="h-full rounded-full bg-[var(--accent-primary)]"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {logOpen && (
            <pre
              ref={logRef}
              className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-[var(--bg-primary)] p-2 font-mono text-[10px] leading-4 text-[var(--text-muted)] whitespace-pre-wrap"
            >
              {detail?.log_tail?.trim() || "Waiting for log output..."}
            </pre>
          )}
          {activeStatus === "done" && detail?.output_lora_path && (
            <p className="mt-2 break-all font-mono text-[10px] text-[var(--text-muted)]">
              {detail.output_lora_path}
            </p>
          )}
        </div>
      )}

      {/* Run history */}
      {historyOpen && runs.length > 0 && (
        <div className="mt-2 divide-y divide-[var(--border-primary)] rounded-xl border border-[var(--border-primary)]">
          {[...runs].reverse().map((run) => {
            const runDiverged =
              run.jobId === watchedJobId && detail?.diverged === true;
            return (
              <div
                key={run.jobId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[var(--accent-primary)]/10 px-2 py-0.5 font-semibold text-[var(--accent-primary)]">
                    v{run.version}
                  </span>
                  <span className={`font-medium ${statusColor(run.status)}`}>
                    {statusLabel(run.status)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                    <span>{run.triggerWord}</span>
                    <button
                      onClick={() =>
                        void handleCopyTriggerWord(run.triggerWord)
                      }
                      className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                      title="Copy trigger word"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </span>
                  <span className="font-mono text-[var(--text-muted)]">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!TERMINAL.has(run.status ?? "") ||
                  run.jobId === watchedJobId ? (
                    <button
                      onClick={() => {
                        setDetail(null);
                        setEtaSecondsRemaining(null);
                        setWatchedJobId(run.jobId);
                      }}
                      className="rounded-lg border border-[var(--border-primary)] px-2 py-0.5 font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Watch
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setDetail(null);
                        setEtaSecondsRemaining(null);
                        setWatchedJobId(run.jobId);
                      }}
                      className="rounded-lg border border-[var(--border-primary)] px-2 py-0.5 font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Details
                    </button>
                  )}
                  {run.status === "done" && (
                    <button
                      onClick={() =>
                        handleDeploy(run.jobId, run.runName, run.triggerWord)
                      }
                      disabled={deploying || runDiverged}
                      title={
                        runDiverged
                          ? divergenceDeployTitle
                          : "Deploy to ComfyUI"
                      }
                      className="rounded-lg border border-[var(--border-primary)] px-2 py-0.5 font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-primary)] transition-colors disabled:opacity-40"
                    >
                      Deploy
                    </button>
                  )}
                  <button
                    onClick={() => openDialog(run.version)}
                    className="rounded-lg border border-[var(--border-primary)] px-2 py-0.5 font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Retrain
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dialog}
    </div>
  );
}
