/**
 * Unit tests for active runs store (src/lib/comfy/runs.ts)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  addActiveRun,
  getActiveRun,
  updateActiveRun,
  deleteActiveRun,
  getAllActiveRuns,
  clearActiveRuns,
} from "@/lib/comfy/runs";
import type { ImagineRun } from "@/types";

function makeRun(id: string, overrides?: Partial<ImagineRun>): ImagineRun {
  return {
    run_id: id,
    prompt: "a cat",
    parsedPrompt: "a cat",
    width: 512,
    height: 512,
    jobs: [],
    createdAt: new Date().toISOString(),
    status: "queued",
    params: {},
    ...overrides,
  } as ImagineRun;
}

beforeEach(() => {
  clearActiveRuns();
});

describe("addActiveRun / getActiveRun", () => {
  it("stores a run and retrieves it by id", () => {
    const run = makeRun("r1");
    addActiveRun(run);
    expect(getActiveRun("r1")).toEqual(run);
  });

  it("returns undefined for unknown id", () => {
    expect(getActiveRun("nope")).toBeUndefined();
  });

  it("stores multiple runs independently", () => {
    addActiveRun(makeRun("a"));
    addActiveRun(makeRun("b"));
    expect(getActiveRun("a")?.run_id).toBe("a");
    expect(getActiveRun("b")?.run_id).toBe("b");
  });
});

describe("updateActiveRun", () => {
  it("overwrites existing run data", () => {
    addActiveRun(makeRun("r2", { status: "queued" }));
    updateActiveRun("r2", makeRun("r2", { status: "done" }));
    expect(getActiveRun("r2")?.status).toBe("done");
  });

  it("inserts run if not already present", () => {
    updateActiveRun("r3", makeRun("r3", { status: "running" }));
    expect(getActiveRun("r3")?.status).toBe("running");
  });
});

describe("deleteActiveRun", () => {
  it("removes the run", () => {
    addActiveRun(makeRun("r4"));
    deleteActiveRun("r4");
    expect(getActiveRun("r4")).toBeUndefined();
  });

  it("is a no-op for unknown id", () => {
    addActiveRun(makeRun("r5"));
    deleteActiveRun("ghost");
    expect(getActiveRun("r5")).toBeDefined();
  });
});

describe("getAllActiveRuns", () => {
  it("returns all stored runs", () => {
    addActiveRun(makeRun("x1"));
    addActiveRun(makeRun("x2"));
    const ids = getAllActiveRuns().map((r) => r.run_id);
    expect(ids).toContain("x1");
    expect(ids).toContain("x2");
    expect(ids).toHaveLength(2);
  });

  it("returns empty array when store is clear", () => {
    expect(getAllActiveRuns()).toHaveLength(0);
  });
});

describe("clearActiveRuns", () => {
  it("removes all runs", () => {
    addActiveRun(makeRun("c1"));
    addActiveRun(makeRun("c2"));
    clearActiveRuns();
    expect(getAllActiveRuns()).toHaveLength(0);
  });
});

describe("FIFO eviction (MAX_ACTIVE_RUNS = 500)", () => {
  it("evicts oldest entries when exceeding cap", () => {
    for (let i = 0; i < 502; i++) {
      addActiveRun(makeRun(`run-${i}`));
    }
    const all = getAllActiveRuns();
    expect(all.length).toBeLessThanOrEqual(500);
    // Oldest two evicted
    expect(getActiveRun("run-0")).toBeUndefined();
    expect(getActiveRun("run-1")).toBeUndefined();
    // Newest preserved
    expect(getActiveRun("run-501")).toBeDefined();
    expect(getActiveRun("run-500")).toBeDefined();
  });

  it("exactly 500 runs does not evict", () => {
    for (let i = 0; i < 500; i++) {
      addActiveRun(makeRun(`r-${i}`));
    }
    expect(getAllActiveRuns()).toHaveLength(500);
    expect(getActiveRun("r-0")).toBeDefined();
  });

  it("501st run evicts oldest", () => {
    for (let i = 0; i < 501; i++) {
      addActiveRun(makeRun(`r-${i}`));
    }
    expect(getActiveRun("r-0")).toBeUndefined();
    expect(getActiveRun("r-1")).toBeDefined();
    expect(getActiveRun("r-500")).toBeDefined();
  });

  it("updateActiveRun also triggers eviction", () => {
    for (let i = 0; i < 500; i++) {
      addActiveRun(makeRun(`r-${i}`));
    }
    updateActiveRun("r-new", makeRun("r-new"));
    expect(getAllActiveRuns().length).toBeLessThanOrEqual(500);
    expect(getActiveRun("r-0")).toBeUndefined();
    expect(getActiveRun("r-new")).toBeDefined();
  });

  it("overwriting existing key does not grow the map", () => {
    for (let i = 0; i < 500; i++) {
      addActiveRun(makeRun(`r-${i}`));
    }
    // Overwrite existing — no eviction needed
    addActiveRun(makeRun("r-0", { prompt: "updated" }));
    expect(getAllActiveRuns()).toHaveLength(500);
    expect(getActiveRun("r-0")?.prompt).toBe("updated");
  });
});
