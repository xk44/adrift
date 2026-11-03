import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import objectInfo from "./fixtures/pipelineNodes.objectInfo.json";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  PIPELINE_SCRIPT_ACTION,
  PIPELINE_SCRIPT_MAX_TOKENS,
  PIPELINE_SCRIPT_MODEL,
  buildPipelineScriptWorkflow,
} from "@/lib/oj/pipelineScript";
import {
  ASSEMBLE_MUSIC_DB_DEFAULT,
  PIPELINE_ASSEMBLE_ACTION,
  buildPipelineAssembleWorkflow,
  planAssembly,
} from "@/lib/oj/pipelineAssemble";
import {
  CLICK_TO_AD_KEY,
  CLIPCUT_KEY,
  SHORTS_STUDIO_KEY,
  URBAN_CUTS_KEY,
  pipelineCards,
} from "@/lib/tools/pipelineCards";
import { buildHubCards } from "@/lib/tools/hub";
import type { EngineContext } from "@/lib/tools/templates";

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<string, { template: string; requiresImage?: boolean }>;
};
const load = (action: string): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(PACKS, reg.templates[reg.actions[action].template].file),
      "utf8",
    ),
  ) as Workflow;

type Spec = [unknown, Record<string, unknown>?];
interface NodeInfo {
  input: Record<string, Record<string, Spec>>;
  output: string[];
}
const INFO = objectInfo as unknown as Record<string, NodeInfo>;

/**
 * Check every node against live object_info: class exists, every input key
 * is a declared input (dotted DynamicCombo / Autogrow keys resolve to their
 * option / template), required inputs are present and links point at a real
 * output slot.
 */
function validate(wf: Workflow): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    const info = INFO[node.class_type];
    if (!info) {
      errors.push(`${id}: unknown class ${node.class_type}`);
      continue;
    }
    const all: Record<string, Spec> = {
      ...info.input.required,
      ...info.input.optional,
      ...info.input.hidden,
    };
    for (const [key, value] of Object.entries(node.inputs)) {
      const [base, sub] = key.split(".");
      const spec = all[base];
      if (!spec) {
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
        continue;
      }
      if (sub !== undefined) {
        const cfg = spec[1] ?? {};
        if (spec[0] === "COMFY_DYNAMICCOMBO_V3") {
          const opt = (
            cfg.options as {
              key: string;
              inputs: Record<string, Record<string, unknown>>;
            }[]
          ).find((o) => o.key === node.inputs[base]);
          const subs = { ...opt?.inputs.required, ...opt?.inputs.optional };
          if (!(sub in subs))
            errors.push(
              `${id}.${key}: not in option ${String(node.inputs[base])}`,
            );
        } else if (spec[0] === "COMFY_AUTOGROW_V3") {
          const prefix = (cfg.template as { prefix: string }).prefix;
          if (!new RegExp(`^${prefix}\\d+$`).test(sub))
            errors.push(`${id}.${key}: bad autogrow key`);
        } else errors.push(`${id}.${key}: dotted key on plain input`);
      }
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string"
      ) {
        const src = wf[value[0]];
        if (!src) errors.push(`${id}.${key}: link to missing node ${value[0]}`);
        else {
          const out = INFO[src.class_type]?.output ?? [];
          if (typeof value[1] !== "number" || value[1] >= out.length)
            errors.push(`${id}.${key}: bad output slot ${String(value[1])}`);
        }
      }
    }
    for (const [req, spec] of Object.entries(info.input.required ?? {})) {
      const has = Object.keys(node.inputs).some(
        (k) => k === req || k.startsWith(`${req}.`),
      );
      if (!has && spec[0] !== "COMFY_AUTOGROW_V3")
        errors.push(`${id}: missing required ${req}`);
    }
  }
  return errors;
}

const IMG = "http://h:8188/view?filename=product.png&subfolder=&type=input";
const run = (images: string[] = []): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: "2026-10-24T00:00:00Z",
    status: "done",
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images }],
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );

describe("pipeline registry wiring", () => {
  it.each([PIPELINE_SCRIPT_ACTION, PIPELINE_ASSEMBLE_ACTION])(
    "%s has a template file, needs no image and resolves a builder",
    (action) => {
      expect(reg.actions[action]).toBeTruthy();
      expect(reg.actions[action].requiresImage).toBe(false);
      expect(validate(load(action))).toEqual([]);
      expect(actionBuilderFor(action)).toBeTypeOf("function");
    },
  );
});

describe("pipeline_script builder", () => {
  it("text-only shorts: drops LoadImage, compiles prompt, budget and seed", () => {
    const { workflow, seed, slots } = buildPipelineScriptWorkflow(
      load(PIPELINE_SCRIPT_ACTION),
      run(),
      0,
      {
        kind: "shorts",
        topic: "how tides work",
        scenes: 4,
        preset: "facts",
        seed: 7,
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(byClass(workflow, "LoadImage")).toHaveLength(0);
    const [[genId, gen]] = byClass(workflow, "TextGenerate");
    expect(gen.inputs.image).toBeUndefined();
    expect(gen.inputs.prompt).toContain("how tides work");
    expect(gen.inputs.prompt).toContain("exactly 4 scenes");
    expect(gen.inputs.max_length).toBe(PIPELINE_SCRIPT_MAX_TOKENS);
    expect(gen.inputs["sampling_mode.seed"]).toBe(7);
    expect(seed).toBe(7);
    expect(slots.ksamplerId).toBe(genId);
    const [[, preview]] = byClass(workflow, "PreviewAny");
    expect(preview.inputs.source).toEqual([genId, 0]);
    const [[, clip]] = byClass(workflow, "CLIPLoader");
    expect(clip.inputs.clip_name).toBe(PIPELINE_SCRIPT_MODEL);
    expect(
      missingAgainstObjectInfo(workflow, objectInfo as Record<string, unknown>),
    ).toEqual([]);
  });

  it("ad: wires the product photo into TextGenerate", () => {
    const { workflow, slots } = buildPipelineScriptWorkflow(
      load(PIPELINE_SCRIPT_ACTION),
      run([IMG]),
      0,
      {
        kind: "ad",
        topic: "steel bottle",
        scenes: 3,
        preset: "ugc",
        presenter: true,
      },
    );
    expect(validate(workflow)).toEqual([]);
    const [[loadId, img]] = byClass(workflow, "LoadImage");
    expect(img.inputs.image).toBe("product.png [input]");
    const [[, gen]] = byClass(workflow, "TextGenerate");
    expect(gen.inputs.image).toEqual([loadId, 0]);
    expect(gen.inputs.prompt).toMatch(/fictional person/);
    expect(slots.imageInputId).toBe(loadId);
  });

  it("rejects bad requests", () => {
    const wf = load(PIPELINE_SCRIPT_ACTION);
    expect(() =>
      buildPipelineScriptWorkflow(wf, run(), 0, { kind: "shorts" }),
    ).toThrow(/topic/);
    expect(() =>
      buildPipelineScriptWorkflow(wf, run(), 0, { kind: "ad", topic: "x" }),
    ).toThrow(/product photo/);
    expect(() =>
      buildPipelineScriptWorkflow(wf, run(), 0, { kind: "movie", topic: "x" }),
    ).toThrow(/unknown kind/);
  });
});

const scene = (i: number, extra: Record<string, unknown> = {}) => ({
  video: `video/clip${i}_00001_.mp4 [output]`,
  audio: `audio/voice${i}_00001_.mp3 [output]`,
  caption: `Scene ${i} caption line that is long enough to wrap onto two lines`,
  clipSeconds: 4.04,
  seconds: 4.04,
  ...extra,
});

describe("pipeline_assemble planning", () => {
  it("never reads past the clip and holds the last frame for long narration", () => {
    const p = planAssembly({
      scenes: [scene(0), scene(1, { seconds: 6.5 })],
      fps: 24,
    });
    expect(p.scenes[0]).toMatchObject({
      clipFrames: 95,
      holdFrames: 2,
      seconds: 4.042,
    });
    expect(p.scenes[1]).toMatchObject({
      clipFrames: 95,
      holdFrames: 61,
      seconds: 6.5,
    });
    expect(p.totalSeconds).toBeCloseTo(10.542, 3);
    expect(p.musicDb).toBe(ASSEMBLE_MUSIC_DB_DEFAULT);
    expect(p.prefix).toBe("video/adrift_short");
    expect([p.width, p.height]).toEqual([720, 1280]);
  });

  it("shorter scenes trim the clip instead", () => {
    const p = planAssembly({
      scenes: [scene(0, { clipSeconds: 8, seconds: 3 })],
    });
    expect(p.scenes[0]).toMatchObject({
      clipFrames: 72,
      holdFrames: 0,
      seconds: 3,
    });
  });

  it.each([
    [{ scenes: [] }, /no scenes/],
    [{ scenes: [scene(0, { video: "../../x.mp4 [output]" })] }, /clip ref/],
    [{ scenes: [scene(0, { audio: "voice.png [output]" })] }, /audio file/],
    [{ scenes: [scene(0, { clipSeconds: 0 })] }, /clipSeconds/],
    [{ scenes: [scene(0)], size: "4k" }, /unknown size/],
    [{ scenes: [scene(0)], music: "/etc/passwd" }, /music/],
    [
      {
        scenes: Array.from({ length: 7 }, (_, i) =>
          scene(i, { seconds: 15, clipSeconds: 15 }),
        ),
      },
      /longer than/,
    ],
    [{ scenes: Array.from({ length: 13 }, (_, i) => scene(i)) }, /at most/],
  ])("rejects %#", (params, err) => {
    expect(() => planAssembly(params as Record<string, unknown>)).toThrow(err);
  });

  it("startSeconds skips into the clip (beat cuts continue the motion)", () => {
    const p = planAssembly({
      scenes: [
        scene(0, { seconds: 1 }),
        scene(1, { seconds: 1, startSeconds: 2 }),
        scene(2, { seconds: 3, startSeconds: 2 }),
      ],
      fps: 24,
    });
    expect(p.scenes[0]).toMatchObject({ skipFrames: 0, clipFrames: 24 });
    expect(p.scenes[1]).toMatchObject({
      skipFrames: 48,
      clipFrames: 24,
      holdFrames: 0,
    });
    // Only 96 - 1 - 48 = 47 frames left, the rest holds.
    expect(p.scenes[2]).toMatchObject({
      skipFrames: 48,
      clipFrames: 47,
      holdFrames: 25,
    });
    expect(() =>
      planAssembly({ scenes: [scene(0, { startSeconds: 4.04 })] }),
    ).toThrow(/past the clip end/);
    const { workflow } = buildPipelineAssembleWorkflow(
      load(PIPELINE_ASSEMBLE_ACTION),
      run(),
      0,
      {
        scenes: [scene(0, { seconds: 1, startSeconds: 1.5 })],
        captions: false,
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(
      byClass(workflow, "VHS_LoadVideo").map(
        ([, n]) => n.inputs.skip_first_frames,
      ),
    ).toEqual([36]);
  });

  it("ignores an unsafe prefix", () => {
    expect(planAssembly({ scenes: [scene(0)], prefix: "../x" }).prefix).toBe(
      "video/adrift_short",
    );
    expect(
      planAssembly({ scenes: [scene(0)], prefix: "video/adrift_ad" }).prefix,
    ).toBe("video/adrift_ad");
  });
});

describe("pipeline_assemble builder", () => {
  it("full graph: captions, hold, narration padding, music bed, concat", () => {
    const { workflow, slots } = buildPipelineAssembleWorkflow(
      load(PIPELINE_ASSEMBLE_ACTION),
      run(),
      0,
      {
        scenes: [scene(0), scene(1, { seconds: 6 })],
        music: "audio/bed_00001_.mp3 [output]",
        musicDb: -18,
        size: "1080x1920",
        fps: 24,
        prefix: "video/adrift_ad",
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(
      byClass(workflow, "VHS_LoadVideo").map(([, n]) => n.inputs.video),
    ).toEqual([
      "video/clip0_00001_.mp4 [output]",
      "video/clip1_00001_.mp4 [output]",
    ]);
    expect(
      byClass(workflow, "VHS_LoadVideo").every(
        ([, n]) => n.inputs.force_rate === 24,
      ),
    ).toBe(true);
    expect(
      byClass(workflow, "ImageScale").every(
        ([, n]) => n.inputs.width === 1080 && n.inputs.height === 1920,
      ),
    ).toBe(true);
    // Both scenes overshoot their clip by >=1 frame, so both hold.
    expect(
      byClass(workflow, "RepeatImageBatch").map(([, n]) => n.inputs.amount),
    ).toEqual([2, 49]);
    const captions = byClass(workflow, "TextOverlay");
    expect(captions).toHaveLength(2);
    expect(String(captions[0][1].inputs.text)).toContain("\n");
    expect(byClass(workflow, "CreateVideo")).toHaveLength(2);
    expect(
      byClass(workflow, "LoadAudio").map(([, n]) => n.inputs.audio),
    ).toEqual([
      "audio/voice0_00001_.mp3 [output]",
      "audio/voice1_00001_.mp3 [output]",
      "audio/bed_00001_.mp3 [output]",
    ]);
    const empties = byClass(workflow, "EmptyAudio").map(
      ([, n]) => n.inputs.duration,
    );
    expect(empties).toEqual([4.042, 6]);
    const [[, vol]] = byClass(workflow, "AudioAdjustVolume");
    expect(vol.inputs.volume).toBe(-18);
    const [[mixId, mix]] = byClass(workflow, "AudioMerge");
    expect(mix.inputs.merge_method).toBe("add");
    const [[concatId, concat]] = byClass(workflow, "ConcatenateVideo");
    const videoIds = byClass(workflow, "CreateVideo").map(([k]) => k);
    expect(concat.inputs["videos.video0"]).toEqual([videoIds[0], 0]);
    expect(concat.inputs["videos.video1"]).toEqual([videoIds[1], 0]);
    expect(concat.inputs.complete_audio).toEqual([mixId, 0]);
    const [[saveId, save]] = byClass(workflow, "SaveVideo");
    expect(save.inputs.video).toEqual([concatId, 0]);
    expect(save.inputs.filename_prefix).toBe("video/adrift_ad");
    expect(slots.ksamplerId).toBe(saveId);
  });

  it("minimal graph: no captions, no narration, no music, no hold", () => {
    const { workflow } = buildPipelineAssembleWorkflow(
      load(PIPELINE_ASSEMBLE_ACTION),
      run(),
      0,
      {
        scenes: [scene(0, { audio: null, clipSeconds: 5, seconds: 4 })],
        captions: false,
      },
    );
    expect(validate(workflow)).toEqual([]);
    for (const cls of [
      "TextOverlay",
      "RepeatImageBatch",
      "LoadAudio",
      "AudioMerge",
      "AudioConcat",
    ])
      expect(byClass(workflow, cls)).toHaveLength(0);
    const [[silenceId]] = byClass(workflow, "EmptyAudio");
    const [[, concat]] = byClass(workflow, "ConcatenateVideo");
    expect(concat.inputs.complete_audio).toEqual([silenceId, 0]);
    expect(byClass(workflow, "VHS_LoadVideo")[0][1].inputs.frame_load_cap).toBe(
      96,
    );
  });
});

describe("pipeline hub cards", () => {
  const ctx = (packs: string[] | null): EngineContext => ({
    catalog: packs ? [] : null,
    packIds: packs ? new Set(packs) : null,
    editLoras: null,
  });

  it("shows checking state, then availability from installed packs", () => {
    const checking = pipelineCards(ctx(null));
    expect(checking.map((c) => c.key)).toEqual([
      SHORTS_STUDIO_KEY,
      CLICK_TO_AD_KEY,
      CLIPCUT_KEY,
      URBAN_CUTS_KEY,
    ]);
    expect(checking[0].checking).toBe(true);
    const none = pipelineCards(ctx([]));
    expect(none[0].available).toBe(false);
    expect(none[0].unavailableReason).toBeTruthy();
    expect(none[1].available).toBe(false);
    const some = pipelineCards(ctx(["qwen-image-edit", "flux2", "ltx25"]));
    expect(some[0].available).toBe(true);
    expect(some[1].available).toBe(true);
    // Click to Ad renders every clip with LTX-2.5: no pack, no card.
    const noLtx = pipelineCards(ctx(["qwen-image-edit", "flux2"]));
    expect(noLtx[1].available).toBe(false);
    expect(noLtx[1].unavailableReason).toMatch(/LTX-2\.5/);
    expect(noLtx[2].available).toBe(true);
    expect(some[1].subtitle).toMatch(/LTX-2\.5/);
    expect(some[1].model).toMatch(/LTX-2\.5/);
    expect(some[2].available).toBe(true);
    expect(some[3].available).toBe(true);
    expect(none[2].available).toBe(false);
    expect(some.every((c) => c.hubCategory === "Video")).toBe(true);
  });

  it("are listed in the hub", () => {
    const keys = buildHubCards({ toolCards: [], ctx: ctx(["flux2"]) }).map(
      (c) => c.key,
    );
    expect(keys).toContain(SHORTS_STUDIO_KEY);
    expect(keys).toContain(CLICK_TO_AD_KEY);
    expect(keys).toContain(CLIPCUT_KEY);
    expect(keys).toContain(URBAN_CUTS_KEY);
  });
});
