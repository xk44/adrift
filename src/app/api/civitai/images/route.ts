import { NextRequest, NextResponse } from "next/server";
import {
  searchCivitaiImages,
  sourceFromNsfw,
  type CivitaiSource,
} from "@/lib/civitai";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateBoundedInteger, validateOptionalString } from "@/lib/validate";

const ALLOWED_IMAGE_PERIODS = new Set([
  "AllTime",
  "Year",
  "Month",
  "Week",
  "Day",
]);

function parseCivitaiSource(value: string | null): CivitaiSource | null {
  if (value === "com" || value === "red") return value;
  return null;
}

function validateImagePeriod(value: string | null): string | undefined {
  if (!value) return undefined;
  return ALLOWED_IMAGE_PERIODS.has(value) ? value : undefined;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const { searchParams } = new URL(request.url);

  const query = validateOptionalString(searchParams.get("q"), 256);
  const limit = validateBoundedInteger(
    searchParams.get("limit") ?? "20",
    1,
    40,
    20,
  );
  const cursor = validateOptionalString(searchParams.get("cursor"), 256);
  const modelType = validateOptionalString(searchParams.get("modelType"), 64);
  const sort = validateOptionalString(searchParams.get("sort"), 64);
  const period = validateImagePeriod(searchParams.get("period"));
  const nsfwParam = searchParams.get("nsfw");
  const sourceParam = searchParams.get("source");
  if (sourceParam !== null && parseCivitaiSource(sourceParam) === null) {
    return NextResponse.json(
      { ok: false, error: "source must be com or red", items: [], nextCursor: undefined },
      { status: 400, headers: apiCorsHeaders(null, "GET, OPTIONS") },
    );
  }
  const type = searchParams.get("type") === "video" ? "video" : undefined;

  try {
    // Safe by default: with no params this is SFW on the normal Civitai site,
    // whatever the saved Civitai settings say. Callers that want NSFW (the
    // Explore toggle) ask for it with ?nsfw=true and/or ?source=red.
    const nsfw = nsfwParam === "true";
    const source = parseCivitaiSource(sourceParam) ?? sourceFromNsfw(nsfw);
    const result = await searchCivitaiImages({
      query,
      limit,
      cursor,
      modelType,
      sort,
      period,
      nsfw,
      source,
      type,
    });

    return NextResponse.json(
      { ok: true, ...result },
      {
        headers: {
          ...apiCorsHeaders(null, "GET, OPTIONS"),
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[CivitaiAPI] Search failed:", message);
    return NextResponse.json(
      { ok: false, error: message, items: [], nextCursor: undefined },
      {
        status: 500,
        headers: apiCorsHeaders(null, "GET, OPTIONS"),
      },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}
