import { describe, expect, it } from "vitest";
import { CIVITAI_MODEL_TYPES } from "@/lib/civitaiFilters";
import {
  civitaiTypeRule,
  diskNameFor,
  isCivitaiDest,
  planCivitaiFile,
} from "@/lib/civitaiFolders";

describe("civitai type -> folder map", () => {
  it("covers every Civitai type with a folder or a browse-only reason", () => {
    for (const type of CIVITAI_MODEL_TYPES) {
      const rule = civitaiTypeRule(type);
      expect(Boolean(rule.dest) !== Boolean(rule.browseOnly)).toBe(true);
    }
  });

  it.each([
    ["Checkpoint", "m.safetensors", "checkpoints"],
    ["Checkpoint", "m-Q8_0.gguf", "diffusion_models"],
    ["LORA", "x.safetensors", "loras"],
    ["LoCon", "x.safetensors", "loras"],
    ["DoRA", "x.safetensors", "loras"],
    ["TextualInversion", "neg.pt", "embeddings"],
    ["Hypernetwork", "h.pt", "hypernetworks"],
    ["MotionModule", "mm_sd15_v3.ckpt", "animatediff_models"],
    ["UNet", "u.safetensors", "diffusion_models"],
    ["TextEncoder", "t5.safetensors", "text_encoders"],
    ["CLIP", "clip_l.safetensors", "text_encoders"],
    ["CLIPVision", "cv.safetensors", "clip_vision"],
    ["Detection", "face_yolov8m.pt", "ultralytics/bbox"],
    ["Detection", "person_yolov8m-seg.pt", "ultralytics/segm"],
    ["Poses", "pose.png", "poses"],
    ["Wildcards", "colors.txt", "wildcards"],
    ["Workflows", "flow.json", "workflows"],
    ["ComfyWorkflows", "flow.json", "workflows"],
    ["Upscaler", "4x-UltraSharp.pth", "upscale_models"],
    ["Controlnet", "cn.safetensors", "controlnet"],
    ["VAE", "v.safetensors", "vae"],
  ])("%s %s -> %s", (type, name, dest) => {
    const plan = planCivitaiFile(type, { name, type: "Model" });
    expect(plan).toMatchObject({ ok: true, dest });
  });

  it("sends a bundled VAE file to vae and refuses non-model files", () => {
    expect(
      planCivitaiFile("Checkpoint", { name: "v.safetensors", type: "VAE" }),
    ).toMatchObject({ ok: true, dest: "vae" });
    for (const type of ["Config", "Training Data", "Archive"]) {
      expect(planCivitaiFile("LORA", { name: "x.zip", type })).toMatchObject({
        ok: false,
      });
    }
  });

  it("routes companion LoRA and diffusion-model files on a checkpoint page by file type", () => {
    expect(
      planCivitaiFile("Checkpoint", { name: "e.safetensors", type: "Enhancement LoRA" }),
    ).toMatchObject({ ok: true, dest: "loras" });
    expect(
      planCivitaiFile("Checkpoint", { name: "d.safetensors", type: "Diffusion Model" }),
    ).toMatchObject({ ok: true, dest: "diffusion_models" });
    expect(
      planCivitaiFile("Checkpoint", { name: "m.safetensors", type: "Model" }),
    ).toMatchObject({ ok: true, dest: "checkpoints" });
  });

  it("refuses wrong extensions and zips with a plain reason", () => {
    expect(
      planCivitaiFile("Wildcards", { name: "pack.zip", type: "Model" }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/unzip/) });
    expect(
      planCivitaiFile("LORA", { name: "evil.exe", type: "Model" }),
    ).toMatchObject({ ok: false });
  });

  it("marks pickle formats", () => {
    expect(planCivitaiFile("LORA", { name: "a.pt" })).toMatchObject({
      ok: true,
      pickle: true,
    });
    expect(planCivitaiFile("LORA", { name: "a.safetensors" })).toMatchObject({
      ok: true,
      pickle: false,
    });
  });

  it("browse-only types and unknown types explain why", () => {
    for (const t of [
      "AestheticGradient",
      "VisionLanguage",
      "LLM",
      "Other",
      "Brand New",
      undefined,
    ]) {
      const plan = planCivitaiFile(t, { name: "x.safetensors" });
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason.length).toBeGreaterThan(10);
    }
  });

  it("normalises wildcard names to Adrift's wildcard rule", () => {
    expect(diskNameFor("wildcards", "My Colors (v2).txt")).toBe("my-colors-v2.txt");
    expect(diskNameFor("loras", "Keep Case.safetensors")).toBe(
      "Keep Case.safetensors",
    );
  });

  it("isCivitaiDest guards the allowlist", () => {
    expect(isCivitaiDest("latent_upscale_models")).toBe(true);
    expect(isCivitaiDest("../etc")).toBe(false);
    expect(isCivitaiDest("custom_nodes")).toBe(false);
  });
});
