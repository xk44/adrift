/**
 * --sv engine selector + the Ostris image style-reference (--sv2)
 * graph wiring. Loads the SHIPPED sref_image.json so the asset itself is
 * validated alongside the injection logic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { injectParams, resolveSvEngine } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import type { Workflow } from "@/types";

const SREF_IMAGE_PATH = path.join(
  process.cwd(),
  "public/workflows/packs/krea2-edit/sref_image.json",
);

const loadSrefImage = (): Workflow =>
  JSON.parse(readFileSync(SREF_IMAGE_PATH, "utf-8")) as Workflow;

const nodeInput = (wf: Workflow, id: string, name: string) =>
  (wf[id].inputs as Record<string, unknown>)[name];

const inject = (wf: Workflow, params: Record<string, unknown>) => {
  const slots = discoverT2ISlots(wf);
  injectParams(wf, slots, params, "a serene mountain lake", "", 42);
  return slots;
};

describe("resolveSvEngine", () => {
  it("selects the Ostris image engine (2)", () => {
    for (const v of [2, "2", "ostris", "OSTRIS", "image", " 2 "]) {
      expect(resolveSvEngine(v)).toBe(2);
    }
  });

  it("defaults to engine 1 unless the image engine is named", () => {
    for (const v of [undefined, null, 1, "1", ""]) {
      expect(resolveSvEngine(v)).toBe(1);
    }
  });
});

describe("sref_image.json asset", () => {
  it("is a turbo bf16 + style-reference LoRA + Ostris reference-latent graph", () => {
    const wf = loadSrefImage();
    // MPS-safe bf16 turbo base (never fp8 on Apple Silicon)
    expect(nodeInput(wf, "1", "unet_name")).toBe(
      "krea2_turbo_bf16.safetensors",
    );
    // style-reference LoRA present on the primary loader
    expect(nodeInput(wf, "2", "lora_name")).toBe(
      "krea2_style_reference.safetensors",
    );
    // the Ostris nodes this graph depends on
    const classes = Object.values(wf).map((n) => n.class_type);
    expect(classes).toContain("Krea2OstrisEditModelPatch");
    expect(classes).toContain("TextEncodeKrea2OstrisEdit");
    // turbo sampler discipline: cfg 1
    expect(nodeInput(wf, "11", "cfg")).toBe(1);
  });
});

describe("--sv2 injection", () => {
  it("injects the prompt into the Ostris text encoder", () => {
    const wf = loadSrefImage();
    inject(wf, { sv: 2 });
    expect(nodeInput(wf, "8", "prompt")).toBe("a serene mountain lake");
  });

  it("drives the style-reference LoRA strength from --sw (0-1000 -> 0-2)", () => {
    const wf = loadSrefImage();
    inject(wf, { sv: 2, sw: 150 });
    expect(nodeInput(wf, "2", "strength_model")).toBe(1.5);
  });

  it("protects the style LoRA from --lora; extra --lora rides the stack slot (30)", () => {
    const wf = loadSrefImage();
    inject(wf, { sv: 2, lora: "my_extra_lora.safetensors::0.8" });
    // style reference untouched
    expect(nodeInput(wf, "2", "lora_name")).toBe(
      "krea2_style_reference.safetensors",
    );
    // extra lora landed on the dedicated stack loader
    expect(nodeInput(wf, "30", "lora_name")).toBe("my_extra_lora.safetensors");
    expect(nodeInput(wf, "30", "strength_model")).toBe(0.8);
  });
});
