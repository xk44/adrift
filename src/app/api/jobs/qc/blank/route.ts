/**
 * Ideogram safety-filter check for one image output (admin).
 *
 *   GET ?job_id=&image=<proxy/view url>[&kick=0] -> { ok, qc, running }
 *       An image with no verdict yet gets checked (no-op for non-Ideogram
 *       jobs); kick=0 only reads (history tiles).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  isBlankCheckRunning,
  scheduleBlankCheck,
  toImageRef,
} from "@/lib/imageQc/server";
import { jobQcState, outputKey } from "@/lib/videoQc/server";

export const dynamic = "force-dynamic";

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/;

const bad = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status });

function imageRef(raw: string) {
  try {
    const u = new URL(raw, "http://local.invalid");
    return toImageRef(
      u.searchParams.get("filename"),
      u.searchParams.get("subfolder") ?? "",
      u.searchParams.get("type") ?? "output",
    );
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 600 });
  if (!rl.ok) return rl.response;
  const jobId = req.nextUrl.searchParams.get("job_id") ?? "";
  if (!JOB_ID_RE.test(jobId)) return bad("job_id is required");
  const ref = imageRef(req.nextUrl.searchParams.get("image") ?? "");
  if (!ref) return bad("image must be a ComfyUI image URL");
  const state = jobQcState(jobId);
  if (!state) return bad("job not found", 404);
  if (
    req.nextUrl.searchParams.get("kick") !== "0" &&
    state.status !== "error" &&
    !state.qc?.outputs?.[outputKey(ref)]
  )
    void scheduleBlankCheck(jobId, ref);
  return NextResponse.json({
    ok: true,
    qc: state.qc,
    running: isBlankCheckRunning(jobId),
  });
}
