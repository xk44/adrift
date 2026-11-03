/**
 * Navigation / route contract checks for completed shell unification work.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stylesHubTabForNav } from "@/lib/stylesHub";
import {
  NAV_DESTINATIONS,
  destinationForNav,
  mobileMenuDestinations,
} from "@/lib/ui/navRegistry";

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("route/nav shell contracts", () => {
  it("does not expose the orphaned chat nav key", () => {
    const types = source("src/types/index.ts");
    const sidebar = source("src/components/Sidebar.tsx");
    const page = source("src/app/page.tsx");

    expect(types).not.toMatch(/\|\s*"chat"/);
    expect(sidebar).not.toMatch(/key:\s*"chat"/);
    expect(page).not.toMatch(/"\d+":\s*"chat"/);
    expect(page).not.toMatch(/case\s+"chat"/);
  });

  it("routes every legacy style key through the tabbed Styles hub", () => {
    const page = source("src/app/page.tsx");
    const routeMapper = source("src/lib/routeMapper.ts");

    expect(page).toContain('stylesHubTabForNav');
    for (const key of ["library", "styles", "style-creator", "style-vault"]) {
      expect(page).toContain(`case "${key}"`);
    }
    expect(page).toContain("initialTab={stylesHubTabForNav(activeNav)}");
    expect(page).toContain("<StylesHubPage");
    expect(page).toContain('case "style-vault"');
    expect(page).not.toContain("StyleVaultPage");
    expect(page).toContain('datasets={<DatasetBoardsPage kind="style" />}');
    // Style navs share one error boundary so the creator panel opens in place.
    expect(page).toContain('isStylesNav(activeNav) ? "styles-hub" : pageKey');
    expect(source("src/components/StylesHubPage.tsx")).toContain(
      "export { stylesHubTabForNav }",
    );
    expect(routeMapper).toContain('["/styles/:id", "style-vault"]');
    expect(routeMapper).toContain('["/style-vault", "style-vault"]');
  });

  it.each([
    ["library", "library"],
    ["styles", "boards"],
    ["style-creator", "creator"],
    ["style-vault", "map"],
  ] as const)("preselects the %s route's %s hub tab", (nav, tab) => {
    expect(stylesHubTabForNav(nav)).toBe(tab);
  });

  it("exposes one Styles item across desktop and mobile navigation", () => {
    const labels = NAV_DESTINATIONS.map((d) => d.label);
    expect(labels.filter((l) => l === "Styles")).toHaveLength(1);
    for (const gone of ["Style Creator", "Style Vault", "Library"]) {
      expect(labels).not.toContain(gone);
    }
    // Every hub key lights up the single Styles item.
    for (const key of ["library", "styles", "style-creator", "style-vault"] as const) {
      expect(destinationForNav(key)?.key).toBe("styles");
    }
    // Mobile Menu carries Styles and the single Setup page.
    const mobileKeys = mobileMenuDestinations().map((d) => d.key);
    expect(mobileKeys).toEqual(expect.arrayContaining(["styles", "setup"]));
    for (const gone of ["workflows", "pipelines", "manager"]) {
      expect(mobileKeys as string[]).not.toContain(gone);
    }
    expect(mobileKeys).not.toContain("style-vault");
  });
});
