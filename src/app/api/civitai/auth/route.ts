import { NextRequest, NextResponse } from "next/server";
import {
  getCivitaiApiKey,
  getCivitaiConfig,
  setCivitaiConfig,
} from "@/lib/civitaiConfig";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders } from "@/lib/api";
import { validatePlainObject, validateRequiredString } from "@/lib/validate";

const CORS_HEADERS = apiCorsHeaders(null, "GET, PUT, PATCH, DELETE, OPTIONS");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const config = await getCivitaiConfig();
  const configKey = config.apiKey?.trim();

  let source: "config" | "env" | "none";
  if (configKey) {
    source = "config";
  } else if (env.CIVITAI_API_KEY) {
    source = "env";
  } else {
    source = "none";
  }

  const key = await getCivitaiApiKey();
  return NextResponse.json(
    {
      ok: true,
      hasKey: Boolean(key),
      source,
      showNsfw: config.showNsfw ?? false,
    },
    { headers: CORS_HEADERS },
  );
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const body = validatePlainObject(rawBody, "body");
  if (typeof body === "string") {
    return NextResponse.json(
      { ok: false, error: body },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const apiKeyResult = validateRequiredString(body.apiKey, "apiKey", 256);
  if (!apiKeyResult.ok) {
    return NextResponse.json(
      { ok: false, error: "apiKey must be a non-empty string" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const trimmed = apiKeyResult.text;

  let testRes: Response;
  try {
    testRes = await fetch("https://civitai.com/api/v1/models?limit=1", {
      headers: {
        Authorization: `Bearer ${trimmed}`,
        "User-Agent": "Adrift/1.0",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not reach Civitai to verify the API key" },
      { status: 502, headers: CORS_HEADERS },
    );
  }
  if (testRes.status === 401) {
    return NextResponse.json(
      { ok: false, error: "Invalid API key" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const existing = await getCivitaiConfig();
  await setCivitaiConfig({ ...existing, apiKey: trimmed });
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 15 });
  if (!rl.ok) return rl.response;

  let body: { showNsfw?: unknown };
  try {
    body = (await request.json()) as { showNsfw?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const existing = await getCivitaiConfig();
  if (typeof body.showNsfw === "boolean") {
    existing.showNsfw = body.showNsfw;
  }
  await setCivitaiConfig(existing);
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  const existing = await getCivitaiConfig();
  await setCivitaiConfig({ ...existing, apiKey: "" });
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
