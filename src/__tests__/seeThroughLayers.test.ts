import { describe, expect, it } from "vitest";
import {
  ALPHA_THRESHOLD,
  canvasSize,
  layerRunResolution,
  depthFromRgba,
  depthPreview,
  isSafePngName,
  layerImageUrl,
  LayerManifestError,
  manifestBasename,
  manifestPathFromTexts,
  painterComposite,
  parseLayerManifest,
  partStems,
  zComposite,
  type CompositePart,
} from "@/lib/layers/seeThrough";
import { validateOutputRef } from "@/lib/mesh/usdz";

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  filename: `adrift_layers_1_ab_${name}.png`,
  left: 0,
  top: 0,
  right: 10,
  bottom: 10,
  depth_median: 0.5,
  depth_filename: `adrift_layers_1_ab_${name}_depth.png`,
  ...extra,
});

describe("manifest path from job texts", () => {
  it("finds a posix or windows path and takes the basename", () => {
    const posix = "/srv/ComfyUI/output/adrift_layers_20261031_ab12_layers.json";
    expect(manifestPathFromTexts(["hello", posix])).toBe(posix);
    expect(manifestBasename(posix)).toBe(
      "adrift_layers_20261031_ab12_layers.json",
    );
    const win = "C:\\ComfyUI\\output\\adrift_layers_1_x_layers.json";
    expect(manifestPathFromTexts([win])).toBe(win);
    expect(manifestBasename(win)).toBe("adrift_layers_1_x_layers.json");
  });

  it("ignores other texts and unsafe names", () => {
    expect(manifestPathFromTexts(["Estimated FOV: 63°"])).toBeNull();
    expect(manifestPathFromTexts(undefined)).toBeNull();
    expect(manifestPathFromTexts(["/out/evil;rm_layers.json"])).toBeNull();
    expect(manifestBasename("/out/layers.json.png")).toBeNull();
  });
});

describe("parseLayerManifest", () => {
  it("keeps names with spaces and orders back to front", () => {
    const m = parseLayerManifest({
      prefix: "adrift_layers",
      timestamp: "20261031",
      layers: [
        entry("face", { depth_median: 0.2 }),
        entry("back hair", { depth_median: 0.9 }),
        entry("topwear", { depth_median: 0.5 }),
      ],
    });
    expect(m.layers.map((l) => l.name)).toEqual([
      "back hair",
      "topwear",
      "face",
    ]);
    expect(m.layers[0].filename).toBe("adrift_layers_1_ab_back hair.png");
    expect(m.layers[0].depthFilename).toBe(
      "adrift_layers_1_ab_back hair_depth.png",
    );
    expect(layerImageUrl(m.layers[0].filename)).toBe(
      "/api/comfy/image?filename=adrift_layers_1_ab_back%20hair.png&subfolder=&type=output",
    );
  });

  it("drops traversal, separators, non-png and bad boxes", () => {
    const m = parseLayerManifest({
      layers: [
        entry("ok"),
        { ...entry("a"), filename: "../secret.png" },
        { ...entry("b"), filename: "sub/x.png" },
        { ...entry("c"), filename: "C:\\x.png" },
        { ...entry("d"), filename: "x.json" },
        { ...entry("e"), filename: "a..b.png" },
        { ...entry("f"), right: -1 },
        { ...entry("g"), left: "0" },
        { ...entry("h"), depth_filename: "../d.png" },
        null,
      ],
    });
    expect(m.layers.map((l) => l.name)).toEqual(["ok", "h"]);
    expect(m.layers[1].depthFilename).toBeNull();
    expect(() => layerImageUrl("../x.png")).toThrow(LayerManifestError);
  });

  it("agrees with validateOutputRef for accepted names", () => {
    for (const n of [
      "a b.png",
      "x_(1).png",
      "../a.png",
      "a/b.png",
      "a\\b.png",
      "é.png",
    ]) {
      if (isSafePngName(n)) expect(validateOutputRef(n, "")).not.toBeNull();
    }
    expect(isSafePngName("a b.png")).toBe(true);
    expect(isSafePngName("é.png")).toBe(false);
  });

  it("throws a typed error when nothing usable is left", () => {
    expect(() => parseLayerManifest({ layers: [] })).toThrow(
      LayerManifestError,
    );
    expect(() =>
      parseLayerManifest({ layers: [{ filename: "../x.png" }] }),
    ).toThrow(LayerManifestError);
    expect(() => parseLayerManifest(null)).toThrow(LayerManifestError);
    expect(() => parseLayerManifest({})).toThrow(LayerManifestError);
  });
});

describe("canvasSize", () => {
  const m = parseLayerManifest({
    layers: [entry("a", { right: 700, bottom: 1190 })],
  });
  it("uses the generation resolution when given", () => {
    expect(canvasSize(m, 1280)).toEqual({ width: 1280, height: 1280 });
  });
  it("defaults to 1280 and grows to boxes that overflow", () => {
    expect(canvasSize(m)).toEqual({ width: 1280, height: 1280 });
    expect(canvasSize(m, 1024)).toEqual({ width: 1216, height: 1216 });
  });
  it("reads the resolution from run params", () => {
    expect(layerRunResolution({ resolution: 1536 })).toBe(1536);
    expect(layerRunResolution({ detail: "fast" })).toBe(1024);
    expect(layerRunResolution({ detail: "max" })).toBe(1280);
    expect(layerRunResolution({})).toBeNull();
    expect(layerRunResolution(undefined)).toBeNull();
  });
});

/** Solid part of size w*h at (left, top) with one colour, alpha and depth. */
function solid(
  left: number,
  top: number,
  w: number,
  h: number,
  rgb: [number, number, number],
  depth: number | ((x: number, y: number) => number) | null,
  depthMedian: number,
  alpha = 255,
): CompositePart {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const d = depth === null ? null : new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rgba.set([...rgb, alpha], i * 4);
      if (d) d[i] = typeof depth === "function" ? depth(x, y) : depth!;
    }
  return {
    rgba,
    depth: d,
    left,
    top,
    width: w,
    height: h,
    visible: true,
    depthMedian,
  };
}

const px = (out: Uint8ClampedArray, w: number, x: number, y: number) =>
  Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

describe("zComposite", () => {
  // Two 4x1 strips over the same pixels. A (red) is nearer on the left half,
  // B (blue) nearer on the right half; B has the larger median, so painter
  // order draws A on top everywhere.
  const A = solid(0, 0, 4, 1, [255, 0, 0], (x) => (x < 2 ? 50 : 200), 0.4);
  const B = solid(0, 0, 4, 1, [0, 0, 255], (x) => (x < 2 ? 150 : 100), 0.5);

  it("orders interleaved parts per pixel where painter order is wrong", () => {
    const z = zComposite([B, A], 4, 1);
    expect(px(z, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(z, 4, 3, 0)).toEqual([0, 0, 255, 255]);
    const p = painterComposite([B, A], 4, 1);
    expect(px(p, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(p, 4, 3, 0)).toEqual([255, 0, 0, 255]);
  });

  it("falls back to depthMedian when a part has no depth map", () => {
    const near = solid(0, 0, 2, 2, [0, 255, 0], null, 0.1);
    const far = solid(0, 0, 2, 2, [255, 0, 0], 250, 0.9);
    const z = zComposite([near, far], 2, 2);
    expect(px(z, 2, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it("skips hidden parts and blends straight alpha over", () => {
    const back = solid(0, 0, 2, 1, [0, 0, 255], 200, 0.8);
    const front = solid(1, 0, 1, 1, [255, 0, 0], 10, 0.1, 128);
    let z = zComposite([back, front], 2, 1);
    expect(px(z, 2, 0, 0)).toEqual([0, 0, 255, 255]);
    const [r, , b, a] = px(z, 2, 1, 0);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
    expect(b).toBeGreaterThan(120);
    expect(a).toBe(255);
    z = zComposite([{ ...back, visible: false }, front], 2, 1);
    expect(px(z, 2, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(z, 2, 1, 0)).toEqual([255, 0, 0, 128]);
  });

  it("ignores near-transparent pixels when ordering and clips to the canvas", () => {
    const ghost = solid(
      -1,
      0,
      3,
      1,
      [9, 9, 9],
      0,
      0,
      Math.floor(ALPHA_THRESHOLD * 255),
    );
    const base = solid(0, 0, 2, 1, [10, 20, 30], 100, 0.5);
    const z = zComposite([base, ghost], 2, 1);
    expect(px(z, 2, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it("depthPreview shows the nearest visible depth, near = bright", () => {
    const d = depthPreview([B, A], 4, 1);
    expect(px(d, 4, 0, 0)).toEqual([205, 205, 205, 255]);
    expect(px(d, 4, 3, 0)).toEqual([155, 155, 155, 255]);
    expect(px(depthPreview([], 4, 1), 4, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("runs 1280x1280 x 24 parts quickly", () => {
    const W = 1280;
    const parts: CompositePart[] = [];
    for (let i = 0; i < 24; i++) {
      const w = 500 + ((i * 37) % 400);
      const h = 600 + ((i * 53) % 500);
      parts.push(
        solid(
          (i * 31) % (W - w),
          (i * 17) % (W - h),
          w,
          h,
          [i * 10, 100, 200],
          (x, y) => (x + y + i * 7) & 255,
          i / 24,
          200,
        ),
      );
    }
    const t0 = performance.now();
    const out = zComposite(parts, W, W);
    const ms = performance.now() - t0;
    expect(out.length).toBe(W * W * 4);
    expect(ms).toBeLessThan(5000);
  });
});

describe("helpers", () => {
  it("depthFromRgba takes the red channel and resamples nearest", () => {
    const rgba = new Uint8ClampedArray([10, 0, 0, 255, 20, 0, 0, 255]);
    expect(Array.from(depthFromRgba(rgba, 2, 1, 2, 1))).toEqual([10, 20]);
    expect(Array.from(depthFromRgba(rgba, 2, 1, 4, 1))).toEqual([
      10, 10, 20, 20,
    ]);
  });

  it("depthFromRgba cuts a part box out of a canvas-sized depth map", () => {
    const rgba = new Uint8ClampedArray(3 * 2 * 4);
    for (let i = 0; i < 6; i++) rgba[i * 4] = i * 10;
    expect(
      Array.from(depthFromRgba(rgba, 3, 2, 2, 1, { left: 1, top: 1 })),
    ).toEqual([40, 50]);
  });

  it("partStems makes file-safe unique stems", () => {
    expect(partStems(["back hair", "Back Hair", "a/../b", "", "眼"])).toEqual([
      "back hair",
      "Back Hair_2",
      "a_b",
      "part",
      "part_2",
    ]);
  });
});
