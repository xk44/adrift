import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResetAllButton } from "@/components/SettingsPanel";

describe("Settings: Reset All confirms first (C14)", () => {
  it("first render is just the button; reset is not called", () => {
    const onReset = vi.fn();
    const html = renderToStaticMarkup(createElement(ResetAllButton, { onReset }));
    expect(html).toContain("Reset All to Defaults");
    expect(html).not.toContain("Reset all<");
    expect(onReset).not.toHaveBeenCalled();
  });

  it("the confirm step offers Cancel (focused) and Reset all", () => {
    const html = renderToStaticMarkup(
      createElement(ResetAllButton, { onReset: vi.fn(), initialConfirming: true }),
    );
    expect(html).toContain('aria-label="Confirm reset"');
    expect(html).toContain("Cancel");
    expect(html).toContain("Reset all");
  });

  it("the panel no longer resets straight from the click", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/SettingsPanel.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/onClick=\{\(\) => useUIStore\.getState\(\)\.resetSettings\(\)\}/);
    expect(src).toContain("<ResetAllButton");
  });
});

describe("focus ring token (C14)", () => {
  it("is neutral in every theme, not the red-orange accent", async () => {
    const { THEME_PRESETS, ADRIFT_DARK, ADRIFT_LIGHT } = await import(
      "@/lib/theme/themes"
    );
    expect([
      ADRIFT_DARK.semantic["--focus-ring"],
      ADRIFT_LIGHT.semantic["--focus-ring"],
    ]).toEqual(["#c9cbd1", "#3d3f45"]);
    for (const p of THEME_PRESETS) {
      expect(p.semantic["--focus-ring"]).not.toContain("accent");
      expect(p.semantic["--focus-ring"]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
