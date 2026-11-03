import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CROP_ASPECTS,
  clampCropRect,
  cropAspectRatio,
  cropOutputSize,
  cropPixelRect,
  fitAspectRect,
  fullCropRect,
  isFullCrop,
  moveCropRect,
  resizeCropRect,
  screenDeltaToSource,
  screenToSource,
  MIN_CROP,
} from "@/lib/editorCrop";
import { editorCropKey, editorKeyAction } from "@/components/editor/editorKeys";
import {
  EditorCropBar,
  EditorCropOverlay,
} from "@/components/editor/EditorCropOverlay";
import { useEditorStore } from "@/store/editorStore";

const img = { width: 1000, height: 800 };
const ratioOf = (r: { w: number; h: number }) => r.w / r.h;

describe("crop aspects", () => {
  it("has the documented presets", () => {
    expect(CROP_ASPECTS.map((a) => a.id)).toEqual([
      "free",
      "original",
      "1:1",
      "4:5",
      "3:4",
      "2:3",
      "9:16",
      "16:9",
      "3:2",
    ]);
  });

  it("resolves ratios, Original from the image", () => {
    expect(cropAspectRatio("free", img)).toBeNull();
    expect(cropAspectRatio("original", img)).toBe(1.25);
    expect(cropAspectRatio("4:5", img)).toBe(0.8);
    expect(cropAspectRatio("16:9", img)).toBeCloseTo(16 / 9);
  });

  it("fits the largest centered rect of a ratio", () => {
    expect(fitAspectRect(img, 1)).toEqual({ x: 100, y: 0, w: 800, h: 800 });
    const wide = fitAspectRect(img, 16 / 9);
    expect(wide.w).toBe(1000);
    expect(wide.h).toBeCloseTo(562.5);
    expect(wide.y).toBeCloseTo(118.75);
    expect(fitAspectRect(img, null)).toEqual(fullCropRect(img));
  });
});

describe("clamp / move", () => {
  it("shrinks oversized rects and shifts them inside", () => {
    expect(clampCropRect({ x: -50, y: 700, w: 2000, h: 300 }, img)).toEqual({
      x: 0,
      y: 500,
      w: 1000,
      h: 300,
    });
    expect(clampCropRect({ x: 10, y: 10, w: 1, h: 1 }, img)).toMatchObject({
      w: MIN_CROP,
      h: MIN_CROP,
    });
  });

  it("moves without leaving the image", () => {
    const r = { x: 100, y: 100, w: 200, h: 200 };
    expect(moveCropRect(r, 50, -20, img)).toEqual({
      x: 150,
      y: 80,
      w: 200,
      h: 200,
    });
    expect(moveCropRect(r, 5000, 5000, img)).toEqual({
      x: 800,
      y: 600,
      w: 200,
      h: 200,
    });
    expect(moveCropRect(r, -5000, 0, img).x).toBe(0);
  });
});

describe("resizeCropRect", () => {
  const start = { x: 100, y: 100, w: 400, h: 300 };

  it("free: moves only the dragged sides and clamps to the image", () => {
    expect(resizeCropRect(start, "e", 50, 99, img, null)).toEqual({
      x: 100,
      y: 100,
      w: 450,
      h: 300,
    });
    expect(resizeCropRect(start, "nw", -40, -30, img, null)).toEqual({
      x: 60,
      y: 70,
      w: 440,
      h: 330,
    });
    expect(resizeCropRect(start, "se", 9999, 9999, img, null)).toEqual({
      x: 100,
      y: 100,
      w: 900,
      h: 700,
    });
    expect(resizeCropRect(start, "w", 9999, 0, img, null)).toEqual({
      x: 500 - MIN_CROP,
      y: 100,
      w: MIN_CROP,
      h: 300,
    });
  });

  it("corner with ratio keeps the opposite corner and the ratio", () => {
    const r = resizeCropRect(start, "se", 100, 0, img, 1);
    expect(ratioOf(r)).toBeCloseTo(1);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    expect(r.w).toBe(500);
    const nw = resizeCropRect(start, "nw", -50, -50, img, 1);
    expect(nw.x + nw.w).toBe(500);
    expect(nw.y + nw.h).toBe(400);
    expect(ratioOf(nw)).toBeCloseTo(1);
  });

  it("corner with ratio stops at the image edge", () => {
    const r = resizeCropRect(start, "se", 5000, 5000, img, 16 / 9);
    expect(ratioOf(r)).toBeCloseTo(16 / 9);
    expect(r.x + r.w).toBeLessThanOrEqual(1000 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(800 + 1e-9);
  });

  it("edge with ratio keeps the center and stays inside", () => {
    const r = resizeCropRect(start, "e", 200, 0, img, 4 / 3);
    expect(r.x).toBe(100);
    expect(r.w).toBe(600);
    expect(r.h).toBeCloseTo(450);
    expect(r.y + r.h / 2).toBeCloseTo(250);
    const tall = resizeCropRect(
      { x: 0, y: 0, w: 100, h: 100 },
      "s",
      0,
      5000,
      img,
      1,
    );
    expect(tall).toEqual({ x: 0, y: 0, w: 800, h: 800 });
  });

  it("never collapses below the minimum", () => {
    const r = resizeCropRect(start, "nw", 5000, 5000, img, 2 / 3);
    expect(r.w).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
    expect(r.h).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
    expect(ratioOf(r)).toBeCloseTo(2 / 3);
  });
});

describe("screen → source mapping", () => {
  it("scales by the displayed size", () => {
    expect(
      screenDeltaToSource(10, 20, { width: 500, height: 400 }, img),
    ).toEqual({ dx: 20, dy: 40 });
    expect(screenDeltaToSource(10, 20, { width: 0, height: 0 }, img)).toEqual({
      dx: 0,
      dy: 0,
    });
    expect(
      screenToSource(
        { x: 150, y: 70 },
        { left: 100, top: 20, width: 250, height: 200 },
        img,
      ),
    ).toEqual({ x: 200, y: 200 });
  });
});

describe("output size", () => {
  it("rounds once and stays inside the image", () => {
    const r = { x: 10.4, y: 0.6, w: 1023.7, h: 1280.2 };
    const big = { width: 2048, height: 2048 };
    expect(cropOutputSize(r, big)).toEqual({ width: 1024, height: 1280 });
    expect(cropPixelRect({ x: 999.6, y: 0, w: 50, h: 50 }, img)).toEqual({
      x: 999,
      y: 0,
      w: 1,
      h: 50,
    });
  });

  it("detects the untouched full frame", () => {
    expect(isFullCrop(fullCropRect(img), img)).toBe(true);
    expect(isFullCrop({ x: 0, y: 0, w: 999, h: 800 }, img)).toBe(false);
  });
});

describe("crop keys", () => {
  it("C picks the tool; Enter/Esc apply/cancel only without modifiers", () => {
    expect(editorKeyAction({ key: "c" })).toEqual({
      kind: "tool",
      tool: "crop",
    });
    expect(editorCropKey({ key: "Enter" })).toBe("apply");
    expect(editorCropKey({ key: "Escape" })).toBe("cancel");
    expect(editorCropKey({ key: "Enter", metaKey: true })).toBeNull();
    expect(editorCropKey({ key: "c" })).toBeNull();
  });
});

describe("crop UI markup", () => {
  it("shows the live output size and labelled controls", () => {
    const html = renderToStaticMarkup(
      createElement(EditorCropBar, {
        img: { width: 2048, height: 2048 },
        rect: { x: 0, y: 0, w: 1024, h: 1280 },
        aspect: "4:5",
        onAspect: () => {},
        onApply: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("1024 × 1280 px");
    expect(html).toContain('aria-label="Aspect ratio"');
    expect(html).toContain('aria-label="Apply crop (Enter)"');
    expect(html).toContain('aria-label="Cancel crop (Esc)"');
  });

  it("disables Apply on the untouched frame", () => {
    const html = renderToStaticMarkup(
      createElement(EditorCropBar, {
        img,
        rect: fullCropRect(img),
        aspect: "free",
        onAspect: () => {},
        onApply: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Apply crop/);
  });

  it("labels every handle and the move area", () => {
    const html = renderToStaticMarkup(
      createElement(EditorCropOverlay, {
        img,
        display: { width: 500, height: 400 },
        rect: { x: 100, y: 100, w: 400, h: 300 },
        ratio: null,
        onChange: () => {},
      }),
    );
    expect(html.match(/aria-label="Resize crop from the [^"]+"/g)?.length).toBe(
      8,
    );
    expect(html).toContain("Crop area");
    // Frame drawn at display scale (0.5).
    expect(html).toMatch(/left:50px;top:50px;width:200px;height:150px/);
  });
});

describe("editorStore.applyCrop", () => {
  beforeEach(() => useEditorStore.getState().resetEditor());

  it("makes the crop the canvas and undo brings the original back", () => {
    useEditorStore.getState().openEditor("http://example.com/orig.png", "g1");
    useEditorStore.getState().applyCrop("blob:crop", "data:mask");
    let s = useEditorStore.getState();
    expect(s.sourceImage).toBe("blob:crop");
    expect(s.sourceImageId).toBeNull();
    expect(s.sourceRun).toBeNull();
    expect(s.history[s.historyIndex].maskData).toBe("data:mask");
    expect(s.layers.at(-1)?.name).toBe("Crop");

    s.undo();
    s = useEditorStore.getState();
    expect(s.sourceImage).toBe("http://example.com/orig.png");
    expect(s.sourceImageId).toBe("g1");
    s.redo();
    expect(useEditorStore.getState().sourceImage).toBe("blob:crop");
  });

  it("a null mask saves no mask data", () => {
    useEditorStore.getState().openEditor("http://example.com/orig.png");
    useEditorStore.getState().applyCrop("blob:crop", null);
    const s = useEditorStore.getState();
    expect(s.history[s.historyIndex].maskData).toBeUndefined();
  });
});
