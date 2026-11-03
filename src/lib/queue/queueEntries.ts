/**
 * Global job queue view: flattens the generation store's runs into the rows
 * the queue drawer shows (running + queued now, then recent finished/failed).
 *
 * Every Create, Tools and Edit submission lands in `useGenerationStore.runs`
 * via addRun, so this is the single source. Where a run came from:
 *   - "edit"   : the image or video editor is waiting on it (its toolRuns)
 *   - "tools"  : the job route stamped a tool provenance on params
 *   - "create" : a prompt or a feed action (vary, upscale, ...)
 * Edit runs come back into the editor; everything else shows as a row at the
 * top of the Create feed, so only those get "jump to".
 *
 * "Upscale after" chains (lib/upscale/upscaleAfter.ts) link an upscale run
 * to the tool run it follows, and a chain still waiting on its tool shows as
 * a queued row of its own.
 */

import type { ImagineJob, ImagineRun, JobStatus } from "@/types";
import { runProvenance } from "@/lib/runProvenance";
import {
  chainLabel,
  upscaleAfterMedia,
  type UpscaleChain,
} from "@/lib/upscale/upscaleAfter";

export type QueueSource = "create" | "tools" | "edit";

export interface QueueEntry {
  /** `${runId}:${jobIndex}`, stable across ticks. */
  key: string;
  runId: string;
  jobIndex: number;
  promptId?: string;
  status: JobStatus;
  /** 0–100. */
  progress: number;
  source: QueueSource;
  /** Tool label, or "Prompt" for a plain prompt run. */
  label: string;
  /** Prompt text to show (may be empty for tool runs without one). */
  prompt: string;
  /** Finished output or the run's source image. Never a live preview. */
  thumb?: string;
  /** True when the finished output is a video/audio/mesh (no image thumb). */
  mediaKind?: "video" | "audio" | "mesh";
  nodeLabel?: string;
  error?: string;
  /** Sort time: completedAt for finished rows, run creation otherwise. */
  at: number;
  /** Plain prompt run: can be re-submitted from its prompt. */
  retryable: boolean;
  /** Shows as a row on the Create page. */
  jumpable: boolean;
  /** Tool run this "Upscale after" job follows (its label). */
  after?: string;
  /** "Upscale after" not queued yet: waits on `after` (runId = parent). */
  waiting?: boolean;
}

export interface QueueSnapshot {
  active: QueueEntry[];
  recent: QueueEntry[];
}

export const RECENT_QUEUE_LIMIT = 8;

const ACTIVE: ReadonlySet<JobStatus> = new Set(["queued", "running"]);
const TERMINAL: ReadonlySet<JobStatus> = new Set([
  "done",
  "error",
  "cancelled",
]);

function runTime(run: ImagineRun): number {
  const t = Date.parse(run.createdAt);
  return Number.isFinite(t) ? t : 0;
}

export function queueSourceOf(
  run: Pick<ImagineRun, "run_id" | "params">,
  editRunIds: ReadonlySet<string>,
): QueueSource {
  if (editRunIds.has(run.run_id)) return "edit";
  return runProvenance(run.params)?.kind === "tool" ? "tools" : "create";
}

function firstImageThumb(run: ImagineRun, job: ImagineJob): string | undefined {
  if (job.images.length > 0) return job.images[0];
  return run.sourceImage ?? run.sourceImages?.[0]?.url ?? undefined;
}

function mediaKindOf(job: ImagineJob): QueueEntry["mediaKind"] {
  if (job.images.length > 0) return undefined;
  if (job.videos?.length) return "video";
  if (job.audios?.length) return "audio";
  if (job.meshes?.length) return "mesh";
  return undefined;
}

export function toQueueEntry(
  run: ImagineRun,
  job: ImagineJob,
  editRunIds: ReadonlySet<string>,
): QueueEntry {
  const source = queueSourceOf(run, editRunIds);
  const provenance = runProvenance(run.params);
  const prompt =
    (job.promptOverride ?? run.parsedPrompt ?? run.prompt ?? "").trim() ||
    (run.prompt ?? "").trim();
  return {
    key: `${run.run_id}:${job.index}`,
    runId: run.run_id,
    jobIndex: job.index,
    promptId: job.prompt_id,
    status: job.status,
    progress: Math.max(0, Math.min(100, Math.round(job.progress || 0))),
    source,
    label: provenance?.label || (source === "edit" ? "Edit" : "Prompt"),
    prompt,
    thumb: firstImageThumb(run, job),
    mediaKind: mediaKindOf(job),
    nodeLabel: job.currentNodeLabel,
    error: job.error,
    at:
      TERMINAL.has(job.status) && job.completedAt
        ? job.completedAt
        : runTime(run),
    retryable:
      source === "create" && provenance === null && run.prompt.trim() !== "",
    jumpable: source !== "edit",
  };
}

/**
 * Running jobs first, then queued ones oldest-first (submission order);
 * after that up to `recentLimit` finished/failed/cancelled jobs from this
 * session, newest first. Runs hydrated from server history are skipped:
 * they are the feed's past, not this queue's.
 */
export function buildQueueSnapshot(
  runs: readonly ImagineRun[],
  editRunIds: ReadonlySet<string> = new Set(),
  recentLimit = RECENT_QUEUE_LIMIT,
  chains: Readonly<Record<string, UpscaleChain>> = {},
): QueueSnapshot {
  const active: QueueEntry[] = [];
  const recent: QueueEntry[] = [];
  const parentOf = new Map<string, string>();
  for (const c of Object.values(chains))
    for (const id of c.children) parentOf.set(id, c.parentLabel);
  const entry = (run: ImagineRun, job: ImagineJob) => {
    const e = toQueueEntry(run, job, editRunIds);
    const after = parentOf.get(run.run_id);
    return after ? { ...e, after } : e;
  };
  for (const run of runs) {
    if (run.historySource === "server") continue;
    for (const job of run.jobs) {
      if (ACTIVE.has(job.status)) active.push(entry(run, job));
      else if (TERMINAL.has(job.status)) recent.push(entry(run, job));
    }
  }
  active.sort(
    (a, b) =>
      Number(b.status === "running") - Number(a.status === "running") ||
      a.at - b.at ||
      a.jobIndex - b.jobIndex,
  );
  recent.sort((a, b) => b.at - a.at || a.jobIndex - b.jobIndex);
  // Not in ComfyUI's queue yet, so after everything that is.
  const waiting = Object.values(chains)
    .filter((c) => c.status === "waiting")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const c of waiting) {
    const media = upscaleAfterMedia(c.cardKey) ?? "image";
    active.push({
      key: `chain:${c.parentRunId}`,
      runId: c.parentRunId,
      jobIndex: 0,
      status: "queued",
      progress: 0,
      source: "tools",
      label: chainLabel(c.factor, media),
      prompt: "",
      ...(media === "video" ? { mediaKind: "video" as const } : {}),
      at: c.createdAt,
      retryable: false,
      jumpable: false,
      after: c.parentLabel,
      waiting: true,
    });
  }
  return { active, recent: recent.slice(0, Math.max(0, recentLimit)) };
}

/** Run ids the image/video editor is waiting on (results return there). */
export function editRunIdSet(
  editorRuns: readonly { runId: string; origin?: string }[],
  videoRuns: readonly { runId: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const r of editorRuns) if (r.origin !== "tool") ids.add(r.runId);
  for (const r of videoRuns) ids.add(r.runId);
  return ids;
}

/** True when the session has any queue rows (active or recent). */
export function hasQueueActivity(runs: readonly ImagineRun[]): boolean {
  return runs.some(
    (r) =>
      r.historySource !== "server" &&
      r.jobs.some((j) => ACTIVE.has(j.status) || TERMINAL.has(j.status)),
  );
}
