/**
 * With STYLE_CODES_ENABLED off (the public build), the numeric style-code UI
 * is hidden: no code catalog, no code input / random code, no
 * Style Codes tab, no StyleVault sref groups. Image style reference stays.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "@/store";
import type { NavKey } from "@/types";

vi.mock("@/lib/features", () => ({ STYLE_CODES_ENABLED: false }));

const { StylesHubPage } = await import("@/components/StylesHubPage");
const { StyleLibraryPage } = await import("@/components/StyleLibraryPage");
const { StyleReferencePanel } =
  await import("@/components/style/StyleReferencePanel");
const { StyleCreatorHome } =
  await import("@/components/style/StyleCreatorHome");
const { StyleSessionView } =
  await import("@/components/style/StyleSessionView");

function renderHub(nav: NavKey, tab: "library" | "map" | "train") {
  useUIStore.setState({ activeNav: nav, navParams: {} });
  return renderToStaticMarkup(
    React.createElement(StylesHubPage, {
      initialTab: tab,
      datasets: React.createElement("div", { "data-testid": "datasets-slot" }),
    }),
  );
}

describe("style codes off", () => {
  afterEach(() => {
    useUIStore.setState({ activeNav: "create" as NavKey, navParams: {} });
  });

  it("Styles hub shows the library views and no code catalog", () => {
    const html = renderHub("library", "library");
    expect(html).toContain(">Browse</button>");
    expect(html).toContain(">Datasets</button>");
    for (const label of ["Map", "Clusters", "Images", "Train"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).not.toContain(">Vault</button>");
    expect(html).not.toContain(">Catalog</button>");
    expect(html).not.toContain('data-testid="styles-section-catalog"');
    expect(html).toContain('data-testid="styles-section-saved"');
    expect(html).toContain('data-testid="styles-section-loras"');
    expect(html).not.toContain("Search codes");
  });

  it("/style-vault opens the Map view", () => {
    const html = renderHub("style-vault", "map");
    expect(html).toContain('data-testid="styles-view-map"');
    expect(html).not.toContain('data-testid="styles-new-style"');
  });

  it("Train renders in the public build", () => {
    const html = renderHub("style-vault", "train");
    expect(html).toContain('data-testid="styles-view-train"');
  });

  it("library views render with no style-code UI", async () => {
    const lib = "@/components/style/library";
    const { ClustersView } = await import(`${lib}/ClustersView`);
    const clusters = renderToStaticMarkup(React.createElement(ClustersView));
    expect(clusters).not.toContain("Blend");
    expect(clusters).not.toContain("--sref");
    const source = readFileSync(
      join(process.cwd(), "src/components/style/library/ClustersView.tsx"),
      "utf8",
    );
    expect(source).toContain("{STYLE_CODES_ENABLED && <StyleMixPanel />}");
    expect(source).toContain("{STYLE_CODES_ENABLED && style.codes");
    const { MapView } = await import(`${lib}/MapView`);
    const { ImagesView } = await import(`${lib}/ImagesView`);
    const { TrainView } = await import(`${lib}/TrainView`);
    for (const view of [MapView, ImagesView, TrainView]) {
      expect(() => renderToStaticMarkup(React.createElement(view))).not.toThrow();
    }
  });

  it("Collections has no StyleVault sref groups", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        initialSvGroups: [],
        initialSvOffline: true,
      }),
    );
    expect(html).toContain(">Moodboards</button>");
    expect(html).not.toContain(">Styles</button>");
    expect(html).not.toContain('data-testid="style-library-sv-offline"');
  });

  it("style reference panel keeps images, drops code input and random", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleReferencePanel, { embedded: true }),
    );
    expect(html).toContain('aria-label="Image URL"');
    expect(html).not.toContain('aria-label="Style code"');
    expect(html).not.toContain("Random Style");
    expect(html).not.toContain("Style Library");
  });

  it("creator home offers moodboards, not style codes", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleCreatorHome, {
        sessions: [],
        onStart: () => {},
      }),
    );
    expect(html).not.toContain("style code");
    expect(html).not.toContain("Start from a style");
    expect(html).toContain("moodboard");
  });

  it("a new creator session saves a moodboard", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(StyleSessionView, {
        sessionId: "new",
        sessions: [],
        onBack: noop,
        onCreateSession: noop,
        updateSession: noop,
        deleteSession: noop,
      }),
    );
    expect(html).not.toContain("style code");
    expect(html).toContain("moodboard");
  });
});
