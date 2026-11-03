/**
 * Model Store Tests
 * =================
 * Tests for parseLoraString, formatLoraString, mergeLoraWeights,
 * and useModelStore alias/resolve logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  useModelStore,
  parseLoraString,
  formatLoraString,
  mergeLoraWeights,
} from "@/store/modelStore";

// ── parseLoraString ─────────────────────────────────────────────────

describe("parseLoraString", () => {
  it("parses single lora without weight", () => {
    expect(parseLoraString("anime")).toEqual([
      { name: "anime", strength: 1.0 },
    ]);
  });

  it("parses single lora with weight", () => {
    expect(parseLoraString("anime::0.55")).toEqual([
      { name: "anime", strength: 0.55 },
    ]);
  });

  it("parses multiple loras", () => {
    const result = parseLoraString("anime::0.55 90smanga::-0.1 aesthetic::1.2");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: "anime", strength: 0.55 });
    expect(result[1]).toEqual({ name: "90smanga", strength: -0.1 });
    expect(result[2]).toEqual({ name: "aesthetic", strength: 1.2 });
  });

  it("clamps weight to [-2, 2]", () => {
    const result = parseLoraString("x::5.0 y::-10");
    expect(result[0].strength).toBe(2);
    expect(result[1].strength).toBe(-2);
  });

  it("handles empty string", () => {
    expect(parseLoraString("")).toEqual([]);
  });

  it("handles whitespace-only string", () => {
    expect(parseLoraString("   ")).toEqual([]);
  });

  it("ignores invalid weight", () => {
    expect(parseLoraString("lora::abc")).toEqual([]);
  });

  it("handles extra whitespace between parts", () => {
    const result = parseLoraString("  a::0.5   b  ");
    expect(result).toHaveLength(2);
  });
});

// ── formatLoraString ────────────────────────────────────────────────

describe("formatLoraString", () => {
  it("formats lora with default weight (no suffix)", () => {
    expect(formatLoraString([{ name: "anime", strength: 1.0 }])).toBe("anime");
  });

  it("formats lora with custom weight", () => {
    expect(formatLoraString([{ name: "anime", strength: 0.5 }])).toBe(
      "anime::0.5",
    );
  });

  it("formats multiple loras space-separated", () => {
    const result = formatLoraString([
      { name: "a", strength: 1.0 },
      { name: "b", strength: 0.8 },
    ]);
    expect(result).toBe("a b::0.8");
  });

  it("handles empty array", () => {
    expect(formatLoraString([])).toBe("");
  });
});

// ── mergeLoraWeights ────────────────────────────────────────────────

describe("mergeLoraWeights", () => {
  it("appends new loras", () => {
    const result = mergeLoraWeights(
      [{ name: "a", strength: 1.0 }],
      [{ name: "b", strength: 0.5 }],
    );
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe("b");
  });

  it("updates existing lora weight (case-insensitive)", () => {
    const result = mergeLoraWeights(
      [{ name: "Anime", strength: 1.0 }],
      [{ name: "anime", strength: 0.3 }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe(0.3);
  });

  it("preserves order of existing loras", () => {
    const result = mergeLoraWeights(
      [
        { name: "a", strength: 1.0 },
        { name: "b", strength: 1.0 },
      ],
      [{ name: "c", strength: 0.5 }],
    );
    expect(result.map((l) => l.name)).toEqual(["a", "b", "c"]);
  });

  it("handles empty incoming", () => {
    const existing = [{ name: "a", strength: 1.0 }];
    expect(mergeLoraWeights(existing, [])).toEqual(existing);
  });

  it("handles empty existing", () => {
    const incoming = [{ name: "a", strength: 0.5 }];
    expect(mergeLoraWeights([], incoming)).toEqual(incoming);
  });
});

// ── useModelStore alias management ──────────────────────────────────

describe("useModelStore — aliases", () => {
  beforeEach(() => {
    useModelStore.setState({
      aliases: [],
      available: {
        checkpoints: [
          "sd_xl_base_1.0.safetensors",
          "dreamshaper_v8.safetensors",
        ],
        loras: ["detail_slider.safetensors"],
        vaes: ["sdxl_vae.safetensors"],
        controlnet: [],
        upscale_models: [],
        clip: [],
        unet: [],
        ipadapter: [],
        embeddings: [],
        gligen: [],
        hypernetworks: [],
        animatediff_models: [],
        diffusers: [],
        style_models: [],
        video_models: [],
        samplers: [],
        schedulers: [],
        enumOptions: {},
        input_images: [],
        input_videos: [],
        input_audios: [],
        lastFetched: Date.now(),
      },
    });
  });

  it("adds an alias", () => {
    useModelStore.getState().addAlias({
      alias: "sdxl",
      filename: "sd_xl_base_1.0.safetensors",
      type: "checkpoint",
    });
    expect(useModelStore.getState().aliases).toHaveLength(1);
  });

  it("deduplicates aliases by name", () => {
    const a = {
      alias: "sdxl",
      filename: "sd_xl_base_1.0.safetensors",
      type: "checkpoint" as const,
    };
    useModelStore.getState().addAlias(a);
    useModelStore.getState().addAlias(a);
    expect(useModelStore.getState().aliases).toHaveLength(1);
  });

  it("removes an alias", () => {
    useModelStore.getState().addAlias({
      alias: "sdxl",
      filename: "sd_xl_base_1.0.safetensors",
      type: "checkpoint",
    });
    useModelStore.getState().removeAlias("sdxl");
    expect(useModelStore.getState().aliases).toHaveLength(0);
  });

  it("updates alias fields", () => {
    useModelStore.getState().addAlias({
      alias: "sdxl",
      filename: "old.safetensors",
      type: "checkpoint",
    });
    useModelStore
      .getState()
      .updateAlias("sdxl", { filename: "new.safetensors" });
    expect(useModelStore.getState().aliases[0].filename).toBe(
      "new.safetensors",
    );
  });
});

// ── resolveAlias ────────────────────────────────────────────────────

describe("useModelStore — resolveAlias", () => {
  beforeEach(() => {
    useModelStore.setState({
      aliases: [
        {
          alias: "sdxl",
          filename: "sd_xl_base_1.0.safetensors",
          type: "checkpoint",
        },
      ],
      available: {
        checkpoints: [
          "sd_xl_base_1.0.safetensors",
          "dreamshaper_v8.safetensors",
        ],
        loras: ["detail_slider.safetensors"],
        vaes: [],
        controlnet: [],
        upscale_models: [],
        clip: [],
        unet: [],
        ipadapter: [],
        embeddings: [],
        gligen: [],
        hypernetworks: [],
        animatediff_models: [],
        diffusers: [],
        style_models: [],
        video_models: [],
        samplers: [],
        schedulers: [],
        enumOptions: {},
        input_images: [],
        input_videos: [],
        input_audios: [],
        lastFetched: Date.now(),
      },
    });
  });

  it("resolves user alias first", () => {
    expect(useModelStore.getState().resolveAlias("sdxl", "checkpoint")).toBe(
      "sd_xl_base_1.0.safetensors",
    );
  });

  it("resolves case-insensitively for aliases", () => {
    expect(useModelStore.getState().resolveAlias("SDXL", "checkpoint")).toBe(
      "sd_xl_base_1.0.safetensors",
    );
  });

  it("falls back to exact filename match", () => {
    expect(
      useModelStore
        .getState()
        .resolveAlias("dreamshaper_v8.safetensors", "checkpoint"),
    ).toBe("dreamshaper_v8.safetensors");
  });

  it("falls back to partial match", () => {
    expect(
      useModelStore.getState().resolveAlias("dreamshaper", "checkpoint"),
    ).toBe("dreamshaper_v8.safetensors");
  });

  it("returns null for no match", () => {
    expect(
      useModelStore.getState().resolveAlias("nonexistent", "checkpoint"),
    ).toBeNull();
  });

  it("respects type when resolving alias", () => {
    // "sdxl" alias is type checkpoint, should not resolve for lora
    expect(useModelStore.getState().resolveAlias("sdxl", "lora")).toBeNull();
  });
});
