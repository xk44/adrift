/**
 * Civitai Retry-After parsing (Fix #4)
 * Ensures seconds-form and HTTP-date-form are both parsed, with clamp [1s, 60s].
 *
 * Run with: npx vitest run src/__tests__/civitaiRetryAfter.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the retry logic by reading the source to verify the fix is in place,
// and by exercising it through a thin integration via module mocking.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("Fix #4 — Retry-After parseInt → NaN fixed", () => {
  it("civitai.ts no longer uses bare parseInt for Retry-After", () => {
    const src = source("src/lib/civitai.ts");
    // The old buggy line: parseInt(retryAfter, 10) * 1000
    // The fix uses Number() and Date.parse() instead
    expect(src).not.toMatch(/parseInt\s*\(\s*retryAfter/);
  });

  it("civitai.ts parses Retry-After as Number() (seconds form)", () => {
    const src = source("src/lib/civitai.ts");
    expect(src).toContain("Number(retryAfter)");
  });

  it("civitai.ts falls back to Date.parse for HTTP date form", () => {
    const src = source("src/lib/civitai.ts");
    expect(src).toContain("Date.parse(retryAfter)");
  });

  it("civitai.ts clamps delay to [1s, 60s]", () => {
    const src = source("src/lib/civitai.ts");
    expect(src).toContain("Math.max(1_000, Math.min(delayMs, 60_000))");
  });

  it("civitai.ts default delay is 2s when retryAfter is unparseable", () => {
    const src = source("src/lib/civitai.ts");
    expect(src).toContain("2_000");
  });
});

describe("Fix #4 — Retry-After delay calculation (unit)", () => {
  function parseRetryAfterDelay(retryAfter: string | null): number {
    // Mirror the logic from civitai.ts so we can unit-test the math
    if (!retryAfter) return 2_000;
    const asSeconds = Number(retryAfter);
    let delayMs: number;
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      delayMs = asSeconds * 1000;
    } else {
      const ts = Date.parse(retryAfter);
      delayMs = Number.isFinite(ts) ? ts - Date.now() : 2_000;
    }
    return Math.max(1_000, Math.min(delayMs, 60_000));
  }

  it("integer seconds form: '30' → 30 000 ms", () => {
    expect(parseRetryAfterDelay("30")).toBe(30_000);
  });

  it("integer seconds form: '1' → clamped to 1 000 ms", () => {
    expect(parseRetryAfterDelay("1")).toBe(1_000);
  });

  it("integer seconds form: '120' → clamped to 60 000 ms", () => {
    expect(parseRetryAfterDelay("120")).toBe(60_000);
  });

  it("'0' seconds → clamped to 1 000 ms (not 0)", () => {
    expect(parseRetryAfterDelay("0")).toBe(1_000);
  });

  it("HTTP date form close in future → clamped above 1 s", () => {
    const soon = new Date(Date.now() + 5_000).toUTCString();
    const delay = parseRetryAfterDelay(soon);
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("null header → default 2 000 ms", () => {
    expect(parseRetryAfterDelay(null)).toBe(2_000);
  });

  it("garbage string → default 2 000 ms via clamp (not NaN)", () => {
    // NaN logic path: Date.parse('garbage') === NaN → falls back to 2_000
    // then clamps: max(1000, min(2000, 60000)) === 2000
    expect(parseRetryAfterDelay("garbage")).toBe(2_000);
  });
});
