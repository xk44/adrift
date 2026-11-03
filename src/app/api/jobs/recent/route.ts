/**
 * GET /api/jobs/recent — persisted generation history for web and mobile.
 *   ?limit=&offset=  a page of runs, newest first
 *   ?run_id=<id>     just that run (runs: [] when unknown) — the Create
 *                    feed's "from ↗" link resolves a source run that isn't
 *                    in the loaded pages
 */
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiLog, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { fetchHistory } from "@/lib/comfy/http";
import { extractOutputs, type ComfyOutputKind } from "@/lib/comfy/outputs";
import { fetchHistoryAnyBackend } from "@/lib/comfy/warmBackend";
import {
  getOutputsByJob,
  getRecentRunRows,
  getRunRowsById,
  insertOutput,
  recordOutputOnce,
  type RecentRunRow,
  updateJobStatus,
} from "@/lib/db";
import { env } from "@/lib/env";
import { fetchQueuedPromptIds } from "@/lib/comfy/queueState";
import { groupRuns } from "@/lib/jobs/recentRuns";
import { withLock } from "@/lib/locks";
import { ensureUsdz, usdzNameFor } from "@/lib/mesh/usdz";
import { withRateLimit } from "@/lib/rateLimit";
import { graphOf, scheduleVideoQc, toVideoRef } from "@/lib/videoQc/server";
import { isIdeogramGraph } from "@/lib/imageQc/blank";
import { scheduleBlankCheck, toImageRef } from "@/lib/imageQc/server";
import { comfyOutputDir } from "@/lib/paths/resolveDirs";

const MAX_LIMIT = 100;
const MAX_RECONCILE_JOBS = 25;
const DB_OUTPUT_TYPE: Partial<
  Record<ComfyOutputKind, "image" | "video" | "audio" | "mesh">
> = {
  image: "image",
  animated: "image",
  video: "video",
  audio: "audio",
  mesh: "mesh",
};

function parsePageParam(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Export a .usdz next to a freshly recorded GLB and record it as a mesh
 * output of the same job. Fire-and-forget: Blender takes seconds, and the
 * next /recent poll picks the row up. Failures only log — clients can still
 * request the conversion via POST /api/jobs/usdz.
 */
function exportUsdzInBackground(jobId: string, filename: string, subfolder: string): void {
  const outputRoot = comfyOutputDir(env.COMFY_ROOT);
  void ensureUsdz(outputRoot, { filename, subfolder })
    .then((result) => {
      if (!result.ok) {
        apiLog("USDZ", `skip ${filename}: ${result.error}`);
        return;
      }
      recordOutputOnce(jobId, result.usdz.filename, result.usdz.subfolder, "mesh");
    })
    .catch((err: unknown) => {
      apiLog("USDZ", `failed ${filename}: ${String(err)}`);
    });
}

/**
 * Prompt ids ComfyUI currently has queued or running. Best-effort: returns
 * null when the queue can't be read, in which case callers must NOT treat
 * "no history entry" as a lost job.
 */
const LOST_JOB_GRACE_MS = 5 * 60_000;

async function reconcile(rows: RecentRunRow[]): Promise<void> {
  const seen = new Set<string>();
  const pending = rows.filter(
    (row) =>
      row.job_id &&
      row.prompt_id_comfy &&
      (row.job_status === "pending" ||
        row.job_status === "queued" ||
        // Done-but-outputless jobs: outputs are only ever recorded here, so a
        // pass that marked a job done without inserting its files would
        // strand it empty forever. Re-pull history
        // while ComfyUI still remembers it; the `existing` filename check
        // keeps this idempotent.
        (row.job_status === "done" && !row.output_filename)) &&
      !seen.has(row.job_id) &&
      (seen.add(row.job_id), true),
  );

  const queuedIds = pending.length > 0 ? await fetchQueuedPromptIds() : null;

  await Promise.all(
    pending.slice(0, MAX_RECONCILE_JOBS).map(async (row) => {
      // Serialize per job: concurrent pollers both read the stale "queued"
      // status before either writes, and would otherwise insert duplicate
      // output rows. The filename recheck makes the loser a no-op.
      await withLock(`reconcile:${row.job_id}`, async () => {
        try {
          const history = await fetchHistoryAnyBackend(
            fetchHistory,
            row.prompt_id_comfy!,
          );
          if (!history && queuedIds && !queuedIds.has(row.prompt_id_comfy!)) {
            // ComfyUI keeps history in memory: after a restart it forgets
            // prompts entirely. Not in history AND not in the queue means the
            // job can never complete — resolve it instead of wedging "queued".
            if (row.created_at * 1000 < Date.now() - LOST_JOB_GRACE_MS) {
              updateJobStatus(
                row.job_id!,
                "error",
                "lost by backend (ComfyUI restart)",
              );
            }
            return;
          }
          const statusStr = history?.status?.status_str?.toLowerCase();
          // Errored prompts report completed=false with status_str="error" —
          // without this they stay "queued" forever.
          if (
            !history?.status ||
            (!history.status.completed && statusStr !== "error")
          )
            return;
          const status = statusStr === "success" ? "done" : "error";
          updateJobStatus(
            row.job_id!,
            status,
            status === "error" ? history.status.status_str : undefined,
          );
          if (status !== "done") return;
          const existing = new Set(
            getOutputsByJob(row.job_id!).map(
              (output) => (output as { filename?: string }).filename,
            ),
          );
          const ideogram = isIdeogramGraph(graphOf(history));
          // One classifier for every saver (SaveImage/SaveVideo "images",
          // VHS "gifs"/"videos", SaveGLB "3d", SaveAudio "audio", ...).
          // Text/latent outputs have no DB slot and are served live by
          // /api/comfy/history instead.
          for (const output of extractOutputs(history)) {
            if (!output.view) continue;
            const outputType = DB_OUTPUT_TYPE[output.kind];
            if (!outputType) continue;
            const { filename, subfolder } = output.view;
            if (existing.has(filename)) continue;
            existing.add(filename);
            insertOutput(row.job_id!, filename, subfolder, undefined, undefined, outputType);
            if (outputType === "mesh" && usdzNameFor(filename)) {
              exportUsdzInBackground(row.job_id!, filename, subfolder);
            }
            if (outputType === "video") {
              const ref = toVideoRef(filename, subfolder, output.view.type);
              if (ref) void scheduleVideoQc(row.job_id!, ref).catch(() => {});
            }
            if (ideogram && output.kind === "image") {
              const ref = toImageRef(filename, subfolder, output.view.type);
              if (ref) void scheduleBlankCheck(row.job_id!, ref, { history });
            }
          }
        } catch {
          // History is best-effort: return the persisted pending state on failure.
        }
      });
    }),
  );
}

/** Run ids are generated server-side (uuid / prefixed ids). */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Run-level status for shape parity with /api/imagine — clients (iOS)
 * decode it as a required field. Derived from job statuses.
 */
function withRunStatus<R extends { jobs: Array<{ status: string }> }>(
  run: R,
): R & { status: string } {
  const statuses = run.jobs.map((job) => job.status);
  const status = statuses.some((st) => st === "running")
    ? "running"
    : statuses.some((st) => st === "queued")
      ? "queued"
      : statuses.some((st) => st === "error")
        ? "error"
        : statuses.length > 0 && statuses.every((st) => st === "cancelled")
          ? "cancelled"
          : "done";
  return { ...run, status };
}

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const url = new URL(request.url);
  const runId = url.searchParams.get("run_id");
  if (runId !== null) {
    if (!RUN_ID_RE.test(runId)) {
      return apiError("invalid run_id", {
        status: 400,
        headers: apiCorsHeaders(request),
      });
    }
    const rows = getRunRowsById(runId);
    await reconcile(rows);
    const runs = groupRuns(getRunRowsById(runId)).map(withRunStatus);
    return apiOk(
      { runs, nextOffset: null },
      { headers: apiCorsHeaders(request) },
    );
  }

  const rawLimit = parsePageParam(url.searchParams.get("limit"), 20);
  const rawOffset = parsePageParam(url.searchParams.get("offset"), 0);
  if (
    rawLimit === null ||
    rawOffset === null ||
    rawLimit < 1 ||
    rawLimit > MAX_LIMIT
  ) {
    return apiError(
      "limit must be 1-100 and offset must be a non-negative integer",
      {
        status: 400,
        headers: apiCorsHeaders(request),
      },
    );
  }

  const rows = getRecentRunRows(rawLimit + 1, rawOffset);
  const initialRuns = groupRuns(rows);
  const pageRunIds = new Set(
    initialRuns.slice(0, rawLimit).map((run) => run.run_id),
  );
  await reconcile(rows.filter((row) => pageRunIds.has(row.run_id)));
  const runs = groupRuns(getRecentRunRows(rawLimit + 1, rawOffset));
  const hasNext = runs.length > rawLimit;
  const page = runs.slice(0, rawLimit).map(withRunStatus);
  return apiOk(
    { runs: page, nextOffset: hasNext ? rawOffset + rawLimit : null },
    { headers: apiCorsHeaders(request) },
  );
}
