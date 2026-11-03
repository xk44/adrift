import { NextRequest, NextResponse } from "next/server";
import {
  searchCivitaiModels,
  sourceFromNsfw,
  type CivitaiSource,
} from "@/lib/civitai";
import { getCivitaiApiKey, getCivitaiConfig } from "@/lib/civitaiConfig";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateBoundedInteger, validateOptionalString } from "@/lib/validate";
import {
  CIVITAI_CURSOR_RE,
  CIVITAI_USERNAME_RE,
  isCivitaiBaseModel,
  isCivitaiCheckpointType,
  isCivitaiModelSort,
  isCivitaiModelType,
  isCivitaiPeriod,
} from "@/lib/civitaiFilters";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

/** Repeated `k=a&k=b` (also tolerates legacy `k=a,b`), whitelisted. */
function parseMulti(
  searchParams: URLSearchParams,
  key: string,
  guard: (v: string) => boolean,
  max: number,
): { ok: true; values: string[] } | { ok: false; error: string } {
  const values = [
    ...new Set(
      searchParams
        .getAll(key)
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length > max) return { ok: false, error: `too many ${key}` };
  const bad = values.find((v) => !guard(v));
  if (bad !== undefined) return { ok: false, error: `invalid ${key}: ${bad.slice(0, 64)}` };
  return { ok: true, values };
}

function badRequest(error: string): NextResponse {
  return NextResponse.json(
    { ok: false, error, items: [], metadata: null },
    { status: 400, headers: CORS_HEADERS },
  );
}

function parseCivitaiSource(value: string | null): CivitaiSource | null {
  if (value === "com" || value === "red") return value;
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const { searchParams } = new URL(request.url);

  const query = validateOptionalString(searchParams.get("q"), 256);
  const typesResult = parseMulti(searchParams, "types", isCivitaiModelType, 23);
  if (!typesResult.ok) return badRequest(typesResult.error);
  const baseResult = parseMulti(searchParams, "baseModels", isCivitaiBaseModel, 40);
  if (!baseResult.ok) return badRequest(baseResult.error);
  const sort = validateOptionalString(searchParams.get("sort"), 64);
  if (sort !== undefined && !isCivitaiModelSort(sort)) return badRequest("invalid sort");
  const period = validateOptionalString(searchParams.get("period"), 64);
  if (period !== undefined && !isCivitaiPeriod(period)) return badRequest("invalid period");
  const checkpointType = validateOptionalString(searchParams.get("checkpointType"), 16);
  if (checkpointType !== undefined && !isCivitaiCheckpointType(checkpointType)) {
    return badRequest("checkpointType must be Trained or Merge");
  }
  const username = validateOptionalString(searchParams.get("username"), 64);
  if (username !== undefined && !CIVITAI_USERNAME_RE.test(username)) {
    return badRequest("invalid username");
  }
  const cursor = validateOptionalString(searchParams.get("cursor"), 128);
  if (cursor !== undefined && !CIVITAI_CURSOR_RE.test(cursor)) {
    return badRequest("invalid cursor");
  }
  const limit = validateBoundedInteger(
    searchParams.get("limit") ?? "20",
    1,
    100,
    20,
  );
  const rawPage = searchParams.get("page");
  const page =
    rawPage !== null
      ? validateBoundedInteger(rawPage, 1, 10_000, 1)
      : undefined;
  const nsfwParam = searchParams.get("nsfw");
  const sourceParam = searchParams.get("source");
  if (sourceParam !== null && parseCivitaiSource(sourceParam) === null) {
    return badRequest("source must be com or red");
  }

  try {
    const config = await getCivitaiConfig();
    const nsfw =
      nsfwParam !== null ? nsfwParam === "true" : (config.showNsfw ?? false);
    const source =
      parseCivitaiSource(sourceParam) ?? config.source ?? sourceFromNsfw(nsfw);
    const [result, apiKey] = await Promise.all([
      searchCivitaiModels({
        query,
        types: typesResult.values,
        sort,
        period,
        limit,
        page,
        cursor,
        baseModels: baseResult.values,
        checkpointType,
        username,
        nsfw,
        source,
      }),
      getCivitaiApiKey(),
    ]);

    return NextResponse.json(
      {
        ok: true,
        hasKey: Boolean(apiKey),
        items: result.items,
        metadata: result.metadata,
        nextCursor: result.nextCursor ?? null,
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=60",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[CivitaiAPI] Model search failed:", message);
    return NextResponse.json(
      { ok: false, error: message, items: [], metadata: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
