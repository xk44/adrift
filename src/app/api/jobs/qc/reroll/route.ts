/**
 * Re-roll a job (admin): requeue its own ComfyUI graph with new seeds.
 *
 *   POST { job_id, client_id?, segment? } -> { ok, run, jobId, rerolledJobId, segment?, seed }
 *
 * `segment: true` on a stitched clip re-rolls only the source clip under
 * its worst QC issue (the stitch itself is not redone).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { redactPaths } from "@/lib/videoEdit/server";
import { rerollJob, VideoQcError } from "@/lib/videoQc/server";

export const dynamic = "force-dynamic";

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const jobId = typeof b?.job_id === "string" ? b.job_id : "";
  if (!JOB_ID_RE.test(jobId))
    return NextResponse.json({ ok: false, error: "job_id is required" }, { status: 400 });
  const clientId =
    typeof b.client_id === "string" && CLIENT_ID_RE.test(b.client_id)
      ? b.client_id
      : undefined;
  try {
    const r = await rerollJob(jobId, { clientId, segment: b.segment === true });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const status = e instanceof VideoQcError ? e.status : 502;
    const msg = redactPaths(e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
