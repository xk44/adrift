/**
 * LTX-2.5 (22B distilled, open weights) video pack: API graphs converted from
 * the official video_ltx2_5_{t2v,i2v,flf2v} templates, the engine hook that
 * keeps the two-stage latents / audio in sync, the Animate + Transition
 * action builders, and the Tools page / hub wiring.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import ltx25Nodes from "./fixtures/ltx25Nodes.objectInfo.json";
import {
  detectModelFamily,
  getPack,
  getPackForModelFamily,
  resolveWorkflow,
} from "@/lib/oj/packs";
import { discoverVideoSlots } from "@/lib/oj/discovery";
import { injectParams } from "@/lib/oj/engine";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { DEFAULT_VIDEO_PACKS } from "@/lib/comfy/backends";
import {
  LTX25_ANIMATE_ACTION,
  LTX25_TRANSITION_ACTION,
  ltx25Dims,
  ltx25SourceDims,
  LTX25_HANDOFF_MAX_SCALE,
  LTX25_TARGET_PIXELS,
  ltx25Length,
  ltx25LengthForSeconds,
  parseAspect,
} from "@/lib/oj/ltx25";
import {
  LTX25_ANIMATE_PROMPT,
  buildLtx25AnimateWorkflow,
  buildLtx25TransitionWorkflow,
} from "@/lib/oj/ltx25Tools";
import {
  ToolInputError,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { buildHubCards } from "@/lib/tools/hub";
import { MODEL_FAMILIES } from "@/lib/tools/toolsDoc";

const PUBLIC = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string; kind?: string }>;
  actions: Record<string, { template: string; requiresImage?: boolean }>;
};
const loadFile = (file: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(PUBLIC, file), "utf8")) as Workflow;
const pack = (name: "t2v" | "i2v" | "flf2v") =>
  loadFile(`packs/ltx25/${name}.json`);

type InputSpec = [unknown, Record<string, unknown>?];
const INFO = ltx25Nodes as unknown as Record<
  string,
  {
    input: Record<string, Record<string, InputSpec>>;
    output: string[];
  }
>;

/** object_info check: classes, declared inputs, combos, link types, required. */
function validate(wf: Workflow): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    const info = INFO[node.class_type];
    if (!info) {
      errors.push(`${id}: unknown class ${node.class_type}`);
      continue;
    }
    const all = { ...info.input.required, ...info.input.optional };
    for (const [key, value] of Object.entries(node.inputs)) {
      const spec = all[key.split(".")[0]];
      if (!spec) {
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
        continue;
      }
      if (Array.isArray(value)) {
        const src = wf[String(value[0])];
        if (!src) {
          errors.push(`${id}.${key}: link to missing node ${value[0]}`);
          continue;
        }
        const outType = INFO[src.class_type]?.output[Number(value[1])];
        const want = spec[0];
        // ResizeImageMaskNode outputs MATCHTYPE (resolves to its input type).
        if (
          typeof want === "string" &&
          outType &&
          outType !== want &&
          outType !== "*" &&
          !outType.startsWith("COMFY_MATCHTYPE") &&
          !want.startsWith("COMFY_MATCHTYPE")
        )
          errors.push(`${id}.${key}: ${outType} into ${want}`);
        continue;
      }
      // LoadImage ships an empty placeholder; the tools fill it.
      if (key === "image") continue;
      if (Array.isArray(spec[0]) && !spec[0].includes(value))
        errors.push(`${id}.${key}: ${String(value)} not in options`);
    }
    for (const req of Object.keys(info.input.required ?? {})) {
      if (
        !Object.keys(node.inputs).some(
          (k) => k === req || k.startsWith(`${req}.`),
        )
      )
        errors.push(`${id}: missing required ${req}`);
    }
  }
  return errors;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );
const inputs = (wf: Workflow, id: string) =>
  wf[id].inputs as Record<string, unknown>;

const IMAGE_URL = "/api/comfy/view?filename=still.png&subfolder=&type=input";
function imageRun(width = 1344, height = 768): ImagineRun {
  return {
    run_id: "src",
    prompt: "a lighthouse on a cliff",
    parsedPrompt: "a lighthouse on a cliff",
    width,
    height,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [IMAGE_URL] },
    ],
    params: {},
  } as unknown as ImagineRun;
}

describe("LTX-2.5 pack graphs", () => {
  it.each(["t2v", "i2v", "flf2v"] as const)(
    "%s validates against /object_info",
    (name) => {
      expect(validate(pack(name))).toEqual([]);
    },
  );

  it.each(["t2v", "i2v", "flf2v"] as const)(
    "%s loads the 22B distilled DiT, Gemma 4 encoder and both VAEs",
    (name) => {
      const wf = pack(name);
      const files = workflowModelRequirements(wf).map((r) => r.file);
      expect(files).toEqual(
        expect.arrayContaining([
          "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
          "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
          "ltx-2.5-video-vae-bf16.safetensors",
          "ltx-2.5-audio-vae-bf16.safetensors",
        ]),
      );
      expect(missingAgainstObjectInfo(wf, ltx25Nodes)).toEqual([]);
    },
  );

  it("two-stage graphs check the x2 latent upscaler model too", () => {
    for (const name of ["t2v", "i2v"] as const) {
      const req = workflowModelRequirements(pack(name)).find((r) =>
        r.file.startsWith("ltx-2.5-latent-spatial-upscaler"),
      );
      expect(req?.dir).toBe("latent_upscale_models");
    }
    expect(byClass(pack("flf2v"), "LTXVLatentUpsampler")).toHaveLength(0);
  });

  it("distilled schedules: 8 + 3 sigmas, CFG 1, audio rides along", () => {
    const wf = pack("i2v");
    const sigmas = byClass(wf, "ManualSigmas").map(
      ([, n]) =>
        String((n.inputs as { sigmas: string }).sigmas).split(",").length,
    );
    expect(sigmas).toEqual([9, 4]);
    for (const [, g] of byClass(wf, "LTXVDualCFGGuider"))
      expect(g.inputs).toMatchObject({ video_cfg: 1, audio_cfg: 1 });
    expect(byClass(wf, "LTXVAudioVAEDecode")).toHaveLength(1);
    const [[, create]] = byClass(wf, "CreateVideo");
    expect(Array.isArray((create.inputs as { audio: unknown }).audio)).toBe(
      true,
    );
  });

  it("is registered as the ltx25 pack and routed to the video backend", () => {
    const p = getPack("ltx25")!;
    expect(p.workflows).toMatchObject({
      t2v: "packs/ltx25/t2v.json",
      i2v: "packs/ltx25/i2v.json",
      transition: "packs/ltx25/flf2v.json",
      ltx25_animate: "packs/ltx25/i2v.json",
      ltx25_transition: "packs/ltx25/flf2v.json",
    });
    expect(p.defaultOverrides).toMatchObject({ steps: 8, cfg: 1 });
    expect(DEFAULT_VIDEO_PACKS).toContain("ltx25");
    for (const [key, file] of [
      ["ltx25_t2v", "t2v"],
      ["ltx25_animate", "i2v"],
      ["ltx25_transition", "flf2v"],
    ])
      expect(reg.templates[key].file).toBe(`packs/ltx25/${file}.json`);
    expect(reg.actions[LTX25_ANIMATE_ACTION].template).toBe("ltx25_animate");
    expect(reg.actions[LTX25_TRANSITION_ACTION].requiresImage).toBe(true);
  });

  it.each([
    ["t2v", "t2v"],
    ["i2v", "i2v"],
    [LTX25_ANIMATE_ACTION, "i2v"],
    [LTX25_TRANSITION_ACTION, "flf2v"],
  ])("resolveWorkflow(%s, ltx25) → packs/ltx25/%s", (action, file) => {
    const r = resolveWorkflow({ templateOrAction: action, packId: "ltx25" });
    expect(r.workflowPath).toMatch(new RegExp(`packs/ltx25/${file}\\.json$`));
  });

  it("family detection keeps LTX-2.5 apart from LTXV 0.9.x", () => {
    expect(
      detectModelFamily(
        "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
      ),
    ).toBe("ltx25");
    expect(detectModelFamily("ltxv-2b-0.9.8-distilled.safetensors")).toBe(
      "ltxv",
    );
    expect(getPackForModelFamily("ltx25").id).toBe("ltx25");
  });
});

describe("LTX-2.5 sizing helpers", () => {
  it("snaps frame counts to 8n+1 within 9..241", () => {
    expect(ltx25Length(121)).toBe(121);
    expect(ltx25Length(50)).toBe(49);
    expect(ltx25Length(2)).toBe(9);
    expect(ltx25Length(10_000)).toBe(241);
    expect(ltx25LengthForSeconds("5")).toBe(121);
    expect(ltx25LengthForSeconds(10)).toBe(241);
    expect(ltx25LengthForSeconds("nope")).toBe(121);
  });

  it("sizes by aspect at ~0.9 MP, /32, half-res first stage", () => {
    expect(parseAspect("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspect("9x16")).toBeCloseTo(9 / 16);
    expect(ltx25Dims(16 / 9, true)).toEqual({
      width: 1280,
      height: 704,
      stageWidth: 640,
      stageHeight: 352,
    });
    const single = ltx25Dims(16 / 9, false);
    expect([single.width, single.height]).toEqual([1280, 736]);
    expect([single.stageWidth, single.stageHeight]).toEqual([1280, 736]);
    const square = ltx25Dims(1, true);
    expect(square.width).toBe(square.height);
    expect(square.width % 64).toBe(0);
  });

  it("image handoff keeps a source already on the grid (FLUX.3 16:9 / 3:2)", () => {
    expect(ltx25SourceDims(1344, 768, true)).toEqual({
      width: 1344,
      height: 768,
      stageWidth: 672,
      stageHeight: 384,
    });
    expect(ltx25SourceDims(1216, 832, true)).toMatchObject({
      width: 1216,
      height: 832,
    });
    expect(ltx25SourceDims(1344, 768, false)).toEqual({
      width: 1344,
      height: 768,
      stageWidth: 1344,
      stageHeight: 768,
    });
  });

  it("image handoff: /64, aspect kept, never below the LTX default", () => {
    const sources: [number, number][] = [
      [1344, 768],
      [768, 1344],
      [1216, 832],
      [832, 1216],
      [1024, 1024],
      [1000, 667],
      [3024, 4032],
      [4032, 3024],
      [1920, 1080],
      [1179, 2556],
      [2000, 500],
    ];
    for (const [w, h] of sources) {
      for (const twoStage of [true, false]) {
        const d = ltx25SourceDims(w, h, twoStage);
        const grid = twoStage ? 64 : 32;
        const tag = `${w}x${h} ${twoStage}`;
        expect(d.width % grid, tag).toBe(0);
        expect(d.height % grid, tag).toBe(0);
        expect(d.stageWidth % 32, tag).toBe(0);
        expect(d.stageHeight % 32, tag).toBe(0);
        const base = ltx25Dims(w / h, twoStage);
        expect(d.width * d.height, tag).toBeGreaterThanOrEqual(
          base.width * base.height,
        );
        expect(d.width * d.height, tag).toBeLessThanOrEqual(
          LTX25_TARGET_PIXELS * LTX25_HANDOFF_MAX_SCALE,
        );
        // Aspect at least as close as the plain ratio-based size, and within
        // 2.5% of the source (beyond 3:1 the ratio is clamped first).
        const ratio = Math.min(3, Math.max(1 / 3, w / h));
        const err = (a: number, b: number) => Math.abs(Math.log(a / b / ratio));
        expect(err(d.width, d.height), tag).toBeLessThanOrEqual(
          err(base.width, base.height) + 1e-9,
        );
        expect(err(d.width, d.height), tag).toBeLessThan(0.025);
      }
    }
  });

  it("image handoff falls back to square for an unknown source size", () => {
    expect(ltx25SourceDims(0, 0, true)).toEqual(ltx25Dims(1, true));
    expect(ltx25SourceDims(NaN, 768, true).width).toBe(
      ltx25SourceDims(NaN, 768, true).height,
    );
  });
});

describe("LTX-2.5 engine injection", () => {
  it("--ar 16:9 t2v: stage-1 latent at half res, audio length follows video", () => {
    const wf = pack("t2v");
    const slots = discoverVideoSlots(wf);
    injectParams(
      wf,
      slots,
      { ar: "16:9", video: true, bs: 50 },
      "a fox runs",
      "",
      7,
    );
    const [[, latent]] = byClass(wf, "EmptyLTXVLatentVideo");
    const li = latent.inputs as Record<string, number>;
    expect([li.width, li.height]).toEqual([640, 352]);
    expect((li.length - 1) % 8).toBe(0);
    const [[, audio]] = byClass(wf, "LTXVEmptyLatentAudio");
    expect((audio.inputs as Record<string, number>).frames_number).toBe(
      li.length,
    );
    for (const [, n] of byClass(wf, "ManualSigmas"))
      expect(n.inputs).not.toHaveProperty("steps");
    for (const [, n] of byClass(wf, "LTXVDualCFGGuider"))
      expect(n.inputs).not.toHaveProperty("cfg");
    expect(validate(wf)).toEqual([]);
    expect(inputs(wf, slots.posTextId!).text).toContain("a fox runs");
  });

  it("leaves non-LTX-2.5 graphs alone", () => {
    const ltxv = loadFile(getPack("ltxv")!.workflows.t2v!);
    const before = JSON.stringify(ltxv);
    const slots = discoverVideoSlots(ltxv);
    injectParams(ltxv, slots, {}, "x", "", 1);
    expect(byClass(ltxv, "LTXVEmptyLatentAudio")).toHaveLength(0);
    expect(JSON.stringify(ltxv)).not.toBe(before); // prompt/seed still injected
  });
});

describe("LTX-2.5 action builders", () => {
  it("Animate: source image as first frame, aspect from source, seed on stage 1", () => {
    expect(actionBuilderFor(LTX25_ANIMATE_ACTION)).toBe(
      buildLtx25AnimateWorkflow,
    );
    const { workflow, seed } = buildLtx25AnimateWorkflow(
      pack("i2v"),
      imageRun(1344, 768),
      0,
      { duration: "8", seed: 123 },
    );
    expect(seed).toBe(123);
    const [[, load]] = byClass(workflow, "LoadImage");
    expect((load.inputs as { image: string }).image).toBe("still.png [input]");
    // 1344x768 is already on the /64 grid above the ~0.9 MP default: the
    // clip keeps the source size (half-size first pass), no crop.
    const [[, latent]] = byClass(workflow, "EmptyLTXVLatentVideo");
    expect(latent.inputs).toMatchObject({
      width: 672,
      height: 384,
      length: 193,
    });
    const noise = byClass(workflow, "RandomNoise").map(
      ([, n]) => (n.inputs as { noise_seed: number }).noise_seed,
    );
    expect(noise).toEqual([123, 42]);
    const [[, pos]] = byClass(workflow, "CLIPTextEncode").filter(
      ([, n]) => n._meta?.title === "Positive Prompt",
    );
    expect((pos.inputs as { text: string }).text).toBe(
      "a lighthouse on a cliff",
    );
    expect(validate(workflow)).toEqual([]);
  });

  it("Animate falls back to the default motion prompt", () => {
    const run = { ...imageRun(), prompt: "", parsedPrompt: "" };
    const { workflow } = buildLtx25AnimateWorkflow(pack("i2v"), run, 0, {});
    const texts = byClass(workflow, "CLIPTextEncode").map(
      ([, n]) => (n.inputs as { text: string }).text,
    );
    expect(texts).toContain(LTX25_ANIMATE_PROMPT);
  });

  it("Transition: start + end frames on the frame 0 / -1 guides", () => {
    expect(actionBuilderFor(LTX25_TRANSITION_ACTION)).toBe(
      buildLtx25TransitionWorkflow,
    );
    const { workflow } = buildLtx25TransitionWorkflow(
      pack("flf2v"),
      imageRun(768, 1344),
      0,
      { secondRefImage: "end.png [input]", prompt: "day to night", seed: 9 },
    );
    const images = byClass(workflow, "LoadImage").map(
      ([, n]) => (n.inputs as { image: string }).image,
    );
    expect(images).toEqual(["still.png [input]", "end.png [input]"]);
    const [[, latent]] = byClass(workflow, "EmptyLTXVLatentVideo");
    const li = latent.inputs as Record<string, number>;
    expect(li.height).toBeGreaterThan(li.width);
    for (const [, r] of byClass(workflow, "ResizeImageMaskNode")) {
      const ri = r.inputs as Record<string, number>;
      expect([ri["resize_type.width"], ri["resize_type.height"]]).toEqual([
        li.width,
        li.height,
      ]);
    }
    const [[, noise]] = byClass(workflow, "RandomNoise");
    expect((noise.inputs as { noise_seed: number }).noise_seed).toBe(9);
    expect(validate(workflow)).toEqual([]);
  });

  it("Transition needs an uploaded end frame", () => {
    expect(() =>
      buildLtx25TransitionWorkflow(pack("flf2v"), imageRun(), 0, {}),
    ).toThrow(/endImage/);
    expect(() =>
      buildLtx25TransitionWorkflow(pack("flf2v"), imageRun(), 0, {
        secondRefImage: "../../etc/passwd [input]",
      }),
    ).toThrow(/endImage/);
  });
});

describe("LTX-2.5 tools page + hub", () => {
  it("Animate tool sends pack_id ltx25 with a duration", () => {
    const spec = getActionTool("ltx25_animate")!;
    expect(spec).toMatchObject({
      requiredPack: "ltx25",
      requireStatusEntry: true,
      modelCheck: { pack: "ltx25", action: "ltx25_animate" },
    });
    expect(
      buildActionRequest(
        spec,
        { ...defaultSettings(spec), text: "waves" },
        null,
      ),
    ).toEqual({
      action: "ltx25_animate",
      params: { pack_id: "ltx25", duration: "5", prompt: "waves" },
      overrides: {},
    });
  });

  it("Transition tool requires the end frame", () => {
    const spec = getActionTool("ltx25_transition")!;
    expect(spec.secondImage).toBe("End frame");
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      ToolInputError,
    );
    const req = buildActionRequest(
      spec,
      { ...defaultSettings(spec), picks: { duration: "10" } },
      null,
      "end.png [input]",
    );
    expect(req.params).toEqual({
      pack_id: "ltx25",
      secondRefImage: "end.png [input]",
      duration: "10",
    });
  });

  it("hub lists both tools under Video as open weights", () => {
    const ctx = {
      catalog: [],
      packIds: new Set(["ltx25"]),
      editLoras: { families: {}, loras: [] },
    };
    const toolCards = buildToolCards({ ...ctx, modelStatus: null });
    const cards = buildHubCards({ toolCards, ctx });
    for (const key of ["action:ltx25_animate", "action:ltx25_transition"]) {
      const card = cards.find((c) => c.key === key);
      expect(card?.hubCategory).toBe("Video");
      expect(card?.nc).toBe(false);
      expect(card?.model).toMatch(/LTX-2\.5.*open weights/);
    }
  });

  it("license table covers the LTX-2.5 weights", () => {
    const files = [
      "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
      "ltx-2.5-video-vae-bf16.safetensors",
      "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
      "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    ];
    for (const f of files) {
      const fam = MODEL_FAMILIES.find((m) => m.match.test(f));
      expect(fam?.commercial, f).toBe("restricted");
    }
  });
});
