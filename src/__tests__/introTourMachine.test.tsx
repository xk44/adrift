/** Tour state machine, resume, page tours and missing-anchor fallback. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pageTourSteps,
  resolveTourTarget,
  resumeIndex,
  TOUR_CLOSED,
  TOUR_PROGRESS_KEY,
  TOUR_STEPS,
  tourReducer,
  tourSteps,
  type Measurable,
  type TourMachine,
} from "@/lib/tour/tour";
import { TourOverlay } from "@/components/tour/TourOverlay";
import { buildPaletteCommands } from "@/components/CommandPalette";
import { pageTourFallback } from "@/components/tour/tourEntry";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

const g = globalThis as { window?: unknown };

beforeEach(() => {
  if (!("window" in g)) g.window = globalThis;
  localStorage.removeItem(TOUR_PROGRESS_KEY);
});

describe("tour state machine", () => {
  const open: TourMachine = { open: true, tour: "intro", index: 2 };

  it("start opens at a clamped index; a tour with no stops never opens", () => {
    expect(tourReducer(TOUR_CLOSED, { type: "start" }, 5)).toEqual({
      open: true,
      tour: "intro",
      index: 0,
    });
    expect(
      tourReducer(TOUR_CLOSED, { type: "start", index: 99 }, 5).index,
    ).toBe(4);
    expect(
      tourReducer(TOUR_CLOSED, { type: "start", index: -3 }, 5).index,
    ).toBe(0);
    expect(
      tourReducer(TOUR_CLOSED, { type: "start", index: Number.NaN }, 5).index,
    ).toBe(0);
    expect(tourReducer(TOUR_CLOSED, { type: "start" }, 0).open).toBe(false);
  });

  it("next / back step, next on the last stop closes", () => {
    expect(tourReducer(open, { type: "next" }, 5).index).toBe(3);
    expect(tourReducer(open, { type: "back" }, 5).index).toBe(1);
    expect(tourReducer({ ...open, index: 0 }, { type: "back" }, 5).index).toBe(
      0,
    );
    const end = tourReducer({ ...open, index: 4 }, { type: "next" }, 5);
    expect(end.open).toBe(false);
  });

  it("goto clamps; skip closes; closed ignores everything but start", () => {
    expect(tourReducer(open, { type: "goto", index: 4 }, 5).index).toBe(4);
    expect(tourReducer(open, { type: "goto", index: 40 }, 5).index).toBe(4);
    expect(tourReducer(open, { type: "goto", index: -1 }, 5).index).toBe(0);
    expect(tourReducer(open, { type: "skip" }, 5).open).toBe(false);
    for (const type of ["next", "back", "skip"] as const)
      expect(tourReducer(TOUR_CLOSED, { type }, 5)).toBe(TOUR_CLOSED);
  });

  it("keeps the tour id through transitions", () => {
    const page: TourMachine = { open: true, tour: "page:tools", index: 0 };
    expect(tourReducer(page, { type: "next" }, 3).tour).toBe("page:tools");
    expect(tourReducer(page, { type: "skip" }, 3).tour).toBe("page:tools");
  });
});

describe("tour resume", () => {
  it("resumeIndex: saved mid stop resumes; first, last, unknown restart", () => {
    const steps = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(resumeIndex(steps, "c")).toBe(2);
    expect(resumeIndex(steps, "a")).toBe(0);
    expect(resumeIndex(steps, "d")).toBe(0);
    expect(resumeIndex(steps, "gone")).toBe(0);
    expect(resumeIndex(steps, null)).toBe(0);
  });

  it("skip mid-way saves the stop, Take the tour resumes there, finishing clears it", async () => {
    const { useTourStore, startTour, tourResumePoint } =
      await import("@/store/tourStore");
    startTour({ fresh: true });
    useTourStore.getState().goTo(5);
    useTourStore.getState().skip();
    expect(useTourStore.getState().open).toBe(false);
    expect(localStorage.getItem(TOUR_PROGRESS_KEY)).toBe(TOUR_STEPS[5].id);
    expect(tourResumePoint()).toEqual({ index: 5, count: TOUR_STEPS.length });

    startTour();
    expect(useTourStore.getState()).toMatchObject({ open: true, index: 5 });
    expect(localStorage.getItem(TOUR_PROGRESS_KEY)).toBeNull();
    useTourStore.getState().goTo(TOUR_STEPS.length - 1);
    useTourStore.getState().next();
    expect(useTourStore.getState().open).toBe(false);
    expect(tourResumePoint()).toBeNull();
  });

  it("skip on the first stop saves nothing; fresh ignores a saved stop", async () => {
    const { useTourStore, startTour } = await import("@/store/tourStore");
    startTour({ fresh: true });
    useTourStore.getState().skip();
    expect(localStorage.getItem(TOUR_PROGRESS_KEY)).toBeNull();
    localStorage.setItem(TOUR_PROGRESS_KEY, TOUR_STEPS[3].id);
    startTour({ fresh: true });
    expect(useTourStore.getState().index).toBe(0);
    useTourStore.getState().close();
  });

  it("a page tour never touches intro progress", async () => {
    const { useTourStore, startPageTour } = await import("@/store/tourStore");
    localStorage.setItem(TOUR_PROGRESS_KEY, TOUR_STEPS[3].id);
    startPageTour("tools");
    const s = useTourStore.getState();
    expect(s.tour).toBe("page:tools");
    expect(s.steps.every((x) => x.page.nav === "tools")).toBe(true);
    s.next();
    useTourStore.getState().skip();
    expect(localStorage.getItem(TOUR_PROGRESS_KEY)).toBe(TOUR_STEPS[3].id);
  });
});

describe("page tours", () => {
  it("are the intro stops on that page, without the queue and finish cards", () => {
    const tools = pageTourSteps("tools");
    expect(tools.map((s) => s.id)).toEqual(
      TOUR_STEPS.filter((s) => s.page.nav === "tools").map((s) => s.id),
    );
    const create = pageTourSteps("create").map((s) => s.id);
    expect(create).toContain("prompt");
    expect(create).not.toContain("queue");
    expect(create).not.toContain("done");
  });

  it("a page the intro skips gets one centered card from its nav hint", () => {
    const fb = pageTourFallback("moodboards");
    expect(fb.label).toBe("Moodboards");
    const steps = tourSteps("page:moodboards", fb);
    expect(steps).toHaveLength(1);
    expect(steps[0].target).toBeUndefined();
    expect(steps[0].body).toBe(fb.hint);
    expect(pageTourSteps("moodboards")).toEqual([]);
    expect(pageTourFallback("library" as never).label).toBeTruthy();
  });

  it("is reachable from the palette and the account menu", () => {
    const cmds = buildPaletteCommands({
      setActiveNav: vi.fn(),
      setStylesHubTab: vi.fn(),
      toggleSettings: vi.fn(),
      toggleTheme: vi.fn(),
      onClose: vi.fn(),
      onShowKeyboardHelp: vi.fn(),
      onDescribe: vi.fn(),
    });
    expect(cmds.find((c) => c.id === "page-tour")?.label).toBe(
      "What's on this page",
    );
    const sidebar = read("src/components/Sidebar.tsx");
    expect(sidebar).toContain("startTour()");
    expect(sidebar).toContain("startCurrentPageTour()");
  });
});

describe("missing anchors", () => {
  const box = (w: number, h: number): Measurable => ({
    getBoundingClientRect: () => ({ width: w, height: h }),
  });

  it("falls through hidden, missing and invalid selectors to the next one", () => {
    const visible = box(100, 40);
    const dom: Record<string, Measurable[]> = {
      "#hidden": [box(0, 0)],
      "#ok": [box(0, 10), visible],
    };
    const query = (sel: string) => {
      if (sel === "[[bad") throw new SyntaxError("bad selector");
      return dom[sel] ?? [];
    };
    expect(
      resolveTourTarget(["[[bad", "#missing", "#hidden", "#ok"], query),
    ).toEqual({ el: visible, selector: "#ok" });
  });

  it("returns null (centered card) when nothing matches", () => {
    expect(resolveTourTarget(["#a", "#b"], () => [])).toBeNull();
    expect(resolveTourTarget([], () => [box(5, 5)])).toBeNull();
    expect(
      resolveTourTarget(["x"], () => {
        throw new Error("no DOM");
      }),
    ).toBeNull();
  });

  it("every flagship stop has a fallback before the centered card", () => {
    for (const id of [
      "params",
      "feed",
      "lightbox",
      "tools-flagship",
      "video-editor",
    ]) {
      const step = TOUR_STEPS.find((s) => s.id === id)!;
      expect(Array.isArray(step.target), id).toBe(true);
      expect((step.target as string[]).length).toBeGreaterThan(1);
    }
  });
});

describe("tour card", () => {
  const steps = TOUR_STEPS.slice(0, 4);
  const render = (index: number, target?: string) =>
    renderToStaticMarkup(
      createElement(TourOverlay, {
        step: { ...steps[index], target },
        steps,
        index,
        onNext: vi.fn(),
        onBack: vi.fn(),
        onGoTo: vi.fn(),
        onSkip: vi.fn(),
        finishAction: { label: "Open Help", onClick: vi.fn() },
      }),
    );

  it("shows section, count and one labelled dot per stop", () => {
    const html = render(1);
    expect(html).toContain(steps[1].section);
    expect(html).toContain("2 of 4");
    expect(html.match(/aria-label="Stop \d+:/g)).toHaveLength(4);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="Tour progress"');
    expect(html).toContain(">Back<");
    expect(html).toContain(">Skip tour<");
  });

  it("renders without a target (centered) and with an unknown one (no crash)", () => {
    const centered = render(0);
    expect(centered).toContain('role="dialog"');
    expect(centered).not.toContain("invisible");
    const missing = render(0, '[data-tour="does-not-exist"]');
    expect(missing).toContain('data-testid="tour-card"');
    expect(missing).not.toContain("tour-spotlight");
  });

  it("last stop swaps Next for Done and shows the finish action", () => {
    const html = render(3);
    expect(html).toContain(">Done<");
    expect(html).toContain(">Open Help<");
    expect(html).not.toContain(">Skip tour<");
  });
});
