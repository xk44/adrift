import { describe, expect, it } from "vitest";
import { profileFromSystemStats, type BackendProfile } from "@/lib/models/compat";
import {
  applyModelOverrides,
  loaderInputOptions,
  matchModelName,
  modelFamily,
  modelTokens,
  rankOverrideCandidates,
  roleForLoaderInput,
  suggestOverride,
} from "@/lib/userTools/modelOverrides";
import { withOverrideCandidates } from "@/lib/userTools/overrideReport";
import { analyzeWorkflow } from "@/lib/userTools/analyze";
import type { Workflow } from "@/types";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";

const GiB = 1024 ** 3;
const cuda4090 = profileFromSystemStats({
  system: { os: "posix", ram_total: 64 * GiB },
  devices: [
    { type: "cuda", name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", vram_total: 24 * GiB },
  ],
}) as BackendProfile;
const mac = profileFromSystemStats({
  system: { os: "darwin", ram_total: 64 * GiB },
  devices: [{ type: "mps", name: "mps", vram_total: 64 * GiB }],
}) as BackendProfile;

const UNETS = [
  "sdxl/juggernautXL_v9.safetensors",
  "flux1-dev-Q4_K_S.gguf",
  "flux1-dev-Q6_K.gguf",
  "wan2.2_t2v_14B_Q8_0.gguf",
  "flux1-schnell-Q8_0.gguf",
];

const oi = (): Record<string, unknown> => ({
  UnetLoaderGGUF: { input: { required: { unet_name: [UNETS] } } },
  UNETLoader: {
    input: {
      required: {
        unet_name: ["COMBO", { options: ["flux1-dev-fp8.safetensors", "flux1-dev.safetensors"] }],
        weight_dtype: [["default", "fp8_e4m3fn"]],
      },
    },
  },
  LoraLoader: {
    input: {
      required: {
        lora_name: [["styles/ink_wash.safetensors", "other_style.safetensors"]],
        strength_model: ["FLOAT", {}],
      },
    },
  },
  KSampler: { input: { required: { sampler_name: [["euler", "dpmpp_2m"]] } } },
});

describe("model name matching", () => {
  it("strips quant and precision tokens", () => {
    expect(modelTokens("flux1-dev-Q8_0.gguf")).toEqual(["flux1", "dev"]);
    expect(modelTokens("models/flux1-dev-Q4_K_M.gguf")).toEqual(["flux1", "dev"]);
    expect(modelTokens("flux1-dev-fp8_e4m3fn.safetensors")).toEqual(["flux1", "dev"]);
    expect(modelTokens("Wan2.2-T2V-A14B-HighNoise-Q8_0.gguf")).toEqual([
      "wan2", "2", "t2v", "a14b", "highnoise",
    ]);
  });

  it("detects coarse families", () => {
    expect(modelFamily("flux1-dev-Q8_0.gguf")).toBe("flux1");
    expect(modelFamily("FLUX.2-dev.safetensors")).toBe("flux2");
    expect(modelFamily("sdxl/juggernautXL_v9.safetensors")).toBe("sdxl");
    expect(modelFamily("t5xxl_fp16.safetensors")).toBe("t5");
    expect(modelFamily("umt5_xxl_fp8.safetensors")).toBe("umt5");
    expect(modelFamily("v1-5-pruned-emaonly.safetensors")).toBe("sd15");
    expect(modelFamily("wan2.1_t2v_14B.safetensors")).toBe("wan");
    expect(modelFamily("4x-UltraSharp.pth")).toBeNull();
  });

  it("tiers matches", () => {
    expect(matchModelName("loras\\ink_wash.safetensors", "styles/Ink_Wash.safetensors").match).toBe("same_file");
    expect(matchModelName("flux1-dev-Q8_0.gguf", "flux1-dev-Q6_K.gguf").match).toBe("same_model");
    expect(matchModelName("flux1-dev-Q8_0.gguf", "flux1-schnell-Q8_0.gguf").match).toBe("same_family");
    expect(matchModelName("flux1-dev-Q8_0.gguf", "sdxl/juggernautXL_v9.safetensors").match).toBe("other");
  });

  it("maps loader inputs to compat roles", () => {
    expect(roleForLoaderInput("CheckpointLoaderSimple", "ckpt_name", "x.safetensors")).toBe("checkpoint");
    expect(roleForLoaderInput("LoraLoader", "lora_name", "x.safetensors")).toBe("lora");
    expect(roleForLoaderInput("DualCLIPLoader", "clip_name2", "t5.safetensors")).toBe("text_encoder");
    expect(roleForLoaderInput("VAELoader", "vae_name", "ae.safetensors")).toBe("vae");
    expect(roleForLoaderInput("UpscaleModelLoader", "model_name", "4x.pth")).toBe("upscale");
    expect(roleForLoaderInput("UnetLoaderGGUF", "unet_name", "wan2.1_t2v.gguf")).toBe("video");
    expect(roleForLoaderInput("UNETLoader", "unet_name", "flux1-dev.gguf")).toBe("image");
  });
});

describe("rankOverrideCandidates", () => {
  it("puts the same model in another quant first, best quant first", () => {
    const ranked = rankOverrideCandidates("flux1-dev-Q8_0.gguf", UNETS, {
      classType: "UnetLoaderGGUF",
      input: "unet_name",
      profile: cuda4090,
    });
    expect(ranked.map((c) => c.value)).toEqual([
      "flux1-dev-Q6_K.gguf",
      "flux1-dev-Q4_K_S.gguf",
      "flux1-schnell-Q8_0.gguf",
      "wan2.2_t2v_14B_Q8_0.gguf",
      "sdxl/juggernautXL_v9.safetensors",
    ]);
    expect(ranked.slice(3).every((c) => c.match === "other")).toBe(true);
    expect(ranked[0]).toMatchObject({ match: "same_model", quant: "gguf_q6_k", verdict: "unknown" });
    expect(suggestOverride(ranked)).toBe("flux1-dev-Q6_K.gguf");
  });

  it("works without a profile (no verdicts) and skips the missing value itself", () => {
    const ranked = rankOverrideCandidates("flux1-dev-Q6_K.gguf", UNETS, {
      classType: "UnetLoaderGGUF",
      input: "unet_name",
    });
    expect(ranked.find((c) => c.value === "flux1-dev-Q6_K.gguf")).toBeUndefined();
    expect(ranked[0].verdict).toBeUndefined();
    expect(ranked[0].value).toBe("flux1-dev-Q4_K_S.gguf");
  });

  it("sinks formats the backend cannot load and never auto-picks them", () => {
    const opts = ["flux1-dev-fp8.safetensors", "flux1-dev.safetensors"];
    const ranked = rankOverrideCandidates("flux1-dev-Q8_0.gguf", opts, {
      classType: "UNETLoader",
      input: "unet_name",
      profile: mac,
    });
    expect(ranked[0].value).toBe("flux1-dev.safetensors");
    expect(ranked[1]).toMatchObject({ value: "flux1-dev-fp8.safetensors", verdict: "unsupported" });
    expect(
      suggestOverride(rankOverrideCandidates("flux1-dev-Q8_0.gguf", ["flux1-dev-fp8.safetensors"], {
        classType: "UNETLoader",
        input: "unet_name",
        profile: mac,
      })),
    ).toBeNull();
  });

  it("offers but never auto-picks a different model of the same family", () => {
    const ranked = rankOverrideCandidates("flux1-krea-dev-Q8_0.gguf", ["flux1-schnell-Q8_0.gguf"], {
      classType: "UnetLoaderGGUF",
      input: "unet_name",
    });
    expect(ranked[0].match).toBe("same_family");
    expect(suggestOverride(ranked)).toBeNull();
  });

  it("caps the list", () => {
    const many = Array.from({ length: 50 }, (_, i) => `lora_${i}.safetensors`);
    expect(
      rankOverrideCandidates("x.safetensors", many, { classType: "LoraLoader", input: "lora_name", limit: 10 }),
    ).toHaveLength(10);
  });
});

describe("withOverrideCandidates / analyzeWorkflow", () => {
  it("attaches ranked options from the loader's COMBO input", () => {
    const [r] = withOverrideCandidates(
      [{ nodeId: "1", classType: "UnetLoaderGGUF", input: "unet_name", file: "flux1-dev-Q8_0.gguf", searchUrl: "u" }],
      oi() as unknown as ObjectInfoIndex,
      null,
    );
    expect(r.suggested).toBe("flux1-dev-Q6_K.gguf");
    expect(r.optionCount).toBe(5);
    expect(r.family).toBe("flux1");
    expect(r.candidates?.[0].value).toBe("flux1-dev-Q6_K.gguf");
    expect(loaderInputOptions(oi(), "Nope", "x")).toBeNull();
    expect(loaderInputOptions(oi(), "LoraLoader", "strength_model")).toBeNull();
  });

  it("runs inside the import analysis", () => {
    const wf: Workflow = {
      "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux1-dev-Q8_0.gguf" } },
    };
    const a = analyzeWorkflow(
      { workflow: wf, format: "api", sourceFile: "x.json", otherFiles: [] },
      {
        objectInfo: oi() as unknown as ObjectInfoIndex,
        source: { type: "file" },
        profile: cuda4090,
      },
    );
    expect(a.missingModels[0]).toMatchObject({
      file: "flux1-dev-Q8_0.gguf",
      suggested: "flux1-dev-Q6_K.gguf",
    });
  });
});

describe("applyModelOverrides", () => {
  const graph = (): Workflow => ({
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux1-dev-Q8_0.gguf" } },
    "2": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux1-dev-Q8_0.gguf" } },
    "3": { class_type: "LoraLoader", inputs: { lora_name: "ink_wash.safetensors", strength_model: 1 } },
    "4": { class_type: "KSampler", inputs: { sampler_name: "euler" } },
  });

  it("rewrites the node and its twins pinned to the same missing file", () => {
    const g = graph();
    const out = applyModelOverrides(
      g,
      [
        { nodeId: "1", input: "unet_name", value: "flux1-dev-Q6_K.gguf" },
        { nodeId: "3", input: "lora_name", value: "" },
      ],
      oi(),
    );
    expect(out["1"].inputs.unet_name).toBe("flux1-dev-Q6_K.gguf");
    expect(out["2"].inputs.unet_name).toBe("flux1-dev-Q6_K.gguf");
    expect(out["3"].inputs.lora_name).toBe("ink_wash.safetensors");
    expect(g["1"].inputs.unet_name).toBe("flux1-dev-Q8_0.gguf"); // input untouched
  });

  it("rejects values that are not installed options of that input", () => {
    const bad = (o: unknown) => () => applyModelOverrides(graph(), [o], oi());
    expect(bad({ nodeId: "1", input: "unet_name", value: "../../etc/passwd" })).toThrow(/not installed/);
    expect(bad({ nodeId: "1", input: "unet_name", value: "other_style.safetensors" })).toThrow(/not installed/);
    expect(bad({ nodeId: "4", input: "sampler_name", value: "dpmpp_2m" })).toThrow(/no model file input/);
    expect(bad({ nodeId: "9", input: "unet_name", value: "flux1-dev-Q6_K.gguf" })).toThrow(/no model file input/);
    expect(bad({ nodeId: "__proto__", input: "unet_name", value: "flux1-dev-Q6_K.gguf" })).toThrow();
    expect(bad({ nodeId: "1", input: "unet_name", value: 5 })).toThrow(/needs a node/);
    expect(bad("x")).toThrow(/must be an object/);
    expect(() => applyModelOverrides(graph(), "x", oi())).toThrow(/must be a list/);
    expect(() => applyModelOverrides(null, [], oi())).toThrow(/workflow/);
    expect(() =>
      applyModelOverrides(graph(), Array.from({ length: 101 }, () => ({})), oi()),
    ).toThrow(/Too many/);
  });

  it("checks against the live object_info, not a stale analysis", () => {
    const live = oi();
    (live.UnetLoaderGGUF as { input: { required: { unet_name: unknown[] } } }).input.required.unet_name = [[]];
    expect(() =>
      applyModelOverrides(graph(), [{ nodeId: "1", input: "unet_name", value: "flux1-dev-Q6_K.gguf" }], live),
    ).toThrow(/not installed/);
  });
});
