/**
 * Live previews: the preview_method merge helper, the runtime setting and
 * the /api/settings/previews route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  invalidateRuntimeSettingsCache,
  readPreviewMethod,
  readRuntimeSettings,
  sanitizeRuntimeSettings,
  writePreviewMethod,
} from "@/lib/runtimeSettings";
import { parsePreviewMethod, withPreviewMethod } from "@/lib/comfy/previewMethod";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-preview-"));
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(tmp, "rs.json"));
  invalidateRuntimeSettingsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  invalidateRuntimeSettingsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("withPreviewMethod", () => {
  it("adds preview_method and keeps other extra_data keys", () => {
    expect(withPreviewMethod(undefined, "auto")).toEqual({ preview_method: "auto" });
    const pnginfo = { extra_pnginfo: { cj: { v: 1 } } };
    expect(withPreviewMethod(pnginfo, "latent2rgb")).toEqual({
      ...pnginfo,
      preview_method: "latent2rgb",
    });
  });
  it("a caller-set preview_method wins", () => {
    expect(withPreviewMethod({ preview_method: "taesd" }, "none")).toEqual({
      preview_method: "taesd",
    });
  });
  it("parsePreviewMethod accepts only the three settings", () => {
    expect(parsePreviewMethod("auto")).toBe("auto");
    expect(parsePreviewMethod("none")).toBe("none");
    expect(parsePreviewMethod("taesd")).toBeNull();
    expect(parsePreviewMethod(3)).toBeNull();
  });
});

describe("previewMethod runtime setting", () => {
  it("defaults to auto, saves, and stores auto as absent", () => {
    expect(readPreviewMethod()).toBe("auto");
    writePreviewMethod("none");
    expect(readPreviewMethod()).toBe("none");
    writePreviewMethod("auto");
    expect(readRuntimeSettings().previewMethod).toBeUndefined();
    expect(readPreviewMethod()).toBe("auto");
  });
  it("sanitize drops unknown values", () => {
    expect(sanitizeRuntimeSettings({ previewMethod: "bogus" }).previewMethod).toBeUndefined();
    expect(sanitizeRuntimeSettings({ previewMethod: "latent2rgb" }).previewMethod).toBe(
      "latent2rgb",
    );
  });
});

describe("/api/settings/previews", () => {
  const URL_ = "http://127.0.0.1:3000/api/settings/previews";
  const SAME = { origin: "http://127.0.0.1:3000", "content-type": "application/json" };
  const req = (method: string, body?: unknown) =>
    new NextRequest(URL_, {
      method,
      headers: { host: "127.0.0.1:3000", ...SAME },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function load() {
    vi.resetModules();
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
    return import("@/app/api/settings/previews/route");
  }

  it("GET returns the method; PUT saves; bad input is 400", async () => {
    const route = await load();
    const g = await route.GET(req("GET"));
    expect(await g.json()).toEqual({ ok: true, method: "auto" });
    const p = await route.PUT(req("PUT", { method: "latent2rgb" }));
    expect(p.status).toBe(200);
    expect(await p.json()).toEqual({ ok: true, method: "latent2rgb" });
    const bad = await route.PUT(req("PUT", { method: "fast" }));
    expect(bad.status).toBe(400);
  });
});
