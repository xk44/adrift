import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Escape closes one layer at a time (C13)", () => {
  it("keyboard help routes Escape through the dialog stack, no window listener", () => {
    const src = read("src/components/KeyboardHelp.tsx");
    expect(src).toContain("useDialogFocus(dialogRef, isOpen, { onEscape: onClose })");
    expect(src).not.toContain('window.addEventListener("keydown"');
  });

  it("page.tsx skips handled Escapes and closes keyboard help before the lightbox", () => {
    const page = read("src/app/page.tsx");
    const start = page.indexOf('if (e.key === "Escape") {');
    expect(start).toBeGreaterThan(-1);
    const block = page.slice(start, start + 900);
    const order = [
      "if (e.defaultPrevented) return;",
      "if (showKeyboardHelp)",
      "if (paletteOpen)",
      "if (lightbox)",
      "if (settingsOpen)",
    ].map((s) => block.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("mobile Menu panel Escape (C13)", () => {
  it("uses the dialog stack, not a window listener", () => {
    const src = read("src/components/MobileBottomNav.tsx");
    expect(src).toMatch(/onEscape: \(\) => setMoreOpen\(false\)/);
    expect(src).not.toContain('window.addEventListener("keydown"');
  });
});
