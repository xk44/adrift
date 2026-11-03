import { describe, expect, it } from "vitest";

import {
  describeColor,
  extractPalette,
  hexToRgb,
  palettePromptText,
} from "@/lib/palette";

/** Build an RGBA buffer from a list of [r,g,b] repeated `n` times each. */
function pixels(
  spec: Array<[number, number, number, number]>,
): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, n] of spec) {
    for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  }
  return new Uint8ClampedArray(out);
}

describe("hexToRgb", () => {
  it("parses with and without leading #", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("00ff00")).toEqual([0, 255, 0]);
  });
});

describe("describeColor", () => {
  it("names greyscale by lightness", () => {
    expect(describeColor("#000000")).toBe("near-black");
    expect(describeColor("#808080")).toBe("grey");
    expect(describeColor("#fefefe")).toBe("off-white");
  });
  it("names saturated hues with a lightness qualifier", () => {
    expect(describeColor("#004d4d")).toContain("teal"); // deep teal
    expect(describeColor("#0000ff")).toContain("blue");
    expect(describeColor("#ff0000")).toContain("red");
  });
  it("splits orange from amber/golden yellow", () => {
    expect(describeColor("#ff7f00")).toBe("vivid orange"); // 30°
    expect(describeColor("#e6a809")).toBe("vivid amber"); // 43°, rain-jacket yellow
    expect(describeColor("#ffe600")).toBe("vivid yellow"); // 54°
  });

  const NEUTRALS = ["near-black", "charcoal", "grey", "silver", "off-white"];
  const HUES = [
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "teal",
    "blue",
    "indigo",
    "magenta",
    "pink",
  ];
  const hasHue = (name: string) =>
    HUES.some((h) => name.split(" ").includes(h));

  it("names near-black swatches neutrally, never by a noise hue", () => {
    // #0c0d09 was "deep lime", #0b0d0a "deep green" (HSL sat ~13% from 3/255 of spread)
    for (const hex of ["#0b0d0a", "#0c0d09", "#101410", "#050505", "#0a1a0a"]) {
      const name = describeColor(hex);
      expect(name, hex).toBe("near-black");
      expect(hasHue(name), hex).toBe(false);
    }
  });

  it("names near-white and grey swatches neutrally", () => {
    expect(describeColor("#f7f8f5")).toBe("off-white"); // was "pale lime"
    expect(describeColor("#fffff0")).toBe("off-white");
    expect(describeColor("#808080")).toBe("grey");
    expect(describeColor("#202820")).toBe("charcoal");
    for (const hex of ["#7a8a7a", "#c0c4c0", "#3a3a3c"]) {
      expect(NEUTRALS, hex).toContain(describeColor(hex));
    }
  });

  it("keeps a dark hue only when chroma is perceptible", () => {
    expect(describeColor("#1a3d1a")).toBe("deep green");
    expect(describeColor("#000033")).toBe("deep blue");
    expect(describeColor("#1a0000")).toBe("deep red");
  });

  it("keeps names for clearly saturated colors", () => {
    expect(describeColor("#32cd32")).toMatch(/green|lime/);
    expect(describeColor("#ff0000")).toBe("vivid red");
    expect(describeColor("#00ff00")).toBe("vivid green");
    expect(describeColor("#0000ff")).toBe("vivid blue");
    expect(describeColor("#ffff00")).toBe("vivid yellow");
    expect(describeColor("#004d4d")).toBe("deep teal");
  });
});

describe("extractPalette", () => {
  it("returns the dominant colors, heaviest first", () => {
    const buf = pixels([
      [255, 0, 0, 100], // red — most
      [0, 0, 255, 50], // blue
      [0, 255, 0, 10], // green — least
    ]);
    const pal = extractPalette(buf, 3);
    expect(pal.length).toBe(3);
    // heaviest first
    expect(pal[0].name).toContain("red");
    expect(pal[0].weight).toBeGreaterThan(pal[1].weight);
  });

  it("skips fully transparent pixels", () => {
    const buf = new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]);
    const pal = extractPalette(buf, 2);
    expect(pal.length).toBe(1);
    expect(pal[0].name).toContain("blue");
  });

  it("returns empty for no opaque pixels", () => {
    expect(extractPalette(new Uint8ClampedArray([1, 2, 3, 0]), 5)).toEqual([]);
  });

  it("spreads results rather than returning near-duplicates", () => {
    // two near-identical reds + one blue; count=2 should prefer red + blue
    const buf = pixels([
      [255, 0, 0, 80],
      [250, 4, 4, 70],
      [0, 0, 255, 40],
    ]);
    const pal = extractPalette(buf, 2);
    const names = pal.map((c) => c.name);
    expect(names.some((n) => n.includes("blue"))).toBe(true);
  });
});

describe("palettePromptText", () => {
  it("builds a palette phrase from unique names", () => {
    const text = palettePromptText([
      { hex: "#004d4d", name: "deep teal", weight: 0.5 },
      { hex: "#ffbf00", name: "vivid orange", weight: 0.3 },
    ]);
    expect(text).toBe("deep teal, vivid orange color palette");
  });
  it("is empty for no colors", () => {
    expect(palettePromptText([])).toBe("");
  });
});
