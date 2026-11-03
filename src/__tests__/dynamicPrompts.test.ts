/**
 * Dynamic Prompts / Wildcards Tests
 * ==================================
 * Unit tests for {a|b|c} alternation expansion.
 *
 * Run with: npm test or npx vitest
 */

import { describe, it, expect } from "vitest";
import { expandDynamicPrompt } from "@/lib/oj/dynamicPrompts";

/** Seeded rng helper: always returns the given value, ignoring calls. */
function constantRng(value: number): () => number {
  return () => value;
}

/** Seeded rng helper: cycles through a fixed sequence of values. */
function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("expandDynamicPrompt", () => {
  describe("no-op cases", () => {
    it("returns the prompt unchanged when there are no braces", () => {
      expect(expandDynamicPrompt("a beautiful landscape")).toBe(
        "a beautiful landscape",
      );
    });

    it("returns an empty string unchanged", () => {
      expect(expandDynamicPrompt("")).toBe("");
    });

    it("leaves whitespace-only input unchanged", () => {
      expect(expandDynamicPrompt("   ")).toBe("   ");
    });
  });

  describe("basic alternation", () => {
    it("picks the first option when rng returns 0", () => {
      const result = expandDynamicPrompt("a {red|blue} car", constantRng(0));
      expect(result).toBe("a red car");
    });

    it("picks the last option when rng returns just under 1", () => {
      const result = expandDynamicPrompt(
        "a {red|blue} car",
        constantRng(0.999999),
      );
      expect(result).toBe("a blue car");
    });

    it("picks the middle option for a 3-way alternation", () => {
      const result = expandDynamicPrompt(
        "a {red|green|blue} car",
        constantRng(0.5),
      );
      expect(result).toBe("a green car");
    });

    it("is deterministic for a given seeded rng", () => {
      const rng = () => 0.2;
      const a = expandDynamicPrompt("a {red|blue|green} car", rng);
      const b = expandDynamicPrompt("a {red|blue|green} car", rng);
      expect(a).toBe(b);
    });

    it("always returns one of the listed alternatives across many random draws", () => {
      const options = new Set<string>();
      for (let i = 0; i < 200; i++) {
        options.add(expandDynamicPrompt("a {red|blue|green} car"));
      }
      for (const opt of options) {
        expect(["a red car", "a blue car", "a green car"]).toContain(opt);
      }
    });

    it("handles multiple independent alternation groups in one prompt", () => {
      const result = expandDynamicPrompt(
        "a {red|blue} car in a {city|forest}",
        constantRng(0),
      );
      expect(result).toBe("a red car in a city");
    });

    it("handles a single-option group (no-op alternation)", () => {
      const result = expandDynamicPrompt("a {red} car", constantRng(0));
      expect(result).toBe("a red car");
    });

    it("handles an empty option within a group", () => {
      const result = expandDynamicPrompt("a {red|} car", constantRng(0.9));
      expect(result).toBe("a  car");
    });
  });

  describe("nesting", () => {
    it("expands a nested group inside the chosen top-level alternative", () => {
      const result = expandDynamicPrompt(
        "{big {red|green}|small blue}",
        sequenceRng([0, 0]), // pick "big {red|green}", then "red"
      );
      expect(result).toBe("big red");
    });

    it("expands the nested group with the second inner option", () => {
      const result = expandDynamicPrompt(
        "{big {red|green}|small blue}",
        sequenceRng([0, 0.9]), // pick "big {red|green}", then "green"
      );
      expect(result).toBe("big green");
    });

    it("does not evaluate the nested group when the other branch is chosen", () => {
      // rng would pick index 1 ("small blue") on the first call; since that
      // branch has no nested group, rng should not be consulted again.
      let calls = 0;
      const rng = () => {
        calls++;
        return 0.9;
      };
      const result = expandDynamicPrompt("{big {red|green}|small blue}", rng);
      expect(result).toBe("small blue");
      expect(calls).toBe(1);
    });

    it("supports multiple levels of nesting", () => {
      const result = expandDynamicPrompt(
        "{a {b {c|d}|e}|f}",
        sequenceRng([0, 0, 0]), // "a {b {c|d}|e}" -> "b {c|d}" -> "c"
      );
      expect(result).toBe("a b c");
    });
  });

  describe("interoperability with prompt flags and weighting syntax", () => {
    it("does not touch prompt --flags outside of braces", () => {
      const result = expandDynamicPrompt(
        "a {red|blue} car --ar 16:9 --stylize 250",
        constantRng(0),
      );
      expect(result).toBe("a red car --ar 16:9 --stylize 250");
    });

    it("leaves (weight:1.2) attention syntax untouched", () => {
      const result = expandDynamicPrompt(
        "(masterpiece:1.3), a {red|blue} car, [blurry]",
        constantRng(0),
      );
      expect(result).toBe("(masterpiece:1.3), a red car, [blurry]");
    });

    it("leaves attention syntax fully alone when there are no wildcards at all", () => {
      const prompt = "(masterpiece:1.3), a car, [blurry]";
      expect(expandDynamicPrompt(prompt)).toBe(prompt);
    });
  });

  describe("escaping / literal braces", () => {
    it("treats \\{ and \\} as literal braces, not alternation", () => {
      const result = expandDynamicPrompt("a \\{literal\\} brace");
      expect(result).toBe("a {literal} brace");
    });

    it("treats \\| as a literal pipe inside a group", () => {
      const result = expandDynamicPrompt(
        "a {red\\|orange|blue} car",
        constantRng(0),
      );
      expect(result).toBe("a red|orange car");
    });

    it("un-escapes a literal backslash \\\\", () => {
      expect(expandDynamicPrompt("a \\\\ path")).toBe("a \\ path");
    });
  });

  describe("malformed / unbalanced braces", () => {
    it("leaves an unmatched opening brace as literal text", () => {
      const result = expandDynamicPrompt("a {red car", constantRng(0));
      expect(result).toBe("a {red car");
    });

    it("leaves an unmatched closing brace as literal text", () => {
      const result = expandDynamicPrompt("a red} car", constantRng(0));
      expect(result).toBe("a red} car");
    });

    it("still expands well-formed groups elsewhere in a prompt with an unmatched brace", () => {
      const result = expandDynamicPrompt(
        "a {red|blue} car {oops",
        constantRng(0),
      );
      expect(result).toBe("a red car {oops");
    });
  });

  describe("default rng", () => {
    it("uses Math.random by default and returns a valid expansion", () => {
      const result = expandDynamicPrompt("a {red|blue} car");
      expect(["a red car", "a blue car"]).toContain(result);
    });
  });
});
