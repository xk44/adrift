import { describe, expect, it } from "vitest";
import {
  STARTER_DESTS,
  buildPlan,
  checkDisk,
  formatPlan,
  parseArgs,
} from "../../scripts/fetch-models.mjs";

const REV = "c".repeat(40);
const row = (set, dest, size = 10) => ({ set, repo: "org/x", path: dest, revision: REV, size, dest });

const LIST = {
  files: [
    row("minimal", "checkpoints/sd_xl_base_1.0.safetensors"),
    row("minimal", "background_removal/birefnet.safetensors"),
    row("full", "checkpoints/stable_audio_3_small_sfx.safetensors"),
    row("full", "text_encoders/t5gemma_b_b_ul2.safetensors"),
    row("minimal", "diffusion_models/big.safetensors", 1000),
    row("full", "loras/other.safetensors"),
  ],
  other: [
    { dest: "upscale_models/RealESRGAN_x4plus.pth", size: 67, license: "BSD-3-Clause", page: "https://example.com" },
    { dest: "upscale_models/other.pth", size: 5, license: "x", page: "https://example.com" },
  ],
  convert: [{ dest: "loras/c.safetensors", repo: "org/c", path: "c", converter: "conv.py" }],
};

describe("fetch-models --set starter", () => {
  it("accepts starter and still rejects unknown sets", () => {
    expect(parseArgs(["--set", "starter"]).set).toBe("starter");
    expect(() => parseArgs(["--set", "huge"])).toThrow(/starter, minimal or full/);
  });

  it("picks exactly the starter files across minimal and full rows", () => {
    const plan = buildPlan(LIST, { set: "starter" });
    expect(plan.items.map((r) => r.dest).sort()).toEqual([...STARTER_DESTS].sort());
    expect(plan.skipped).toBe(2);
    expect(plan.other.map((o) => o.dest)).toEqual(["upscale_models/RealESRGAN_x4plus.pth"]);
    expect(plan.convert).toEqual([]);
  });

  it("points to the larger sets when files are left out", () => {
    const plan = buildPlan(LIST, { set: "starter" });
    const text = formatPlan(plan, checkDisk(plan, null));
    expect(text).toMatch(/Set: starter/);
    expect(text).toMatch(/2 more file\(s\) are in the larger sets/);
  });

  it("leaves the minimal default unchanged", () => {
    const plan = buildPlan(LIST, {});
    expect(plan.set).toBe("minimal");
    expect(plan.items).toHaveLength(3);
    expect(plan.other).toHaveLength(2);
  });
});

describe("fetch-models COMFY_ROOT default", () => {
  it("uses COMFY_ROOT when --comfy is not given", () => {
    expect(parseArgs(["--yes"], { COMFY_ROOT: " /srv/ComfyUI " }).comfy).toBe("/srv/ComfyUI");
  });
  it("lets --comfy override COMFY_ROOT", () => {
    expect(parseArgs(["--comfy", "/c"], { COMFY_ROOT: "/srv/ComfyUI" }).comfy).toBe("/c");
  });
  it("still needs a folder for --yes when neither is set", () => {
    expect(() => parseArgs(["--yes"], {})).toThrow(/needs --comfy/);
    expect(() => parseArgs(["--yes"], { COMFY_ROOT: "  " })).toThrow(/needs --comfy/);
  });
});
