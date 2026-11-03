import { describe, it, expect } from "vitest";
import {
  parseLoraMetadata,
  parseTagFrequency,
  normalizeBaseFamily,
  loraBaseMismatch,
  isSafeLoraFilename,
} from "@/lib/loraMetadata";
import { appendTriggerToPrompt } from "@/components/settings/LoraMetaInfo";

describe("parseLoraMetadata", () => {
  it("extracts triggers, base, dim/alpha, title", () => {
    const m = parseLoraMetadata({
      ss_tag_frequency: JSON.stringify({
        "10_a": { zzstyle: 50, girl: 5 },
        "5_b": { zzstyle: 10, hat: 20 },
      }),
      ss_base_model_version: "sdxl_base_v1-0",
      ss_network_dim: "32",
      ss_network_alpha: "16.0",
      "modelspec.title": "My LoRA",
    });
    expect(m.triggers.map((t) => t.word)).toEqual(["zzstyle", "hat", "girl"]);
    expect(m.triggers[0].count).toBe(60);
    expect(m.baseFamily).toBe("sdxl");
    expect(m.networkDim).toBe(32);
    expect(m.networkAlpha).toBe(16);
    expect(m.title).toBe("My LoRA");
  });

  it("falls back to modelspec.architecture", () => {
    const m = parseLoraMetadata({ "modelspec.architecture": "flux-1-dev/lora" });
    expect(m.baseFamily).toBe("flux");
  });

  it("survives malformed ss_tag_frequency JSON", () => {
    expect(parseTagFrequency("{not json")).toEqual([]);
    expect(parseTagFrequency("[1,2]")).toEqual([]);
    expect(parseTagFrequency('{"d": "oops"}')).toEqual([]);
    expect(parseTagFrequency('{"d": {"a": "x", "b": -1, "c": 3}}')).toEqual([
      { word: "c", count: 3 },
    ]);
    const m = parseLoraMetadata({ ss_tag_frequency: "{bad", ss_network_dim: "abc" });
    expect(m.triggers).toEqual([]);
    expect(m.networkDim).toBeNull();
  });

  it("handles non-object input and keeps HTML as inert text", () => {
    expect(parseLoraMetadata(null).triggers).toEqual([]);
    expect(parseLoraMetadata("x").baseModel).toBeNull();
    const m = parseLoraMetadata({ "modelspec.title": "<img src=x onerror=1>\u0000" });
    expect(m.title).toBe("<img src=x onerror=1>");
  });
});

describe("base mismatch", () => {
  it("normalizes families", () => {
    expect(normalizeBaseFamily("stable-diffusion-xl-v1-base/lora")).toBe("sdxl");
    expect(normalizeBaseFamily("sd_v1")).toBe("sd15");
    expect(normalizeBaseFamily("Qwen-Image")).toBe("qwen-image");
    expect(normalizeBaseFamily("mystery")).toBeNull();
  });
  it("flags only known differing families", () => {
    expect(loraBaseMismatch("sdxl", "flux").mismatch).toBe(true);
    expect(loraBaseMismatch("sdxl_base_v1-0", "sdxl").mismatch).toBe(false);
    expect(loraBaseMismatch("flux", "krea2-edit").mismatch).toBe(true);
    expect(loraBaseMismatch("krea2", "krea2-raw").mismatch).toBe(false);
    expect(loraBaseMismatch(null, "sdxl").mismatch).toBe(false);
    expect(loraBaseMismatch("mystery", "sdxl").mismatch).toBe(false);
    expect(loraBaseMismatch("sdxl", null).mismatch).toBe(false);
  });
});

describe("misc", () => {
  it("rejects unsafe lora filenames", () => {
    expect(isSafeLoraFilename("a/b.safetensors")).toBe(true);
    for (const bad of ["", "../x", "a/../b", "/etc/passwd", "a\\b", "a//b", "x\u0000"]) {
      expect(isSafeLoraFilename(bad)).toBe(false);
    }
  });
  it("appends trigger words with comma separation", () => {
    expect(appendTriggerToPrompt("", "zz")).toBe("zz");
    expect(appendTriggerToPrompt("a cat, ", "zz")).toBe("a cat, zz");
  });
});
