/**
 * ComfyUI machines (Settings > ComfyUI machines, the wizard's "Add another
 * machine").
 *
 *   GET [?probe=1] -> { ok, max, instances, exclusive[, status] }. Tokens are
 *                     never returned (hasToken only). probe=1 adds a live
 *                     /system_stats + /queue check per machine.
 *   PUT { main?: {name?, role?},
 *         instances?: [{id?, name, url, role, enabled, mode?, token?, clearToken?}],
 *         exclusive?: boolean | null }
 *       -> saves the extra machines (the full list replaces the saved one),
 *          the main machine's name/role and the one-GPU-job-at-a-time switch.
 *          A saved token is kept only when the same id keeps the same URL.
 *
 * The main connection's URL/token stays with /api/settings/comfy-connection;
 * the env video host (COMFY_VIDEO_HTTP_URL) is listed read-only.
 * Writes: same rule as the connection (src/lib/onboarding/settingsAuth.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readComfyInstances, writeComfyInstances } from "@/lib/runtimeSettings";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { invalidateComfyBackendCaches } from "@/lib/comfy/backendCaches";
import { listBackends } from "@/lib/comfy/backends";
import {
  instancesView,
  probeAllInstances,
  validateInstancesPut,
} from "@/lib/comfy/instancesSettings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const probe = req.nextUrl.searchParams.get("probe") === "1";
  return NextResponse.json({
    ok: true,
    ...instancesView(),
    ...(probe ? { status: await probeAllInstances() } : {}),
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  let body: Record<string, unknown>;
  try {
    const raw = (await req.json()) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error();
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  // URLs the saved machines may not reuse: main + the env video host.
  const fixed = listBackends()
    .filter((b) => b.source !== "saved" || b.primary)
    .map((b) => b.url);
  const result = validateInstancesPut(body, readComfyInstances(), fixed);
  if (!result.ok)
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    );
  writeComfyInstances(result.update);
  invalidateComfyBackendCaches();
  return NextResponse.json({
    ok: true,
    ...instancesView(),
    warnings: result.warnings,
  });
}
