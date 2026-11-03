import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(__dirname, "..", "components", "ManagerPage.tsx"),
  "utf8",
);

describe("ManagerPage copy + error states", () => {
  it("never renders the raw upstream error as the headline", () => {
    expect(src).toContain("friendlyManagerError(error)");
    // Raw text only appears behind a disclosure.
    expect(src).not.toMatch(/<AlertTriangle[^>]*\/>\s*\{error\}/);
    expect(src).toContain("Technical details");
  });

  it("does not claim the catalog installs models, and links to the one download home", () => {
    expect(src).not.toMatch(/install ComfyUI node packs and models/i);
    expect(src).toContain("This list is for browsing");
    expect(src).toContain("openModelDownloads()");
    expect(src).not.toContain("/workflows?tab=civitai");
  });

  it("keeps the blocked pill neutral when nothing is blocked", () => {
    expect(src).toMatch(/blocklistSize > 0\s*\?\s*"border-red-500/);
  });
});
