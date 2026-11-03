/**
 * Settings → Blender: which Blender "Open in Blender" and the USDZ export use.
 *
 *   GET -> { ok, path, version?, source, missing?, hint?, saved, envPath }
 *   PUT { path: string | null } -> the GET payload. "" / null clears the
 *       saved path (back to auto-detect). The file must exist and be named
 *       like Blender.
 *
 * BLENDER_PATH in the environment always wins over the saved path. Saved in
 * data/runtime_settings.json (`blenderPath`).
 *
 * Reads: requireAdmin. Writes: requireSettingsWrite, like the other settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import {
  readBlenderPathSetting,
  writeBlenderPathSetting,
} from "@/lib/runtimeSettings";
import { detectBlender, parseBlenderPathInput } from "@/lib/blender/detect";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;

async function status() {
  return {
    ok: true,
    ...(await detectBlender()),
    saved: readBlenderPathSetting(),
    envPath: process.env.BLENDER_PATH?.trim() || null,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  return NextResponse.json(await status());
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireSettingsWrite(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  let body: unknown;
  try {
    body = await readJsonCapped(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      return NextResponse.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json(
      { ok: false, error: "Pass { path }" },
      { status: 400 },
    );
  const parsed = parseBlenderPathInput((body as Record<string, unknown>).path);
  if (!parsed.ok)
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  try {
    writeBlenderPathSetting(parsed.value);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json(await status());
}
