/**
 * Validate module tests
 * =====================
 * Covers all pure validators in src/lib/validate.ts
 */

import { describe, it, expect } from "vitest";
import {
  validatePrompt,
  validateRequiredString,
  validateNonNegativeInteger,
  validatePlainObject,
  validateBoundedInteger,
  validateBatchSize,
  validateDimensions,
  validateSeed,
  hostMatchesAllowlist,
  isAllowedHttpsFetchUrl,
  isAllowedCivitaiImageUrl,
  validateOptionalString,
  validateEnum,
  validateIdentifier,
  resolveAllowedInpaintImageFetchUrl,
} from "@/lib/validate";

// ── validatePrompt ─────────────────────────────────────────────────

describe("validatePrompt", () => {
  it("accepts a normal prompt", () => {
    const r = validatePrompt("a cat sitting on a chair");
    expect(r).toEqual({ ok: true, text: "a cat sitting on a chair" });
  });

  it("trims whitespace", () => {
    const r = validatePrompt("  hello  ");
    expect(r).toEqual({ ok: true, text: "hello" });
  });

  it("strips control characters", () => {
    const r = validatePrompt("foo\x00bar\x07baz");
    expect(r).toEqual({ ok: true, text: "foobarbaz" });
  });

  it("preserves tabs and newlines", () => {
    const r = validatePrompt("line1\nline2\ttab");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("\n");
  });

  it("rejects empty string", () => {
    expect(validatePrompt("")).toEqual({
      ok: false,
      error: "Prompt cannot be empty",
    });
  });

  it("rejects whitespace-only string", () => {
    expect(validatePrompt("   ")).toEqual({
      ok: false,
      error: "Prompt cannot be empty",
    });
  });

  it("rejects string of only control chars", () => {
    expect(validatePrompt("\x00\x01\x02")).toEqual({
      ok: false,
      error: "Prompt cannot be empty",
    });
  });

  it("rejects prompt exceeding max length", () => {
    const long = "a".repeat(10_001);
    const r = validatePrompt(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("maximum length");
  });

  it("accepts prompt at exactly max length", () => {
    const r = validatePrompt("a".repeat(10_000));
    expect(r.ok).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(validatePrompt(42 as unknown as string).ok).toBe(false);
  });
});

// ── validateRequiredString ──────────────────────────────────────────

describe("validateRequiredString", () => {
  it("accepts valid string", () => {
    expect(validateRequiredString("hello", "name")).toEqual({
      ok: true,
      text: "hello",
    });
  });

  it("rejects undefined", () => {
    expect(validateRequiredString(undefined, "field").ok).toBe(false);
  });

  it("rejects number", () => {
    expect(validateRequiredString(123, "field").ok).toBe(false);
  });

  it("rejects empty after sanitize", () => {
    expect(validateRequiredString("  \x00  ", "field").ok).toBe(false);
  });

  it("rejects over maxChars", () => {
    const r = validateRequiredString("a".repeat(100), "f", 50);
    expect(r.ok).toBe(false);
  });
});

// ── validateNonNegativeInteger ──────────────────────────────────────

describe("validateNonNegativeInteger", () => {
  it("accepts 0", () => expect(validateNonNegativeInteger(0, "n")).toBe(0));
  it("accepts positive int", () =>
    expect(validateNonNegativeInteger(5, "n")).toBe(5));
  it("rejects negative", () =>
    expect(typeof validateNonNegativeInteger(-1, "n")).toBe("string"));
  it("rejects float", () =>
    expect(typeof validateNonNegativeInteger(1.5, "n")).toBe("string"));
  it("rejects string", () =>
    expect(typeof validateNonNegativeInteger("1", "n")).toBe("string"));
});

// ── validatePlainObject ─────────────────────────────────────────────

describe("validatePlainObject", () => {
  it("returns empty object for null/undefined", () => {
    expect(validatePlainObject(null, "x")).toEqual({});
    expect(validatePlainObject(undefined, "x")).toEqual({});
  });
  it("passes through a plain object", () => {
    expect(validatePlainObject({ a: 1 }, "x")).toEqual({ a: 1 });
  });
  it("rejects arrays", () => {
    expect(typeof validatePlainObject([1], "x")).toBe("string");
  });
  it("rejects primitives", () => {
    expect(typeof validatePlainObject("str", "x")).toBe("string");
  });
});

// ── validateBoundedInteger ──────────────────────────────────────────

describe("validateBoundedInteger", () => {
  it("clamps above max", () =>
    expect(validateBoundedInteger(100, 0, 10, 5)).toBe(10));
  it("clamps below min", () =>
    expect(validateBoundedInteger(-5, 0, 10, 5)).toBe(0));
  it("returns value in range", () =>
    expect(validateBoundedInteger(7, 0, 10, 5)).toBe(7));
  it("parses numeric string", () =>
    expect(validateBoundedInteger("3", 0, 10, 5)).toBe(3));
  it("returns fallback for NaN", () =>
    expect(validateBoundedInteger("abc", 0, 10, 5)).toBe(5));
  it("returns fallback for float", () =>
    expect(validateBoundedInteger(1.5, 0, 10, 5)).toBe(5));
});

// ── validateBatchSize ───────────────────────────────────────────────

describe("validateBatchSize", () => {
  it("returns 1 for undefined", () =>
    expect(validateBatchSize(undefined)).toBe(1));
  it("clamps to max 16", () => expect(validateBatchSize(100)).toBe(16));
  it("clamps to min 1", () => expect(validateBatchSize(0)).toBe(1));
  it("rounds float", () => expect(validateBatchSize(3.7)).toBe(4));
  it("parses numeric string", () => expect(validateBatchSize("4")).toBe(4));
  it("returns default for NaN", () => expect(validateBatchSize("x")).toBe(1));
});

// ── validateDimensions ──────────────────────────────────────────────

describe("validateDimensions", () => {
  it("passes valid dimensions", () => {
    expect(validateDimensions(1024, 768)).toEqual({ width: 1024, height: 768 });
  });
  it("rounds to nearest 8", () => {
    expect(validateDimensions(515, 515)).toEqual({ width: 512, height: 512 });
  });
  it("clamps small values to 64", () => {
    expect(validateDimensions(10, 10)).toEqual({ width: 64, height: 64 });
  });
  it("clamps large values to 4096", () => {
    expect(validateDimensions(9999, 9999)).toEqual({
      width: 4096,
      height: 4096,
    });
  });
  it("uses fallback for invalid input", () => {
    expect(validateDimensions("abc", null)).toEqual({
      width: 512,
      height: 512,
    });
  });
});

// ── validateSeed ────────────────────────────────────────────────────

describe("validateSeed", () => {
  it("returns number for valid seed", () => expect(validateSeed(42)).toBe(42));
  it("returns undefined for null", () =>
    expect(validateSeed(null)).toBeUndefined());
  it("returns undefined for negative", () =>
    expect(validateSeed(-1)).toBeUndefined());
  it("returns undefined for float", () =>
    expect(validateSeed(1.5)).toBeUndefined());
  it("parses numeric string", () => expect(validateSeed("123")).toBe(123));
  it("returns undefined for non-numeric string", () =>
    expect(validateSeed("abc")).toBeUndefined());
  it("accepts 0", () => expect(validateSeed(0)).toBe(0));
});

// ── hostMatchesAllowlist ────────────────────────────────────────────

describe("hostMatchesAllowlist", () => {
  it("matches exact host", () => {
    expect(hostMatchesAllowlist("civitai.com", ["civitai.com"])).toBe(true);
  });
  it("matches wildcard subdomain", () => {
    expect(hostMatchesAllowlist("images.civitai.com", ["*.civitai.com"])).toBe(
      true,
    );
  });
  it("wildcard does not match bare domain", () => {
    expect(hostMatchesAllowlist("civitai.com", ["*.civitai.com"])).toBe(false);
  });
  it("rejects non-matching host", () => {
    expect(hostMatchesAllowlist("evil.com", ["civitai.com"])).toBe(false);
  });
  it("case insensitive", () => {
    expect(hostMatchesAllowlist("CIVITAI.COM", ["civitai.com"])).toBe(true);
  });
});

// ── isAllowedHttpsFetchUrl ──────────────────────────────────────────

describe("isAllowedHttpsFetchUrl", () => {
  it("accepts https on allowed host", () => {
    expect(
      isAllowedHttpsFetchUrl("https://civitai.com/img.jpg", ["civitai.com"]),
    ).toBe(true);
  });
  it("rejects http", () => {
    expect(
      isAllowedHttpsFetchUrl("http://civitai.com/img.jpg", ["civitai.com"]),
    ).toBe(false);
  });
  it("rejects non-allowed host", () => {
    expect(isAllowedHttpsFetchUrl("https://evil.com/x", ["civitai.com"])).toBe(
      false,
    );
  });
  it("rejects invalid URL", () => {
    expect(isAllowedHttpsFetchUrl("not a url", ["civitai.com"])).toBe(false);
  });
});

// ── isAllowedCivitaiImageUrl ────────────────────────────────────────

describe("isAllowedCivitaiImageUrl", () => {
  it("accepts civitai.com URL", () => {
    expect(isAllowedCivitaiImageUrl("https://civitai.com/images/123.jpg")).toBe(
      true,
    );
  });
  it("accepts subdomain", () => {
    expect(isAllowedCivitaiImageUrl("https://image.civitai.com/x.jpg")).toBe(
      true,
    );
  });
  it("rejects random URL", () => {
    expect(isAllowedCivitaiImageUrl("https://google.com/x.jpg")).toBe(false);
  });
});

// ── validateOptionalString ──────────────────────────────────────────

describe("validateOptionalString", () => {
  it("returns undefined for null", () =>
    expect(validateOptionalString(null)).toBeUndefined());
  it("returns undefined for empty", () =>
    expect(validateOptionalString("")).toBeUndefined());
  it("trims and returns valid", () =>
    expect(validateOptionalString("  hi  ")).toBe("hi"));
  it("truncates to maxChars", () =>
    expect(validateOptionalString("abcdef", 3)).toBe("abc"));
});

// ── validateEnum ────────────────────────────────────────────────────

describe("validateEnum", () => {
  const allowed = new Set(["a", "b", "c"] as const);
  it("returns value when in set", () =>
    expect(validateEnum("b", allowed, "a")).toBe("b"));
  it("returns fallback when not in set", () =>
    expect(validateEnum("z", allowed, "a")).toBe("a"));
  it("returns fallback for null", () =>
    expect(validateEnum(null, allowed, "a")).toBe("a"));
});

// ── validateIdentifier ──────────────────────────────────────────────

describe("validateIdentifier", () => {
  it("accepts alphanumeric with hyphens", () => {
    expect(validateIdentifier("abc-123_def.v2", "id")).toEqual({
      ok: true,
      text: "abc-123_def.v2",
    });
  });
  it("rejects null", () =>
    expect(validateIdentifier(null, "id").ok).toBe(false));
  it("rejects path traversal", () =>
    expect(validateIdentifier("../etc", "id").ok).toBe(false));
  it("rejects control chars", () =>
    expect(validateIdentifier("a\x00b", "id").ok).toBe(false));
  it("rejects over maxChars", () =>
    expect(validateIdentifier("a".repeat(201), "id").ok).toBe(false));
});

// ── resolveAllowedInpaintImageFetchUrl ──────────────────────────────

describe("resolveAllowedInpaintImageFetchUrl", () => {
  const comfy = "http://127.0.0.1:8188";

  it("allows data: URIs", () => {
    expect(
      resolveAllowedInpaintImageFetchUrl("data:image/png;base64,abc", comfy),
    ).toBe("data:image/png;base64,abc");
  });

  it("allows same-host ComfyUI URLs", () => {
    const url = "http://127.0.0.1:8188/view?filename=test.png";
    expect(resolveAllowedInpaintImageFetchUrl(url, comfy)).toBe(url);
  });

  it("rejects different host", () => {
    expect(
      resolveAllowedInpaintImageFetchUrl("http://evil.com/x.png", comfy),
    ).toBeNull();
  });

  it("rejects relative path without appOrigin", () => {
    expect(
      resolveAllowedInpaintImageFetchUrl("/api/comfy/image", comfy),
    ).toBeNull();
  });

  it("allows /api/comfy/ path with appOrigin", () => {
    const r = resolveAllowedInpaintImageFetchUrl(
      "/api/comfy/image",
      comfy,
      "http://localhost:3000",
    );
    expect(r).toBe("http://localhost:3000/api/comfy/image");
  });

  it("rejects non-comfy relative path even with appOrigin", () => {
    expect(
      resolveAllowedInpaintImageFetchUrl(
        "/etc/passwd",
        comfy,
        "http://localhost:3000",
      ),
    ).toBeNull();
  });
});
