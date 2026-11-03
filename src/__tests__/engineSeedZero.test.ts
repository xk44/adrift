/**
 * engine.ts seed 0 preservation (Fix #5)
 * baseSeed ? ... : undefined dropped seed=0; fix uses baseSeed !== undefined.
 *
 * Run with: npx vitest run src/__tests__/engineSeedZero.test.ts
 */

import { describe, it, expect } from "vitest";
import { buildImagineRuns } from "@/lib/oj/engine";
import type { ParseResult, Workflow } from "@/types";

const MINIMAL_WORKFLOW = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "model.safetensors" },
  },
  "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "" } },
  "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "" } },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "4": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["5", 0],
      seed: 0,
      steps: 20,
      cfg: 7.0,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1.0,
    },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["4", 0] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
} as unknown as Workflow;

function makeParseResult(params: Record<string, unknown> = {}): ParseResult {
  return { prompt: "a cat", params, unknownFlags: [], errors: [] };
}

describe("Fix #5 — --seed 0 is not dropped as falsy", () => {
  it("seed=0 is used as base seed for first job", () => {
    const pr = makeParseResult({ seed: 0 });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 1 });
    expect(runs[0].jobs[0].seed).toBe(0);
  });

  it("seed=0 sequential batch: jobs get 0, 1, 2 ...", () => {
    const pr = makeParseResult({ seed: 0 });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, {
      batchSize: 3,
    });
    // With chaos=0 seeds are sequential from baseSeed
    expect(runs[0].jobs[0].seed).toBe(0);
    expect(runs[0].jobs[1].seed).toBe(1);
    expect(runs[0].jobs[2].seed).toBe(2);
  });

  it("seed=0 with repeat: each repeat offset by batchSize", () => {
    const pr = makeParseResult({ seed: 0, repeat: 2 });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 2 });
    expect(runs).toHaveLength(2);
    // repeat 0: base = 0 + 0*2 = 0
    expect(runs[0].jobs[0].seed).toBe(0);
    // repeat 1: base = 0 + 1*2 = 2
    expect(runs[1].jobs[0].seed).toBe(2);
  });

  it("undefined seed still generates a random seed", () => {
    const pr = makeParseResult({});
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 1 });
    expect(typeof runs[0].jobs[0].seed).toBe("number");
    // Random seed should be a large integer, not necessarily 0
    // (could statistically be 0 but extremely unlikely)
  });

  it("non-zero seed is still preserved normally", () => {
    const pr = makeParseResult({ seed: 42 });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 1 });
    expect(runs[0].jobs[0].seed).toBe(42);
  });
});
