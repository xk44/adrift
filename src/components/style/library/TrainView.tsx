"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import { showToast } from "@/components/Toast";
import { useModelStore } from "@/store/modelStore";
import {
  cancelTrainingJob,
  deployTrainingJob,
  getTrainingJob,
  listTrainingBackends,
  listTrainingJobs,
  startTrainingJob,
  type StartTrainingJobRequest,
  type TrainingBackend,
  type TrainingBackendName,
  type TrainingDataset,
  type TrainingJobDetail,
  type TrainingJobStatus,
  type TrainingJobSummary,
} from "@/lib/sref/apiClient";
import { trainingStartErrorMessage } from "@/lib/sref/trainingErrors";
import { clusterNodeLabel } from "@/lib/sref/vaultShapes";
import { ServiceOffline } from "./LibraryStatus";
import {
  formatLoss,
  statusColor,
  StatusIcon,
  svFetch,
  type SVClusterNode,
} from "./shared";

interface ClusterChoice {
  id: number;
  label: string;
}

function flattenClusters(nodes: SVClusterNode[], depth = 0): ClusterChoice[] {
  return nodes.flatMap((node) => [
    {
      id: node.id,
      label: `${"\u00a0\u00a0".repeat(depth)}${clusterNodeLabel(node)}${
        node.member_count != null ? ` (${node.member_count})` : ""
      }`,
    },
    ...flattenClusters(node.children ?? [], depth + 1),
  ]);
}

export function TrainView() {
  const [backends, setBackends] = useState<TrainingBackend[]>([]);
  const [jobs, setJobs] = useState<TrainingJobSummary[]>([]);
  const [details, setDetails] = useState<Record<string, TrainingJobDetail>>({});
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deployMsg, setDeployMsg] = useState<{
    id: string;
    ok: boolean;
    msg: string;
  } | null>(null);
  const previousJobStatuses = useRef<Map<string, TrainingJobStatus>>(new Map());
  const autoDeployAttempted = useRef<Set<string>>(new Set());

  // Local training has no clusters; those need the library service.
  const [serviceUp, setServiceUp] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [backend, setBackend] = useState<TrainingBackendName>("musubi-tuner");
  const [runName, setRunName] = useState("");
  const [datasetMode, setDatasetMode] = useState<"cluster" | "images">(
    "cluster",
  );
  const [clusterId, setClusterId] = useState("");
  const [clusters, setClusters] = useState<ClusterChoice[]>([]);
  const [imagesDir, setImagesDir] = useState("");
  const [steps, setSteps] = useState("1200");
  const [rank, setRank] = useState("16");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lr, setLr] = useState("5e-5");
  const [lrWarmupSteps, setLrWarmupSteps] = useState("10");
  const [blocksToSwap, setBlocksToSwap] = useState("26");
  const [excludeShared, setExcludeShared] = useState(true);
  const [divergenceLossThreshold, setDivergenceLossThreshold] = useState("100");
  const [autoCaption, setAutoCaption] = useState(false);
  const [triggerWord, setTriggerWord] = useState("");
  const [training, setTraining] = useState(false);
  const [trainMsg, setTrainMsg] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const installedBackends = backends.filter(
    (b) => b.installed && b.model_families.includes("krea2"),
  );
  const selectedDetail = selectedJobId ? details[selectedJobId] : null;

  const loadBackends = useCallback(async () => {
    const data = await listTrainingBackends();
    setBackends(data);
    const firstInstalled = data.find(
      (b) => b.installed && b.model_families.includes("krea2"),
    );
    if (firstInstalled) setBackend(firstInstalled.name);
  }, []);

  const loadJobs = useCallback(async () => {
    const data = await listTrainingJobs();
    setJobs(data);
    setSelectedJobId((current) => current ?? data[0]?.job_id ?? null);
    return data;
  }, []);

  const loadDetail = useCallback(async (jobId: string) => {
    const detail = await getTrainingJob(jobId);
    setDetails((current) => ({ ...current, [jobId]: detail }));
    return detail;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setOffline(false);
    try {
      await loadBackends();
      const up = await svFetch("health").then(
        () => true,
        () => false,
      );
      setServiceUp(up);
      if (!up) setDatasetMode("images");
      const treeData = up
        ? await svFetch<{ tree: SVClusterNode[] } | SVClusterNode[]>(
            "clusters/tree",
          ).catch(() => [])
        : [];
      const choices = flattenClusters(
        Array.isArray(treeData) ? treeData : (treeData.tree ?? []),
      );
      setClusters(choices);
      // Re-indexing replaces clusters, so an old pick may be gone.
      setClusterId((current) =>
        choices.some((c) => String(c.id) === current) ? current : "",
      );
      const data = await loadJobs();
      const firstJob = data[0]?.job_id;
      if (firstJob) await loadDetail(firstJob);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [loadBackends, loadDetail, loadJobs]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedJobId) return;
    loadDetail(selectedJobId).catch(() => undefined);
  }, [loadDetail, selectedJobId]);

  // Keyed on the boolean, not `jobs`: every poll replaces `jobs`, which would
  // to tear down and re-create this interval on each tick.
  const hasActiveJob = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = setInterval(() => {
      loadJobs().catch(() => undefined);
      if (selectedJobId) loadDetail(selectedJobId).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [hasActiveJob, loadDetail, loadJobs, selectedJobId]);

  const deploy = useCallback(
    async (jobId: string) => {
      setDeploying(jobId);
      setDeployMsg(null);
      try {
        // No lora_dir sent; the trainer deploys into its configured ComfyUI
        // loras folder (same as LoraRunPanel).
        const result = await deployTrainingJob(jobId, {
          name: runName.trim() || undefined,
        });
        await useModelStore.getState().fetchAvailable(true);
        setDeployMsg({
          id: jobId,
          ok: true,
          msg: `Deployed ${result.lora_name} to ComfyUI`,
        });
        showToast(`Deployed ${result.lora_name} to ComfyUI`, "success");
      } catch (e) {
        setDeployMsg({ id: jobId, ok: false, msg: String(e) });
        showToast("LoRA deploy failed. Use the deploy button to retry.", "error");
      } finally {
        setDeploying(null);
      }
    },
    [runName],
  );

  useEffect(() => {
    for (const job of jobs) {
      const previous = previousJobStatuses.current.get(job.job_id);
      if (
        job.status === "done" &&
        previous != null &&
        previous !== "done" &&
        !autoDeployAttempted.current.has(job.job_id)
      ) {
        autoDeployAttempted.current.add(job.job_id);
        showToast("Training complete. Deploying LoRA to ComfyUI.", "info");
        void deploy(job.job_id);
      }
    }
    previousJobStatuses.current = new Map(
      jobs.map((job) => [job.job_id, job.status]),
    );
  }, [deploy, jobs]);

  useEffect(() => {
    if (!selectedDetail) return;
    const previous = previousJobStatuses.current.get(selectedDetail.job_id);
    if (
      selectedDetail.status === "done" &&
      previous != null &&
      previous !== "done" &&
      !autoDeployAttempted.current.has(selectedDetail.job_id)
    ) {
      autoDeployAttempted.current.add(selectedDetail.job_id);
      showToast("Training complete. Deploying LoRA to ComfyUI.", "info");
      void deploy(selectedDetail.job_id);
    }
    previousJobStatuses.current.set(
      selectedDetail.job_id,
      selectedDetail.status,
    );
  }, [deploy, selectedDetail]);

  const startTraining = useCallback(async () => {
    const dataset: TrainingDataset = {};
    if (datasetMode === "cluster") {
      const id = Number(clusterId);
      if (!Number.isInteger(id) || id <= 0) {
        setTrainMsg({ ok: false, msg: "Pick a cluster" });
        return;
      }
      dataset.cluster_id = id;
    } else {
      if (!imagesDir.trim()) {
        setTrainMsg({ ok: false, msg: "Enter an image-set directory" });
        return;
      }
      dataset.images_dir = imagesDir.trim();
    }

    const parsedSteps = Number(steps);
    const parsedRank = Number(rank);
    const parsedBlocksToSwap = Number(blocksToSwap);
    const parsedDivergenceLossThreshold = Number(divergenceLossThreshold);
    const params: StartTrainingJobRequest["params"] = {
      lr: lr.trim() || "5e-5",
      lr_warmup_steps: lrWarmupSteps.trim() || "10",
      blocks_to_swap:
        Number.isFinite(parsedBlocksToSwap) && parsedBlocksToSwap >= 0
          ? Math.min(26, Math.floor(parsedBlocksToSwap))
          : 26,
      exclude_shared: excludeShared,
      divergence_loss_threshold:
        Number.isFinite(parsedDivergenceLossThreshold) &&
        parsedDivergenceLossThreshold > 0
          ? parsedDivergenceLossThreshold
          : 100,
      auto_caption: autoCaption,
      trigger_word: triggerWord.trim(),
    };
    if (Number.isFinite(parsedSteps) && parsedSteps > 0) {
      params.steps = Math.floor(parsedSteps);
    }
    if (Number.isFinite(parsedRank) && parsedRank > 0) {
      params.rank = Math.floor(parsedRank);
    }

    setTraining(true);
    setTrainMsg(null);
    try {
      const res = await startTrainingJob({
        backend,
        model_family: "krea2",
        run_name: runName.trim() || `krea2-${Date.now()}`,
        dataset,
        params,
      });
      setTrainMsg({
        ok: true,
        msg: `Training started - ${res.job_id}`,
      });
      setShowForm(false);
      setSelectedJobId(res.job_id);
      await loadJobs();
      await loadDetail(res.job_id);
    } catch (e) {
      setTrainMsg({ ok: false, msg: trainingStartErrorMessage(e) });
    } finally {
      setTraining(false);
    }
  }, [
    backend,
    clusterId,
    autoCaption,
    blocksToSwap,
    datasetMode,
    divergenceLossThreshold,
    excludeShared,
    imagesDir,
    loadDetail,
    loadJobs,
    lr,
    lrWarmupSteps,
    rank,
    runName,
    steps,
    triggerWord,
  ]);

  const cancel = useCallback(
    async (jobId: string) => {
      setCancelling(jobId);
      try {
        await cancelTrainingJob(jobId);
        await loadJobs();
        await loadDetail(jobId);
      } finally {
        setCancelling(null);
      }
    },
    [loadDetail, loadJobs],
  );

  const canStart =
    installedBackends.length > 0 &&
    Boolean(datasetMode === "cluster" ? clusterId.trim() : imagesDir.trim());
  const selectedLossHistory =
    selectedDetail?.loss_history
      ?.filter((value) => Number.isFinite(value))
      .slice(-20) ?? [];

  if (loading) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" rounded="xl" />
        ))}
      </div>
    );
  }

  if (offline) return <ServiceOffline onRetry={load} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
          Krea 2 training jobs ({jobs.length})
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-light-400 transition-[background-color,color] duration-150 hover:bg-light-50 hover:text-light-primary dark:text-dark-500 dark:hover:bg-dark-800 dark:hover:text-dark-primary"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              setShowForm((f) => !f);
              setTrainMsg(null);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-splash px-3 py-1.5 text-xs font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96]"
          >
            <Play className="h-3 w-3" />
            New Training
          </button>
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
          <p className="mb-3 text-[11px] font-medium text-light-400 dark:text-dark-500">
            Start Krea 2 LoRA training
          </p>
          {installedBackends.length === 0 && (
            <div className="mb-3 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              No Krea 2 trainer is set up. Set one up in Settings, Training, or
              see docs/STYLE_LIBRARY.md for a trainer in the library service.
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                Backend
              </span>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value as TrainingBackendName)}
                className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary"
              >
                {backends.map((item) => (
                  <option
                    key={item.name}
                    value={item.name}
                    disabled={!item.installed || !item.model_families.includes("krea2")}
                  >
                    {item.name}
                    {item.version ? ` ${item.version}` : ""}
                    {!item.installed ? " (not installed)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                Run Name
              </span>
              <input
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
                placeholder="krea2-style"
                className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary placeholder:text-light-400 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary dark:placeholder:text-dark-500"
              />
            </label>
          </div>
          <div className="mt-3 flex rounded-lg bg-light-bg p-1 dark:bg-dark-900">
            {(["cluster", "images"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setDatasetMode(mode)}
                disabled={mode === "cluster" && !serviceUp}
                title={
                  mode === "cluster" && !serviceUp
                    ? "Needs the library service"
                    : undefined
                }
                className={[
                  "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-[background-color,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
                  datasetMode === mode
                    ? "bg-splash text-white"
                    : "text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary",
                ].join(" ")}
              >
                {mode === "cluster" ? "Style Cluster" : "Image Set"}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            {datasetMode === "cluster" ? (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-light-500 dark:text-dark-400">
                  Cluster
                </span>
                <select
                  value={clusterId}
                  onChange={(e) => setClusterId(e.target.value)}
                  disabled={clusters.length === 0}
                  className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none disabled:opacity-50 dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary"
                >
                  <option value="">
                    {clusters.length === 0 ? "No clusters yet" : "Pick a cluster"}
                  </option>
                  {clusters.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-[11px] text-light-500 dark:text-dark-400">
                  Images Directory
                </span>
                <input
                  value={imagesDir}
                  onChange={(e) => setImagesDir(e.target.value)}
                  placeholder="/path/to/captioned/images"
                  className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary placeholder:text-light-400 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary dark:placeholder:text-dark-500"
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                Steps
              </span>
              <input
                type="number"
                min={1}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-light-500 dark:text-dark-400">
                Rank
              </span>
              <input
                type="number"
                min={1}
                value={rank}
                onChange={(e) => setRank(e.target.value)}
                className="rounded-lg border border-light-100 bg-light-bg px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary"
              />
            </label>
          </div>
          <div className="mt-3 rounded-lg bg-light-bg px-3 py-2.5 dark:bg-dark-900">
            <p className="mb-2 text-[11px] font-medium text-light-400 dark:text-dark-500">
              Dataset captions
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center gap-2 text-xs text-light-600 dark:text-dark-400">
                <input
                  type="checkbox"
                  checked={autoCaption}
                  onChange={(e) => setAutoCaption(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-light-200 accent-splash dark:border-dark-700"
                />
                Auto-caption with Qwen (omnitag, needs the library service)
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-light-500 dark:text-dark-400">
                  Trigger word
                </span>
                <input
                  value={triggerWord}
                  onChange={(e) => setTriggerWord(e.target.value)}
                  placeholder="optional"
                  className="rounded-lg border border-light-100 bg-light-input px-3 py-1.5 text-sm text-light-primary placeholder:text-light-400 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-500"
                />
              </label>
            </div>
          </div>
          <div className="mt-3 rounded-lg bg-light-bg dark:bg-dark-900">
            <button
              onClick={() => setShowAdvanced((open) => !open)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-[background-color] duration-150 hover:bg-light-50 dark:hover:bg-dark-800 rounded-lg"
            >
              <span className="flex-1 text-[11px] font-medium text-light-400 dark:text-dark-500">
                Advanced
              </span>
              {showAdvanced ? (
                <ChevronDown className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
              )}
            </button>
            {showAdvanced && (
              <div className="grid gap-3 border-t border-light-100 px-3 pb-3 pt-2 dark:border-dark-750 md:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-light-500 dark:text-dark-400">
                    Learning rate
                  </span>
                  <input
                    value={lr}
                    onChange={(e) => setLr(e.target.value)}
                    className="rounded-lg border border-light-100 bg-light-input px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-light-500 dark:text-dark-400">
                    Warmup steps
                  </span>
                  <input
                    value={lrWarmupSteps}
                    onChange={(e) => setLrWarmupSteps(e.target.value)}
                    className="rounded-lg border border-light-100 bg-light-input px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-light-500 dark:text-dark-400">
                    Blocks to swap
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={26}
                    value={blocksToSwap}
                    onChange={(e) => setBlocksToSwap(e.target.value)}
                    onBlur={() => {
                      const parsed = Number(blocksToSwap);
                      if (Number.isFinite(parsed)) {
                        setBlocksToSwap(String(Math.min(26, Math.max(0, Math.floor(parsed)))));
                      }
                    }}
                    className="rounded-lg border border-light-100 bg-light-input px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-light-600 dark:text-dark-400 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={excludeShared}
                    onChange={(e) => setExcludeShared(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-light-200 accent-splash dark:border-dark-700"
                  />
                  Exclude shared layers (recommended, stable)
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-light-500 dark:text-dark-400">
                    Divergence loss threshold
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={divergenceLossThreshold}
                    onChange={(e) => setDivergenceLossThreshold(e.target.value)}
                    className="rounded-lg border border-light-100 bg-light-input px-3 py-1.5 text-sm text-light-primary focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary"
                  />
                </label>
              </div>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={startTraining}
              disabled={training || !canStart}
              className="flex items-center gap-1.5 rounded-lg bg-splash px-4 py-1.5 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {training ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {training ? "Starting..." : "Start"}
            </button>
          </div>
          {trainMsg && (
            <div
              className={`mt-2 flex items-center gap-1.5 text-xs ${trainMsg.ok ? "text-emerald-500" : "text-red-500"}`}
            >
              {trainMsg.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5" />
              )}
              {trainMsg.msg}
            </div>
          )}
        </div>
      )}

      {deployMsg && (
        <div
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs ${deployMsg.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"}`}
        >
          {deployMsg.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {deployMsg.msg}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Layers className="h-8 w-8 text-light-300 dark:text-dark-500" />
          <p className="mt-3 text-xs text-light-400 dark:text-dark-500">
            No training jobs yet
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <div className="space-y-2">
            {jobs.map((job) => {
              const detail = details[job.job_id];
              const progress = detail?.progress;
              const isSelected = selectedJobId === job.job_id;
              return (
                <button
                  key={job.job_id}
                  onClick={() => setSelectedJobId(job.job_id)}
                  className={[
                    "w-full rounded-xl border bg-light-input px-4 py-3 text-left shadow-panel transition-[border-color,background-color] duration-150 dark:bg-dark-input dark:shadow-panel-dark",
                    isSelected
                      ? "border-splash/50"
                      : "border-light-100 hover:bg-light-50 dark:border-dark-750 dark:hover:bg-dark-800",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-3">
                    <StatusIcon status={job.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-light-primary dark:text-dark-primary">
                          {job.job_id}
                        </p>
                        <span className={`text-xs ${statusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
                        {job.backend} · {new Date(job.created_at).toLocaleString()}
                      </p>
                    </div>
                    {progress != null && (
                      <span className="font-mono text-[11px] text-light-400 dark:text-dark-500">
                        {Math.round(progress)}%
                      </span>
                    )}
                  </div>
                  {progress != null && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
                      <div
                        className="h-full rounded-full bg-splash"
                        style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
            {selectedDetail ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <StatusIcon status={selectedDetail.status} className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-light-primary dark:text-dark-primary">
                      {selectedDetail.job_id}
                    </p>
                    <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
                      {selectedDetail.backend} · {selectedDetail.model_family}
                    </p>
                  </div>
                  {(selectedDetail.status === "queued" ||
                    selectedDetail.status === "running") && (
                    <button
                      onClick={() => cancel(selectedDetail.job_id)}
                      disabled={cancelling === selectedDetail.job_id}
                      className="flex items-center gap-1 rounded-md bg-light-50 px-2 py-1 text-[11px] font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:opacity-50 dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
                    >
                      {cancelling === selectedDetail.job_id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      Cancel
                    </button>
                  )}
                </div>

                {(selectedDetail.step != null ||
                  selectedDetail.total_steps != null) && (
                  <p className="text-xs text-light-500 dark:text-dark-400">
                    Step {selectedDetail.step ?? 0} /{" "}
                    {selectedDetail.total_steps ?? "?"}
                  </p>
                )}

                {selectedDetail.diverged && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    Training diverged — auto-cancelled
                  </div>
                )}

                {(selectedDetail.last_loss != null ||
                  selectedDetail.max_loss != null ||
                  selectedLossHistory.length > 0) && (
                  <div className="rounded-lg bg-light-bg px-3 py-2 dark:bg-dark-900">
                    <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
                      Loss
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-light-500 dark:text-dark-400">
                      <span>Current {formatLoss(selectedDetail.last_loss)}</span>
                      <span>Max {formatLoss(selectedDetail.max_loss)}</span>
                    </div>
                    {selectedLossHistory.length > 0 && (
                      <p className="mt-1 truncate font-mono text-[11px] text-light-600 dark:text-dark-400">
                        {selectedLossHistory.map(formatLoss).join(" · ")}
                      </p>
                    )}
                  </div>
                )}

                {selectedDetail.output_lora_path && (
                  <div className="rounded-lg bg-light-bg px-3 py-2 dark:bg-dark-900">
                    <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
                      Output
                    </p>
                    <p className="mt-1 truncate font-mono text-[11px] text-light-600 dark:text-dark-400">
                      {selectedDetail.output_lora_path}
                    </p>
                  </div>
                )}

                {selectedDetail.log_tail && (
                  <pre className="microScrollbar max-h-52 overflow-auto rounded-lg bg-light-bg p-3 font-mono text-[11px] leading-5 text-light-600 dark:bg-dark-900 dark:text-dark-400">
                    {selectedDetail.log_tail}
                  </pre>
                )}

                {selectedDetail.status === "done" && (
                  <button
                    onClick={() => deploy(selectedDetail.job_id)}
                    disabled={deploying === selectedDetail.job_id}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-splash px-4 py-2 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deploying === selectedDetail.job_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    Deploy to ComfyUI LoRAs
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-light-400 dark:text-dark-500">
                Select a job to view progress and logs.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

