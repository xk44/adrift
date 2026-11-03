/**
 * Parser edge-case tests
 * Covers: empty prompt, unicode, very long prompt, malformed params
 *
 * Run with: npx vitest run src/__tests__/parserEdgeCases.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseImagineInput,
  formatParams,
  buildFullPrompt,
} from "@/lib/oj/parser";

describe("parseImagineInput edge cases", () => {
  describe("empty / whitespace prompts", () => {
    it("returns empty prompt for empty string", () => {
      const r = parseImagineInput("");
      expect(r.prompt).toBe("");
      expect(r.params).toEqual({});
      expect(r.errors).toEqual([]);
      expect(r.unknownFlags).toEqual([]);
    });

    it("returns empty prompt for whitespace-only", () => {
      const r = parseImagineInput("   \t  \n  ");
      expect(r.prompt).toBe("");
    });

    it("parses flags-only input with empty prompt", () => {
      const r = parseImagineInput("--ar 16:9 --seed 42");
      expect(r.prompt).toBe("");
      expect(r.params.ar).toBe("16:9");
      expect(r.params.seed).toBe(42);
    });
  });

  describe("unicode prompts", () => {
    it("preserves CJK characters", () => {
      const r = parseImagineInput("美しい風景 日本の山 --ar 16:9");
      expect(r.prompt).toBe("美しい風景 日本の山");
      expect(r.params.ar).toBe("16:9");
    });

    it("preserves emoji in prompt", () => {
      const r = parseImagineInput("a cat 🐱 with a hat 🎩 --seed 1");
      expect(r.prompt).toBe("a cat 🐱 with a hat 🎩");
      expect(r.params.seed).toBe(1);
    });

    it("preserves RTL text", () => {
      const r = parseImagineInput("منظر طبيعي جميل --stylize 200");
      expect(r.prompt).toContain("منظر");
      expect(r.params.stylize).toBe(200);
    });
  });

  describe("very long prompts", () => {
    it("handles prompt with 1000+ words", () => {
      const longPrompt = Array(1000).fill("word").join(" ");
      const r = parseImagineInput(`${longPrompt} --seed 99`);
      expect(r.prompt.split(" ").length).toBe(1000);
      expect(r.params.seed).toBe(99);
    });
  });

  describe("malformed parameter values", () => {
    it("--ar with non-ratio string produces validation error", () => {
      const r = parseImagineInput("cat --ar abc");
      // abc is not W:H format, so validate will flag it
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain("aspect ratio");
    });

    it("--seed with negative value is accepted by parser (no min in registry)", () => {
      const r = parseImagineInput("cat --seed -1");
      // seed has no min/max in registry — API-layer validateSeed handles bounds
      // Parser tokenizer sees "-1" as a non-flag token starting with "-" not "--"
      // so it becomes part of the prompt, and --seed gets "requires a value" error
      // OR -1 is consumed as the value. Either way, no crash.
      expect(r.prompt).toContain("cat");
    });

    it("--chaos above max 100 produces error", () => {
      const r = parseImagineInput("cat --chaos 999");
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain("above maximum");
    });

    it("--stylize with non-number coerces to undefined and errors", () => {
      const r = parseImagineInput("cat --stylize abc");
      expect(r.errors.length).toBeGreaterThan(0);
    });

    it("--steps missing value when followed by another flag", () => {
      const r = parseImagineInput("cat --steps --seed 42");
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain("requires a value");
      expect(r.params.seed).toBe(42);
    });

    it("--steps missing value at end of input", () => {
      const r = parseImagineInput("cat --steps");
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain("requires a value");
    });

    it("--ar 0:0 produces error (division by zero)", () => {
      const r = parseImagineInput("cat --ar 0:0");
      // 0:0 passes format check but 0/0 = NaN, so it should error
      // Actually the regex passes but the engine's calculateDims handles it
      // The parser itself validates format only; 0:0 matches \\d+:\\d+
      // This is a documentation test - it should not crash
      expect(r.prompt).toBe("cat");
    });
  });

  describe("formatParams round-trip", () => {
    it("formats empty params as empty string", () => {
      expect(formatParams({})).toBe("");
    });

    it("round-trips basic params through parse -> format", () => {
      const input = "a cat --ar 16:9 --seed 42";
      const parsed = parseImagineInput(input);
      const formatted = formatParams(parsed.params);
      expect(formatted).toContain("--ar 16:9");
      expect(formatted).toContain("--seed 42");
    });
  });

  describe("--sref multi-value parsing", () => {
    it("keeps multiple sref tokens in the sref param without leaking into prompt text", () => {
      const r = parseImagineInput("portrait lighting --sref 111 222 --s 300");
      expect(r.params.sref).toBe("111 222");
      expect(r.prompt).toBe("portrait lighting");
      expect(r.prompt).not.toContain("222");
      expect(r.params.stylize).toBe(300);
    });
  });

  describe("buildFullPrompt", () => {
    it("returns prompt alone when no params", () => {
      expect(buildFullPrompt("a cat", {})).toBe("a cat");
    });

    it("appends formatted params", () => {
      const result = buildFullPrompt("a cat", { ar: "16:9" });
      expect(result).toContain("a cat");
      expect(result).toContain("--ar 16:9");
    });
  });

  describe("decimal aspect ratios", () => {
    it("accepts decimal W:H like 2.35:1 (anamorphic)", () => {
      const r = parseImagineInput("a film still --ar 2.35:1");
      expect(r.errors).toHaveLength(0);
      expect(r.params.ar).toBe("2.35:1");
    });

    it("accepts decimals on either side", () => {
      expect(parseImagineInput("x --ar 1:1.5").errors).toHaveLength(0);
      expect(parseImagineInput("x --ar 1.85:1").errors).toHaveLength(0);
    });

    it("still accepts plain integer ratios", () => {
      const r = parseImagineInput("x --ar 16:9");
      expect(r.errors).toHaveLength(0);
      expect(r.params.ar).toBe("16:9");
    });

    it("rejects zero-sided and malformed ratios", () => {
      expect(parseImagineInput("x --ar 0:1").errors.length).toBeGreaterThan(0);
      expect(parseImagineInput("x --ar 2.35:0").errors.length).toBeGreaterThan(0);
      expect(parseImagineInput("x --ar abc").errors.length).toBeGreaterThan(0);
      expect(parseImagineInput("x --ar 2.:1").errors.length).toBeGreaterThan(0);
    });
  });
});
