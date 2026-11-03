import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { isAllowedHuggingFaceApiUrl } from "@/lib/validate";
import {
  hfModelsUpstreamUrl,
  mapHfModels,
  parseHfModelsRequest,
  parseHfNextCursor,
} from "@/lib/hfModels";

/**
 * GET /api/hf/models — read-only proxy for the Hugging Face Hub model
 * search (https://huggingface.co/api/models). No token is ever sent.
 * Every query param is whitelisted by parseHfModelsRequest; the upstream
 * URL is rebuilt from scratch and checked against the HF host allowlist.
 */

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");
const UPSTREAM_TIMEOUT_MS = 10_000;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json(
    { ok: false, error, items: [], nextCursor: null },
    { status, headers: CORS_HEADERS },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const parsed = parseHfModelsRequest(new URL(request.url).searchParams);
  if (!parsed.ok) return fail(400, parsed.error);

  const upstreamUrl = hfModelsUpstreamUrl(parsed.upstream);
  if (!isAllowedHuggingFaceApiUrl(upstreamUrl)) {
    return fail(400, "Upstream URL not allowed");
  }

  try {
    const res = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Adrift/1.0",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      return fail(502, `Hugging Face API error ${res.status}`);
    }
    const json: unknown = await res.json();
    if (!Array.isArray(json)) {
      return fail(502, "Unexpected Hugging Face response");
    }
    return NextResponse.json(
      {
        ok: true,
        items: mapHfModels(json),
        nextCursor: parseHfNextCursor(res.headers.get("link")),
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut
      ? "Hugging Face request timed out"
      : error instanceof Error
        ? error.message
        : "Unknown error";
    console.error("[HFModels] search failed:", message);
    return fail(timedOut ? 504 : 502, message);
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
