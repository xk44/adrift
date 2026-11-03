import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_TRAINING_IMAGES,
  TRAIN_PARAM_LIMITS,
  assessMaterialized,
  trainParamError,
  validateTrainParams,
} from "@/lib/training/limits";

describe("validateTrainParams", () => {
  it("accepts the trainer defaults and omitted params", () => {
    expect(validateTrainParams({})).toBeNull();
    expect(
      validateTrainParams({ steps: 1500, rank: 16, resolution: 1024, lr: 5e-5 }),
    ).toBeNull();
    expect(validateTrainParams({ lr: 1e-4, resolution: 512 })).toBeNull();
    expect(validateTrainParams({ resolution: 2048, steps: 50_000 })).toBeNull();
  });

  it("names the field and the allowed range", () => {
    expect(validateTrainParams({ steps: 99 })).toBe(
      "steps must be 100–50000 (got 99)",
    );
    expect(validateTrainParams({ resolution: 768 + 32 })).toBe(
      "resolution must be 512–2048, multiple of 64 (got 800)",
    );
    expect(validateTrainParams({ rank: 0 })).toBe("rank must be 1–256 (got 0)");
  });

  it("rejects fractional integers, out-of-range lr and NaN", () => {
    expect(trainParamError("steps", 150.5)).toMatch(/^steps must be/);
    expect(trainParamError("lr", 0.1)).toMatch(/^lr must be/);
    expect(trainParamError("lr", 0)).toMatch(/^lr must be/);
    expect(trainParamError("rank", Number.NaN)).toMatch(/^rank must be/);
  });

  it("checks every limit at its bounds", () => {
    for (const [name, l] of Object.entries(TRAIN_PARAM_LIMITS)) {
      const key = name as keyof typeof TRAIN_PARAM_LIMITS;
      expect(trainParamError(key, l.min)).toBeNull();
      expect(trainParamError(key, l.max)).toBeNull();
      expect(trainParamError(key, l.max * 2)).not.toBeNull();
    }
  });
});

describe("assessMaterialized", () => {
  it("fails with zero usable images", () => {
    expect(assessMaterialized(3, 0)).toEqual({
      skipped: 3,
      error: "No moodboard images could be materialized",
    });
  });

  it("fails below the usable minimum", () => {
    const r = assessMaterialized(10, MIN_USABLE_TRAINING_IMAGES - 1);
    expect(r.error).toMatch(/^Only 4 of 10 images could be read; at least 5/);
    expect(r.skipped).toBe(6);
  });

  it("lets a complete board smaller than the minimum through", () => {
    expect(assessMaterialized(2, 2)).toEqual({ skipped: 0 });
  });

  it("warns (without failing) when more than 20% are missing", () => {
    expect(assessMaterialized(10, 7)).toEqual({
      skipped: 3,
      warning:
        "3 of 10 images were skipped (missing or unreadable); training on 7.",
    });
  });

  it("stays quiet at or below a 20% loss", () => {
    expect(assessMaterialized(10, 8)).toEqual({ skipped: 2 });
    expect(assessMaterialized(10, 10)).toEqual({ skipped: 0 });
  });
});
