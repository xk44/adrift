/**
 * Whether the setup wizard was finished (or skipped) on any device.
 *
 *   GET  -> { ok, onboarded }
 *   POST -> mark it done (idempotent)
 *
 * Saved in data/runtime_settings.json (`onboardedAt`) so every browser on the
 * network skips the wizard once one has completed it. The browser also keeps
 * a localStorage copy (store/onboardingStore.ts) as a cache and fallback.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readRuntimeSettings, writeOnboarded } from "@/lib/runtimeSettings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({
    ok: true,
    onboarded: !!readRuntimeSettings().onboardedAt,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  try {
    writeOnboarded();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, onboarded: true });
}
