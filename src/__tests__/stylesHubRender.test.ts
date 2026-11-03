/**
 * Render smoke test for the merged Styles page: runs the real hub, browse
 * surface and creator panel through SSR so wiring errors surface in CI
 * (the page itself is client-only in page.tsx).
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pins the style-code UI on (the public export flips the default off;
// styleCodesFlagOff.test.ts covers that build).
vi.mock("@/lib/features", () => ({ STYLE_CODES_ENABLED: true }));
import { useUIStore } from "@/store";
import { StylesHubPage } from "@/components/StylesHubPage";
import { StyleCreatorPanel } from "@/components/style/StyleCreatorPanel";
import type { StyleSession } from "@/components/style/styleCreatorLogic";
import type { NavKey } from "@/types";

function render(nav: NavKey, params: Record<string, string> = {}) {
  useUIStore.setState({ activeNav: nav, navParams: params });
  const tab =
    nav === "styles"
      ? "boards"
      : nav === "style-vault"
        ? "map"
        : nav === "style-creator"
          ? "creator"
          : "library";
  return renderToStaticMarkup(
    React.createElement(StylesHubPage, {
      initialTab: tab,
      datasets: React.createElement("div", { "data-testid": "datasets-slot" }),
    }),
  );
}

const SESSION: StyleSession = {
  id: "session-1",
  name: "Test session",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  selectedImageIds: [],
  status: "draft",
};

function renderPanel(sessionId: string | null) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(StyleCreatorPanel, {
      sessionId,
      sessions: [SESSION],
      seed: { prompt: "--sref abc123", imageIds: [], nonce: 1 },
      onClose: noop,
      onStart: noop,
      onOpenSession: noop,
      updateSession: noop,
      deleteSession: noop,
    }),
  );
}

describe("StylesHubPage render", () => {
  afterEach(() => {
    useUIStore.setState({ activeNav: "create" as NavKey, navParams: {} });
  });

  it("library shows browse without the creator panel", () => {
    const html = render("library");
    expect(html).toContain('data-testid="styles-new-style"');
    expect(html).toContain('data-testid="styles-section-saved"');
    expect(html).toContain('data-testid="styles-section-catalog"');
    expect(html).not.toContain('data-testid="style-creator-panel"');
  });

  it("defers the heavy LoRA and Collections sections on first paint", () => {
    const html = render("library");
    expect(html).toContain('data-testid="styles-section-loras"');
    expect(html).toContain('data-testid="styles-section-collections"');
    // Placeholders only: the sections mount when scrolled near.
    expect(html).not.toContain('data-testid="style-library-embedded"');
    expect(html).not.toContain("Krea 2 Style LoRAs");
  });

  it("card icon actions carry visible, accessible labels", () => {
    const browse = readFileSync(
      join(process.cwd(), "src/components/style/StylesBrowse.tsx"),
      "utf8",
    );
    expect(browse).toContain("aria-label={label}");
    expect(browse).toContain("group-hover/ia:opacity-100");
    // No icon-only card button relies on title= alone any more.
    expect(browse).not.toMatch(/title="(Add to prompt|Remix in creator|Copy code|Delete)"/);
    // A missing LoRA catalog degrades to one sentence, not a raw HTTP error.
    const loras = readFileSync(
      join(process.cwd(), "src/components/style/Krea2StyleLoraBrowser.tsx"),
      "utf8",
    );
    expect(loras).toContain('data-testid="krea2-loras-unavailable"');
    // Touch targets grow on coarse pointers.
    expect(browse).toContain("[@media(pointer:coarse)]:min-h-10");
  });

  // zustand 4.5 serves the initial state during SSR, so the store-driven
  // panel toggle (creatorStateForNav, unit-tested in stylesHub.test.ts) is
  // exercised by rendering the panel directly.
  it("creator panel renders the start screen", () => {
    const html = renderPanel(null);
    expect(html).toContain('data-testid="style-creator-panel"');
    expect(html).toContain('data-testid="style-creator-home"');
    expect(html).toContain("--sref abc123");
  });

  it("creator panel renders a session", () => {
    const html = renderPanel("session-1");
    expect(html).toContain('data-testid="style-creator-panel"');
    expect(html).not.toContain('data-testid="style-creator-home"');
    expect(html).toContain("Style session");
  });

  it("styles and style-vault show their own views", () => {
    expect(render("styles")).toContain('data-testid="datasets-slot"');
    const vault = render("style-vault");
    expect(vault).toContain('data-testid="styles-view-map"');
    expect(vault).not.toContain('data-testid="styles-new-style"');
  });
});
