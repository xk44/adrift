/**
 * The ComfyUI connection the first-run wizard manages.
 *
 *   GET    -> where Adrift's ComfyUI URL comes from (env / saved / default),
 *             whether it answers, and the GPU profile. Never returns the token.
 *   PUT    -> save { url, mode: "local"|"lan"|"wan", token? , keepToken? }
 *   DELETE -> forget the saved connection (back to env / default)
 *
 * Saved to data/runtime_settings.json (src/lib/runtimeSettings.ts). An
 * explicit COMFY_HTTP_URL env var wins and makes PUT answer 409.
 * Writes: ADMIN_API_KEY auth, or loopback + same-origin in dev mode
 * (src/lib/onboarding/settingsAuth.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { env } from "@/lib/env";
import {
  comfyUrlFromEnv,
  readRuntimeSettings,
  runtimeComfyToken,
  writeComfyConnection,
} from "@/lib/runtimeSettings";
import {
  normalizeComfyUrl,
  validateToken,
  type ConnectionMode,
} from "@/lib/onboarding/comfyUrl";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { probeComfy } from "@/lib/onboarding/comfyProbe";
import { invalidateComfyBackendCaches } from "@/lib/comfy/backendCaches";

export const dynamic = "force-dynamic";

const MODES = new Set<ConnectionMode>(["local", "lan", "wan"]);

function wsEnvSet(): boolean {
  // Computed key: next.config's `env` inlines literal process.env.NEXT_PUBLIC_*
  // reads at build time, which would hide whether it was really set.
  const key = ["NEXT_PUBLIC", "COMFY_WS_BASE"].join("_");
  return !!process.env[key]?.trim();
}

function status() {
  const settings = readRuntimeSettings();
  const envUrl = comfyUrlFromEnv();
  const saved = settings.comfy;
  const source: "env" | "saved" | "default" = envUrl
    ? "env"
    : saved
      ? "saved"
      : "default";
  return {
    source,
    envLocked: !!envUrl,
    httpUrl: env.COMFY_HTTP_URL.replace(/\/+$/, ""),
    mode: source === "saved" ? saved!.mode : null,
    savedUrl: saved?.httpUrl ?? null,
    hasToken: !!(process.env.COMFY_BEARER?.trim() || runtimeComfyToken()),
    tokenFromEnv: !!process.env.COMFY_BEARER?.trim(),
    // The browser's live-progress socket follows the saved URL unless
    // NEXT_PUBLIC_COMFY_WS_BASE is set explicitly.
    wsBase: source === "saved" && !wsEnvSet() ? env.COMFY_WS_BASE : null,
    updatedAt: saved?.updatedAt ?? null,
    onboarded: !!settings.onboardedAt,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const s = status();
  // ?quick=1 (the page-load check) skips the large /object_info read.
  const quick = req.nextUrl.searchParams.get("quick") === "1";
  const probe = await probeComfy(
    s.httpUrl,
    process.env.COMFY_BEARER?.trim() || runtimeComfyToken(),
    fetch,
    { nodes: !quick },
  );
  return NextResponse.json({
    ok: true,
    ...s,
    configured: s.source !== "default",
    reachable: probe.ok,
    probe: probe.ok
      ? probe
      : { ok: false, code: probe.code, error: probe.error, url: probe.url },
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  if (comfyUrlFromEnv())
    return NextResponse.json(
      {
        ok: false,
        error:
          "COMFY_HTTP_URL is set in the environment (.env.local), which always wins. Remove it there to choose here.",
      },
      { status: 409 },
    );
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
  const mode = String(body.mode ?? "lan") as ConnectionMode;
  if (!MODES.has(mode))
    return NextResponse.json(
      { ok: false, error: "mode must be local, lan or wan" },
      { status: 400 },
    );
  const url = normalizeComfyUrl(String(body.url ?? ""), mode);
  if (!url.ok)
    return NextResponse.json({ ok: false, error: url.error }, { status: 400 });
  const token = validateToken(body.token);
  if (token && typeof token === "object")
    return NextResponse.json(
      { ok: false, error: token.error },
      { status: 400 },
    );
  // keepToken: re-saving the same address without retyping its token.
  const previous = readRuntimeSettings().comfy;
  const keep =
    body.keepToken === true && previous?.httpUrl === url.url
      ? previous.authToken
      : undefined;
  writeComfyConnection({
    httpUrl: url.url,
    mode,
    authToken: (token as string | null) ?? keep,
  });
  invalidateComfyBackendCaches();
  return NextResponse.json({
    ok: true,
    ...status(),
    warning: url.warning ?? null,
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  writeComfyConnection(null);
  invalidateComfyBackendCaches();
  return NextResponse.json({ ok: true, ...status() });
}
