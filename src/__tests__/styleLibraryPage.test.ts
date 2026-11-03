import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Pins the style-code UI on (the public export flips the default off;
// styleCodesFlagOff.test.ts covers that build).
vi.mock("@/lib/features", () => ({ STYLE_CODES_ENABLED: true }));
import {
  kindBadgeLabel,
  normalizeKreaSources,
  StyleLibraryPage,
} from "@/components/StyleLibraryPage";

vi.mock("@/hooks", () => ({
  navigateTo: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  showToast: vi.fn(),
}));

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("StyleLibraryPage", () => {
  it("renders all filter chips", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        initialSvGroups: [],
        initialSvOffline: true,
      }),
    );

    for (const label of ["All", "Moodboards", "Characters", "Datasets", "Krea", "Styles"]) {
      expect(html).toContain(`>${label}</button>`);
    }
  });

  it("renders embedded inside the Styles page without its own header", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        embedded: true,
        query: "",
        initialSvGroups: [],
        initialSvOffline: true,
      }),
    );

    expect(html).toContain('data-testid="style-library-embedded"');
    expect(html).not.toContain("<h1");
    expect(html).toContain(">Moodboards</button>");
  });

  it("keeps kind badge logic explicit", () => {
    expect(kindBadgeLabel("moodboard")).toBe("Moodboard");
    expect(kindBadgeLabel("character")).toBe("Character");
    expect(kindBadgeLabel("style")).toBe("Style");
  });

  it("an absent StyleVault degrades to one quiet line, not an error", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        initialSvGroups: [],
        initialSvOffline: true,
      }),
    );

    expect(html).toContain('data-testid="style-library-sv-offline"');
    expect(html).toContain("appear here when StyleVault is running");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Couldn&#x27;t reach");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("No style collections yet");
    expect(html).not.toMatch(/\bMJ\b/);
  });

  it("hides the Krea import section when there is nothing to import", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        initialSvGroups: [],
      }),
    );
    expect(html).not.toContain("Krea (not imported)");
    expect(html).not.toContain("No unimported Krea boards");
  });

  it("never lists Krea sources from the single-image route", () => {
    // /api/moodboards/krea requires board+file; a bare GET always 400s.
    expect(source("src/components/StyleLibraryPage.tsx")).not.toMatch(
      /fetch\(\s*["'`]\/api\/moodboards\/krea["'`]\s*\)/,
    );
  });

  it("an empty but reachable StyleVault reads as empty, not as an error", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        initialSvGroups: [],
        initialSvOffline: false,
      }),
    );

    expect(html).toContain("No style collections yet");
    expect(html).not.toContain("Couldn&#x27;t reach StyleVault");
  });

  it("normalizes Krea source-list payloads for import cards", () => {
    const sources = normalizeKreaSources({
      boards: [
        {
          id: "01_Test_images",
          name: "Test",
          images: [{ url: "/api/moodboards/krea?board=01_Test_images&file=a.png" }],
        },
      ],
    });

    expect(sources).toEqual([
      {
        id: "01_Test_images",
        name: "Test",
        description: undefined,
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
            weight: 1,
            caption: undefined,
          },
        ],
      },
    ]);
  });

  it("wires the library into the merged Styles page", () => {
    const page = source("src/app/page.tsx");
    const types = source("src/types/index.ts");
    const sidebar = source("src/components/Sidebar.tsx");
    const hub = source("src/components/StylesHubPage.tsx");
    const browse = source("src/components/style/StylesBrowse.tsx");

    expect(types).toContain('| "library"');
    for (const tab of ["library", "boards", "creator", "map", "clusters", "images", "train"]) {
      expect(types).toMatch(new RegExp(`export type StylesHubTab =[^;]*"${tab}"`));
    }
    expect(sidebar).toContain('navDestinationsIn("more")');
    expect(source("src/lib/ui/navRegistry.ts")).toMatch(
      /key: "styles",\s*label: "Styles"/,
    );
    expect(page).toContain('import("@/components/StylesHubPage")');
    expect(page).toContain('case "library"');
    expect(page).toContain("<StylesHubPage");
    expect(hub).toContain('{ key: "browse", label: "Browse", tab: "library" }');
    expect(hub).toContain('{ key: "datasets", label: "Datasets", tab: "boards" }');
    expect(hub).toContain('tab: "map"');
    expect(hub).not.toContain('tab: "vault"');
    expect(hub).toContain("<StyleCreatorPanel");
    expect(browse).toContain("<StyleLibraryPage embedded query={query} />");
    expect(browse).toContain("<Krea2StyleLoraBrowser");
  });
});
