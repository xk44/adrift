/**
 * Judge-mode middleware step (Edge runtime). Returns a response to send, or
 * null to continue with the normal /api checks (host guard, CSRF).
 *
 *  - GET <page>?judge=<token>: valid token -> tiny same-site HTML page that
 *    sets the httpOnly SameSite=Strict cookie and moves to "/" (a 302 would
 *    not do: the redirect hop of a cross-site navigation, e.g. from the
 *    judging form, is still cross-site, so a Strict cookie would not be sent
 *    on it and the judge would land on the 401 page).
 *  - No valid cookie -> 401 (HTML for pages, JSON for /api).
 *  - Pages: "/" and "/judge" -> the judge studio; shipped assets pass; every
 *    other path -> 404. API: judgeRouteKind() allowlist, else 404.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  JUDGE_COOKIE,
  JUDGE_COOKIE_MAX_AGE_S,
  JUDGE_QUERY,
  cookieValue,
  isJudgeTokenEdge,
  judgePageDecision,
  judgeRouteKind,
} from "./judgePolicy";

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function isHttps(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex">` +
      `<title>Adrift preview</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
      `${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...PRIVATE_HEADERS,
      },
    },
  );
}

function json(error: string, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: PRIVATE_HEADERS },
  );
}

const NEED_LINK =
  "<h1>Adrift preview</h1><p>This preview is only open to contest judges. " +
  "Please use the link from the judging form.</p>";

export async function judgeMiddleware(
  request: NextRequest,
): Promise<NextResponse | null> {
  const { pathname, searchParams } = request.nextUrl;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const method = request.method.toUpperCase();

  // First visit: ?judge=<token> on a page.
  const offered = searchParams.get(JUDGE_QUERY);
  if (!isApi && offered !== null && method === "GET") {
    if (!(await isJudgeTokenEdge(offered))) return html(NEED_LINK, 403);
    const res = html(
      `<p>Opening the preview…</p>` +
        `<p><a href="/">Continue</a></p>` +
        `<script>location.replace("/")</script>`,
      200,
    );
    res.cookies.set(JUDGE_COOKIE, offered, {
      httpOnly: true,
      sameSite: "strict",
      secure: isHttps(request),
      path: "/",
      maxAge: JUDGE_COOKIE_MAX_AGE_S,
    });
    return res;
  }

  const token = cookieValue(request.headers.get("cookie"), JUDGE_COOKIE);
  const authed = token ? await isJudgeTokenEdge(token) : false;
  if (!authed) {
    return isApi
      ? json("This preview needs the link from the judging form.", 401)
      : html(NEED_LINK, 401);
  }

  if (isApi) {
    if (!judgeRouteKind(pathname, method)) return json("Not found", 404);
    return null;
  }

  if (method !== "GET" && method !== "HEAD") return html("Not found", 404);
  const decision = judgePageDecision(pathname);
  if (decision === "deny") return html("<p>Not found.</p>", 404);
  if (decision === "studio") {
    const url = request.nextUrl.clone();
    url.pathname = "/judge";
    return NextResponse.rewrite(url, { headers: PRIVATE_HEADERS });
  }
  return NextResponse.next({ headers: PRIVATE_HEADERS });
}
