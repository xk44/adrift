import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { getPack } from "@/lib/oj/packs";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import {
  SA3_MEDIUM_BASE_CKPT,
  SA3_MEDIUM_CKPT,
  SA3_T2A_GRAPH,
  SFX_GRAPH,
  addAudioRegion,
  audioLorasFromObjectInfo,
  buildSa3AudioToAudio,
  buildSa3Extend,
  buildSa3Inpaint,
  buildSa3TextToAudio,
  checkpointsFromObjectInfo,
  formatAudioRegions,
  injectAudioDuration,
  insertAudioLora,
  isAudioLora,
  parseAudioRegions,
  pickAudioWorkflow,
  sa3StrengthLabel,
} from "@/lib/oj/sa3Audio";
import { routeSlotWorkflowPath } from "@/lib/workflowAssignments";
import {
  buildSa3Request,
  isSa3Tool,
  SA3_TOOL_SPECS,
} from "@/lib/tools/sa3Tools";
import {
  ACTION_TOOLS,
  ToolInputError,
  buildActionRequest,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { actionToolMedia } from "@/lib/ui/lightboxTools";
import {
  audioLoraLabel,
  computePeaks,
  regionFromDrag,
  regionPercent,
  secondsAtX,
} from "@/lib/tools/audioWaveform";
import { handoffAudioFileName } from "@/lib/tools/audioHandoff";

const ROOT = path.resolve(__dirname, "../..");
const WF = path.join(ROOT, "public/workflows");
const load = (rel: string): Workflow =>
  JSON.parse(readFileSync(path.join(WF, rel), "utf8")) as Workflow;
const RUN = {} as ImagineRun;
const REF = "adrift_src.mp3 [input]";
const NO_LORAS = { families: {}, loras: [] };

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const hits = byClass(wf, cls);
  expect(hits, cls).toHaveLength(1);
  return hits[0];
};
const classes = (wf: Workflow) =>
  Object.values(wf)
    .map((n) => n.class_type)
    .sort();

const T2A = load("packs/audio/sa3_t2a.json");
const A2A = load("packs/audio/sa3_a2a.json");
const INP = load("packs/audio/sa3_inpaint.json");
const EXT = load("packs/audio/sa3_extend.json");

describe("SA3 pack graphs", () => {
  it("use only core nodes plus the cj_sa3_audio pack", () => {
    expect(classes(T2A)).toEqual(
      [
        "CLIPLoader",
        "CLIPTextEncode",
        "CLIPTextEncode",
        "CheckpointLoaderSimple",
        "EmptyLatentAudio",
        "KSampler",
        "SaveAudioMP3",
        "VAEDecodeAudio",
      ].sort(),
    );
    expect(classes(A2A)).toContain("VAEEncodeAudio");
    expect(classes(A2A)).toContain("LoadAudio");
    for (const wf of [INP, EXT]) {
      expect(classes(wf)).toContain("CJSA3InpaintConditioning");
      expect(classes(wf)).toContain("CJAudioPasteback");
      // the raw (un-pasted) decode is not saved, only the pasted result
      expect(byClass(wf, "SaveAudioMP3")).toHaveLength(1);
    }
    for (const wf of [T2A, A2A, INP, EXT]) {
      expect(one(wf, "CheckpointLoaderSimple")[1].inputs.ckpt_name).toBe(
        SA3_MEDIUM_CKPT,
      );
    }
  });

  it("are wired into the audio pack and the registry", () => {
    const audio = getPack("audio")!;
    expect(audio.workflows.sa3_t2a).toBe("packs/audio/sa3_t2a.json");
    expect(audio.workflows.sa3_a2a).toBe("packs/audio/sa3_a2a.json");
    expect(audio.workflows.sa3_inpaint).toBe("packs/audio/sa3_inpaint.json");
    expect(audio.workflows.sa3_extend).toBe("packs/audio/sa3_extend.json");
    const actions = registry.actions as Record<string, { template?: string }>;
    for (const id of ["sa3_t2a", "sa3_a2a", "sa3_inpaint", "sa3_extend"]) {
      expect(actions[id], id).toBeDefined();
      expect(
        ACTION_BUILDERS[id as keyof typeof ACTION_BUILDERS],
        id,
      ).toBeTypeOf("function");
    }
  });
});

describe("--audio (t2a) routing", () => {
  it("registry t2a points at a graph with no StableAudioSampler", () => {
    const t2a = (registry.templates as Record<string, { file: string }>).t2a;
    expect(t2a.file).toBe(SFX_GRAPH);
    const wf = load(t2a.file);
    expect(classes(wf)).not.toContain("StableAudioSampler");
    expect(byClass(wf, "EmptyLatentAudio")).toHaveLength(1);
  });

  it("no shipped graph uses StableAudioSampler", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory()
          ? walk(p)
          : f.endsWith(".json")
            ? [p]
            : [];
      });
    const offenders = walk(WF).filter((f) =>
      readFileSync(f, "utf8").includes('"StableAudioSampler"'),
    );
    expect(offenders).toEqual([]);
  });

  it("the default pack's t2a slot is the SFX graph", () => {
    const sd = getPack("sd");
    if (sd?.workflows.t2a)
      expect(load(sd.workflows.t2a)).toEqual(load(SFX_GRAPH));
  });

  it("picks SA3 medium when its checkpoint is on the backend", () => {
    expect(pickAudioWorkflow([`audio\\${SA3_MEDIUM_CKPT}`])).toBe(
      SA3_T2A_GRAPH,
    );
    expect(pickAudioWorkflow([SA3_MEDIUM_CKPT, "x.safetensors"])).toBe(
      SA3_T2A_GRAPH,
    );
    expect(pickAudioWorkflow(["stable_audio_3_small_sfx.safetensors"])).toBe(
      SFX_GRAPH,
    );
    expect(pickAudioWorkflow(null)).toBe(SFX_GRAPH);
  });

  it("injects the length through EmptyLatentAudio, clamped per checkpoint", () => {
    const sa3 = structuredClone(T2A);
    const [lid] = one(sa3, "EmptyLatentAudio");
    sa3[lid].inputs.width = 1024;
    sa3[lid].inputs.height = 1024;
    injectAudioDuration(sa3, 200);
    expect(sa3[lid].inputs.seconds).toBe(200);
    expect(sa3[lid].inputs).not.toHaveProperty("width");
    expect(sa3[lid].inputs).not.toHaveProperty("height");
    injectAudioDuration(sa3, 9999);
    expect(sa3[lid].inputs.seconds).toBe(380);

    const sfx = load(SFX_GRAPH);
    const [sid] = one(sfx, "EmptyLatentAudio");
    injectAudioDuration(sfx, 200);
    expect(sfx[sid].inputs.seconds).toBe(30);
    injectAudioDuration(sfx, "garbage");
    expect(sfx[sid].inputs.seconds).toBe(10);
  });

  it("the expand.text_to_audio slot wins for --audio prompts", () => {
    const a = {
      "expand.text_to_audio": { workflowPath: "user/my_audio.json" },
    } as never;
    expect(routeSlotWorkflowPath("rain on a tin roof --audio", a)).toBe(
      "user/my_audio.json",
    );
    expect(routeSlotWorkflowPath("rain on a tin roof --AUDIO", a)).toBe(
      "user/my_audio.json",
    );
    expect(routeSlotWorkflowPath("rain on a tin roof", a)).toBeUndefined();
    expect(routeSlotWorkflowPath("x --audio", {})).toBeUndefined();
  });
});

describe("SA3 builders", () => {
  it("text to audio: prompt, negative, seed, length", () => {
    const { workflow, seed } = buildSa3TextToAudio(T2A, RUN, 0, {
      prompt: "lofi beat",
      negative: "vocals",
      seed: 42,
      duration: 500,
    });
    expect(seed).toBe(42);
    const [kid, k] = one(workflow, "KSampler");
    expect(k.inputs.seed).toBe(42);
    expect(k.inputs.steps).toBe(8);
    expect(k.inputs.cfg).toBe(1);
    const pos = workflow[(k.inputs.positive as string[])[0]];
    const neg = workflow[(k.inputs.negative as string[])[0]];
    expect(pos.inputs.text).toBe("lofi beat");
    expect(neg.inputs.text).toBe("vocals");
    expect(one(workflow, "EmptyLatentAudio")[1].inputs.seconds).toBe(380);
    expect(kid).toBeTruthy();
    // base graph untouched
    expect(one(T2A, "KSampler")[1].inputs.seed).toBe(0);
    expect(() => buildSa3TextToAudio(T2A, RUN, 0, { prompt: " " })).toThrow(
      /describe the sound/,
    );
  });

  it("quality swaps to the base checkpoint at 50 steps, cfg 7", () => {
    const { workflow } = buildSa3TextToAudio(T2A, RUN, 0, {
      prompt: "x",
      speed: "quality",
    });
    expect(one(workflow, "CheckpointLoaderSimple")[1].inputs.ckpt_name).toBe(
      SA3_MEDIUM_BASE_CKPT,
    );
    const k = one(workflow, "KSampler")[1];
    expect([k.inputs.steps, k.inputs.cfg]).toEqual([50, 7]);
  });

  it("the shipped Quality graph matches the quality preset", () => {
    const { workflow } = buildSa3TextToAudio(T2A, RUN, 0, {
      prompt: "x",
      speed: "quality",
      seed: 0,
    });
    const ref = load("packs/audio/sa3_t2a_quality.json");
    for (const cls of ["CheckpointLoaderSimple", "KSampler"]) {
      const a = one(workflow, cls)[1].inputs;
      const b = one(ref, cls)[1].inputs;
      for (const k of ["ckpt_name", "steps", "cfg"])
        if (k in b) expect(a[k], `${cls}.${k}`).toBe(b[k]);
    }
  });

  it("restyle: LoadAudio + denoise = strength (clamped 0.3-0.95)", () => {
    const { workflow } = buildSa3AudioToAudio(A2A, RUN, 0, {
      prompt: "jazz trio",
      audioRef: REF,
      strength: 0.99,
    });
    expect(one(workflow, "LoadAudio")[1].inputs.audio).toBe(REF);
    expect(one(workflow, "KSampler")[1].inputs.denoise).toBe(0.95);
    const low = buildSa3AudioToAudio(A2A, RUN, 0, {
      prompt: "x",
      audioRef: REF,
      strength: 0.1,
    }).workflow;
    expect(one(low, "KSampler")[1].inputs.denoise).toBe(0.3);
    expect(() =>
      buildSa3AudioToAudio(A2A, RUN, 0, { prompt: "x", audioRef: "../x" }),
    ).toThrow(/audioRef/);
  });

  it("fix a section: same regions on conditioning and pasteback, total 0", () => {
    const { workflow } = buildSa3Inpaint(INP, RUN, 0, {
      prompt: "sax solo",
      negative: "noise",
      audioRef: REF,
      regions: "14.5 to 18, 4-8",
      seconds: 30,
    });
    const [, cond] = one(workflow, "CJSA3InpaintConditioning");
    const [, paste] = one(workflow, "CJAudioPasteback");
    expect(cond.inputs.regions).toBe("4-8; 14.5-18");
    expect(cond.inputs.total_seconds).toBe(0);
    expect(paste.inputs.regions).toBe("4-8; 14.5-18");
    expect(paste.inputs.crossfade_ms).toBe(60);
    expect(one(workflow, "LoadAudio")[1].inputs.audio).toBe(REF);
    expect(one(workflow, "KSampler")[1].inputs.denoise).toBe(1);
    // prompts go to the CLIPTextEncodes feeding the conditioning node
    expect(workflow[(cond.inputs.positive as string[])[0]].inputs.text).toBe(
      "sax solo",
    );
    expect(workflow[(cond.inputs.negative as string[])[0]].inputs.text).toBe(
      "noise",
    );
    expect(() =>
      buildSa3Inpaint(INP, RUN, 0, { audioRef: REF, regions: "" }),
    ).toThrow(/pick at least one/);
    expect(() =>
      buildSa3Inpaint(INP, RUN, 0, { audioRef: REF, regions: "8-4" }),
    ).toThrow(/ends before/);
    expect(() =>
      buildSa3Inpaint(INP, RUN, 0, {
        audioRef: REF,
        regions: "40-45",
        seconds: 30,
      }),
    ).toThrow(/after the end/);
  });

  it("extend: empty regions, total above the source length", () => {
    const { workflow } = buildSa3Extend(EXT, RUN, 0, {
      audioRef: REF,
      total: 90,
      seconds: 30,
    });
    const [, cond] = one(workflow, "CJSA3InpaintConditioning");
    expect(cond.inputs.regions).toBe("");
    expect(cond.inputs.total_seconds).toBe(90);
    expect(one(workflow, "CJAudioPasteback")[1].inputs.regions).toBe("");
    expect(() =>
      buildSa3Extend(EXT, RUN, 0, { audioRef: REF, total: 20, seconds: 30 }),
    ).toThrow(/must be longer/);
  });

  it("inserts an audio LoRA between checkpoint and sampler", () => {
    for (const [wf, build, extra] of [
      [T2A, buildSa3TextToAudio, {}],
      [A2A, buildSa3AudioToAudio, { audioRef: REF }],
      [INP, buildSa3Inpaint, { audioRef: REF, regions: "1-2" }],
      [EXT, buildSa3Extend, { audioRef: REF, total: 60 }],
    ] as const) {
      const { workflow } = build(wf, RUN, 0, {
        prompt: "x",
        lora: "audio\\lofi_keys.safetensors",
        loraStrength: 9,
        ...extra,
      });
      const [lid, lora] = one(workflow, "LoraLoaderModelOnly");
      const [cid] = one(workflow, "CheckpointLoaderSimple");
      const maxBase = Math.max(...Object.keys(wf).map(Number));
      expect(Number(lid)).toBe(maxBase + 1);
      expect(lora.inputs).toEqual({
        model: [cid, 0],
        lora_name: "audio/lofi_keys.safetensors",
        strength_model: 1.5,
      });
      expect(one(workflow, "KSampler")[1].inputs.model).toEqual([lid, 0]);
    }
    const plain = buildSa3TextToAudio(T2A, RUN, 0, { prompt: "x" }).workflow;
    expect(byClass(plain, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(() =>
      insertAudioLora(structuredClone(T2A), "style/x.safetensors", 1, "t"),
    ).toThrow(/audio LoRA/);
    expect(() =>
      insertAudioLora(structuredClone(T2A), "audio/../x.safetensors", 1, "t"),
    ).toThrow(/audio LoRA/);
  });
});

describe("regions + UI helpers", () => {
  it("parses, merges and formats region strings", () => {
    expect(parseAudioRegions("4-8; 14.5 to 18\n20..22")).toEqual([
      { start: 4, end: 8 },
      { start: 14.5, end: 18 },
      { start: 20, end: 22 },
    ]);
    expect(() => parseAudioRegions("4")).toThrow(/not a range/);
    expect(
      formatAudioRegions(
        addAudioRegion([{ start: 4, end: 8 }], { start: 7, end: 10.04 }),
      ),
    ).toBe("4-10");
    expect(formatAudioRegions([{ start: 1.234, end: 2.06 }])).toBe("1.2-2.1");
  });

  it("lists audio LoRAs and checkpoints from object_info", () => {
    const info = {
      LoraLoaderModelOnly: {
        input: {
          required: {
            lora_name: [
              [
                "style/a.safetensors",
                "audio\\b.safetensors",
                "audio/a.safetensors",
                "audio/c.ckpt",
              ],
            ],
          },
        },
      },
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [[SA3_MEDIUM_CKPT]] } },
      },
    };
    expect(audioLorasFromObjectInfo(info)).toEqual([
      "audio/a.safetensors",
      "audio/b.safetensors",
    ]);
    expect(audioLorasFromObjectInfo(null)).toEqual([]);
    expect(checkpointsFromObjectInfo(info)).toEqual([SA3_MEDIUM_CKPT]);
    expect(checkpointsFromObjectInfo({})).toBeNull();
    expect(isAudioLora("audio/x.safetensors")).toBe(true);
    expect(isAudioLora("x.safetensors")).toBe(false);
  });

  it("describes restyle strength in plain words", () => {
    expect(sa3StrengthLabel(0.3)).toMatch(/Light touch/);
    expect(sa3StrengthLabel(0.6)).toMatch(/Balanced/);
    expect(sa3StrengthLabel(0.7)).toMatch(/Strong/);
    expect(sa3StrengthLabel(0.95)).toMatch(/Almost new/);
  });

  it("waveform helpers", () => {
    expect(computePeaks([0, 0.5, -1, 0.25], 2)).toEqual([0.5, 1]);
    expect(computePeaks([], 3)).toEqual([0, 0, 0]);
    expect(secondsAtX(50, 200, 40)).toBe(10);
    expect(secondsAtX(-5, 200, 40)).toBe(0);
    expect(secondsAtX(999, 200, 40)).toBe(40);
    expect(regionFromDrag(8, 4)).toEqual({ start: 4, end: 8 });
    expect(regionFromDrag(4, 4.1)).toBeNull();
    expect(regionPercent({ start: 10, end: 20 }, 40)).toEqual({
      left: 25,
      width: 25,
    });
    expect(audioLoraLabel("audio/lofi_keys.safetensors")).toBe("lofi keys");
    expect(
      handoffAudioFileName("/api/comfy/view?filename=audio%2Fx_001.mp3"),
    ).toBe("x_001.mp3");
    expect(handoffAudioFileName("/media/clip.wav")).toBe("clip.wav");
    expect(handoffAudioFileName("/media/blob")).toBe("audio.mp3");
  });
});

describe("SA3 tool cards", () => {
  const settings = (
    picks: Record<string, string>,
    text = "lofi",
  ): ToolSettings =>
    ({ text, secondText: "", picks }) as unknown as ToolSettings;
  const spec = (id: string) => ACTION_TOOLS.find((s) => s.id === id)!;

  it("are listed under Audio and take audio from the lightbox", () => {
    for (const s of SA3_TOOL_SPECS) {
      expect(spec(s.id)).toBe(s);
      expect(s.category).toBe("Audio");
      expect(isSa3Tool(s.id)).toBe(true);
      expect(s.modelCheck).toEqual({ pack: "audio", action: s.id });
    }
    expect(actionToolMedia(spec("sa3_t2a"))).toEqual([]);
    expect(actionToolMedia(spec("sa3_a2a"))).toEqual(["audio"]);
    expect(actionToolMedia(spec("sa3_inpaint"))).toEqual(["audio"]);
    expect(actionToolMedia(spec("sa3_extend"))).toEqual(["audio"]);
  });

  it("build action requests with speed, LoRA and the tool's values", () => {
    const t2a = buildActionRequest(
      spec("sa3_t2a"),
      settings({
        duration: "120",
        sa3Speed: "quality",
        sa3Lora: "audio/a.safetensors",
        sa3LoraStrength: "0.5",
      }),
      NO_LORAS,
    );
    expect(t2a).toMatchObject({
      action: "sa3_t2a",
      params: {
        pack_id: "audio",
        prompt: "lofi",
        duration: 120,
        speed: "quality",
        lora: "audio/a.safetensors",
        loraStrength: 0.5,
      },
    });
    const noLora = buildSa3Request(
      spec("sa3_t2a"),
      settings({ sa3Lora: "style/a.safetensors" }),
      undefined,
      (m) => new Error(m),
    );
    expect(noLora.params).not.toHaveProperty("lora");
    expect(noLora.params.speed).toBe("fast");

    const fix = (regions: string, seconds?: number) =>
      buildActionRequest(
        spec("sa3_inpaint"),
        settings({ regions }, ""),
        NO_LORAS,
        undefined,
        { ref: REF, seconds },
      );
    expect(fix("14-18, 4-8", 30).params).toMatchObject({
      audioRef: REF,
      seconds: 30,
      regions: "4-8; 14-18",
    });
    expect(() => fix("8-4")).toThrow(ToolInputError);
    expect(() => fix("")).toThrow(/Pick at least one section/);
    expect(() => fix("40-45", 30)).toThrow(/after the end/);

    const ext = (total: string, seconds?: number) =>
      buildActionRequest(
        spec("sa3_extend"),
        settings({ total }, ""),
        NO_LORAS,
        undefined,
        { ref: REF, seconds },
      );
    expect(ext("90", 30).params).toMatchObject({ total: 90, seconds: 30 });
    expect(() => ext("20", 30)).toThrow(/above the audio/);
    expect(() =>
      buildActionRequest(spec("sa3_a2a"), settings({}), NO_LORAS, undefined, undefined),
    ).toThrow(/Add the audio to restyle first/);
    expect(
      buildActionRequest(spec("sa3_a2a"), settings({ strength: "0.4" }), NO_LORAS, undefined, {
        ref: REF,
      }).params,
    ).toMatchObject({ strength: 0.4, audioRef: REF });
  });
});
