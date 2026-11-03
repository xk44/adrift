/**
 * Post-render video QC for one job (admin).
 *
 *   GET  ?job_id=&video=<view url>[&kick=0]  -> { ok, qc, running, enabled }
 *        A video with no verdict yet gets one queued (live jobs finish over
 *        the WebSocket before /recent records them; the runner checks the
 *        video is one of the job's outputs in ComfyUI history);
 *        kick=0 only reads (gallery thumbnails, so scrolling history doesn't
 *        queue a QC pass per old clip).
 *   POST { job_id, video, force? }  -> { ok, running } re-checks a video.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readVideoQcSettings } from "@/lib/runtimeSettings";
import { parseSourceUrl } from "@/lib/videoEdit/sourceRef";
import {
  isQcRunning,
  jobQcState,
  outputKey,
  scheduleVideoQc,
  type QcVideoRef,
} from "@/lib/videoQc/server";
import { resolveVideoQcSettings } from "@/lib/videoQc/settings";

export const dynamic = "force-dynamic";

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/;

const bad = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status });

function videoRef(raw: unknown): QcVideoRef | null {
  const ref = parseSourceUrl(raw);
  return ref?.kind === "comfy"
    ? { filename: ref.filename, subfolder: ref.subfolder, type: ref.type }
    : null;
}

function enabled(): boolean {
  try {
    return resolveVideoQcSettings(readVideoQcSettings()).enabled;
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 600 });
  if (!rl.ok) return rl.response;
  const jobId = req.nextUrl.searchParams.get("job_id") ?? "";
  if (!JOB_ID_RE.test(jobId)) return bad("job_id is required");
  const state = jobQcState(jobId);
  if (!state) return bad("job not found", 404);
  const on = enabled();
  const rawVideo = req.nextUrl.searchParams.get("video");
  const ref = rawVideo ? videoRef(rawVideo) : null;
  if (rawVideo && !ref) return bad("video must be a ComfyUI video URL");
  if (
    on &&
    ref &&
    req.nextUrl.searchParams.get("kick") !== "0" &&
    state.status !== "error" &&
    !state.qc?.outputs?.[outputKey(ref)] &&
    !isQcRunning(jobId)
  )
    void scheduleVideoQc(jobId, ref).catch(() => {});
  return NextResponse.json({
    ok: true,
    qc: state.qc,
    running: isQcRunning(jobId),
    enabled: on,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }
  const jobId = typeof b?.job_id === "string" ? b.job_id : "";
  if (!JOB_ID_RE.test(jobId)) return bad("job_id is required");
  const ref = videoRef(b.video);
  if (!ref) return bad("video must be a ComfyUI video URL");
  if (!jobQcState(jobId)) return bad("job not found", 404);
  if (!enabled()) return bad("Video QC is turned off in Settings", 409);
  void scheduleVideoQc(jobId, ref, { force: b.force === true }).catch(() => {});
  return NextResponse.json({ ok: true, running: true });
}
