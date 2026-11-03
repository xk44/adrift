/**
 * Source contracts for the first-run / offline / error-surfacing wiring
 * (the shell is too heavy to render in unit tests).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const src = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("first-run wiring", () => {
  it("Create's empty state is the checklist, never 'No images yet'", () => {
    const gallery = src("src/components/Gallery.tsx");
    expect(gallery).toContain("return <FirstRunChecklist />;");
    expect(gallery).not.toContain("No images yet");
  });

  it("the offline card sits under the prompt bar, or at the top without one", () => {
    const page = src("src/app/page.tsx");
    const wrapper = page.indexOf(
      'className="flex-1 flex flex-col min-w-0 pt-[env(safe-area-inset-top)]"',
    );
    expect(wrapper).toBeGreaterThan(0);
    // Not gated on showPromptBar: Editor, Help and Account still get it.
    const top = page.indexOf("{!showPromptBar && offlineNotice(false)}", wrapper);
    const header = page.indexOf("{showPromptBar && (", wrapper);
    const bar = page.indexOf("<PromptBar", header);
    const under = page.indexOf("{offlineNotice(true)}", bar);
    const content = page.indexOf('id="pageScroll"', wrapper);
    expect(top).toBeGreaterThan(wrapper);
    expect(top).toBeLessThan(header);
    expect(under).toBeGreaterThan(bar);
    expect(under).toBeLessThan(content);
    expect(page).toContain("<SetupDialogHost />");
    expect(page).toContain(
      "dismissed: connBannerDismissed || comfyKnownOffline",
    );
  });

  it("Create failures render through CreateFailureNotice", () => {
    const page = src("src/app/page.tsx");
    expect(page).toContain("<CreateFailureNotice");
    expect(page).toContain("failure={lastFailure}");
  });

  it("the lightbox clears the notch on phones", () => {
    expect(src("src/components/Lightbox.tsx")).toContain(
      "pt-[env(safe-area-inset-top)] md:pt-0",
    );
  });

  it("the 'status dot in the sidebar' hint is desktop-only", () => {
    const page = src("src/app/page.tsx");
    expect(page).toMatch(
      /<span className="hidden md:inline">\s*\{" "\}\s*Click the status dot in the sidebar/,
    );
  });
});

describe("silent catches now toast", () => {
  it("editor", () => {
    expect(
      src("src/components/editor/EditorPage.tsx").match(/showToast\(/g),
    ).toHaveLength(3); // + "Edit queued" confirmation
    expect(
      src("src/components/editor/EditorExport.tsx").match(/showToast\(/g),
    ).toHaveLength(4); // + saved confirmation, + empty-mask info
    expect(src("src/components/editor/EditorEmptyState.tsx")).toContain(
      "That file isn't an image",
    );
    expect(src("src/app/page.tsx")).toContain(
      "showToast(editFailureMessage(result.error)",
    );
  });

  it("account settings: no empty catches, NSFW toggle checks res.ok", () => {
    const account = src("src/components/AccountSettingsPage.tsx");
    expect(account).not.toMatch(/catch \{\}/);
    const toggle = account.slice(account.indexOf("const toggleNsfw"));
    expect(toggle.slice(0, 600)).toContain("if (!res.ok) throw");
  });
});
