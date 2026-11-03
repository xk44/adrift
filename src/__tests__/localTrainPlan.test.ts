import { describe, expect, it } from "vitest";
import {
  buildTrainPlan,
  PlanError,
  type PlanInput,
} from "@/lib/training/local/plan";

const base: PlanInput = {
  backend: "musubi-tuner",
  family: "krea2",
  repoPath: "/opt/musubi-tuner",
  pythonBin: "/opt/musubi-tuner/.venv/bin/python",
  jobDir: "/data/training/jobs/local-0123456789ab",
  datasetDir: "/data/moodboards/b1/train/v1",
  runName: "mystyle_v1",
  params: { triggerWord: "mystyle", steps: 1200, rank: 32 },
  models: {
    dit: "/models/krea2_raw.safetensors",
    textEncoder: "/models/qwen3vl_4b_bf16.safetensors",
    vae: "/models/qwen_image_vae.safetensors",
  },
};

describe("buildTrainPlan: musubi-tuner krea2", () => {
  it("linux: cache latents, cache TE, accelerate train (fp8 + block swap)", () => {
    const plan = buildTrainPlan({ ...base, platform: "linux" });
    expect(plan.cwd).toBe("/opt/musubi-tuner");
    expect(plan.outputDir).toBe(
      "/data/training/jobs/local-0123456789ab/output",
    );
    expect(plan.commands).toMatchSnapshot();
    expect(plan.files).toMatchSnapshot();
  });

  it("darwin: mps caches, no fp8/block swap, mixed_precision no", () => {
    const plan = buildTrainPlan({ ...base, platform: "darwin" });
    const train = plan.commands.at(-1)!.argv;
    expect(train).not.toContain("--fp8_base");
    expect(train).not.toContain("--blocks_to_swap");
    expect(plan.commands[0]!.argv).toEqual(
      expect.arrayContaining(["--device", "mps"]),
    );
    expect(plan.commands).toMatchSnapshot();
  });

  it("every argv is an array of strings (no shell strings)", () => {
    for (const c of buildTrainPlan(base).commands) {
      expect(Array.isArray(c.argv)).toBe(true);
      for (const a of c.argv) expect(typeof a).toBe("string");
    }
  });

  it("caps block swap at 26", () => {
    const plan = buildTrainPlan({
      ...base,
      platform: "linux",
      params: { ...base.params, blocksToSwap: 40 },
    });
    const argv = plan.commands.at(-1)!.argv;
    expect(argv[argv.indexOf("--blocks_to_swap") + 1]).toBe("26");
  });

  it("throws PlanError when the DiT is missing", () => {
    expect(() =>
      buildTrainPlan({ ...base, models: { ...base.models, dit: undefined } }),
    ).toThrow(PlanError);
  });
});

describe("buildTrainPlan: ai-toolkit krea2 (untested route)", () => {
  it("writes one yaml and runs run.py", () => {
    const plan = buildTrainPlan({
      ...base,
      backend: "ai-toolkit",
      repoPath: "/opt/ai-toolkit",
      pythonBin: "/opt/ai-toolkit/.venv/bin/python",
      models: { model: "/models/krea2_turbo.safetensors" },
      platform: "linux",
    });
    expect(plan.commands).toMatchSnapshot();
    expect(plan.files).toMatchSnapshot();
  });
});
