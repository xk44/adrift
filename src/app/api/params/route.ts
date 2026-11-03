/**
 * GET /api/params — expose parameter registry for admin UI
 */
import { NextRequest, NextResponse } from "next/server";
import { getAllParams } from "@/lib/oj/parser";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const params = getAllParams();
  return NextResponse.json(
    { ok: true, params },
    { headers: apiCorsHeaders(request, "GET, OPTIONS") },
  );
}
