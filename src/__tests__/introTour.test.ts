import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forcedTour,
  markTourSeen,
  placeTourCard,
  readTourSeen,
  sheetDock,
  shouldAutoStartTour,
  spotlightRect,
  stripTourParam,
  TOUR_MAX_STEPS,
  TOUR_SEEN_KEY,
  TOUR_STEPS,
  stepTargets,
  tourKeyAction,
} from "@/lib/tour/tour";
import { NAV_DESTINATIONS } from "@/lib/ui/navRegistry";
import { buildPaletteCommands } from "@/components/CommandPalette";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

const g = globalThis as { window?: unknown };
let hadWindow = false;
beforeEach(() => {
  hadWindow = "window" in g;
  if (!hadWindow) g.window = globalThis;
  localStorage.removeItem(TOUR_SEEN_KEY);
});
afterEach(() => {
  if (!hadWindow) delete g.window;
});

describe("intro tour: step list", () => {
  it("has 16-20 stops with unique ids, a section, a title and a short body", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(16);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(TOUR_MAX_STEPS);
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of TOUR_STEPS) {
      expect(s.title.trim()).not.toBe("");
      expect(s.section.trim()).not.toBe("");
      expect(s.body.trim()).not.toBe("");
      // 1-2 sentences
      expect(s.body.split(/[.?]\s/).length).toBeLessThanOrEqual(3);
    }
  });

  it("copy is plain: no hype words, exclamation marks or emoji, sentence case titles", () => {
    const hype = /\b(unlock|seamless|magic|supercharge|powerful|effortless)/i;
    for (const s of TOUR_STEPS) {
      const text = `${s.title} ${s.body}`;
      expect(text).not.toMatch(hype);
      expect(text).not.toContain("!");
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      const words = s.title.split(" ").slice(1);
      for (const w of words) {
        // Later words lower-case unless a proper noun / acronym.
        if (/^[A-Z][a-z]+$/.test(w)) expect(["GPU", "LoRA"]).toContain(w);
      }
    }
  });

  it("every stop lives on a real nav page, ends on a target-less finish card", () => {
    const keys = new Set(NAV_DESTINATIONS.map((d) => d.key));
    for (const s of TOUR_STEPS) expect(keys.has(s.page.nav)).toBe(true);
    const last = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(last.target).toBeUndefined();
    expect(last.body).toContain("Help");
    expect(TOUR_STEPS[0].target).toBe("[data-prompt-card]");
  });

  it("each data-tour / data-testid target exists in the page source it points at", () => {
    const sources = [
      "src/app/page.tsx",
      "src/components/Gallery.tsx",
      "src/components/Sidebar.tsx",
      "src/components/SettingsPanel.tsx",
      "src/components/editor/video/VideoEditor.tsx",
      "src/components/editor/video/VideoStartSection.tsx",
      "src/components/tools/ToolsPage.tsx",
      "src/components/tools/userTools/ImportWorkflowDialog.tsx",
      "src/components/editor/EditorPage.tsx",
      "src/components/ExplorePage.tsx",
      "src/components/StylesHubPage.tsx",
      "src/components/SetupPage.tsx",
      "src/components/AccountSettingsPage.tsx",
      "src/components/PromptBar.tsx",
    ]
      .map((f) => {
        try {
          return read(f);
        } catch {
          return "";
        }
      })
      .join("\n");
    for (const sel of TOUR_STEPS.flatMap(stepTargets)) {
      const m = sel.match(/^\[([\w-]+)(?:="([^"]+)")?\]$/);
      expect(m, sel).not.toBeNull();
      const [, attr, value] = m!;
      const needle = value ? `${attr}="${value}"` : attr;
      if (attr === "data-testid" && value?.startsWith("tool-card-")) {
        // ToolsPage builds it from the hub card key
        expect(sources).toContain("data-testid={`tool-card-${card.key}`}");
        expect(read("src/lib/tools/toolNames.ts")).toContain(
          `"${value.slice("tool-card-".length)}"`,
        );
        continue;
      }
      if (attr === "data-testid" && value === "characters-hero") {
        // DatasetBoardsPage builds it from meta.nav
        const boards = read("src/components/DatasetBoardsPage.tsx");
        expect(boards).toContain("testId={`${meta.nav}-hero`}");
        expect(boards).toContain('nav: "characters"');
        continue;
      }
      expect(sources, needle).toContain(needle);
    }
  });
});

describe("intro tour: when it starts", () => {
  const closed = { wasOpen: true, wasFirstRun: true, isOpen: false };

  it("starts after the first-run wizard closes, once", () => {
    expect(shouldAutoStartTour(closed, false)).toBe(true);
    expect(shouldAutoStartTour(closed, true)).toBe(false);
  });

  it("never starts for a wizard opened by hand, or with no wizard", () => {
    expect(shouldAutoStartTour({ ...closed, wasFirstRun: false }, false)).toBe(
      false,
    );
    expect(
      shouldAutoStartTour(
        { wasOpen: false, wasFirstRun: false, isOpen: false },
        false,
      ),
    ).toBe(false);
    // still open (step change) → no
    expect(shouldAutoStartTour({ ...closed, isOpen: true }, false)).toBe(false);
  });

  it("?tour=1 forces it; the param is stripped afterwards", () => {
    expect(forcedTour("?tour=1")).toBe(true);
    expect(forcedTour("?a=b&tour=true")).toBe(true);
    expect(forcedTour("?tour=0")).toBe(false);
    expect(forcedTour("")).toBe(false);
    expect(stripTourParam("?tour=1")).toBe("");
    expect(stripTourParam("?view=models&tour=1")).toBe("?view=models");
  });

  it("persists the seen flag and tolerates broken storage", () => {
    expect(readTourSeen()).toBe(false);
    markTourSeen();
    expect(readTourSeen()).toBe(true);
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readTourSeen()).toBe(false);
    spy.mockRestore();
  });

  it("starting the tour marks it seen; next past the end closes it", async () => {
    const { useTourStore, startTour } = await import("@/store/tourStore");
    startTour({ fresh: true });
    expect(readTourSeen()).toBe(true);
    expect(useTourStore.getState()).toMatchObject({ open: true, index: 0 });
    useTourStore.getState().back();
    expect(useTourStore.getState().index).toBe(0);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++)
      useTourStore.getState().next();
    expect(useTourStore.getState().index).toBe(TOUR_STEPS.length - 1);
    useTourStore.getState().next();
    expect(useTourStore.getState().open).toBe(false);
  });

  it("only the first-run wizard is flagged; a manual re-open is not", async () => {
    const { useOnboardingStore } = await import("@/store/onboardingStore");
    const s = useOnboardingStore.getState();
    s.openOnboarding(undefined, { firstRun: true });
    expect(useOnboardingStore.getState().firstRun).toBe(true);
    // a step change while open keeps the flag
    useOnboardingStore.getState().openOnboarding("connect");
    expect(useOnboardingStore.getState().firstRun).toBe(true);
    useOnboardingStore.getState().close();
    expect(useOnboardingStore.getState().firstRun).toBe(false);
    useOnboardingStore.getState().openOnboarding();
    expect(useOnboardingStore.getState().firstRun).toBe(false);
    useOnboardingStore.getState().close();
  });

  it("OnboardingHost flags only its own first-run open, and TourHost listens for it", () => {
    const host = read("src/components/onboarding/OnboardingHost.tsx");
    expect(host).toContain("{ firstRun: true }");
    const tour = read("src/components/tour/TourHost.tsx");
    expect(tour).toContain("shouldAutoStartTour(");
    expect(tour).toContain("forcedTour(");
    expect(read("src/app/page.tsx")).toContain("<TourHost />");
  });
});

describe("intro tour: re-launch", () => {
  it("command palette has Take the tour", () => {
    const d = {
      setActiveNav: vi.fn(),
      setStylesHubTab: vi.fn(),
      toggleSettings: vi.fn(),
      toggleTheme: vi.fn(),
      onClose: vi.fn(),
      onShowKeyboardHelp: vi.fn(),
      onDescribe: vi.fn(),
    };
    const cmd = buildPaletteCommands(d).find((c) => c.id === "take-tour");
    expect(cmd?.label).toBe("Take the tour");
    expect(cmd?.keywords).toContain("tour");
  });

  it("Help and Settings offer it", () => {
    for (const f of [
      "src/components/HelpPage.tsx",
      "src/components/SettingsPanel.tsx",
    ]) {
      const src = read(f);
      expect(src).toContain("startTour()");
      expect(src).toContain("Take the tour");
    }
  });
});

describe("intro tour: keyboard", () => {
  it("maps arrows and Escape, ignores modified keys and IME", () => {
    expect(tourKeyAction({ key: "ArrowRight" }, 0)).toBe("next");
    expect(tourKeyAction({ key: "ArrowLeft" }, 3)).toBe("back");
    expect(tourKeyAction({ key: "ArrowLeft" }, 0)).toBeNull();
    expect(tourKeyAction({ key: "Escape" }, 5)).toBe("skip");
    expect(tourKeyAction({ key: "ArrowRight", metaKey: true }, 0)).toBeNull();
    expect(tourKeyAction({ key: "Escape", isComposing: true }, 0)).toBeNull();
    expect(tourKeyAction({ key: "Enter" }, 0)).toBeNull();
    expect(tourKeyAction({ key: "Home" }, 4)).toBe("first");
    expect(tourKeyAction({ key: "Home" }, 0)).toBeNull();
    expect(tourKeyAction({ key: "End" }, 0)).toBe("last");
  });

  it("overlay is a modal dialog labelled by its title, keys handled in capture", () => {
    const src = read("src/components/tour/TourOverlay.tsx");
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain("aria-labelledby={titleId}");
    expect(src).toContain("useDialogFocus(");
    expect(src).toContain('addEventListener("keydown", onKey, true)');
    expect(src).toContain("motion-safe:");
  });
});

describe("intro tour: card placement", () => {
  const vp = { width: 1280, height: 800 };
  const card = { width: 340, height: 180 };

  it("centers without a target", () => {
    expect(placeTourCard(null, card, vp)).toEqual({
      left: 470,
      top: 310,
      side: "center",
    });
  });

  it("sits below, then above, then beside, always inside the viewport", () => {
    const top = { left: 100, top: 40, width: 400, height: 60 };
    const below = placeTourCard(top, card, vp);
    expect(below.side).toBe("bottom");
    expect(below.top).toBe(40 + 60 + 14);
    const low = { left: 900, top: 700, width: 300, height: 60 };
    const above = placeTourCard(low, card, vp);
    expect(above.side).toBe("top");
    expect(above.left + card.width).toBeLessThanOrEqual(vp.width - 16);
    const tall = { left: 0, top: 10, width: 600, height: 780 };
    expect(placeTourCard(tall, card, vp).side).toBe("right");
    const huge = { left: 0, top: 0, width: 1280, height: 800 };
    const inside = placeTourCard(huge, card, vp);
    expect(inside.top + card.height).toBeLessThanOrEqual(vp.height - 16);
  });

  it("phone sheet docks away from the spotlight", () => {
    expect(sheetDock(null, 800)).toBe("bottom");
    expect(sheetDock({ left: 0, top: 50, width: 300, height: 100 }, 800)).toBe(
      "bottom",
    );
    expect(sheetDock({ left: 0, top: 600, width: 300, height: 100 }, 800)).toBe(
      "top",
    );
  });

  it("spotlight pads and clips, null when empty", () => {
    expect(
      spotlightRect({ left: 10, top: 10, width: 100, height: 50 }, vp),
    ).toEqual({ left: 4, top: 4, width: 112, height: 62 });
    expect(
      spotlightRect({ left: 0, top: 0, width: 0, height: 0 }, vp),
    ).toBeNull();
    expect(
      spotlightRect({ left: 0, top: 900, width: 100, height: 50 }, vp),
    ).toBeNull();
  });
});
