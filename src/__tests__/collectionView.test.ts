import { describe, expect, it } from "vitest";
import {
  collageLayout,
  isCollectionSort,
  normalizeRename,
  scopeCollection,
  sortCollection,
  toTimestamp,
} from "@/lib/collectionView";

describe("collectionView", () => {
  describe("toTimestamp", () => {
    it("parses ms, seconds, numeric strings and ISO dates", () => {
      expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
      expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
      expect(toTimestamp("1700000000000")).toBe(1_700_000_000_000);
      expect(toTimestamp("2024-01-02T00:00:00.000Z")).toBe(
        Date.parse("2024-01-02T00:00:00.000Z"),
      );
    });
    it("returns null for junk", () => {
      expect(toTimestamp(undefined)).toBeNull();
      expect(toTimestamp("")).toBeNull();
      expect(toTimestamp("not a date")).toBeNull();
      expect(toTimestamp(Number.NaN)).toBeNull();
    });
  });

  describe("sortCollection", () => {
    const items = [
      { id: "a", name: "board 10", createdAt: "2024-01-02T00:00:00Z" },
      { id: "b", name: "Board 2", createdAt: 1_710_000_000_000 },
      { id: "c", name: "apple" },
      { id: "d", name: "zebra", updatedAt: 1_600_000_000 },
      { id: "e", name: "Apple" },
    ];

    it("latest puts newest first and undated items last in input order", () => {
      expect(sortCollection(items, "latest").map((i) => i.id)).toEqual([
        "b",
        "a",
        "d",
        "c",
        "e",
      ]);
    });

    it("oldest is the exact reverse of latest", () => {
      expect(sortCollection(items, "oldest").map((i) => i.id)).toEqual([
        "e",
        "c",
        "d",
        "a",
        "b",
      ]);
    });

    it("name is natural, case-insensitive and stable", () => {
      expect(sortCollection(items, "name").map((i) => i.id)).toEqual([
        "c",
        "e",
        "b",
        "a",
        "d",
      ]);
    });

    it("does not mutate the input", () => {
      const copy = [...items];
      sortCollection(items, "name");
      expect(items).toEqual(copy);
    });
  });

  it("scopeCollection filters to the selection", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(scopeCollection(items, "all", new Set(["b"]))).toHaveLength(3);
    expect(
      scopeCollection(items, "selected", new Set(["b", "c"])).map((i) => i.id),
    ).toEqual(["b", "c"]);
    expect(scopeCollection(items, "selected", new Set())).toEqual([]);
  });

  it("isCollectionSort guards values", () => {
    expect(isCollectionSort("latest")).toBe(true);
    expect(isCollectionSort("name")).toBe(true);
    expect(isCollectionSort("newest")).toBe(false);
    expect(isCollectionSort(undefined)).toBe(false);
  });

  describe("collageLayout", () => {
    const urls = ["1", "2", "3", "4", "5", "6", "7"];
    it("handles empty and blank urls", () => {
      expect(collageLayout([]).cells).toEqual([]);
      expect(collageLayout(["", null, undefined, "  "]).cells).toEqual([]);
    });
    it("fills without holes for small counts", () => {
      expect(collageLayout(urls.slice(0, 1))).toMatchObject({
        cols: 1,
        rows: 1,
      });
      expect(collageLayout(urls.slice(0, 2))).toMatchObject({
        cols: 2,
        rows: 1,
      });
      const three = collageLayout(urls.slice(0, 3));
      expect(three).toMatchObject({ cols: 2, rows: 2 });
      expect(three.cells[0]).toMatchObject({ url: "1", rowSpan: 2 });
      expect(three.cells).toHaveLength(3);
    });
    it("caps at 2x2 by default and 3x2 when asked", () => {
      const four = collageLayout(urls);
      expect(four).toMatchObject({ cols: 2, rows: 2 });
      expect(four.cells.map((c) => c.url)).toEqual(["1", "2", "3", "4"]);
      const five = collageLayout(urls.slice(0, 5), 6);
      expect(five).toMatchObject({ cols: 2, rows: 2 });
      expect(five.cells).toHaveLength(4);
      const six = collageLayout(urls, 6);
      expect(six).toMatchObject({ cols: 3, rows: 2 });
      expect(six.cells).toHaveLength(6);
    });
  });

  describe("normalizeRename", () => {
    it("returns the trimmed, collapsed name", () => {
      expect(normalizeRename("  New   name ", "Old")).toBe("New name");
    });
    it("returns null for blank, unchanged or too-long drafts", () => {
      expect(normalizeRename("   ", "Old")).toBeNull();
      expect(normalizeRename(" Old ", "Old")).toBeNull();
      expect(normalizeRename("x".repeat(101), "Old")).toBeNull();
      expect(normalizeRename("x".repeat(100), "Old")).toBe("x".repeat(100));
    });
  });
});
