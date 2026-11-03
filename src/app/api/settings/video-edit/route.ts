/**
 * Video editor storage settings (admin).
 *
 *   GET  -> { ok, keepDays, projects, oldestAt }
 *   PUT  { keepDays: null | 30 | 90 | 365 } -> { ok, keepDays }
 *   POST { releaseOlderThanDays: 1..3650 }  -> { ok, released }
 *
 * keepDays is "Keep uploads for saved projects": how long a saved project
 * that is never opened again keeps its uploaded clips safe from the work-dir
 * sweep. null = forever (the default). Saved in data/runtime_settings.json
 * (`videoEditRefDays`), which the sweep reads.
 *
 * POST releases, right now, the projects not opened for that many days: their
 * uploads stay on disk but the sweep may remove them once the work dir is over
 * its size cap. projects / oldestAt describe what is pinned now.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  readVideoEditRefDays,
  writeVideoEditRefDays,
} from "@/lib/runtimeSettings";
import {
  REF_KEEP_DAYS,
  parseRefKeepDays,
  projectRefsSummary,
  releaseStaleProjectRefs,
} from "@/lib/videoEdit/projectRefs";
import { workRoot } from "@/lib/videoEdit/server";

export const dynamic = "force-dynamic";

const DAY = 24 * 3_600_000;
const MAX_RELEASE_DAYS = 3650;

const bad = (error: string) =>
  NextResponse.json({ ok: false, error }, { status: 400 });

async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b)
      ? (b as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const summary = projectRefsSummary(workRoot());
  return NextResponse.json({
    ok: true,
    keepDays: readVideoEditRefDays(),
    projects: summary.projects,
    oldestAt: summary.oldestAt,
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  const b = await body(req);
  if (!b || !("keepDays" in b)) return bad("keepDays is required");
  const days = b.keepDays === null ? null : parseRefKeepDays(b.keepDays);
  if (b.keepDays !== null && days === null)
    return bad(`keepDays must be null or one of ${REF_KEEP_DAYS.join(", ")}`);
  try {
    writeVideoEditRefDays(days);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, keepDays: readVideoEditRefDays() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;
  const b = await body(req);
  const n = b?.releaseOlderThanDays;
  if (
    typeof n !== "number" ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > MAX_RELEASE_DAYS
  )
    return bad(`releaseOlderThanDays must be 1-${MAX_RELEASE_DAYS}`);
  const released = releaseStaleProjectRefs(workRoot(), n * DAY);
  return NextResponse.json({ ok: true, released });
}
