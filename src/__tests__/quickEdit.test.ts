import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRUSH_DEFAULT,
  BRUSH_MAX,
  BRUSH_MIN,
  EXPAND_PRESETS,
  QUICK_EDIT_MODES,
  brushRadiusSource,
  clampBrush,
  displayToSource,
  expandPads,
  expandSettings,
  fitContain,
  maskFromAlpha,
  maskMaybePainted,
  planQuickEdit,
  pushMaskOp,
  quickEditMode,
  stepBrush,
  strokeRaster,
  undoMaskOp,
  type MaskOp,
  type QuickEditInput,
} from "@/lib/quickEdit";
import { planOutpaint } from "@/lib/tools/outpaint";
import type { CatalogTool, EditLoraListResponse } from "@/lib/tools/toolsPage";

function catalogTool(over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    id: "t1",
    label: "Tool One",
    category: "Edit",
    base: "krea2",
    baseLabel: "Krea 2",
    description: "d",
    loras: [],
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
const noLoras: EditLoraListResponse = { families: {}, loras: [] };

const input = (over: Partial<QuickEditInput>): QuickEditInput => ({
  mode: "inpaint",
  prompt: "a red hat",
  hasMask: true,
  expand: "zoom_1_5",
  upscale: "upscale_subtle",
  ...over,
});

const outpaintTool = (over: Partial<CatalogTool> = {}) =>
  catalogTool({
    id: "qwen21-outpaint",
    outpaint: { default: "all_25", fill: "blur", maxSide: 2048, presets: [] },
    promptMode: "optional",
    ...over,
  });

describe("geometry", () => {
  it("fitContain keeps aspect inside the container", () => {
    expect(
      fitContain({ width: 800, height: 600 }, { width: 2000, height: 1000 }),
    ).toEqual({ width: 800, height: 400 });
    expect(
      fitContain({ width: 800, height: 600 }, { width: 1000, height: 2000 }),
    ).toEqual({ width: 300, height: 600 });
    // Upscales small sources too (the stage fills its box).
    expect(
      fitContain({ width: 400, height: 400 }, { width: 100, height: 50 }),
    ).toEqual({ width: 400, height: 200 });
  });

  it("fitContain returns zero for unmeasured boxes", () => {
    expect(
      fitContain({ width: 0, height: 600 }, { width: 10, height: 10 }),
    ).toEqual({ width: 0, height: 0 });
    expect(
      fitContain({ width: 600, height: 600 }, { width: NaN, height: 10 }),
    ).toEqual({ width: 0, height: 0 });
  });

  it("displayToSource scales and clamps to the image", () => {
    const display = { width: 500, height: 250 };
    const source = { width: 2000, height: 1000 };
    expect(displayToSource({ x: 125, y: 50 }, display, source)).toEqual({
      x: 500,
      y: 200,
    });
    expect(displayToSource({ x: -10, y: 900 }, display, source)).toEqual({
      x: 0,
      y: 1000,
    });
  });

  it("brushRadiusSource converts a display diameter to a source radius", () => {
    // 4x downscaled display: 40 px brush = 80 px source radius.
    expect(
      brushRadiusSource(
        40,
        { width: 500, height: 250 },
        { width: 2000, height: 1000 },
      ),
    ).toBe(80);
    // Upscaled display shrinks it; never below half a pixel.
    expect(
      brushRadiusSource(
        4,
        { width: 1000, height: 1000 },
        { width: 100, height: 100 },
      ),
    ).toBe(0.5);
  });
});

describe("brush size", () => {
  it("clamps and rounds", () => {
    expect(clampBrush(1)).toBe(BRUSH_MIN);
    expect(clampBrush(9999)).toBe(BRUSH_MAX);
    expect(clampBrush(12.6)).toBe(13);
    expect(clampBrush(NaN)).toBe(BRUSH_DEFAULT);
  });

  it("[ and ] step multiplicatively, at least 1 px, within bounds", () => {
    expect(stepBrush(40, 1)).toBe(50);
    expect(stepBrush(40, -1)).toBe(32);
    expect(stepBrush(BRUSH_MIN, 1)).toBeGreaterThan(BRUSH_MIN);
    expect(stepBrush(BRUSH_MIN, -1)).toBe(BRUSH_MIN);
    expect(stepBrush(BRUSH_MAX, 1)).toBe(BRUSH_MAX);
    // Round trip stays close.
    expect(Math.abs(stepBrush(stepBrush(60, 1), -1) - 60)).toBeLessThanOrEqual(
      1,
    );
  });
});

describe("mask history", () => {
  const paint: MaskOp = {
    kind: "stroke",
    erase: false,
    radius: 10,
    points: [{ x: 1, y: 1 }],
  };
  const erase: MaskOp = { ...paint, erase: true };

  it("push ignores empty strokes; undo pops one op", () => {
    let ops = pushMaskOp([], paint);
    ops = pushMaskOp(ops, { ...paint, points: [] });
    expect(ops).toHaveLength(1);
    ops = pushMaskOp(ops, { kind: "invert" });
    expect(undoMaskOp(ops)).toEqual([paint]);
    expect(undoMaskOp([])).toEqual([]);
  });

  it("maskMaybePainted needs paint or invert", () => {
    expect(maskMaybePainted([])).toBe(false);
    expect(maskMaybePainted([erase])).toBe(false);
    expect(maskMaybePainted([paint])).toBe(true);
    expect(maskMaybePainted([{ kind: "invert" }])).toBe(true);
  });

  it("strokeRaster: paint adds, eraser cuts, width = diameter", () => {
    expect(strokeRaster(paint as Extract<MaskOp, { kind: "stroke" }>)).toEqual({
      composite: "source-over",
      lineWidth: 20,
      lineCap: "round",
      lineJoin: "round",
    });
    expect(
      strokeRaster(erase as Extract<MaskOp, { kind: "stroke" }>).composite,
    ).toBe("destination-out");
  });

  it("maskFromAlpha exports white-on-black at the same size", () => {
    const rgba = new Uint8ClampedArray([
      255,
      0,
      0,
      255, // painted
      0,
      0,
      0,
      0, // empty
      255,
      0,
      0,
      5, // faint antialias edge -> keep
      10,
      20,
      30,
      200, // painted
    ]);
    const { pixels, painted } = maskFromAlpha(rgba);
    expect(painted).toBe(2);
    expect(Array.from(pixels)).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });
});

describe("expand presets", () => {
  it("zoom presets pad each side by the fraction", () => {
    expect(expandPads("zoom_1_5", 1000, 800)).toEqual({
      left: 250,
      right: 250,
      top: 200,
      bottom: 200,
      width: 1500,
      height: 1200,
    });
    expect(expandPads("zoom_2", 1024, 1024)).toMatchObject({
      width: 2048,
      height: 2048,
    });
  });

  it("aspect presets pad the short axis, centered", () => {
    // 1001 tall -> 1780 wide: 779 extra, odd px goes right.
    expect(expandPads("to_16_9", 1001, 1001)).toEqual({
      left: 389,
      right: 390,
      top: 0,
      bottom: 0,
      width: 1780,
      height: 1001,
    });
    expect(expandPads("to_9_16", 900, 900)).toMatchObject({
      left: 0,
      right: 0,
      top: 350,
      bottom: 350,
      height: 1600,
    });
  });

  it("aspect preset that adds nothing is null", () => {
    expect(expandPads("to_16_9", 1600, 900)).toBeNull();
    expect(expandPads("zoom_2", 0, 100)).toBeNull();
  });

  it.each([
    [1000, 800],
    [1024, 1536],
    [1920, 1080],
    [777, 333],
  ])("matches the server planner for %ix%i", (w, h) => {
    const limits = { multiple: 1, maxCanvasPixels: 1e12 };
    for (const p of EXPAND_PRESETS) {
      const mine = expandPads(p.id, w, h);
      const spec =
        p.kind === "zoom"
          ? ({
              kind: "sides",
              sides: {
                left: p.perSide,
                right: p.perSide,
                top: p.perSide,
                bottom: p.perSide,
              },
            } as const)
          : ({ kind: "aspect", aspect: p.ratio, anchor: "center" } as const);
      if (!mine) {
        expect(() => planOutpaint(w, h, spec, limits)).toThrow();
        continue;
      }
      const plan = planOutpaint(w, h, spec, limits);
      expect(mine).toEqual({
        left: plan.left,
        right: plan.right,
        top: plan.top,
        bottom: plan.bottom,
        width: plan.width,
        height: plan.height,
      });
    }
  });

  it("maps presets onto the outpaint tool settings", () => {
    expect(expandSettings("zoom_1_5")).toEqual({
      outpaintMode: "sides",
      outpaintDirection: "all",
      outpaintAmount: 0.25,
    });
    expect(expandSettings("zoom_2").outpaintAmount).toBe(0.5);
    expect(expandSettings("to_9_16")).toEqual({
      outpaintMode: "aspect",
      outpaintAspect: "9:16",
      outpaintAnchor: "center",
    });
  });
});

describe("planQuickEdit", () => {
  const inpaintTool = catalogTool({
    id: "krea2-inpaint",
    needsMask: true,
    promptMode: "required",
    speed: {
      supported: true,
      default: false,
      available: true,
      steps: 8,
      cfg: 1,
    },
  });

  it("mode table: paint modes need a mask, Expand/Upscale do not", () => {
    expect(QUICK_EDIT_MODES.map((m) => m.id)).toEqual([
      "inpaint",
      "erase",
      "expand",
      "upscale",
    ]);
    expect(quickEditMode("erase").prompt).toBe("none");
    expect(quickEditMode("expand").needsMask).toBe(false);
  });

  it("inpaint requires mask and prompt", () => {
    const ctx = { catalog: [inpaintTool], editLoras: loras };
    expect(planQuickEdit(input({ hasMask: false }), ctx)).toHaveProperty(
      "error",
    );
    expect(planQuickEdit(input({ prompt: "  " }), ctx)).toHaveProperty("error");
  });

  it("inpaint prefers the catalog inpaint tool, fast when available", () => {
    const plan = planQuickEdit(input({}), {
      catalog: [
        catalogTool({ id: "krea2-anypaint", needsMask: true }),
        inpaintTool,
      ],
      editLoras: loras,
    });
    expect(plan).toMatchObject({
      kind: "catalog",
      tool: { id: "krea2-inpaint" },
      settings: { text: "a red hat", fast: true },
    });
  });

  it("inpaint on AnyPaint keeps the canvas size", () => {
    const anypaint = catalogTool({
      id: "krea2-anypaint",
      needsMask: true,
      options: [
        {
          id: "expand",
          label: "Expand",
          type: "enum",
          default: "none",
          values: [],
        },
      ],
    });
    const plan = planQuickEdit(input({}), {
      catalog: [anypaint],
      editLoras: null,
    });
    expect(plan).toMatchObject({
      kind: "catalog",
      settings: { picks: { expand: "none" } },
    });
  });

  it("inpaint falls back to the editor inpaint route", () => {
    expect(
      planQuickEdit(input({ prompt: " sky " }), {
        catalog: [{ ...inpaintTool, available: false }],
        editLoras: null,
      }),
    ).toEqual({ kind: "inpaint", prompt: "sky" });
  });

  it("erase uses the remove_object region path when an edit LoRA exists", () => {
    const plan = planQuickEdit(input({ mode: "erase", prompt: "" }), {
      catalog: [],
      editLoras: loras,
    });
    expect(plan).toMatchObject({
      kind: "action",
      spec: { id: "remove_object" },
      region: true,
      settings: { text: "" },
    });
  });

  it("erase falls back to the catalog box-remove tool, then errors", () => {
    const box = catalogTool({ id: "qwen21-remove-box", needsMask: true });
    expect(
      planQuickEdit(input({ mode: "erase" }), {
        catalog: [box],
        editLoras: noLoras,
      }),
    ).toMatchObject({ kind: "catalog", tool: { id: "qwen21-remove-box" } });
    expect(
      planQuickEdit(input({ mode: "erase" }), {
        catalog: null,
        editLoras: null,
      }),
    ).toEqual({ error: expect.stringMatching(/loading/) });
    expect(
      planQuickEdit(input({ mode: "erase" }), {
        catalog: [],
        editLoras: noLoras,
      }),
    ).toEqual({ error: expect.stringMatching(/No object-remove/) });
    expect(
      planQuickEdit(input({ mode: "erase", hasMask: false }), {
        catalog: [box],
        editLoras: loras,
      }),
    ).toHaveProperty("error");
  });

  it("expand runs the outpaint tool with the preset, no mask needed", () => {
    const plan = planQuickEdit(
      input({
        mode: "expand",
        hasMask: false,
        expand: "to_16_9",
        prompt: "beach",
      }),
      { catalog: [outpaintTool()], editLoras: null },
    );
    expect(plan).toMatchObject({
      kind: "catalog",
      tool: { id: "qwen21-outpaint" },
      settings: {
        outpaintMode: "aspect",
        outpaintAspect: "16:9",
        text: "beach",
      },
    });
    const noPrompt = planQuickEdit(input({ mode: "expand", prompt: "beach" }), {
      catalog: [outpaintTool({ promptMode: "none" })],
      editLoras: null,
    });
    expect(noPrompt).toMatchObject({ settings: { text: "" } });
  });

  it("expand errors while loading or when no outpaint tool is usable", () => {
    const e = input({ mode: "expand" });
    expect(planQuickEdit(e, { catalog: null, editLoras: null })).toHaveProperty(
      "error",
    );
    expect(planQuickEdit(e, { catalog: [], editLoras: null })).toHaveProperty(
      "error",
    );
    expect(
      planQuickEdit(e, {
        catalog: [outpaintTool({ available: false, installed: false })],
        editLoras: null,
      }),
    ).toHaveProperty("error");
  });

  it("upscale runs the upscale action with the chosen style", () => {
    const plan = planQuickEdit(
      input({ mode: "upscale", hasMask: false, upscale: "upscale_creative" }),
      { catalog: null, editLoras: null },
    );
    expect(plan).toMatchObject({
      kind: "action",
      spec: { id: "upscale" },
      region: false,
      settings: { picks: { mode: "upscale_creative" } },
    });
  });
});

describe("Lightbox wiring", () => {
  const src = readFileSync(
    join(__dirname, "..", "components", "Lightbox.tsx"),
    "utf8",
  );
  const overlay = readFileSync(
    join(__dirname, "..", "components", "QuickEditOverlay.tsx"),
    "utf8",
  );

  it("Edit group has Quick edit (E) before Open editor", () => {
    const catalog = readFileSync(
      join(__dirname, "..", "lib", "ui", "creatorActions.ts"),
      "utf8",
    );
    const quick = catalog.indexOf('id: "quick_edit"');
    expect(quick).toBeGreaterThan(-1);
    const editor = catalog.indexOf('id: "open_editor"', quick);
    expect(editor).toBeGreaterThan(quick);
    expect(catalog.slice(quick, editor)).toContain('kbd: "E"');
    expect(catalog.slice(quick, editor)).toContain('group: "edit"');
    expect(src).toMatch(/case "quick_edit":\s*openQuickEdit\(\);/);
  });

  it("E opens it; Escape closes it before the lightbox", () => {
    expect(src).toMatch(/case "quick-edit":\s*openQuickEdit\(\);/);
    expect(src).toMatch(
      /if \(quickEditOpen\) \{\s*if \(e\.key === "Escape"\) \{\s*e\.stopPropagation\(\);\s*setQuickEditOpen\(false\);/,
    );
  });

  it("overlay is not a separate aria-modal and blocks swipe gestures", () => {
    expect(overlay).not.toMatch(/aria-modal/);
    expect(overlay).toMatch(/data-quick-edit/);
    expect(src).toMatch(/\[data-quick-edit\]/);
  });

  it("overlay submits through the shared tool paths", () => {
    expect(overlay).toMatch(/submitCatalogTool\(/);
    expect(overlay).toMatch(/submitActionTool\(/);
    expect(overlay).toMatch(/useInpaint\(/);
    expect(overlay).not.toMatch(/fetch\("\/api\/jobs/);
  });
});
