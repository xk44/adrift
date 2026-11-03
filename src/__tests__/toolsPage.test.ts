import { describe, it, expect, vi } from "vitest";
import {
  ACTION_TOOLS,
  CATEGORY_ORDER,
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  buildCatalogBody,
  buildToolCards,
  OUTPAINT_CARD_KEY,
  OUTPAINT_ZOOM_PRESETS,
  outpaintEffectiveSteps,
  pickFastestOutpaint,
  resolveOutpaintTool,
  zoomPresetSettings,
  catalogUnavailableReason,
  defaultSettings,
  getActionTool,
  licenseNoteFor,
  overlayToMaskPixels,
  maskSize,
  outpaintOption,
  previewCatalogPrompt,
  sidesFor,
  type CatalogTool,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import {
  ToolApiError,
  describeCaption,
  submitActionTool,
  submitCatalogTool,
  type FetchLike,
  type ToolImage,
} from "@/lib/tools/runTool";

function catalogTool(over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    id: "t1",
    label: "Tool One",
    category: "Camera",
    base: "qwen",
    baseLabel: "Qwen Edit",
    description: "d",
    loras: [{ file: "edit_tools/foo.safetensors", strength: 1 }],
    extras: { keepFraming: null },
    speed: { supported: false },
    defaults: { steps: 20, cfg: 4 },
    refCount: 1,
    refLabels: ["Photo"],
    needsMask: false,
    outpaint: null,
    promptMode: "none",
    promptTemplate: "",
    promptHint: "",
    options: [],
    requiresNodes: null,
    license: { name: "MIT", commercial: true, note: "" },
    sourceUrl: "",
    installed: true,
    packAvailable: true,
    available: true,
    ...over,
  } as CatalogTool;
}

const loras: EditLoraListResponse = {
  families: { krea2edit: { label: "Krea 2 Edit" } },
  loras: [
    {
      id: "k1",
      name: "K1",
      file: "k1.safetensors",
      family: "krea2edit",
      base: "krea2",
      defaultStrength: 0.9,
      installed: true,
    },
  ] as EditLoraListResponse["loras"],
};

describe("cards and grouping", () => {
  it("builds all action cards plus every catalog tool", () => {
    const cards = buildToolCards({
      catalog: [catalogTool(), catalogTool({ id: "t2", category: "Edit" })],
      packIds: new Set(["krea2-edit", "qwen-image-21"]),
      editLoras: loras,
    });
    expect(cards.filter((c) => c.kind === "action")).toHaveLength(
      ACTION_TOOLS.filter((t) => !t.hidden).length,
    );
    expect(cards.filter((c) => c.kind === "catalog")).toHaveLength(2);
  });

  it("every action category is in CATEGORY_ORDER", () => {
    for (const t of ACTION_TOOLS)
      expect(CATEGORY_ORDER, t.id).toContain(t.category);
  });

  it("explains an uninstalled LoRA", () => {
    const reason = catalogUnavailableReason(
      catalogTool({ available: false, installed: false }),
    );
    expect(reason).toMatch(/LoRA not installed: foo/);
  });

  it("explains a missing base/pack", () => {
    const reason = catalogUnavailableReason(
      catalogTool({ available: false, packAvailable: false }),
    );
    expect(reason).toMatch(/Qwen Edit/);
  });

  it("disables pack actions with a reason, and shows checking before packs load", () => {
    const spec = getActionTool("edit_qwen21")!;
    expect(actionAvailability(spec, null, null).checking).toBe(true);
    const missing = actionAvailability(spec, new Set(), null);
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/qwen-image-21/);
    expect(actionAvailability(spec, new Set(["qwen-image-21"]), null).available).toBe(true);
  });

  it("notes non-commercial licenses only", () => {
    expect(licenseNoteFor({ name: "MIT", commercial: true, note: "" })).toBeNull();
    expect(
      licenseNoteFor({ name: "NC", commercial: false, note: "research only" }),
    ).toBe("Non-commercial: research only");
    expect(licenseNoteFor({ name: "?", commercial: null, note: "" })).toMatch(
      /^Check license/,
    );
    const capped = "Revenue cap: commercial use only under US$5M revenue.";
    expect(
      licenseNoteFor({ name: "FLUX", commercial: null, note: capped, badge: "cap" }),
    ).toBe(capped);
    expect(
      licenseNoteFor({ name: "FLUX", commercial: null, note: "under US$5M", badge: "cap" }),
    ).toBe("Revenue cap: under US$5M");
  });
});

describe("outpaint", () => {
  it("maps directions to per-side fractions", () => {
    expect(sidesFor("horizontal", 0.25)).toEqual({
      left: 0.25,
      right: 0.25,
      top: 0,
      bottom: 0,
    });
    expect(sidesFor("top", 0.5)).toEqual({
      left: 0,
      right: 0,
      top: 0.5,
      bottom: 0,
    });
  });
  it("supports aspect mode and rejects zero expansion", () => {
    const s = defaultSettings();
    expect(outpaintOption({ ...s, outpaintMode: "aspect" })).toEqual({
      aspect: "16:9",
      anchor: "center",
    });
    expect(outpaintOption({ ...s, outpaintAmount: 0 })).toHaveProperty("error");
  });
});

describe("buildCatalogBody", () => {
  const ref = { run_id: "r", job_index: 0 };
  it("requires images, prompt and mask as the tool demands", () => {
    const s = defaultSettings();
    expect(() => buildCatalogBody(catalogTool(), s, [null], null, "c")).toThrow(
      ToolInputError,
    );
    const req = catalogTool({ promptMode: "required" });
    expect(() => buildCatalogBody(req, s, [ref], null, "c")).toThrow(/prompt/i);
    const m = catalogTool({ needsMask: true });
    expect(() => buildCatalogBody(m, s, [ref], null, "c")).toThrow(/Paint/);
    const body = buildCatalogBody(m, s, [ref], "data:image/png;base64,AA", "c");
    expect(body.mask).toBe("data:image/png;base64,AA");
    expect(body.toolId).toBe("t1");
    expect(body.client_id).toBe("c");
  });

  it("includes fast/keepFraming only when available, and omits prompt in none mode", () => {
    const t = catalogTool({
      speed: { supported: true, default: false, available: true, steps: 4, cfg: 1 },
      extras: {
        keepFraming: {
          label: "k",
          description: "",
          default: false,
          available: false,
        },
      },
    });
    const s = { ...defaultSettings(t), fast: true, text: "ignored" };
    const body = buildCatalogBody(t, s, [ref], null, "c");
    expect(body.options.fast).toBe(true);
    expect("keepFraming" in body.options).toBe(false);
    expect(body.prompt).toBeUndefined();
  });

  it("sends enum option defaults and outpaint sides", () => {
    const t = catalogTool({
      options: [
        {
          id: "angle",
          label: "Angle",
          type: "enum",
          default: "a",
          values: [
            { id: "a", label: "A", text: "from above" },
            { id: "b", label: "B", text: "from below" },
          ],
        },
      ],
      promptMode: "optional",
      promptTemplate: "shot {angle}. {prompt}",
      outpaint: { default: "", fill: "#808080", maxSide: 1, presets: [] },
    });
    const s = { ...defaultSettings(t), text: "hi", picks: { angle: "b" } };
    const body = buildCatalogBody(t, s, [ref], null, "c");
    expect(body.options.angle).toBe("b");
    expect(body.options.outpaint).toEqual(sidesFor("all", 0.25));
    expect(previewCatalogPrompt(t, s)).toBe("shot from below. hi");
  });
});

describe("buildActionRequest", () => {
  it("puts pack_id inside params and sets edit LoRA overrides", () => {
    const spec = getActionTool("edit_photo")!;
    const s = { ...defaultSettings(), text: "make it red" };
    const req = buildActionRequest(spec, s, loras);
    expect(req.params.pack_id).toBe("krea2-edit");
    expect(req.params.editMode).toBe("instruct");
    expect(req.overrides["2.lora_name"]).toBe("k1.safetensors");
    expect(req.overrides["2.strength_model"]).toBe(0.9);
  });
  it("requires text and an installed LoRA", () => {
    const spec = getActionTool("edit_photo")!;
    expect(() => buildActionRequest(spec, defaultSettings(), loras)).toThrow(
      ToolInputError,
    );
    expect(() =>
      buildActionRequest(spec, { ...defaultSettings(), text: "x" }, null),
    ).toThrow(/LoRA/);
  });
  it("replace person uses the dual-ref action", () => {
    const spec = getActionTool("replace_person")!;
    const s = { ...defaultSettings(), text: "the man" };
    expect(() => buildActionRequest(spec, s, loras)).toThrow(/photo/i);
    const req = buildActionRequest(spec, s, loras, "ref2.png [input]");
    expect(req.action).toBe("edit_instruct_dual");
    expect(req.params.secondRefImage).toBe("ref2.png [input]");
    expect(req.params.editMode).toBe("swap");
  });
  it("simple actions map directly", () => {
    expect(buildActionRequest(getActionTool("bg_remove")!, defaultSettings(), null).action).toBe("bg_remove");
    expect(buildActionRequest(getActionTool("make_3d")!, defaultSettings(), null).action).toBe("make_3d");
  });
});

describe("mask helpers", () => {
  it("converts painted alpha to white and counts painted pixels", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 200, 0, 0, 0, 0]);
    const { pixels, painted } = overlayToMaskPixels(rgba);
    expect(painted).toBe(1);
    expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
  it("caps the mask size", () => {
    // Source size up to the canvas-memory cap (sharp edges, no upscaling).
    expect(maskSize(4000, 2000)).toEqual({ width: 4000, height: 2000 });
    expect(maskSize(2048, 1365)).toEqual({ width: 2048, height: 1365 });
    expect(maskSize(8192, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(maskSize(100, 50)).toEqual({ width: 100, height: 50 });
  });
});

describe("runTool with mock fetch (no network)", () => {
  const upload: ToolImage = {
    id: "u",
    source: "upload",
    previewUrl: "blob:x",
    label: "u",
    width: 10,
    height: 10,
    dataUrl: "data:image/png;base64,AAAA",
  };
  const gallery: ToolImage = {
    id: "g",
    source: "gallery",
    previewUrl: "/x.png",
    label: "g",
    width: 10,
    height: 10,
    runId: "run1",
    jobIndex: 2,
  };
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: async () => body });

  it("describeCaption: posts the input to /api/describe and returns a cleaned caption", async () => {
    const f: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe("/api/describe");
      expect(init?.body).toBeInstanceOf(FormData);
      return ok({ ok: true, caption: "ohwx,  a quiet  harbor at dusk.", suggestions: ["x --v 6"] });
    });
    const blob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    expect(await describeCaption(f, upload, blob)).toBe("a quiet harbor at dusk");
    expect(blob).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    const empty: FetchLike = vi.fn(async () => ok({ ok: true, caption: "  " }));
    await expect(describeCaption(empty, upload, blob)).rejects.toBeInstanceOf(ToolApiError);
  });

  it("catalog: uploads then posts to /api/jobs/tool", async () => {
    const calls: [string, unknown][] = [];
    const f: FetchLike = vi.fn(async (url, init) => {
      calls.push([url, init?.body ? JSON.parse(String(init.body)) : null]);
      if (url === "/api/comfy/upload") return ok({ ok: true, ref: "a.png [input]" });
      return ok({ ok: true, run: { run_id: "new", jobs: [] } });
    });
    const run = await submitCatalogTool({
      fetchImpl: f,
      tool: catalogTool(),
      settings: defaultSettings(),
      images: [upload],
      mask: null,
      clientId: "c",
    });
    expect(run.run_id).toBe("new");
    expect(calls.map((c) => c[0])).toEqual(["/api/comfy/upload", "/api/jobs/tool"]);
    expect((calls[1][1] as { images: unknown[] }).images).toEqual(["a.png [input]"]);
  });

  it("catalog: gallery images skip upload", async () => {
    const f: FetchLike = vi.fn(async () => ok({ ok: true, run: { run_id: "n" } }));
    await submitCatalogTool({
      fetchImpl: f,
      tool: catalogTool(),
      settings: defaultSettings(),
      images: [gallery],
      mask: null,
      clientId: "c",
    });
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((f as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.images[0]).toEqual({ run_id: "run1", job_index: 2 });
  });

  it("reports optional-node bypass warnings via onWarnings", async () => {
    const f: FetchLike = vi.fn(async () =>
      ok({
        ok: true,
        run: { run_id: "n" },
        warnings: { nodes: ["NegPiP missing — bypassed"] },
      }),
    );
    const onWarnings = vi.fn();
    await submitCatalogTool({
      fetchImpl: f,
      tool: catalogTool(),
      settings: defaultSettings(),
      images: [gallery],
      mask: null,
      clientId: "c",
      onWarnings,
    });
    expect(onWarnings).toHaveBeenCalledWith(["NegPiP missing — bypassed"]);

    const quiet = vi.fn();
    await submitActionTool({
      fetchImpl: vi.fn(async () => ok({ ok: true, run: { run_id: "n" } })),
      spec: getActionTool("edit_photo")!,
      settings: { ...defaultSettings(), text: "red" },
      editLoras: loras,
      image: gallery,
      secondImage: null,
      clientId: "c",
      onWarnings: quiet,
    });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("validates before any network call", async () => {
    const f: FetchLike = vi.fn();
    await expect(
      submitCatalogTool({
        fetchImpl: f,
        tool: catalogTool({ promptMode: "required" }),
        settings: defaultSettings(),
        images: [upload],
        mask: null,
        clientId: "c",
      }),
    ).rejects.toThrow(ToolInputError);
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces server errors", async () => {
    const f: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "bad tool" }),
    });
    await expect(
      submitCatalogTool({
        fetchImpl: f,
        tool: catalogTool(),
        settings: defaultSettings(),
        images: [gallery],
        mask: null,
        clientId: "c",
      }),
    ).rejects.toThrow(ToolApiError);
  });

  it("action: posts run ref, params and overrides to /api/jobs/action", async () => {
    const f: FetchLike = vi.fn(async () => ok({ ok: true, run: { run_id: "n" } }));
    await submitActionTool({
      fetchImpl: f,
      spec: getActionTool("edit_photo")!,
      settings: { ...defaultSettings(), text: "red" },
      editLoras: loras,
      image: gallery,
      secondImage: null,
      clientId: "c",
    });
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/jobs/action");
    const body = JSON.parse(String(init.body));
    expect(body.run_id).toBe("run1");
    expect(body.job_index).toBe(2);
    expect(body.params.pack_id).toBe("krea2-edit");
    expect(body.workflow_control_overrides["2.lora_name"]).toBe("k1.safetensors");
  });

  it("action: uploaded source is seeded into a run first", async () => {
    const urls: string[] = [];
    const f: FetchLike = vi.fn(async (url) => {
      urls.push(url);
      if (url === "/api/comfy/upload") return ok({ ok: true, ref: "r.png [input]" });
      if (url === "/api/jobs/seed-run")
        return ok({ ok: true, run: { run_id: "seed", jobs: [{ index: 0 }] } });
      return ok({ ok: true, run: { run_id: "n" } });
    });
    await submitActionTool({
      fetchImpl: f,
      spec: getActionTool("bg_remove")!,
      settings: defaultSettings(),
      editLoras: null,
      image: upload,
      secondImage: null,
      clientId: "c",
    });
    expect(urls).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
  });
});

describe("unified Outpaint card", () => {
  const op = { default: "all_25", fill: "#808080", maxSide: 1, presets: [] };
  const qwen = (over: Partial<CatalogTool> = {}) =>
    catalogTool({
      id: "qwen21-outpaint",
      label: "Outpaint",
      category: "Expand",
      base: "qwen21",
      baseLabel: "Qwen-Image 2.1",
      outpaint: op,
      defaults: { steps: 25, cfg: 1 },
      speed: { supported: true, default: false, available: true, steps: 4, cfg: 1 },
      ...over,
    });
  const flux = (over: Partial<CatalogTool> = {}) =>
    catalogTool({
      id: "flux3-outpaint",
      label: "Outpaint",
      category: "Expand",
      base: "flux3",
      baseLabel: "FLUX.3 Klein",
      outpaint: op,
      defaults: { steps: 16, cfg: 1 },
      ...over,
    });

  it("prefers the backend with the fewest effective steps (speed LoRA)", () => {
    expect(pickFastestOutpaint([flux(), qwen()])?.id).toBe("qwen21-outpaint");
    expect(outpaintEffectiveSteps(qwen())).toBe(4);
  });

  it("ignores the speed LoRA when not installed", () => {
    const q = qwen({
      speed: { supported: true, default: false, available: false, steps: 4, cfg: 1 },
    });
    expect(outpaintEffectiveSteps(q)).toBe(25);
    expect(pickFastestOutpaint([q, flux()])?.id).toBe("flux3-outpaint");
  });

  it("falls back to the other backend when one is unavailable", () => {
    const q = qwen({ available: false, installed: false });
    expect(pickFastestOutpaint([q, flux()])?.id).toBe("flux3-outpaint");
  });

  it("switches the speed LoRA on by default for the resolved tool", () => {
    const t = resolveOutpaintTool([qwen(), flux()])!;
    expect(defaultSettings(t).fast).toBe(true);
  });

  it("collapses outpaint backends into one top-level card", () => {
    const cards = buildToolCards({
      catalog: [qwen(), flux(), catalogTool()],
      packIds: null,
      editLoras: null,
    });
    const out = cards.filter((c) => c.title === "Outpaint");
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(OUTPAINT_CARD_KEY);
    expect(out[0].id).toBe("qwen21-outpaint");
    expect(out[0].available).toBe(true);
    expect(cards.filter((c) => c.kind === "catalog")).toHaveLength(2);
  });

  it("shows a model-not-installed state when no backend is available", () => {
    const cards = buildToolCards({
      catalog: [
        qwen({ available: false, installed: false }),
        flux({ available: false, installed: false }),
      ],
      packIds: null,
      editLoras: null,
    });
    const out = cards.find((c) => c.key === OUTPAINT_CARD_KEY)!;
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/No outpaint model installed/);
  });

  it("has no card when the server lists no outpaint tool", () => {
    const cards = buildToolCards({
      catalog: [catalogTool()],
      packIds: null,
      editLoras: null,
    });
    expect(cards.find((c) => c.key === OUTPAINT_CARD_KEY)).toBeUndefined();
  });

  it("zoom presets expand all sides by the right amount", () => {
    const s = { ...defaultSettings(), ...zoomPresetSettings(0.5) };
    expect(outpaintOption(s)).toEqual(sidesFor("all", 0.5));
    expect(OUTPAINT_ZOOM_PRESETS.map((z) => z.amount)).toEqual([0.25, 0.5]);
  });

  it("sends the optional prompt and fast flag for the resolved tool", () => {
    const t = resolveOutpaintTool([
      qwen({ promptMode: "optional", promptTemplate: "x {prompt}" }),
    ])!;
    const body = buildCatalogBody(
      t,
      { ...defaultSettings(t), text: " a beach " },
      ["img"],
      null,
      "c",
    );
    expect(body.prompt).toBe("a beach");
    expect(body.options.fast).toBe(true);
  });
});
