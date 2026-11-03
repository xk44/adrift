/**
 * Folders Adrift uses: ComfyUI install, models, input, output, Adrift's data.
 *
 *   GET -> { ok, comfyLocal, dirs: [{ key, display, source, envVar,
 *            envLocked, defaultDisplay, side, check }] }
 *   PUT { dirs: { comfyRoot?: string|null, models?, input?, output?, data? } }
 *       -> the GET payload. null / "" = back to the default.
 *
 * Precedence (lib/paths/resolveDirs.ts): an env var (COMFY_ROOT,
 * COMFY_MODELS_DIR, COMFY_INPUT_DIR, COMFYUI_OUTPUT_DIR, ADRIFT_DATA_DIR)
 * always wins and makes PUT answer 409 for that folder; then the folder
 * saved here (data/runtime_settings.json `dirs`); then the default. Paths
 * travel in ~ form only. Nothing is created or moved here; see ./check for
 * the per-folder check and "Create folder".
 *
 * Reads: requireAdmin. Writes: ADMIN_API_KEY auth, or loopback + same-origin
 * in dev mode (src/lib/onboarding/settingsAuth.ts), like the other settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { dirsStatus, saveDirs } from "@/lib/paths/dirsStatus";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json(dirsStatus());
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
  let r;
  try {
    r = saveDirs(body.dirs);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  if (!r.ok)
    return NextResponse.json(
      { ok: false, error: r.error, key: r.key },
      { status: r.status },
    );
  return NextResponse.json(dirsStatus());
}
