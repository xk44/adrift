/**
 * The "onboarded" flag lives server-side (data/runtime_settings.json) so every
 * device skips the wizard once one completes it; localStorage is a cache.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-onboarded-"));
  file = path.join(dir, "rt.json");
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
  vi.stubEnv("ADMIN_API_KEY", "");
  vi.resetModules();
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (method: string) =>
  new NextRequest("http://localhost:3000/api/settings/onboarded", {
    method,
    headers: { host: "localhost:3000" },
  });

describe("runtime settings onboardedAt", () => {
  it("writeOnboarded persists once and keeps the comfy connection", async () => {
    const rt = await import("@/lib/runtimeSettings");
    rt.writeComfyConnection({
      httpUrl: "http://127.0.0.1:8188",
      mode: "local",
    });
    const first = rt.writeOnboarded().onboardedAt;
    expect(first).toBeTruthy();
    expect(rt.writeOnboarded().onboardedAt).toBe(first);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.onboardedAt).toBe(first);
    expect(onDisk.comfy.httpUrl).toBe("http://127.0.0.1:8188");
    // Saving the connection again keeps the flag.
    rt.writeComfyConnection(null);
    expect(rt.readRuntimeSettings().onboardedAt).toBe(first);
  });
});

describe("/api/settings/onboarded", () => {
  it("GET false, POST marks it, GET true", async () => {
    const { GET, POST } = await import("@/app/api/settings/onboarded/route");
    expect(await (await GET(req("GET"))).json()).toEqual({
      ok: true,
      onboarded: false,
    });
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(await (await GET(req("GET"))).json()).toEqual({
      ok: true,
      onboarded: true,
    });
  });

  it("needs admin auth when a key is set", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    vi.resetModules();
    const { POST } = await import("@/app/api/settings/onboarded/route");
    expect((await POST(req("POST"))).status).toBe(401);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("onboarding store", () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }

  it("markOnboarded caches locally and POSTs to the server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    vi.stubGlobal("fetch", fetchMock);
    const s = await import("@/store/onboardingStore");
    expect(s.readOnboarded()).toBe(false);
    s.markOnboarded();
    expect(s.readOnboarded()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/onboarded",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a server 'onboarded' skips the wizard on a fresh device and fills the cache", async () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const s = await import("@/store/onboardingStore");
    expect(s.syncOnboardedFromServer(undefined)).toBe(false);
    expect(s.syncOnboardedFromServer(false)).toBe(false);
    expect(s.syncOnboardedFromServer(true)).toBe(true);
    expect(s.readOnboarded()).toBe(true);
    // Cached copy still counts when the server can't be reached later.
    expect(s.syncOnboardedFromServer(undefined)).toBe(true);
  });

  it("the host consults the server flag", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/onboarding/OnboardingHost.tsx"),
      "utf8",
    );
    expect(src).toContain("syncOnboardedFromServer(latest?.onboarded)");
  });
});
