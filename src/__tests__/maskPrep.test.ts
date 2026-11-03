import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MAX_REDBOXES,
  REDBOX_COLOR,
  SCRIBBLE_COLOR,
  applyRedBox,
  applyScribble,
  findMaskBoxes,
  paintRedBoxes,
  paintScribble,
  redBoxBars,
  redBoxStroke,
} from "@/lib/tools/maskPrep";
import { OutpaintError } from "@/lib/tools/outpaint";

function mk(w: number, h: number, rects: Array<[number, number, number, number]>) {
  const m = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 255;
  return m;
}
const px = (rgb: Uint8Array, w: number, x: number, y: number) => [...rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
const white = (w: number, h: number) => new Uint8Array(w * h * 3).fill(255);

describe("redBoxStroke", () => {
  it("is max(3, 0.6% of short side)", () => {
    expect(redBoxStroke(100, 100)).toBe(3);
    expect(redBoxStroke(2000, 1000)).toBe(6);
    expect(redBoxStroke(5000, 3000)).toBe(18);
  });
});

describe("findMaskBoxes", () => {
  it("empty mask gives no boxes", () => {
    expect(findMaskBoxes(new Uint8Array(100), 10, 10)).toEqual([]);
  });
  it("single component bbox", () => {
    expect(findMaskBoxes(mk(20, 20, [[3, 4, 9, 12]]), 20, 20)).toEqual([{ x0: 3, y0: 4, x1: 9, y1: 12 }]);
  });
  it("separate components, largest first", () => {
    const b = findMaskBoxes(mk(40, 40, [[0, 0, 3, 3], [20, 20, 35, 35]]), 40, 40);
    expect(b).toEqual([
      { x0: 20, y0: 20, x1: 35, y1: 35 },
      { x0: 0, y0: 0, x1: 3, y1: 3 },
    ]);
  });
  it("8-connected diagonal pixels join", () => {
    const m = mk(10, 10, [[1, 1, 3, 3], [4, 4, 6, 6]]);
    expect(findMaskBoxes(m, 10, 10)).toEqual([{ x0: 1, y0: 1, x1: 6, y1: 6 }]);
  });
  it("drops speckle when real components exist, keeps it when alone", () => {
    expect(findMaskBoxes(mk(20, 20, [[10, 10, 15, 15], [0, 0, 0, 0]]), 20, 20)).toHaveLength(1);
    expect(findMaskBoxes(mk(20, 20, [[0, 0, 0, 0]]), 20, 20)).toHaveLength(1);
  });
  it("caps at MAX_REDBOXES", () => {
    const rects: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rects.push([i * 4, 0, i * 4 + 2, 2]);
    expect(findMaskBoxes(mk(100, 5, rects), 100, 5)).toHaveLength(MAX_REDBOXES);
  });
});

describe("redBoxBars", () => {
  it("outline sits just outside the box", () => {
    const bars = redBoxBars({ x0: 20, y0: 20, x1: 39, y1: 39 }, 100, 100, 3);
    expect(bars[0]).toEqual({ x: 17, y: 17, w: 26, h: 3 });
    expect(bars[1]).toEqual({ x: 17, y: 40, w: 26, h: 3 });
    expect(bars[2]).toEqual({ x: 17, y: 17, w: 3, h: 26 });
    expect(bars[3]).toEqual({ x: 40, y: 17, w: 3, h: 26 });
  });
  it("clamps to the image at edges", () => {
    const bars = redBoxBars({ x0: 0, y0: 0, x1: 99, y1: 99 }, 100, 100, 3);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(100);
      expect(b.y + b.h).toBeLessThanOrEqual(100);
    }
  });
});

describe("paintRedBoxes / paintScribble", () => {
  it("paints an outline, leaves the interior and far pixels alone", () => {
    const rgb = white(100, 100);
    const boxes = paintRedBoxes(rgb, mk(100, 100, [[20, 20, 39, 39]]), 100, 100);
    expect(boxes).toHaveLength(1);
    const red = [REDBOX_COLOR.r, REDBOX_COLOR.g, REDBOX_COLOR.b];
    expect(px(rgb, 100, 30, 18)).toEqual(red);
    expect(px(rgb, 100, 18, 30)).toEqual(red);
    expect(px(rgb, 100, 30, 41)).toEqual(red);
    expect(px(rgb, 100, 30, 30)).toEqual([255, 255, 255]);
    expect(px(rgb, 100, 90, 90)).toEqual([255, 255, 255]);
  });
  it("scribble paints exactly the mask pixels magenta", () => {
    const rgb = white(10, 10);
    const n = paintScribble(rgb, mk(10, 10, [[2, 2, 4, 3]]), 10, 10);
    expect(n).toBe(6);
    expect(px(rgb, 10, 3, 2)).toEqual([SCRIBBLE_COLOR.r, SCRIBBLE_COLOR.g, SCRIBBLE_COLOR.b]);
    expect(px(rgb, 10, 5, 5)).toEqual([255, 255, 255]);
  });
  it("empty masks throw OutpaintError", () => {
    expect(() => paintRedBoxes(white(4, 4), new Uint8Array(16), 4, 4)).toThrow(OutpaintError);
    expect(() => paintScribble(white(4, 4), new Uint8Array(16), 4, 4)).toThrow(OutpaintError);
  });
});

describe("applyRedBox / applyScribble (sharp)", () => {
  const img = () =>
    sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  // mask at a different size than the image: resized to fit
  const maskPng = () => {
    const m = Buffer.alloc(40 * 30, 0);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) m[y * 40 + x] = 255;
    return sharp(m, { raw: { width: 40, height: 30, channels: 1 } }).png().toBuffer();
  };
  it("redbox keeps size and draws the outline", async () => {
    const r = await applyRedBox(await img(), await maskPng());
    expect([r.width, r.height]).toEqual([80, 60]);
    expect(r.boxes).toHaveLength(1);
    const { data } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (20 * 80 + 40) * 3; // inside box at 2x: x 20..59, y 20..39
    expect([data[o], data[o + 1], data[o + 2]]).toEqual([10, 20, 30]);
    const t = (18 * 80 + 40) * 3; // just above the top edge
    expect([data[t], data[t + 1], data[t + 2]]).toEqual([239, 68, 68]);
  });
  it("scribble paints magenta under the mask", async () => {
    const r = await applyScribble(await img(), await maskPng());
    const { data } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (30 * 80 + 40) * 3;
    expect([data[o], data[o + 1], data[o + 2]]).toEqual([255, 0, 255]);
    expect([data[0], data[1], data[2]]).toEqual([10, 20, 30]);
  });
  it("empty mask rejects", async () => {
    const blank = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(applyRedBox(await img(), blank)).rejects.toBeInstanceOf(OutpaintError);
    await expect(applyScribble(await img(), blank)).rejects.toBeInstanceOf(OutpaintError);
  });
});
