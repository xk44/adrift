/**
 * Edit tab with an image loaded (static render; the editor store is mocked
 * so the server snapshot has a source image). Covers the 390px phone layout
 * (panels collapse into a tabbed sheet; no fixed-width rails), the hidden
 * layers panel, no dead toolbar controls, and the accessible canvas surface.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/store/editorStore", async () => {
  const { create } = await import("zustand");
  const real = await vi.importActual<typeof import("@/store/editorStore")>(
    "@/store/editorStore",
  );
  const initial = real.useEditorStore.getState();
  const state = {
    ...initial,
    sourceImage: "/api/image/example.png",
    sourceDimensions: { width: 1024, height: 768, originalWidth: 1024, originalHeight: 768 },
  };
  const useEditorStore = create(() => state);
  return { ...real, useEditorStore, default: useEditorStore };
});

const { EditorPage } = await import("@/components/editor/EditorPage");
const html = renderToStaticMarkup(createElement(EditorPage));

const openTag = (marker: string) =>
  html.match(new RegExp(`<[^>]*${marker}[^>]*>`))?.[0] ?? "";

describe("EditorPage with an image (phone layout)", () => {
  it("stacks canvas over a tabbed panel sheet below md", () => {
    const layout = openTag('data-testid="editor-layout"');
    expect(layout).toContain("flex-col");
    expect(layout).toContain("md:flex-row");
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Tools</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Export</);
  });

  it("only one side panel shows on phones; side rails are full-width there", () => {
    const tools = openTag('id="editor-panel-tools"');
    const exp = openTag('id="editor-panel-export"');
    expect(tools).toMatch(/class="flex /);
    expect(exp).toMatch(/class="hidden /);
    // No bare fixed widths left: every rail width is md-scoped.
    expect(html).not.toMatch(/class="[^"]*(?<![:\w-])w-(52|64)\b/);
    expect(html).toContain("md:w-52");
    expect(html).toContain("md:w-64");
  });

  it("hides the layers panel (canvas does not composite layers)", () => {
    expect(html).not.toContain(">Layers<");
    expect(html).not.toContain('title="Add layer"');
  });

  it("toolbar has no dead controls", () => {
    expect(html).not.toContain("Magic wand");
    expect(html).not.toContain("Move / Resize");
    const reset = openTag('data-testid="editor-reset"');
    expect(reset).toContain('aria-label="Reset selection"');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toContain("Smart Select");
  });

  it("canvas surface is a labelled, focusable application with keyboard help", () => {
    const surface = openTag('data-testid="editor-canvas-surface"');
    expect(surface).toContain('role="application"');
    expect(surface).toContain('tabindex="0"');
    expect(surface).toMatch(/aria-label="[^"]*\[ \/ \] smaller \/ bigger brush/);
    expect(surface).toMatch(/aria-label="[^"]*H show \/ hide the mask/);
  });

  it("Submit Edit waits for a prompt once an image exists, and says so", () => {
    const submit = openTag('data-testid="editor-submit"');
    expect(submit).toMatch(/\sdisabled/);
    expect(submit).toContain('title="Describe the change first"');
  });

  it("drops dead UI: no Retexture tab, no outpaint-looking edge handles", () => {
    expect(html).not.toContain("Retexture");
    expect(html).not.toContain("ControlNet");
    expect(html).not.toContain("-translate-x-1/2 w-8 h-1");
  });

  it("mask overlay uses a plain blend and has visibility controls", () => {
    const overlay = openTag('data-testid="editor-mask-overlay"');
    expect(overlay).not.toContain("multiply");
    expect(html).toContain('aria-label="Hide mask (H)"');
    expect(html).toContain('aria-label="Mask opacity"');
  });

  it("has a visible shortcut cheat sheet button and mask export", () => {
    expect(openTag('data-testid="editor-shortcuts-button"')).toContain(
      'aria-expanded="false"',
    );
    expect(html).toContain("Keyboard shortcuts");
    expect(html).toContain("Download Mask");
  });

  it("the zoomed stage scrolls instead of clipping (m-auto, overflow-auto)", () => {
    expect(openTag('data-testid="editor-canvas-stage"')).toContain("overflow-auto");
    expect(html).toMatch(/class="relative m-auto shrink-0/);
  });

  it("New is an image-only action with an accessible name on phones", () => {
    const btn = openTag('data-testid="editor-new"');
    expect(btn).toContain('aria-label="New image"');
  });
});
