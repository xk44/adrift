/**
 * Edit-tab mask operations (Reset / invert / select-all keys / Smart Select
 * merge) on raw paint-layer RGBA.
 */
import { describe, it, expect } from "vitest";
import {
  EDITOR_MASK_RGB,
  fillMaskPixels,
  invertMaskPixels,
  mergeSmartMaskPixels,
} from "@/lib/editorMask";

const px = (...alphas: number[]) => {
  const a = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((v, i) => (a[i * 4 + 3] = v));
  return a;
};
const alphas = (a: Uint8ClampedArray) =>
  Array.from({ length: a.length / 4 }, (_, i) => a[i * 4 + 3]);

describe("editor mask ops", () => {
  it("fill selects every pixel in the stroke color", () => {
    const out = fillMaskPixels(px(0, 10, 255));
    expect(alphas(out)).toEqual([255, 255, 255]);
    expect(Array.from(out.slice(0, 3))).toEqual([...EDITOR_MASK_RGB]);
  });

  it("invert flips painted and empty pixels (any alpha counts as painted)", () => {
    expect(alphas(invertMaskPixels(px(0, 1, 255)))).toEqual([255, 0, 0]);
    // twice = back to a binary version of the original selection
    expect(alphas(invertMaskPixels(invertMaskPixels(px(0, 1))))).toEqual([0, 255]);
  });

  it("smart merge unions the pre-session mask with bright SAM pixels", () => {
    const sam = new Uint8ClampedArray(12);
    sam.set([255, 255, 255, 255], 0); // subject
    sam.set([0, 0, 0, 255], 4); // background
    sam.set([0, 0, 0, 255], 8);
    const base = px(0, 0, 200); // third pixel was painted before
    expect(alphas(mergeSmartMaskPixels(base, sam))).toEqual([255, 0, 255]);
    expect(alphas(mergeSmartMaskPixels(null, sam))).toEqual([255, 0, 0]);
  });

  it("smart merge rejects mismatched sizes", () => {
    expect(() =>
      mergeSmartMaskPixels(px(0), new Uint8ClampedArray(8)),
    ).toThrow(/size/);
  });
});
