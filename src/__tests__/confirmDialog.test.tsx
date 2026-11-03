/** Shared ConfirmDialog replaces window.confirm across the app. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: false,
        title: "Delete?",
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(html).toBe("");
  });

  it("is a labelled modal alertdialog with both buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        title: "Delete 3 moodboards?",
        message: "This can't be undone.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("Delete 3 moodboards?");
    expect(html).toContain("This can&#x27;t be undone.");
    expect(html).toContain(">Cancel<");
    expect(html).toContain(">Delete<");
    expect(html).toContain("bg-red-600");
  });

  it("call sites no longer use window.confirm", () => {
    for (const f of [
      "src/components/Gallery.tsx",
      "src/components/MoodboardsPage.tsx",
      "src/components/tools/BoardRunner.tsx",
      "src/components/gallery/SelectionBar.tsx",
      "src/components/editor/video/VideoEditor.tsx",
    ]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/window\.confirm\(/);
      expect(src, f).toContain("useConfirm");
    }
  });
});
