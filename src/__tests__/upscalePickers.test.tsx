/**
 * Upscale pickers: tool-page request params, Quick edit plan, per-run
 * override, and the shared UpscaleModelPicker markup. Nothing is queued.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  sliderVisible,
} from "@/lib/tools/toolsPage";
import { planQuickEdit } from "@/lib/quickEdit";
import {
  UPSCALE_MODEL_PREF_KEY,
  readUpscaleModelPref,
  subscribeUpscaleModelPref,
  takeLegacyUpscaleModel,
  upscaleActionParams,
  writeUpscaleModelPref,
} from "@/lib/upscale/upscalePrefs";
import {
  UpscaleModelPicker,
  loadUpscaleModels,
  resetUpscaleModelCache,
} from "@/components/upscale/UpscaleModelPicker";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    _m: m,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetUpscaleModelCache();
  writeUpscaleModelPref("");
});

describe("Upscale tool request", () => {
  const spec = getActionTool("upscale")!;

  it("Faithful sends the chosen model only", () => {
    const s = defaultSettings(spec);
    s.picks = { mode: "upscale_subtle", upscale_model: "4x-UltraSharp.pth" };
    expect(buildActionRequest(spec, s, null)).toEqual({
      action: "upscale_subtle",
      params: { upscale_model: "4x-UltraSharp.pth" },
      overrides: {},
    });
  });

  it("Faithful with the standard model sends no params", () => {
    expect(buildActionRequest(spec, defaultSettings(spec), null).params).toEqual(
      {},
    );
  });

  it("Creative sends model + creativity (slider only shown for Creative)", () => {
    const s = defaultSettings(spec);
    s.picks = {
      mode: "upscale_creative",
      upscale_model: "RealESRGAN_x2plus.pth",
      creativity: "62",
    };
    const slider = spec.sliders!.find((x) => x.key === "creativity")!;
    expect(sliderVisible(slider, spec, s)).toBe(true);
    expect(sliderVisible(slider, spec, defaultSettings(spec))).toBe(false);
    expect(buildActionRequest(spec, s, null)).toEqual({
      action: "upscale_creative",
      params: { upscale_model: "RealESRGAN_x2plus.pth", creativity: 60 },
      overrides: {},
    });
  });

  it("drops an unsafe model name", () => {
    const s = defaultSettings(spec);
    s.picks = { mode: "upscale_subtle", upscale_model: "../../x.pth" };
    expect(buildActionRequest(spec, s, null).params).toEqual({});
  });
});

describe("Quick edit upscale plan", () => {
  const base = {
    mode: "upscale" as const,
    prompt: "",
    hasMask: false,
    expand: "square" as never,
  };
  const ctx = { catalog: [], editLoras: null };

  it("carries the model choice into the tool settings", () => {
    const plan = planQuickEdit(
      { ...base, upscale: "upscale_creative", upscaleModel: "4x-UltraSharp.pth" },
      ctx,
    );
    if (!("kind" in plan) || plan.kind !== "action") throw new Error("no plan");
    expect(plan.settings.picks).toMatchObject({
      mode: "upscale_creative",
      upscale_model: "4x-UltraSharp.pth",
    });
    expect(buildActionRequest(plan.spec, plan.settings, null).params).toEqual({
      upscale_model: "4x-UltraSharp.pth",
      creativity: 35,
    });
  });

  it("omits the model when none is chosen", () => {
    const plan = planQuickEdit({ ...base, upscale: "upscale_subtle" }, ctx);
    if (!("kind" in plan) || plan.kind !== "action") throw new Error("no plan");
    expect(plan.settings.picks.upscale_model).toBeUndefined();
  });
});

describe("per-run upscale model override", () => {
  it("is session-only and notifies pickers", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const seen: string[] = [];
    const off = subscribeUpscaleModelPref((m) => seen.push(m));
    writeUpscaleModelPref("4x-UltraSharp.pth");
    expect(storage._m.size).toBe(0);
    expect(readUpscaleModelPref()).toBe("4x-UltraSharp.pth");
    expect(upscaleActionParams("upscale_subtle")).toEqual({
      upscale_model: "4x-UltraSharp.pth",
    });
    expect(upscaleActionParams("upscale_creative")).toEqual({
      upscale_model: "4x-UltraSharp.pth",
      creativity: 35,
    });
    expect(upscaleActionParams("vary_subtle")).toBeUndefined();
    writeUpscaleModelPref("");
    off();
    expect(seen).toEqual(["4x-UltraSharp.pth", ""]);
    expect(upscaleActionParams("upscale_subtle")).toEqual({});
  });

  it("drops junk values", () => {
    writeUpscaleModelPref("../evil.pth");
    expect(readUpscaleModelPref()).toBe("");
  });

  it("takes the legacy localStorage choice once, guarded", () => {
    const storage = memoryStorage();
    storage.setItem(UPSCALE_MODEL_PREF_KEY, "4x-UltraSharp.pth");
    vi.stubGlobal("window", { localStorage: storage });
    expect(takeLegacyUpscaleModel()).toBe("4x-UltraSharp.pth");
    expect(storage._m.has(UPSCALE_MODEL_PREF_KEY)).toBe(false);
    expect(takeLegacyUpscaleModel()).toBe("");
    storage.setItem(UPSCALE_MODEL_PREF_KEY, "../evil.pth");
    expect(takeLegacyUpscaleModel()).toBe("");
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("blocked");
      },
    });
    expect(takeLegacyUpscaleModel()).toBe("");
  });

  it("works with no window (server render)", () => {
    expect(takeLegacyUpscaleModel()).toBe("");
  });
});

describe("UpscaleModelPicker", () => {
  it("renders the standard option, the current choice and the mode hint", () => {
    const html = renderToStaticMarkup(
      <UpscaleModelPicker
        value="4x-UltraSharp.pth"
        onChange={() => {}}
        mode="upscale_subtle"
      />,
    );
    expect(html).toContain("Upscale model");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('value="4x-UltraSharp.pth"');
    expect(html).toContain("Faithful keeps every pixel honest");
  });

  it("shows the Creative hint", () => {
    const html = renderToStaticMarkup(
      <UpscaleModelPicker mode="upscale_creative" compact />,
    );
    expect(html).toContain("Creative invents fine detail");
  });

  it("inline mode stays out of the way until there is a choice", () => {
    // Options load after mount, so the server render is empty.
    expect(renderToStaticMarkup(<UpscaleModelPicker inline />)).toBe("");
  });

  it("fetches options once and retries after a failure", async () => {
    const models = [{ file: "a_4x.pth", scale: 4, label: "a_4x · 4×" }];
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, models }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadUpscaleModels()).toBeNull();
    expect(await loadUpscaleModels()).toEqual(models);
    expect(await loadUpscaleModels()).toEqual(models);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/comfy/upscale-models");
  });

  it("shows the default for a fresh picker and the per-run pick", () => {
    expect(renderToStaticMarkup(<UpscaleModelPicker compact />)).toContain(
      "Uses the default upscaler from Settings.",
    );
    writeUpscaleModelPref("4x-AnimeSharp.pth");
    const html = renderToStaticMarkup(<UpscaleModelPicker compact />);
    expect(html).toContain("AnimeSharp");
    expect(html).toContain("Uses AnimeSharp 4× for this run only.");
  });

  it("Settings variant shows the recommended choice, no usage line", () => {
    const html = renderToStaticMarkup(
      <UpscaleModelPicker
        variant="default"
        content="illustration"
        label="Illustration & anime"
        value=""
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Illustration &amp; anime");
    expect(html).toContain("Recommended");
    expect(html).not.toContain("upscale-model-usage");
  });
});
