/**
 * MOSS-Image pack: graph recipe, env-gated registration, missing-model state,
 * and moodboard training family selection. Weights are not installed, so
 * nothing here renders.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { TRAINING_MODEL_FAMILIES } from "@/lib/sref/apiClient";

type G = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const load = (): G => {
  const g = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/moss-image/t2i.json"),
      "utf-8",
    ),
  );
  delete g._meta;
  return g;
};
const byClass = (g: G, c: string) =>
  Object.entries(g).filter(([, n]) => n.class_type === c);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("moss-image t2i graph", () => {
  const g = load();

  it("follows the ComfyUI MOSS recipe", () => {
    expect(byClass(g, "UNETLoader")[0][1].inputs.unet_name).toBe("moss_image_sft_bf16.safetensors");
    expect(byClass(g, "CLIPLoader")[0][1].inputs).toMatchObject({
      clip_name: "qwen3.5_9b_bf16.safetensors",
      type: "moss_image",
    });
    expect(byClass(g, "VAELoader")[0][1].inputs.vae_name).toBe("flux2-vae.safetensors");
    expect(byClass(g, "EmptyFlux2LatentImage")).toHaveLength(1);
    expect(byClass(g, "ModelSamplingAuraFlow")[0][1].inputs.shift).toBe(5);
    expect(byClass(g, "SkipLayerGuidanceDiTSimple")[0][1].inputs).toMatchObject({
      single_layers: "22",
      double_layers: "",
    });
    expect(byClass(g, "KSampler")[0][1].inputs).toMatchObject({
      steps: 50,
      cfg: 3,
      sampler_name: "euler",
      scheduler: "sgm_uniform",
    });
  });

  it("chains UNET -> shift -> SLG -> KSampler with no dangling refs", () => {
    const [shiftId, shift] = byClass(g, "ModelSamplingAuraFlow")[0];
    const [slgId, slg] = byClass(g, "SkipLayerGuidanceDiTSimple")[0];
    expect(shift.inputs.model).toEqual([byClass(g, "UNETLoader")[0][0], 0]);
    expect(slg.inputs.model).toEqual([shiftId, 0]);
    expect(byClass(g, "KSampler")[0][1].inputs.model).toEqual([slgId, 0]);
    for (const n of Object.values(g))
      for (const v of Object.values(n.inputs))
        if (Array.isArray(v) && typeof v[0] === "string") expect(g[v[0]]).toBeDefined();
  });

  it("declares the three weights as requirements", () => {
    const files = workflowModelRequirements(g as never).map((r) => r.file).sort();
    expect(files).toEqual([
      "flux2-vae.safetensors",
      "moss_image_sft_bf16.safetensors",
      "qwen3.5_9b_bf16.safetensors",
    ]);
  });
});

describe("moss-image pack registration", () => {
  it("is absent without CJ_MOSS_IMAGE", async () => {
    vi.stubEnv("CJ_MOSS_IMAGE", "");
    vi.resetModules();
    const { getPack } = await import("@/lib/oj/packs");
    expect(getPack("moss-image")).toBeUndefined();
  });

  it("registers when enabled and model-status reports missing weights", async () => {
    vi.stubEnv("CJ_MOSS_IMAGE", "1");
    // Hermetic: an empty ComfyUI root, so a real install that already has the
    // weights cannot hide the "missing" state.
    vi.stubEnv("COMFY_ROOT", fs.mkdtempSync(path.join(os.tmpdir(), "moss-root-")));
    vi.resetModules();
    const { getPack } = await import("@/lib/oj/packs");
    const pack = getPack("moss-image");
    expect(pack?.modelFamily).toBe("moss_image");
    expect(pack?.workflows.t2i).toBe("packs/moss-image/t2i.json");
    const { GET } = await import("@/app/api/tools/model-status/route");
    const body = await (await GET(new NextRequest("http://localhost/api/tools/model-status"))).json();
    expect(body.packs["moss-image"].missing).toContain("diffusion_models/moss_image_sft_bf16.safetensors");
  });
});

describe("training families", () => {
  it("allows krea2 and moss_image", () => {
    expect([...TRAINING_MODEL_FAMILIES]).toEqual(["krea2", "moss_image"]);
  });
});

describe("moss-image sampling multiplier guard (ComfyUI #17119)", () => {
  const dir = path.join(process.cwd(), "public/workflows/packs/moss-image");
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  it.each(packs)("%s: native UNETLoader graphs never use ModelSamplingSD3", (f) => {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    const classes = Object.entries(g)
      .filter(([k]) => k !== "_meta")
      .map(([, n]) => (n as { class_type: string }).class_type);
    if (classes.includes("UNETLoader")) expect(classes).not.toContain("ModelSamplingSD3");
    // the OpenMOSS plugin loader is multiplier 1000, so SD3 is right there
    if (classes.includes("MOSSImageLoader")) expect(classes).not.toContain("ModelSamplingAuraFlow");
  });
});
