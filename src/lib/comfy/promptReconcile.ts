/**
 * Stalled-tile reconciliation: decide what a pending job really is from
 * ComfyUI's queue + history, independent of the WebSocket.
 *
 * WS events can be missed (socket down or reconnecting, page reload, a prompt
 * that finished before the socket subscribed, events routed to another tab or
 * backend, ComfyUI restarted or the prompt deleted from its queue). The client
 * asks /api/comfy/prompt-status for its pending prompt ids on every socket
 * (re)connect and on a slow interval; this module holds the pure parts:
 * classifying a prompt server-side and turning that into a store action
 * client-side. Client-safe: no node imports.
 */
import type { JobStatus } from "@/types";
import {
  describeExecutionError,
  describeExecutionInterrupted,
  extractNodeTitles,
  type ExecutionEventData,
} from "@/lib/comfy/errorMessages";

export type PromptState =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  /** Not in any queue and no history: ComfyUI restarted or it was deleted. */
  | "missing"
  /** Could not tell (a backend's queue was unreadable). */
  | "unknown";

export interface PromptStatus {
  state: PromptState;
  error?: string;
}

/** Merged queue of every backend; null = some backend unreadable. */
export interface QueueSnapshot {
  running: ReadonlySet<string>;
  pending: ReadonlySet<string>;
}

interface HistoryLike {
  prompt?: unknown;
  outputs?: Record<string, unknown>;
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: unknown;
  };
}

function historyMessages(entry: HistoryLike): Array<[string, unknown]> {
  const raw = entry.status?.messages;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is [string, unknown] => Array.isArray(m) && typeof m[0] === "string",
  );
}

/** One ComfyUI history entry → final state. */
export function classifyHistory(entry: HistoryLike): PromptStatus {
  const msgs = historyMessages(entry);
  const graph = Array.isArray(entry.prompt) ? entry.prompt[2] : undefined;
  const titles = extractNodeTitles(graph);
  const interrupted = msgs.find((m) => m[0] === "execution_interrupted");
  if (interrupted)
    return {
      state: "cancelled",
      error: describeExecutionInterrupted(
        (interrupted[1] ?? {}) as ExecutionEventData,
        titles,
      ).message,
    };
  const failed = msgs.find((m) => m[0] === "execution_error");
  const statusStr = entry.status?.status_str?.toLowerCase() ?? "";
  if (failed || statusStr === "error" || statusStr === "failed")
    return {
      state: "error",
      error: failed
        ? describeExecutionError((failed[1] ?? {}) as ExecutionEventData, titles)
            .message
        : "ComfyUI execution failed",
    };
  return { state: "done" };
}

/** Queue + history (either may be missing) → state of one prompt. */
export function classifyPrompt(
  promptId: string,
  queue: QueueSnapshot | null,
  history: HistoryLike | null,
): PromptStatus {
  if (queue?.running.has(promptId)) return { state: "running" };
  if (queue?.pending.has(promptId)) return { state: "queued" };
  if (history) return classifyHistory(history);
  return queue ? { state: "missing" } : { state: "unknown" };
}

/**
 * Run status from its jobs. Any running/queued job keeps the run active; a
 * finished mix resolves (done + cancelled = done, so the done images still
 * reach the gallery; never "stays running" — that was an endless pulse).
 */
export function deriveRunStatus(
  jobs: ReadonlyArray<{ status: JobStatus }>,
  fallback: JobStatus,
): JobStatus {
  if (jobs.length === 0) return fallback;
  if (jobs.some((j) => j.status === "running")) return "running";
  if (jobs.some((j) => j.status === "queued")) return "queued";
  if (jobs.every((j) => j.status === "done")) return "done";
  if (jobs.some((j) => j.status === "error")) return "error";
  if (jobs.every((j) => j.status === "cancelled")) return "cancelled";
  return "done";
}

// ── Client decisions ─────────────────────────────────────────────────────

/**
 * A prompt must look missing this long, over this many checks, before it is
 * dropped (rides out a slow backend probe or a check racing a restart).
 */
export const MISSING_CONFIRM_MS = 20_000;
export const MISSING_CONFIRM_CHECKS = 3;
/** A pending job that never got a prompt id (submit lost) fails after this. */
export const NO_PROMPT_ID_TIMEOUT_MS = 90_000;
export const LOST_JOB_MESSAGE =
  "Lost: ComfyUI no longer has this job (it restarted or the job was removed from the queue).";

export type ReconcileAction =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "fetch" }
  | { kind: "error"; message: string }
  | { kind: "cancel" };

/**
 * Turn one prompt status into a store action. `missing` is when this prompt
 * was first seen missing and how many checks in a row saw it missing
 * (tracked by the caller, cleared once it is seen again).
 */
export function reconcileAction(
  job: { status: JobStatus },
  status: PromptStatus,
  missing: { since: number; count: number } | undefined,
  now: number,
): ReconcileAction {
  if (job.status !== "queued" && job.status !== "running")
    return { kind: "none" };
  switch (status.state) {
    case "running":
      return job.status === "queued" ? { kind: "running" } : { kind: "none" };
    case "done":
      return { kind: "fetch" };
    case "error":
      return { kind: "error", message: status.error ?? "ComfyUI execution failed" };
    case "cancelled":
      return { kind: "cancel" };
    case "missing":
      return missing !== undefined &&
        missing.count >= MISSING_CONFIRM_CHECKS &&
        now - missing.since >= MISSING_CONFIRM_MS
        ? { kind: "error", message: LOST_JOB_MESSAGE }
        : { kind: "none" };
    default:
      return { kind: "none" };
  }
}
