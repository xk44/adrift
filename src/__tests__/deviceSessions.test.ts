/**
 * Per-device sessions: sid claim, data/sessions.json registry, requireAdmin
 * rejecting unpaired devices, the /api/auth/devices routes and logout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SECRET = "test-session-secret-for-devices";
const KEY = "k".repeat(40);
const DAY = 24 * 60 * 60 * 1000;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
let dir = "";
let sessionsFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-devices-"));
  sessionsFile = path.join(dir, "sessions.json");
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(dir, "rt.json"));
  vi.stubEnv("ADRIFT_SESSIONS_FILE", sessionsFile);
  vi.stubEnv("ADMIN_API_KEY", KEY);
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

function payloadOf(token: string) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

function bearerReq(url: string, token: string, init: { method?: string } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function cookieReq(url: string, token: string, method = "POST") {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      cookie: `cj_session=${token}`,
      origin: "http://localhost",
      host: "localhost",
    },
  });
}

async function login(ua = IPHONE_UA): Promise<string> {
  const { POST } = await import("@/app/api/auth/login/route");
  const res = await POST(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "user-agent": ua },
      body: JSON.stringify({ api_key: KEY }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

async function isAuthed(token: string): Promise<boolean> {
  const { requireAdmin } = await import("@/lib/auth");
  return requireAdmin(bearerReq("/api/x", token)).ok;
}

describe("sid claim", () => {
  it("round-trips through create/verify and survives refresh", async () => {
    const s = await import("@/lib/session");
    const sid = s.newSessionId();
    vi.useFakeTimers({ toFake: ["Date"] });
    const token = s.createSessionToken(SECRET, DAY, { sid });
    expect(payloadOf(token).sid).toBe(sid);
    const v = s.verifySessionToken(token, SECRET);
    expect(v.valid && v.payload.sid).toBe(sid);

    vi.setSystemTime(payloadOf(token).exp - 60_000);
    // Not registered yet: the paired check rejects, refresh refuses.
    expect(s.refreshSessionToken(token, SECRET, DAY)).toBeNull();
    const reg = await import("@/lib/sessionRegistry");
    reg.registerSession({ sid, label: "Mac · Chrome", createdAt: Date.now() });
    const next = s.refreshSessionToken(token, SECRET, DAY);
    expect(next).toBeTruthy();
    expect(payloadOf(next!).sid).toBe(sid);
  });

  it("sids are random and url-safe", async () => {
    const s = await import("@/lib/session");
    const reg = await import("@/lib/sessionRegistry");
    const a = s.newSessionId();
    expect(a).not.toBe(s.newSessionId());
    expect(reg.isValidSessionId(a)).toBe(true);
  });

  it("login mints a sid and registers the device", async () => {
    const token = await login(MAC_CHROME_UA);
    const sid = payloadOf(token).sid;
    expect(typeof sid).toBe("string");
    const reg = await import("@/lib/sessionRegistry");
    const list = reg.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sid, label: "Mac · Chrome" });
  });
});

describe("registry", () => {
  it("add / remove / removeOthers / clear", async () => {
    const reg = await import("@/lib/sessionRegistry");
    const now = Date.now();
    const ids = ["a", "b", "c"].map((c) => c.repeat(22));
    for (const sid of ids)
      reg.registerSession({ sid, label: "x", createdAt: now });
    expect(reg.listSessions()).toHaveLength(3);
    expect(reg.removeSession(ids[0])).toBe(true);
    expect(reg.removeSession(ids[0])).toBe(false);
    expect(reg.isSessionPaired(ids[0])).toBe(false);
    expect(reg.removeOtherSessions(ids[1])).toBe(1);
    expect(reg.listSessions().map((e) => e.sid)).toEqual([ids[1]]);
    expect(reg.clearSessions()).toBe(1);
    expect(reg.listSessions()).toEqual([]);
    // File written with owner-only permissions.
    expect(fs.statSync(sessionsFile).mode & 0o777).toBe(0o600);
  });

  it("prunes entries older than the session lifetime cap", async () => {
    const reg = await import("@/lib/sessionRegistry");
    const now = Date.now();
    const old = "o".repeat(22);
    const fresh = "f".repeat(22);
    reg.registerSession({
      sid: old,
      label: "old",
      createdAt: now - reg.MAX_SESSION_LIFETIME_MS - 1000,
    });
    reg.registerSession({ sid: fresh, label: "fresh", createdAt: now });
    expect(reg.isSessionPaired(old)).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    expect(onDisk.sessions.map((e: { sid: string }) => e.sid)).toEqual([fresh]);
  });

  it("caps the list, dropping the least recently seen", async () => {
    const reg = await import("@/lib/sessionRegistry");
    const now = Date.now();
    const list = Array.from({ length: reg.MAX_SESSIONS + 5 }, (_, i) => ({
      sid: `s${String(i).padStart(20, "0")}`,
      label: "x",
      createdAt: now,
      lastSeenAt: now - (reg.MAX_SESSIONS + 5 - i) * 1000,
    }));
    const pruned = reg.pruneSessions(list, now);
    expect(pruned).toHaveLength(reg.MAX_SESSIONS);
    // The 5 oldest-seen (indices 0..4) are gone.
    expect(pruned.some((e) => e.sid === list[0].sid)).toBe(false);
    expect(pruned.some((e) => e.sid === list[5].sid)).toBe(true);
  });

  it("drops malformed entries from a hand-edited file", async () => {
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        version: 1,
        sessions: [
          { sid: "bad id!", label: "x", createdAt: Date.now() },
          { sid: "g".repeat(22), label: "ok", createdAt: Date.now() },
          { sid: "h".repeat(22), label: "x" },
        ],
      }),
    );
    const reg = await import("@/lib/sessionRegistry");
    expect(reg.listSessions().map((e) => e.label)).toEqual(["ok"]);
  });

  it("touch with an interval skips recent writes", async () => {
    const reg = await import("@/lib/sessionRegistry");
    const sid = "t".repeat(22);
    const t0 = Date.now();
    reg.registerSession({ sid, label: "x", createdAt: t0, lastSeenAt: t0 });
    reg.touchSession(sid, { now: t0 + 1000, minIntervalMs: 60_000 });
    expect(reg.getSession(sid)!.lastSeenAt).toBe(t0);
    reg.touchSession(sid, { now: t0 + 120_000, minIntervalMs: 60_000 });
    expect(reg.getSession(sid, t0 + 120_000)!.lastSeenAt).toBe(t0 + 120_000);
    expect(reg.touchSession("u".repeat(22))).toBe(false);
  });
});

describe("device labels", () => {
  it("derives short names", async () => {
    const { deviceLabelFromUserAgent: l } =
      await import("@/lib/sessionRegistry");
    expect(l(IPHONE_UA)).toBe("iPhone · Safari");
    expect(l(MAC_CHROME_UA)).toBe("Mac · Chrome");
    expect(
      l(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("Windows · Edge");
    expect(
      l(
        "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      ),
    ).toBe("Linux · Firefox");
    expect(l("Adrift/42 CFNetwork/1568.100.1 Darwin/24.0.0")).toBe(
      "Adrift iOS app",
    );
    expect(l("")).toBe("Unknown device");
    expect(l(null)).toBe("Unknown device");
    expect(l("x".repeat(5000)).length).toBeLessThanOrEqual(60);
  });

  it("never stores the raw User-Agent or IP", async () => {
    const ua = `${MAC_CHROME_UA} SecretMarker/9.9`;
    const { POST } = await import("@/app/api/auth/login/route");
    await POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "user-agent": ua, "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ api_key: KEY }),
      }),
    );
    const raw = fs.readFileSync(sessionsFile, "utf8");
    expect(raw).not.toContain("SecretMarker");
    expect(raw).not.toContain("Mozilla");
    expect(raw).not.toContain("203.0.113.7");
    const entry = JSON.parse(raw).sessions[0];
    expect(Object.keys(entry).sort()).toEqual(
      ["createdAt", "label", "lastSeenAt", "sid"].sort(),
    );
  });
});

describe("requireAdmin + devices routes", () => {
  it("rejects a token whose device was unpaired; legacy tokens still pass", async () => {
    const token = await login();
    expect(await isAuthed(token)).toBe(true);
    const s = await import("@/lib/session");
    const legacy = s.createSessionToken(SECRET, DAY); // no sid
    expect(await isAuthed(legacy)).toBe(true);

    const reg = await import("@/lib/sessionRegistry");
    reg.removeSession(payloadOf(token).sid);
    expect(await isAuthed(token)).toBe(false);
    expect(await isAuthed(legacy)).toBe(true);
    // An unpaired device can't refresh back in either.
    const { POST: refresh } = await import("@/app/api/auth/refresh/route");
    const r = await refresh(
      bearerReq("/api/auth/refresh", token, { method: "POST" }),
    );
    expect(r.status).toBe(401);
  });

  it("GET /api/auth/devices lists devices and marks the caller", async () => {
    const mine = await login(MAC_CHROME_UA);
    await login(IPHONE_UA);
    const { GET } = await import("@/app/api/auth/devices/route");
    const res = await GET(bearerReq("/api/auth/devices", mine));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.devices).toHaveLength(2);
    const cur = body.devices.filter((d: { current: boolean }) => d.current);
    expect(cur).toHaveLength(1);
    expect(cur[0].label).toBe("Mac · Chrome");

    const denied = await GET(
      new NextRequest("http://localhost/api/auth/devices"),
    );
    expect(denied.status).toBe(401);
  });

  it("GET reports enabled:false when no admin key is set", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.resetModules();
    const { GET } = await import("@/app/api/auth/devices/route");
    const res = await GET(new NextRequest("http://localhost/api/auth/devices"));
    expect(await res.json()).toMatchObject({ enabled: false, devices: [] });
  });

  it("DELETE unpairs one device; unpairing yourself clears the cookie", async () => {
    const mine = await login(MAC_CHROME_UA);
    const other = await login(IPHONE_UA);
    const { DELETE } = await import("@/app/api/auth/devices/[sid]/route");
    const del = (sid: string, as: string) =>
      DELETE(bearerReq(`/api/auth/devices/${sid}`, as, { method: "DELETE" }), {
        params: Promise.resolve({ sid }),
      });

    const r1 = await del(payloadOf(other).sid, mine);
    expect(r1.status).toBe(200);
    expect((await r1.json()).signedOut).toBe(false);
    expect(await isAuthed(other)).toBe(false);
    expect(await isAuthed(mine)).toBe(true);

    expect((await del(payloadOf(other).sid, mine)).status).toBe(404);
    expect((await del("not a sid", mine)).status).toBe(404);

    const r2 = await del(payloadOf(mine).sid, mine);
    expect((await r2.json()).signedOut).toBe(true);
    expect(r2.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(await isAuthed(mine)).toBe(false);
  });

  it("unpair-others keeps the caller signed in and revokes others + legacy tokens", async () => {
    const mine = await login(MAC_CHROME_UA);
    const other = await login(IPHONE_UA);
    const s = await import("@/lib/session");
    const legacy = s.createSessionToken(SECRET, DAY);
    expect(await isAuthed(legacy)).toBe(true);

    const { POST } = await import("@/app/api/auth/devices/unpair-others/route");
    const res = await POST(cookieReq("/api/auth/devices/unpair-others", mine));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(1);
    const fresh = body.token as string;
    expect(payloadOf(fresh).sid).toBe(payloadOf(mine).sid);
    expect(payloadOf(fresh).auth).toBe(payloadOf(mine).auth);
    expect(payloadOf(fresh).gen).toBe(1);
    expect(res.headers.get("set-cookie")).toContain(`cj_session=${fresh}`);

    expect(await isAuthed(fresh)).toBe(true);
    expect(await isAuthed(other)).toBe(false);
    expect(await isAuthed(legacy)).toBe(false);
    // The old token of the caller is at the old generation: void too.
    expect(await isAuthed(mine)).toBe(false);
    const reg = await import("@/lib/sessionRegistry");
    expect(reg.listSessions().map((e) => e.sid)).toEqual([payloadOf(mine).sid]);
  });

  it("unpair-others from a legacy token pairs the caller instead of signing it out", async () => {
    await login(IPHONE_UA);
    const s = await import("@/lib/session");
    const legacy = s.createSessionToken(SECRET, DAY);
    const { POST } = await import("@/app/api/auth/devices/unpair-others/route");
    const res = await POST(
      bearerReq("/api/auth/devices/unpair-others", legacy, { method: "POST" }),
    );
    const body = await res.json();
    expect(typeof payloadOf(body.token).sid).toBe("string");
    expect(await isAuthed(body.token)).toBe(true);
    expect(await isAuthed(legacy)).toBe(false);
    // Bearer caller: token in the body, no cookie.
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("logout", () => {
  it("plain logout unpairs only the caller's device", async () => {
    const mine = await login(MAC_CHROME_UA);
    const other = await login(IPHONE_UA);
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(cookieReq("/api/auth/logout", mine));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(await isAuthed(mine)).toBe(false);
    expect(await isAuthed(other)).toBe(true);
  });

  it("logout with a forged token removes nothing", async () => {
    const other = await login(IPHONE_UA);
    const s = await import("@/lib/session");
    const forged = s.createSessionToken("wrong-secret", DAY, {
      sid: payloadOf(other).sid,
    });
    const { POST } = await import("@/app/api/auth/logout/route");
    await POST(bearerReq("/api/auth/logout", forged, { method: "POST" }));
    expect(await isAuthed(other)).toBe(true);
  });

  it("logout?all=1 unpairs every device including the caller", async () => {
    const mine = await login(MAC_CHROME_UA);
    const other = await login(IPHONE_UA);
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(
      bearerReq("/api/auth/logout?all=1", mine, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await isAuthed(mine)).toBe(false);
    expect(await isAuthed(other)).toBe(false);
    const reg = await import("@/lib/sessionRegistry");
    expect(reg.listSessions()).toEqual([]);
  });
});

describe("formatRelativeTime", () => {
  it("reads plainly", async () => {
    const { formatRelativeTime: f } =
      await import("@/components/settings/DevicesSettings");
    const now = 1_800_000_000_000;
    expect(f(now - 10_000, now)).toBe("just now");
    expect(f(now - 60_000, now)).toBe("1 minute ago");
    expect(f(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(f(now - 2 * DAY, now)).toBe("2 days ago");
  });
});
