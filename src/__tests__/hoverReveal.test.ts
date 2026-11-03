import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Touch screens have no hover: an action that is only revealed by
// `group-hover:opacity-100` is invisible on a phone. New hover reveals must
// also reveal on focus-within (keyboard) and on `(hover:none)` devices, or
// use the Gallery tap-to-reveal pattern. Remaining hits are decorative
// overlays (gradients, captions, drag grips) — a per-file ratchet.

const BASELINE: Record<string, number> = {
  "src/components/editor/EditorLayers.tsx": 1, // drag grip
  "src/components/ExplorePage.tsx": 1, // likes badge
  "src/components/PersonalizePage.tsx": 2, // gradient + caption
  "src/components/ProfilePage.tsx": 3, // avatar camera, gradients
  "src/components/PromptAttachmentSections.tsx": 1, // thumb caption
  "src/components/PromptBar.tsx": 2, // owned by the prompt bar workstream
  "src/components/style/MoodboardPanel.tsx": 1, // drag grip
  "src/components/style/StyleReferencePanel.tsx": 1, // drag grip
  "src/components/style/StyleSessionView.tsx": 2, // check mark, seed badge
  "src/components/TasksPage.tsx": 3, // gradient + caption + chevron
};

const HOVER_ONLY = /opacity-0 group-hover(\/[\w-]+)?:opacity-100/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("hover-only reveals", () => {
  it("do not grow beyond the decorative baseline", () => {
    const root = path.join(__dirname, "..", "..");
    const counts: Record<string, number> = {};
    for (const abs of tsxFiles(path.join(root, "src", "components"))) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const line of readFileSync(abs, "utf8").split("\n")) {
        if (HOVER_ONLY.test(line) && !/focus-within|focus-visible|hover:none/.test(line)) {
          counts[rel] = (counts[rel] ?? 0) + 1;
        }
      }
    }
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    const over = Object.entries(counts)
      .filter(([f, n]) => n > (BASELINE[f] ?? 0))
      .map(
        ([f, n]) =>
          `${f}: ${n} hover-only reveals (baseline ${BASELINE[f] ?? 0}) — add group-focus-within:opacity-100 [@media(hover:none)]:opacity-100`,
      );
    expect(over).toEqual([]);
  });
});
