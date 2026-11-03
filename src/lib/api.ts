import { NextResponse } from "next/server";
import { corsAllowOrigin } from "@/lib/net/corsPolicy";

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  request_id?: string;
  details?: unknown;
  warnings?: unknown;
}

export function apiOk<T extends Record<string, unknown>>(data: T, init?: { status?: number; requestId?: string; warnings?: unknown; headers?: HeadersInit }) {
  return NextResponse.json(
    {
      ok: true,
      ...data,
      request_id: init?.requestId,
      warnings: init?.warnings,
    },
    {
      status: init?.status ?? 200,
      headers: init?.headers,
    }
  );
}

export function apiError(error: string, init?: { status?: number; requestId?: string; details?: unknown; headers?: HeadersInit }) {
  return NextResponse.json(
    {
      ok: false,
      error,
      request_id: init?.requestId,
      details: init?.details,
    } satisfies ApiEnvelope,
    {
      status: init?.status ?? 500,
      headers: init?.headers,
    }
  );
}

export function apiCorsHeaders(
  request?: Request | null,
  methods = "GET, POST, OPTIONS",
): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, Authorization",
    Vary: "Origin",
  };

  if (!request) return headers;

  const origin = request.headers.get("origin");
  if (!origin) return headers;

  // Same origin, or exactly the configured ComfyUI origin (lib/net/corsPolicy).
  const allowed = corsAllowOrigin(origin, request.url, request.headers.get("host"));
  if (allowed) headers["Access-Control-Allow-Origin"] = allowed;

  return headers;
}

export function apiOptions() {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(),
  });
}

export function apiLog(scope: string, message: string, data?: unknown) {
  // Silent in production unless explicitly enabled — route logging is noisy
  // (the imagine route alone emits ~15 lines per generation)
  if (process.env.NODE_ENV === "production" && process.env.CJ_API_LOG !== "1")
    return;
  const prefix = `[${scope}]`;
  if (data !== undefined) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

export function apiWarn(scope: string, message: string, data?: unknown) {
  const prefix = `[${scope}]`;
  if (data !== undefined) {
    console.warn(prefix, message, data);
  } else {
    console.warn(prefix, message);
  }
}

export function apiErr(scope: string, message: string, data?: unknown) {
  const prefix = `[${scope}]`;
  if (data !== undefined) {
    console.error(prefix, message, data);
  } else {
    console.error(prefix, message);
  }
}
