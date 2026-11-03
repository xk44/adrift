/**
 * Post-render video QC, server side: runs ffprobe + one ffmpeg detection
 * pass on a finished video output, stores the verdict on its job
 * (jobs.qc_status / jobs.qc), and re-rolls a job by requeueing its own
 * ComfyUI graph with new seeds. Everything here is fire-and-forget from the
 * caller's point of view: a result is never held back for QC.
 */
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import {
  findJobIdForOutput,
  getDB,
  getOutputsByJob,
  insertJob,
  insertRun,
  recordOutputOnce,
  updateJobStatus,
} from "@/lib/db";
import { fetchHistory, queuePrompt } from "@/lib/comfy/http";
import { fetchHistoryAnyBackend } from "@/lib/comfy/warmBackend";
import { knownPromptBackend } from "@/lib/comfy/backends";
import { extractOutputs, type ComfyOutputKind } from "@/lib/comfy/outputs";
import { withLock } from "@/lib/locks";
import { scheduleBlankCheck, toImageRef } from "@/lib/imageQc/server";
import { readVideoQcSettings } from "@/lib/runtimeSettings";
import {
  findBinary,
  localSourcePath,
  probeFile,
  redactPaths,
} from "@/lib/videoEdit/server";
import {
  COMFY_VIEW_TYPES,
  validateViewRef,
  VIDEO_SOURCE_EXT,
  type ComfyViewType,
} from "@/lib/videoEdit/sourceRef";
import type { ComfyHistoryEntry, ImagineRun } from "@/types";
import {
  badSegment,
  buildQcArgs,
  evaluateQc,
  expectationsFromGraph,
  expectationsFromParams,
  mergeExpect,
  parseQcStderr,
  reseedGraph,
  shouldAutoReroll,
  worstStatus,
  type QcExpect,
  type QcProbe,
  type QcResult,
  type QcStatus,
} from "./qc";
import {
  resolveVideoQcSettings,
  type VideoQcSettings,
  type VideoQcThresholds,
} from "./settings";

export interface QcVideoRef {
  filename: string;
  subfolder: string;
  type: ComfyViewType;
}

export interface StoredOutputQc extends QcResult {
  video: QcVideoRef;
  checkedAt: number;
  /** Stitched clip: 0-based source clip under the worst timed issue. */
  segment?: number;
}

export interface QcReroll {
  jobId: string;
  runId: string;
  at: number;
  auto: boolean;
  /** Stitch segment (0-based clip index) re-rolled instead of the whole clip. */
  segment?: number;
}

export interface JobQc {
  version: 1;
  status: QcStatus | "pending" | "error";
  /** 1 = the original render; each re-roll adds one. */
  attempt: number;
  rerollOf?: string;
  rerolls?: QcReroll[];
  outputs: Record<string, StoredOutputQc>;
  error?: string;
}

export class VideoQcError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

/**
 * Identity / face drift hook. Adrift has no in-process image embedder
 * (CLIP vision / face models only run inside ComfyUI graphs), so nothing is
 * registered by default; a provider can add issues for a finished clip.
 */
export type IdentityCheck = (input: {
  file: string;
  probe: QcProbe;
  graph: Record<string, unknown> | null;
}) => Promise<QcResult["issues"]>;

let identityCheck: IdentityCheck | null = null;
export function setIdentityCheck(fn: IdentityCheck | null): void {
  identityCheck = fn;
}

export function outputKey(v: QcVideoRef): string {
  return `${v.type}/${v.subfolder ? `${v.subfolder}/` : ""}${v.filename}`;
}

/** Validated video ref from loose input (route bodies, view URLs). */
export function toVideoRef(
  filename: unknown,
  subfolder: unknown,
  type: unknown,
): QcVideoRef | null {
  const ref = validateViewRef(filename, subfolder ?? "");
  if (!ref || !VIDEO_SOURCE_EXT.test(ref.filename)) return null;
  const t = (type ?? "output") as ComfyViewType;
  if (!COMFY_VIEW_TYPES.includes(t)) return null;
  return { ...ref, type: t };
}

// DB

interface JobRow {
  id: string;
  run_id: string;
  prompt_id_comfy: string | null;
  status: string | null;
  qc_status: string | null;
  qc: string | null;
  params: string | null;
  run_prompt_id: string;
  parsed_prompt: string | null;
  width: number | null;
  height: number | null;
  prompt_text: string | null;
}

function jobRow(jobId: string): JobRow | null {
  return (
    (getDB()
      .prepare(
        `SELECT j.id, j.run_id, j.prompt_id_comfy, j.status, j.qc_status, j.qc,
                r.params, r.prompt_id AS run_prompt_id, r.parsed_prompt,
                r.width, r.height, p.text AS prompt_text
         FROM jobs j
         JOIN runs r ON r.id = j.run_id
         LEFT JOIN prompts p ON p.id = r.prompt_id
         WHERE j.id = ?`,
      )
      .get(jobId) as JobRow | undefined) ?? null
  );
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function paramsOf(row: JobRow): Record<string, unknown> {
  const p = parseJson<unknown>(row.params);
  return p && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}

function emptyQc(): JobQc {
  return { version: 1, status: "pending", attempt: 1, outputs: {} };
}

/** Job status + stored QC, or null when the job doesn't exist. */
export function jobQcState(
  jobId: string,
): { status: string | null; qc: JobQc | null } | null {
  const row = jobRow(jobId);
  return row ? { status: row.status, qc: parseJson<JobQc>(row.qc) } : null;
}

export function readJobQc(jobId: string): JobQc | null {
  const row = jobRow(jobId);
  if (!row) return null;
  return parseJson<JobQc>(row.qc);
}

function writeJobQc(jobId: string, qc: JobQc): void {
  getDB()
    .prepare("UPDATE jobs SET qc_status = ?, qc = ? WHERE id = ?")
    .run(qc.status, JSON.stringify(qc), jobId);
}

/** Read-modify-write under the job's QC lock holder (callers serialize). */
export function updateJobQc(jobId: string, fn: (qc: JobQc) => void): JobQc {
  const qc = readJobQc(jobId) ?? emptyQc();
  fn(qc);
  writeJobQc(jobId, qc);
  return qc;
}

function overallStatus(qc: JobQc): JobQc["status"] {
  const results = Object.values(qc.outputs);
  if (results.length === 0) return qc.error ? "error" : "pending";
  return worstStatus(results.map((r) => r.status));
}

// ffmpeg

const QC_TIMEOUT_MS = 5 * 60_000;
const MAX_STDERR = 4_000_000;

function runForStderr(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, stderr, error: (err as Error).message });
      return;
    }
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        ok: false,
        stderr,
        error: missing
          ? "ffmpeg not found (install ffmpeg or set FFMPEG_PATH)"
          : err.message,
      });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true, stderr }
          : {
              ok: false,
              stderr,
              error: signal ? `killed (${signal})` : `exit ${code}`,
            },
      );
    });
  });
}

/** Probe + detection pass on a local file. Throws VideoQcError. */
export async function analyzeVideoFile(
  file: string,
  t: VideoQcThresholds,
  expect: QcExpect,
  graph: Record<string, unknown> | null = null,
): Promise<QcResult> {
  let probe: QcProbe | null = null;
  try {
    const info = await probeFile(file);
    probe = {
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
    };
  } catch {
    probe = null;
  }
  if (!probe) return evaluateQc(null, emptyDetections(), expect, t);
  const r = await runForStderr(
    findBinary("ffmpeg"),
    buildQcArgs(file, t, probe.hasAudio),
    QC_TIMEOUT_MS,
  );
  if (!r.ok)
    throw new VideoQcError(
      redactPaths(`ffmpeg QC pass failed: ${r.error ?? "unknown error"}`),
      502,
    );
  const result = evaluateQc(
    probe,
    parseQcStderr(r.stderr, probe.duration),
    expect,
    t,
  );
  if (identityCheck) {
    try {
      const extra = await identityCheck({ file, probe, graph });
      if (extra.length > 0) {
        result.issues.push(...extra);
        result.status = worstStatus(result.issues.map((i) => i.severity));
      }
    } catch {
      // Optional check: its failure never fails QC.
    }
  }
  return result;
}

function emptyDetections() {
  return { black: [], freeze: [], jumps: [], silence: [] };
}

// Scheduling

const inFlight = new Map<string, Promise<void>>();

function settings(): VideoQcSettings {
  try {
    return resolveVideoQcSettings(readVideoQcSettings());
  } catch {
    return resolveVideoQcSettings(null);
  }
}

export async function historyFor(
  promptId: string | null,
): Promise<ComfyHistoryEntry | null> {
  if (!promptId) return null;
  try {
    return await fetchHistoryAnyBackend(fetchHistory, promptId);
  } catch {
    return null;
  }
}

export function graphOf(
  history: ComfyHistoryEntry | null,
): Record<string, unknown> | null {
  const g = Array.isArray(history?.prompt) ? history!.prompt[2] : null;
  return g && typeof g === "object" ? g : null;
}

function videoOutputsOf(history: ComfyHistoryEntry | null): QcVideoRef[] {
  if (!history) return [];
  const out: QcVideoRef[] = [];
  for (const o of extractOutputs(history)) {
    if (o.kind !== "video" || !o.view) continue;
    const ref = toVideoRef(o.view.filename, o.view.subfolder, o.view.type);
    if (ref) out.push(ref);
  }
  return out;
}

/** The ref is one of this job's outputs (DB rows first, then history). */
function belongsToJob(
  jobId: string,
  ref: QcVideoRef,
  history: ComfyHistoryEntry | null,
): boolean {
  const rows = getOutputsByJob(jobId) as {
    filename?: string;
    subfolder?: string | null;
  }[];
  if (rows.length > 0)
    return rows.some(
      (r) =>
        r.filename === ref.filename && (r.subfolder ?? "") === ref.subfolder,
    );
  return videoOutputsOf(history).some((v) => outputKey(v) === outputKey(ref));
}

/**
 * QC one video output of a job in the background. Serialized (one ffmpeg
 * pass at a time); a second call for the same output while one runs joins
 * it. `force` re-checks an output that already has a result.
 */
export function scheduleVideoQc(
  jobId: string,
  ref: QcVideoRef,
  opts: { force?: boolean } = {},
): Promise<void> {
  const key = `${jobId}|${outputKey(ref)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = runQcTask(jobId, ref, opts.force === true)
    .catch(() => undefined)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

export function isQcRunning(jobId: string): boolean {
  for (const k of inFlight.keys()) if (k.startsWith(`${jobId}|`)) return true;
  return false;
}

async function runQcTask(
  jobId: string,
  ref: QcVideoRef,
  force: boolean,
): Promise<void> {
  const s = settings();
  if (!s.enabled) return;
  const row = jobRow(jobId);
  if (!row) return;
  const okey = outputKey(ref);
  const existing = parseJson<JobQc>(row.qc);
  if (!force && existing?.outputs?.[okey]) return;

  await withLock("video-qc", async () => {
    const history = await historyFor(row.prompt_id_comfy);
    if (!belongsToJob(jobId, ref, history)) return;
    updateJobQc(jobId, (qc) => {
      if (force) delete qc.outputs[okey];
      qc.status = "pending";
      delete qc.error;
    });
    let result: QcResult;
    const graph = graphOf(history);
    const params = paramsOf(row);
    try {
      const expect = mergeExpect(
        expectationsFromGraph(graph),
        expectationsFromParams(params),
      );
      const file = await localSourcePath({ kind: "comfy", ...ref });
      result = await analyzeVideoFile(file, s, expect, graph);
    } catch (e) {
      const msg = redactPaths(e instanceof Error ? e.message : String(e));
      updateJobQc(jobId, (qc) => {
        qc.error = msg;
        qc.status = overallStatus(qc);
      });
      return;
    }
    const qc = updateJobQc(jobId, (q) => {
      const seg = result.status === "pass" ? null : badSegment(result, params);
      q.outputs[okey] = {
        ...result,
        video: ref,
        checkedAt: Date.now(),
        ...(seg ? { segment: seg.index } : {}),
      };
      q.status = overallStatus(q);
    });
    const alreadyRerolled = (qc.rerolls ?? []).some((r) => r.auto);
    if (shouldAutoReroll(result.status, qc.attempt, s, alreadyRerolled)) {
      void rerollJob(jobId, { auto: true, segment: true }).catch((e) => {
        updateJobQc(jobId, (q) => {
          q.error = `Auto re-roll failed: ${redactPaths(e instanceof Error ? e.message : String(e))}`;
        });
      });
    }
  });
}

// Re-roll

/** "sub/name.mp4 [output]" → view ref (stitch params store clips this way). */
export function parseAnnotatedRef(ref: string): QcVideoRef | null {
  const m = /^(.+?)\s*\[(output|input|temp)\]$/.exec(ref.trim());
  const body = m ? m[1] : ref.trim();
  const slash = body.lastIndexOf("/");
  return toVideoRef(
    slash >= 0 ? body.slice(slash + 1) : body,
    slash >= 0 ? body.slice(0, slash) : "",
    m ? m[2] : "output",
  );
}

export interface RerollResult {
  run: ImagineRun;
  jobId: string;
  rerolledJobId: string;
  segment?: number;
  seed: number | null;
}

/**
 * Requeue a job's own graph (from ComfyUI history) with every literal seed
 * changed, as a new run that shares the original prompt. With `segment`,
 * a stitched clip re-rolls only the source clip under its worst issue.
 */
export async function rerollJob(
  jobId: string,
  opts: { auto?: boolean; clientId?: string; segment?: boolean } = {},
): Promise<RerollResult> {
  const row = jobRow(jobId);
  if (!row) throw new VideoQcError("job not found", 404);
  const qc = parseJson<JobQc>(row.qc) ?? emptyQc();

  let target = row;
  let segment: number | undefined;
  if (opts.segment) {
    const worst = Object.values(qc.outputs).find((o) => o.status !== "pass");
    const seg = worst ? badSegment(worst, paramsOf(row)) : null;
    const ref = seg ? parseAnnotatedRef(seg.video) : null;
    const srcJob = ref ? findJobIdForOutput(ref.filename, ref.subfolder) : null;
    const srcRow = srcJob ? jobRow(srcJob) : null;
    if (seg && srcRow) {
      target = srcRow;
      segment = seg.index;
    }
  }

  const history = await historyFor(target.prompt_id_comfy);
  const graph = graphOf(history);
  if (!history || !graph)
    throw new VideoQcError(
      "ComfyUI no longer has this job's graph (restarted?); use Rerun instead",
      410,
    );
  const reseeded = reseedGraph(graph);
  if (reseeded.changed === 0)
    throw new VideoQcError("This job's graph has no seed to change", 422);

  const extra = (history.prompt[3] ?? {}) as Record<string, unknown>;
  const clientId =
    opts.clientId ??
    (typeof extra.client_id === "string" ? extra.client_id : "adrift-qc");
  const extraData =
    extra.extra_pnginfo && typeof extra.extra_pnginfo === "object"
      ? { extra_pnginfo: extra.extra_pnginfo }
      : undefined;
  const baseUrl = target.prompt_id_comfy
    ? knownPromptBackend(target.prompt_id_comfy)
    : undefined;
  const queued = await queuePrompt(
    reseeded.graph as Parameters<typeof queuePrompt>[0],
    clientId,
    baseUrl,
    { extraData },
  );

  const targetQc =
    target.id === row.id ? qc : (parseJson<JobQc>(target.qc) ?? emptyQc());
  const params: Record<string, unknown> = {
    ...paramsOf(target),
    qcRerollOf: target.id,
  };
  const runId = uuidv4();
  const newJobId = `${runId}:0`;
  const seed = reseeded.seed;
  insertRun(runId, target.run_prompt_id, Object.keys(reseeded.graph).length, {
    parsedPrompt: target.parsed_prompt ?? undefined,
    params,
    width: target.width ?? undefined,
    height: target.height ?? undefined,
  });
  insertJob(newJobId, runId, seed ?? undefined, queued.prompt_id);
  writeJobQc(newJobId, {
    version: 1,
    status: "pending",
    attempt: (targetQc.attempt ?? 1) + 1,
    rerollOf: target.id,
    outputs: {},
  });
  const entry: QcReroll = {
    jobId: newJobId,
    runId,
    at: Date.now(),
    auto: opts.auto === true,
    ...(segment !== undefined ? { segment } : {}),
  };
  for (const id of new Set([row.id, target.id]))
    updateJobQc(id, (q) => {
      q.rerolls = [...(q.rerolls ?? []), entry];
    });
  watchJob(newJobId, queued.prompt_id);

  const prompt = target.prompt_text ?? "";
  const run: ImagineRun = {
    run_id: runId,
    prompt,
    parsedPrompt: target.parsed_prompt ?? prompt,
    width: target.width ?? 0,
    height: target.height ?? 0,
    createdAt: new Date().toISOString(),
    status: "queued",
    params,
    ...(typeof params.action === "string" ? { action: params.action } : {}),
    jobs: [
      {
        seed: seed ?? 0,
        index: 0,
        status: "queued",
        progress: 0,
        images: [],
        prompt_id: queued.prompt_id,
      },
    ],
  };
  return {
    run,
    jobId: newJobId,
    rerolledJobId: target.id,
    seed,
    ...(segment !== undefined ? { segment } : {}),
  };
}

// Watching re-rolled jobs to completion

const DB_OUTPUT_TYPE: Partial<
  Record<ComfyOutputKind, "image" | "video" | "audio" | "mesh">
> = {
  image: "image",
  animated: "image",
  video: "video",
  audio: "audio",
  mesh: "mesh",
};
const WATCH_EVERY_MS = 10_000;
const WATCH_MAX_MS = 90 * 60_000;
const watching = new Set<string>();

/**
 * Poll a re-rolled job's history until it finishes, record its outputs and
 * QC its videos (so an auto re-roll chain proceeds with no page open).
 * In-memory: a server restart drops the watch; /api/jobs/recent still
 * reconciles the job and the badge re-triggers QC.
 */
export function watchJob(jobId: string, promptId: string): void {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  const started = Date.now();
  const tick = async () => {
    try {
      const history = await historyFor(promptId);
      const st = history?.status;
      const statusStr = st?.status_str?.toLowerCase();
      if (st && (st.completed || statusStr === "error")) {
        watching.delete(jobId);
        await finishJob(jobId, history!, statusStr === "success");
        return;
      }
    } catch {
      // Keep polling until the deadline.
    }
    if (Date.now() - started > WATCH_MAX_MS) {
      watching.delete(jobId);
      return;
    }
    setTimeout(() => void tick(), WATCH_EVERY_MS).unref?.();
  };
  setTimeout(() => void tick(), WATCH_EVERY_MS).unref?.();
}

async function finishJob(
  jobId: string,
  history: ComfyHistoryEntry,
  success: boolean,
): Promise<void> {
  const videos: QcVideoRef[] = [];
  const images: QcVideoRef[] = [];
  // Same lock as /api/jobs/recent's reconcile: no duplicate output rows.
  await withLock(`reconcile:${jobId}`, async () => {
    updateJobStatus(
      jobId,
      success ? "done" : "error",
      success ? undefined : history.status?.status_str,
    );
    if (!success) return;
    for (const o of extractOutputs(history)) {
      const kind = DB_OUTPUT_TYPE[o.kind];
      if (!o.view || !kind) continue;
      recordOutputOnce(jobId, o.view.filename, o.view.subfolder, kind);
      if (kind === "video") {
        const ref = toVideoRef(o.view.filename, o.view.subfolder, o.view.type);
        if (ref) videos.push(ref);
      } else if (o.kind === "image") {
        const ref = toImageRef(o.view.filename, o.view.subfolder, o.view.type);
        if (ref) images.push(ref);
      }
    }
  });
  for (const v of videos) void scheduleVideoQc(jobId, v);
  for (const i of images) void scheduleBlankCheck(jobId, i, { history });
}
