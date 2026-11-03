/**
 * First-run wizard, connection side: URL validation, runtime settings
 * persistence, the settings route's auth rules, the ComfyUI probe and the
 * browser WS base override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPrivateHost,
  normalizeComfyUrl,
  validateToken,
} from "@/lib/onboarding/comfyUrl";
import { browserWsBase } from "@/lib/comfy/wsBaseOverride";
import { probeComfy } from "@/lib/onboarding/comfyProbe";

describe("normalizeComfyUrl", () => {
  it.each([
    ["192.168.1.20", "lan", "http://192.168.1.20:8188"],
    ["192.168.1.20:8000", "lan", "http://192.168.1.20:8000"],
    ["box.local", "lan", "http://box.local:8188"],
    ["http://host:8188/", "lan", "http://host:8188"],
    ["https://comfy.example.com/", "wan", "https://comfy.example.com"],
    ["comfy.example.com", "wan", "https://comfy.example.com"],
    ["https://example.com/comfy/", "wan", "https://example.com/comfy"],
    ["http://[::1]:8188", "local", "http://[::1]:8188"],
  ] as const)("%s (%s) -> %s", (input, mode, url) => {
    const r = normalizeComfyUrl(input, mode);
    expect(r).toMatchObject({ ok: true, url });
  });

  it.each([
    "",
    "   ",
    "ftp://host",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://user:pw@host:8188",
    "http://host:8188/?x=1",
    "http://host:8188/#a",
    "http://ho st",
    "x".repeat(3000),
  ])("rejects %j", (input) => {
    expect(normalizeComfyUrl(input, "lan").ok).toBe(false);
  });

  it("warns about plain http to a public host over the internet", () => {
    const r = normalizeComfyUrl("http://203.0.113.5:8188", "wan");
    expect(r.ok && r.warning).toMatch(/https/);
    expect(
      normalizeComfyUrl("http://100.101.102.103:8188", "wan"),
    ).not.toHaveProperty("warning");
    expect(normalizeComfyUrl("https://203.0.113.5", "wan")).not.toHaveProperty(
      "warning",
    );
  });

  it("isPrivateHost", () => {
    for (const h of [
      "127.0.0.1",
      "10.0.0.2",
      "172.16.0.1",
      "172.31.9.9",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "box.local",
      "gpu.tail1234.ts.net",
      "comfybox",
      "[fd00::1]",
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "example.com", "100.128.0.1"])
      expect(isPrivateHost(h), h).toBe(false);
  });

  it("validateToken", () => {
    expect(validateToken(undefined)).toBeNull();
    expect(validateToken("")).toBeNull();
    expect(validateToken("  ")).toBeNull();
    expect(validateToken(" abc.DEF-123 ")).toBe("abc.DEF-123");
    expect(validateToken("a b")).toHaveProperty("error");
    expect(validateToken("a\nb")).toHaveProperty("error");
    expect(validateToken(42)).toHaveProperty("error");
    expect(validateToken("x".repeat(5000))).toHaveProperty("error");
  });
});

describe("browserWsBase", () => {
  it("keeps remote hosts and swaps loopback for the page host", () => {
    expect(browserWsBase("ws://192.168.1.20:8188/")).toBe(
      "ws://192.168.1.20:8188",
    );
    expect(browserWsBase("ws://127.0.0.1:8188", "192.168.1.5")).toBe(
      "ws://192.168.1.5:8188",
    );
    expect(browserWsBase("ws://127.0.0.1:8188", "localhost")).toBe(
      "ws://127.0.0.1:8188",
    );
    expect(browserWsBase("wss://comfy.example.com/x/", "a.b")).toBe(
      "wss://comfy.example.com/x",
    );
    expect(browserWsBase("http://host:8188")).toBeNull();
    expect(browserWsBase("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------- probe

const STATS_4090 = {
  system: { os: "linux", ram_total: 100904390656, comfyui_version: "0.42.0" },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
      type: "cuda",
      index: 0,
      vram_total: 25503596544,
      vram_free: 20000000000,
    },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probeComfy", () => {
  it("reports version, GPU, memory and node count; sends the token", async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith("/system_stats")
        ? json(STATS_4090)
        : json({ A: {}, B: {}, C: {} }),
    );
    const r = await probeComfy(
      "http://h:8188/",
      "tok",
      f as unknown as typeof fetch,
    );
    expect(r).toMatchObject({
      ok: true,
      url: "http://h:8188",
      comfyuiVersion: "0.42.0",
      memoryGb: 24,
      unified: false,
      nodeCount: 3,
    });
    expect(r.ok && r.gpuName).toMatch(/4090/);
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(init.redirect).toBe("manual");
  });

  it("nodes:false skips /object_info", async () => {
    const f = vi.fn(async () => json(STATS_4090));
    const r = await probeComfy("http://h:8188", null, f as never, {
      nodes: false,
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, nodeCount: null });
  });

  it.each([
    [() => json({}, 401), "auth"],
    [() => new Response(null, { status: 302 }), "redirect"],
    [() => json({}, 500), "http"],
    [() => new Response("<html>", { status: 200 }), "not_comfy"],
    [() => json({ hello: 1 }), "not_comfy"],
    [
      () => {
        throw new TypeError("fetch failed");
      },
      "unreachable",
    ],
    [
      () => {
        throw new DOMException("t", "TimeoutError");
      },
      "timeout",
    ],
  ] as const)("failure %#", async (impl, code) => {
    const r = await probeComfy("http://h:8188", null, vi.fn(impl) as never);
    expect(r).toMatchObject({ ok: false, code });
  });

  it("a failing /object_info is not fatal", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/system_stats")) return json(STATS_4090);
      throw new TypeError("slow");
    });
    expect(await probeComfy("http://h", null, f as never)).toMatchObject({
      ok: true,
      nodeCount: null,
    });
  });
});

// ---------------------------------------------------------------- settings

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-rs-"));
  file = path.join(dir, "runtime_settings.json");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rateLimit");
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function freshSettings() {
  vi.resetModules();
  return import("@/lib/runtimeSettings");
}

describe("runtimeSettings", () => {
  it("never touches the real file in tests without an override", async () => {
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", "");
    const rs = await freshSettings();
    expect(rs.readRuntimeSettings()).toEqual({ version: 1 });
    expect(() =>
      rs.writeComfyConnection({ httpUrl: "http://x:8188", mode: "lan" }),
    ).toThrow(/ADRIFT_RUNTIME_SETTINGS_FILE/);
  });

  it("round-trips atomically with mode 0600 and a schema version", async () => {
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
    vi.stubEnv("COMFY_HTTP_URL", "");
    const rs = await freshSettings();
    rs.writeComfyConnection({
      httpUrl: "https://comfy.example.com/",
      mode: "wan",
      authToken: " t0k ",
    });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toMatchObject({
      version: rs.RUNTIME_SETTINGS_VERSION,
      comfy: {
        httpUrl: "https://comfy.example.com",
        mode: "wan",
        authToken: "t0k",
      },
    });
    expect(Object.keys(onDisk)).toEqual(["version", "comfy"]);
    if (process.platform !== "win32")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["runtime_settings.json"]);
    expect(rs.runtimeComfyHttpUrl()).toBe("https://comfy.example.com");
    expect(rs.runtimeComfyToken()).toBe("t0k");

    rs.writeComfyConnection(null);
    expect(rs.readRuntimeSettings()).toEqual({ version: 1 });
  });

  it("env COMFY_HTTP_URL wins and hides the saved URL and token", async () => {
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
    vi.stubEnv("COMFY_HTTP_URL", "");
    vi.stubEnv("COMFY_WS_BASE", "");
    let rs = await freshSettings();
    rs.writeComfyConnection({
      httpUrl: "http://192.168.1.20:8188",
      mode: "lan",
      authToken: "secret",
    });
    vi.resetModules();
    let { env } = await import("@/lib/env");
    expect(env.COMFY_HTTP_URL).toBe("http://192.168.1.20:8188");
    expect(env.COMFY_WS_BASE).toBe("ws://192.168.1.20:8188");

    vi.stubEnv("COMFY_HTTP_URL", "http://10.0.0.9:8188");
    rs = await freshSettings();
    ({ env } = await import("@/lib/env"));
    expect(env.COMFY_HTTP_URL).toBe("http://10.0.0.9:8188");
    expect(rs.runtimeComfyHttpUrl()).toBeUndefined();
    expect(rs.runtimeComfyToken()).toBeUndefined();
  });

  it("sanitize drops credentials in URLs, bad modes and newer schemas", async () => {
    const rs = await freshSettings();
    expect(
      rs.sanitizeRuntimeSettings({
        version: 1,
        comfy: { httpUrl: "http://u:p@h:1", mode: "lan" },
      }),
    ).toEqual({ version: 1 });
    expect(
      rs.sanitizeRuntimeSettings({
        version: 1,
        comfy: { httpUrl: "javascript:alert(1)" },
      }),
    ).toEqual({ version: 1 });
    expect(
      rs.sanitizeRuntimeSettings({
        version: 99,
        comfy: { httpUrl: "http://h:1" },
      }),
    ).toEqual({ version: 1 });
    expect(
      rs.sanitizeRuntimeSettings({
        version: 1,
        comfy: { httpUrl: "http://h:1/", mode: "evil", civitaiKey: "x" },
        other: "x",
      }),
    ).toEqual({
      version: 1,
      comfy: { httpUrl: "http://h:1", mode: "local", updatedAt: "" },
    });
  });

  it("a corrupt file reads as empty", async () => {
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
    fs.writeFileSync(file, "{not json");
    const rs = await freshSettings();
    expect(rs.readRuntimeSettings()).toEqual({ version: 1 });
  });

  it("wsBaseFromHttp", async () => {
    const rs = await freshSettings();
    expect(rs.wsBaseFromHttp("https://a.b/x/")).toBe("wss://a.b/x");
    expect(rs.wsBaseFromHttp("http://a:8188")).toBe("ws://a:8188");
  });
});

// ---------------------------------------------------------------- route auth

const LOCAL = "http://127.0.0.1:3000";

function req(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return new NextRequest(url, {
    method,
    headers: { host: new URL(url).host, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loadRoutes(opts: { key?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
  vi.stubEnv("ADMIN_API_KEY", opts.key ?? "");
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("COMFY_HTTP_URL", "");
  vi.stubEnv("COMFY_BEARER", "");
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  const main = await import("@/app/api/settings/comfy-connection/route");
  const test = await import("@/app/api/settings/comfy-connection/test/route");
  const auth = await import("@/lib/onboarding/settingsAuth");
  return { main, test, auth };
}

describe("settings auth helpers", () => {
  it("isSameOrigin / isLoopbackRequest", async () => {
    const { auth } = await loadRoutes();
    const u = `${LOCAL}/api/settings/comfy-connection`;
    expect(auth.isSameOrigin(req("PUT", u, { origin: LOCAL }))).toBe(true);
    expect(
      auth.isSameOrigin(req("PUT", u, { origin: "http://evil.test" })),
    ).toBe(false);
    expect(auth.isSameOrigin(req("PUT", u, { origin: "null" }))).toBe(false);
    expect(
      auth.isSameOrigin(req("PUT", u, { referer: "http://evil.test/x" })),
    ).toBe(false);
    expect(auth.isSameOrigin(req("PUT", u))).toBe(true);

    expect(auth.isLoopbackRequest(req("PUT", u))).toBe(true);
    expect(
      auth.isLoopbackRequest(req("PUT", u, { "x-forwarded-for": "8.8.8.8" })),
    ).toBe(false);
    expect(
      auth.isLoopbackRequest(
        req("PUT", "http://192.168.1.5:3000/api/settings/comfy-connection"),
      ),
    ).toBe(false);
    expect(
      auth.isLoopbackRequest(
        req("PUT", "http://[::1]:3000/api/settings/comfy-connection"),
      ),
    ).toBe(true);
  });
});

describe("/api/settings/comfy-connection", () => {
  const URL_ = `${LOCAL}/api/settings/comfy-connection`;
  const SAME = { origin: LOCAL, "content-type": "application/json" };

  it("dev mode: a loopback same-origin PUT saves; GET never returns the token", async () => {
    const { main } = await loadRoutes();
    const put = await main.PUT(
      req("PUT", URL_, SAME, {
        url: "192.168.1.20",
        mode: "lan",
        token: "s3cret",
      }),
    );
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved).toMatchObject({
      source: "saved",
      httpUrl: "http://192.168.1.20:8188",
      hasToken: true,
      wsBase: "ws://192.168.1.20:8188",
    });
    expect(JSON.stringify(saved)).not.toContain("s3cret");

    const get = await main.GET(req("GET", `${URL_}?quick=1`));
    const body = await get.json();
    expect(body).toMatchObject({
      configured: true,
      reachable: false,
      source: "saved",
    });
    expect(JSON.stringify(body)).not.toContain("s3cret");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // quick=1: only /system_stats was tried
    expect(
      fetchMock.mock.calls.every((c) => String(c[0]).endsWith("/system_stats")),
    ).toBe(true);

    const del = await main.DELETE(req("DELETE", URL_, SAME));
    expect((await del.json()).source).toBe("default");
  });

  it("dev mode: cross-origin and non-loopback writes are refused", async () => {
    const { main, test } = await loadRoutes();
    const body = { url: "10.0.0.2", mode: "lan" };
    expect(
      (await main.PUT(req("PUT", URL_, { origin: "http://evil.test" }, body)))
        .status,
    ).toBe(403);
    expect(
      (
        await main.PUT(
          req("PUT", URL_, { ...SAME, "x-forwarded-for": "203.0.113.9" }, body),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await test.POST(
          req("POST", `${URL_}/test`, { origin: "http://evil.test" }, body),
        )
      ).status,
    ).toBe(403);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("env-pinned URL answers 409", async () => {
    const { main } = await loadRoutes();
    vi.stubEnv("COMFY_HTTP_URL", "http://10.0.0.9:8188");
    const r = await main.PUT(
      req("PUT", URL_, SAME, { url: "10.0.0.2", mode: "lan" }),
    );
    expect(r.status).toBe(409);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects bad input", async () => {
    const { main } = await loadRoutes();
    for (const b of [
      { url: "ftp://x", mode: "lan" },
      { url: "10.0.0.2", mode: "nope" },
      { url: "10.0.0.2", mode: "lan", token: "a b" },
    ])
      expect((await main.PUT(req("PUT", URL_, SAME, b))).status).toBe(400);
  });

  it("with ADMIN_API_KEY: no creds 401, bearer key works from any host", async () => {
    const { main } = await loadRoutes({ key: "k-123" });
    const remote = "http://192.168.1.5:3000/api/settings/comfy-connection";
    expect((await main.GET(req("GET", remote))).status).toBe(401);
    expect(
      (await main.PUT(req("PUT", remote, {}, { url: "10.0.0.2", mode: "lan" })))
        .status,
    ).toBe(401);
    const ok = await main.PUT(
      req(
        "PUT",
        remote,
        { authorization: "Bearer k-123" },
        { url: "10.0.0.2", mode: "lan" },
      ),
    );
    expect(ok.status).toBe(200);
  });

  it("test route probes without saving", async () => {
    const { test } = await loadRoutes();
    const r = await test.POST(
      req("POST", `${URL_}/test`, SAME, { url: "10.0.0.2", mode: "lan" }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: true,
      normalizedUrl: "http://10.0.0.2:8188",
      result: { ok: false, code: "unreachable" },
    });
    expect(fs.existsSync(file)).toBe(false);
  });
});
