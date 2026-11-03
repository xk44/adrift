/**
 * Parser bug fixes — apostrophe tokenization + unknown flag value consumption
 * Fix #2: mid-word apostrophes must not open a quoted span
 * Fix #3: unknown flag value tokens must not leak into prompt text
 *
 * Run with: npx vitest run src/__tests__/parserApostropheSeed.test.ts
 */

import { describe, it, expect } from "vitest";
import { parseImagineInput } from "@/lib/oj/parser";

describe("Fix #2 — mid-word apostrophe does not swallow rest of input", () => {
  it("dog's portrait parses prompt and --ar correctly", () => {
    const r = parseImagineInput("dog's portrait --ar 16:9");
    expect(r.prompt).toBe("dog's portrait");
    expect(r.params.ar).toBe("16:9");
    expect(r.errors).toHaveLength(0);
  });

  it("possessive mid-word apostrophe is treated as a literal character", () => {
    const r = parseImagineInput("cat's eye view --seed 42");
    expect(r.prompt).toBe("cat's eye view");
    expect(r.params.seed).toBe(42);
  });

  it("quoted string at token start still works normally", () => {
    const r = parseImagineInput('"a beautiful cat" --ar 1:1');
    expect(r.prompt).toBe("a beautiful cat");
    expect(r.params.ar).toBe("1:1");
  });

  it("does not swallow --seed value after possessive word", () => {
    const r = parseImagineInput("world's best view --seed 99 --stylize 500");
    expect(r.params.seed).toBe(99);
    expect(r.params.stylize).toBe(500);
    expect(r.prompt).toContain("world's");
  });
});

describe("Fix #3 — unknown flag value tokens do not leak into prompt", () => {
  it("single value after unknown flag is consumed, not added to prompt", () => {
    const r = parseImagineInput("cats --foobar 42");
    expect(r.prompt).toBe("cats");
    expect(r.unknownFlags).toContain("--foobar");
  });

  it("multiple value tokens after unknown flag are all consumed", () => {
    const r = parseImagineInput("cats --foobar hello world --ar 1:1");
    expect(r.prompt).toBe("cats");
    expect(r.unknownFlags).toContain("--foobar");
    expect(r.params.ar).toBe("1:1");
  });

  it("unknown flag at end with no value does not error", () => {
    const r = parseImagineInput("cats --baz");
    expect(r.prompt).toBe("cats");
    expect(r.unknownFlags).toContain("--baz");
    expect(r.errors).toHaveLength(0);
  });

  it("unknown flag between known flags consumes only its own values", () => {
    const r = parseImagineInput("mountains --seed 5 --nope orphan --chaos 10");
    expect(r.prompt).toBe("mountains");
    expect(r.params.seed).toBe(5);
    expect(r.params.chaos).toBe(10);
    expect(r.unknownFlags).toContain("--nope");
    // "orphan" must not appear in prompt
    expect(r.prompt).not.toContain("orphan");
  });

  it("known flags following unknown flag still parse correctly", () => {
    const r = parseImagineInput("portrait --unk val1 val2 --stylize 300");
    expect(r.params.stylize).toBe(300);
    expect(r.prompt).toBe("portrait");
  });
});

describe("Fix #5 — --seed 0 is preserved (not treated as falsy)", () => {
  it("seed 0 is passed as base seed", () => {
    const r = parseImagineInput("cats --seed 0");
    expect(r.params.seed).toBe(0);
  });
});

describe("--p / --profile is reported as unsupported", () => {
  it.each(["--p", "--profile", "--P"])("%s lands in unknownFlags", (flag) => {
    const r = parseImagineInput(`a cat ${flag} warm --ar 1:1`);
    expect(r.unknownFlags).toEqual([flag]);
    expect(r.params.profile).toBeUndefined();
    expect(r.params.ar).toBe("1:1");
    expect(r.prompt).toBe("a cat");
  });
});
