/**
 * Per-job machine routing (Settings > ComfyUI machines; src/lib/comfy/router.ts).
 *
 *   GET            -> { ok, routing: {auto, pins, priorities}, status: [...] }
 *                     status = per machine: online, queue, device, node and
 *                     model-file counts from the cached /object_info.
 *   PUT { auto?, pins?, priorities? }
 *                  -> merges into the saved setting (a key set to null
 *                     clears it); pins/priorities replace their whole map.
 *   POST           -> re-reads every machine's /object_info + /system_stats
 *                     (after installing nodes/models), returns the status.
 *
 * Writes: same rule as the machine list (src/lib/onboarding/settingsAuth.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readRuntimeSettings, writeComfyRouting } from "@/lib/runtimeSettings";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { sanitizeComfyRouting } from "@/lib/comfy/routingSettings";
import { routingStatus } from "@/lib/comfy/router";

export const dynamic = "force-dynamic";

function view() {
  const r = readRuntimeSettings().comfyRouting ?? {};
  return { auto: r.auto === true, pins: r.pins ?? {}, priorities: r.priorities ?? {} };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({ ok: true, routing: view(), status: await routingStatus() });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  let body: Record<string, unknown>;
  try {
    const raw = (await req.json()) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.auto !== undefined && body.auto !== null && typeof body.auto !== "boolean")
    return NextResponse.json(
      { ok: false, error: "auto must be true, false or null" },
      { status: 400 },
    );
  const merged: Record<string, unknown> = { ...(readRuntimeSettings().comfyRouting ?? {}) };
  for (const key of ["auto", "pins", "priorities"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null) delete merged[key];
    else merged[key] = body[key];
  }
  writeComfyRouting(sanitizeComfyRouting(merged));
  return NextResponse.json({ ok: true, routing: view() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 6 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({
    ok: true,
    routing: view(),
    status: await routingStatus({ refresh: true }),
  });
}
