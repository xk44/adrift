import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  buildRecipe,
  graphFacts,
  parseRecipe,
  recipeJson,
  RECIPE_KEY,
  scrubText,
} from "@/lib/recipe/recipe";
import { missingModels, reproducePlan, withSeed } from "@/lib/recipe/reproduce";
import { stripPngTextChunks, writePngTextChunk } from "@/lib/recipe/pngText";
import {
  recipeFromPngBytes,
  recipeFromVideoBytes,
} from "@/lib/recipe/fileRecipe";
import { stampRecipe } from "@/lib/recipe/stamp";
import { buildVideoEditRecipe } from "@/lib/recipe/videoEditRecipe";
import { buildRenderArgs } from "@/lib/videoEdit/ffmpegArgs";
import { readPngTextChunks } from "@/lib/pngMeta";
import { buildExtraData } from "@/lib/comfy/pnginfo";

const V = "9.9.9";

const GRAPH = {
  "1": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "flux/flux1-dev.safetensors",
      weight_dtype: "default",
    },
  },
  "2": {
    class_type: "VAELoader",
    inputs: { vae_name: "/home/someone/models/vae/ae.safetensors" },
  },
  "3": {
    class_type: "DualCLIPLoader",
    inputs: {
      clip_name1: "t5xxl.safetensors",
      clip_name2: "clip_l.safetensors",
    },
  },
  "4": {
    class_type: "LoraLoader",
    inputs: {
      lora_name: "style/ink.safetensors",
      strength_model: 0.8,
      strength_clip: 0.5,
      model: ["1", 0],
    },
  },
  "5": {
    class_type: "Power Lora Loader (rgthree)",
    inputs: {
      lora_1: { on: true, lora: "detail.safetensors", strength: 0.4 },
      lora_2: { on: false, lora: "off.safetensors", strength: 1 },
    },
  },
  "6": {
    class_type: "LoadImage",
    inputs: { image: "photo_0123456789abcdef.png" },
  },
  "7": { class_type: "KSampler", inputs: { seed: 42, steps: 20 } },
  "8": { class_type: "RandomNoise", inputs: { noise_seed: 7 } },
};

function makePng(): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([
      len,
      Buffer.from(type, "latin1"),
      data,
      Buffer.alloc(4),
    ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 0, 0, 0]));
  return new Uint8Array(
    Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("buildRecipe", () => {
  const params = {
    fullPrompt:
      "a fox at dusk --ar 16:9 --sref https://cdn.example.com/x.png /Users/someone/ref.png",
    seed: 42,
    ar: "16:9",
    stylize: 250,
    api_key: "sk-123",
    civitaiToken: "tok-zzz",
    comfy_backend: "pc",
    client_id: "c-1",
    image_url: "https://example.com/a.png",
    sref_path: "/home/someone/srefs/1.png",
    ref_image: "data:image/png;base64,AAAA",
    nested: {
      password: "x",
      folder: "C:\\Users\\someone",
      keep: 1,
      host: "box.local",
    },
    note: "see /Volumes/Disk/thing and mail me at someone@example.com",
  };

  it("keeps settings, prompt and seed; strips secrets, hosts, paths and URLs", () => {
    const r = buildRecipe({
      params,
      graph: GRAPH,
      adriftVersion: V,
      now: new Date(0),
    });
    expect(r.schema).toBe("adrift.recipe");
    expect(r.v).toBe(1);
    expect(r.adrift).toBe(V);
    expect(r.tool).toEqual({ kind: "create", id: "imagine" });
    expect(r.seeds).toEqual([42, 7]);
    expect(r.params).toMatchObject({
      ar: "16:9",
      stylize: 250,
      nested: { keep: 1 },
    });
    const json = JSON.stringify(r);
    for (const bad of [
      "sk-123",
      "tok-zzz",
      "comfy_backend",
      "c-1",
      "example.com",
      "/Users/",
      "/home/",
      "/Volumes/",
      "C:\\\\",
      "someone",
      "data:image",
      "box.local",
    ]) {
      expect(json).not.toContain(bad);
    }
    expect(r.prompt).toBe("a fox at dusk --ar 16:9 --sref");
  });

  it("lists models, LoRAs with strengths and inputs by content hash", () => {
    const r = buildRecipe({ params: {}, graph: GRAPH, adriftVersion: V });
    expect(r.models).toEqual([
      { name: "flux/flux1-dev.safetensors", kind: "diffusion_model" },
      { name: "ae.safetensors", kind: "vae" },
      { name: "t5xxl.safetensors", kind: "text_encoder" },
      { name: "clip_l.safetensors", kind: "text_encoder" },
    ]);
    expect(r.loras).toEqual([
      { name: "style/ink.safetensors", strength: 0.8, clipStrength: 0.5 },
      { name: "detail.safetensors", strength: 0.4 },
    ]);
    expect(r.inputs).toEqual([
      { role: "image", sha256: "0123456789abcdef", ext: "png" },
    ]);
  });

  it("reads tool provenance", () => {
    expect(
      buildRecipe({
        params: {
          action: "tool_moss-restyle-depth",
          tool_id: "moss-restyle-depth",
          action_provenance: {
            kind: "tool",
            id: "moss-restyle-depth",
            label: "Restyle",
          },
        },
        adriftVersion: V,
      }).tool,
    ).toEqual({ kind: "tool", id: "moss-restyle-depth", label: "Restyle" });
    expect(
      buildRecipe({
        params: {
          action: "upscale_creative",
          action_provenance: {
            kind: "action",
            id: "upscale_creative",
            via: "upscale",
          },
        },
        adriftVersion: V,
      }).tool,
    ).toEqual({ kind: "action", id: "upscale_creative", via: "upscale" });
    expect(
      buildRecipe({ params: { action: "inpaint" }, adriftVersion: V }).tool
        .kind,
    ).toBe("inpaint");
    expect(
      buildRecipe({
        params: { user_tool_values: {}, tool_id: "mine" },
        adriftVersion: V,
      }).tool,
    ).toEqual({ kind: "user_tool", id: "mine" });
    expect(
      buildRecipe({ params: { video: true }, adriftVersion: V }).tool,
    ).toEqual({ kind: "create", id: "imagine", mode: "video" });
  });

  it("recipeJson is pure ASCII and parses back", () => {
    const r = buildRecipe({
      params: { fullPrompt: "café 猫", seed: 1 },
      adriftVersion: V,
    });
    const json = recipeJson(r);
    expect(/^[\x20-\x7e]*$/.test(json)).toBe(true);
    const back = parseRecipe(json);
    expect(back.ok && back.recipe.prompt).toBe("café 猫");
  });

  it("scrubText leaves ordinary prompts alone", () => {
    expect(scrubText("a cat, 3:2, --seed 5")).toBe("a cat, 3:2, --seed 5");
  });
});

describe("parseRecipe", () => {
  const base = buildRecipe({
    params: { fullPrompt: "x", seed: 3 },
    adriftVersion: V,
  });

  it("accepts current recipes", () => {
    const r = parseRecipe(JSON.stringify(base));
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings).toEqual([]);
    expect(r.ok && r.recipe.seeds).toEqual([3]);
  });

  it("accepts newer versions with a warning and drops unknown fields", () => {
    const r = parseRecipe({
      ...base,
      v: 7,
      futureField: { a: 1 },
      tool: { kind: "hologram", id: "x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings[0]).toMatch(/newer Adrift/);
    expect(r.recipe).not.toHaveProperty("futureField");
    expect(r.recipe.tool.kind).toBe("workflow");
  });

  it("reads the older cj chunk", () => {
    const r = parseRecipe(
      JSON.stringify({
        v: 1,
        params: { fullPrompt: "old", seed: 9, token: "t" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.prompt).toBe("old");
    expect(r.recipe.seeds).toEqual([9]);
    expect(r.recipe.params).not.toHaveProperty("token");
    expect(r.warnings[0]).toMatch(/Older Adrift/);
  });

  it("rejects garbage and bad versions", () => {
    expect(parseRecipe("{nope").ok).toBe(false);
    expect(parseRecipe(42).ok).toBe(false);
    expect(parseRecipe({ hello: 1 }).ok).toBe(false);
    expect(parseRecipe({ ...base, v: 0 }).ok).toBe(false);
    expect(parseRecipe({ ...base, v: "2" }).ok).toBe(false);
  });

  it("re-scrubs foreign recipes", () => {
    const r = parseRecipe({
      ...base,
      params: { apiKey: "k", ok: 1 },
      models: [
        { name: "/home/someone/m.safetensors", kind: "checkpoint", sha: "zz" },
      ],
      workflow: "/home/someone/wf/flow.json",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.params).toEqual({ ok: 1 });
    expect(r.recipe.models).toEqual([
      { name: "m.safetensors", kind: "checkpoint" },
    ]);
    expect(r.recipe.workflow).toBe("flow.json");
  });
});

describe("PNG chunk", () => {
  it("write / read round trip, replace and strip", () => {
    const recipe = buildRecipe({
      params: { fullPrompt: "night city 東京", seed: 5 },
      graph: GRAPH,
      adriftVersion: V,
    });
    let png = writePngTextChunk(makePng(), RECIPE_KEY, recipeJson(recipe));
    png = writePngTextChunk(png, "other", "keep");
    const chunks = readPngTextChunks(png);
    expect(chunks.other).toBe("keep");
    const back = recipeFromPngBytes(png);
    expect(back?.ok).toBe(true);
    if (!back?.ok) return;
    expect(back.recipe).toEqual(
      parseRecipe(recipe).ok &&
        (parseRecipe(recipe) as { recipe: unknown }).recipe,
    );
    expect(back.recipe.prompt).toBe("night city 東京");

    const replaced = writePngTextChunk(
      png,
      RECIPE_KEY,
      recipeJson({ ...recipe, seeds: [6] }),
    );
    expect(
      Object.keys(readPngTextChunks(replaced)).filter((k) => k === RECIPE_KEY),
    ).toHaveLength(1);
    expect(
      recipeFromPngBytes(replaced)?.ok &&
        (recipeFromPngBytes(replaced) as { recipe: { seeds: number[] } }).recipe
          .seeds,
    ).toEqual([6]);

    const stripped = stripPngTextChunks(png, [RECIPE_KEY]);
    expect(readPngTextChunks(stripped)).toEqual({ other: "keep" });
    expect(recipeFromPngBytes(stripped)).toBeNull();
  });

  it("falls back to the legacy cj chunk (what Adrift PNGs already carry)", () => {
    const png = writePngTextChunk(
      makePng(),
      "cj",
      JSON.stringify({ v: 1, params: { fullPrompt: "legacy", seed: 2 } }),
    );
    const r = recipeFromPngBytes(png);
    expect(r?.ok && r.recipe.prompt).toBe("legacy");
  });
});

describe("video comment", () => {
  it("finds the recipe in VHS-style ffmetadata (python json.dumps spacing)", () => {
    const recipe = buildRecipe({
      params: { fullPrompt: "waves {loop}", seed: 11 },
      adriftVersion: V,
    });
    const pyJson = JSON.stringify(recipe)
      .replace(/":/g, '": ')
      .replace(/,"/g, ', "');
    const comment = `{"prompt": {"1": {}}, "adrift_recipe": ${pyJson}, "workflow": {"nodes": []}}`;
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from("....moov....udta©cmt", "latin1"),
        Buffer.from(comment, "utf8"),
        Buffer.from("\0\0junk"),
      ]),
    );
    const r = recipeFromVideoBytes(bytes);
    expect(r?.ok && r.recipe.prompt).toBe("waves {loop}");
    expect(r?.ok && r.recipe.seeds).toEqual([11]);
  });

  it("video editor export carries its recipe; off strips source metadata", () => {
    const pieces = [
      { path: "/abs/clip_0123456789abcdef.mp4", in: 0, out: 2.5, audio: true },
    ];
    const recipe = buildVideoEditRecipe(
      pieces,
      { width: 640, height: 360, fps: 24 },
      V,
    );
    expect(recipe.tool.kind).toBe("video_editor");
    expect(recipe.inputs).toEqual([
      { role: "video", sha256: "0123456789abcdef", ext: "mp4" },
    ]);
    expect(JSON.stringify(recipe)).not.toContain("/abs");
    const on = buildRenderArgs(pieces, "/out.mp4", {
      width: 640,
      height: 360,
      fps: 24,
      withAudio: true,
      comment: recipeJson(recipe),
    });
    const i = on.indexOf("-metadata");
    expect(on[i + 1].startsWith('comment={"schema":"adrift.recipe"')).toBe(
      true,
    );
    expect(on).not.toContain("-map_metadata");
    const off = buildRenderArgs(pieces, "/out.mp4", {
      width: 640,
      height: 360,
      fps: 24,
      withAudio: true,
      stripMetadata: true,
    });
    expect(off.join(" ")).toContain("-map_metadata -1");
    expect(off).not.toContain("-metadata");
  });
});

describe("stampRecipe", () => {
  const graph = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sdxl.safetensors" },
    },
  };

  it("adds adrift_recipe to Adrift jobs when on", () => {
    const extra = buildExtraData({ params: { fullPrompt: "hi", seed: 4 } });
    const { extraData, recipe } = stampRecipe(extra, graph, true);
    const info = extraData?.extra_pnginfo as Record<string, unknown>;
    expect(info.cj).toBeDefined();
    expect(info[RECIPE_KEY]).toBe(recipe);
    expect(recipe?.models).toEqual([
      { name: "sdxl.safetensors", kind: "checkpoint" },
    ]);
  });

  it("strips recipe + cj when off but still returns the recipe for the DB", () => {
    const extra = buildExtraData({
      params: { fullPrompt: "hi" },
      uiWorkflow: { nodes: [], links: [] },
    });
    const { extraData, recipe } = stampRecipe(extra, graph, false);
    expect(recipe).not.toBeNull();
    expect(extraData?.extra_pnginfo).toEqual({
      workflow: { nodes: [], links: [] },
    });
    const bare = stampRecipe(buildExtraData({ params: {} }), graph, false);
    expect(bare.extraData).not.toHaveProperty("extra_pnginfo");
  });

  it("leaves non-Adrift prompts untouched", () => {
    const extra = { preview_method: "none" };
    expect(stampRecipe(extra, graph, true)).toEqual({
      extraData: extra,
      recipe: null,
    });
    expect(stampRecipe(undefined, graph, true).recipe).toBeNull();
  });
});

describe("reproducePlan", () => {
  it("create -> prompt with the seed pinned", () => {
    const r = buildRecipe({
      params: { fullPrompt: "a fox --seed 1 --ar 1:1", seed: 99 },
      graph: GRAPH,
      adriftVersion: V,
    });
    const plan = reproducePlan(r);
    expect(plan).toMatchObject({
      kind: "prompt",
      prompt: "a fox --ar 1:1 --seed 99",
    });
    expect(plan.kind === "prompt" && plan.notes[0]).toMatch(/1 input file/);
    expect(withSeed("x", undefined)).toBe("x");
  });

  it("catalog tool -> its card with options restored", () => {
    const r = buildRecipe({
      params: {
        fullPrompt: "oil painting",
        action: "tool_moss-restyle-depth",
        tool_id: "moss-restyle-depth",
        tool_options: { structure: "loose", depth: "nope" },
        action_provenance: { kind: "tool", id: "moss-restyle-depth" },
        action_source_run_id: "run-1",
        action_source_job_index: 2,
      },
      adriftVersion: V,
    });
    expect(reproducePlan(r)).toEqual({
      kind: "tool",
      toolKey: "catalog:moss-restyle-depth",
      prefill: { picks: { structure: "loose" }, text: "oil painting" },
      sourceRunId: "run-1",
      sourceJobIndex: 2,
      notes: [],
    });
  });

  it("action -> its card (via the card it was queued from)", () => {
    const r = buildRecipe({
      params: {
        action: "upscale_creative",
        action_provenance: {
          kind: "action",
          id: "upscale_creative",
          via: "upscale",
        },
      },
      adriftVersion: V,
    });
    expect(reproducePlan(r)).toMatchObject({
      kind: "tool",
      toolKey: "action:upscale",
      prefill: {},
    });
  });

  it("lightbox-only, inpaint and user tools are reported, not guessed", () => {
    expect(
      reproducePlan(
        buildRecipe({ params: { action: "vary_strong" }, adriftVersion: V }),
      ).kind,
    ).toBe("unsupported");
    expect(
      reproducePlan(
        buildRecipe({ params: { action: "inpaint" }, adriftVersion: V }),
      ).kind,
    ).toBe("unsupported");
    expect(
      reproducePlan(
        buildRecipe({ params: { user_tool_values: {} }, adriftVersion: V }),
      ).kind,
    ).toBe("unsupported");
    expect(
      reproducePlan(buildRecipe({ params: {}, adriftVersion: V })).kind,
    ).toBe("unsupported");
  });

  it("missingModels matches by name, tolerating a moved subfolder", () => {
    const r = buildRecipe({ params: {}, graph: GRAPH, adriftVersion: V });
    expect(
      missingModels(r, {
        models: [
          "other/flux1-dev.safetensors",
          "ae.safetensors",
          "t5xxl.safetensors",
          "clip_l.safetensors",
        ],
        loras: ["style/ink.safetensors"],
      }),
    ).toEqual({ models: [], loras: ["detail.safetensors"] });
  });
});

describe("graphFacts", () => {
  it("ignores non-graphs", () => {
    expect(graphFacts(null)).toEqual({
      models: [],
      loras: [],
      inputs: [],
      seeds: [],
    });
    expect(graphFacts([1, 2])).toEqual({
      models: [],
      loras: [],
      inputs: [],
      seeds: [],
    });
  });
});
