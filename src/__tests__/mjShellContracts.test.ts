/**
 * shell contract regression checks.
 *
 * These are intentionally source-level checks for stable selectors that visual
 * and keyboard flows depend on. They catch accidental regressions without
 * adding brittle browser layout assertions.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("shell selector contracts", () => {
  it("keeps the prompt textarea on the stable desktop_input_bar id", () => {
    const promptBar = source("src/components/PromptBar.tsx");
    const page = source("src/app/page.tsx");
    const commandPalette = source("src/components/CommandPalette.tsx");

    expect(promptBar).toContain('id="desktop_input_bar"');
    expect(page).toContain('"#desktop_input_bar"');
    expect(commandPalette).toContain('"#desktop_input_bar"');
    expect(page).not.toContain("textarea[placeholder");
    expect(commandPalette).not.toContain("textarea[placeholder");
  });

  it("mounts the toast container once at the app root", () => {
    const layout = source("src/app/layout.tsx");
    const toastContainerMatches = layout.match(/<ToastContainer \/>/g) ?? [];

    expect(layout).toContain('import { ToastContainer } from "@/components/Toast";');
    expect(toastContainerMatches).toHaveLength(1);
  });

  it("keeps failed prompt submissions visible and user-facing", () => {
    const promptBar = source("src/components/PromptBar.tsx");

    expect(promptBar).toContain('import { showToast } from "@/components/Toast";');
    expect(promptBar).toContain("state.errors.length > errorCount");
    expect(promptBar).toContain('showToast(error, "error")');
    expect(promptBar).toContain('setPromptValue("");');
  });

  it("keeps a single top-level #pageScroll container on the app shell", () => {
    const page = source("src/app/page.tsx");
    const pageScrollMatches = page.match(/id="pageScroll"/g) ?? [];

    expect(pageScrollMatches).toHaveLength(1);
    // The <main> tag may be formatted across multiple lines by prettier
    expect(page).toContain("<main");
    expect(page).toContain('id="pageScroll"');
    expect(page).toContain("overflow-y-auto");
    expect(page).toContain("overflow-x-hidden");
    expect(page).toContain("noScrollbar");
  });
});
