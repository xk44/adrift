/** Caption tokens (text-light-500 / text-dark-400) meet WCAG AA (4.5:1). */
import { describe, expect, it } from "vitest";
import { ADRIFT_DARK, ADRIFT_LIGHT } from "@/lib/theme/themes";

// Tailwind's light.* / dark.* palettes read CSS variables whose default
// values are the Adrift presets' scales.
type Palette = Record<string, string>;
const colors: Record<"light" | "dark", Palette> = {
  light: ADRIFT_LIGHT.scale,
  dark: ADRIFT_DARK.scale,
};

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) =>
    x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("caption contrast (C14)", () => {
  it("light-500 passes AA on the light surfaces", () => {
    const l = colors.light;
    for (const bg of [l.bg, l["50"], l["100"], l.input, l["200"]])
      expect(contrast(l["500"], bg), bg).toBeGreaterThanOrEqual(4.5);
  });

  it("dark-400 passes AA on the dark surfaces", () => {
    const d = colors.dark;
    for (const bg of [d.bg, d.input, d["900"], d["850"], d["800"]])
      expect(contrast(d["400"], bg), bg).toBeGreaterThanOrEqual(4.5);
  });

  it("stays a step below the body text tokens", () => {
    expect(luminance(colors.light["500"])).toBeGreaterThan(
      luminance(colors.light["600"]),
    );
    expect(luminance(colors.dark["400"])).toBeLessThan(
      luminance(colors.dark["500"]),
    );
  });
});
