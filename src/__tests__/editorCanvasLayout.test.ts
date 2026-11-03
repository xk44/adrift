/**
 * Edit-tab layout math: the canvas must keep a usable size on a 390px phone
 * (fixed 80px padding + side panels used to leave it 0px wide), never upscale
 * past natural size, and the side panels collapse into one sheet below md.
 */
import { describe, it, expect } from "vitest";
import {
  canvasPadding,
  fitCanvasDisplay,
  nextBrushSize,
} from "@/components/editor/editorCanvasLayout";
import { editorPanelClass } from "@/components/editor/editorLayout";

describe("canvasPadding", () => {
  it("is min(80px, 4% of width) with a 16px floor", () => {
    expect(canvasPadding(390)).toBe(16);
    expect(canvasPadding(1000)).toBe(40);
    expect(canvasPadding(4000)).toBe(80);
    expect(canvasPadding(0)).toBe(16);
  });
});

describe("fitCanvasDisplay", () => {
  it("leaves a real canvas on a 390px phone", () => {
    const d = fitCanvasDisplay({ width: 390, height: 420 }, { width: 1024, height: 1024 });
    expect(d.width).toBeGreaterThan(300);
    expect(d.width).toBeCloseTo(d.height);
    expect(d.width).toBeLessThanOrEqual(390 - 32);
  });

  it("keeps aspect ratio and fits the tighter side", () => {
    const d = fitCanvasDisplay({ width: 1200, height: 600 }, { width: 2000, height: 1000 });
    expect(d.width / d.height).toBeCloseTo(2);
    expect(d.width).toBeLessThanOrEqual(1200 - 96);
    expect(d.height).toBeLessThanOrEqual(600 - 96);
  });

  it("does not upscale small images", () => {
    const d = fitCanvasDisplay({ width: 1600, height: 1200 }, { width: 200, height: 100 });
    expect(d).toEqual({ width: 200, height: 100, scale: 1 });
  });

  it("is 0x0 before the stage or image is measured", () => {
    expect(fitCanvasDisplay({ width: 0, height: 0 }, { width: 10, height: 10 }).width).toBe(0);
    expect(fitCanvasDisplay({ width: 500, height: 500 }, null).width).toBe(0);
  });
});

describe("nextBrushSize", () => {
  it("steps ~15% and clamps to 1..500", () => {
    expect(nextBrushSize(100, 1)).toBe(115);
    expect(nextBrushSize(100, -1)).toBe(85);
    expect(nextBrushSize(1, -1)).toBe(1);
    expect(nextBrushSize(2, 1)).toBe(3);
    expect(nextBrushSize(495, 1)).toBe(500);
  });
});

describe("editorPanelClass", () => {
  it("shows only the selected panel on phones, both on desktop", () => {
    const tools = editorPanelClass("tools", true, "tools");
    const exp = editorPanelClass("export", true, "tools");
    expect(tools.split(" ")).toContain("flex");
    expect(exp.split(" ")).toContain("hidden");
    for (const c of [tools, exp]) {
      expect(c).toContain("md:flex");
      expect(c).toMatch(/max-h-\[42vh\]/);
    }
  });

  it("hides the toolbar on phones before an image is loaded", () => {
    expect(editorPanelClass("tools", false, "tools")).toBe("hidden md:flex");
  });
});
