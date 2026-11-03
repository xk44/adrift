/**
 * Speed tier (Draft / Standard / Quality): the resolver in speedTier.ts, its
 * engine wiring (injectParams), MOSS / H3 hand-offs, the settings hint and the
 * Relax/Fast/Turbo migration.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  FLUX3_KLEIN_DISTILLED_UNET,
  FLUX3_KLEIN_DISTILLED_UNET_BF16,
  QWEN_TURBO_LORA,
  SPEED_SETTINGS,
  SPEED_TIER_DISTILLED_PARAM,
  SPEED_TIER_MAP,
  applySpeedTier,
  detectSpeedEngine,
  h3SpeedForTier,
  migratePresetSettings,
  mossSpeedForTier,
  normalizeSpeedSetting,
  parseSpeedTier,
  resolveSpeedTier,
  speedEngineForWorkflowPath,
  speedTierDistilledFiles,
  speedTierFlag,
  speedTierHint,
  type SpeedEngine,
} from "@/lib/oj/speedTier";
import { injectParams } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { parseImagineInput } from "@/lib/oj/parser";
import registry from "@/lib/oj/registry.json";
import { getParamSuggestions } from "@/lib/promptAutocomplete";
import { migrateGenerationSettings, selectSettingsString } from "@/store";
import type { GenerationSettings, Workflow } from "@/types";

// ── Fixtures ──────────────────────────────────────────────────────────────

const PACKS = path.join(process.cwd(), "public", "workflows", "packs");

function pack(rel: string): Workflow {
  const raw = JSON.parse(readFileSync(path.join(PACKS, rel), "utf8"));
  return (raw.prompt ?? raw) as Workflow;
}

/** Minimal UNET + KSampler graph. */
function unetGraph(
  unet: string,
  steps: number,
  cfg = 3.5,
  extra: Workflow = {} as Workflow,
): Workflow {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["2", 0],
        seed: 1,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    ...extra,
  } as unknown as Workflow;
}

function ckptGraph(ckpt: string, steps = 20): Workflow {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "3": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], steps, cfg: 7, seed: 1 },
    },
  } as unknown as Workflow;
}

const T = { stepsTargetId: "3", cfgTargetId: "3" };
const steps = (wf: Workflow, id = "3") => wf[id].inputs.steps;

// ── Setting names / flag ──────────────────────────────────────────────────

describe("normalizeSpeedSetting (migration)", () => {
  it("maps legacy names", () => {
    expect(normalizeSpeedSetting("Relax")).toBe("Quality");
    expect(normalizeSpeedSetting("Fast")).toBe("Standard");
    expect(normalizeSpeedSetting("Turbo")).toBe("Draft");
  });
  it("is case-insensitive and keeps new names", () => {
    expect(normalizeSpeedSetting("relax")).toBe("Quality");
    expect(normalizeSpeedSetting(" TURBO ")).toBe("Draft");
    for (const s of SPEED_SETTINGS) expect(normalizeSpeedSetting(s)).toBe(s);
  });
  it("falls back to Standard", () => {
    expect(normalizeSpeedSetting(undefined)).toBe("Standard");
    expect(normalizeSpeedSetting(null)).toBe("Standard");
    expect(normalizeSpeedSetting(3)).toBe("Standard");
    expect(normalizeSpeedSetting("ludicrous")).toBe("Standard");
  });
});

describe("speedTierFlag / parseSpeedTier", () => {
  it("Standard emits nothing (no behaviour change)", () => {
    expect(speedTierFlag("Standard")).toBe("");
    expect(speedTierFlag("Fast")).toBe("");
  });
  it("Draft / Quality emit --tier", () => {
    expect(speedTierFlag("Draft")).toBe("--tier draft");
    expect(speedTierFlag("Quality")).toBe("--tier quality");
    expect(speedTierFlag("Relax")).toBe("--tier quality");
  });
  it("parses --tier values", () => {
    expect(parseSpeedTier("Draft")).toBe("draft");
    expect(parseSpeedTier("standard")).toBe("standard");
    expect(parseSpeedTier("nope")).toBeUndefined();
    expect(parseSpeedTier(undefined)).toBeUndefined();
  });
  it("the prompt parser reads --tier into params.speedTier", () => {
    const r = parseImagineInput("a fox --tier draft");
    expect(r.params.speedTier).toBe("draft");
  });
});

// ── Mapping table ─────────────────────────────────────────────────────────

describe("resolveSpeedTier", () => {
  it("Standard is never a plan", () => {
    for (const e of Object.keys(SPEED_TIER_MAP) as SpeedEngine[]) {
      expect(resolveSpeedTier(e, "standard")).toBeNull();
      expect(resolveSpeedTier(e, "Standard")).toBeNull();
    }
  });
  it("unknown / missing engine is null", () => {
    expect(resolveSpeedTier(null, "draft")).toBeNull();
    expect(resolveSpeedTier(undefined, "quality")).toBeNull();
  });
  it.each(["checkpoint", "ideogram4", "anima", "krea2-raw"] as const)(
    "%s: draft halves, quality 1.5x",
    (e) => {
      expect(resolveSpeedTier(e, "draft")).toMatchObject({
        stepsScale: 0.5,
        minSteps: 4,
      });
      expect(resolveSpeedTier(e, "quality")).toMatchObject({ stepsScale: 1.5 });
    },
  );
  it.each(["krea2-turbo", "zimage-turbo"] as const)(
    "%s: distilled, draft only",
    (e) => {
      expect(resolveSpeedTier(e, "draft")?.stepsScale).toBe(0.5);
      expect(resolveSpeedTier(e, "quality")).toBeNull();
    },
  );
  it("qwen-image: turbo LoRA draft, more steps for quality", () => {
    const d = resolveSpeedTier("qwen-image", "draft")!;
    expect(d.distilled).toMatchObject({
      lora: { file: QWEN_TURBO_LORA, strength: 1 },
      steps: 4,
      cfg: 1,
    });
    expect(d.stepsScale).toBe(0.5); // fallback when the LoRA is missing
    expect(resolveSpeedTier("qwen-image", "quality")?.stepsScale).toBe(1.5);
  });
  it("flux3: distilled Klein draft, quality is a no-op (base is 50 steps)", () => {
    const d = resolveSpeedTier("flux3", "draft")!;
    expect(d.distilled?.unet?.file).toBe(FLUX3_KLEIN_DISTILLED_UNET);
    expect(d.distilled).toMatchObject({ steps: 16, cfg: 1 });
    expect(resolveSpeedTier("flux3", "quality")).toBeNull();
  });
  it.each(["qwen-image-turbo", "flux3-distilled"] as const)(
    "%s: no mapping (already distilled)",
    (e) => {
      expect(resolveSpeedTier(e, "draft")).toBeNull();
      expect(resolveSpeedTier(e, "quality")).toBeNull();
    },
  );
  it("moss-image: preset swap", () => {
    expect(resolveSpeedTier("moss-image", "draft")?.mossSpeed).toBe("fast");
    expect(resolveSpeedTier("moss-image", "quality")?.mossSpeed).toBe("off");
  });
  it("h3-video: turbo LoRA draft only", () => {
    expect(resolveSpeedTier("h3-video", "draft")?.h3Speed).toBe("turbo8");
    expect(resolveSpeedTier("h3-video", "quality")).toBeNull();
  });
});

// ── Engine detection ──────────────────────────────────────────────────────

describe("detectSpeedEngine", () => {
  it.each([
    ["qwen-image-21/t2i.json", "qwen-image"],
    ["qwen-image-21/t2i_turbo.json", "qwen-image-turbo"],
    ["flux3/t2i.json", "flux3"],
    ["flux3/t2i_fast.json", "flux3-distilled"],
    ["krea2/t2i.json", "krea2-turbo"],
    ["moss-image/t2i.json", "moss-image"],
    ["sefi/t2i.json", null],
  ])("pack %s -> %s", (rel, engine) => {
    expect(detectSpeedEngine(pack(rel))).toBe(engine);
  });

  it("H3 graphs", () => {
    expect(detectSpeedEngine(pack("minimax/t2v.json"))).toBe("h3-video");
  });

  it("synthetic model graphs", () => {
    expect(
      detectSpeedEngine(unetGraph("z_image_turbo_bf16.safetensors", 9)),
    ).toBe("zimage-turbo");
    expect(detectSpeedEngine(unetGraph("anima-preview.safetensors", 30))).toBe(
      "anima",
    );
    expect(detectSpeedEngine(unetGraph("krea2_raw_bf16.safetensors", 28))).toBe(
      "krea2-raw",
    );
    // Raw unet + distill LoRA (the krea2-raw pack) is turbo.
    expect(
      detectSpeedEngine(
        unetGraph("krea2_raw_bf16.safetensors", 8, 1, {
          "9": {
            class_type: "LoraLoaderModelOnly",
            inputs: { lora_name: "krea2_turbo_distill.safetensors" },
          },
        } as unknown as Workflow),
      ),
    ).toBe("krea2-turbo");
    const ideo = unetGraph("ideogram4.safetensors", 20, 3.5, {
      "8": { class_type: "Ideogram4Scheduler", inputs: { steps: 20 } },
    } as unknown as Workflow);
    expect(detectSpeedEngine(ideo)).toBe("ideogram4");
  });

  it("checkpoint graphs, except video / audio checkpoints", () => {
    expect(detectSpeedEngine(ckptGraph("sdxl_base.safetensors"))).toBe(
      "checkpoint",
    );
    expect(detectSpeedEngine(ckptGraph("ltx-video-2b.safetensors"))).toBeNull();
    expect(
      detectSpeedEngine(ckptGraph("stable_audio_open.safetensors")),
    ).toBeNull();
  });

  it("unknown diffusion models and sampler-less graphs are unmapped", () => {
    expect(
      detectSpeedEngine(unetGraph("mystery_dit.safetensors", 20)),
    ).toBeNull();
    expect(
      detectSpeedEngine({
        "1": { class_type: "SaveImage", inputs: {} },
      } as unknown as Workflow),
    ).toBeNull();
  });
});

describe("speedEngineForWorkflowPath + speedTierHint", () => {
  it.each([
    [undefined, "checkpoint"],
    ["t2i.json", "checkpoint"],
    ["packs/sdxl/pack.json", "checkpoint"],
    ["packs/qwen-image-21/t2i.json", "qwen-image"],
    ["packs/qwen-image-21/t2i_turbo.json", "qwen-image-turbo"],
    ["packs/flux3/t2i.json", "flux3"],
    ["packs/flux3/t2i_fast.json", "flux3-distilled"],
    ["packs/krea2/t2i.json", "krea2-turbo"],
    ["packs/krea2-raw/t2i.json", "krea2-turbo"],
    ["zimageturbo_t2i.json", "zimage-turbo"],
    ["ideogram4_t2i.json", "ideogram4"],
    ["packs/anima/anima_ref.json", "anima"],
    ["packs/moss-image/t2i.json", "moss-image"],
    ["packs/minimax/t2v.json", "h3-video"],
    ["packs/sefi/t2i.json", null],
    ["custom/my_graph.json", undefined],
  ])("%s -> %s", (p, engine) => {
    expect(speedEngineForWorkflowPath(p as string | undefined)).toBe(engine);
  });

  it("hints the plan, 'No effect for this model' when unmapped", () => {
    expect(speedTierHint("checkpoint", "Draft")).toBe("Half the steps");
    expect(speedTierHint("qwen-image", "Draft")).toBe("4-step turbo LoRA");
    expect(speedTierHint("krea2-turbo", "Quality")).toBe(
      "No effect for this model",
    );
    expect(speedTierHint(null, "Draft")).toBe("No effect for this model");
    expect(speedTierHint("flux3-distilled", "Quality")).toBe(
      "No effect for this model",
    );
  });
  it("no hint for Standard or an unknown custom graph", () => {
    expect(speedTierHint("checkpoint", "Standard")).toBeNull();
    expect(speedTierHint(undefined, "Draft")).toBeNull();
  });
});

// ── applySpeedTier ───────────────────────────────────────────────────────

describe("applySpeedTier", () => {
  it("draft halves steps, quality 1.5x, standard untouched", () => {
    const a = ckptGraph("sdxl.safetensors", 20);
    applySpeedTier(a, T, { speedTier: "draft" });
    expect(steps(a)).toBe(10);
    const b = ckptGraph("sdxl.safetensors", 20);
    applySpeedTier(b, T, { speedTier: "quality" });
    expect(steps(b)).toBe(30);
    const c = ckptGraph("sdxl.safetensors", 20);
    expect(applySpeedTier(c, T, { speedTier: "standard" })).toBeNull();
    expect(applySpeedTier(c, T, {})).toBeNull();
    expect(steps(c)).toBe(20);
  });

  it("draft never goes below 4 steps", () => {
    const wf = unetGraph("krea2_turbo_bf16.safetensors", 6, 1);
    applySpeedTier(wf, T, { speedTier: "draft" });
    expect(steps(wf)).toBe(4);
  });

  it("explicit --steps / --draft / --turbo win", () => {
    for (const p of [{ steps: 33 }, { draft: true }, { turbo: true }]) {
      const wf = ckptGraph("sdxl.safetensors", 20);
      expect(applySpeedTier(wf, T, { speedTier: "draft", ...p })).toBeNull();
      expect(steps(wf)).toBe(20);
    }
  });

  it("unmapped engines are untouched", () => {
    const q = pack("qwen-image-21/t2i_turbo.json");
    expect(
      applySpeedTier(
        q,
        { stepsTargetId: "8", cfgTargetId: "8" },
        {
          speedTier: "draft",
        },
      ),
    ).toBeNull();
    expect(q["8"].inputs.steps).toBe(4);
    const k = unetGraph("krea2_turbo_bf16.safetensors", 8, 1);
    expect(applySpeedTier(k, T, { speedTier: "quality" })).toBeNull();
    expect(steps(k)).toBe(8);
  });

  it("leaves MOSS / H3 to their own resolvers", () => {
    const m = pack("moss-image/t2i.json");
    expect(
      applySpeedTier(
        m,
        { stepsTargetId: "7", cfgTargetId: "7" },
        {
          speedTier: "draft",
        },
      ),
    ).toBeNull();
    expect(m["7"].inputs.steps).toBe(50);
  });

  it("qwen draft without the LoRA installed: step fallback only", () => {
    const wf = pack("qwen-image-21/t2i.json");
    const before = Object.keys(wf).length;
    applySpeedTier(
      wf,
      { stepsTargetId: "7", cfgTargetId: "7" },
      {
        speedTier: "draft",
      },
    );
    expect(wf["7"].inputs.steps).toBe(20);
    expect(wf["7"].inputs.cfg).toBe(3.5);
    expect(Object.keys(wf).length).toBe(before);
  });

  it("qwen draft with the LoRA installed: inserts it, 4 steps, cfg 1", () => {
    const wf = pack("qwen-image-21/t2i.json");
    applySpeedTier(
      wf,
      { stepsTargetId: "7", cfgTargetId: "7" },
      {
        speedTier: "draft",
        [SPEED_TIER_DISTILLED_PARAM]: true,
      },
    );
    const loras = Object.entries(wf).filter(
      ([, n]) => n.class_type === "LoraLoaderModelOnly",
    );
    expect(loras).toHaveLength(1);
    const [loraId, lora] = loras[0];
    expect(lora.inputs.lora_name).toBe(QWEN_TURBO_LORA);
    expect(lora.inputs.model).toEqual(["1", 0]);
    // Nothing reads the UNET directly any more.
    for (const [id, n] of Object.entries(wf)) {
      if (id === loraId) continue;
      for (const v of Object.values(n.inputs ?? {})) {
        expect(v).not.toEqual(["1", 0]);
      }
    }
    expect(wf["7"].inputs.steps).toBe(4);
    expect(wf["7"].inputs.cfg).toBe(1);
  });

  it("an explicit --cfg survives the distilled swap", () => {
    const wf = pack("qwen-image-21/t2i.json");
    wf["7"].inputs.cfg = 2.5;
    applySpeedTier(
      wf,
      { stepsTargetId: "7", cfgTargetId: "7" },
      {
        speedTier: "draft",
        cfg: 2.5,
        [SPEED_TIER_DISTILLED_PARAM]: true,
      },
    );
    expect(wf["7"].inputs.cfg).toBe(2.5);
  });

  it("flux3 draft with the distilled unet installed swaps it", () => {
    const wf = pack("flux3/t2i.json");
    applySpeedTier(
      wf,
      { stepsTargetId: "7", cfgTargetId: "7" },
      {
        speedTier: "draft",
        [SPEED_TIER_DISTILLED_PARAM]: true,
      },
    );
    expect(wf["1"].inputs.unet_name).toBe(FLUX3_KLEIN_DISTILLED_UNET);
    expect(wf["7"].inputs.steps).toBe(16);
    expect(wf["7"].inputs.cfg).toBe(1);
  });

  it("flux3 quality: stays at the official 50 steps, same unet", () => {
    const wf = pack("flux3/t2i.json");
    applySpeedTier(
      wf,
      { stepsTargetId: "7", cfgTargetId: "7" },
      {
        speedTier: "quality",
      },
    );
    expect(wf["7"].inputs.steps).toBe(50);
    expect(wf["1"].inputs.unet_name).toBe("flux3_image_klein_bf16.safetensors");
  });
});

describe("speedTierDistilledFiles", () => {
  it("lists files the draft variant needs", () => {
    expect(
      speedTierDistilledFiles(pack("qwen-image-21/t2i.json"), {
        speedTier: "draft",
      }),
    ).toEqual({ loras: [QWEN_TURBO_LORA], unets: [], alts: {} });
    expect(
      speedTierDistilledFiles(pack("flux3/t2i.json"), { speedTier: "draft" }),
    ).toEqual({
      loras: [],
      unets: [FLUX3_KLEIN_DISTILLED_UNET],
      alts: { [FLUX3_KLEIN_DISTILLED_UNET]: [FLUX3_KLEIN_DISTILLED_UNET_BF16] },
    });
  });
  it("empty for quality, pinned steps or no variant", () => {
    const empty = { loras: [], unets: [], alts: {} };
    const q = pack("qwen-image-21/t2i.json");
    expect(speedTierDistilledFiles(q, { speedTier: "quality" })).toEqual(empty);
    expect(
      speedTierDistilledFiles(q, { speedTier: "draft", steps: 12 }),
    ).toEqual(empty);
    expect(
      speedTierDistilledFiles(ckptGraph("sdxl.safetensors"), {
        speedTier: "draft",
      }),
    ).toEqual(empty);
  });
});

describe("MOSS / H3 tier hand-off", () => {
  it("mossSpeedForTier", () => {
    expect(mossSpeedForTier({ speedTier: "draft" })).toBe("fast");
    expect(mossSpeedForTier({ speedTier: "quality" })).toBe("off");
    expect(mossSpeedForTier({ speedTier: "standard" })).toBeUndefined();
    expect(mossSpeedForTier({ speedTier: "draft", steps: 20 })).toBeUndefined();
  });
  it("h3SpeedForTier", () => {
    expect(h3SpeedForTier({ speedTier: "draft" })).toBe("turbo8");
    expect(h3SpeedForTier({ speedTier: "quality" })).toBeUndefined();
    expect(h3SpeedForTier({ speedTier: "draft", steps: 30 })).toBeUndefined();
    expect(
      h3SpeedForTier({ speedTier: "draft", h3Speed: "off" }),
    ).toBeUndefined();
  });
});

// ── Engine integration ───────────────────────────────────────────────────

describe("injectParams applies the tier", () => {
  it("halves krea2 t2i steps at draft", () => {
    const wf = pack("krea2/t2i.json");
    injectParams(
      wf,
      discoverT2ISlots(wf),
      { speedTier: "draft" },
      "a cat",
      "",
      5,
    );
    const ks = Object.values(wf).find((n) => n.class_type === "KSampler")!;
    expect(ks.inputs.steps).toBe(4);
  });
  it("--steps beats the tier", () => {
    const wf = pack("qwen-image-21/t2i.json");
    injectParams(
      wf,
      discoverT2ISlots(wf),
      { speedTier: "draft", steps: 30 },
      "a cat",
      "",
      5,
    );
    expect(wf["7"].inputs.steps).toBe(30);
  });
  it("standard leaves the pack default", () => {
    const wf = pack("qwen-image-21/t2i.json");
    injectParams(wf, discoverT2ISlots(wf), {}, "a cat", "", 5);
    expect(wf["7"].inputs.steps).toBe(40);
  });
});

// ── Settings migration + weird ───────────────────────────────────────────

describe("migrateGenerationSettings", () => {
  const legacy = (speed: string, weird = 0) =>
    ({ speed, weird }) as unknown as Partial<GenerationSettings>;

  it("maps Relax/Fast/Turbo", () => {
    expect(migrateGenerationSettings(legacy("Relax")).speed).toBe("Quality");
    expect(migrateGenerationSettings(legacy("Fast")).speed).toBe("Standard");
    expect(migrateGenerationSettings(legacy("Turbo")).speed).toBe("Draft");
  });
  it("resets the reserved weird value and fills defaults", () => {
    const s = migrateGenerationSettings(legacy("Fast", 1500));
    expect(s.weird).toBe(0);
    expect(s.stylize).toBeTypeOf("number");
    expect(s.aspect).toBeTruthy();
  });
  it("keeps other stored values", () => {
    const s = migrateGenerationSettings({
      speed: "Draft",
      stylize: 420,
    } as Partial<GenerationSettings>);
    expect(s.speed).toBe("Draft");
    expect(s.stylize).toBe(420);
  });
});

describe("migratePresetSettings", () => {
  it("maps speed and drops weird", () => {
    const m = migratePresetSettings({
      stylize: 200,
      weird: 500,
      speed: "Relax",
    });
    expect(m).toEqual({ stylize: 200, speed: "Quality" });
    expect(migratePresetSettings({ speed: "Turbo" }).speed).toBe("Draft");
    expect(migratePresetSettings({}).speed).toBe("Standard");
  });
});

describe("weird is reserved", () => {
  it("still parses so old prompts work", () => {
    expect(parseImagineInput("a fox --weird 250").params.weird).toBe(250);
  });
  it("is not suggested", () => {
    const flags = getParamSuggestions(registry as never, "--").map((s) => s.label);
    expect(flags).not.toContain("--weird");
    expect(flags).toContain("--tier");
  });
  it("is not emitted from settings; tier is", () => {
    const base = migrateGenerationSettings({});
    const str = selectSettingsString({
      settings: { ...base, weird: 900, speed: "Draft" },
    } as never);
    expect(str).not.toContain("--weird");
    expect(str).toContain("--tier draft");
  });
});

describe("resolveSpeedTierParams (install check)", () => {
  async function root(files: Record<string, string[]>) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "speedtier-"));
    for (const [sub, names] of Object.entries(files)) {
      mkdirSync(path.join(dir, "models", sub), { recursive: true });
      for (const n of names) writeFileSync(path.join(dir, "models", sub, n), "");
    }
    return dir;
  }

  it("uses the qwen turbo LoRA only when installed", async () => {
    const { resolveSpeedTierParams } = await import("@/lib/oj/mossImageDefaults");
    const wf = pack("qwen-image-21/t2i.json");
    const without = await resolveSpeedTierParams(await root({ loras: [] }), wf, {
      speedTier: "draft",
    });
    expect(without).toEqual({});
    const withLora = await resolveSpeedTierParams(
      await root({ loras: [QWEN_TURBO_LORA] }),
      wf,
      { speedTier: "draft" },
    );
    expect(withLora).toEqual({ [SPEED_TIER_DISTILLED_PARAM]: true });
  });

  it("uses the distilled Klein unet only when installed", async () => {
    const { resolveSpeedTierParams } = await import("@/lib/oj/mossImageDefaults");
    const wf = pack("flux3/t2i.json");
    expect(
      await resolveSpeedTierParams(
        await root({ diffusion_models: [FLUX3_KLEIN_DISTILLED_UNET] }),
        wf,
        { speedTier: "draft" },
      ),
    ).toEqual({ [SPEED_TIER_DISTILLED_PARAM]: true });
    expect(
      await resolveSpeedTierParams(await root({}), wf, { speedTier: "draft" }),
    ).toEqual({});
  });

  it("nothing for standard / quality / pinned steps", async () => {
    const { resolveSpeedTierParams } = await import("@/lib/oj/mossImageDefaults");
    const dir = await root({ loras: [QWEN_TURBO_LORA] });
    const wf = pack("qwen-image-21/t2i.json");
    expect(await resolveSpeedTierParams(dir, wf, {})).toEqual({});
    expect(
      await resolveSpeedTierParams(dir, wf, { speedTier: "quality" }),
    ).toEqual({});
    expect(
      await resolveSpeedTierParams(dir, wf, { speedTier: "draft", steps: 9 }),
    ).toEqual({});
  });
});
