/**
 * Settings → Training: where the local LoRA trainers live.
 *
 *   GET -> trainingSettingsStatus() (saved paths, problems, ready families)
 *   PUT { training: { backends?: { "musubi-tuner"?: { repoPath?, pythonBin? },
 *         "ai-toolkit"?: {...} }, models?: { krea2Dit?, ... } } }
 *       -> the GET payload. The whole `training` object is replaced; empty
 *       string / null clears a field. Every path must exist (repo = folder,
 *       python = executable file, models = file).
 *
 * Reads: requireAdmin. Writes: requireSettingsWrite, like the other settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { requireSettingsWrite } from "@/lib/onboarding/settingsAuth";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { writeTrainingSettings } from "@/lib/runtimeSettings";
import {
  TrainingSettingsError,
  parseTrainingSettingsInput,
} from "@/lib/training/local/config";
import { trainingSettingsStatus } from "@/lib/training/local/settingsStatus";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json(trainingSettingsStatus());
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
  const training =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).training
      : undefined;
  let parsed;
  try {
    parsed = parseTrainingSettingsInput(training);
  } catch (e) {
    if (e instanceof TrainingSettingsError)
      return NextResponse.json(
        { ok: false, error: e.message, field: e.field },
        { status: 400 },
      );
    throw e;
  }
  let saved;
  try {
    saved = writeTrainingSettings(parsed);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json(trainingSettingsStatus(saved.training ?? {}));
}
