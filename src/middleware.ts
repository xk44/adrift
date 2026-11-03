import { NextRequest, NextResponse } from "next/server";
import { isTrustedDevHost } from "@/lib/hostGuard";
import { bindRequiresKey, bindWithoutKeyMessage, hasAdminKey } from "@/lib/net/bindPolicy";
import { isVerifiedBearer } from "@/lib/net/edgeAuth";
import { isJudgeMode } from "@/lib/judge/judgePolicy";
import { judgeMiddleware } from "@/lib/judge/judgeMiddleware";

/**
 * CSRF protection for mutating API requests.
 *
 * Before CSRF, for every /api request:
 *  a. Bound beyond loopback (CJ_HOST) without ADMIN_API_KEY → 503 with a
 *     message saying how to fix it (the server also refuses to start).
 *  b. No ADMIN_API_KEY: the Host header must be loopback or listed in
 *     CJ_ALLOWED_HOSTS (DNS-rebinding guard, see lib/hostGuard) → else 403.
 *
 * Rules (applied only to POST/PUT/PATCH/DELETE on /api/*):
 *  1. Requests with a VERIFIED `Authorization: Bearer …` (the admin key or a
 *     valid session token) are API clients — skip CSRF. Any other bearer
 *     gets the browser checks below.
 *  2. If Origin header is present, it must match the app host.
 *  3. If no Origin, check Referer — if present it must match the app host.
 *  4. If neither Origin nor Referer is present, require the custom header
 *     `X-Requested-With: XMLHttpRequest` (all in-app fetch calls include this).
 *  5. Otherwise → 403.
 */
export async function middleware(request: NextRequest) {
  const method = request.method.toUpperCase();

  // Judge mode (lib/judge): token cookie + page/API allowlist first. The
  // matcher covers pages too; outside judge mode they pass straight through.
  if (isJudgeMode()) {
    const judged = await judgeMiddleware(request);
    if (judged) return judged;
  }
  if (!request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  if (bindRequiresKey()) {
    return NextResponse.json(
      { ok: false, error: bindWithoutKeyMessage() },
      { status: 503 },
    );
  }
  if (
    !hasAdminKey() &&
    !isTrustedDevHost(request.headers.get("host") ?? request.nextUrl.host)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This host name isn't trusted. Open Adrift via localhost, add the name to CJ_ALLOWED_HOSTS, or set ADMIN_API_KEY.",
      },
      { status: 403 },
    );
  }

  // Safe methods — no CSRF check needed
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return NextResponse.next();

  // API clients authenticating with a verified Bearer token — skip CSRF
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ") && (await isVerifiedBearer(auth.slice(7).trim()))) {
    return NextResponse.next();
  }

  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // If host header is missing we can't validate origin — reject
  if (!host) {
    return NextResponse.json(
      { ok: false, error: "CSRF check failed" },
      { status: 403 },
    );
  }

  // Helper: extract host from a full URL string, return null on parse failure
  function hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  if (origin) {
    // Origin header present — must match app host
    if (hostOf(origin) === host) return NextResponse.next();
    return NextResponse.json(
      { ok: false, error: "CSRF check failed" },
      { status: 403 },
    );
  }

  if (referer) {
    // No Origin but Referer present — must match app host
    if (hostOf(referer) === host) return NextResponse.next();
    return NextResponse.json(
      { ok: false, error: "CSRF check failed" },
      { status: 403 },
    );
  }

  // No Origin or Referer — require custom header (same-origin XHR/fetch)
  const xrw = request.headers.get("x-requested-with") ?? "";
  if (xrw.toLowerCase() === "xmlhttprequest") return NextResponse.next();

  return NextResponse.json(
    { ok: false, error: "CSRF check failed" },
    { status: 403 },
  );
}

export const config = {
  // Pages are matched for judge mode only (see above); static chunks never.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
