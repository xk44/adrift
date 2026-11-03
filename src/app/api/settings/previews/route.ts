/**
 * Live previews setting (admin).
 *
 *   GET -> { ok, method }
 *   PUT { method: "auto" | "latent2rgb" | "none" } -> { ok, method }
 *
 * The method is sent as `extra_data.preview_method` with every prompt Adrift
 * queues (lib/comfy/http.ts queuePrompt), so ComfyUI streams sampler previews
 * to the tab that submitted. Saved in data/runtime_settings.json
 * (`previewMethod`, absent = "auto").
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readPreviewMethod, writePreviewMethod } from "@/lib/runtimeSettings";
import { PREVIEW_METHODS, parsePreviewMethod } from "@/lib/comfy/previewMethod";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({ ok: true, method: readPreviewMethod() });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  let b: unknown = null;
  try {
    b = await req.json();
  } catch {
    b = null;
  }
  const method =
    b && typeof b === "object" && !Array.isArray(b)
      ? parsePreviewMethod((b as Record<string, unknown>).method)
      : null;
  if (!method)
    return NextResponse.json(
      { ok: false, error: `method must be one of ${PREVIEW_METHODS.join(", ")}` },
      { status: 400 },
    );
  try {
    writePreviewMethod(method);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, method: readPreviewMethod() });
}
