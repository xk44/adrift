/**
 * POST /api/tools/setup/download { key, id?, dests: string[] }
 *   Downloads the listed weight files of one Tools-page card into
 *   COMFY_ROOT/models with scripts/fetch-models.mjs (pinned revisions, size
 *   check, resume, never overwrites). Every dest must be a file of that card
 *   and a row of models/download-list.json. One download runs at a time.
 *   -> 202 { ok, job } | 409 { ok:false, error, job? } (busy / remote ComfyUI)
 * GET /api/tools/setup/download?job=<id>  -> { ok, job }
 * DELETE /api/tools/setup/download?job=<id>  -> { ok } (stops it; partial
 *   files resume next time)
 */
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyIsLocalMachine } from "@/lib/paths/resolveDirs";
import { resolveToolSetup } from "@/lib/tools/setupRequirements";
import { loadSetupWorkflow } from "@/lib/tools/setupWorkflows";
import {
  cancelDownload,
  downloadSupport,
  downloadableDests,
  getJob,
  runningJob,
  safeDest,
  setupFileDest,
  startDownload,
} from "@/lib/tools/setupDownload";

const CORS_HEADERS = apiCorsHeaders(null, "GET, POST, DELETE, OPTIONS");

function fail(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    { ok: false, error, ...extra },
    { status, headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("job") ?? "";
  const job = id ? getJob(id) : runningJob();
  if (!job) return fail("no such download", 404);
  return NextResponse.json(
    { ok: true, job },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("job") ?? "";
  if (!cancelDownload(id)) return fail("that download is not running", 404);
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let body: { key?: unknown; id?: unknown; dests?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("invalid JSON", 400);
  }
  const key = typeof body.key === "string" ? body.key : "";
  const id = typeof body.id === "string" ? body.id : undefined;
  const dests = Array.isArray(body.dests) ? body.dests : [];
  if (!key || !dests.length || dests.length > 40 || !dests.every(safeDest))
    return fail("need key and 1-40 file paths", 400);

  const comfyRoot = path.resolve(env.COMFY_ROOT);
  const support = downloadSupport({
    comfyLocal: comfyIsLocalMachine(),
    comfyRoot,
  });
  if (!support.ok) return fail(support.reason, 409);

  const setup = resolveToolSetup(key, loadSetupWorkflow, id);
  if (!setup) return fail("no setup info for this tool", 404);
  const allowed = new Set<string>();
  for (const opt of setup.options)
    for (const f of opt.files) {
      const d = setupFileDest(f);
      if (d && !f.gated) allowed.add(d);
    }
  const listed = downloadableDests() ?? new Set<string>();
  const bad = (dests as string[]).filter(
    (d) => !allowed.has(d) || !listed.has(d),
  );
  if (bad.length)
    return fail(`not a downloadable file of this tool: ${bad.join(", ")}`, 400);

  const busy = runningJob();
  if (busy)
    return fail(
      "Another download is running. It continues in the background.",
      409,
      {
        job: busy,
      },
    );

  const job = startDownload(
    setup.key,
    [...new Set(dests as string[])],
    comfyRoot,
  );
  return NextResponse.json(
    { ok: true, job },
    { status: 202, headers: CORS_HEADERS },
  );
}
