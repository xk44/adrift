import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const lightboxSource = () =>
  readFileSync(join(projectRoot, "src/components/Lightbox.tsx"), "utf8");

describe("lightbox more menu contracts", () => {
  it("uses the top-right More button as a menu instead of a direct copy-url action", () => {
    const source = lightboxSource();

    expect(source).toContain('aria-label="More actions"');
    expect(source).toContain('role="menu"');
    expect(source).toContain('setShowMoreMenu((value) => !value)');
    expect(source).not.toContain('title="Copy image URL"\n          >\n            <MoreHorizontal');
  });

  it("exposes the lightbox menu actions and nested copy options", () => {
    const source = lightboxSource();

    expect(source).toContain("Copy prompt");
    expect(source).toContain("Copy image URL");
    expect(source).toContain("Copy seed");
    expect(source).toContain("Copy metadata");
    expect(source).not.toContain("Report flow is not connected");
    expect(source).toContain("Download Image");
    // Reverse image search had no backend: the disabled item was removed.
    expect(source).not.toContain("Search Image");
  });

  it("closes the menu on an outside press and after any item runs", () => {
    const source = lightboxSource();
    expect(source).toContain("const runMenuItem = (action: () => void) =>");
    expect(source).toContain("const menu = moreMenuRef.current;");
  });

  it("copies the full prompt with fallback seed and metadata through shared clipboard helper", () => {
    const source = lightboxSource();

    expect(source).toContain("const getFullPrompt = () =>");
    expect(source).toContain('`${currentImage.prompt} --seed ${currentImage.seed}`');
    expect(source).toContain("const getImageMetadata = () => ({");
    expect(source).toContain("copyText(JSON.stringify(getImageMetadata(), null, 2), \"Metadata copied\")");
  });
});
