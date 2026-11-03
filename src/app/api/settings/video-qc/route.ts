/**
 * Post-render video QC settings (admin).
 *
 *   GET -> { ok, settings, defaults, bounds }
 *   PUT { ...Partial<VideoQcSettings> } -> { ok, settings }
 *
 * Saved in data/runtime_settings.json (`videoQc`, only non-default keys).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  readVideoQcSettings,
  writeVideoQcSettings,
} from "@/lib/runtimeSettings";
import {
  DEFAULT_VIDEO_QC,
  VIDEO_QC_BOUNDS,
  resolveVideoQcSettings,
  type VideoQcSettings,
} from "@/lib/videoQc/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({
    ok: true,
    settings: resolveVideoQcSettings(readVideoQcSettings()),
    defaults: DEFAULT_VIDEO_QC,
    bounds: VIDEO_QC_BOUNDS,
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!b || typeof b !== "object" || Array.isArray(b))
    return NextResponse.json({ ok: false, error: "expected an object" }, { status: 400 });
  // Merge over the full current settings so a partial PUT keeps the rest.
  const next = {
    ...resolveVideoQcSettings(readVideoQcSettings()),
    ...(b as Partial<VideoQcSettings>),
  };
  try {
    writeVideoQcSettings(next);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    settings: resolveVideoQcSettings(readVideoQcSettings()),
  });
}
