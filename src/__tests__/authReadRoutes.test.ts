/**
 * Every data GET under /api requires credentials: Bearer key, Bearer session
 * token, or the httpOnly cj_session cookie. Open: health, login/logout,
 * refresh, OPTIONS preflight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const KEY = "test-admin-key-123";
const API_DIR = path.resolve(__dirname, "../app/api");

/** GET routes that intentionally stay open (no credentials needed). */
const OPEN_GET = new Set(["health"]);

function routeFiles(dir = API_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

const routes = routeFiles().map((file) => ({
  file,
  id: path.relative(API_DIR, path.dirname(file)),
}));

function urlFor(id: string): string {
  const concrete = id
    .replace(/\[\.\.\.path\]/, "status")
    .replace(/\[[a-zA-Z]+\]/g, "x");
  return `http://localhost/api/${concrete}`;
}

const PARAMS = {
  params: Promise.resolve({ path: ["status"], id: "x", promptId: "x", job: "x" }),
};

class FakeWS {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  close() {}
  send() {}
  addEventListener() {}
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ADMIN_API_KEY", KEY);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  vi.stubGlobal("WebSocket", FakeWS);
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

async function mintCookie(ttlMs?: number): Promise<string> {
  const { createSessionToken } = await import("@/lib/session");
  return createSessionToken(KEY, ttlMs);
}

/** Resolve status of a GET; a handler that gets past auth may throw or hang. */
async function getStatus(
  mod: { GET: (r: NextRequest, c: unknown) => Promise<Response> | Response },
  url: string,
  headers: Record<string, string> = {},
): Promise<number | "past-auth"> {
  const req = new NextRequest(url, { headers });
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => mod.GET(req, PARAMS))
      .then((r) => r.status)
      .catch(() => "past-auth" as const),
    new Promise<"past-auth">((r) => setTimeout(() => r("past-auth"), 4000)),
  ]);
  return outcome;
}

const getRoutes = routes.filter(({ file }) =>
  /export (async )?function GET\b/.test(
    readFileSync(file, "utf8"),
  ),
);

describe("read-only GETs require auth", () => {
  it("discovers a sane number of GET routes", () => {
    expect(getRoutes.length).toBeGreaterThan(25);
  });

  const protectedGets = getRoutes.filter(({ id }) => !OPEN_GET.has(id));

  it.each(protectedGets.map((r) => [r.id, r.file]))(
    "%s: 401 without creds, passes auth with Bearer key / cookie",
    async (id, file) => {
      const mod = await import(/* @vite-ignore */ file);
      const url = urlFor(id);

      expect(await getStatus(mod, url)).toBe(401);
      expect(
        await getStatus(mod, url, { authorization: "Bearer wrong" }),
      ).toBe(401);
      expect(
        await getStatus(mod, url, { cookie: "cj_session=garbage" }),
      ).toBe(401);

      expect(
        await getStatus(mod, url, { authorization: `Bearer ${KEY}` }),
      ).not.toBe(401);
      const cookie = await mintCookie();
      expect(
        await getStatus(mod, url, { cookie: `other=1; cj_session=${cookie}` }),
      ).not.toBe(401);
    },
    15_000,
  );

  it("moodboard upload file serving (image fetch path) honours the cookie", async () => {
    const mod = await import("@/app/api/moodboards/upload/route");
    const url = "http://localhost/api/moodboards/upload?file=a.png";
    expect(await getStatus(mod, url)).toBe(401);
    const cookie = await mintCookie();
    expect(await getStatus(mod, url, { cookie: `cj_session=${cookie}` })).not.toBe(
      401,
    );
  });
});

describe("open routes stay open", () => {
  it("health GET needs no credentials", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new NextRequest("http://localhost/api/health"));
    expect(res.status).toBe(200);
  });

  it("OPTIONS preflight needs no credentials", async () => {
    const { OPTIONS } = await import("@/app/api/moodboards/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });

  it("login rejects a wrong key and logout is open", async () => {
    const { POST: login } = await import("@/app/api/auth/login/route");
    const bad = await login(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: "nope" }),
      }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const { POST: logout } = await import("@/app/api/auth/logout/route");
    const out = await logout(
      new NextRequest("http://localhost/api/auth/logout", { method: "POST" }),
    );
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });
});

describe("login cookie", () => {
  async function doLogin(headers: Record<string, string> = {}) {
    const { POST: login } = await import("@/app/api/auth/login/route");
    return login(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ api_key: KEY }),
      }),
    );
  }

  it("mints an httpOnly SameSite=Lax cookie with an expiry that authenticates", async () => {
    const res = await doLogin();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^cj_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Max-Age=\d+/i);
    expect(setCookie).not.toMatch(/Secure/i);

    const value = setCookie.split(";")[0].split("=")[1];
    const { requireAdmin } = await import("@/lib/auth");
    const ok = requireAdmin(
      new NextRequest("http://localhost/api/x", {
        headers: { cookie: `cj_session=${value}` },
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it("sets Secure behind https", async () => {
    const res = await doLogin({ "x-forwarded-proto": "https" });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("cookie expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { requireAdmin, SESSION_COOKIE_TTL_MS } = await import("@/lib/auth");
    const cookie = await mintCookie(SESSION_COOKIE_TTL_MS);
    const req = () =>
      new NextRequest("http://localhost/api/x", {
        headers: { cookie: `cj_session=${cookie}` },
      });
    expect(requireAdmin(req()).ok).toBe(true);
    vi.setSystemTime(Date.now() + SESSION_COOKIE_TTL_MS + 1000);
    const res = requireAdmin(req());
    expect(res.ok).toBe(false);
  });

  it("cookie signed with a different secret is rejected", async () => {
    const { createSessionToken, resolveSessionSecret } = await import("@/lib/session");
    const forged = createSessionToken("other-secret");
    const { requireAdmin } = await import("@/lib/auth");
    const res = requireAdmin(
      new NextRequest("http://localhost/api/x", {
        headers: { cookie: `cj_session=${forged}` },
      }),
    );
    expect(res.ok).toBe(false);
  });
});

describe("dev mode (no ADMIN_API_KEY)", () => {
  it("stays open", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    const { requireAdmin } = await import("@/lib/auth");
    expect(
      requireAdmin(new NextRequest("http://localhost/api/x")).ok,
    ).toBe(true);
  });
});

describe("cookie CSRF guard on unsafe methods", () => {
  it("rejects cookie-only POST from a foreign origin, accepts same-origin", async () => {

    const prev = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "k".repeat(32);
    vi.resetModules();
    const auth = await import("@/lib/auth");
    const { createSessionToken, resolveSessionSecret } = await import("@/lib/session");
    const secret = resolveSessionSecret()!;
    const tok = createSessionToken(secret, 60_000);
    const mk = (origin?: string) =>
      new NextRequest("http://localhost:3000/api/jobs", {
        method: "POST",
        headers: { cookie: `cj_session=${tok}`, host: "localhost:3000", ...(origin ? { origin } : {}) },
      });
    expect(auth.requireAdmin(mk("http://localhost:6666")).ok).toBe(false);
    expect(auth.requireAdmin(mk()).ok).toBe(false);
    expect(auth.requireAdmin(mk("http://localhost:3000")).ok).toBe(true);
    process.env.ADMIN_API_KEY = prev;
    vi.resetModules();
  });
});
