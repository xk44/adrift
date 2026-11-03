/**
 * POST { url, mode?, token?, id? } -> test one ComfyUI machine: reachable?,
 * ComfyUI version, GPU name, memory, queue. Nothing is saved.
 *
 * Without a token, re-testing a saved machine at its saved URL (by `id`;
 * "main" = the main connection) reuses its saved token, never echoed back.
 * Read-only GETs (/system_stats, /queue), plain fetch, no redirects: see
 * src/lib/onboarding/comfyProbe.ts for why this is not safeFetch.
 * Same access rule as saving.
 */
import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/rateLimit";
import {
  normalizeComfyUrl,
  validateToken,
  type ConnectionMode,
} from "@/lib/onboarding/comfyUrl";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { listBackends } from "@/lib/comfy/backends";
import { probeInstance, tokenForBackend } from "@/lib/comfy/instancesSettings";

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
  const mode = (
    ["local", "lan", "wan"].includes(String(body.mode)) ? body.mode : "lan"
  ) as ConnectionMode;
  const url = normalizeComfyUrl(String(body.url ?? ""), mode);
  if (!url.ok)
    return NextResponse.json({ ok: false, error: url.error }, { status: 400 });
  const token = validateToken(body.token);
  if (token && typeof token === "object")
    return NextResponse.json({ ok: false, error: token.error }, { status: 400 });
  let useToken = token as string | null;
  if (!useToken && typeof body.id === "string") {
    const known = listBackends().find(
      (b) => b.settingsId === body.id && b.url === url.url,
    );
    if (known) useToken = tokenForBackend(known) ?? null;
  }
  const result = await probeInstance(url.url, useToken);
  return NextResponse.json({
    ok: true,
    normalizedUrl: url.url,
    warning: url.warning ?? null,
    result,
  });
}
