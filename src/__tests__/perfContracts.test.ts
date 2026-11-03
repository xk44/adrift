/**
 * Re-render / timer contracts for critique #34 (source-level + pure helpers;
 * node env, no jsdom — same idiom as clientAsyncRaceContracts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startVisibleInterval,
  type VisibilityDoc,
} from "@/lib/ui/visibleInterval";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function fakeDoc(state: "visible" | "hidden") {
  let listener: (() => void) | null = null;
  const doc = {
    visibilityState: state as string,
    addEventListener: (_: "visibilitychange", fn: () => void) => {
      listener = fn;
    },
    removeEventListener: (_: "visibilitychange", fn: () => void) => {
      if (listener === fn) listener = null;
    },
  };
  return {
    doc: doc as VisibilityDoc,
    set(next: "visible" | "hidden") {
      doc.visibilityState = next;
      listener?.();
    },
    hasListener: () => listener !== null,
  };
}

describe("startVisibleInterval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately and every period while visible", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { doc } = fakeDoc("visible");
    const stop = startVisibleInterval(tick, 5000, doc);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15000);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it("pauses while hidden and refreshes once on return", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const f = fakeDoc("visible");
    const stop = startVisibleInterval(tick, 5000, f.doc);
    f.set("hidden");
    vi.advanceTimersByTime(60000);
    expect(tick).toHaveBeenCalledTimes(1);
    f.set("visible");
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("starting hidden does one tick and no timer; stop removes the listener", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const f = fakeDoc("hidden");
    const stop = startVisibleInterval(tick, 5000, f.doc);
    vi.advanceTimersByTime(20000);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
    expect(f.hasListener()).toBe(false);
    f.set("visible");
    vi.advanceTimersByTime(20000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe("WorkflowControlPanel re-render contracts", () => {
  const src = read("src/components/WorkflowControlPanel.tsx");

  it("batch selector falls back to a stable EMPTY_BATCH, not a fresh []", () => {
    expect(src).toContain("s.batchOverrides[selectionKey] ?? EMPTY_BATCH");
    expect(src).not.toMatch(/s\.batchOverrides\[selectionKey\] \?\? \[\]/);
  });

  it("editors are memoized and fed stabilized controls + a stable setter", () => {
    expect(src).toContain("const MemoControlEditor = React.memo(ControlEditor);");
    expect(src).toContain("<MemoControlEditor");
    expect(src).not.toContain("<ControlEditor");
    expect(src).toContain("stabilizeEffectiveControls(");
    const setter = src.slice(src.indexOf("const handleSetOverride = useCallback("));
    const deps = setter.slice(0, setter.indexOf("\n  );"));
    expect(deps).toContain("[selectionKey, setOverride, markDependencyDirty]");
  });
});

describe("Gallery contracts", () => {
  const src = read("src/components/Gallery.tsx");

  it("feed filters against a deferred search query", () => {
    expect(src).toContain("useDeferredValue(searchQuery)");
    expect(src).toContain("query: deferredSearchQuery");
  });

  it("run groups are stabilized across recomputes", () => {
    expect(src).toContain("stabilizeRunGroups(");
  });

  it("scroll-parent retry stops once attached (no forever 2s interval)", () => {
    expect(src).not.toContain("window.setInterval(attach, 2000)");
    expect(src).toContain("if (attachedToElement()) window.clearInterval(retry);");
  });
});

describe("timer contracts", () => {
  it("StyleVault training poll is keyed on a boolean, not the jobs array", () => {
    const src = read("src/components/style/library/TrainView.tsx");
    expect(src).toContain("}, [hasActiveJob, loadDetail, loadJobs, selectedJobId]);");
    expect(src).not.toContain("}, [jobs, loadDetail, loadJobs, selectedJobId]);");
  });

  it("SettingsPanel H3 status poll pauses while the tab is hidden", () => {
    const src = read("src/components/SettingsPanel.tsx");
    expect(src).toContain("startVisibleInterval(() => void poll(), 5000)");
  });

  it("Tools search filters against a deferred query", () => {
    const src = read("src/components/tools/ToolsPage.tsx");
    expect(src).toContain("filterHubCards(pool, deferredQuery)");
  });
});
