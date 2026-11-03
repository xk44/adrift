import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import registry from "@/lib/tools/editToolRegistry.json";
import editLoraRegistry from "@/lib/krea2/editLoraRegistry.json";
import {
  ANYPAINT_EXPAND_OPTION,
  MASK_PREPS,
  STATIC_WORKFLOWS,
  anyPaintExpandSpec,
  ToolRequestError,
  allToolLoraFiles,
  buildToolWorkflow,
  fitLatentDims,
  formatComfyRef,
  getEditTool,
  getEditTools,
  getKeepFramingLora,
  insertLoraChain,
  parseComfyRef,
  renderToolPrompt,
  resolveToolLoras,
  resolveToolOptions,
  stripNonNodes,
  toPublicTool,
  toolGraphFamily,
  toolLicense,
  toolNeedsLatentFit,
  toolFixedLatent,
  toolCameraAngleInputs,
  toolWorkflowPath,
} from "@/lib/tools/editTools";
import type { Workflow } from "@/types";
import {
  OutpaintError,
  anyPaintAspectOk,
  planAnyPaint,
  planKrea2Outpaint,
  planLetterbox,
  planOutpaint,
  type AnyPaintPlacement,
  type Krea2OutpaintPlacement,
} from "@/lib/tools/outpaint";

const WF_DIR = path.join(process.cwd(), "public", "workflows");
const LORA_DIR = path.join(
  process.env.COMFY_ROOT || path.join(os.homedir(), "Projects", "ComfyUI"),
  "models",
  "loras",
);
/** Tools that run on the base model alone (no LoRA in their chain). */
const LORA_FREE_TOOLS = new Set(["qwen21-remove-bg"]);

function loadWf(rel: string): Workflow {
  return stripNonNodes(JSON.parse(fs.readFileSync(path.join(WF_DIR, rel), "utf8")));
}
const tool = (id: string) => {
  const t = getEditTool(id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe("registry integrity", () => {
  it("has the required tools with unique ids", () => {
    const ids = getEditTools().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        "flux3-camera",
        "flux3-outpaint",
        "flux3-restore",
        "krea2-anypaint",
        "krea2-body-swap",
        "krea2-general-edit",
        "krea2-head-swap",
        "krea2-inpaint",
        "krea2-layout-regions",
        "krea2-outpaint",
        "krea2-restyle-depth",
        "moss-charref",
        "moss-colorize",
        "moss-restyle-depth",
        "qwen21-anything2real",
        "qwen21-body-swap",
        "qwen21-camera",
        "qwen21-character-sheet",
        "qwen21-doodle",
        "qwen21-head-swap",
        "qwen21-next-scene",
        "qwen21-outfit-swap",
        "qwen21-outpaint",
        "qwen21-pano360",
        "qwen21-realism",
        "qwen21-remove-bg",
        "qwen21-remove-box",
        "qwen21-restore",
        "qwen21-unblur-background",
        "qwen2511-camera",
        "qwen2511-remove",
        "qwen2511-unblur-upscale",
      ].sort(),
    );
  });

  it("every tool points at an existing workflow file", () => {
    for (const t of getEditTools()) {
      const rel = toolWorkflowPath(t, undefined);
      expect(fs.existsSync(path.join(WF_DIR, rel)), `${t.id}: ${rel}`).toBe(true);
    }
  });

  it("static workflow map matches the pack registry when packs are enabled", async () => {
    const prev = { q: process.env.CJ_QWEN_IMAGE_21, f: process.env.CJ_FLUX3, m: process.env.CJ_MOSS_IMAGE };
    process.env.CJ_QWEN_IMAGE_21 = "1";
    process.env.CJ_FLUX3 = "1";
    process.env.CJ_MOSS_IMAGE = "1";
    try {
      const { vi } = await import("vitest");
      vi.resetModules();
      const { getPack } = await import("@/lib/oj/packs");
      for (const t of getEditTools()) {
        const pack = getPack(t.pack);
        expect(pack, t.pack).toBeDefined();
        const rel = pack?.workflows?.[t.packAction];
        expect(rel, `${t.pack}/${t.packAction}`).toBeTruthy();
        expect(STATIC_WORKFLOWS[t.packAction]).toBe(rel);
      }
    } finally {
      if (prev.q === undefined) delete process.env.CJ_QWEN_IMAGE_21;
      else process.env.CJ_QWEN_IMAGE_21 = prev.q;
      if (prev.f === undefined) delete process.env.CJ_FLUX3;
      else process.env.CJ_FLUX3 = prev.f;
      if (prev.m === undefined) delete process.env.CJ_MOSS_IMAGE;
      else process.env.CJ_MOSS_IMAGE = prev.m;
    }
  });

  it("base graphs have exactly one UNETLoader, one KSampler, a LoadImage", () => {
    for (const t of getEditTools()) {
      const wf = loadWf(toolWorkflowPath(t, undefined));
      const count = (c: string) => Object.values(wf).filter((n) => n.class_type === c).length;
      // mossi2i loads DiT/TE/VAE through the OpenMOSS MOSSImageLoader instead of UNETLoader
      expect(count(toolGraphFamily(t) === "mossi2i" ? "MOSSImageLoader" : "UNETLoader"), t.id).toBe(1);
      expect(count("KSampler"), t.id).toBe(1);
      expect(count("LoadImage"), t.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("all referenced LoRA files exist on disk (skipped if models dir absent)", () => {
    if (!fs.existsSync(LORA_DIR)) return;
    for (const t of getEditTools()) {
      for (const f of allToolLoraFiles(t)) {
        expect(fs.existsSync(path.join(LORA_DIR, f)), f).toBe(true);
      }
    }
  });

  it("structural invariants", () => {
    for (const t of getEditTools()) {
      expect(t.refLabels.length, t.id).toBe(t.refCount);
      // krea2control loads its adapter in a custom node, not the LoRA chain;
      // qwen21-remove-bg is the base model's own RGBA skill (no LoRA)
      if (toolGraphFamily(t) !== "krea2control" && !LORA_FREE_TOOLS.has(t.id)) {
        expect(t.loras.length, t.id).toBeGreaterThan(0);
      }
      expect(t.needsMask, t.id).toBe(MASK_PREPS.includes(t.prep));
      if (t.needsMask) expect(t.maskHint, t.id).toBeTruthy();
      expect(!!t.outpaint, t.id).toBe(t.prep === "outpaint");
      expect(() => toolGraphFamily(t)).not.toThrow();
      expect(toolLicense(t).name).toBeTruthy();
      if (t.promptTemplate.includes("{prompt}")) {
        expect(t.promptMode, t.id).not.toBe("none");
      }
      for (const o of t.options) {
        expect(o.values.some((v) => v.id === o.default), `${t.id}.${o.id}`).toBe(true);
      }
    }
    expect(registry.version).toBeGreaterThan(0);
  });

  it("krea2 general edit v2 is also in the krea2 edit LoRA registry", () => {
    const entry = JSON.stringify(editLoraRegistry);
    expect(entry).toContain("krea2_general_edit_v2_r64.safetensors");
    expect(entry).toContain("general-edit-v2");
  });
});

describe("public projection", () => {
  it("exposes client fields and no server internals", () => {
    const pub = toPublicTool(tool("qwen21-camera"), {
      installed: true,
      keepFramingInstalled: false,
      speedInstalled: true,
      packAvailable: true,
    });
    expect(pub).toMatchObject({
      id: "qwen21-camera",
      installed: true,
      packAvailable: true,
      available: true,
      refCount: 1,
    });
    expect(pub).not.toHaveProperty("pack");
    expect(pub).not.toHaveProperty("packAction");
    expect(pub).not.toHaveProperty("graphFamily");
    expect(pub.speed).toEqual({ supported: false });
  });

  it("available is false when the pack is missing", () => {
    const pub = toPublicTool(tool("qwen21-restore"), {
      installed: true,
      keepFramingInstalled: true,
      speedInstalled: true,
      packAvailable: false,
    });
    expect(pub.available).toBe(false);
    expect(pub.speed).toMatchObject({ supported: true, steps: 4, cfg: 1, available: true });
    expect(pub.extras.keepFraming).toMatchObject({ available: true });
  });
});

describe("options", () => {
  it("applies tool defaults", () => {
    const o = resolveToolOptions(tool("krea2-general-edit"), undefined);
    expect(o).toMatchObject({ fast: false, keepFraming: false, steps: 10, cfg: 1 });
    const cam = resolveToolOptions(tool("qwen21-camera"), {});
    expect(cam).toMatchObject({ steps: 30, cfg: 3 });
  });

  it("fast switches to lightning steps/cfg, explicit steps still win", () => {
    const t = tool("qwen21-restore");
    expect(resolveToolOptions(t, { fast: true })).toMatchObject({ fast: true, steps: 4, cfg: 1 });
    expect(resolveToolOptions(t, { fast: true, steps: 8 }).steps).toBe(8);
  });

  it.each([
    ["qwen21-camera", { fast: true }],
    ["krea2-general-edit", { keepFraming: true }],
    ["qwen21-restore", { bogus: 1 }],
    ["qwen21-restore", { steps: 0 }],
    ["qwen21-restore", { steps: 1.5 }],
    ["qwen21-restore", { cfg: 99 }],
    ["qwen21-restore", { seed: -1 }],
    ["qwen21-restore", { fast: "yes" }],
    ["qwen21-restore", { outpaint: "wide" }],
    ["qwen21-camera", { azimuth: "nope" }],
    ["qwen21-outpaint", { outpaint: "nope" }],
    ["qwen21-outpaint", { outpaint: { left: 0 } }],
    ["qwen21-outpaint", { outpaint: { left: 9 } }],
    ["qwen21-outpaint", { outpaint: { sideways: 0.2 } }],
    ["qwen21-outpaint", { outpaint: { aspect: "abc" } }],
    ["qwen21-restore", "string"],
  ])("rejects bad options for %s %j", (id, opts) => {
    expect(() => resolveToolOptions(tool(id), opts)).toThrow(ToolRequestError);
  });

  it("resolves outpaint presets, sides and aspect", () => {
    const t = tool("qwen21-outpaint");
    const def = resolveToolOptions(t, undefined).outpaint;
    expect(def?.presetId).toBe(t.outpaint?.default);
    expect(resolveToolOptions(t, { outpaint: { left: 0.2, right: 0.2 } }).outpaint?.spec).toEqual({
      kind: "sides",
      sides: { left: 0.2, right: 0.2, top: 0, bottom: 0 },
    });
    const a = resolveToolOptions(t, { outpaint: { aspect: "16:9", anchor: "left" } });
    expect(a.outpaint?.spec).toMatchObject({ kind: "aspect", anchor: "left" });
  });
});

describe("prompt rendering", () => {
  it("camera vocab", () => {
    const t = tool("qwen21-camera");
    const o = resolveToolOptions(t, {
      azimuth: "front-right",
      elevation: "high-angle",
      distance: "close-up",
    });
    const p = renderToolPrompt(t, "a red car", o.choices);
    expect(p.startsWith("<qma> ")).toBe(true);
    expect(p).toContain("front-right quarter view");
    expect(p.endsWith("a red car")).toBe(true);
    for (const opt of t.options) {
      const chosen = opt.values.find((v) => v.id === o.choices[opt.id]);
      expect(p).toContain(chosen!.text);
    }
  });

  it("camera works with no user prompt and collapses whitespace", () => {
    const t = tool("qwen21-camera");
    const p = renderToolPrompt(t, undefined, resolveToolOptions(t, {}).choices);
    expect(p).not.toMatch(/\s{2,}/);
    expect(p).not.toMatch(/\{/);
  });

  it("outfit swap embeds user prompt", () => {
    const t = tool("qwen21-outfit-swap");
    const p = renderToolPrompt(t, "make it red", {});
    expect(p).toContain("image 1");
    expect(p).toContain("image 2");
    expect(p).toContain("make it red");
  });

  it("unblur ignores user text", () => {
    const p = renderToolPrompt(tool("qwen21-unblur-background"), "ignored words", {});
    expect(p).toContain("sharp background");
    expect(p).not.toContain("ignored");
  });

  it("required prompt throws prompt_required", () => {
    try {
      renderToolPrompt(tool("krea2-general-edit"), "  ", {});
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolRequestError);
      expect((e as ToolRequestError).code).toBe("prompt_required");
    }
  });

  it("strips control characters", () => {
    expect(renderToolPrompt(tool("krea2-general-edit"), "a\u0000b\u0007c", {})).toBe("abc");
  });
});

describe("LoRA chain + graph building", () => {
  it("resolveToolLoras orders tool, consistency, speed", () => {
    const t = tool("qwen21-restore");
    const chain = resolveToolLoras(t, { fast: true, keepFraming: true });
    expect(chain.map((l) => l.file)).toEqual([
      t.loras[0].file,
      "edit_tools/qwen-image-2.1-consistency.safetensors",
      "edit_tools/qwen-image-2.1-lightning-4step.safetensors",
    ]);
    expect(resolveToolLoras(t, { fast: false, keepFraming: false })).toHaveLength(1);
  });

  it("insertLoraChain wires UNET -> lora(s) -> consumers, replacing existing loaders", () => {
    const wf = loadWf("packs/qwen-image-21/edit.json");
    const unet = Object.entries(wf).find(([, n]) => n.class_type === "UNETLoader")![0];
    const added = insertLoraChain(wf, [
      { file: "a.safetensors", strength: 0.8 },
      { file: "b.safetensors", strength: 1 },
    ]);
    expect(added).toHaveLength(2);
    expect(wf[added[0]].inputs).toMatchObject({ model: [unet, 0], lora_name: "a.safetensors", strength_model: 0.8 });
    expect(wf[added[1]].inputs.model).toEqual([added[0], 0]);
    const loaders = Object.entries(wf).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
    expect(loaders).toHaveLength(2);
    // nothing but the first lora reads the raw UNET output
    const readers = Object.entries(wf).filter(([, n]) =>
      Object.values(n.inputs).some((v) => Array.isArray(v) && v[0] === unet && v[1] === 0),
    );
    expect(readers.map(([id]) => id)).toEqual([added[0]]);
    // sampler (or whatever consumed the model) now reads the chain tail
    const tailReaders = Object.entries(wf).filter(([id, n]) =>
      id !== added[1] &&
      Object.values(n.inputs).some((v) => Array.isArray(v) && v[0] === added[1]),
    );
    expect(tailReaders.length).toBeGreaterThan(0);
  });

  it("replaces pre-existing LoRA loaders (edit_turbo has one)", () => {
    const p = path.join(WF_DIR, "packs/qwen-image-21/edit_turbo.json");
    if (!fs.existsSync(p)) return;
    const wf = loadWf("packs/qwen-image-21/edit_turbo.json");
    const before = Object.values(wf).filter((n) => n.class_type === "LoraLoaderModelOnly").length;
    expect(before).toBeGreaterThan(0);
    insertLoraChain(wf, [{ file: "x.safetensors", strength: 1 }]);
    const after = Object.values(wf).filter((n) => n.class_type === "LoraLoaderModelOnly");
    expect(after).toHaveLength(1);
    expect(after[0].inputs.lora_name).toBe("x.safetensors");
  });

  it.each(getEditTools().map((t) => t.id))("buildToolWorkflow(%s)", (id) => {
    const t = tool(id);
    const base = loadWf(toolWorkflowPath(t, undefined));
    const snapshot = JSON.stringify(base);
    const refs = t.refCount === 2 ? ["a.png [input]", "b.png [input]"] : ["a.png [input]"];
    const loras = resolveToolLoras(t, { fast: false, keepFraming: false });
    const choices = resolveToolOptions(t, {}).choices;
    const wf = buildToolWorkflow({
      workflow: base,
      tool: t,
      // cameraAngle tools splice the camera span out of the rendered prompt
      prompt: t.cameraAngle ? renderToolPrompt(t, "PROMPT_X", choices) : "PROMPT_X",
      choices: t.cameraAngle ? choices : undefined,
      loras,
      steps: 7,
      cfg: 2.5,
      seed: 123,
      imageRefs: refs,
      latent: { width: 832, height: 1248 },
      placement:
        toolGraphFamily(t) === "krea2outpaint"
          ? { passes: [{ canvasWidth: 1024, canvasHeight: 768, x0: 0, y0: 64, x1: 1024, y1: 704 }] }
          : undefined,
      ...(toolGraphFamily(t) === "krea2anypaint"
        ? {
            anypaint: { canvasWidth: 1024, canvasHeight: 768, x0: 0, y0: 0, x1: 1024, y1: 768 },
            maskRef: "m.png [input]",
          }
        : {}),
    });
    expect(JSON.stringify(base)).toBe(snapshot); // input not mutated
    const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
    expect(ks.inputs).toMatchObject({ steps: 7, cfg: 2.5, seed: 123 });
    expect(JSON.stringify(wf)).toContain("PROMPT_X");
    // mossi2i applies its single LoRA inside MOSSi2iReference (the toolkit patches the reference path)
    const loraClass = toolGraphFamily(t) === "mossi2i" ? "MOSSi2iReference" : "LoraLoaderModelOnly";
    const lorasInGraph = Object.entries(wf).filter(([, n]) => n.class_type === loraClass);
    expect(lorasInGraph.map(([, n]) => n.inputs.lora_name)).toEqual(loras.map((l) => l.file));
    const loadImages = Object.values(wf).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
    expect(loadImages).toEqual(expect.arrayContaining(refs));
    for (const n of Object.values(wf)) {
      if (n.class_type === "SaveImage") expect(n.inputs.filename_prefix).toBe(`Adrift_${id}`);
      if ((n.class_type === "Krea2OstrisEditModelPatch" || n.class_type === "MOSSImageOstrisEditModelPatch") && t.kvCache)
        expect(n.inputs.kv_cache).toBe(true);
    }
    // every link resolves to an existing node
    for (const n of Object.values(wf)) {
      for (const v of Object.values(n.inputs)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[1] === "number") {
          expect(wf[String(v[0])], `${id} dangling ${String(v[0])}`).toBeDefined();
        }
      }
    }
  });

  it("outfit swap wires image 2 into the encoder", () => {
    const t = tool("qwen21-outfit-swap");
    const wf = buildToolWorkflow({
      workflow: loadWf("packs/qwen-image-21/edit.json"),
      tool: t,
      prompt: "p",
      loras: resolveToolLoras(t, { fast: false, keepFraming: false }),
      steps: 25,
      cfg: 1,
      seed: 1,
      imageRefs: ["a.png [input]", "b.png [input]"],
    });
    const enc = Object.values(wf).find((n) => n.class_type === "TextEncodeQwenImage21")!;
    const link = enc.inputs["images.image_2"] as [string, number];
    expect(wf[link[0]].class_type).toBe("LoadImage");
    expect(wf[link[0]].inputs.image).toBe("b.png [input]");
  });

  it("rejects wrong image counts", () => {
    const t = tool("qwen21-outfit-swap");
    expect(() =>
      buildToolWorkflow({
        workflow: loadWf("packs/qwen-image-21/edit.json"),
        tool: t,
        prompt: "p",
        loras: [],
        steps: 1,
        cfg: 1,
        seed: 1,
        imageRefs: ["a.png [input]"],
      }),
    ).toThrow(/needs 2/);
  });
});

describe("moss restyle from depth", () => {
  const t = () => tool("moss-restyle-depth");
  const build = (opts: { fast: boolean; choices?: Record<string, string>; latent?: { width: number; height: number } }) => {
    const resolved = resolveToolOptions(t(), { fast: opts.fast, ...(opts.choices ?? {}) });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t(), undefined)),
      tool: t(),
      prompt: renderToolPrompt(t(), "a brutalist concrete villa at dusk", resolved.choices),
      loras: resolveToolLoras(t(), resolved),
      steps: resolved.steps ?? 50,
      cfg: resolved.cfg ?? 3,
      seed: 9,
      imageRefs: ["src.png [input]"],
      latent: opts.latent,
      choices: resolved.choices,
    });
  };
  const node = (wf: Workflow, c: string) => Object.values(wf).find((n) => n.class_type === c)!;

  it("is a moss-family tool that needs a latent fit and a prompt", () => {
    expect(toolGraphFamily(t())).toBe("moss");
    expect(toolNeedsLatentFit(t())).toBe(true);
    expect(() => renderToolPrompt(t(), "", {})).toThrow();
  });

  it("depth map from the source feeds MOSSImageControl, which feeds the sampler", () => {
    const wf = build({ fast: false });
    const ctrlId = Object.keys(wf).find((k) => wf[k].class_type === "MOSSImageControl")!;
    const ks = node(wf, "KSampler");
    expect(ks.inputs.positive).toEqual([ctrlId, 0]);
    expect(ks.inputs.negative).toEqual([ctrlId, 1]);
    const scaleLink = wf[ctrlId].inputs.depth_map as [string, number];
    expect(wf[scaleLink[0]].class_type).toBe("ImageScale");
    expect(node(wf, "LoadImage").inputs.image).toBe("src.png [input]");
    expect(node(wf, "MOSSImageControl").inputs.end_percent).toBe(1);
    expect(node(wf, "LoadDA3Model").inputs.model_name).toBe("depth_anything_3_base.safetensors");
    // control + deband LoRAs chained, no speed LoRA when not fast
    const lnames = Object.values(wf)
      .filter((n) => n.class_type === "LoraLoaderModelOnly")
      .map((n) => n.inputs.lora_name);
    expect(lnames).toEqual(["moss-control.safetensors", "moss_image_sft_banding_fix_L37-41_bf16.safetensors"]);
    expect(node(wf, "KSampler").inputs.steps).toBe(50);
  });

  it("loose structure + large depth model + latent size flow into the graph", () => {
    const wf = build({ fast: false, choices: { structure: "loose", depth: "large" }, latent: { width: 832, height: 1216 } });
    expect(node(wf, "MOSSImageControl").inputs.end_percent).toBe(0.5);
    expect(node(wf, "LoadDA3Model").inputs.model_name).toBe("depth_anything_3_mono_large.safetensors");
    expect(node(wf, "EmptyFlux2LatentImage").inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, "ImageScale").inputs).toMatchObject({ width: 832, height: 1216 });
  });

  it("fast mode adds the DMD speed LoRA and the MOSS speed recipe", () => {
    const wf = build({ fast: true });
    const lnames = Object.values(wf)
      .filter((n) => n.class_type === "LoraLoaderModelOnly")
      .map((n) => n.inputs.lora_name);
    expect(lnames).toContain("moss_image_sft_8step_dmd.safetensors");
    expect(node(wf, "KSampler").inputs).toMatchObject({ steps: 14, cfg: 3, sampler_name: "er_sde", scheduler: "simple" });
    expect(node(wf, "TemporalScoreRescaling")).toBeDefined();
  });
});

describe("krea2 restyle from depth", () => {
  const t = () => tool("krea2-restyle-depth");
  const build = (choices: Record<string, string> = {}, latent?: { width: number; height: number }) => {
    const resolved = resolveToolOptions(t(), { ...choices });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t(), undefined)),
      tool: t(),
      prompt: renderToolPrompt(t(), "a knight in silver armor in a misty forest", resolved.choices),
      loras: resolveToolLoras(t(), resolved),
      steps: resolved.steps ?? 8,
      cfg: resolved.cfg ?? 1,
      seed: 4,
      imageRefs: ["pose.png [input]"],
      latent,
      choices: resolved.choices,
    });
  };
  const node = (wf: Workflow, c: string) => Object.values(wf).find((n) => n.class_type === c)!;

  it("is a krea2control tool: latent fit, prompt required, no LoRA chain by default", () => {
    expect(toolGraphFamily(t())).toBe("krea2control");
    expect(toolNeedsLatentFit(t())).toBe(true);
    expect(() => renderToolPrompt(t(), "", {})).toThrow();
    expect(resolveToolLoras(t(), resolveToolOptions(t(), {}))).toEqual([]);
  });

  it("source depth map -> Krea2DualControlApply -> sampler model; turbo 8 steps cfg 1", () => {
    const wf = build();
    const ctrlId = Object.keys(wf).find((k) => wf[k].class_type === "Krea2DualControlApply")!;
    expect(node(wf, "KSampler").inputs).toMatchObject({ model: [ctrlId, 0], steps: 8, cfg: 1, seed: 4 });
    const ctrl = wf[ctrlId].inputs;
    expect(ctrl).toMatchObject({ adapter_name: "krea2-control.safetensors", strength: 1, color_end: 1, depth_end: 1 });
    expect(ctrl.color_image).toBeUndefined();
    const depthLink = ctrl.depth_image as [string, number];
    expect(wf[depthLink[0]].class_type).toBe("ImageScale");
    expect(wf[(ctrl.vae as [string, number])[0]].class_type).toBe("VAELoader");
    expect(node(wf, "LoadImage").inputs.image).toBe("pose.png [input]");
    expect(node(wf, "LoadDA3Model").inputs.model_name).toBe("depth_anything_3_base.safetensors");
    expect(Object.values(wf).some((n) => n.class_type === "LoraLoaderModelOnly")).toBe(false);
    expect(node(wf, "SaveImage").inputs.filename_prefix).toBe("Adrift_krea2-restyle-depth");
  });

  it("loose structure + large depth model + latent size flow into the graph", () => {
    const wf = build({ structure: "loose", depth: "large" }, { width: 896, height: 1152 });
    expect(node(wf, "Krea2DualControlApply").inputs.depth_end).toBe(0.6);
    expect(node(wf, "LoadDA3Model").inputs.model_name).toBe("depth_anything_3_mono_large.safetensors");
    expect(node(wf, "EmptySD3LatentImage").inputs).toMatchObject({ width: 896, height: 1152 });
    expect(node(wf, "ImageScale").inputs).toMatchObject({ width: 896, height: 1152 });
  });
});

describe("krea2 layout from region map", () => {
  const t = () => tool("krea2-layout-regions");
  const build = (choices: Record<string, string> = {}, latent?: { width: number; height: number }) => {
    const resolved = resolveToolOptions(t(), { ...choices });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t(), undefined)),
      tool: t(),
      prompt: renderToolPrompt(t(), "a woman on the left, a red car on the right", resolved.choices),
      loras: resolveToolLoras(t(), resolved),
      steps: resolved.steps ?? 8,
      cfg: resolved.cfg ?? 1,
      seed: 9,
      imageRefs: ["map.png [input]"],
      latent,
      choices: resolved.choices,
    });
  };
  const node = (wf: Workflow, c: string) => Object.values(wf).find((n) => n.class_type === c)!;

  it("region map -> nearest resize -> color slot only; no depth estimator", () => {
    expect(toolGraphFamily(t())).toBe("krea2control");
    expect(toolNeedsLatentFit(t())).toBe(true);
    const wf = build();
    const ctrlId = Object.keys(wf).find((k) => wf[k].class_type === "Krea2DualControlApply")!;
    expect(node(wf, "KSampler").inputs).toMatchObject({ model: [ctrlId, 0], steps: 8, cfg: 1, seed: 9 });
    const ctrl = wf[ctrlId].inputs;
    expect(ctrl).toMatchObject({ adapter_name: "krea2-control.safetensors", color_end: 1, depth_end: 1 });
    expect(ctrl.depth_image).toBeUndefined();
    const scale = wf[(ctrl.color_image as [string, number])[0]];
    expect(scale.class_type).toBe("ImageScale");
    expect(scale.inputs.upscale_method).toBe("nearest-exact");
    expect(wf[(scale.inputs.image as [string, number])[0]].inputs.image).toBe("map.png [input]");
    expect(Object.values(wf).some((n) => /DA3/.test(n.class_type))).toBe(false);
    expect(node(wf, "SaveImage").inputs.filename_prefix).toBe("Adrift_krea2-layout-regions");
  });

  it("loose layout ends the color map at 0.4 and leaves depth_end alone; latent sizes the map", () => {
    const wf = build({ layout: "loose" }, { width: 1152, height: 896 });
    expect(node(wf, "Krea2DualControlApply").inputs).toMatchObject({ color_end: 0.4, depth_end: 1 });
    expect(node(wf, "ImageScale").inputs).toMatchObject({ width: 1152, height: 896 });
    expect(node(wf, "EmptySD3LatentImage").inputs).toMatchObject({ width: 1152, height: 896 });
  });

  it("depth tool ignores a stray layout choice (its color slot is empty)", () => {
    const d = tool("krea2-restyle-depth");
    const wf = buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(d, undefined)),
      tool: d,
      prompt: "x",
      loras: [],
      steps: 8,
      cfg: 1,
      seed: 1,
      imageRefs: ["a.png [input]"],
      choices: { structure: "strict", depth: "base", layout: "loose" },
    });
    expect(node(wf, "Krea2DualControlApply").inputs).toMatchObject({ color_end: 1, depth_end: 1 });
  });
});

describe("krea2 BFS head / body swap (two refs)", () => {
  const build = (id: string, choices: Record<string, string> = {}, prompt?: string) => {
    const t = tool(id);
    const resolved = resolveToolOptions(t, { ...choices });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t, undefined)),
      tool: t,
      prompt: renderToolPrompt(t, prompt, resolved.choices),
      loras: resolveToolLoras(t, resolved),
      steps: resolved.steps ?? t.defaults.steps,
      cfg: resolved.cfg ?? 1,
      seed: 3,
      imageRefs: ["base.png [input]", "ref.png [input]"],
      latent: { width: 896, height: 1152 },
      choices: resolved.choices,
    });
  };
  type N = Workflow[string];
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const src = (wf: Workflow, link: unknown): N => wf[(link as [string, number])[0]];
  /** follow a link through the 1MP pre-scale back to the LoadImage filename */
  const imageOf = (wf: Workflow, link: unknown): unknown => {
    const n = src(wf, link);
    return n.class_type === "LoadImage" ? n.inputs.image : imageOf(wf, n.inputs.image);
  };

  it("head swap: base -> slot a, reference head -> slot b on patch and both encoders", () => {
    const t = tool("krea2-head-swap");
    expect(toolGraphFamily(t)).toBe("krea2edit");
    expect(toolNeedsLatentFit(t)).toBe(true);
    const wf = build("krea2-head-swap", {}, "ignored user text");
    const [[, patch]] = all(wf, "Krea2EditModelPatch");
    expect(imageOf(wf, patch.inputs.source_image)).toBe("base.png [input]");
    expect(imageOf(wf, patch.inputs.source_image_b)).toBe("ref.png [input]");
    expect(imageOf(wf, src(wf, patch.inputs.source_latent).inputs.pixels)).toBe("base.png [input]");
    expect(imageOf(wf, src(wf, patch.inputs.source_latent_b).inputs.pixels)).toBe("ref.png [input]");
    expect(patch.inputs.ref_boost).toBe(1);
    const enc = all(wf, "Krea2EditGroundedEncode").map(([, n]) => n);
    expect(enc).toHaveLength(2);
    for (const e of enc) {
      expect(imageOf(wf, e.inputs.image)).toBe("base.png [input]");
      expect(imageOf(wf, e.inputs.image_b)).toBe("ref.png [input]");
    }
    const ks = all(wf, "KSampler")[0][1];
    const pos = src(wf, ks.inputs.positive);
    expect(pos.inputs).toMatchObject({ prompt: "head_swap: replace the head with the reference head.", grounding_px: 512 });
    expect(src(wf, ks.inputs.negative).inputs).toMatchObject({ prompt: "", grounding_px: 768 });
    expect(ks.inputs).toMatchObject({ steps: 8, cfg: 1, seed: 3 });
    const loras = all(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs);
    expect(loras).toEqual([expect.objectContaining({ lora_name: "bfs_head_swap_v1.1_krea2.safetensors", strength_model: 1 })]);
    // refs keep their own aspect: no ImageScale (which latent fit would stretch)
    expect(all(wf, "ImageScale")).toHaveLength(0);
    expect(all(wf, "ImageScaleToTotalPixels").map(([, n]) => n.inputs.megapixels)).toEqual([1, 1]);
    expect(all(wf, "EmptySD3LatentImage")[0][1].inputs).toMatchObject({ width: 896, height: 1152 });
  });

  it("strong likeness sets ref_boost 4 (pulls toward the reference)", () => {
    const wf = build("krea2-head-swap", { likeness: "strong" });
    expect(all(wf, "Krea2EditModelPatch")[0][1].inputs).toMatchObject({ ref_boost: 4, ref_boost_a: 1 });
  });

  it("body swap: 0.5 LoRA, native grounding, optional BG prompt appended", () => {
    const wf = build("krea2-body-swap", {}, "BG: a rainy neon street");
    const ks = all(wf, "KSampler")[0][1];
    expect(src(wf, ks.inputs.positive).inputs).toMatchObject({
      prompt: "body_swap: replace the person with the reference person. BG: a rainy neon street",
      grounding_px: 0,
    });
    expect(ks.inputs.steps).toBe(10);
    expect(all(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs)).toEqual([
      expect.objectContaining({ lora_name: "bfs_body_swap_v1_krea2.safetensors", strength_model: 0.5 }),
    ]);
    const bare = build("krea2-body-swap");
    expect(src(bare, all(bare, "KSampler")[0][1].inputs.positive).inputs.prompt).toBe(
      "body_swap: replace the person with the reference person.",
    );
  });

  it("a single-ref krea2edit graph cannot take two refs", () => {
    const t = { ...tool("krea2-head-swap"), packAction: "edit_instruct" };
    expect(() =>
      buildToolWorkflow({
        workflow: loadWf(toolWorkflowPath(t, undefined)),
        tool: t,
        prompt: "x",
        loras: [],
        steps: 8,
        cfg: 1,
        seed: 1,
        imageRefs: ["a.png [input]", "b.png [input]"],
      }),
    ).toThrow(/second LoadImage/);
  });
});

describe("helpers", () => {
  it("parseComfyRef / formatComfyRef round trip + traversal rejection", () => {
    const r = parseComfyRef("sub/dir/img 1.png [output]");
    expect(r).toEqual({ filename: "img 1.png", subfolder: "sub/dir", type: "output" });
    expect(formatComfyRef(r!)).toBe("sub/dir/img 1.png [output]");
    expect(parseComfyRef("../x.png [input]")).toBeNull();
    expect(parseComfyRef("a/../x.png [input]")).toBeNull();
    expect(parseComfyRef("x.exe [input]")).toBeNull();
    expect(parseComfyRef("x.png")).toBeNull();
    expect(parseComfyRef(5)).toBeNull();
  });

  it("fitLatentDims keeps aspect, multiples of 16", () => {
    const d = fitLatentDims(2000, 1000);
    expect(d.width % 16).toBe(0);
    expect(d.height % 16).toBe(0);
    expect(d.width / d.height).toBeCloseTo(2, 1);
  });
});

describe("outpaint prompt", () => {
  it("renders the default prompt when blank and splices user text", () => {
    const t = getEditTools().find((x) => x.id === "qwen21-outpaint")!;
    expect(t.promptMode).toBe("optional");
    expect(renderToolPrompt(t, "", {})).toMatch(/seamless continuation/);
    expect(renderToolPrompt(t, "a sunset sky", {})).toMatch(/unchanged\. a sunset sky$/);
  });
});

describe("image tools batch (swap / story / remove / 2511 / flux3)", () => {
  const pub = (id: string) =>
    toPublicTool(tool(id), {
      installed: true,
      keepFramingInstalled: true,
      speedInstalled: true,
      packAvailable: true,
    });

  it("head swap: two labelled refs, fixed prompt with user text appended, MIT-over-Qwen license", () => {
    const t = tool("qwen21-head-swap");
    expect(t.refCount).toBe(2);
    expect(t.refLabels).toEqual(["Target", "Face"]);
    expect(t.loras[0].file).toBe("edit_tools/bfs_head_v1.1_qwen_2.1.safetensors");
    const p = renderToolPrompt(t, "keep the glasses", {});
    expect(p.startsWith("head_swap: start with <image1> as the base image")).toBe(true);
    expect(p).toContain("4k keep the glasses");
    expect(renderToolPrompt(t, "", {}).endsWith("sharp details, 4k")).toBe(true);
    expect(toolLicense(t).name).toMatch(/^MIT/);
    expect(toolLicense(t).commercial).toBe(false); // Qwen Research base governs
    expect(resolveToolOptions(t, { fast: true })).toMatchObject({ fast: true, steps: 4 });
  });

  it("body swap: scene/person refs, body_swap prompt", () => {
    const t = tool("qwen21-body-swap");
    expect(t.refLabels).toEqual(["Scene", "Person"]);
    expect(renderToolPrompt(t, "", {})).toMatch(/^body_swap: start with <image1>/);
  });

  it("next scene: strength 0.7, prompt required, template", () => {
    const t = tool("qwen21-next-scene");
    expect(t.loras[0].strength).toBe(0.7);
    expect(resolveToolLoras(t, { fast: false, keepFraming: false })[0].strength).toBe(0.7);
    expect(resolveToolOptions(t, {})).toMatchObject({ steps: 28, cfg: 1 });
    expect(renderToolPrompt(t, "The camera pulls back", {})).toBe("Next Scene: The camera pulls back");
    expect(() => renderToolPrompt(t, "", {})).toThrow(ToolRequestError);
  });

  it("remove-box: mask + redbox prep, fixed prompt ignores user text, speed on by default", () => {
    const t = tool("qwen21-remove-box");
    expect(t).toMatchObject({ needsMask: true, prep: "redbox", promptMode: "none" });
    expect(renderToolPrompt(t, "ignored", {})).toBe("Remove the red highlighted object from the scene");
    const o = resolveToolOptions(t, undefined);
    expect(o).toMatchObject({ fast: true, steps: 4, cfg: 1 });
    expect(resolveToolLoras(t, o).map((l) => l.file)).toEqual([
      "edit_tools/Qwen-Image-2.1-Object-Remover-Bbox-turbo-4000.safetensors",
      "edit_tools/qwen-image-2.1-lightning-4step.safetensors",
    ]);
    expect(pub("qwen21-remove-box").maskHint).toMatch(/red box/i);
  });

  it("doodle: scribble prep, required prompt template, steps 40", () => {
    const t = tool("qwen21-doodle");
    expect(t).toMatchObject({ needsMask: true, prep: "scribble", promptMode: "required" });
    expect(renderToolPrompt(t, "a brown leather armchair", {})).toBe(
      "<doodle> Turn the magenta scribble into a brown leather armchair.",
    );
    expect(() => renderToolPrompt(t, "", {})).toThrow(ToolRequestError);
    expect(resolveToolOptions(t, {})).toMatchObject({ steps: 40, cfg: 1, fast: false });
  });

  it("anything2real: Restyle category with a rendered prompt", () => {
    const t = tool("qwen21-anything2real");
    expect(t.category).toBe("Restyle");
    expect(renderToolPrompt(t, "", {})).toMatch(/^Turn this into a realistic photo of the character/);
  });

  it("non-mask tools expose maskHint=null", () => {
    expect(pub("qwen21-restore").maskHint).toBeNull();
  });

  describe("qwen2511 base", () => {
    it("is its own base/graph family on the qwen-image-edit pack, Apache license", () => {
      for (const id of ["qwen2511-remove", "qwen2511-unblur-upscale"]) {
        const t = tool(id);
        expect(t.base).toBe("qwen2511");
        expect(toolGraphFamily(t)).toBe("qwen2511");
        expect(toolWorkflowPath(t, undefined)).toBe("packs/qwen-image-edit/edit.json");
        expect(toolLicense(t)).toMatchObject({ name: "Apache-2.0", commercial: true });
        expect(toolNeedsLatentFit(t)).toBe(true);
        expect(pub(id).baseLabel).toBe("Qwen-Image-Edit 2511");
      }
    });

    it("remove: user text is required and spliced into the template", () => {
      const t = tool("qwen2511-remove");
      expect(renderToolPrompt(t, "the red car", {})).toBe(
        "Remove the red car from the image while preserving the background and remaining elements maintaining realism and original details.",
      );
      expect(() => renderToolPrompt(t, "", {})).toThrow(ToolRequestError);
    });

    it("unblur-upscale: fixed prompt", () => {
      expect(renderToolPrompt(tool("qwen2511-unblur-upscale"), "x", {})).toBe("unblur and upscale");
    });

    it("fast uses the 2511 lightning LoRA from the loras root", () => {
      const t = tool("qwen2511-remove");
      const o = resolveToolOptions(t, { fast: true });
      expect(o).toMatchObject({ steps: 4, cfg: 2 });
      expect(resolveToolLoras(t, o).map((l) => l.file)).toEqual([
        "edit_tools/Qwen-Image-Edit-2511-Object-Remover.safetensors",
        "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
      ]);
    });

    it("buildToolWorkflow strips the baked LoRAs, sets prompt on the EditPlus encoder and the latent", () => {
      const t = tool("qwen2511-remove");
      const loras = resolveToolLoras(t, { fast: false, keepFraming: false });
      const wf = buildToolWorkflow({
        workflow: loadWf("packs/qwen-image-edit/edit.json"),
        tool: t,
        prompt: "PROMPT_2511",
        loras,
        steps: 30,
        cfg: 4,
        seed: 5,
        imageRefs: ["a.png [input]"],
        latent: { width: 832, height: 1248 },
      });
      const loaders = Object.values(wf).filter((n) => n.class_type === "LoraLoaderModelOnly");
      expect(loaders.map((n) => n.inputs.lora_name)).toEqual([loras[0].file]);
      const enc = Object.entries(wf).filter(([, n]) => n.class_type === "TextEncodeQwenImageEditPlus");
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      const posId = String((ks.inputs.positive as [string, number])[0]);
      expect(wf[posId].inputs.prompt).toBe("PROMPT_2511");
      expect(enc).toHaveLength(2);
      // AuraFlow model-sampling now reads the new chain tail, not a removed node
      const aura = Object.values(wf).find((n) => n.class_type === "ModelSamplingAuraFlow")!;
      expect(wf[String((aura.inputs.model as [string, number])[0])].class_type).toBe("LoraLoaderModelOnly");
      const lat = Object.values(wf).find((n) => n.class_type === "EmptySD3LatentImage")!;
      expect(lat.inputs).toMatchObject({ width: 832, height: 1248 });
    });
  });

  describe("flux3 tools", () => {
    it("restore: distilled graph, 8 steps, prompt + optional user text", () => {
      const t = tool("flux3-restore");
      expect(toolWorkflowPath(t, undefined)).toBe("packs/flux3/edit_fast.json");
      expect(resolveToolOptions(t, {})).toMatchObject({ steps: 8, cfg: 1 });
      expect(renderToolPrompt(t, "", {})).toMatch(/^Restore the photo: remove blur, noise and compression artifacts/);
      expect(renderToolPrompt(t, "colorize", {}).endsWith("colors. colorize")).toBe(true);
    });

    it("camera: undistilled base graph at 50 steps, <mva> grammar", () => {
      const t = tool("flux3-camera");
      expect(toolWorkflowPath(t, undefined)).toBe("packs/flux3/edit.json");
      expect(resolveToolOptions(t, {})).toMatchObject({ steps: 50 });
      const base = resolveToolOptions(t, {
        azimuth: "back-left",
        elevation: "top-down",
      });
      expect(renderToolPrompt(t, "ignored", base.choices)).toBe("<mva> back-left quarter view, top-down shot");
      const cu = resolveToolOptions(t, { azimuth: "front", elevation: "low-angle", distance: "close-up" });
      expect(renderToolPrompt(t, undefined, cu.choices)).toBe("<mva> front view, low-angle shot close-up");
      const side = resolveToolOptions(t, { azimuth: "right", elevation: "eye-level" });
      expect(renderToolPrompt(t, undefined, side.choices)).toBe("<mva> right side view, eye-level shot");
      expect(() => resolveToolOptions(t, { elevation: "underground" })).toThrow(ToolRequestError);
    });

    it("keepFraming is per-base: qwen21 and flux3 resolve different LoRAs", () => {
      expect(getKeepFramingLora("qwen21").file).toBe("edit_tools/qwen-image-2.1-consistency.safetensors");
      expect(getKeepFramingLora("flux3").file).toBe("edit_tools/flux-3-image-klein-consistency.safetensors");
      expect(getKeepFramingLora("krea2").file).toBe("edit_tools/qwen-image-2.1-consistency.safetensors"); // default
      const t = tool("flux3-restore");
      expect(t.extras.keepFraming?.default).toBe(false);
      expect(resolveToolOptions(t, {}).keepFraming).toBe(false);
      const o = resolveToolOptions(t, { keepFraming: true });
      expect(resolveToolLoras(t, o).map((l) => l.file)).toEqual([
        "edit_tools/flux-3-image-klein-restore.safetensors",
        "edit_tools/flux-3-image-klein-consistency.safetensors",
      ]);
      expect(allToolLoraFiles(t)).toContain("edit_tools/flux-3-image-klein-consistency.safetensors");
      const p = pub("flux3-restore");
      expect(p.extras.keepFraming?.description).toMatch(/FLUX\.3/);
      expect(pub("qwen21-restore").extras.keepFraming?.description).toMatch(/Consistency LoRA/);
    });
  });
});

/** TS port of comfy_extras/nodes_camera_angle.py's prompt buckets. */
function cameraAnglePrompt(h: number, v: number, zoom: number): string {
  const sectors = [
    "front view",
    "front-right quarter view",
    "right side view",
    "back-right quarter view",
    "back view",
    "back-left quarter view",
    "left side view",
    "front-left quarter view",
  ];
  const az = sectors[Math.floor((((h % 360) + 22.5) % 360) / 45)];
  const el = v < -15 ? "low-angle shot" : v < 15 ? "eye-level shot" : v < 45 ? "elevated shot" : "high-angle shot";
  const dist = zoom < 2 ? "wide shot" : zoom < 6 ? "medium shot" : "close-up";
  return `${az} ${el} ${dist}`;
}

describe("qwen no-download tools (RGBA background removal + 2511 camera angle)", () => {
  const edit21 = "packs/qwen-image-21/edit.json";

  describe("qwen21-remove-bg", () => {
    it("is a LoRA-free qwen21 tool on the stock edit graph with the template prompt", () => {
      const t = tool("qwen21-remove-bg");
      expect(t.base).toBe("qwen21");
      expect(toolWorkflowPath(t, undefined)).toBe(edit21);
      expect(t.loras).toEqual([]);
      expect(t.speed.supported).toBe(false);
      expect(resolveToolOptions(t, {})).toMatchObject({ steps: 25, cfg: 1, fast: false });
      expect(renderToolPrompt(t, "ignored", {})).toBe("Remove the background, and output a PNG image");
      expect(resolveToolLoras(t, { fast: false, keepFraming: false })).toEqual([]);
    });

    it("builds with no LoRA loader, source-size encoder and a plain SaveImage (RGBA from the VAE)", () => {
      const t = tool("qwen21-remove-bg");
      const wf = buildToolWorkflow({
        workflow: loadWf(edit21),
        tool: t,
        prompt: renderToolPrompt(t, undefined, {}),
        loras: [],
        steps: 25,
        cfg: 1,
        seed: 9,
        imageRefs: ["a.png [input]"],
      });
      expect(Object.values(wf).filter((n) => n.class_type === "LoraLoaderModelOnly")).toHaveLength(0);
      const unet = Object.entries(wf).find(([, n]) => n.class_type === "UNETLoader")!;
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      // the sampler's model chain reaches the UNET directly
      let ref = ks.inputs.model as [string, number];
      for (let hop = 0; hop < 8 && String(ref[0]) !== unet[0]; hop++) {
        ref = wf[String(ref[0])].inputs.model as [string, number];
      }
      expect(String(ref[0])).toBe(unet[0]);
      const enc = Object.values(wf).find((n) => n.class_type === "TextEncodeQwenImage21")!;
      expect(enc.inputs).toMatchObject({ prompt: "Remove the background, and output a PNG image", resolution: 0 });
      const save = Object.values(wf).filter((n) => n.class_type === "SaveImage");
      expect(save).toHaveLength(1);
      expect(save[0].inputs.filename_prefix).toBe("Adrift_qwen21-remove-bg");
      // VAE is the 2.1 RGBA-capable one
      const vae = Object.values(wf).find((n) => n.class_type === "VAELoader")!;
      expect(vae.inputs.vae_name).toBe("qwen_image_2.1_vae_bf16.safetensors");
    });
  });

  describe("qwen2511-camera", () => {
    it("is a 2511 tool with the multiple-angles LoRA and lightning fast mode on by default", () => {
      const t = tool("qwen2511-camera");
      expect(t.base).toBe("qwen2511");
      expect(t.cameraAngle).toBe(true);
      expect(toolWorkflowPath(t, undefined)).toBe("packs/qwen-image-edit/edit.json");
      const o = resolveToolOptions(t, {});
      expect(o).toMatchObject({ fast: true, steps: 4 });
      expect(o.choices).toEqual({ azimuth: "front-right", elevation: "eye-level", distance: "medium" });
      expect(resolveToolLoras(t, o).map((l) => l.file)).toEqual([
        "qwen-image-edit-2511-multiple-angles-lora.safetensors",
        "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
      ]);
      expect(resolveToolOptions(t, { fast: false })).toMatchObject({ steps: 40, cfg: 3 });
      expect(() => resolveToolOptions(t, { azimuth: "up" })).toThrow(ToolRequestError);
    });

    it("every preset's text is exactly what the CameraAngle node emits for its inputs", () => {
      const t = tool("qwen2511-camera");
      const [az, el, dist] = t.options;
      for (const a of az.values)
        for (const e of el.values)
          for (const d of dist.values) {
            const choices = { azimuth: a.id, elevation: e.id, distance: d.id };
            const cam = toolCameraAngleInputs(t, choices);
            expect(cameraAnglePrompt(cam.horizontal_angle, cam.vertical_angle, cam.zoom)).toBe(
              `${a.text} ${e.text} ${d.text}`,
            );
            expect(renderToolPrompt(t, undefined, choices)).toBe(`<sks> ${a.text} ${e.text} ${d.text}`);
          }
      expect(az.values).toHaveLength(8);
      expect(el.values).toHaveLength(4);
      expect(dist.values).toHaveLength(3);
    });

    it("wires CameraAngle -> StringConcatenate(<sks>, ...) -> StringConcatenate(..., user text) into the EditPlus prompt", () => {
      const t = tool("qwen2511-camera");
      const o = resolveToolOptions(t, { azimuth: "back-left", elevation: "high-angle", distance: "close-up" });
      const prompt = renderToolPrompt(t, "keep the red scarf", o.choices);
      expect(prompt).toBe("<sks> back-left quarter view high-angle shot close-up keep the red scarf");
      const wf = buildToolWorkflow({
        workflow: loadWf("packs/qwen-image-edit/edit.json"),
        tool: t,
        prompt,
        loras: resolveToolLoras(t, o),
        steps: o.steps,
        cfg: o.cfg,
        seed: 1,
        imageRefs: ["a.png [input]"],
        latent: { width: 1024, height: 1024 },
        choices: o.choices,
      });
      const cams = Object.entries(wf).filter(([, n]) => n.class_type === "CameraAngle");
      expect(cams).toHaveLength(1);
      const [camId, cam] = cams[0];
      expect(cam.inputs).toEqual({ horizontal_angle: 225, vertical_angle: 60, zoom: 10 });
      const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
      const pos = wf[String((ks.inputs.positive as [string, number])[0])];
      expect(pos.class_type).toBe("TextEncodeQwenImageEditPlus");
      const suffix = wf[String((pos.inputs.prompt as [string, number])[0])];
      expect(suffix).toMatchObject({ class_type: "StringConcatenate" });
      expect(suffix.inputs.string_b).toBe("keep the red scarf");
      const prefix = wf[String((suffix.inputs.string_a as [string, number])[0])];
      expect(prefix.class_type).toBe("StringConcatenate");
      expect(prefix.inputs).toEqual({ string_a: "<sks>", string_b: [camId, 1], delimiter: " " });
      // negative encoder untouched
      const neg = wf[String((ks.inputs.negative as [string, number])[0])];
      expect(typeof neg.inputs.prompt).toBe("string");
    });

    it("without user text the prefix concat feeds the encoder directly", () => {
      const t = tool("qwen2511-camera");
      const o = resolveToolOptions(t, {});
      const wf = buildToolWorkflow({
        workflow: loadWf("packs/qwen-image-edit/edit.json"),
        tool: t,
        prompt: renderToolPrompt(t, "", o.choices),
        loras: resolveToolLoras(t, o),
        steps: o.steps,
        cfg: o.cfg,
        seed: 1,
        imageRefs: ["a.png [input]"],
        choices: o.choices,
      });
      expect(Object.values(wf).filter((n) => n.class_type === "StringConcatenate")).toHaveLength(1);
      const cam = Object.values(wf).find((n) => n.class_type === "CameraAngle")!;
      expect(cam.inputs).toEqual({ horizontal_angle: 45, vertical_angle: 0, zoom: 5 });
    });

    it("rejects a prompt whose camera span does not match the choices", () => {
      const t = tool("qwen2511-camera");
      expect(() =>
        buildToolWorkflow({
          workflow: loadWf("packs/qwen-image-edit/edit.json"),
          tool: t,
          prompt: "<sks> back view eye-level shot medium shot",
          loras: [],
          steps: 4,
          cfg: 1,
          seed: 1,
          imageRefs: ["a.png [input]"],
          choices: { azimuth: "front", elevation: "eye-level", distance: "medium" },
        }),
      ).toThrow(/camera span/);
    });

    it("the default Camera angle stays the all-local qwen21 tool", () => {
      expect(tool("qwen21-camera").label).toBe("Camera angle");
      expect(tool("qwen2511-camera").label).toBe("Camera angle (Qwen Edit 2511)");
    });
  });
});

describe("krea2 bbox outpaint", () => {
  const t = () => tool("krea2-outpaint");
  const build = (placement: Krea2OutpaintPlacement | undefined, prompt?: string) => {
    const resolved = resolveToolOptions(t(), {});
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t(), undefined)),
      tool: t(),
      prompt: renderToolPrompt(t(), prompt, resolved.choices),
      loras: resolveToolLoras(t(), resolved),
      steps: resolved.steps ?? t().defaults.steps,
      cfg: resolved.cfg ?? 1,
      seed: 9,
      imageRefs: ["src.png [input]"],
      placement,
    });
  };
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const geom = (n: Workflow[string]) => [
    n.inputs.canvas_width, n.inputs.canvas_height,
    n.inputs.bbox_x0, n.inputs.bbox_y0, n.inputs.bbox_x1, n.inputs.bbox_y1,
  ];
  const one = { passes: [{ canvasWidth: 1456, canvasHeight: 720, x0: 240, y0: 0, x1: 1216, y1: 720 }] };

  it("is a fast, no-pad Krea 2 tool", () => {
    expect(toolGraphFamily(t())).toBe("krea2outpaint");
    expect(toolNeedsLatentFit(t())).toBe(false);
    expect(t().defaults.steps).toBe(8);
    expect(renderToolPrompt(t(), "", {})).toBe("Seamless natural extension of the scene.");
  });

  it("single pass: geometry on encoder + composite, latent = canvas, original image in", () => {
    const wf = build(one, "a beach at dusk");
    const [[, enc]] = all(wf, "TextEncodeKrea2Outpaint");
    const [[compId, comp]] = all(wf, "Krea2OutpaintComposite");
    expect(geom(enc)).toEqual([1456, 720, 240, 0, 1216, 720]);
    expect(geom(comp)).toEqual(geom(enc));
    expect(all(wf, "EmptySD3LatentImage")[0][1].inputs).toMatchObject({ width: 1456, height: 720 });
    expect(all(wf, "KSampler")).toHaveLength(1);
    expect(enc.inputs.prompt).toBe("Seamless natural extension of the scene. a beach at dusk");
    const [[loadId, load]] = all(wf, "LoadImage");
    expect(load.inputs.image).toBe("src.png [input]");
    expect(enc.inputs.image).toEqual([loadId, 0]);
    expect(all(wf, "SaveImage")[0][1].inputs.images).toEqual([compId, 0]);
    // LoRA chain -> outpaint patch -> sampler
    const [[loraId, lora]] = all(wf, "LoraLoaderModelOnly");
    expect(lora.inputs.lora_name).toBe("krea2_outpaint_rank32.safetensors");
    const [[patchId, patch]] = all(wf, "Krea2OutpaintModelPatch");
    expect(patch.inputs.model).toEqual([loraId, 0]);
    expect(all(wf, "KSampler")[0][1].inputs.model).toEqual([patchId, 0]);
  });

  it("two passes: pass 2 is fed by pass 1's composite and is what gets saved", () => {
    const wf = build({
      passes: [
        { canvasWidth: 1024, canvasHeight: 576, x0: 128, y0: 0, x1: 896, y1: 576 },
        { canvasWidth: 1024, canvasHeight: 768, x0: 0, y0: 96, x1: 1024, y1: 672 },
      ],
    });
    const encs = all(wf, "TextEncodeKrea2Outpaint");
    const comps = all(wf, "Krea2OutpaintComposite");
    const kss = all(wf, "KSampler");
    const lats = all(wf, "EmptySD3LatentImage");
    expect([encs.length, comps.length, kss.length, lats.length, all(wf, "VAEDecode").length]).toEqual([2, 2, 2, 2, 2]);
    const [[c1Id, c1], [c2Id, c2]] = comps;
    expect(geom(c1)).toEqual([1024, 576, 128, 0, 896, 576]);
    expect(geom(c2)).toEqual([1024, 768, 0, 96, 1024, 672]);
    expect(geom(encs[1][1])).toEqual(geom(c2));
    expect(encs[1][1].inputs.image).toEqual([c1Id, 0]);
    expect(c2.inputs.source).toEqual([c1Id, 0]);
    expect(lats.map(([, n]) => [n.inputs.width, n.inputs.height])).toEqual([[1024, 576], [1024, 768]]);
    const [[, k1], [, k2]] = kss;
    expect(k2.inputs).toMatchObject({ seed: 9, steps: 8, positive: [encs[1][0], 0], latent_image: [lats[1][0], 0] });
    expect(k2.inputs.model).toEqual(k1.inputs.model);
    expect(k2.inputs.negative).toEqual(k1.inputs.negative);
    expect(all(wf, "VAEDecode")[1][1].inputs.samples).toEqual([kss[1][0], 0]);
    expect(c2.inputs.generated).toEqual([all(wf, "VAEDecode")[1][0], 0]);
    expect(all(wf, "SaveImage").map(([, n]) => n.inputs.images)).toEqual([[c2Id, 0]]);
  });

  it("throws without a placement", () => {
    expect(() => build(undefined)).toThrow(/placement/);
  });
});

describe("krea2 AnyPaint", () => {
  const t = () => tool("krea2-anypaint");
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const build = (anypaint: AnyPaintPlacement | undefined, maskRef: string | undefined = "mask.png [input]") => {
    const resolved = resolveToolOptions(t(), {});
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t(), undefined)),
      tool: t(),
      prompt: renderToolPrompt(t(), "a kitchen with a bowl of lemons", resolved.choices),
      loras: resolveToolLoras(t(), resolved),
      steps: resolved.steps ?? 8,
      cfg: resolved.cfg ?? 1,
      seed: 5,
      imageRefs: ["src.png [input]"],
      anypaint,
      maskRef,
    });
  };

  it("is a mask tool on its own graph family with the reference settings", () => {
    expect(toolGraphFamily(t())).toBe("krea2anypaint");
    expect(t().prep).toBe("anypaint");
    expect(t().needsMask).toBe(true);
    expect(toolNeedsLatentFit(t())).toBe(false);
    expect(t().defaults).toEqual({ steps: 8, cfg: 1 });
    expect(t().promptMode).toBe("required");
    expect(t().requiresNodes).toBe("comfyui-krea2-anypaint");
    expect(STATIC_WORKFLOWS.anypaint).toBe("packs/krea2/anypaint.json");
    expect(() => renderToolPrompt(t(), "", {})).toThrow(ToolRequestError);
    expect(renderToolPrompt(t(), "  a red door  ", { expand: "left_50" })).toBe("a red door");
  });

  it("expand values are none + real outpaint presets", () => {
    const opt = t().options.find((o) => o.id === ANYPAINT_EXPAND_OPTION)!;
    expect(opt.default).toBe("none");
    const presetIds = registry.outpaintPresets.map((p) => p.id);
    for (const v of opt.values) {
      if (v.id !== "none") expect(presetIds, v.id).toContain(v.id);
    }
    expect(anyPaintExpandSpec(t(), { expand: "none" })).toBeUndefined();
    expect(anyPaintExpandSpec(t(), {})).toBeUndefined();
    expect(anyPaintExpandSpec(t(), { expand: "left_50" })).toEqual({
      kind: "sides",
      sides: { left: 0.5, right: 0, top: 0, bottom: 0 },
    });
    expect(anyPaintExpandSpec(t(), { expand: "aspect_16_9" })).toMatchObject({ kind: "aspect", anchor: "center" });
    // non-anypaint tools never expand
    expect(anyPaintExpandSpec(tool("krea2-inpaint"), { expand: "left_50" })).toBeUndefined();
    expect(() => resolveToolOptions(t(), { expand: "all_50" })).toThrow(ToolRequestError); // not offered
    expect(() => resolveToolOptions(t(), { outpaint: "all_25" })).toThrow(ToolRequestError);
    expect(() => resolveToolOptions(t(), { fast: true })).toThrow(ToolRequestError);
  });

  it("wires geometry, mask, LoRA -> patch -> sampler, known latent; raw decode saved", () => {
    const wf = build({ canvasWidth: 1456, canvasHeight: 720, x0: 240, y0: 0, x1: 1216, y1: 720 });
    const [[prepId, prep]] = all(wf, "Krea2AnyPaintPrepare");
    expect(prep.inputs).toMatchObject({
      canvas_width: 1456, canvas_height: 720, bbox_x0: 240, bbox_y0: 0, bbox_x1: 1216, bbox_y1: 720,
      seam_px: 32, reference_max_edge: 384,
    });
    const [[loadId, load]] = all(wf, "LoadImage");
    const [[maskId, mask]] = all(wf, "LoadImageMask");
    expect(load.inputs.image).toBe("src.png [input]");
    expect(mask.inputs).toMatchObject({ image: "mask.png [input]", channel: "red" });
    expect(prep.inputs.source).toEqual([loadId, 0]);
    expect(prep.inputs.mask).toEqual([maskId, 0]);
    const [[encId, enc]] = all(wf, "TextEncodeKrea2AnyPaint");
    expect(enc.inputs.prompt).toBe("a kitchen with a bowl of lemons");
    expect(enc.inputs.condition).toEqual([prepId, 0]);
    const [[knownId, known]] = all(wf, "Krea2AnyPaintKnownLatent");
    expect(known.inputs.known).toEqual([prepId, 1]);
    expect(known.inputs.keep_mask).toEqual([prepId, 2]);
    const [[loraId, lora]] = all(wf, "LoraLoaderModelOnly");
    expect(lora.inputs.lora_name).toBe("krea2_anypaint_rank32.safetensors");
    const [[patchId, patch]] = all(wf, "Krea2AnyPaintModelPatch");
    expect(patch.inputs.model).toEqual([loraId, 0]);
    const [[ksId, ks]] = all(wf, "KSampler");
    expect(ks.inputs).toMatchObject({
      model: [patchId, 0], positive: [encId, 0], latent_image: [knownId, 0],
      steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, seed: 5,
    });
    expect(all(wf, "EmptySD3LatentImage")).toHaveLength(0);
    const [[decId]] = all(wf, "VAEDecode");
    expect(all(wf, "SaveImage")[0][1].inputs.images).toEqual([decId, 0]);
  });

  it("throws without a placement or a mask ref", () => {
    expect(() => build(undefined)).toThrow(/placement/);
    expect(() => build({ canvasWidth: 1024, canvasHeight: 1024, x0: 0, y0: 0, x1: 1024, y1: 1024 }, "")).toThrow(/mask/);
  });

  describe("planAnyPaint", () => {
    const valid = (w: number, h: number, p: AnyPaintPlacement) => {
      expect(p.canvasWidth % 16).toBe(0);
      expect(p.canvasHeight % 16).toBe(0);
      expect(p.x0).toBeGreaterThanOrEqual(0);
      expect(p.y0).toBeGreaterThanOrEqual(0);
      expect(p.x1).toBeLessThanOrEqual(p.canvasWidth);
      expect(p.y1).toBeLessThanOrEqual(p.canvasHeight);
      for (const v of [p.x0, p.y0, p.x1, p.y1]) expect(Number.isInteger(v)).toBe(true);
      expect(anyPaintAspectOk(w, h, p.x1 - p.x0, p.y1 - p.y0)).toBe(true);
    };

    it("inpaint: ~1MP canvas in the source aspect, bbox = whole canvas", () => {
      const p = planAnyPaint(4000, 3000);
      expect(p).toEqual({ canvasWidth: 1184, canvasHeight: 880, x0: 0, y0: 0, x1: 1184, y1: 880 });
      valid(4000, 3000, p);
      expect(planAnyPaint(640, 480, { kind: "aspect", aspect: 4 / 3, anchor: "center" })).toEqual(planAnyPaint(640, 480));
    });

    it("one-axis growth spans the other axis exactly", () => {
      const p = planAnyPaint(640, 480, { kind: "sides", sides: { left: 0, right: 0.5, top: 0, bottom: 0 } });
      valid(640, 480, p);
      expect([p.x0, p.y0, p.y1]).toEqual([0, 0, p.canvasHeight]);
      expect(p.canvasWidth / p.canvasHeight).toBeCloseTo(960 / 480, 1);
      const q = planAnyPaint(640, 480, { kind: "sides", sides: { left: 0, right: 0, top: 0.5, bottom: 0 } });
      valid(640, 480, q);
      expect([q.x0, q.x1, q.y1]).toEqual([0, q.canvasWidth, q.canvasHeight]);
    });

    it("all-sides growth centres the source", () => {
      const p = planAnyPaint(800, 600, { kind: "sides", sides: { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25 } });
      valid(800, 600, p);
      expect(Math.abs(p.x0 - (p.canvasWidth - p.x1))).toBeLessThanOrEqual(2);
      expect(Math.abs(p.y0 - (p.canvasHeight - p.y1))).toBeLessThanOrEqual(2);
      expect((p.x1 - p.x0) / p.canvasWidth).toBeCloseTo(2 / 3, 1);
    });

    it("matches the reference aspect tolerance", () => {
      expect(anyPaintAspectOk(1000, 1000, 1000, 1025)).toBe(true);
      expect(anyPaintAspectOk(1000, 1000, 1000, 1030)).toBe(false);
      expect(anyPaintAspectOk(40, 40, 40, 42)).toBe(true); // 2 px of a 40 px box
    });

    it("extreme aspects that cannot keep their shape are rejected, not distorted", () => {
      expect(() => planAnyPaint(8000, 100)).toThrow(OutpaintError); // 9152 px canvas
      valid(4000, 1000, planAnyPaint(4000, 1000));
    });

    it("fuzz: every size x preset is valid or an OutpaintError", () => {
      const sizes = [[640, 480], [481, 1023], [1920, 1080], [333, 777], [1024, 1024], [3000, 750], [517, 2069]];
      const specs = registry.outpaintPresets.map((p) => anyPaintExpandSpec(t(), { expand: p.id })!);
      let ok = 0;
      for (const [w, h] of sizes) {
        valid(w, h, planAnyPaint(w, h));
        for (const spec of specs) {
          try {
            valid(w, h, planAnyPaint(w, h, spec));
            ok++;
          } catch (e) {
            expect(e).toBeInstanceOf(OutpaintError);
          }
        }
      }
      expect(ok).toBe(sizes.length * specs.length);
    });
  });
});

describe("krea2 4-step speed mode", () => {
  const FOUR = "krea2_turbo_4step_rank_64_lora_comfyui.safetensors";
  const TURBO = [
    "krea2-general-edit",
    "krea2-outpaint",
    "krea2-head-swap",
    "krea2-body-swap",
    "krea2-restyle-depth",
    "krea2-layout-regions",
  ];
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const build = (id: string, opts: Record<string, unknown>, extra: Partial<Parameters<typeof buildToolWorkflow>[0]> = {}) => {
    const t = tool(id);
    const resolved = resolveToolOptions(t, opts);
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t, undefined)),
      tool: t,
      prompt: renderToolPrompt(t, "a red coat", resolved.choices),
      loras: resolveToolLoras(t, resolved),
      steps: resolved.steps ?? t.defaults.steps,
      cfg: resolved.cfg ?? t.defaults.cfg,
      seed: 3,
      imageRefs: Array.from({ length: t.refCount }, (_, i) => `r${i}.png [input]`),
      latent: { width: 1024, height: 1024 },
      ...extra,
    });
  };
  const outpaintPlacement = {
    passes: [
      { canvasWidth: 1024, canvasHeight: 576, x0: 128, y0: 0, x1: 896, y1: 576 },
      { canvasWidth: 1024, canvasHeight: 768, x0: 0, y0: 96, x1: 1024, y1: 672 },
    ],
  };

  it("speed LoRA entry follows the lvladikov README (steps 4, cfg 1, strength 1)", () => {
    expect(registry.speedLoras.krea2).toMatchObject({ file: FOUR, steps: 4, cfg: 1, strength: 1 });
  });

  it.each(TURBO)("%s: 8-step stays the default, fast is opt-in", (id) => {
    const t = tool(id);
    expect(t.speed).toEqual({ supported: true, default: false });
    const def = resolveToolOptions(t, {});
    expect(def.fast).toBe(false);
    expect(def.steps).toBe(t.defaults.steps);
    expect(resolveToolLoras(t, def).map((l) => l.file)).not.toContain(FOUR);
    const fast = resolveToolOptions(t, { fast: true });
    expect(fast).toMatchObject({ fast: true, steps: 4, cfg: 1 });
    const chain = resolveToolLoras(t, fast);
    expect(chain[chain.length - 1]).toEqual({ file: FOUR, strength: 1 });
    expect(resolveToolOptions(t, { fast: true, steps: 6 }).steps).toBe(6);
  });

  it("krea2-inpaint runs on Krea 2 Raw and rejects fast", () => {
    expect(tool("krea2-inpaint").speed.supported).toBe(false);
    expect(() => resolveToolOptions(tool("krea2-inpaint"), { fast: true })).toThrow(ToolRequestError);
  });

  it("public projection labels the speed LoRA", () => {
    const pub = toPublicTool(tool("krea2-general-edit"), {
      installed: true,
      keepFramingInstalled: false,
      speedInstalled: true,
      packAvailable: true,
    });
    expect(pub.speed).toEqual({ supported: true, default: false, available: true, steps: 4, cfg: 1, label: "4-step distill" });
    for (const id of TURBO) expect(allToolLoraFiles(tool(id))).toContain(FOUR);
    expect(allToolLoraFiles(tool("krea2-inpaint"))).not.toContain(FOUR);
  });

  it.each(["krea2-general-edit", "krea2-head-swap", "krea2-body-swap", "krea2-restyle-depth", "krea2-layout-regions"])(
    "%s fast graph: UNET -> ... -> 4-step LoRA feeds the sampler path, KSampler 4 steps cfg 1",
    (id) => {
      const wf = build(id, { fast: true });
      const loras = all(wf, "LoraLoaderModelOnly");
      const tail = loras.find(([, n]) => n.inputs.lora_name === FOUR);
      expect(tail).toBeDefined();
      // nothing else still reads the UNET directly
      const [[unetId]] = all(wf, "UNETLoader");
      const rawReaders = Object.values(wf).filter(
        (n) => n.class_type !== "LoraLoaderModelOnly" && JSON.stringify(n.inputs).includes(`["${unetId}",0]`),
      );
      expect(rawReaders).toEqual([]);
      // the 4-step LoRA is the last link: nothing chains off it but non-LoRA consumers
      const tailReaders = Object.values(wf).filter((n) => JSON.stringify(n.inputs).includes(`["${tail![0]}",0]`));
      expect(tailReaders.length).toBeGreaterThan(0);
      expect(tailReaders.every((n) => n.class_type !== "LoraLoaderModelOnly")).toBe(true);
      expect(all(wf, "KSampler")[0][1].inputs).toMatchObject({ steps: 4, cfg: 1 });
    },
  );

  it("outpaint fast: both passes run 4 steps on the outpaint + 4-step chain", () => {
    const wf = build("krea2-outpaint", { fast: true }, { placement: outpaintPlacement, latent: undefined });
    expect(all(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name)).toEqual([
      "krea2_outpaint_rank32.safetensors",
      FOUR,
    ]);
    const kss = all(wf, "KSampler");
    expect(kss).toHaveLength(2);
    for (const [, k] of kss) expect(k.inputs).toMatchObject({ steps: 4, cfg: 1 });
    const [[patchId, patch]] = all(wf, "Krea2OutpaintModelPatch");
    const fourId = all(wf, "LoraLoaderModelOnly").find(([, n]) => n.inputs.lora_name === FOUR)![0];
    expect(patch.inputs.model).toEqual([fourId, 0]);
    expect(kss[0][1].inputs.model).toEqual([patchId, 0]);
  });

  it("outpaint default keeps the 8-step single-LoRA graph", () => {
    const wf = build("krea2-outpaint", {}, { placement: outpaintPlacement, latent: undefined });
    expect(all(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name)).toEqual(["krea2_outpaint_rank32.safetensors"]);
    for (const [, k] of all(wf, "KSampler")) expect(k.inputs.steps).toBe(8);
  });
});

describe("planKrea2Outpaint", () => {
  const sides = (l: number, r: number, tp: number, b: number) =>
    ({ kind: "sides", sides: { left: l, right: r, top: tp, bottom: b } }) as const;

  it("widen 640x480 by 25% each side: one ~1MP pass, source spans the height", () => {
    expect(planKrea2Outpaint(640, 480, sides(0.25, 0.25, 0, 0))).toEqual({
      passes: [{ canvasWidth: 1456, canvasHeight: 720, x0: 240, y0: 0, x1: 1216, y1: 720 }],
    });
  });

  it("all sides: two passes, the smaller intermediate first", () => {
    const { passes } = planKrea2Outpaint(640, 480, sides(0.25, 0.25, 0.25, 0.25));
    expect(passes).toHaveLength(2);
    expect(passes).toEqual([
      // the 784-wide full-height strip (689,920 px) beats the 1184x592 one
      { canvasWidth: 784, canvasHeight: 880, x0: 0, y0: 144, x1: 784, y1: 736 },
      { canvasWidth: 1184, canvasHeight: 880, x0: 200, y0: 0, x1: 984, y1: 880 },
    ]);
  });

  const cases: Array<[number, number, ReturnType<typeof sides> | { kind: "aspect"; aspect: number; anchor: "center" | "left" | "right" | "top" | "bottom" }]> = [
    [640, 480, sides(0.25, 0.25, 0.25, 0.25)],
    [480, 640, sides(0.5, 0.5, 0.5, 0.5)],
    [1024, 1024, sides(0, 0.5, 0, 0)],
    [1024, 1024, sides(0.1, 0, 0, 0.7)],
    [3000, 2000, sides(1, 1, 1, 1)],
    [333, 777, sides(0.13, 0.31, 0.07, 0.2)],
    [800, 600, { kind: "aspect", aspect: 16 / 9, anchor: "center" }],
    [800, 600, { kind: "aspect", aspect: 9 / 16, anchor: "top" }],
    [1920, 1080, { kind: "aspect", aspect: 1, anchor: "left" }],
  ];
  it.each(cases)("%i x %i %j keeps the model-card contract", (w, h, spec) => {
    const { passes } = planKrea2Outpaint(w, h, spec);
    expect(passes.length === 1 || passes.length === 2).toBe(true);
    for (const p of passes) {
      expect(p.canvasWidth % 16).toBe(0);
      expect(p.canvasHeight % 16).toBe(0);
      for (const v of [p.x0, p.y0, p.x1, p.y1]) expect(v % 8).toBe(0);
      expect(0 <= p.x0 && p.x0 < p.x1 && p.x1 <= p.canvasWidth).toBe(true);
      expect(0 <= p.y0 && p.y0 < p.y1 && p.y1 <= p.canvasHeight).toBe(true);
      // single-pass contract: the box spans the width or height (pass 1 may carry
      // <16 px of align16 padding, as in the reference plan_passes)
      expect(Math.min(p.canvasWidth - (p.x1 - p.x0), p.canvasHeight - (p.y1 - p.y0))).toBeLessThan(16);
    }
    const last = passes[passes.length - 1];
    const px = last.canvasWidth * last.canvasHeight;
    expect(px / (1024 * 1024)).toBeGreaterThan(0.93);
    expect(px / (1024 * 1024)).toBeLessThan(1.07);
    const native = planOutpaint(w, h, spec, { maxCanvasPixels: Infinity, multiple: 1 });
    expect(last.canvasWidth / last.canvasHeight).toBeCloseTo(native.width / native.height, 1);
    // the first pass's box keeps the source aspect
    const first = passes[0];
    expect(((first.x1 - first.x0) / (first.y1 - first.y0)) / (w / h)).toBeCloseTo(1, 1);
    if (passes.length === 2) {
      // pass 2 places all of pass 1's canvas
      expect(last.x1 - last.x0).toBe(first.canvasWidth);
      expect(last.y1 - last.y0).toBe(first.canvasHeight);
    }
  });
});

describe("qwen21 pano360 / character sheet / realism", () => {
  type N = Workflow[string];
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const build = (id: string, choices: Record<string, string> = {}, prompt = "") => {
    const t = tool(id);
    const resolved = resolveToolOptions(t, { ...choices });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t, undefined)),
      tool: t,
      prompt: renderToolPrompt(t, prompt, resolved.choices),
      loras: resolveToolLoras(t, resolved),
      steps: resolved.steps ?? 25,
      cfg: resolved.cfg ?? 1,
      seed: 5,
      imageRefs: ["src.png [input]"],
      choices: resolved.choices,
    });
  };
  const encRes = (wf: Workflow) => all(wf, "TextEncodeQwenImage21").map(([, n]) => (n as N).inputs.resolution);

  it("pano360: fixed 2:1 latent wired into the sampler, encoder at 1088, no speed LoRA", () => {
    const t = tool("qwen21-pano360");
    expect(t).toMatchObject({ category: "Expand", prep: "none", needsMask: false, promptMode: "required" });
    expect(() => renderToolPrompt(t, "", {})).toThrow(ToolRequestError);
    expect(renderToolPrompt(t, "a foggy harbour at dawn", {})).toBe(
      "Transform this set of images into an equirectangular 360 panorama. Scene: a foggy harbour at dawn",
    );
    const wf = build("qwen21-pano360", {}, "a foggy harbour at dawn");
    expect(encRes(wf).every((r) => r === 1088)).toBe(true);
    const lats = all(wf, "EmptySD3LatentImage");
    expect(lats).toHaveLength(1);
    expect(lats[0][1].inputs).toMatchObject({ width: 1536, height: 768, batch_size: 1 });
    const ks = all(wf, "KSampler")[0][1];
    expect(ks.inputs.latent_image).toEqual([lats[0][0], 0]);
    expect(ks.inputs).toMatchObject({ steps: 25, cfg: 1 });
    const loras = all(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name);
    expect(loras).toContain("edit_tools/pano360_qwen21_edit_v1.safetensors");
    expect(loras.some((l) => String(l).includes("lightning"))).toBe(false);
  });

  it("pano360: the size option picks the latent", () => {
    const t = tool("qwen21-pano360");
    expect(toolFixedLatent(t, {})).toEqual({ width: 1536, height: 768 });
    expect(toolFixedLatent(t, { size: "2048" })).toEqual({ width: 2048, height: 1024 });
    const wf = build("qwen21-pano360", { size: "2048" }, "a desert canyon");
    expect(all(wf, "EmptySD3LatentImage")[0][1].inputs).toMatchObject({ width: 2048, height: 1024 });
    expect(toolFixedLatent(tool("qwen21-realism"), {})).toBeUndefined();
  });

  it("character sheet: letterbox prep, own-size encoder, exact trained prompts", () => {
    const t = tool("qwen21-character-sheet");
    expect(t).toMatchObject({ prep: "letterbox", letterbox: { width: 1344, height: 768 }, needsMask: false, outpaint: null });
    expect(MASK_PREPS).not.toContain("letterbox");
    expect(renderToolPrompt(t, "ignored", resolveToolOptions(t, {}).choices)).toMatch(/^turn this photo into a character reference sheet: a 3x2 grid/);
    expect(renderToolPrompt(t, "", { sheet: "pose-full" })).toMatch(/^turn this photo into a character pose sheet: .*leaning back$/);
    const wf = build("qwen21-character-sheet", { sheet: "angle-full" });
    expect(encRes(wf).every((r) => r === 0)).toBe(true);
    expect(all(wf, "EmptySD3LatentImage")).toHaveLength(0);
    const ks = all(wf, "KSampler")[0][1];
    expect(wf[(ks.inputs.latent_image as [string, number])[0]].class_type).toBe("TextEncodeQwenImage21");
  });

  it("realism: fixed trained caption at 768", () => {
    const t = tool("qwen21-realism");
    expect(renderToolPrompt(t, "whatever", {})).toBe("convert this into a real phone photo");
    expect(encRes(build("qwen21-realism")).every((r) => r === 768)).toBe(true);
  });

  it("encoderResolution / fixedLatent refuse non-qwen21 graphs", () => {
    const t = { ...tool("krea2-general-edit"), fixedLatent: { width: 512, height: 512 } };
    expect(() =>
      buildToolWorkflow({
        workflow: loadWf(toolWorkflowPath(t, undefined)),
        tool: t,
        prompt: "x",
        loras: resolveToolLoras(t, resolveToolOptions(t, {})),
        steps: 8,
        cfg: 1,
        seed: 1,
        imageRefs: ["a.png [input]"],
      }),
    ).toThrow();
  });
});

describe("planLetterbox", () => {
  it("fits a portrait photo inside 1344x768, centered, no crop", () => {
    const p = planLetterbox(600, 1200, { width: 1344, height: 768 });
    expect(p).toMatchObject({ width: 1344, height: 768, srcWidth: 384, srcHeight: 768, top: 0, bottom: 0, left: 480, right: 480 });
  });
  it("fits a wide image by width, remainder to bottom/right", () => {
    const p = planLetterbox(3000, 1001, { width: 1344, height: 768 });
    expect(p.srcWidth).toBe(1344);
    expect(p.left + p.srcWidth + p.right).toBe(1344);
    expect(p.top + p.srcHeight + p.bottom).toBe(768);
    expect(p.bottom - p.top).toBeGreaterThanOrEqual(0);
    expect(p.bottom - p.top).toBeLessThanOrEqual(1);
  });
  it("rejects empty sizes", () => {
    expect(() => planLetterbox(0, 10, { width: 1344, height: 768 })).toThrow();
  });
});

describe("moss charref (Ostris edit) + colorize (MOSS Toolkit i2i)", () => {
  const build = (id: string, prompt: string) => {
    const t = tool(id);
    const resolved = resolveToolOptions(t, { fast: false });
    return buildToolWorkflow({
      workflow: loadWf(toolWorkflowPath(t, undefined)),
      tool: t,
      prompt: renderToolPrompt(t, prompt, resolved.choices),
      loras: resolveToolLoras(t, resolved),
      steps: resolved.steps ?? 30,
      cfg: resolved.cfg ?? 3,
      seed: 5,
      imageRefs: ["ref.png [input]"],
      choices: resolved.choices,
    });
  };
  const all = (wf: Workflow, c: string) => Object.entries(wf).filter(([, n]) => n.class_type === c);

  it("charref: UNET -> charref LoRA -> Ostris patch (kv cache) -> SLG -> sampler, prompt prefixed", () => {
    const t = tool("moss-charref");
    expect(toolGraphFamily(t)).toBe("mossostris");
    expect(toolNeedsLatentFit(t)).toBe(false); // output takes the reference's FluxKontext size
    expect(() => renderToolPrompt(t, "", {})).toThrow();
    const wf = build("moss-charref", "1girl, sitting in a cafe");
    const [[unetId]] = all(wf, "UNETLoader");
    const [[loraId, lora]] = all(wf, "LoraLoaderModelOnly");
    const [[patchId, patch]] = all(wf, "MOSSImageOstrisEditModelPatch");
    expect(lora.inputs).toMatchObject({ model: [unetId, 0], lora_name: "moss_image_charref_v2.safetensors" });
    expect(patch.inputs).toMatchObject({ model: [loraId, 0], kv_cache: true });
    const [[slgId, slg]] = all(wf, "SkipLayerGuidanceDiTSimple");
    expect(slg.inputs.model).toEqual([patchId, 0]);
    const [[, ks]] = all(wf, "KSampler");
    expect(ks.inputs).toMatchObject({ model: [slgId, 0], steps: 50, cfg: 3, sampler_name: "euler", scheduler: "sgm_uniform" });
    const enc = all(wf, "TextEncodeMOSSImageOstrisEdit").map(([, n]) => n);
    expect(enc).toHaveLength(2);
    const prompts = enc.map((n) => n.inputs.prompt);
    expect(prompts).toContain("Same character and art style as Picture 1. 1girl, sitting in a cafe");
    expect(prompts).toContain(""); // negative stays empty but still sees the reference
    for (const n of enc) expect(n.inputs.image1).toBeDefined();
    expect(all(wf, "LoadImage")[0][1].inputs.image).toBe("ref.png [input]");
  });

  it("colorize: LoRA set on MOSSi2iReference, sampler takes its latent, prompt optional", () => {
    const t = tool("moss-colorize");
    expect(toolGraphFamily(t)).toBe("mossi2i");
    expect(() => renderToolPrompt(t, "", {})).not.toThrow();
    const wf = build("moss-colorize", "blonde hair, blue eyes");
    expect(all(wf, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(all(wf, "UNETLoader")).toHaveLength(0);
    const [[refId, ref]] = all(wf, "MOSSi2iReference");
    expect(ref.inputs).toMatchObject({ lora_name: "moss_image_base_colorize_v2.safetensors", strength: 1 });
    const [[, ks]] = all(wf, "KSampler");
    expect(ks.inputs.latent_image).toEqual([refId, 1]);
    expect(ks.inputs).toMatchObject({ sampler_name: "er_sde", scheduler: "sgm_uniform", seed: 5 });
    expect(all(wf, "MOSSi2iTextEncode")[0][1].inputs.text).toBe("blonde hair, blue eyes");
    expect(all(wf, "MOSSImageLoader")[0][1].inputs.dit).toBe("moss_image_base_bf16.safetensors");
  });

  it("colorize refuses a LoRA chain it cannot express", () => {
    const t = tool("moss-colorize");
    expect(() =>
      buildToolWorkflow({
        workflow: loadWf(toolWorkflowPath(t, undefined)),
        tool: t,
        prompt: "",
        loras: [
          { file: "a.safetensors", strength: 1 },
          { file: "b.safetensors", strength: 1 },
        ],
        steps: 30,
        cfg: 3,
        seed: 1,
        imageRefs: ["ref.png [input]"],
      }),
    ).toThrow();
  });
});
