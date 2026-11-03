/**
 * Upscaler of choice (admin).
 *
 *   GET -> { ok, pref, locked, available, models, resolved }
 *          `models` = live picker options (null when ComfyUI is unreachable),
 *          `resolved` = the model each content type uses right now.
 *   PUT { photo?, illustration?, video?: file | null, scale?: 2 | 4 | null,
 *         lock?: boolean, after?: boolean } -> same shape as GET
 *         (`after` = tool runners' "Upscale after" default)
 *
 * Saved in data/runtime_settings.json (`upscaler`); applied to every prompt
 * at submit (lib/upscale/resolveUpscalers.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { readUpscalerPref, writeUpscalerPref } from "@/lib/runtimeSettings";
import { liveUpscalerFiles } from "@/lib/upscale/applyUpscalerPref";
import { upscaleModelOptionsFromObjectInfo } from "@/lib/upscale/upscaleModels";
import {
  isLocked,
  mergeUpscalerPref,
  resolveAllDefaults,
  upscalerPatchError,
} from "@/lib/upscale/upscalerPref";

export const dynamic = "force-dynamic";

async function snapshot(fresh = false) {
  const pref = readUpscalerPref();
  const info = await getObjectInfoCached(undefined, { fresh }).catch(() => null);
  const live = liveUpscalerFiles(info);
  return {
    ok: true,
    pref: pref ?? {},
    locked: isLocked(pref),
    available: live !== null,
    models: info ? upscaleModelOptionsFromObjectInfo(info) : null,
    resolved: live ? resolveAllDefaults(pref, live) : null,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json(await snapshot(fresh));
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  let b: unknown = null;
  try {
    b = await req.json();
  } catch {
    b = null;
  }
  if (!b || typeof b !== "object" || Array.isArray(b))
    return NextResponse.json(
      { ok: false, error: "Body must be a JSON object" },
      { status: 400 },
    );
  const patch = b as Record<string, unknown>;
  const err = upscalerPatchError(patch);
  if (err)
    return NextResponse.json({ ok: false, error: err }, { status: 400 });
  try {
    writeUpscalerPref(mergeUpscalerPref(readUpscalerPref(), patch));
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json(await snapshot());
}
