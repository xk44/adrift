/**
 * Prompt Weighting Passthrough Tests
 * ===================================
 * ComfyUI's CLIPTextEncode natively understands attention-weighting syntax
 * like `(word:1.3)` and `[word]`. This suite is a regression guard proving
 * the CJ prompt pipeline (prompt-flag parsing -> dynamic-prompt expansion ->
 * workflow node injection) never strips, escapes, or otherwise mangles
 * that syntax. We do NOT reimplement weighting math here — ComfyUI does
 * that; we only assert the raw text survives untouched end-to-end.
 *
 * Run with: npx vitest run src/__tests__/promptWeightingPreservation.test.ts
 */

import { describe, it, expect } from "vitest";
import type { Workflow } from "@/types";
import { parseImagineInput } from "@/lib/oj/parser";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { injectParams, setNodeInput } from "@/lib/oj/engine";
import { expandDynamicPrompt } from "@/lib/oj/dynamicPrompts";

const WEIGHTED_PROMPT = "(masterpiece:1.3), a cat, [blurry]";

function node(class_type: string, inputs?: Record<string, unknown>) {
  return { class_type, inputs: inputs ?? {} };
}

/** Minimal t2i workflow with distinct positive/negative CLIPTextEncode nodes. */
function buildMinimalWorkflow(): Workflow {
  return {
    "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
    "2": node("KSampler", {
      seed: 0,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["1", 0],
      positive: ["5", 0],
      negative: ["6", 0],
      latent_image: ["3", 0],
    }),
    "5": node("CLIPTextEncode", { text: "", clip: ["1", 1] }),
    "6": node("CLIPTextEncode", { text: "", clip: ["1", 1] }),
    "3": node("EmptyLatentImage", { width: 512, height: 512, batch_size: 1 }),
  };
}

describe("prompt weighting passthrough", () => {
  it("parseImagineInput preserves (weight:1.2) / [bracket] syntax verbatim in .prompt", () => {
    const result = parseImagineInput(WEIGHTED_PROMPT);
    expect(result.prompt).toBe(WEIGHTED_PROMPT);
    expect(result.errors).toHaveLength(0);
  });

  it("parseImagineInput preserves weighting syntax when prompt flags are mixed in", () => {
    const input = `${WEIGHTED_PROMPT} --ar 16:9 --stylize 250`;
    const result = parseImagineInput(input);
    expect(result.prompt).toBe(WEIGHTED_PROMPT);
    expect(result.params.ar).toBe("16:9");
    expect(result.params.stylize).toBe(250);
  });

  it("expandDynamicPrompt is a no-op on weighting syntax (no braces present)", () => {
    expect(expandDynamicPrompt(WEIGHTED_PROMPT)).toBe(WEIGHTED_PROMPT);
  });

  it("full round trip: raw input -> parseImagineInput -> injectParams -> CLIPTextEncode text is byte-for-byte unchanged", () => {
    const rawInput = `${WEIGHTED_PROMPT} --ar 16:9`;
    const parsed = parseImagineInput(rawInput);
    expect(parsed.prompt).toBe(WEIGHTED_PROMPT);

    const workflow = buildMinimalWorkflow();
    const slots = discoverT2ISlots(workflow);
    expect(slots.posTextId).toBeDefined();
    expect(slots.negTextId).toBeDefined();

    injectParams(workflow, slots, parsed.params, parsed.prompt, "", 12345);

    const posNode = workflow[slots.posTextId as string];
    expect(posNode.inputs.text).toBe(WEIGHTED_PROMPT);
  });

  it("setNodeInput writes the weighted text through untouched (no regex/escape applied)", () => {
    const workflow = buildMinimalWorkflow();
    setNodeInput(workflow, "5", "text", WEIGHTED_PROMPT);
    expect(workflow["5"].inputs.text).toBe(WEIGHTED_PROMPT);
  });

  it("survives JSON.stringify/parse round trip unchanged (transport safety)", () => {
    const workflow = buildMinimalWorkflow();
    setNodeInput(workflow, "5", "text", WEIGHTED_PROMPT);
    const roundTripped = JSON.parse(JSON.stringify(workflow)) as Workflow;
    expect(roundTripped["5"].inputs.text).toBe(WEIGHTED_PROMPT);
  });
});
