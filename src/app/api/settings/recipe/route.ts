/**
 * "Embed recipe in files" setting (admin).
 *
 *   GET -> { ok, embed }
 *   PUT { embed: boolean } -> { ok, embed }
 *
 * On (default): outputs carry their Adrift recipe (PNG "adrift_recipe"
 * chunk, video metadata comment). Off: the recipe and Adrift's job params
 * are left out of new files; the local DB still keeps the recipe. Saved in
 * data/runtime_settings.json (`embedRecipe`, absent = on).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { readEmbedRecipe, writeEmbedRecipe } from "@/lib/runtimeSettings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json({ ok: true, embed: readEmbedRecipe() });
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
  const embed =
    b && typeof b === "object" && !Array.isArray(b)
      ? (b as Record<string, unknown>).embed
      : undefined;
  if (typeof embed !== "boolean")
    return NextResponse.json(
      { ok: false, error: "embed must be true or false" },
      { status: 400 },
    );
  try {
    writeEmbedRecipe(embed);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/runtime_settings.json" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, embed: readEmbedRecipe() });
}
