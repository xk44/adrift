/**
 * Upscaler of choice, client side: picker grouping / search, the "uses X"
 * line, the shared /api/settings/upscaler cache (+ legacy localStorage
 * migration) and the Settings card markup. fetch is mocked; nothing queued.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toUpscaleModelOptions } from "@/lib/upscale/upscaleModels";
import {
  groupUpscalerOptions,
  upscalerUsage,
  usageText,
} from "@/lib/upscale/upscalerOptions";
import {
  getUpscalerDefaults,
  loadUpscalerDefaults,
  resetUpscalerDefaultsCache,
  saveUpscalerDefaults,
  subscribeUpscalerDefaults,
  type UpscalerDefaults,
} from "@/lib/upscale/upscalerDefaultsClient";
import { UPSCALE_MODEL_PREF_KEY } from "@/lib/upscale/upscalePrefs";
import { imageUpscaleContent } from "@/lib/upscale/upscalerPref";
import { UpscalerSettings } from "@/components/settings/UpscalerSettings";

const OPTIONS = toUpscaleModelOptions([
  "4x-UltraSharp.pth",
  "4x-AnimeSharp.pth",
  "RealESRGAN_x2plus.pth",
  "1x-Kim2091-DeJpeg-v0.pth",
  "8x_NMKD-Faces_160000_G.pth",
  "4x_NMKD-Siax_200k.pth",
]);

const DEFAULTS: UpscalerDefaults = {
  pref: { illustration: "4x-AnimeSharp.pth" },
  locked: true,
  available: true,
  models: OPTIONS,
  resolved: {
    photo: { file: "4x-UltraSharp.pth", source: "table" },
    illustration: { file: "4x-AnimeSharp.pth", source: "choice" },
    video: null,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetUpscalerDefaultsCache();
});

describe("groupUpscalerOptions", () => {
  it("groups in catalog order", () => {
    const g = groupUpscalerOptions(OPTIONS);
    expect(g.map((x) => x.category)).toEqual([
      "photo",
      "illustration",
      "2x",
      "cleanup",
      "faces",
    ]);
    expect(g[0].options.map((o) => o.name)).toEqual(
      expect.arrayContaining(["UltraSharp"]),
    );
  });

  it("searches name, file, tags and group; all words must match", () => {
    const names = (q: string) =>
      groupUpscalerOptions(OPTIONS, { query: q }).flatMap((g) =>
        g.options.map((o) => o.file),
      );
    expect(names("anime")).toEqual(["4x-AnimeSharp.pth"]);
    expect(names("2x")).toContain("RealESRGAN_x2plus.pth");
    expect(names("dejpeg")).toEqual(["1x-Kim2091-DeJpeg-v0.pth"]);
    expect(names("sharp 4x")).toContain("4x-UltraSharp.pth");
    expect(names("zzz")).toEqual([]);
  });

  it("defaultsOnly drops cleanup and face models", () => {
    const cats = groupUpscalerOptions(OPTIONS, { defaultsOnly: true }).map(
      (g) => g.category,
    );
    expect(cats).not.toContain("cleanup");
    expect(cats).not.toContain("faces");
  });
});

describe("upscalerUsage", () => {
  it("names the default and its source", () => {
    const u = upscalerUsage("", "photo", DEFAULTS);
    expect(u).toMatchObject({ file: "4x-UltraSharp.pth", source: "table" });
    expect(usageText(u)).toBe(
      "Uses UltraSharp 4× · recommended default · locked",
    );
    expect(usageText(upscalerUsage("", "illustration", DEFAULTS))).toBe(
      "Uses AnimeSharp 4× · your default · locked",
    );
    expect(
      usageText(upscalerUsage("", "photo", { ...DEFAULTS, locked: false })),
    ).toBe("Uses UltraSharp 4× · recommended default");
  });

  it("per-run override wins; unknown defaults fall back to plain text", () => {
    expect(
      usageText(upscalerUsage("RealESRGAN_x2plus.pth", "photo", DEFAULTS)),
    ).toBe("Uses Real-ESRGAN 2× for this run only.");
    expect(usageText(upscalerUsage("", "video", DEFAULTS))).toBe(
      "Uses the default upscaler from Settings.",
    );
    expect(usageText(upscalerUsage("", "photo", null))).toBe(
      "Uses the default upscaler from Settings.",
    );
  });
});

describe("imageUpscaleContent", () => {
  it("reads checkpoint and LoRA names", () => {
    expect(imageUpscaleContent({ model: "flux1-dev.safetensors" })).toBe(
      "photo",
    );
    expect(imageUpscaleContent({ model: "illustriousXL.safetensors" })).toBe(
      "illustration",
    );
    expect(
      imageUpscaleContent({
        model: "sdxl.safetensors",
        loras: [{ name: "x", filename: "anime_style.safetensors" }],
      }),
    ).toBe("illustration");
    expect(imageUpscaleContent({})).toBe("photo");
  });
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    _m: m,
  };
}

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("upscaler defaults client", () => {
  const body = { ok: true, ...DEFAULTS };

  it("loads once, shares the snapshot, and refetches on fresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(body));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([
      loadUpscalerDefaults(),
      loadUpscalerDefaults(),
    ]);
    expect(a).toEqual(DEFAULTS);
    expect(b).toBe(a);
    expect(getUpscalerDefaults()).toBe(a);
    await loadUpscalerDefaults();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadUpscalerDefaults(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/settings/upscaler?fresh=1",
    );
  });

  it("returns null when not allowed or offline, then retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(okJson(body));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadUpscalerDefaults()).toBeNull();
    expect(await loadUpscalerDefaults()).toBeNull();
    expect(await loadUpscalerDefaults()).toEqual(DEFAULTS);
  });

  it("saves a patch and notifies subscribers; errors throw", async () => {
    const saved = {
      ...body,
      pref: { photo: "4x_NMKD-Siax_200k.pth" },
      resolved: {
        ...DEFAULTS.resolved,
        photo: { file: "4x_NMKD-Siax_200k.pth", source: "choice" },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(saved))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error: "photo: not a model file name",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const seen: unknown[] = [];
    const off = subscribeUpscalerDefaults((d) => seen.push(d?.pref));
    await saveUpscalerDefaults({ photo: "4x_NMKD-Siax_200k.pth" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ photo: "4x_NMKD-Siax_200k.pth" }),
    });
    expect(seen).toEqual([{ photo: "4x_NMKD-Siax_200k.pth" }]);
    await expect(saveUpscalerDefaults({ photo: "/x" })).rejects.toThrow(
      "photo: not a model file name",
    );
    off();
  });

  it("moves the legacy browser choice into the photo default once", async () => {
    const storage = memoryStorage();
    storage.setItem(UPSCALE_MODEL_PREF_KEY, "4x_NMKD-Siax_200k.pth");
    vi.stubGlobal("window", { localStorage: storage });
    const migrated = {
      ...body,
      pref: { ...DEFAULTS.pref, photo: "4x_NMKD-Siax_200k.pth" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(body))
      .mockResolvedValueOnce(okJson(migrated));
    vi.stubGlobal("fetch", fetchMock);
    const d = await loadUpscalerDefaults();
    expect(d?.pref.photo).toBe("4x_NMKD-Siax_200k.pth");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ photo: "4x_NMKD-Siax_200k.pth" }),
    });
    expect(storage._m.has(UPSCALE_MODEL_PREF_KEY)).toBe(false);
  });

  it("never overwrites a saved photo default, and skips 1x / face legacy picks", async () => {
    for (const [legacy, pref] of [
      ["4x_NMKD-Siax_200k.pth", { photo: "4x-UltraSharp.pth" }],
      ["1x-Kim2091-DeJpeg-v0.pth", {}],
    ] as const) {
      resetUpscalerDefaultsCache();
      const storage = memoryStorage();
      storage.setItem(UPSCALE_MODEL_PREF_KEY, legacy);
      vi.stubGlobal("window", { localStorage: storage });
      const fetchMock = vi.fn().mockResolvedValue(okJson({ ...body, pref }));
      vi.stubGlobal("fetch", fetchMock);
      await loadUpscalerDefaults();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(storage._m.has(UPSCALE_MODEL_PREF_KEY)).toBe(false);
    }
  });
});

describe("UpscalerSettings", () => {
  it("renders the three defaults, the scale select and the lock", () => {
    const html = renderToStaticMarkup(<UpscalerSettings />);
    expect(html).toContain("Photos &amp; general");
    expect(html).toContain("Illustration &amp; anime");
    expect(html).toContain("Video frames");
    expect(html).toContain("Faithful upscale size");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });
});
