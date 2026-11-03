import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { discoverT2ISlots, discoverVideoSlots } from "@/lib/oj/discovery";
import { parseImagineInput } from "@/lib/oj/parser";
import { injectParams, X2_DETAIL_VAE, buildImagineRuns } from "@/lib/oj/engine";
import type { Workflow } from "@/lib/oj/workflow-analysis";

function loadWorkflow(rel: string): Workflow {
  return JSON.parse(
    readFileSync(join(process.cwd(), rel), "utf-8"),
  ) as Workflow;
}

const H3_T2V = "public/workflows/packs/minimax/t2v.json";

describe("--refiner x2_detail (H3 video decode VAE swap)", () => {
  it("swaps only the H3 video VAE, leaving the audio VAE alone", () => {
    const workflow = loadWorkflow(H3_T2V);
    injectParams(
      workflow,
      discoverVideoSlots(workflow),
      { refiner: "x2_detail" },
      "a whale breaching at sunset",
      "",
      42,
    );
    expect(workflow["3"]?.inputs.vae_name).toBe(X2_DETAIL_VAE);
    expect(workflow["4"]?.inputs.vae_name).toBe(
      "minimax_h3_audio_vae_fp32.safetensors",
    );
  });

  it("is a no-op on non-H3 workflows", () => {
    const workflow = loadWorkflow("public/workflows/t2i.json");
    const before = JSON.stringify(
      Object.values(workflow)
        .filter((n) => n.class_type === "VAELoader")
        .map((n) => n.inputs),
    );
    injectParams(
      workflow,
      discoverT2ISlots(workflow),
      { refiner: "x2_detail" },
      "a red fox",
      "",
      42,
    );
    const after = JSON.stringify(
      Object.values(workflow)
        .filter((n) => n.class_type === "VAELoader")
        .map((n) => n.inputs),
    );
    expect(after).toBe(before);
  });

  it("generic --vae override never clobbers the H3 audio VAE", () => {
    const workflow = loadWorkflow(H3_T2V);
    const slots = discoverVideoSlots(workflow);
    // Force the fallback sweep path (no pre-discovered loader target).
    delete (slots as { vaeLoaderId?: string }).vaeLoaderId;
    injectParams(
      workflow,
      slots,
      { vae: "some_custom_vae.safetensors" },
      "a whale",
      "",
      42,
    );
    expect(workflow["3"]?.inputs.vae_name).toBe("some_custom_vae.safetensors");
    expect(workflow["4"]?.inputs.vae_name).toBe(
      "minimax_h3_audio_vae_fp32.safetensors",
    );
  });
});

describe("draft refinerSlot validation", () => {
  const draftRun = (input: string) => {
    const workflow = loadWorkflow("public/workflows/t2i.json");
    const runs = buildImagineRuns(parseImagineInput(input), workflow);
    return runs[0] as unknown as Record<string, unknown>;
  };

  it("passes through registry actions", () => {
    const run = draftRun("a fox --draft --refiner upscale_detail");
    expect(run.refinerSlot).toBe("upscale_detail");
  });

  it("falls back to upscale_subtle for generation-time refiners", () => {
    for (const name of ["x2_detail", "sol_refiner", "not_a_real_action"]) {
      const run = draftRun(`a fox --draft --refiner ${name}`);
      expect(run.refinerSlot, name).toBe("upscale_subtle");
    }
  });
});
