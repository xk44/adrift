import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/components/SettingsPanel.tsx"),
  "utf8",
);

describe("dock aspect ratio is shown once (C16)", () => {
  it("the W:H field renders only in Custom mode", () => {
    expect(src).toMatch(/\{showCustomAspect && \(\s*<input[\s\S]{0,120}aria-label="Custom aspect ratio \(W:H\)"/);
    expect(src).not.toContain("always visible for direct editing");
  });

  it("Custom opens the field even when the value matches a preset", () => {
    expect(src).toContain("const showCustomAspect = isCustom || customOpen;");
    expect(src).toMatch(/aria-pressed=\{showCustomAspect\}[\s\S]{0,200}setCustomOpen\(true\)/);
    expect(src).toContain("!showCustomAspect && settings.aspect === preset.value");
  });
});
