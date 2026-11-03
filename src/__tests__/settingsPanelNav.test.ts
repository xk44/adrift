import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { navigateToDestination } from "@/lib/ui/navRegistry";
import { buildPathname } from "@/lib/routeMapper";

describe("Settings drawer: Browse style library", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/SettingsPanel.tsx"),
    "utf8",
  );

  it("goes through the nav registry, never the raw 'styles' (Datasets) key", () => {
    expect(src).not.toContain('setActiveNav("styles")');
    expect(src).toMatch(/navigateToDestination\("styles"/);
  });

  it("the Styles destination opens Browse at /styles", () => {
    const setActiveNav = vi.fn();
    const setStylesHubTab = vi.fn();
    navigateToDestination("styles", { setActiveNav, setStylesHubTab });
    expect(setStylesHubTab).toHaveBeenCalledWith("library");
    expect(setActiveNav).toHaveBeenCalledWith("library");
    expect(buildPathname(setActiveNav.mock.calls[0][0])).toBe("/styles");
  });
});
