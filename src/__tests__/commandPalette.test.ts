import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPaletteCommands } from "@/components/CommandPalette";

function deps() {
  return {
    setActiveNav: vi.fn(),
    setStylesHubTab: vi.fn(),
    toggleSettings: vi.fn(),
    toggleTheme: vi.fn(),
    onClose: vi.fn(),
    onShowKeyboardHelp: vi.fn(),
    onDescribe: vi.fn(),
  };
}

describe("command palette: Describe Image", () => {
  it("asks the shell to open the dialog, then closes the palette", () => {
    const d = deps();
    const cmd = buildPaletteCommands(d).find((c) => c.id === "describe-image");
    expect(cmd).toBeDefined();
    cmd!.action();
    expect(d.onDescribe).toHaveBeenCalledTimes(1);
    expect(d.onClose).toHaveBeenCalledTimes(1);
    expect(d.onDescribe.mock.invocationCallOrder[0]).toBeLessThan(
      d.onClose.mock.invocationCallOrder[0],
    );
  });

  it("the dialog is rendered by page.tsx outside the palette's conditional mount", () => {
    const page = readFileSync(
      path.join(process.cwd(), "src/app/page.tsx"),
      "utf8",
    );
    const palette = readFileSync(
      path.join(process.cwd(), "src/components/CommandPalette.tsx"),
      "utf8",
    );
    expect(palette).not.toContain("<DescribeDialog");
    expect(page).toMatch(/\{describeOpen && \(/);
    expect(page).toContain("onDescribe={() => setDescribeOpen(true)}");
  });
});

describe("command palette: themes", () => {
  it("keeps the light/dark toggle and adds one Theme entry per preset", async () => {
    const { THEME_PRESETS } = await import("@/lib/theme/themes");
    const setPalette = vi.fn();
    const d = { ...deps(), setPalette };
    const cmds = buildPaletteCommands(d);
    expect(cmds.find((c) => c.id === "toggle-theme")).toBeDefined();
    const themeCmds = cmds.filter((c) => c.id.startsWith("theme-"));
    expect(themeCmds.map((c) => c.label)).toEqual(
      THEME_PRESETS.map((p) => `Theme: ${p.name}`),
    );
    themeCmds.find((c) => c.id === "theme-oled")!.action();
    expect(setPalette).toHaveBeenCalledWith("oled");
    expect(d.onClose).toHaveBeenCalledTimes(1);
  });
});
