/**
 * Adrift recipes (admin).
 *
 *   GET ?run=<runId>&job=<index>
 *     -> { ok, recipe, source: "stored" | "derived", warnings, missing }
 *     Stored = written when the job was queued; derived = rebuilt from the
 *     run's params (older runs: no model / LoRA list).
 *   POST { recipe } (a recipe read from a dropped file, or a "cj" chunk)
 *     -> { ok, recipe, warnings, missing }
 *
 * `missing` lists recipe models / LoRAs this ComfyUI does not offer
 * (null when object_info is unreachable).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  extractEnumOptionsInventory,
  type ObjectInfoResponse,
} from "@/lib/oj/localInventory";
import { buildRecipe, parseRecipe, type AdriftRecipe } from "@/lib/recipe/recipe";
import { missingModels, type MissingModels } from "@/lib/recipe/reproduce";
import { getRecipeForRun, getRunParams } from "@/lib/recipe/store";
import { ADRIFT_VERSION } from "@/lib/recipe/stamp";

export const dynamic = "force-dynamic";

const MODEL_FILE_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl)$/i;

async function missingFor(recipe: AdriftRecipe): Promise<MissingModels | null> {
  if (recipe.models.length === 0 && recipe.loras.length === 0) {
    return { models: [], loras: [] };
  }
  const info = await getObjectInfoCached();
  if (!info) return null;
  const names: string[] = [];
  const enums = extractEnumOptionsInventory(info as ObjectInfoResponse);
  for (const inputs of Object.values(enums)) {
    for (const options of Object.values(inputs)) {
      for (const o of options) if (MODEL_FILE_RE.test(o)) names.push(o);
    }
  }
  return missingModels(recipe, { models: names, loras: [] });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  const runId = req.nextUrl.searchParams.get("run") ?? "";
  const job = Number(req.nextUrl.searchParams.get("job") ?? "0");
  if (!/^[\w-]{1,80}$/.test(runId))
    return NextResponse.json({ ok: false, error: "run is required" }, { status: 400 });
  const jobIndex = Number.isInteger(job) && job >= 0 ? job : 0;
  let recipe: AdriftRecipe | null = null;
  let source: "stored" | "derived" = "stored";
  const warnings: string[] = [];
  try {
    recipe = getRecipeForRun(runId, jobIndex);
    if (!recipe) {
      const params = getRunParams(runId);
      if (params) {
        source = "derived";
        recipe = { ...buildRecipe({ params, adriftVersion: ADRIFT_VERSION }), createdAt: "" };
        warnings.push("Made before recipes were saved: models and LoRAs were not recorded.");
      }
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Library unavailable" }, { status: 500 });
  }
  if (!recipe)
    return NextResponse.json({ ok: false, error: "No recipe for this run" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    recipe,
    source,
    warnings,
    missing: await missingFor(recipe),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  let b: unknown = null;
  try {
    b = await req.json();
  } catch {
    b = null;
  }
  const raw = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>).recipe : undefined;
  const parsed = parseRecipe(raw);
  if (!parsed.ok)
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    recipe: parsed.recipe,
    warnings: parsed.warnings,
    missing: await missingFor(parsed.recipe),
  });
}
