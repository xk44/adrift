import { describe, it, expect, vi, beforeEach } from "vitest";

const infoMock = vi.fn();
const capsMock = vi.fn();
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: (...a: unknown[]) => infoMock(...a),
}));
vi.mock("@/lib/comfy/capabilities", () => ({
  getComfyCapabilities: (...a: unknown[]) => capsMock(...a),
}));

import {
  applyModelVariantFallback,
  parseModelName,
  pickVariant,
  swapModelVariants,
} from "@/lib/comfy/modelVariants";

const PC_UNETS = [
  "krea2_turbo_fp8_scaled.safetensors",
  "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
  "fibo2_dev_bf16.safetensors",
  "FLUX1/flux1-dev_fp8_scaled.safetensors",
  "wan22_animate_int8.safetensors",
];

const info = (unets: string[], clips: string[] = []) => ({
  UNETLoader: {
    input: { required: { unet_name: [unets], weight_dtype: [["default"]] } },
  },
  CLIPLoader: { input: { required: { clip_name: [clips] } } },
});

describe("parseModelName", () => {
  it("splits stem / precision, keeps folder prefix", () => {
    expect(parseModelName("krea2_turbo_bf16.safetensors")).toEqual({
      stem: "krea2_turbo",
      precision: "bf16",
      ext: "safetensors",
    });
    expect(
      parseModelName("FLUX1\\flux1-dev_fp8_scaled.safetensors")?.stem,
    ).toBe("flux1/flux1-dev");
    expect(
      parseModelName("qwen_image_edit_2509_fp8_e4m3fn.safetensors")?.precision,
    ).toBe("fp8_e4m3fn");
  });
  it("no precision tag / no model extension -> null", () => {
    expect(parseModelName("sd_xl_base_1.0.safetensors")).toBeNull();
    expect(parseModelName("model_bf16.gguf")).toBeNull();
  });
});

describe("pickVariant", () => {
  it("missing bf16 -> installed fp8_scaled sibling", () => {
    expect(pickVariant("krea2_turbo_bf16.safetensors", PC_UNETS)).toBe(
      "krea2_turbo_fp8_scaled.safetensors",
    );
  });
  it("listed file -> no fallback", () => {
    expect(pickVariant("fibo2_dev_bf16.safetensors", PC_UNETS)).toBeNull();
  });
  it("prefers the closest precision (bf16 over fp8)", () => {
    const opts = [
      "x_fp8_e4m3fn.safetensors",
      "x_bf16.safetensors",
      "x_fp8_scaled.safetensors",
    ];
    expect(pickVariant("x_fp16.safetensors", opts)).toBe("x_bf16.safetensors");
    expect(
      pickVariant("x_fp32.safetensors", opts.slice(0, 1).concat(opts[2])),
    ).toBe("x_fp8_scaled.safetensors");
  });
  it("never swaps to int8 / nvfp4 (own loaders), never across stems", () => {
    expect(pickVariant("wan22_animate_bf16.safetensors", PC_UNETS)).toBeNull();
    expect(pickVariant("krea2_raw_bf16.safetensors", PC_UNETS)).toBeNull();
    expect(
      pickVariant("x_bf16.safetensors", ["x_nvfp4.safetensors"]),
    ).toBeNull();
  });
  it("MPS: fp8 siblings skipped", () => {
    expect(
      pickVariant("krea2_turbo_bf16.safetensors", PC_UNETS, { noFp8: true }),
    ).toBeNull();
    expect(
      pickVariant(
        "y_bf16.safetensors",
        ["y_fp8_scaled.safetensors", "y_fp16.safetensors"],
        {
          noFp8: true,
        },
      ),
    ).toBe("y_fp16.safetensors");
  });
  it("folder-prefixed names match within their folder", () => {
    expect(pickVariant("FLUX1/flux1-dev_bf16.safetensors", PC_UNETS)).toBe(
      "FLUX1/flux1-dev_fp8_scaled.safetensors",
    );
    expect(pickVariant("flux1-dev_bf16.safetensors", PC_UNETS)).toBeNull();
  });
});

describe("swapModelVariants", () => {
  const prompt = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "krea2_turbo_bf16.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" },
    },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0] } },
  };
  it("swaps UNET + CLIP, returns a copy, leaves the input alone", () => {
    const before = JSON.stringify(prompt);
    const r = swapModelVariants(
      prompt,
      info(PC_UNETS, ["qwen3vl_4b_bf16.safetensors"]),
    );
    expect(JSON.stringify(prompt)).toBe(before);
    expect(r.prompt).not.toBe(prompt);
    expect(r.prompt["1"].inputs.unet_name).toBe(
      "krea2_turbo_fp8_scaled.safetensors",
    );
    expect(r.prompt["2"].inputs.clip_name).toBe("qwen3vl_4b_bf16.safetensors");
    expect(r.swaps.map((s) => [s.nodeId, s.from, s.to])).toEqual([
      [
        "1",
        "krea2_turbo_bf16.safetensors",
        "krea2_turbo_fp8_scaled.safetensors",
      ],
      ["2", "qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_bf16.safetensors"],
    ]);
  });
  it("nothing to swap -> same object", () => {
    const r = swapModelVariants(
      prompt,
      info(
        ["krea2_turbo_bf16.safetensors"],
        ["qwen3vl_4b_fp8_scaled.safetensors"],
      ),
    );
    expect(r.prompt).toBe(prompt);
    expect(r.swaps).toEqual([]);
  });
});

describe("applyModelVariantFallback", () => {
  beforeEach(() => {
    infoMock.mockReset();
    capsMock.mockReset();
  });
  const prompt = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "krea2_turbo_bf16.safetensors" },
    },
  };

  it("unreachable ComfyUI: untouched", async () => {
    infoMock.mockResolvedValue(null);
    const r = await applyModelVariantFallback(prompt);
    expect(r).toEqual({ prompt, swaps: [] });
    expect(capsMock).not.toHaveBeenCalled();
  });
  it("nothing missing: no capabilities / fresh round-trip", async () => {
    infoMock.mockResolvedValue(info(["krea2_turbo_bf16.safetensors"]));
    const r = await applyModelVariantFallback(prompt);
    expect(r.swaps).toEqual([]);
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(capsMock).not.toHaveBeenCalled();
  });
  it("a file installed seconds ago (fresh list has it) is not swapped", async () => {
    infoMock
      .mockResolvedValueOnce(info(PC_UNETS))
      .mockResolvedValueOnce(
        info([...PC_UNETS, "krea2_turbo_bf16.safetensors"]),
      );
    capsMock.mockResolvedValue({ noFp8: false });
    const r = await applyModelVariantFallback(prompt);
    expect(r.swaps).toEqual([]);
    expect(infoMock.mock.calls[1][1]).toEqual({ fresh: true });
  });
  it("CUDA swaps to fp8; MPS refuses fp8", async () => {
    infoMock.mockResolvedValue(info(PC_UNETS));
    capsMock.mockResolvedValue({ noFp8: false });
    expect((await applyModelVariantFallback(prompt)).swaps[0]?.to).toBe(
      "krea2_turbo_fp8_scaled.safetensors",
    );
    capsMock.mockResolvedValue({ noFp8: true });
    expect((await applyModelVariantFallback(prompt)).swaps).toEqual([]);
  });
});

describe("int8_convrot names (H3 text encoder)", () => {
  const INT8 = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors";
  const BF16 = "qwen3vl_32b_minimax_h3_bf16.safetensors";
  it("parses the int8_convrot tag onto the bf16 sibling's stem", () => {
    expect(parseModelName(INT8)).toEqual({
      stem: "qwen3vl_32b_minimax_h3",
      precision: "int8_convrot",
      ext: "safetensors",
    });
  });
  it("a graph naming int8_convrot falls back to bf16 when only bf16 is installed", () => {
    expect(pickVariant(INT8, [BF16])).toBe(BF16);
  });
  it("a graph naming bf16 never drops to int8_convrot", () => {
    expect(pickVariant(BF16, [INT8])).toBeNull();
  });
});
