import { describe, expect, it } from "vitest";
import { challengesDoneToday, plural, remainingPairs } from "@/lib/taskCards";

describe("taskCards", () => {
  it("remainingPairs counts unvoted distinct pairs", () => {
    expect(remainingPairs([], [])).toBe(0);
    expect(remainingPairs(["a"], [])).toBe(0);
    expect(remainingPairs(["a", "b", "c"], [])).toBe(3);
    expect(
      remainingPairs(
        ["a", "b", "c"],
        [
          { imageA: "a", imageB: "b" },
          // same pair reversed: not double-counted
          { imageA: "b", imageB: "a" },
          // stale image no longer in the gallery
          { imageA: "a", imageB: "zzz" },
          // self-pair is ignored
          { imageA: "c", imageB: "c" },
        ],
      ),
    ).toBe(2);
    expect(
      remainingPairs(
        ["a", "b"],
        [
          { imageA: "a", imageB: "b" },
          { imageA: "a", imageB: "b" },
        ],
      ),
    ).toBe(0);
  });

  it("remainingPairs dedupes repeated gallery ids", () => {
    expect(remainingPairs(["a", "a", "b"], [])).toBe(1);
  });

  it("challengesDoneToday only counts today's seed", () => {
    const done = new Set(["abc-0", "abc-2", "old-1"]);
    expect(challengesDoneToday("abc", done)).toBe(2);
    expect(challengesDoneToday("new", done)).toBe(0);
  });

  it("plural formats counts", () => {
    expect(plural(1, "pair")).toBe("1 pair");
    expect(plural(0, "pair")).toBe("0 pairs");
    expect(plural(2, "day")).toBe("2 days");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});
