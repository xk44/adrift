import { describe, expect, it } from "vitest";
import {
  NO_MASK_ADJUST,
  adjustMaskPixels,
  featherGray,
  growGray,
  isMaskAdjusted,
  maskStepPx,
} from "@/lib/tools/maskOps";

const W = 40;
const H = 40;

/** Gray mask with a filled square [x0, x1) x [y0, y1). */
function square(x0: number, y0: number, x1: number, y1: number) {
  const g = new Uint8ClampedArray(W * H);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) g[y * W + x] = 255;
  return g;
}

function toRgba(gray: Uint8ClampedArray) {
  const out = new Uint8ClampedArray(gray.length * 4);
  gray.forEach((v, i) => {
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  });
  return out;
}

const count = (g: Uint8ClampedArray) => g.filter((v) => v > 127).length;
const at = (g: Uint8ClampedArray, x: number, y: number) => g[y * W + x];

describe("mask edge tools", () => {
  it("steps scale with the mask's shorter side", () => {
    expect(maskStepPx(10, 1024, 2048)).toBe(51);
    expect(maskStepPx(-2, 400, 300)).toBe(3);
    expect(maskStepPx(0, 4096, 4096)).toBe(0);
  });

  it("grow expands the filled area by the radius", () => {
    const g = square(15, 15, 25, 25);
    const grown = growGray(g, W, H, 3);
    expect(at(grown, 12, 20)).toBe(255);
    expect(at(grown, 11, 20)).toBe(0);
    expect(count(grown)).toBeGreaterThan(count(g));
    // Every original pixel stays filled.
    g.forEach((v, i) => v && expect(grown[i]).toBe(255));
  });

  it("shrink pulls the edge in and keeps the image border intact", () => {
    const g = square(15, 15, 25, 25);
    const shrunk = growGray(g, W, H, -2);
    expect(at(shrunk, 15, 20)).toBe(0);
    expect(at(shrunk, 17, 20)).toBe(255);
    // A mask touching the image edge does not shrink away from it.
    const edge = growGray(square(0, 0, 10, 40), W, H, -2);
    expect(at(edge, 0, 20)).toBe(255);
    expect(at(edge, 9, 20)).toBe(0);
  });

  it("feather makes a soft ramp but keeps the middle solid", () => {
    const g = square(10, 10, 30, 30);
    const soft = featherGray(g, W, H, 6);
    expect(at(soft, 20, 20)).toBe(255);
    expect(at(soft, 0, 0)).toBe(0);
    const edge = at(soft, 10, 20);
    expect(edge).toBeGreaterThan(30);
    expect(edge).toBeLessThan(225);
    // Monotonic ramp across the edge.
    expect(at(soft, 8, 20)).toBeLessThan(at(soft, 10, 20));
    expect(at(soft, 10, 20)).toBeLessThan(at(soft, 12, 20));
  });

  it("adjustMaskPixels: no settings = same array; invert swaps", () => {
    const rgba = toRgba(square(10, 10, 20, 20));
    expect(isMaskAdjusted(NO_MASK_ADJUST)).toBe(false);
    expect(adjustMaskPixels(rgba, W, H, NO_MASK_ADJUST)).toBe(rgba);
    const inv = adjustMaskPixels(rgba, W, H, {
      ...NO_MASK_ADJUST,
      invert: true,
    });
    expect(inv[(15 * W + 15) * 4]).toBe(0);
    expect(inv[0]).toBe(255);
    expect(inv[3]).toBe(255);
    expect(inv[1]).toBe(inv[0]);
  });

  it("adjustMaskPixels grows then softens (white = fill, alpha 255)", () => {
    const rgba = toRgba(square(15, 15, 25, 25));
    // 40 px short side: grow 5 steps = 1 px, feather 10 = 2 px.
    const out = adjustMaskPixels(rgba, W, H, {
      grow: 5,
      feather: 10,
      invert: false,
    });
    expect(out).not.toBe(rgba);
    expect(out[(20 * W + 20) * 4]).toBe(255);
    const edge = out[(20 * W + 14) * 4];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  it("clamps out-of-range settings and ignores mismatched sizes", () => {
    const rgba = toRgba(square(15, 15, 25, 25));
    const huge = adjustMaskPixels(rgba, W, H, {
      grow: 99,
      feather: 0,
      invert: false,
    });
    const max = adjustMaskPixels(rgba, W, H, {
      grow: 10,
      feather: 0,
      invert: false,
    });
    expect(Array.from(huge)).toEqual(Array.from(max));
    const bad = adjustMaskPixels(rgba, W + 1, H, {
      grow: 2,
      feather: 0,
      invert: false,
    });
    expect(bad).toBe(rgba);
  });
});

describe("MaskPainter edge tools (markup)", () => {
  it("offers grow/shrink, soft edge, invert and a mask file loader", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MaskPainter } = await import("@/components/tools/MaskPainter");
    const html = renderToStaticMarkup(
      React.createElement(MaskPainter, { imageUrl: "/x.png", onChange: () => {} }),
    );
    expect(html).toContain('data-testid="mask-edge-tools"');
    expect(html).toContain('aria-label="Grow or shrink the mask"');
    expect(html).toContain('min="-10"');
    expect(html).toContain('aria-label="Soften the mask edge"');
    expect(html).toContain("Invert");
    expect(html).toContain("Load mask");
    expect(html).toMatch(/type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);
  });
});
