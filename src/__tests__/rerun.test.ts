import { describe, it, expect } from "vitest";
import { stripFlags, applyOverrides, buildRerunPrompts } from "@/lib/oj/rerun";

describe("stripFlags", () => {
  it("removes a flag and its single value", () => {
    expect(stripFlags("a cat --seed 42 in a hat", ["--seed"])).toBe(
      "a cat in a hat",
    );
  });

  it("removes a flag with a multi-token W:H value", () => {
    expect(stripFlags("sunset --ar 16:9 --s 250", ["--ar"])).toBe(
      "sunset --s 250",
    );
  });

  it("is case-insensitive on the flag", () => {
    expect(stripFlags("x --SEED 7", ["--seed"])).toBe("x");
  });

  it("removes all aliases passed", () => {
    expect(stripFlags("x --s 100 --stylize 200 y", ["--s", "--stylize"])).toBe(
      "x y",
    );
  });

  it("leaves prompt untouched when flag absent", () => {
    expect(stripFlags("just a prompt", ["--seed"])).toBe("just a prompt");
  });
});

describe("applyOverrides", () => {
  it("appends canonical flags for numeric overrides", () => {
    expect(applyOverrides("a fox", { stylize: 500, chaos: 20 })).toBe(
      "a fox --s 500 --chaos 20",
    );
  });

  it("replaces an existing stylize (either alias) rather than duplicating", () => {
    expect(applyOverrides("a fox --stylize 100", { stylize: 750 })).toBe(
      "a fox --s 750",
    );
    expect(applyOverrides("a fox --s 100", { stylize: 750 })).toBe(
      "a fox --s 750",
    );
  });

  it("leaves flags untouched when override is null/undefined", () => {
    expect(applyOverrides("a fox --s 100 --chaos 5", { weird: 250 })).toBe(
      "a fox --s 100 --chaos 5 --weird 250",
    );
  });

  it("replaces aspect ratio", () => {
    expect(applyOverrides("a fox --ar 1:1", { aspect: "16:9" })).toBe(
      "a fox --ar 16:9",
    );
  });

  it("rounds fractional numeric values", () => {
    expect(applyOverrides("x", { stylize: 249.7 })).toBe("x --s 250");
  });

  it("ignores empty aspect strings", () => {
    expect(applyOverrides("a fox", { aspect: "  " })).toBe("a fox");
  });
});

describe("buildRerunPrompts", () => {
  it("always strips the original seed", () => {
    expect(buildRerunPrompts("a cat --seed 999")).toEqual(["a cat"]);
  });

  it("emits `count` identical variants when no seed given", () => {
    expect(buildRerunPrompts("a cat", { stylize: 250, count: 3 })).toEqual([
      "a cat --s 250",
      "a cat --s 250",
      "a cat --s 250",
    ]);
  });

  it("increments the seed per variant when a base seed is given", () => {
    expect(buildRerunPrompts("a cat", { seed: 100, count: 3 })).toEqual([
      "a cat --seed 100",
      "a cat --seed 101",
      "a cat --seed 102",
    ]);
  });

  it("combines param overrides with per-variant seeds", () => {
    expect(
      buildRerunPrompts("a cat --seed 1 --s 100", {
        stylize: 750,
        seed: 50,
        count: 2,
      }),
    ).toEqual(["a cat --s 750 --seed 50", "a cat --s 750 --seed 51"]);
  });

  it("clamps count to at least 1 and at most 25", () => {
    expect(buildRerunPrompts("x", { count: 0 })).toHaveLength(1);
    expect(buildRerunPrompts("x", { count: 999 })).toHaveLength(25);
  });

  it("defaults to a single variant", () => {
    expect(buildRerunPrompts("a plain prompt")).toHaveLength(1);
  });
});
