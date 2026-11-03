import { NextRequest, NextResponse } from "next/server";
import { fetchCivitaiModelVersionByHash } from "@/lib/civitai";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getCivitaiConfig } from "@/lib/civitaiConfig";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const { searchParams } = new URL(request.url);
  const hash = searchParams.get("hash");

  if (!hash || hash.length > 128 || !/^[a-fA-F0-9]+$/.test(hash)) {
    return NextResponse.json(
      { ok: false, error: "hash parameter required (hex, max 128 chars)" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const nsfwParam = searchParams.get("nsfw");
    const config = await getCivitaiConfig();
    const nsfw =
      nsfwParam !== null ? nsfwParam === "true" : (config.showNsfw ?? false);
    const modelVersion = await fetchCivitaiModelVersionByHash(hash, nsfw);

    if (!modelVersion) {
      return NextResponse.json(
        { ok: false },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { ok: true, modelVersion },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[CivitaiAPI] Hash lookup failed:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
