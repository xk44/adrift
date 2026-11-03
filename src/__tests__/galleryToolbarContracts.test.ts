import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const gallery = () =>
  readFileSync(join(process.cwd(), "src/components/Gallery.tsx"), "utf8");

describe("Create feed toolbar + tile hover contracts", () => {
  it("labels the tile quick actions and reuses the row action handler", () => {
    const src = gallery();
    expect(src).toContain('title="Vary subtle"');
    expect(src).toContain('title="Vary strong"');
    expect(src).toContain('title="Animate"');
    expect(src).toContain('handleAction("vary_strong", img)');
    expect(src).toContain('handleAction("animate_low", img)');
  });

  it("puts like/hide/more at the tile's top-right with a portaled menu", () => {
    const src = gallery();
    expect(src).toContain("toggleLiked(img.id)");
    expect(src).toContain("handleHide()");
    expect(src).toContain('aria-label="More actions"');
    expect(src).toContain("createPortal(");
    // Portal events bubble through React; the menu must not open the lightbox.
    expect(src).toContain("onClick={(e) => e.stopPropagation()}");
  });

  it("renders View / Filters / search toolbar and relative date headers", () => {
    const src = gallery();
    expect(src).toContain("<CreateToolbar");
    expect(src).toContain("GALLERY_VIEW_MODES.map");
    expect(src).toContain('role="menuitemradio"');
    expect(src).toContain('aria-label="Search prompts"');
    expect(src).toContain("relativeDateLabel(date, now)");
    expect(src).toContain('aria-label="Scroll to top"');
    // Infinite scroll sentinel still drives chunked rendering.
    expect(src).toContain('<div ref={sentinelRef} className="h-4" />');
  });

  it("persists the view choice defensively", () => {
    const src = gallery();
    expect(src).toContain('"adrift.create.viewMode"');
    expect(src).toMatch(/try \{\s*window\.localStorage\.setItem/);
  });
});
