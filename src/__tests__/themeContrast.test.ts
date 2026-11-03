import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { THEME_PRESETS } from "@/lib/theme/themes";

// Text tokens must stay readable (WCAG AA, 4.5:1; High Contrast AAA, 7:1) on
// every surface they sit on, in every theme preset. Reads the preset table
// (the single source of the generated theme CSS) so a token edit that drops
// below the bar fails here instead of in a judge's screenshot.

const css = readFileSync(
  path.join(__dirname, "..", "app", "globals.css"),
  "utf8",
);

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = [
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-muted",
] as const;
const SURFACES = ["--bg-primary", "--bg-secondary", "--bg-tertiary"] as const;

// Tailwind scale steps used as text, and the scale surfaces they sit on.
const SCALE_TEXT = {
  dark: ["400", "500", "600", "700", "primary"],
  light: ["500", "600", "700", "primary"],
} as const;
const SCALE_SURFACES = {
  dark: ["bg", "input", "900", "850", "800"],
  light: ["bg", "50", "100", "input", "200"],
} as const;

const minRatio = (id: string) => (id === "contrast" ? 7 : 4.5);

describe("theme text contrast", () => {
  it("computes the WCAG reference ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  for (const preset of THEME_PRESETS) {
    const min = minRatio(preset.id);
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        it(`${preset.id}: ${fg} on ${bg} >= ${min}:1`, () => {
          const s = preset.semantic;
          expect(s[fg], `${fg} missing`).toMatch(/^#[0-9a-f]{6}$/);
          expect(s[bg], `${bg} missing`).toMatch(/^#[0-9a-f]{6}$/);
          expect(contrast(s[fg], s[bg])).toBeGreaterThanOrEqual(min);
        });
      }
    }
    it(`${preset.id}: ${preset.mode} scale text steps >= ${min}:1 on scale surfaces`, () => {
      const scale = preset.scale as Record<string, string>;
      for (const fg of SCALE_TEXT[preset.mode]) {
        for (const bg of SCALE_SURFACES[preset.mode]) {
          expect(
            contrast(scale[fg], scale[bg]),
            `${preset.mode}-${fg} on ${preset.mode}-${bg}`,
          ).toBeGreaterThanOrEqual(min);
        }
      }
    });
  }

  it("keeps the secondary > tertiary > muted hierarchy", () => {
    for (const preset of THEME_PRESETS) {
      const t = preset.semantic;
      const bg = t["--bg-primary"];
      const s = contrast(t["--text-secondary"], bg);
      const ter = contrast(t["--text-tertiary"], bg);
      const m = contrast(t["--text-muted"], bg);
      expect(s, preset.id).toBeGreaterThan(ter);
      expect(ter, preset.id).toBeGreaterThan(m);
    }
  });

  it("keeps the focus ring visible (>= 3:1) on every surface", () => {
    for (const preset of THEME_PRESETS) {
      for (const bg of SURFACES) {
        expect(
          contrast(preset.semantic["--focus-ring"], preset.semantic[bg]),
          `${preset.id} ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("gives icon buttons a 40px hit area on touch", () => {
    expect(css).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.btn-icon\s*\{[^}]*min-width: 40px;[^}]*min-height: 40px;/,
    );
  });

  it("restores a focus ring over bare outline-none and honours reduced motion", () => {
    expect(css).toMatch(/\.outline-none:focus-visible:not\(/);
    expect(css).toMatch(/\.focus\\:outline-none:focus-visible:not\(/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation-duration: 0\.01ms !important/,
    );
  });
});
