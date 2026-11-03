import { describe, expect, it } from "vitest";
import {
  WINDOW_CHUNK_MAX,
  chunkRuns,
  distanceToViewport,
  hashString,
  nextCollapsedKeys,
  sameCollapsed,
  windowOverscan,
} from "@/lib/galleryWindowing";

const ids = (n: number, prefix = "run") =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const id = (s: string) => s;

describe("galleryWindowing", () => {
  it("hashes deterministically", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toBe(0x811c9dc5);
  });

  it("chunks every row exactly once, in order, within the cap", () => {
    const rows = ids(500);
    const chunks = chunkRuns(rows, id);
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(
      WINDOW_CHUNK_MAX,
    );
    // Average chunk size lands near the target, not 1 and not the cap.
    expect(chunks.length).toBeGreaterThan(500 / WINDOW_CHUNK_MAX);
    expect(chunks.length).toBeLessThan(500 / 3);
  });

  it("handles empty and tiny inputs", () => {
    expect(chunkRuns([], id)).toEqual([]);
    expect(chunkRuns(["a"], id)).toEqual([["a"]]);
  });

  it("forces a boundary at max when no hash boundary hits", () => {
    const chunks = chunkRuns(ids(10), id, 1_000_000_007, 4);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
  });

  it("keeps chunk boundaries stable when runs are prepended or appended", () => {
    const rows = ids(300);
    const key = (c: string[]) => c.join(",");
    const base = chunkRuns(rows, id).map(key);
    const prepended = chunkRuns([...ids(5, "new"), ...rows], id).map(key);
    const appended = chunkRuns([...rows, ...ids(40, "older")], id).map(key);
    // All but the chunk touched at each edge survive unchanged.
    const survivors = (next: string[]) =>
      base.filter((k) => next.includes(k)).length;
    expect(survivors(prepended)).toBeGreaterThanOrEqual(base.length - 1);
    expect(survivors(appended)).toBeGreaterThanOrEqual(base.length - 1);
  });

  it("measures distance to the viewport", () => {
    const vp = { top: 0, bottom: 800 };
    expect(distanceToViewport({ top: 100, bottom: 200 }, vp)).toBe(0);
    expect(distanceToViewport({ top: -500, bottom: 10 }, vp)).toBe(0);
    expect(distanceToViewport({ top: -900, bottom: -300 }, vp)).toBe(300);
    expect(distanceToViewport({ top: 1000, bottom: 1400 }, vp)).toBe(200);
  });

  it("sizes overscan from the viewport with a floor", () => {
    expect(windowOverscan(400)).toBe(1200);
    expect(windowOverscan(1000)).toBe(1500);
  });

  describe("nextCollapsedKeys", () => {
    const vp = { top: 0, bottom: 1000 };
    const overscan = 1000;

    it("collapses mounted units only past 2x overscan", () => {
      const next = nextCollapsedKeys(
        [
          { key: "near", rect: { top: 1500, bottom: 1900 }, collapsed: false },
          { key: "mid", rect: { top: 2500, bottom: 2900 }, collapsed: false },
          { key: "far", rect: { top: 3100, bottom: 3500 }, collapsed: false },
          {
            key: "above",
            rect: { top: -4000, bottom: -3000 },
            collapsed: false,
          },
        ],
        vp,
        overscan,
      );
      expect([...next].sort()).toEqual(["above", "far"]);
    });

    it("remounts collapsed units within 1x overscan (hysteresis)", () => {
      const next = nextCollapsedKeys(
        [
          { key: "back", rect: { top: 1800, bottom: 2600 }, collapsed: true },
          { key: "stay", rect: { top: 2500, bottom: 2900 }, collapsed: true },
        ],
        vp,
        overscan,
      );
      expect([...next]).toEqual(["stay"]);
    });

    it("keeps the previous state for unmeasurable units", () => {
      const next = nextCollapsedKeys(
        [
          { key: "a", rect: null, collapsed: true },
          { key: "b", rect: null, collapsed: false },
        ],
        vp,
        overscan,
      );
      expect([...next]).toEqual(["a"]);
    });

    it("never collapses a pinned (focused) unit", () => {
      const next = nextCollapsedKeys(
        [
          {
            key: "focused",
            rect: { top: 9000, bottom: 9500 },
            collapsed: true,
            pinned: true,
          },
        ],
        vp,
        overscan,
      );
      expect(next.size).toBe(0);
    });
  });

  it("compares collapsed maps by keys and heights", () => {
    const a = new Map([
      ["x", 10],
      ["y", 0],
    ]);
    expect(sameCollapsed(a, new Map(a))).toBe(true);
    expect(sameCollapsed(a, new Map([["x", 10]]))).toBe(false);
    expect(
      sameCollapsed(
        a,
        new Map([
          ["x", 11],
          ["y", 0],
        ]),
      ),
    ).toBe(false);
  });
});

describe("Gallery windowing wiring", () => {
  it("renders finished rows through windowed chunks, keeping the append sentinel", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/Gallery.tsx"),
      "utf8",
    );
    expect(src).toContain("chunkRuns(rows, (row) => row.runId)");
    expect(src).toContain("<FeedChunk");
    expect(src).toContain("collapsedHeight={collapsedChunks.get(chunk.key)}");
    // Wall placeholders reuse the tile's own sizing so lines don't re-break.
    expect(src).toContain("style={tileStyle(viewMode, img.width, img.height)}");
    // Focused chunks never collapse (keyboard navigation).
    expect(src).toContain("el.contains(active)");
    expect(src).toContain('<div ref={sentinelRef} className="h-4" />');
    expect(src).not.toContain("function LazyRow(");
  });
});
