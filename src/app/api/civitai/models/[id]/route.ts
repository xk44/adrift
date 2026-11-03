import { NextRequest, NextResponse } from "next/server";
import { fetchCivitaiModel } from "@/lib/civitai";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getCivitaiConfig } from "@/lib/civitaiConfig";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const { id } = await params;
  const modelId = parseInt(id, 10);

  if (isNaN(modelId) || modelId <= 0 || modelId > 2_000_000_000) {
    return NextResponse.json(
      { ok: false, error: "Invalid model ID" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const nsfwParam = searchParams.get("nsfw");
    const config = await getCivitaiConfig();
    const nsfw =
      nsfwParam !== null ? nsfwParam === "true" : (config.showNsfw ?? false);
    const model = await fetchCivitaiModel(modelId, nsfw);

    if (!model) {
      return NextResponse.json(
        { ok: false, error: "Model not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { ok: true, model },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=300",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[CivitaiAPI] Fetch model failed:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
