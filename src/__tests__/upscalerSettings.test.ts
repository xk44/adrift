/**
 * Upscaler preference: the runtime setting and /api/settings/upscaler, plus
 * applyUpscalerPreference (the queuePrompt step) against a mocked
 * /object_info. Nothing is queued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  invalidateRuntimeSettingsCache,
  readRuntimeSettings,
  readUpscalerPref,
  sanitizeRuntimeSettings,
  writeUpscalerPref,
} from "@/lib/runtimeSettings";

const OBJECT_INFO = {
  UpscaleModelLoader: {
    input: {
      required: {
        model_name: [
          "COMBO",
          {
            options: [
              "RealESRGAN_x4plus.pth",
              "4x-UltraSharp.pth",
              "4x-AnimeSharp.pth",
              "GFPGANv1.4.pth",
            ],
          },
        ],
      },
    },
  },
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-upscaler-"));
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(tmp, "rs.json"));
  invalidateRuntimeSettingsCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  vi.doUnmock("@/lib/comfy/objectInfoCache");
  invalidateRuntimeSettingsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("upscaler runtime setting", () => {
  it("is absent by default, saves, and clears", () => {
    expect(readUpscalerPref()).toBeNull();
    writeUpscalerPref({ photo: "4x-UltraSharp.pth", lock: false });
    expect(readUpscalerPref()).toEqual({
      photo: "4x-UltraSharp.pth",
      lock: false,
    });
    writeUpscalerPref(null);
    expect(readRuntimeSettings().upscaler).toBeUndefined();
  });

  it("sanitize drops bad values", () => {
    expect(
      sanitizeRuntimeSettings({ upscaler: { photo: "../x.pth", scale: 9 } })
        .upscaler,
    ).toBeUndefined();
    expect(
      sanitizeRuntimeSettings({ upscaler: { video: "RealESRGAN_x4plus.pth" } })
        .upscaler,
    ).toEqual({ video: "RealESRGAN_x4plus.pth" });
  });
});

describe("/api/settings/upscaler", () => {
  const URL_ = "http://127.0.0.1:3000/api/settings/upscaler";
  const SAME = {
    origin: "http://127.0.0.1:3000",
    "content-type": "application/json",
  };
  const req = (method: string, body?: unknown) =>
    new NextRequest(URL_, {
      method,
      headers: { host: "127.0.0.1:3000", ...SAME },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function load(info: unknown = OBJECT_INFO) {
    vi.resetModules();
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: () => ({ ok: true }),
    }));
    vi.doMock("@/lib/comfy/objectInfoCache", () => ({
      getObjectInfoCached: async () => info,
    }));
    return import("@/app/api/settings/upscaler/route");
  }

  it("GET reports the table defaults and live models", async () => {
    const route = await load();
    const d = await (await route.GET(req("GET"))).json();
    expect(d).toMatchObject({
      ok: true,
      pref: {},
      locked: true,
      available: true,
      resolved: {
        photo: { file: "4x-UltraSharp.pth", source: "table" },
        illustration: { file: "4x-AnimeSharp.pth", source: "table" },
        video: { file: "RealESRGAN_x4plus.pth", source: "table" },
      },
    });
    expect(d.models.map((m: { file: string }) => m.file)).not.toContain(
      "GFPGANv1.4.pth",
    );
    expect(
      d.models.find((m: { file: string }) => m.file === "4x-AnimeSharp.pth"),
    ).toMatchObject({ name: "AnimeSharp", category: "illustration" });
  });

  it("PUT saves a choice, unlocks, and rejects bad input", async () => {
    const route = await load();
    const p = await route.PUT(
      req("PUT", { photo: "RealESRGAN_x4plus.pth", lock: false, scale: 2 }),
    );
    expect(p.status).toBe(200);
    const d = await p.json();
    expect(d.pref).toEqual({
      photo: "RealESRGAN_x4plus.pth",
      lock: false,
      scale: 2,
    });
    expect(d.locked).toBe(false);
    expect(d.resolved.photo).toEqual({
      file: "RealESRGAN_x4plus.pth",
      source: "choice",
    });
    expect((await route.PUT(req("PUT", { photo: "/abs.pth" }))).status).toBe(
      400,
    );
    expect((await route.PUT(req("PUT", [1]))).status).toBe(400);
    const cleared = await (
      await route.PUT(req("PUT", { photo: null, lock: true, scale: null }))
    ).json();
    expect(cleared.pref).toEqual({});
  });

  it("GET without ComfyUI still returns the preference", async () => {
    const route = await load(null);
    const d = await (await route.GET(req("GET"))).json();
    expect(d).toMatchObject({
      ok: true,
      available: false,
      models: null,
      resolved: null,
    });
  });
});

describe("applyUpscalerPreference", () => {
  const g = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: "RealESRGAN_x4plus.pth" },
    },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: { image: ["1", 0], upscale_model: ["2", 0] },
    },
  };

  async function load(info: unknown) {
    vi.resetModules();
    vi.doMock("@/lib/comfy/objectInfoCache", () => ({
      getObjectInfoCached: async () => {
        if (info instanceof Error) throw info;
        return info;
      },
    }));
    return import("@/lib/upscale/applyUpscalerPref");
  }

  it("rewrites with the saved choice", async () => {
    writeUpscalerPref({ photo: "4x-AnimeSharp.pth" });
    const m = await load(OBJECT_INFO);
    const r = await m.applyUpscalerPreference(g);
    expect(r.prompt["2"].inputs.model_name).toBe("4x-AnimeSharp.pth");
  });

  it("never breaks a run when ComfyUI is unreachable", async () => {
    const m = await load(new Error("down"));
    expect((await m.applyUpscalerPreference(g)).prompt).toBe(g);
    const m2 = await load(null);
    expect((await m2.applyUpscalerPreference(g)).prompt).toBe(g);
  });
});
