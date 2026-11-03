import { describe, expect, it } from "vitest";
import { fitEditLatentToSource } from "@/lib/oj/engine";
import type { Workflow } from "@/types";

function wf(): Workflow {
  return {
    "5": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
  } as unknown as Workflow;
}

describe("fitEditLatentToSource", () => {
  it("sizes a fixed 1024 edit latent to the source aspect (~1 MP)", () => {
    const w = wf();
    fitEditLatentToSource(w, "5", undefined, { width: 1792, height: 2368 });
    const { width, height } = w["5"].inputs as Record<string, number>;
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    expect(width / height).toBeCloseTo(1792 / 2368, 2);
    expect(Math.abs(width * height - 1024 * 1024)).toBeLessThan(40_000);
  });

  it("leaves an explicit --ar and unknown sizes alone", () => {
    for (const [ar, src] of [
      ["16:9", { width: 1344, height: 768 }],
      [undefined, { width: 0, height: 0 }],
    ] as const) {
      const w = wf();
      fitEditLatentToSource(w, "5", ar, src);
      expect(w["5"].inputs).toMatchObject({ width: 1024, height: 1024 });
    }
  });

  it("ignores linked or missing latent nodes", () => {
    const w = wf();
    (w["5"].inputs as Record<string, unknown>).width = ["9", 0];
    fitEditLatentToSource(w, "5", undefined, { width: 1344, height: 768 });
    expect(w["5"].inputs.height).toBe(1024);
    expect(() =>
      fitEditLatentToSource(w, "77", undefined, { width: 1, height: 1 }),
    ).not.toThrow();
  });
});
