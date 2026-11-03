import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SORT_MENU_OPTIONS,
  activeSortKey,
  hasSortMenu,
  sortMenuLabel,
  sortMenuOptionsFor,
} from "@/lib/explore/sortMenu";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("explore sort menu", () => {
  it("flattens primary tabs and every Top period into one list", () => {
    expect(SORT_MENU_OPTIONS.map((o) => o.key)).toEqual([
      "hot",
      "new",
      "top-today",
      "top-week",
      "top-month",
      "top-year",
      "top-alltime",
      "likes",
    ]);
    const keys = new Set(SORT_MENU_OPTIONS.map((o) => o.key));
    expect(keys.size).toBe(SORT_MENU_OPTIONS.length);
    for (const o of SORT_MENU_OPTIONS) {
      expect(o.period !== undefined).toBe(o.tab === "top");
    }
  });

  it("folds the Top period into the active key and label", () => {
    expect(activeSortKey("hot", "week")).toBe("hot");
    expect(activeSortKey("top", "week")).toBe("top-week");
    expect(sortMenuLabel("top", "today")).toBe("Top Day");
    expect(sortMenuLabel("top", "alltime")).toBe("Top All Time");
    expect(sortMenuLabel("new", "month")).toBe("New");
    expect(sortMenuLabel("likes", "month")).toBe("Likes");
  });

  it("falls back to Hot for an unknown state", () => {
    expect(sortMenuLabel("bogus" as never, "today")).toBe("Hot");
  });

  it("offers Likes only for still images", () => {
    expect(sortMenuOptionsFor("images").some((o) => o.tab === "likes")).toBe(
      true,
    );
    for (const t of ["videos", "models", "loras", "styles"] as const) {
      expect(sortMenuOptionsFor(t).some((o) => o.tab === "likes")).toBe(false);
      expect(sortMenuOptionsFor(t)).toHaveLength(SORT_MENU_OPTIONS.length - 1);
    }
  });

  it("hides the sort trigger only for the curated Styles library", () => {
    expect(hasSortMenu("styles")).toBe(false);
    expect(hasSortMenu("images")).toBe(true);
    expect(hasSortMenu("videos")).toBe(true);
    expect(hasSortMenu("models")).toBe(false);
    expect(hasSortMenu("loras")).toBe(false);
  });
});

describe("explore compact header contracts", () => {
  const controls = src("src/components/ExploreControls.tsx");

  it("renders a phone-only single-row header and hides the wide row on phones", () => {
    expect(controls).toContain('data-testid="explore-compact-header"');
    expect(controls).toContain("md:hidden");
    expect(controls).toMatch(/`hidden md:flex \$\{settingsOpen/);
  });

  it("portals bottom sheets above the fixed bottom tab bar", () => {
    expect(controls).toContain('import { createPortal } from "react-dom"');
    expect(controls).toContain("document.body");
    expect(controls).toContain("fixed inset-0 z-[60] md:hidden");
    expect(controls).toContain('role="radiogroup"');
    expect(controls).toContain('aria-modal="true"');
  });
});

describe("mobile lightbox contracts", () => {
  const lightbox = src("src/components/Lightbox.tsx");

  it("is a full-screen stacked scroller on phones and the content overlay on md+", () => {
    expect(lightbox).toContain(
      "fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain noScrollbar bg-[var(--bg-primary)] md:absolute md:z-40 md:flex-row md:overflow-hidden",
    );
    expect(lightbox).toContain("h-[68dvh] shrink-0");
    expect(lightbox).toContain("w-full shrink-0 flex flex-col");
    expect(lightbox).toContain("md:w-[420px]");
  });

  it("keeps horizontal strips out of swipe navigation", () => {
    expect(lightbox).toContain("data-lightbox-hscroll");
    expect(lightbox).toContain('closest("[data-lightbox-hscroll]")');
    expect(lightbox).toContain("touchStartScrolledRef");
  });
});

describe("explore bottom sheet focus (F7)", () => {
  it("traps Tab inside the sheet and restores focus via useDialogFocus", () => {
    const controls = src("src/components/ExploreControls.tsx");
    expect(controls).toContain('from "@/hooks/useDialogFocus"');
    expect(controls).toContain(
      'useDialogFocus(panelRef, open && mounted, { initialFocus: "none" })',
    );
  });
});
