/**
 * Krea2 action pack: vary/remix/pan/zoom/upscale resolve to krea2-native
 * templates and buildActionWorkflow produces sane sampling for them.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolveWorkflow } from "@/lib/oj/packs";
import { buildActionWorkflow } from "@/lib/oj/engine";
import type { ImagineRun, Workflow } from "@/types";

const packFile = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  );

const KREA2_ACTIONS: Array<[string, string]> = [
  ["vary_subtle", "packs/krea2/i2i.json"],
  ["vary_strong", "packs/krea2/i2i.json"],
  ["remix_subtle", "packs/krea2/i2i.json"],
  ["remix_strong", "packs/krea2/i2i.json"],
  ["pan_left", "packs/krea2/outpaintv2.json"],
  ["zoom_2x", "packs/krea2/outpaintv2.json"],
  // Faithful = pure model upscale (no diffusion), shared with every pack.
  ["upscale_subtle", "upscale_subtle.json"],
  ["upscale_creative", "packs/krea2/upscale_creative.json"],
];

describe("krea2 pack action resolution", () => {
  it.each(KREA2_ACTIONS)("%s resolves to %s", (action, expected) => {
    const r = resolveWorkflow({
      templateOrAction: action,
      checkpointName: "krea2_turbo_bf16.safetensors",
    });
    expect(r.workflowPath).toBe(expected);
    expect(r.pack?.id).toBe("krea2");
  });

  it("non-krea2 checkpoints keep the generic templates", () => {
    const r = resolveWorkflow({
      templateOrAction: "vary_subtle",
      checkpointName: "sd_xl_base_1.0.safetensors",
    });
    expect(r.workflowPath).not.toContain("krea2");
  });
});

describe("krea2 action workflows are valid + turbo-safe", () => {
  const run: ImagineRun = {
    run_id: "r1",
    prompt: "a fox",
    parsedPrompt: "a fox",
    width: 1024,
    height: 1024,
    jobs: [
      { seed: 7, index: 0, status: "completed", progress: 100, images: [] },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  } as unknown as ImagineRun;

  it("vary_subtle gets registry denoise on the krea2 i2i graph", () => {
    const { workflow, slots } = buildActionWorkflow(
      packFile("packs/krea2/i2i.json"),
      "vary_subtle",
      run,
      0,
    );
    const ks = workflow[slots.ksamplerId].inputs as Record<string, unknown>;
    expect(ks.denoise).toBe(0.25);
    expect(ks.cfg).toBe(1);
    expect(ks.scheduler).toBe("simple");
  });

  it("outpaint keeps full denoise and inpaint encoding", () => {
    const { workflow, slots } = buildActionWorkflow(
      packFile("packs/krea2/outpaint.json"),
      "pan_right",
      run,
      0,
    );
    const ks = workflow[slots.ksamplerId].inputs as Record<string, unknown>;
    expect(ks.denoise).toBe(1);
    expect(
      Object.values(workflow).some(
        (n) => n.class_type === "VAEEncodeForInpaint",
      ),
    ).toBe(true);
  });

  it("creative upscale chains RealESRGAN into a tiled krea2 refine", () => {
    const wf = packFile("packs/krea2/upscale_creative.json");
    const kinds = Object.values(wf).map((n) => n.class_type);
    expect(kinds).toContain("ImageUpscaleWithModel");
    expect(kinds).toContain("UNETLoader");
    expect(kinds).toContain("SplitImageToTileList");
    expect(kinds).toContain("ImageMergeTileList");
    const { workflow, slots } = buildActionWorkflow(
      wf,
      "upscale_creative",
      run,
      0,
    );
    const ks = workflow[slots.ksamplerId].inputs as Record<string, unknown>;
    expect(ks.cfg).toBe(1);
  });
});
