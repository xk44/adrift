import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchFocusOnOpen } from "@/components/LightboxToolsPanel";

const FILES = [
  "src/components/Lightbox.tsx",
  "src/components/LightboxActions.tsx",
  "src/components/LightboxToolsPanel.tsx",
  "src/components/StyleInsights.tsx",
  "src/components/RerunSheet.tsx",
];

/** Every literal `<button ...>` opening tag in a source file. */
function buttonTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<button\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // Walk to the matching `>` of the opening tag, skipping `{...}` and
    // quoted attribute values (they can contain `>` from arrow functions).
    let i = m.index + 7;
    let depth = 0;
    let quote: string | null = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

describe("lightbox buttons are labelled", () => {
  for (const file of FILES) {
    it(`${file}: every button has a tooltip and an aria-label`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const tags = buttonTags(source);
      expect(tags.length).toBeGreaterThan(0);
      const missing = tags.filter(
        (t) => !/\btitle=/.test(t) || !/\baria-label=/.test(t),
      );
      expect(missing).toEqual([]);
    });
  }
});

describe("tools panel search focus", () => {
  it("focuses only with a fine pointer so touch keyboards stay closed", () => {
    expect(searchFocusOnOpen(() => ({ matches: true }))).toBe(true);
    expect(searchFocusOnOpen(() => ({ matches: false }))).toBe(false);
  });
});
