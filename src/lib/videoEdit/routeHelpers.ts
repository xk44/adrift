/** Shared plumbing for /api/video-edit/* routes (route files export handlers only). */
import type { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError } from "@/lib/api";
import { VideoEditError } from "./server";

export async function readJsonBody(
  request: NextRequest,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > maxBytes)
    return {
      ok: false,
      response: apiError("Payload too large", {
        status: 413,
        headers: apiCorsHeaders(),
      }),
    };
  try {
    const text = await request.text();
    if (text.length > maxBytes)
      return {
        ok: false,
        response: apiError("Payload too large", {
          status: 413,
          headers: apiCorsHeaders(),
        }),
      };
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: apiError("Invalid JSON body", {
        status: 400,
        headers: apiCorsHeaders(),
      }),
    };
  }
}

export function badRequest(error: string): NextResponse {
  return apiError(error, { status: 400, headers: apiCorsHeaders() });
}

export function videoEditErrorResponse(e: unknown): NextResponse {
  const status = e instanceof VideoEditError ? e.status : 500;
  const message = e instanceof Error ? e.message : "video edit failed";
  return apiError(message, { status, headers: apiCorsHeaders() });
}
