/**
 * Video batch (`--vb`): N video variants per run, queued as separate jobs
 * (sequential ComfyUI prompts) with distinct seeds. Image batch size never
 * applies to video.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImagineInput } from "@/lib/oj/parser";
import {
  buildImagineRuns,
  extractWorkflowsFromRuns,
  videoBatchCount,
  VIDEO_BATCH_MAX,
} from "@/lib/oj/engine";
import { videoBatchFlag, VIDEO_BATCH_OPTIONS } from "@/lib/oj/videoDefault";
import type { Workflow } from "@/types";

const WF = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m" } },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
} as unknown as Workflow;

describe("--vb parser", () => {
  it("parses --vb and --vbatch as the vb int param", () => {
    expect(parseImagineInput("a cat --video --vb 2").params.vb).toBe(2);
    expect(parseImagineInput("a cat --video --vbatch 4").params.vb).toBe(4);
    expect(parseImagineInput("a cat --video --vb 4").errors).toEqual([]);
  });

  it("rejects values outside 1-4", () => {
    expect(parseImagineInput("a cat --video --vb 5").errors.length).toBe(1);
    expect(parseImagineInput("a cat --video --vb 0").errors.length).toBe(1);
  });

  it("keeps --vb out of the prompt text", () => {
    expect(parseImagineInput("a cat --video --vb 2").prompt).toBe("a cat");
  });
});

describe("videoBatchCount", () => {
  it("defaults to 1 and clamps to 1..VIDEO_BATCH_MAX", () => {
    expect(videoBatchCount(undefined)).toBe(1);
    expect(videoBatchCount("x")).toBe(1);
    expect(videoBatchCount(0)).toBe(1);
    expect(videoBatchCount(2)).toBe(2);
    expect(videoBatchCount(99)).toBe(VIDEO_BATCH_MAX);
  });
});

describe("buildImagineRuns video fan-out", () => {
  it("--video --vb 4 → one run with 4 jobs, distinct seeds", () => {
    const pr = parseImagineInput("a cat --video --vb 4");
    const runs = buildImagineRuns(pr, WF, { batchSize: 1 });
    expect(runs).toHaveLength(1);
    const seeds = runs[0].jobs.map((j) => j.seed);
    expect(seeds).toHaveLength(4);
    expect(new Set(seeds).size).toBe(4);
    expect(runs[0].jobs.map((j) => j.index)).toEqual([0, 1, 2, 3]);
  });

  it("video ignores the image batch size (no --vb → 1 job)", () => {
    const pr = parseImagineInput("a cat --video");
    const runs = buildImagineRuns(pr, WF, { batchSize: 8 });
    expect(runs[0].jobs).toHaveLength(1);
  });

  it("--vb wins over the image batch size for video", () => {
    const pr = parseImagineInput("a cat --video --vb 2");
    const runs = buildImagineRuns(pr, WF, { batchSize: 8 });
    expect(runs[0].jobs).toHaveLength(2);
  });

  it("--vb has no effect on image runs", () => {
    const pr = parseImagineInput("a cat --vb 4");
    const runs = buildImagineRuns(pr, WF, { batchSize: 2 });
    expect(runs[0].jobs).toHaveLength(2);
  });

  it("--seed + --vb gives sequential seeds; --repeat sets do not overlap", () => {
    const pr = parseImagineInput("a cat --video --vb 2 --seed 100 --repeat 2");
    const runs = buildImagineRuns(pr, WF, {});
    expect(runs.map((r) => r.jobs.map((j) => j.seed))).toEqual([
      [100, 101],
      [102, 103],
    ]);
  });

  it("extracts one workflow per variant, each with its own seed", () => {
    const pr = parseImagineInput("a cat --video --vb 2 --seed 7");
    const runs = buildImagineRuns(pr, WF, {});
    const jobs = extractWorkflowsFromRuns(runs, WF);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.seed)).toEqual([7, 8]);
    expect(jobs[0].workflow).not.toBe(jobs[1].workflow);
  });
});

describe("videoBatchFlag (Settings → Variants)", () => {
  it("offers 1/2/4", () => {
    expect([...VIDEO_BATCH_OPTIONS]).toEqual([1, 2, 4]);
  });

  it("emits --vb only for --video prompts with a setting above 1", () => {
    expect(videoBatchFlag("a cat --video", 2)).toBe("--vb 2");
    expect(videoBatchFlag("a cat --VIDEO --ar 16:9", 4)).toBe("--vb 4");
    expect(videoBatchFlag("a cat --video", 1)).toBeUndefined();
    expect(videoBatchFlag("a cat --video", undefined)).toBeUndefined();
    expect(videoBatchFlag("a cat", 4)).toBeUndefined();
    expect(videoBatchFlag("a cat --videos", 4)).toBeUndefined();
  });

  it("a typed --vb / --vbatch wins", () => {
    expect(videoBatchFlag("a cat --video --vb 1", 4)).toBeUndefined();
    expect(videoBatchFlag("a cat --video --vbatch 2", 4)).toBeUndefined();
  });
});

describe("Variants control wiring", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("Video settings card offers Variants bound to settings.videoBatch", () => {
    const panel = src("src/components/SettingsPanel.tsx");
    expect(panel).toContain('<SettingLabel label="Variants" />');
    expect(panel).toContain("options={VIDEO_BATCH_PILLS}");
    expect(panel).toContain("updateSettings({ videoBatch: v })");
  });

  it("submit appends --vb from the setting and the store defaults to 1", () => {
    expect(src("src/hooks/useImagine.ts")).toContain(
      "videoBatchFlag(basePrompt, settings.videoBatch)",
    );
    expect(src("src/store/index.ts")).toContain("videoBatch: 1,");
  });
});
