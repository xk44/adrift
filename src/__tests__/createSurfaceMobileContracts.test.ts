import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("Create surface mobile contracts", () => {
  const promptBar = read("components/PromptBar.tsx");
  const gallery = read("components/Gallery.tsx");
  const settings = read("components/SettingsPanel.tsx");

  it("collapses secondary prompt tools into one labeled overflow menu", () => {
    expect(promptBar).toContain('aria-label="More prompt tools"');
    expect(promptBar).toContain('aria-controls="cj-prompt-tools"');
    expect(promptBar).toContain('id="cj-prompt-tools"');
    expect(promptBar).toContain('role="menu"');
    expect(promptBar).toContain('aria-haspopup="menu"');
    // Rendered once (no duplicated pickers per breakpoint).
    expect(promptBar.match(/<PromptHistoryDropdown/g)?.length).toBe(1);
    expect(promptBar.match(/<ComfyLibraryPicker/g)?.length).toBe(1);
  });

  it("shows labeled Styles | Images | Settings pills on their own row below sm", () => {
    expect(promptBar).toContain('aria-label="Prompt controls"');
    expect(promptBar).toContain('label="Styles"');
    expect(promptBar).toContain('label="Images"');
    expect(promptBar).toContain('label="Settings"');
    // Card and control row stack below sm, sit side by side from sm up.
    expect(promptBar).toContain("className={PROMPT_ROW_CLASS}");
    expect(promptBar).toContain("className={PROMPT_CONTROLS_CLASS}");
  });

  it("keeps the textarea flexible so the placeholder is not clipped", () => {
    expect(promptBar).toMatch(/order-1 flex-1 min-w-0/);
  });

  it("renders the disconnected state as a quiet status line", () => {
    expect(promptBar).toContain('role="status"');
    expect(promptBar).toContain("<ConnectionStatusPill");
  });

  it("settings opens without a connection gate (matches Ctrl+S)", () => {
    expect(promptBar).not.toMatch(
      /if \(!isConnected\) return;\s*toggleSettings/,
    );
  });

  it("settings panel is a full-screen sheet below md, docked from md up", () => {
    expect(settings).toContain('role="dialog"');
    expect(settings).toMatch(/fixed inset-0 z-50[^"]*md:static/);
    expect(settings).toContain("lg:w-[560px]");
  });

  it("settings drawer has Styles | Settings tabs and regrouped cards", () => {
    expect(settings).toContain('role="tablist"');
    expect(settings).toContain("<StyleReferencePanel embedded />");
    for (const title of [
      'title="Image"',
      'title="Model"',
      'title="Aesthetics"',
      'title="More options"',
      'title="Advanced"',
    ]) {
      expect(settings).toContain(title);
    }
    // The Personalize switch had no backend (nothing read the flag), so the
    // card is gone rather than offering a toggle that changes nothing.
    expect(settings).not.toContain('title="Personalize"');
    expect(settings).not.toContain('aria-label="Personalize"');
    // Self-hosted: no Visibility/Stealth control at all.
    expect(settings).not.toContain('<SettingLabel label="Visibility" />');
    expect(settings).not.toContain('<SettingLabel label="Stealth" />');
  });

  it("run rows are 2-up on phones and use the measured column count from md", () => {
    expect(gallery).toContain(
      "grid-cols-2 md:[grid-template-columns:var(--run-cols)]",
    );
    expect(gallery.match(/className=\{RUN_GRID_CLASS\}/g)?.length).toBe(2);
    // List rows stack the prompt column under the images below lg.
    expect(gallery).toContain('"w-full lg:w-[230px] shrink-0');
    expect(gallery.match(/className=\{RUN_META_CLASS\}/g)?.length).toBe(2);
    expect(gallery).not.toContain("order-first lg:order-none");
    // Run actions stay visible on touch; hover-reveal only on desktop.
    expect(gallery).toContain("lg:opacity-0 lg:group-hover:opacity-100");
  });
});
