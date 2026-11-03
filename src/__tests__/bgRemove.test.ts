/**
 * bg_remove action: core ComfyUI BiRefNet graph (LoadImage →
 * RemoveBackground → InvertMask → JoinImageWithAlpha → SaveImage) resolves from the
 * registry for every pack and gets the source image injected, with no
 * sampler/prompt slots touched.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { buildActionWorkflow, UTILITY_IMAGE_ACTIONS } from "@/lib/oj/engine";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const graph = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(WORKFLOWS_DIR, "packs/utility/bg_remove.json"),
      "utf-8",
    ),
  );

const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox --ar 3:2",
    parsedPrompt: "a fox",
    width: 1536,
    height: 1024,
    jobs: [{ seed: 7, index: 0, status: "completed", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: { aspectRatio: "3:2" },
  }) as unknown as ImagineRun;

describe("bg_remove registry wiring", () => {
  const actions = registry.actions as Record<string, Record<string, unknown>>;
  const templates = registry.templates as Record<string, { file: string }>;

  it("action requires an image and points at the bg_remove template", () => {
    expect(actions.bg_remove).toMatchObject({
      id: "bg_remove",
      template: "bg_remove",
      requiresImage: true,
    });
    expect(templates.bg_remove.file).toBe("packs/utility/bg_remove.json");
    expect(
      fs.existsSync(path.join(WORKFLOWS_DIR, "packs/utility/bg_remove.json")),
    ).toBe(true);
  });

  it.each([
    [{}],
    [{ checkpointName: "krea2_turbo_bf16.safetensors" }],
    [{ packId: "krea2" }],
  ])("resolves to the core graph regardless of pack (%o)", (hints) => {
    expect(
      resolveWorkflow({ templateOrAction: "bg_remove", ...hints }).workflowPath,
    ).toBe("packs/utility/bg_remove.json");
  });
});

describe("bg_remove graph", () => {
  it("is LoadImage → RemoveBackground → InvertMask → JoinImageWithAlpha → SaveImage", () => {
    const wf = graph();
    const byClass = (c: string) =>
      Object.entries(wf).find(([, n]) => n.class_type === c);
    const [loadId] = byClass("LoadImage")!;
    const [modelId, model] = byClass("LoadBackgroundRemovalModel")!;
    const [maskId, mask] = byClass("RemoveBackground")!;
    const [invertId, invert] = byClass("InvertMask")!;
    const [joinId, join] = byClass("JoinImageWithAlpha")!;
    const [, save] = byClass("SaveImage")!;
    expect(model.inputs.bg_removal_name).toBe("birefnet.safetensors");
    expect(mask.inputs).toMatchObject({
      bg_removal_model: [modelId, 0],
      image: [loadId, 0],
    });
    expect(invert.inputs.mask).toEqual([maskId, 0]);
    expect(join.inputs).toMatchObject({
      image: [loadId, 0],
      // RemoveBackground emits foreground=1; JoinImageWithAlpha applies
      // alpha = 1 - mask, so without the invert the subject goes transparent.
      alpha: [invertId, 0],
    });
    expect(save.inputs.images).toEqual([joinId, 0]);
    // No sampler: nothing for prompt/seed injection to clobber.
    expect(
      Object.values(wf).some((n) => /KSampler|Sampler/.test(n.class_type)),
    ).toBe(false);
  });
});

describe("buildActionWorkflow(bg_remove)", () => {
  it("is registered as a utility action", () => {
    expect(UTILITY_IMAGE_ACTIONS.has("bg_remove")).toBe(true);
  });

  it("injects the source job's output into LoadImage and leaves the rest alone", () => {
    const base = graph();
    const { workflow, slots, seed } = buildActionWorkflow(
      base,
      "bg_remove",
      run([
        "http://127.0.0.1:8188/view?filename=cj_00042_.png&subfolder=adrift&type=output",
      ]),
      0,
    );
    expect(slots.imageInputId).toBe("1");
    expect(workflow["1"].inputs.image).toBe("adrift/cj_00042_.png [output]");
    expect(seed).toBe(7);
    for (const id of ["2", "3", "4", "5", "6"]) {
      expect(workflow[id]).toEqual(base[id]);
    }
    // Caller's base graph is not mutated.
    expect(base["1"].inputs.image).toBe("input.png");
  });

  it("keeps the placeholder when the source has no /view URL yet", () => {
    const { workflow } = buildActionWorkflow(graph(), "bg_remove", run([]), 0);
    expect(workflow["1"].inputs.image).toBe("input.png");
  });

  it("throws on a graph without LoadImage", () => {
    const wf = graph();
    delete wf["1"];
    expect(() => buildActionWorkflow(wf, "bg_remove", run([]), 0)).toThrow(
      /LoadImage/,
    );
  });
});
