/**
 * XYZ-plot / grid mode: `--grid` expands `{a|b|c}` wildcards combinatorially
 * (cartesian product) into one job per combination, each with its own prompt.
 */
import { describe, it, expect } from "vitest";
import {
  expandDynamicPromptGrid,
  MAX_GRID_CELLS,
} from "@/lib/oj/dynamicPrompts";
import { buildImagineRuns, extractWorkflowsFromRuns } from "@/lib/oj/engine";
import { parseImagineInput } from "@/lib/oj/parser";
import type { Workflow } from "@/types";

describe("expandDynamicPromptGrid", () => {
  it("returns the cartesian product across all groups", () => {
    expect(expandDynamicPromptGrid("{photo|painting} of a {cat|dog}")).toEqual([
      "photo of a cat",
      "photo of a dog",
      "painting of a cat",
      "painting of a dog",
    ]);
  });

  it("returns a single element when there are no braces", () => {
    expect(expandDynamicPromptGrid("a plain prompt")).toEqual([
      "a plain prompt",
    ]);
  });

  it("expands nested groups combinatorially", () => {
    expect(expandDynamicPromptGrid("{big {red|blue}|small}")).toEqual([
      "big red",
      "big blue",
      "small",
    ]);
  });

  it("caps the fan-out at MAX_GRID_CELLS", () => {
    // 5 groups of 4 = 1024 combinations, capped.
    const prompt = "{a|b|c|d} {a|b|c|d} {a|b|c|d} {a|b|c|d} {a|b|c|d}";
    const cells = expandDynamicPromptGrid(prompt);
    expect(cells.length).toBe(MAX_GRID_CELLS);
  });

  it("leaves attention weights and flags untouched inside a cell", () => {
    expect(expandDynamicPromptGrid("(masterpiece:1.3), a {cat|dog}")).toEqual([
      "(masterpiece:1.3), a cat",
      "(masterpiece:1.3), a dog",
    ]);
  });
});

const T2I_WORKFLOW: Workflow = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "x.safetensors" },
  },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["1", 1] },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["1", 1] },
  },
  "4": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "5": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
      seed: 0,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
    },
  },
  "6": {
    class_type: "VAEDecode",
    inputs: { samples: ["5", 0], vae: ["1", 2] },
  },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
};

describe("grid mode end-to-end", () => {
  it("builds one job per combination with a fixed seed and per-cell prompt", () => {
    const parsed = parseImagineInput(
      "{photo|painting} of a {cat|dog} --seed 100 --grid",
    );
    expect(parsed.params.grid).toBe(true);
    const runs = buildImagineRuns(parsed, T2I_WORKFLOW);
    expect(runs).toHaveLength(1);
    const jobs = runs[0].jobs;
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j) => j.promptOverride)).toEqual([
      "photo of a cat",
      "photo of a dog",
      "painting of a cat",
      "painting of a dog",
    ]);
    // seed is held fixed across the grid so only the prompt varies
    expect(new Set(jobs.map((j) => j.seed))).toEqual(new Set([100]));
    expect(jobs.every((j) => j.label === j.promptOverride)).toBe(true);
  });

  it("injects each cell's prompt into its own workflow copy", () => {
    const parsed = parseImagineInput("{cat|dog} portrait --grid");
    const runs = buildImagineRuns(parsed, T2I_WORKFLOW);
    const extracted = extractWorkflowsFromRuns(runs, T2I_WORKFLOW);
    expect(extracted).toHaveLength(2);
    const positives = extracted.map(
      (e) => (e.workflow["2"].inputs as { text: string }).text,
    );
    expect(positives).toEqual(["cat portrait", "dog portrait"]);
  });

  it("falls back to a normal batch when --grid is absent", () => {
    const parsed = parseImagineInput("{cat|dog} portrait");
    const runs = buildImagineRuns(parsed, T2I_WORKFLOW, { batchSize: 4 });
    // no grid flag -> single-batch run (prompt already single-picked upstream,
    // but the engine sees literal braces and does NOT grid-expand them)
    expect(runs[0].jobs.every((j) => j.promptOverride === undefined)).toBe(
      true,
    );
  });
});
