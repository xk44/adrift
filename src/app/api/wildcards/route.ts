/**
 * GET /api/wildcards            -> { wildcards: [{ name, count }] }
 * GET /api/wildcards?name=a/b   -> { name, options: string[] }
 *
 * Reads data/wildcards/*.txt. Names are validated ([a-z0-9_-/]) and resolved
 * strictly inside the library root.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { isValidWildcardName } from "@/lib/wildcards";
import { listWildcards, readWildcard } from "@/lib/wildcardsFs";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const name = request.nextUrl.searchParams.get("name");
  if (name === null) {
    return apiOk({ wildcards: listWildcards() });
  }
  if (!isValidWildcardName(name)) {
    return apiError("Invalid wildcard name", { status: 400 });
  }
  const options = readWildcard(name);
  if (!options) return apiError("Wildcard not found", { status: 404 });
  return apiOk({ name, options });
}
