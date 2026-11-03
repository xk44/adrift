import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../../tailwind.config";
import { ADRIFT_DARK, ADRIFT_LIGHT } from "@/lib/theme/themes";

const projectRoot = process.cwd();

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (path.includes(join("src", "__tests__"))) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (/\.(tsx|ts)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

type Palette = Record<string, string>;
const colors = (config.theme?.extend as { colors: Record<string, Palette | string> })
  .colors as { light: Palette; dark: Palette; splash: string };

describe("Tailwind dual-palette contracts", () => {
  it("defines every light/dark palette token used by source classes and theme() calls", () => {
    const paletteKeys = {
      light: new Set(Object.keys(colors.light)),
      dark: new Set(Object.keys(colors.dark)),
    };
    const used = new Map<string, Set<string>>([
      ["light", new Set<string>()],
      ["dark", new Set<string>()],
    ]);

    const classTokenPattern = /(?:text|bg|border|from|via|to|ring|divide|placeholder|decoration|outline)-(light|dark)-([A-Za-z0-9_-]+)/g;
    const themeTokenPattern = /theme\(colors\.(light|dark)\.([A-Za-z0-9_-]+)\)/g;

    for (const file of collectSourceFiles(join(projectRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of Array.from(source.matchAll(classTokenPattern))) {
        used.get(match[1])?.add(match[2]);
      }
      for (const match of Array.from(source.matchAll(themeTokenPattern))) {
        used.get(match[1])?.add(match[2]);
      }
    }

    const missing = Array.from(used.entries()).flatMap(([palette, tokens]) =>
      Array.from(tokens)
        .filter((token) => !paletteKeys[palette as "light" | "dark"].has(token))
        .map((token) => `${palette}-${token}`),
    );

    expect(missing).toEqual([]);
  });

  it("keeps the key light/dark semantic aliases and shadows available", () => {
    const configSource = readFileSync(join(projectRoot, "tailwind.config.ts"), "utf8");

    expect(ADRIFT_LIGHT.scale.bg).toBe("#ffffff");
    expect(ADRIFT_LIGHT.scale.input).toBe("#f4f4f5");
    expect(ADRIFT_LIGHT.scale.primary).toBe("#09090b");
    expect(ADRIFT_DARK.scale.bg).toBe("#0d0e12");
    expect(ADRIFT_DARK.scale.input).toBe("#1a1b21");
    expect(ADRIFT_DARK.scale.primary).toBe("#f4f4f5");
    expect(configSource).toContain("panel:");
    expect(configSource).toContain('"panel-dark"');
    expect(configSource).not.toContain('"mj-card"');
  });

  it("reads every palette step from a channel variable (opacity modifiers work)", () => {
    for (const scale of ["light", "dark"] as const) {
      for (const [key, value] of Object.entries(colors[scale])) {
        expect(value).toBe(`rgb(var(--c-${scale}-${key}) / <alpha-value>)`);
      }
    }
    expect(colors.splash).toBe("rgb(var(--c-splash) / <alpha-value>)");
  });
});
