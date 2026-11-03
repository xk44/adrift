import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = src("src/components/tools/ToolsPage.tsx");
const toggle = src("src/components/tools/OpenWeightsFilter.tsx");

describe("Tools hub copy (calm header, honest badges)", () => {
  it("keeps the readiness breakdown in a tooltip", () => {
    expect(page).toMatch(/title=\{readinessDetail\(readiness\)\}/);
  });

  it("keeps the open-weights count out of the visible header", () => {
    expect(toggle).toMatch(/className="sr-only" data-testid="tools-open-weights-count"/);
  });

  it("does not stack NC / Unchecked pills in the NEW cover slot", () => {
    expect(page).not.toMatch(/>\s*Unchecked\s*</);
    expect(page).not.toMatch(/>\s*NC\s*</);
    expect(page).not.toMatch(/Not tested yet/);
    expect(page).toMatch(/>\s*Beta\s*</);
    expect(page).toMatch(/Non-commercial license/);
  });

  it("says 'open weights' once per card (chip, not model line)", () => {
    expect(page).not.toMatch(/modelLine\(/);
  });

  it("featured cards keep a minimum width when the dock narrows the page", () => {
    expect(page).toMatch(/minmax\(220px,1fr\)/);
    expect(page).not.toMatch(/sm:grid-cols-3 sm:gap-4/);
  });
});

describe("Tools deep links and launcher errors", () => {
  it("toasts and strips an unknown ?tool= once the catalog has loaded", () => {
    expect(page).toMatch(
      /if \(loaded && !loadFailed\) \{[\s\S]*?showToast\("Tool not installed"[\s\S]*?syncUrl\(null\);/,
    );
  });

  it("overlay launcher clears a stale load error when it retries", () => {
    const launcher = src("src/components/OverlayToolsLauncher.tsx");
    expect(launcher).toMatch(/setLoadError\(false\);\s*fetch\("\/api\/tools"\)/);
  });
});
