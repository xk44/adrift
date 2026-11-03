/**
 * useComfyWS - WebSocket hook for ComfyUI real-time updates
 * Maintains stable connection with automatic reconnection
 * Tracks job progress, completion, and errors
 */

"use client";

import { useEffect, useRef, useCallback } from "react";
import { useGenerationStore } from "@/store";
import type { ComfyWSMessage, JobStatus } from "@/types";
import { getNodeLabel } from "@/lib/oj/workflow-analysis";
import {
  describeExecutionError,
  describeExecutionInterrupted,
  type ExecutionEventData,
  type NodeTitles,
} from "@/lib/comfy/errorMessages";
import { decodeComfyBinaryFrame, livePreviews } from "@/lib/comfy/livePreview";
import { historyTexts } from "@/lib/comfy/outputs";
import {
  acquireComfySocket,
  type ComfySocketLease,
} from "@/lib/comfy/sharedSocket";
import { createPromptWatchdog } from "@/lib/comfy/promptWatchdog";
import { guardTabClientId } from "@/lib/comfy/tabClientId";
import { getComfyWsBaseOverride } from "@/lib/comfy/wsBaseOverride";
import {
  NO_PROMPT_ID_TIMEOUT_MS,
  reconcileAction,
  type PromptStatus,
} from "@/lib/comfy/promptReconcile";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "done",
  "error",
  "cancelled",
] as JobStatus[]);

/**
 * Did /api/comfy/history return a finished prompt? Any output kind counts
 * (the route classifies with extractOutputs: images, video, audio, mesh,
 * text, latents/custom) — as does a completed status with no outputs.
 */
function historyIsFinished(data: {
  ok?: boolean;
  outputs?: unknown;
  images?: unknown[];
  videos?: unknown[];
  meshes?: unknown[];
  audios?: unknown[];
  status?: { completed?: unknown } | null;
}): boolean {
  if (!data?.ok) return false;
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  return (
    nonEmpty(data.outputs) ||
    nonEmpty(data.images) ||
    nonEmpty(data.videos) ||
    nonEmpty(data.meshes) ||
    nonEmpty(data.audios) ||
    data.status?.completed === true
  );
}

async function fetchPromptTitles(promptId: string): Promise<NodeTitles> {
  try {
    const res = await fetch(
      `/api/comfy/prompt-titles/${encodeURIComponent(promptId)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return {};
    const json = (await res.json()) as { titles?: NodeTitles };
    return json.titles ?? {};
  } catch {
    return {};
  }
}

// WebSocket configuration. With no env override, derive the URL from the
// page's hostname so the UI still connects when browsed from another device
// on the LAN — a hardcoded 127.0.0.1 would point at the *client* machine.
const WS_BASE_URL = process.env.NEXT_PUBLIC_COMFY_WS_BASE ?? "";
const RECONNECT_DELAY_MS = 2000;

function resolveWebSocketBaseUrl(): string {
  const saved = getComfyWsBaseOverride();
  if (saved) return saved;
  if (typeof window === "undefined") {
    return WS_BASE_URL || "ws://127.0.0.1:8188";
  }

  if (WS_BASE_URL.startsWith("ws://") || WS_BASE_URL.startsWith("wss://")) {
    return WS_BASE_URL;
  }

  if (WS_BASE_URL.startsWith("/")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${WS_BASE_URL}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (WS_BASE_URL) {
    return `${protocol}//${WS_BASE_URL}`;
  }
  return `${protocol}//${window.location.hostname}:8188`;
}
const MAX_RECONNECT_ATTEMPTS = 3;
const STABLE_CONNECTION_MS = 10000; // Connection must stay open this long before attempt counter resets
const HEARTBEAT_INTERVAL_MS = 30000;
const REACHABILITY_CHECK_MS = 15000; // Check ComfyUI reachability periodically
// Runs queued on another ComfyUI host (the env video host or a machine added
// in Settings) never reach this WebSocket (it is connected to the default
// host), so they finish via history polling.
const VIDEO_BACKEND_POLL_MS = 5000;
// A pending prompt that gets no WS event for this long (its events went to
// another socket, or the socket went quiet) is polled via history until done.
const WS_SILENCE_STALE_MS = 20000;
const WS_SILENCE_TICK_MS = 5000;
// Pending jobs are reconciled against ComfyUI's queue + history on every
// socket (re)connect and this often while any job is pending, so no tile can
// pulse forever (missed events, reload, restart, prompt deleted from queue).
const RECONCILE_INTERVAL_MS = 6000;
// A prompt whose history says "done" is re-fetched at most this often.
const RECONCILE_REFETCH_MS = 30000;
const RECONCILE_MAX_IDS = 50;

function isVideoBackendRun(run: {
  params?: Record<string, unknown>;
  jobs?: { backend?: { id: string } }[];
}): boolean {
  const backend = run.params?.comfy_backend;
  if (typeof backend === "string" && backend !== "" && backend !== "default")
    return true;
  // Auto-routed runs can split jobs across machines.
  return !!run.jobs?.some((j) => j.backend && j.backend.id !== "default");
}

interface UseComfyWSOptions {
  enabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export function useComfyWS(options: UseComfyWSOptions = {}) {
  const { enabled = true, onConnect, onDisconnect, onError } = options;

  const onConnectRef = useRef<UseComfyWSOptions["onConnect"]>(onConnect);
  const onDisconnectRef =
    useRef<UseComfyWSOptions["onDisconnect"]>(onDisconnect);
  const onErrorRef = useRef<UseComfyWSOptions["onError"]>(onError);

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onConnect, onDisconnect, onError]);

  const clientId = useGenerationStore((s) => s.clientId);
  const setWsConnected = useGenerationStore((s) => s.setWsConnected);
  const setWsReconnecting = useGenerationStore((s) => s.setWsReconnecting);
  const setQueueRemaining = useGenerationStore((s) => s.setQueueRemaining);
  const setCurrentPromptId = useGenerationStore((s) => s.setCurrentPromptId);
  const setJobStatus = useGenerationStore((s) => s.setJobStatus);
  const setJobImages = useGenerationStore((s) => s.setJobImages);
  const setJobError = useGenerationStore((s) => s.setJobError);
  const cancelJob = useGenerationStore((s) => s.cancelJob);
  const setError = useGenerationStore((s) => s.setError);
  const addError = useGenerationStore((s) => s.addError);
  const setComfyReachable = useGenerationStore((s) => s.setComfyReachable);

  // A lease on the tab-wide shared socket (see lib/comfy/sharedSocket).
  const wsRef = useRef<ComfySocketLease | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const closeTimeout = useRef<NodeJS.Timeout | null>(null);
  const stabilityTimeout = useRef<NodeJS.Timeout | null>(null);
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null);
  const reachabilityInterval = useRef<NodeJS.Timeout | null>(null);
  const isIntentionalClose = useRef(false);
  const lastReachableCheck = useRef<number>(0);
  // Result of the most recent real check — returned while debounced so
  // callers never mistake "skipped" (undefined) for "unreachable".
  const lastReachable = useRef<boolean | null>(null);
  const cachedNodesByPrompt = useRef<Map<string, Set<string>>>(new Map());
  // Prompts whose history fetch already started — execution_success and the
  // trailing `executing {node:null}` both signal the end of a prompt.
  const historyRequested = useRef<Set<string>>(new Set());
  // Prompt currently executing: legacy PREVIEW_IMAGE frames carry no id.
  const activePromptId = useRef<string | null>(null);
  // Last WS event per pending prompt, for the history-poll fallback.
  const promptWatchdog = useRef(
    createPromptWatchdog({ staleMs: WS_SILENCE_STALE_MS }),
  );
  // Reconcile bookkeeping: first time a prompt looked missing, last refetch
  // of a finished prompt's outputs, and a single-flight guard.
  const missingSince = useRef<Map<string, { since: number; count: number }>>(
    new Map(),
  );
  const reconcileRefetchAt = useRef<Map<string, number>>(new Map());
  const reconcileInFlight = useRef(false);

  const getJobProgressContext = useCallback((promptId: string) => {
    const currentRuns = useGenerationStore.getState().runs;
    const runWithJob = currentRuns.find((r) =>
      r.jobs.some((j) => j.prompt_id === promptId),
    );
    const job = runWithJob?.jobs.find((j) => j.prompt_id === promptId);
    const totalNodes = runWithJob?.workflowNodeClassMap
      ? Object.keys(runWithJob.workflowNodeClassMap).length
      : 0;

    return { runWithJob, job, totalNodes };
  }, []);

  const calculateNodeProgress = useCallback(
    (
      promptId: string,
      currentNodeFraction = 0,
      completedOverride?: number,
    ) => {
      const { job, totalNodes } = getJobProgressContext(promptId);
      if (totalNodes <= 0) return undefined;

      const cachedCount = cachedNodesByPrompt.current.get(promptId)?.size ?? 0;
      const completedUncachedCount =
        completedOverride ?? job?.completedNodes ?? 0;
      const completedNodeUnits = Math.min(
        totalNodes,
        cachedCount + completedUncachedCount + currentNodeFraction,
      );
      const pct = Math.round((completedNodeUnits / totalNodes) * 100);
      // Never move a running bar backwards (late cache reports, rounding).
      return job?.status === "running" ? Math.max(pct, job.progress) : pct;
    },
    [getJobProgressContext],
  );

  /**
   * Check if ComfyUI is reachable via HTTP API
   * This provides a fallback when WS connection fails
   */
  const checkReachability = useCallback(async () => {
    const now = Date.now();
    // Debounce: don't check more than once every 5 seconds
    if (now - lastReachableCheck.current < 5000) {
      return lastReachable.current ?? true;
    }
    lastReachableCheck.current = now;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // /api/health is the cheap probe (one /system_stats, 2s timeout, no
      // rate limit). /api/comfy/models pulls all of /object_info with
      // server-side retries and allows 20/min, so polling it while ComfyUI
      // is down hits 429s that keep the pill red after it comes back.
      const response = await fetch("/api/health", {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeout);

      const health = response.ok
        ? ((await response.json().catch(() => null)) as {
            comfyui?: string;
          } | null)
        : null;
      const reachable = health?.comfyui === "connected";
      lastReachable.current = reachable;
      setComfyReachable(reachable);
      return reachable;
    } catch {
      lastReachable.current = false;
      setComfyReachable(false);
      return false;
    }
  }, [setComfyReachable]);

  /**
   * Fetch history for completed prompt and extract images
   */
  const fetchCompletedImages = useCallback(
    async (promptId: string, attempt = 0) => {
      try {
        const response = await fetch(`/api/comfy/history/${promptId}`);
        const data = await response.json();

        if (historyIsFinished(data)) {
          livePreviews.clear(promptId);
          const imageUrls = (data.images ?? []).map(
            (img: { url: string }) => img.url,
          );
          const videoUrls = (data.videos ?? []).map(
            (v: { url: string }) => v.url,
          );
          const audioUrls = (data.audios ?? []).map(
            (a: { url: string }) => a.url,
          );
          const meshUrls = (data.meshes ?? []).map(
            (m: { url: string }) => m.url,
          );
          setJobImages(promptId, imageUrls, {
            videos: videoUrls.length > 0 ? videoUrls : undefined,
            audios: audioUrls.length > 0 ? audioUrls : undefined,
            meshes: meshUrls.length > 0 ? meshUrls : undefined,
            texts: historyTexts(data),
          });
          console.log(
            `[ComfyWS] Fetched ${imageUrls.length} images, ${videoUrls.length} videos, ${audioUrls.length} audios, ${meshUrls.length} meshes for ${promptId}`,
          );
        } else {
          if (attempt < 8) {
            const delayMs = 250 * Math.pow(2, attempt);
            setTimeout(() => {
              fetchCompletedImages(promptId, attempt + 1);
            }, delayMs);
          } else {
            livePreviews.clear(promptId);
            console.warn(`[ComfyWS] No outputs found for ${promptId}`);
          }
        }
      } catch (error) {
        if (attempt < 8) {
          const delayMs = 250 * Math.pow(2, attempt);
          setTimeout(() => {
            fetchCompletedImages(promptId, attempt + 1);
          }, delayMs);
        } else {
          livePreviews.clear(promptId);
          console.error(
            `[ComfyWS] Failed to fetch history for ${promptId}:`,
            error,
          );
        }
      }
    },
    [setJobImages],
  );

  /**
   * Poll for job status updates when WebSocket is disconnected
   * This provides fallback progress tracking
   */
  const pollJobStatus = useCallback(async (
    runFilter?: (run: { params?: Record<string, unknown> }) => boolean,
    onlyPromptIds?: ReadonlySet<string>,
  ) => {
    // Find jobs that might have completed (been running for a while)
    // Read current state to avoid stale closure over `runs`
    const allRuns = useGenerationStore.getState().runs;
    const currentRuns = runFilter ? allRuns.filter(runFilter) : allRuns;
    const runningJobs = currentRuns.flatMap((r) =>
      r.jobs.filter(
        (j) =>
          (j.status === "running" || j.status === "queued") &&
          j.prompt_id &&
          (!onlyPromptIds || onlyPromptIds.has(j.prompt_id)),
      ),
    );

    for (const job of runningJobs) {
      if (!job.prompt_id) continue;

      try {
        const response = await fetch(`/api/comfy/history/${job.prompt_id}`);
        const data = await response.json();
        const status = data.status;
        const statusStr =
          typeof status?.status_str === "string"
            ? status.status_str.toLowerCase()
            : "";

        const hasOutput =
          data.ok &&
          (data.images?.length > 0 ||
            data.videos?.length > 0 ||
            data.meshes?.length > 0 ||
            data.audios?.length > 0 ||
            data.outputs?.length > 0);

        if (hasOutput) {
          const imageUrls = (data.images ?? []).map(
            (img: { url: string }) => img.url,
          );
          const videoUrls = (data.videos ?? []).map(
            (v: { url: string }) => v.url,
          );
          const audioUrls = (data.audios ?? []).map(
            (a: { url: string }) => a.url,
          );
          const meshUrls = (data.meshes ?? []).map(
            (m: { url: string }) => m.url,
          );
          livePreviews.clear(job.prompt_id);
          setJobImages(job.prompt_id, imageUrls, {
            videos: videoUrls.length > 0 ? videoUrls : undefined,
            audios: audioUrls.length > 0 ? audioUrls : undefined,
            meshes: meshUrls.length > 0 ? meshUrls : undefined,
            texts: historyTexts(data),
          });
          console.log(`[ComfyWS] Polled completion for ${job.prompt_id}`);
        } else if (data.ok && status?.completed === true) {
          setJobStatus(job.prompt_id, "done", 100, null, null, null);
          console.log(`[ComfyWS] Polled completion for ${job.prompt_id}`);
        } else if (
          data.ok &&
          (statusStr === "error" ||
            statusStr === "failed" ||
            statusStr === "failure")
        ) {
          const error =
            typeof data.error === "string"
              ? data.error
              : "ComfyUI execution failed";
          setJobError(job.prompt_id, error);
        }
      } catch (error) {
        // Silently fail - will retry on next poll
      }
    }
  }, [setJobError, setJobImages, setJobStatus]);

  /**
   * Handle a binary frame: latent previews (PREVIEW_IMAGE / _WITH_METADATA).
   */
  const handleBinary = useCallback((payload: ArrayBuffer | ArrayBufferView) => {
    const preview = decodeComfyBinaryFrame(payload);
    if (!preview) return;
    // Type 4 names its prompt; legacy type 1 belongs to whatever is running.
    const promptId = preview.promptId ?? activePromptId.current;
    if (!promptId) return;
    promptWatchdog.current.noteEvent(promptId);
    const job = useGenerationStore
      .getState()
      .runs.flatMap((r) => r.jobs)
      .find((j) => j.prompt_id === promptId);
    // Only our own, still-running jobs get a preview (a trailing frame after
    // completion would otherwise leak an object URL nobody clears).
    if (!job) return;
    // A preview proves it is running even if execution_start was missed
    // (socket reconnected mid-run).
    if (job.status === "queued")
      useGenerationStore.getState().setJobStatus(promptId, "running");
    else if (job.status !== "running") return;
    livePreviews.push(promptId, preview);
  }, []);

  /**
   * Fetch a finished prompt's outputs once — execution_success and the
   * trailing `executing {node:null}` both end the same prompt.
   */
  const fetchCompletedImagesOnce = useCallback(
    (promptId: string) => {
      if (activePromptId.current === promptId) activePromptId.current = null;
      if (historyRequested.current.has(promptId)) return;
      historyRequested.current.add(promptId);
      // Bounded: drop the oldest ids beyond a few hundred prompts.
      if (historyRequested.current.size > 500) {
        const oldest = historyRequested.current.values().next().value;
        if (oldest !== undefined) historyRequested.current.delete(oldest);
      }
      void fetchCompletedImages(promptId);
    },
    [fetchCompletedImages],
  );

  /**
   * Reconcile every pending job with ComfyUI's queue + history (all
   * backends): finished ones fetch outputs, failed / interrupted ones end,
   * and ones ComfyUI no longer knows (restart, deleted from queue) fail with
   * a clear message after two checks instead of pulsing forever.
   */
  const reconcilePending = useCallback(async () => {
    if (reconcileInFlight.current) return;
    const now = Date.now();
    const store = useGenerationStore.getState();
    const ids: string[] = [];
    for (const run of store.runs) {
      for (const [i, job] of run.jobs.entries()) {
        if (job.status !== "queued" && job.status !== "running") continue;
        if (job.prompt_id) {
          if (ids.length < RECONCILE_MAX_IDS) ids.push(job.prompt_id);
          continue;
        }
        // Never got a prompt id (submit lost / server died mid-submit).
        const created = Date.parse(run.createdAt);
        if (Number.isFinite(created) && now - created > NO_PROMPT_ID_TIMEOUT_MS)
          store.updateJob(run.run_id, i, {
            status: "error",
            error: "Never reached ComfyUI (no prompt id).",
          });
      }
    }
    // Forget bookkeeping for prompts that are no longer pending.
    const live = new Set(ids);
    for (const id of [...missingSince.current.keys()])
      if (!live.has(id)) missingSince.current.delete(id);
    for (const id of [...reconcileRefetchAt.current.keys()])
      if (!live.has(id)) reconcileRefetchAt.current.delete(id);
    if (ids.length === 0) return;

    reconcileInFlight.current = true;
    let statuses: Record<string, PromptStatus> = {};
    try {
      const res = await fetch(
        `/api/comfy/prompt-status?ids=${ids.map(encodeURIComponent).join(",")}`,
        { cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        ok?: boolean;
        statuses?: Record<string, PromptStatus>;
      };
      if (!data.ok || !data.statuses) return;
      statuses = data.statuses;
    } catch {
      return; // next tick retries
    } finally {
      reconcileInFlight.current = false;
    }

    const at = Date.now();
    const jobs = new Map(
      useGenerationStore
        .getState()
        .runs.flatMap((r) => r.jobs)
        .filter((j) => j.prompt_id)
        .map((j) => [j.prompt_id as string, j]),
    );
    for (const [id, status] of Object.entries(statuses)) {
      const job = jobs.get(id);
      if (!job) continue;
      if (status?.state === "missing") {
        const prev = missingSince.current.get(id);
        missingSince.current.set(id, {
          since: prev?.since ?? at,
          count: (prev?.count ?? 0) + 1,
        });
      } else if (status?.state !== "unknown") {
        missingSince.current.delete(id);
      }
      const action = reconcileAction(
        job,
        status ?? { state: "unknown" },
        missingSince.current.get(id),
        at,
      );
      switch (action.kind) {
        case "running":
          setJobStatus(id, "running", job.progress);
          break;
        case "fetch": {
          const last = reconcileRefetchAt.current.get(id) ?? 0;
          if (at - last < RECONCILE_REFETCH_MS) break;
          reconcileRefetchAt.current.set(id, at);
          historyRequested.current.add(id);
          if (activePromptId.current === id) activePromptId.current = null;
          void fetchCompletedImages(id);
          break;
        }
        case "error":
          console.warn(`[ComfyWS] Reconciled ${id} as failed: ${action.message}`);
          livePreviews.clear(id);
          if (activePromptId.current === id) activePromptId.current = null;
          missingSince.current.delete(id);
          setJobError(id, action.message);
          break;
        case "cancel":
          livePreviews.clear(id);
          if (activePromptId.current === id) activePromptId.current = null;
          cancelJob(id);
          break;
        default:
          break;
      }
    }
  }, [cancelJob, fetchCompletedImages, setJobError, setJobStatus]);

  /**
   * Handle incoming WebSocket message
   */
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // ComfyUI binary frames: latent previews (and progress text, ignored).
      if (typeof event.data !== "string") {
        const raw = event.data as unknown;
        if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
          handleBinary(raw as ArrayBuffer | ArrayBufferView);
        } else if (
          typeof Blob !== "undefined" &&
          raw instanceof Blob
        ) {
          void raw.arrayBuffer().then(handleBinary, () => {});
        }
        return;
      }

      try {
        const msg: ComfyWSMessage = JSON.parse(event.data);
        const { data } = msg;
        // Wider than ComfyWSMessage["type"]: feature_flags / progress_state.
        const type = msg.type as string;
        if (typeof data?.prompt_id === "string") {
          promptWatchdog.current.noteEvent(data.prompt_id);
        }

        switch (type) {
          case "status":
            if (data.status?.exec_info?.queue_remaining !== undefined) {
              setQueueRemaining(data.status.exec_info.queue_remaining);
            }
            break;

          case "feature_flags":
          case "progress_state":
            // Server capability reply / per-node state map (unused: the
            // `progress` + `executing` stream already drives the bar).
            break;

          case "execution_start":
            // New execution starting
            if (data.prompt_id) {
              cachedNodesByPrompt.current.delete(data.prompt_id);
              historyRequested.current.delete(data.prompt_id);
              activePromptId.current = data.prompt_id;
              setCurrentPromptId(data.prompt_id);
              setJobStatus(data.prompt_id, "running", 0);
              console.log(`[ComfyWS] Execution started: ${data.prompt_id}`);
            }
            break;

          case "executing":
            // Node execution update
            if (data.prompt_id) {
              const promptId = data.prompt_id;
              if (data.node === null || data.node === undefined) {
                // ComfyUI sends this after EVERY prompt (main.py
                // prompt_worker) — also failed / interrupted ones, which
                // already reached a terminal state. Only a still-running job
                // (servers without execution_success) completes here.
                const { job } = getJobProgressContext(promptId);
                if (job && !TERMINAL_STATUSES.has(job.status)) {
                  console.log(`[ComfyWS] Execution complete: ${promptId}`);
                  cachedNodesByPrompt.current.delete(promptId);
                  setJobStatus(promptId, "done", 100, null, null, null);
                  setCurrentPromptId(null);
                  fetchCompletedImagesOnce(promptId);
                } else {
                  cachedNodesByPrompt.current.delete(promptId);
                  if (activePromptId.current === promptId) {
                    activePromptId.current = null;
                  }
                  if (
                    useGenerationStore.getState().currentPromptId === promptId
                  ) {
                    setCurrentPromptId(null);
                  }
                }
              } else {
                activePromptId.current = promptId;
                // Look up the node's class_type from the run's workflowNodeClassMap
                // Read current state to avoid stale closure over `runs`
                const { runWithJob, job } = getJobProgressContext(promptId);
                const nodeId = String(data.node);
                const classType = runWithJob?.workflowNodeClassMap?.[nodeId];
                const label = classType
                  ? getNodeLabel(classType)
                  : `Node ${nodeId}`;
                // The store bumps completedNodes when the node changes; use
                // the post-transition count so the bar never dips.
                const prevNode = job?.currentNode;
                const completed =
                  (job?.completedNodes ?? 0) +
                  (prevNode !== undefined && prevNode !== nodeId ? 1 : 0);
                setJobStatus(
                  promptId,
                  "running",
                  calculateNodeProgress(promptId, 0, completed),
                  nodeId,
                  label,
                  undefined,
                );
              }
            }
            break;

          case "progress":
            // Step progress within a node
            if (
              data.prompt_id &&
              data.value !== undefined &&
              data.max !== undefined
            ) {
              const nodeFraction =
                data.max > 0
                  ? Math.max(0, Math.min(1, data.value / data.max))
                  : 0;
              const progress =
                calculateNodeProgress(data.prompt_id, nodeFraction) ??
                Math.round(nodeFraction * 100);
              setJobStatus(
                data.prompt_id,
                "running",
                progress,
                undefined,
                undefined,
                {
                  current: data.value,
                  total: data.max,
                },
              );
            }
            break;

          case "executed":
            // Node finished (not full workflow - don't rely on this for completion)
            break;

          case "execution_cached":
            // ComfyUI reports cache-skipped nodes, not workflow completion.
            if (data.prompt_id) {
              console.log(`[ComfyWS] Execution cached: ${data.prompt_id}`);
              const cachedData = data as typeof data & {
                nodes?: Array<string | number>;
              };
              const cachedNodes = cachedNodesByPrompt.current.get(
                data.prompt_id,
              );
              const nextCachedNodes = cachedNodes ?? new Set<string>();
              const nodes = Array.isArray(cachedData.nodes)
                ? cachedData.nodes
                : [];
              for (const node of nodes) {
                nextCachedNodes.add(String(node));
              }
              cachedNodesByPrompt.current.set(data.prompt_id, nextCachedNodes);
              setJobStatus(
                data.prompt_id,
                "running",
                calculateNodeProgress(data.prompt_id),
              );
            }
            break;

          case "execution_error":
            // Error during execution
            if (data.prompt_id) {
              const promptId = data.prompt_id as string;
              const evt = data as unknown as ExecutionEventData;
              console.error(
                `[ComfyWS] Execution error: ${promptId}`,
                evt.exception_message,
              );
              cachedNodesByPrompt.current.delete(promptId);
              if (activePromptId.current === promptId) {
                activePromptId.current = null;
              }
              livePreviews.clear(promptId);
              setCurrentPromptId(null);
              // Show immediately with the node type, then upgrade to the
              // node title once the server tells us.
              const quick = describeExecutionError(evt);
              setJobError(promptId, quick.message);
              setError(`Generation failed: ${quick.message}`);
              void fetchPromptTitles(promptId).then((titles) => {
                if (Object.keys(titles).length === 0) return;
                const full = describeExecutionError(evt, titles);
                setJobError(promptId, full.message);
                setError(`Generation failed: ${full.message}`);
              });
            }
            break;

          case "execution_interrupted":
            // User/API interrupt: a cancellation, not a failure
            if (data.prompt_id) {
              const promptId = data.prompt_id as string;
              cachedNodesByPrompt.current.delete(promptId);
              if (activePromptId.current === promptId) {
                activePromptId.current = null;
              }
              livePreviews.clear(promptId);
              cancelJob(promptId);
              setCurrentPromptId(null);
              void fetchPromptTitles(promptId).then((titles) => {
                console.log(
                  `[ComfyWS] ${describeExecutionInterrupted(data as unknown as ExecutionEventData, titles).message}`,
                );
              });
            }
            break;

          case "execution_success":
            // Full workflow completed successfully
            if (data.prompt_id) {
              console.log(`[ComfyWS] Execution success: ${data.prompt_id}`);
              cachedNodesByPrompt.current.delete(data.prompt_id);
              setJobStatus(data.prompt_id, "done", 100, null, null, null);
              setCurrentPromptId(null);
              fetchCompletedImagesOnce(data.prompt_id);
            }
            break;

          default:
            console.debug(`[ComfyWS] Unknown message type: ${type}`, data);
        }
      } catch (error) {
        console.error("[ComfyWS] Failed to parse message:", error);
      }
    },
    [
      setQueueRemaining,
      setCurrentPromptId,
      setJobStatus,
      setJobError,
      cancelJob,
      setError,
      handleBinary,
      fetchCompletedImagesOnce,
      getJobProgressContext,
      calculateNodeProgress,
    ],
  );

  const connect = useCallback(() => {
    // Cancel any pending deferred close BEFORE the live-socket guard.
    // Under React StrictMode (mount → cleanup → mount) the second mount's
    // connect() hits the early return below while the first cleanup's
    // deferred closeNow is still armed with isIntentionalClose=true — the
    // live socket would be reaped 100ms after opening with no reconnect.
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current);
      closeTimeout.current = null;
    }
    isIntentionalClose.current = false;

    const wsBaseUrl = resolveWebSocketBaseUrl();
    const wsUrl = `${wsBaseUrl}/ws?clientId=${clientId}`;

    // Already connected/connecting for THIS clientId. A lease on an older id
    // (the duplicate-tab guard reset it mid-handshake) is replaced below,
    // otherwise the socket would stay registered under the stale id.
    if (
      wsRef.current?.url === wsUrl &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    console.log(`[ComfyWS] Connecting to ${wsUrl}`);

    try {
      // Shared per tab and URL: a remount or a second consumer reuses the
      // same socket instead of opening another one with the same clientId
      // (ComfyUI would deliver each job's events to only one of them). The
      // pool sets binaryType and sends the feature_flags handshake (opts into
      // PREVIEW_IMAGE_WITH_METADATA) as the socket's first message.
      if (wsRef.current) wsRef.current.release();
      const ws = acquireComfySocket(wsUrl);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        console.log("[ComfyWS] Connected");
        setWsConnected(true);
        setWsReconnecting(false);
        setComfyReachable(true);
        setError(null);

        // Don't reset the attempt counter immediately: a server that accepts
        // the handshake then drops right away (e.g. origin validation) would
        // otherwise loop forever at minimum backoff. Only treat the
        // connection as healthy after it has stayed open for a while.
        if (stabilityTimeout.current) {
          clearTimeout(stabilityTimeout.current);
        }
        stabilityTimeout.current = setTimeout(() => {
          stabilityTimeout.current = null;
          reconnectAttempts.current = 0;
        }, STABLE_CONNECTION_MS);

        onConnectRef.current?.();

        // Events sent while the socket was down (or before it subscribed)
        // are gone: catch every pending job up from queue + history now.
        void reconcilePending();

        // Heartbeat: browser WebSockets handle keepalive natively,
        // so no explicit ping is needed. The interval reference is
        // kept for potential future use but not started.

        if (reachabilityInterval.current) {
          clearInterval(reachabilityInterval.current);
        }
        reachabilityInterval.current = setInterval(() => {
          void checkReachability();
        }, REACHABILITY_CHECK_MS);
      };

      ws.onclose = (event) => {
        console.log(
          `[ComfyWS] Disconnected: code=${event.code}, reason=${event.reason}`,
        );
        // A socket we already replaced or deliberately closed (closeNow nulls
        // wsRef; reconnect() then opens a fresh one). Its close event arrives
        // asynchronously and must not clobber the live socket's state.
        if (wsRef.current !== ws) return;
        setWsConnected(false);
        onDisconnectRef.current?.();

        // Connection didn't survive long enough to be considered stable —
        // keep the current attempt counter so backoff grows across rapid
        // open/close cycles.
        if (stabilityTimeout.current) {
          clearTimeout(stabilityTimeout.current);
          stabilityTimeout.current = null;
        }

        if (heartbeatInterval.current) {
          clearInterval(heartbeatInterval.current);
          heartbeatInterval.current = null;
        }

        if (reachabilityInterval.current) {
          clearInterval(reachabilityInterval.current);
          reachabilityInterval.current = null;
        }

        // Attempt reconnection if not intentional
        if (!isIntentionalClose.current && enabled) {
          if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
            setWsReconnecting(true);
            reconnectAttempts.current++;
            const delay =
              RECONNECT_DELAY_MS * Math.min(reconnectAttempts.current, 5);
            console.log(
              `[ComfyWS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`,
            );
            reconnectTimeout.current = setTimeout(connect, delay);
          } else {
            console.warn(
              "[ComfyWS] Max reconnection attempts reached, falling back to HTTP polling",
            );
            setWsReconnecting(false);
            if (reachabilityInterval.current) {
              clearInterval(reachabilityInterval.current);
            }
            reachabilityInterval.current = setInterval(() => {
              void pollJobStatus();
              // ComfyUI restarts take longer than the fast retry budget
              // (~12s). Once HTTP says it's back, retry the socket instead of
              // staying on polling until reload. Only a one-retry budget: the
              // counter returns to 0 solely via the stability window, so a
              // server that serves HTTP but drops the WS can't loop fast.
              void checkReachability().then((reachable) => {
                if (
                  reachable &&
                  !isIntentionalClose.current &&
                  wsRef.current === ws
                ) {
                  reconnectAttempts.current = MAX_RECONNECT_ATTEMPTS - 1;
                  connect();
                }
              });
            }, REACHABILITY_CHECK_MS);
            // Don't show error if we can still reach ComfyUI via HTTP
            void checkReachability().then((reachable) => {
              if (!reachable) {
                setError(
                  "Lost connection to ComfyUI. Please check if it's running.",
                );
                addError({
                  message: "WebSocket disconnected and ComfyUI unreachable",
                  category: "network",
                });
              }
            });
          }
        }
      };

      ws.onerror = (event) => {
        if (wsRef.current !== ws) return;
        // A dropped/refused socket is an expected network condition (ComfyUI
        // restarting or not started yet) that the reconnect + reachability
        // logic below handles and the UI surfaces as "Disconnected". Use warn,
        // not error: Next dev turns every console.error into an overlay issue.
        console.warn("[ComfyWS] Socket error:", event.type);
        onErrorRef.current?.(event);
        // Check reachability to determine if ComfyUI is down
        void checkReachability();
      };

      ws.onmessage = handleMessage;

      wsRef.current = ws;
    } catch (error) {
      console.error("[ComfyWS] Failed to create WebSocket:", error);
      setError("Failed to connect to ComfyUI");
    }
  }, [
    clientId,
    enabled,
    handleMessage,
    setWsConnected,
    setWsReconnecting,
    setError,
    setComfyReachable,
    addError,
    checkReachability,
    pollJobStatus,
    reconcilePending,
  ]);

  const closeNow = useCallback(
    (reason: string, linger = false) => {
      if (closeTimeout.current) {
        clearTimeout(closeTimeout.current);
        closeTimeout.current = null;
      }

      if (wsRef.current) {
        // Releasing a lease never kills a socket another lease still holds;
        // the pool closes it (cleanly, even mid-handshake) once unused.
        const remaining = wsRef.current.release({ linger });
        wsRef.current = null;
        console.log(`[ComfyWS] Released socket (${reason})`);
        // Another holder (e.g. the remounted hook) keeps it connected.
        if (remaining > 0) return;
      }

      setWsConnected(false);
      setWsReconnecting(false);
    },
    [setWsConnected, setWsReconnecting],
  );

  const disconnect = useCallback(() => {
    isIntentionalClose.current = true;

    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }

    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }

    if (reachabilityInterval.current) {
      clearInterval(reachabilityInterval.current);
      reachabilityInterval.current = null;
    }

    if (stabilityTimeout.current) {
      clearTimeout(stabilityTimeout.current);
      stabilityTimeout.current = null;
    }

    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current);
      closeTimeout.current = null;
    }

    closeTimeout.current = setTimeout(() => {
      // Linger: a remount within the pool's window reuses the open socket.
      closeNow("Client disconnect", true);
    }, 100);
  }, [closeNow]);

  const reconnect = useCallback(() => {
    isIntentionalClose.current = false;
    reconnectAttempts.current = 0;
    closeNow("Client reconnect");
    setTimeout(connect, 100);
  }, [closeNow, connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (enabled) {
      isIntentionalClose.current = false;
      connect();
    }

    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  // Video-backend runs: poll their history even while the WS is connected.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const pending = useGenerationStore
        .getState()
        .runs.some(
          (r) =>
            isVideoBackendRun(r) &&
            r.jobs.some((j) => j.status === "running" || j.status === "queued"),
        );
      if (pending) void pollJobStatus(isVideoBackendRun);
    }, VIDEO_BACKEND_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, pollJobStatus]);

  // Pending prompts silent on the WS for WS_SILENCE_STALE_MS: poll history
  // until they finish, so a job whose events went elsewhere never hangs.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const pending: string[] = [];
      for (const run of useGenerationStore.getState().runs) {
        if (isVideoBackendRun(run)) continue; // polled above
        for (const job of run.jobs) {
          if (
            job.prompt_id &&
            (job.status === "running" || job.status === "queued")
          ) {
            pending.push(job.prompt_id);
          }
        }
      }
      const stale = promptWatchdog.current.stale(pending);
      if (stale.length > 0) {
        void pollJobStatus((r) => !isVideoBackendRun(r), new Set(stale));
      }
    }, WS_SILENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, pollJobStatus]);

  // Slow reconcile while anything is pending (any socket state): the
  // safety net that keeps tiles from pulsing forever.
  useEffect(() => {
    if (!enabled) return;
    void reconcilePending();
    const timer = setInterval(() => {
      const pending = useGenerationStore
        .getState()
        .runs.some((r) =>
          r.jobs.some((j) => j.status === "running" || j.status === "queued"),
        );
      if (pending) void reconcilePending();
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, reconcilePending]);

  // A duplicated tab inherits this tab's sessionStorage clientId; whichever
  // tab hears its id announced by another moves to a fresh one.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    return guardTabClientId(
      () => useGenerationStore.getState().clientId,
      () => {
        console.log("[ComfyWS] clientId in use by another tab; picking a new one");
        useGenerationStore.getState().resetClientId();
      },
    );
  }, [enabled]);

  // Re-connect when clientId changes
  useEffect(() => {
    if (enabled && wsRef.current?.readyState === WebSocket.OPEN) {
      reconnect();
    }
  }, [clientId, enabled, reconnect]);

  return {
    connect,
    disconnect,
    reconnect,
    isConnected: useGenerationStore((s) => s.wsConnected),
    isReconnecting: useGenerationStore((s) => s.wsReconnecting),
  };
}

export default useComfyWS;
