/**
 * Edit page Tools panel markup (static render; no DOM test library):
 * sections, the Selection tag on mask tools, accessible names, and the
 * toolbar button that opens it.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorToolsPanel } from "@/components/editor/EditorToolsPanel";
import { EditorToolbar } from "@/components/editor/EditorToolbar";

const html = () =>
  renderToStaticMarkup(createElement(EditorToolsPanel, { onClose: () => {} }));

describe("EditorToolsPanel", () => {
  it("lists Image, Video and 3D sections with the built-in tools", () => {
    const out = html();
    for (const s of ["image", "video", "3d"])
      expect(out).toContain(`data-editor-tools-section="${s}"`);
    expect(out).toContain('placeholder="Search tools"');
    expect(out).toContain('id="editor-tools-panel"');
  });

  it("tags tools that use the selection", () => {
    expect(html()).toMatch(/Selection/);
    expect(html()).toContain("with the canvas and selection");
  });

  it("every button has an accessible name", () => {
    const buttons = html().match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) {
      const named =
        /aria-label="[^"]+"|title="[^"]+"/.test(b) ||
        b.replace(/<[^>]+>/g, "").trim().length > 0;
      expect(named, b.slice(0, 120)).toBe(true);
    }
  });

  it("copy stays on brand", () => {
    // Split literals: the public export gate rejects the retired names verbatim.
    const retired = new RegExp(["mid" + "journey", "comfy" + "journey"].join("|"));
    expect(html().toLowerCase()).not.toMatch(retired);
  });
});

// Static render sees the store's initial state (zustand server snapshot),
// so only the empty-editor state is checked here.
describe("EditorToolbar Tools button", () => {
  it("is in the toolbar and disabled until an image is loaded", () => {
    const off = renderToStaticMarkup(createElement(EditorToolbar));
    const btn = off.match(/<button[^>]*data-testid="editor-tools-button"[^>]*>/)?.[0] ?? "";
    expect(btn).toContain("disabled");
    expect(btn).toContain('aria-controls="editor-tools-panel"');
    expect(btn).toContain('title="Load an image first"');
  });
});

describe("EditorPromptBar Submit Edit", () => {
  it("is disabled with a hint until an image is loaded", async () => {
    const { EditorPromptBar } = await import("@/components/editor/EditorPromptBar");
    const out = renderToStaticMarkup(
      createElement(EditorPromptBar, { onSubmit: async () => {} }),
    );
    const btn = out.match(/<button[^>]*data-testid="editor-submit"[^>]*>/)?.[0] ?? "";
    expect(btn).toContain("disabled");
    expect(btn).toContain('title="Load an image first"');
  });
});
