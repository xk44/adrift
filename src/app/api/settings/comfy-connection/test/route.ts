/**
 * POST { url, mode?, token? }      -> test one ComfyUI address
 * POST { probeLocal: true }        -> try this computer: 127.0.0.1:8188, then
 *                                     :8000 (ComfyUI Desktop); first answer wins,
 *                                     else the most telling failure
 *
 * Read-only GETs to /system_stats and /object_info only; nothing is saved.
 * Same access rule as saving (it makes the server fetch an admin-chosen URL).
 * Uses a plain fetch, not safeFetch: see src/lib/onboarding/comfyProbe.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/rateLimit";
import { readRuntimeSettings, comfyUrlFromEnv } from "@/lib/runtimeSettings";
import {
  LOCAL_PROBE_URLS,
  normalizeComfyUrl,
  validateToken,
  type ConnectionMode,
} from "@/lib/onboarding/comfyUrl";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import {
  localProbeFailure,
  probeComfy,
  probeLocalCandidates,
} from "@/lib/onboarding/comfyProbe";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
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

  if (body.probeLocal === true) {
    const result = await probeLocalCandidates(LOCAL_PROBE_URLS);
    return NextResponse.json({
      ok: true,
      result: result ? localProbeFailure(result) : result,
      envLocked: !!comfyUrlFromEnv(),
    });
  }

  const mode = (
    ["local", "lan", "wan"].includes(String(body.mode)) ? body.mode : "lan"
  ) as ConnectionMode;
  const url = normalizeComfyUrl(String(body.url ?? ""), mode);
  if (!url.ok)
    return NextResponse.json({ ok: false, error: url.error }, { status: 400 });
  const token = validateToken(body.token);
  if (token && typeof token === "object")
    return NextResponse.json(
      { ok: false, error: token.error },
      { status: 400 },
    );
  // Re-testing the saved address may reuse its saved token (never echoed back).
  const saved = readRuntimeSettings().comfy;
  const useToken =
    (token as string | null) ??
    (body.useSavedToken === true && saved?.httpUrl === url.url
      ? saved.authToken
      : null);
  const result = await probeComfy(url.url, useToken);
  return NextResponse.json({
    ok: true,
    result,
    normalizedUrl: url.url,
    warning: url.warning ?? null,
    envLocked: !!comfyUrlFromEnv(),
  });
}
