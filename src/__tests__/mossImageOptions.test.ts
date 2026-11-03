/** MOSS-Image speed / deband runtime options (t2i + i2i graphs). */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@/types";
import {
  MOSS_BASE_DMD_LORA,
  MOSS_BASE_UNET,
  MOSS_DEBAND_LORA,
  MOSS_KREA2_GRAFT_LORA,
  MOSS_PHOTOREAL_LORA,
  MOSS_SPEED_4_LORA,
  MOSS_SPEED_8_LORA,
  applyMossImageOptions,
  mossRequiredLoras,
  parseMossSpeed,
} from "@/lib/oj/mossImage";
import { resolveMossOptions } from "@/lib/oj/mossImageDefaults";
import { parseImagineInput } from "@/lib/oj/parser";

const load = (name: string): Workflow => {
  const g = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/moss-image", `${name}.json`),
      "utf-8",
    ),
  );
  delete g._meta;
  return g;
};
const all = (g: Workflow, c: string) =>
  Object.entries(g).filter(([, n]) => n.class_type === c);
const ks = (g: Workflow) => all(g, "KSampler")[0][1].inputs as Record<string, unknown>;
const loras = (g: Workflow) =>
  all(g, "LoraLoaderModelOnly").map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model]);

function noDangling(g: Workflow) {
  for (const [id, n] of Object.entries(g))
    for (const v of Object.values(n.inputs))
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(g[v[0]], `node ${id} -> ${v[0]}`).toBeDefined();
}

describe.each(["t2i", "i2i"])("applyMossImageOptions (%s)", (name) => {
  it("off / unset leaves the graph untouched", () => {
    const g = load(name);
    const before = JSON.stringify(g);
    expect(applyMossImageOptions(g, {})).toEqual([]);
    expect(applyMossImageOptions(g, { mossSpeed: "off" })).toEqual([]);
    expect(JSON.stringify(g)).toBe(before);
  });

  it("balanced: deband + partial DMD, 14 steps, CFG 3, er_sde/simple, TSR + SLG 22,24", () => {
    const g = load(name);
    const base = ks(load(name));
    const ids = applyMossImageOptions(g, { mossSpeed: "balanced" });
    expect(ids).toHaveLength(2);
    expect(loras(g)).toEqual([
      [MOSS_DEBAND_LORA, 1],
      [MOSS_SPEED_8_LORA, 0.4],
    ]);
    expect(base.steps).toBe(50);
    expect(ks(g)).toMatchObject({ steps: 14, cfg: 3, sampler_name: "er_sde", scheduler: "simple" });
    const unet = all(g, "UNETLoader")[0][0];
    expect(g[ids[0]].inputs.model).toEqual([unet, 0]);
    expect(g[ids[1]].inputs.model).toEqual([ids[0], 0]);
    const [[slgId, slg]] = all(g, "SkipLayerGuidanceDiTSimple");
    expect(slg.inputs).toMatchObject({ single_layers: "22, 24", start_percent: 0.1, end_percent: 0.7 });
    const [[tsrId, tsr]] = all(g, "TemporalScoreRescaling");
    expect(tsr.inputs).toMatchObject({ tsr_k: 0.95, tsr_sigma: 1 });
    expect(slg.inputs.model).toEqual([tsrId, 0]);
    // TSR sits on the ModelSamplingAuraFlow output, which still follows the LoRA chain.
    const [[msId, ms]] = all(g, "ModelSamplingAuraFlow");
    expect(tsr.inputs.model).toEqual([msId, 0]);
    expect(ms.inputs.model).toEqual([ids[1], 0]);
    expect(ks(g).model).toEqual([slgId, 0]);
    noDangling(g);
  });

  it("fast / fast4 presets: 10 steps, strengths per preset, never stacked", () => {
    const g = load(name);
    applyMossImageOptions(g, { mossSpeed: "fast" });
    expect(loras(g)).toEqual([
      [MOSS_DEBAND_LORA, 1],
      [MOSS_SPEED_8_LORA, 0.5],
    ]);
    expect(ks(g)).toMatchObject({ steps: 10, cfg: 3 });
    const g4 = load(name);
    applyMossImageOptions(g4, { mossSpeed: "4" });
    expect(loras(g4)).toEqual([
      [MOSS_DEBAND_LORA, 1],
      [MOSS_SPEED_4_LORA, 0.35],
    ]);
    expect(ks(g4)).toMatchObject({ steps: 10, cfg: 3 });
    noDangling(g4);
  });

  it("deband alone keeps the base recipe; deband:false drops it from a speed preset", () => {
    const g = load(name);
    const base = ks(load(name));
    applyMossImageOptions(g, { deband: true });
    expect(loras(g)).toEqual([[MOSS_DEBAND_LORA, 1]]);
    expect(ks(g)).toMatchObject({
      steps: base.steps,
      cfg: base.cfg,
      sampler_name: base.sampler_name,
      scheduler: base.scheduler,
    });
    expect(all(g, "TemporalScoreRescaling")).toHaveLength(0);
    noDangling(g);

    const g2 = load(name);
    applyMossImageOptions(g2, { deband: false, mossSpeed: 8 });
    expect(loras(g2)).toEqual([[MOSS_SPEED_8_LORA, 0.4]]);
    noDangling(g2);
  });

  it("krea2 graft: @1 after deband, before speed; alone keeps the base recipe", () => {
    const g = load(name);
    const base = ks(load(name));
    expect(applyMossImageOptions(g, { mossKrea2: true }).length).toBeGreaterThan(0);
    expect(loras(g)).toEqual([[MOSS_KREA2_GRAFT_LORA, 1]]);
    expect(ks(g)).toMatchObject({ steps: base.steps, cfg: base.cfg });
    noDangling(g);

    const g2 = load(name);
    applyMossImageOptions(g2, { mossKrea2: true, mossSpeed: "balanced" });
    expect(loras(g2).map(([f]) => f)).toEqual([
      MOSS_DEBAND_LORA,
      MOSS_KREA2_GRAFT_LORA,
      MOSS_SPEED_8_LORA,
    ]);
    noDangling(g2);
  });

  it("krea2 graft is ignored on turbo (Base UNET; graft is SFT-only)", () => {
    const g = load(name);
    applyMossImageOptions(g, { mossKrea2: true, mossSpeed: "turbo" });
    expect(loras(g)).toEqual([[MOSS_BASE_DMD_LORA, 1]]);
  });

  it("turbo: Base UNET + DMD @1, 8 steps, CFG 1, euler/simple, no deband/TSR", () => {
    const g = load(name);
    const ids = applyMossImageOptions(g, { mossSpeed: "turbo" });
    expect(ids).toHaveLength(1);
    expect(all(g, "UNETLoader")[0][1].inputs.unet_name).toBe(MOSS_BASE_UNET);
    expect(loras(g)).toEqual([[MOSS_BASE_DMD_LORA, 1]]);
    expect(ks(g)).toMatchObject({ steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple" });
    expect(all(g, "TemporalScoreRescaling")).toHaveLength(0);
    noDangling(g);
  });

  it("photoreal: LoRA @1 after the krea2 graft, before speed; ignored on turbo", () => {
    const g = load(name);
    applyMossImageOptions(g, { mossPhotoreal: true });
    expect(loras(g)).toEqual([[MOSS_PHOTOREAL_LORA, 1]]);
    noDangling(g);
    const g2 = load(name);
    applyMossImageOptions(g2, { mossKrea2: true, mossPhotoreal: "1", mossSpeed: "balanced" });
    const files = loras(g2).map((l) => l[0]);
    expect(files.indexOf(MOSS_KREA2_GRAFT_LORA)).toBeLessThan(files.indexOf(MOSS_PHOTOREAL_LORA));
    expect(files.indexOf(MOSS_PHOTOREAL_LORA)).toBeLessThan(files.indexOf(MOSS_SPEED_8_LORA));
    noDangling(g2);
    const g3 = load(name);
    applyMossImageOptions(g3, { mossPhotoreal: true, mossSpeed: "turbo" });
    expect(loras(g3).map((l) => l[0])).not.toContain(MOSS_PHOTOREAL_LORA);
  });

  it("explicit numeric steps / cfg are not overridden by the preset", () => {
    // injectParams has already written explicit values; the preset must not clobber them.
    const g = load(name);
    ks(g).steps = 12;
    ks(g).cfg = 2;
    applyMossImageOptions(g, { mossSpeed: "balanced", steps: 12, cfg: 2 });
    expect(ks(g)).toMatchObject({ steps: 12, cfg: 2 });
  });
});

describe("parse + required", () => {
  it("parseMossSpeed", () => {
    expect(parseMossSpeed("8-step")).toBe("balanced");
    expect(parseMossSpeed(4)).toBe("fast4");
    expect(parseMossSpeed("Fast alt")).toBe("fast4");
    expect(parseMossSpeed("fast")).toBe("fast");
    expect(parseMossSpeed("OFF")).toBe("off");
    expect(parseMossSpeed("")).toBeUndefined();
    expect(parseMossSpeed("turbo")).toBe("turbo");
    expect(parseMossSpeed("base-dmd")).toBe("turbo");
    expect(parseMossSpeed("base")).toBe("off");
    expect(parseMossSpeed("warp")).toBeUndefined();
  });
  it("mossRequiredLoras", () => {
    expect(mossRequiredLoras({})).toEqual([]);
    expect(mossRequiredLoras({ mossSpeed: "4" })).toEqual([
      MOSS_SPEED_4_LORA,
      MOSS_DEBAND_LORA,
    ]);
  });
  it("mossRequiredLoras turbo: base DMD only, no deband", () => {
    expect(mossRequiredLoras({ mossSpeed: "turbo" })).toEqual([MOSS_BASE_DMD_LORA]);
  });
  it("mossRequiredLoras krea2: SFT presets only", () => {
    expect(mossRequiredLoras({ mossKrea2: true })).toEqual([MOSS_KREA2_GRAFT_LORA]);
    expect(mossRequiredLoras({ mossKrea2: true, mossSpeed: "turbo" })).toEqual([
      MOSS_BASE_DMD_LORA,
    ]);
    expect(parseImagineInput("a fox --krea2look").params.mossKrea2).toBe(true);
  });
  it("parser flags --photoreal + required LoRAs", () => {
    const p = parseImagineInput("a fox --photoreal").params;
    expect(p.mossPhotoreal).toBe(true);
    expect(mossRequiredLoras({ mossPhotoreal: true })).toEqual([MOSS_PHOTOREAL_LORA]);
    expect(mossRequiredLoras({ mossPhotoreal: true, mossSpeed: "turbo" })).toEqual([MOSS_BASE_DMD_LORA]);
  });
  it("parser flags --speed / --deband", () => {
    const p = parseImagineInput("a fox --speed fast --deband").params;
    expect(p.mossSpeed).toBe("fast");
    expect(p.deband).toBe(true);
  });
});

describe("resolveMossOptions", () => {
  const dirs: string[] = [];
  const root = (...files: string[]) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cj-moss-"));
    dirs.push(d);
    fs.mkdirSync(path.join(d, "models/loras"), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, "models/loras", f), "x");
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("defaults to balanced when DMD + deband are installed, else off (silently)", async () => {
    expect(
      (await resolveMossOptions(root(MOSS_SPEED_8_LORA, MOSS_DEBAND_LORA), {})).params.mossSpeed,
    ).toBe("balanced");
    expect((await resolveMossOptions(root(MOSS_SPEED_8_LORA), {})).params.mossSpeed).toBe("off");
    const r = await resolveMossOptions(root(), {});
    expect(r.params.mossSpeed).toBe("off");
    expect(r.missing).toEqual([]);
  });
  it("explicit request for a missing LoRA is reported", async () => {
    const r = await resolveMossOptions(root(), { mossSpeed: "4" });
    expect(r.missing).toEqual([
      `loras/${MOSS_SPEED_4_LORA}`,
      `loras/${MOSS_DEBAND_LORA}`,
    ]);
  });
  it("explicit turbo reports the Base UNET + DMD LoRA when missing", async () => {
    const r = await resolveMossOptions(root(), { mossSpeed: "turbo" });
    expect(r.missing).toEqual([
      `loras/${MOSS_BASE_DMD_LORA}`,
      `diffusion_models/${MOSS_BASE_UNET}`,
    ]);
    const d = root(MOSS_BASE_DMD_LORA);
    fs.mkdirSync(path.join(d, "models/diffusion_models"), { recursive: true });
    fs.writeFileSync(path.join(d, "models/diffusion_models", MOSS_BASE_UNET), "x");
    expect((await resolveMossOptions(d, { mossSpeed: "turbo" })).missing).toEqual([]);
  });
  it("explicit --krea2look missing is reported", async () => {
    const r = await resolveMossOptions(root(MOSS_SPEED_8_LORA, MOSS_DEBAND_LORA), {
      mossKrea2: true,
    });
    expect(r.params.mossSpeed).toBe("balanced");
    expect(r.missing).toEqual([`loras/${MOSS_KREA2_GRAFT_LORA}`]);
  });
  it("explicit deband missing is reported even with the defaulted speed", async () => {
    const r = await resolveMossOptions(root(MOSS_SPEED_8_LORA), { deband: true });
    expect(r.params.mossSpeed).toBe("off");
    expect(r.missing).toEqual([`loras/${MOSS_DEBAND_LORA}`]);
  });
});
