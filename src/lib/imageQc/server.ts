/**
 * Ideogram 4 safety-filter check, server side: decodes a finished image
 * output of an Ideogram job, flags a blank canvas on the job's QC record
 * (jobs.qc, shared with video QC) and re-rolls the job once with a new seed.
 */
import { getDB } from "@/lib/db";
import { fetchImageResponse } from "@/lib/comfy/http";
import { extractOutputs } from "@/lib/comfy/outputs";
import { withLock } from "@/lib/locks";
import {
  COMFY_VIEW_TYPES,
  validateViewRef,
  type ComfyViewType,
} from "@/lib/videoEdit/sourceRef";
import { redactPaths } from "@/lib/videoEdit/server";
import { worstStatus } from "@/lib/videoQc/qc";
import {
  graphOf,
  historyFor,
  outputKey,
  readJobQc,
  rerollJob,
  updateJobQc,
  type QcVideoRef,
} from "@/lib/videoQc/server";
import type { ComfyHistoryEntry } from "@/types";
import {
  blankCanvasStats,
  isBlankCanvas,
  isIdeogramGraph,
  SAFETY_FILTER_MESSAGE,
  shouldAutoRerollBlank,
} from "./blank";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const SAMPLE = 96;
const MAX_BYTES = 64 * 1024 * 1024;

export function toImageRef(
  filename: unknown,
  subfolder: unknown,
  type: unknown,
): QcVideoRef | null {
  const ref = validateViewRef(filename, subfolder ?? "");
  if (!ref || !IMAGE_EXT.test(ref.filename)) return null;
  const t = (type ?? "output") as ComfyViewType;
  if (!COMFY_VIEW_TYPES.includes(t)) return null;
  return { ...ref, type: t };
}

type SharpFn = typeof import("sharp");

async function loadSharp(): Promise<SharpFn> {
  const mod = (await import("sharp")) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}

/** Nearest-neighbour sample keeps per-pixel noise (averaging would hide it). */
async function imageIsBlank(ref: QcVideoRef): Promise<boolean> {
  const res = await fetchImageResponse(ref.filename, ref.subfolder, ref.type);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return false;
  const sharp = await loadSharp();
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .resize(SAMPLE, SAMPLE, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return isBlankCanvas(blankCanvasStats(data, info.channels));
}

function promptIdOf(jobId: string): string | null | undefined {
  const row = getDB()
    .prepare("SELECT prompt_id_comfy FROM jobs WHERE id = ?")
    .get(jobId) as { prompt_id_comfy: string | null } | undefined;
  return row ? row.prompt_id_comfy : undefined;
}

const inFlight = new Map<string, Promise<void>>();
const autoRerolled = new Set<string>();

export function isBlankCheckRunning(jobId: string): boolean {
  for (const k of inFlight.keys()) if (k.startsWith(`${jobId}|`)) return true;
  return false;
}

/**
 * Check one image output of a job in the background. No-op unless the
 * job's graph is Ideogram 4 and the image is one of its outputs. `history`
 * skips the lookup when the caller already has it.
 */
export function scheduleBlankCheck(
  jobId: string,
  ref: QcVideoRef,
  opts: { history?: ComfyHistoryEntry | null; force?: boolean } = {},
): Promise<void> {
  const key = `${jobId}|${outputKey(ref)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = runBlankCheck(jobId, ref, opts)
    .catch(() => undefined)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function runBlankCheck(
  jobId: string,
  ref: QcVideoRef,
  opts: { history?: ComfyHistoryEntry | null; force?: boolean },
): Promise<void> {
  const okey = outputKey(ref);
  if (!opts.force && readJobQc(jobId)?.outputs?.[okey]) return;
  const promptId = promptIdOf(jobId);
  if (promptId === undefined) return;
  const history = opts.history ?? (await historyFor(promptId));
  if (!history || !isIdeogramGraph(graphOf(history))) return;
  const own = extractOutputs(history).some(
    (o) =>
      o.view &&
      o.view.filename === ref.filename &&
      (o.view.subfolder ?? "") === ref.subfolder,
  );
  if (!own) return;

  const blank = await imageIsBlank(ref);
  const qc = await withLock(`image-qc:${jobId}`, async () =>
    updateJobQc(jobId, (q) => {
      q.outputs[okey] = {
        status: blank ? "fail" : "pass",
        issues: blank
          ? [
              {
                kind: "safety_filter",
                severity: "fail",
                message: SAFETY_FILTER_MESSAGE,
              },
            ]
          : [],
        video: ref,
        checkedAt: Date.now(),
      };
      q.status = worstStatus(Object.values(q.outputs).map((o) => o.status));
    }),
  );

  const already =
    autoRerolled.has(jobId) || (qc.rerolls ?? []).some((r) => r.auto);
  if (!shouldAutoRerollBlank(blank, qc.attempt, already)) return;
  autoRerolled.add(jobId);
  try {
    await rerollJob(jobId, { auto: true });
  } catch (e) {
    const msg = redactPaths(e instanceof Error ? e.message : String(e));
    updateJobQc(jobId, (q) => {
      q.error = `Auto re-roll failed: ${msg}`;
    });
  }
}
