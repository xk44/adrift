import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import objectInfo from "./fixtures/pipelineNodes.objectInfo.json";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  MOTION_SCRIPT_ACTION,
  MOTION_SCRIPT_MAX_TOKENS,
  buildMotionScriptWorkflow,
} from "@/lib/oj/motionScript";
import {
  MOTION_SCENES,
  clampMotionScenes,
  cleanBrief,
  jsonFromReply,
  motionPrompt,
  parseMotionReply,
} from "@/lib/motion/prompt";
import {
  exportFilename,
  musicBed,
  narrate,
  writeOutline,
} from "@/lib/motion/client";
import {
  duckGain,
  exportSize,
  extensionFor,
  pickMimeType,
} from "@/lib/motion/exporter";
import { buildTemplate } from "@/lib/motion/templates";
import { MOTION_DESIGNER_KEY, motionCards } from "@/lib/tools/motionCard";
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

type InputSpec = [unknown, Record<string, unknown>?];
const INFO = objectInfo as unknown as Record<
  string,
  { input: Record<string, Record<string, InputSpec>>; output: string[] }
>;

/** Light object_info check: classes exist, plain keys are declared, links resolve. */
function validate(wf: Workflow): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    const info = INFO[node.class_type];
    if (!info) {
      errors.push(`${id}: unknown class ${node.class_type}`);
      continue;
    }
    const all = {
      ...info.input.required,
      ...info.input.optional,
      ...info.input.hidden,
    };
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!all[key.split(".")[0]])
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        !wf[value[0]]
      )
        errors.push(`${id}.${key}: link to missing node ${value[0]}`);
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

const run = (): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: "2026-10-24T00:00:00Z",
    status: "done",
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images: [] }],
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );

describe("motion_script action", () => {
  it("is registered, image-free and resolves a builder", () => {
    expect(reg.actions[MOTION_SCRIPT_ACTION]).toBeTruthy();
    expect(reg.actions[MOTION_SCRIPT_ACTION].requiresImage).toBe(false);
    expect(reg.templates[reg.actions[MOTION_SCRIPT_ACTION].template].file).toBe(
      "packs/pipeline/script.json",
    );
    expect(actionBuilderFor(MOTION_SCRIPT_ACTION)).toBe(
      buildMotionScriptWorkflow,
    );
  });

  it("builds a text-only Qwen3-VL graph with the compiled prompt", () => {
    const { workflow, seed, slots } = buildMotionScriptWorkflow(
      load(MOTION_SCRIPT_ACTION),
      run(),
      0,
      { brief: "how solar panels work", scenes: 5, tone: "playful", seed: 11 },
    );
    expect(validate(workflow)).toEqual([]);
    expect(
      missingAgainstObjectInfo(workflow, objectInfo as Record<string, unknown>),
    ).toEqual([]);
    expect(byClass(workflow, "LoadImage")).toHaveLength(0);
    const [[genId, gen]] = byClass(workflow, "TextGenerate");
    expect(gen.inputs.image).toBeUndefined();
    expect(gen.inputs.prompt).toContain("how solar panels work");
    expect(gen.inputs.prompt).toContain("Exactly 5 scenes");
    expect(gen.inputs.prompt).toContain("Tone: playful");
    expect(gen.inputs.max_length).toBe(MOTION_SCRIPT_MAX_TOKENS);
    expect(gen.inputs["sampling_mode.seed"]).toBe(11);
    expect(seed).toBe(11);
    expect(slots.ksamplerId).toBe(genId);
    const [[, preview]] = byClass(workflow, "PreviewAny");
    expect(preview.inputs.source).toEqual([genId, 0]);
  });

  it("requires a brief, clamps scenes and ignores a bad tone", () => {
    const base = load(MOTION_SCRIPT_ACTION);
    expect(() => buildMotionScriptWorkflow(base, run(), 0, {})).toThrow(
      /describe/,
    );
    expect(() =>
      buildMotionScriptWorkflow(base, run(), 0, { brief: "   " }),
    ).toThrow();
    const { workflow, seed } = buildMotionScriptWorkflow(base, run(), 0, {
      brief: "x".repeat(2000),
      scenes: 99,
      tone: "<script>",
    });
    const [[, gen]] = byClass(workflow, "TextGenerate");
    expect(gen.inputs.prompt).toContain(`Exactly ${MOTION_SCENES.max} scenes`);
    expect(gen.inputs.prompt).toContain("Tone: clear");
    expect(String(gen.inputs.prompt)).not.toContain("x".repeat(700));
    expect(Number.isInteger(seed)).toBe(true);
    // The base template is not mutated.
    expect(byClass(base, "LoadImage")).toHaveLength(1);
  });
});

describe("motion prompt + reply parsing", () => {
  it("prompt carries the safety rules and the whiteboard hint", () => {
    const p = motionPrompt({ brief: "tides", scenes: 4, whiteboard: true });
    expect(p).toMatch(/No real people/);
    expect(p).toMatch(/do not invent statistics/);
    expect(p).toMatch(/whiteboard/);
    expect(p).not.toMatch(/lowerthird:/);
  });

  it("clamps and cleans inputs", () => {
    expect(clampMotionScenes(1)).toBe(MOTION_SCENES.min);
    expect(clampMotionScenes(50)).toBe(MOTION_SCENES.max);
    expect(clampMotionScenes("nope")).toBe(MOTION_SCENES.default);
    expect(cleanBrief("  a\u0000b  ")).toBe("ab");
    expect(cleanBrief(42)).toBe("");
  });

  it("extracts JSON from fenced / thinking / sloppy replies", () => {
    expect(
      jsonFromReply('<think>hmm {"x":0}</think>```json\n{"a":1,}\n```'),
    ).toEqual({ a: 1 });
    expect(jsonFromReply("{“a”: 2}")).toEqual({ a: 2 });
    expect(jsonFromReply("no json here")).toBeNull();
  });

  it("parses a JSON reply into an outline", () => {
    const o = parseMotionReply(
      JSON.stringify({
        title: "Solar",
        scenes: [
          { layout: "title", heading: "Sunlight to power" },
          {
            layout: "steps",
            heading: "How",
            items: ["Light hits cells", "Electrons move"],
          },
        ],
      }),
    );
    expect(o.title).toBe("Solar");
    expect(o.scenes.map((s) => s.layout)).toEqual(["title", "steps"]);
  });

  it("falls back to plain lines when the model ignores JSON", () => {
    const o = parseMotionReply(
      "1. Sunlight hits the panel\n2. Cells make current\n- ok",
      "Solar power",
    );
    expect(o.scenes[0]).toMatchObject({
      layout: "title",
      heading: "Solar power",
    });
    expect(o.scenes.slice(1).map((s) => s.heading)).toEqual([
      "Sunlight hits the panel",
      "Cells make current",
    ]);
  });
});

/** Scripted fetch for the seed-run -> action -> history flow. */
function fakeServer(outputs: Record<string, unknown>[]) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  let n = 0;
  const json = (data: unknown, status = 200) =>
    ({
      ok: status < 400,
      status,
      json: async () => data,
    }) as unknown as Response;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({ url, body });
    if (url === "/api/jobs/seed-run")
      return json({
        ok: true,
        run: { run_id: `seed${n}`, jobs: [{ index: 0 }] },
      });
    if (url === "/api/jobs/action") {
      const id = `p${n++}`;
      return json({
        ok: true,
        run: { run_id: `run_${id}`, jobs: [{ prompt_id: id }] },
      });
    }
    const m = /history\/p(\d+)/.exec(url);
    if (m)
      return json({
        status: { status_str: "success" },
        ...outputs[Number(m[1])],
      });
    return json({ ok: false, error: "unexpected" }, 500);
  };
  return {
    calls,
    deps: { fetchImpl, clientId: "c1", sleep: async () => undefined },
  };
}

describe("motion client", () => {
  it("writeOutline runs motion_script and parses the text", async () => {
    const reply = JSON.stringify({
      title: "Tides",
      scenes: [{ layout: "title", heading: "Tides 101" }],
    });
    const { calls, deps } = fakeServer([{ texts: [{ text: reply }] }]);
    const runs: unknown[] = [];
    const { outline, raw } = await writeOutline(
      { ...deps, onRun: (r: ImagineRun) => runs.push(r) },
      { brief: "Explain tides", scenes: 4, tone: "calm", seed: 3 },
    );
    expect(raw).toBe(reply);
    expect(outline.scenes[0].heading).toBe("Tides 101");
    const action = calls.find((c) => c.url === "/api/jobs/action")!.body!;
    expect(action).toMatchObject({
      action: "motion_script",
      client_id: "c1",
      params: { brief: "Explain tides", scenes: 4, tone: "calm", seed: 3 },
    });
    expect(runs).toHaveLength(1);
  });

  it("writeOutline refuses an empty brief without calling the server", async () => {
    const { calls, deps } = fakeServer([]);
    await expect(writeOutline(deps, { brief: "  " })).rejects.toThrow(
      /Describe/,
    );
    expect(calls).toHaveLength(0);
  });

  it("narrate voices only scenes with narration, at their cue times", async () => {
    const spec = buildTemplate("explainer");
    spec.scenes.forEach(
      (s, i) => (s.narration = i % 2 === 0 ? `Line ${i}` : ""),
    );
    const want = spec.scenes.filter((s) => s.narration).length;
    const { calls, deps } = fakeServer(
      Array.from({ length: want }, (_, i) => ({
        audios: [{ filename: `v${i}.wav`, url: `/a/v${i}.wav` }],
      })),
    );
    const progress: number[] = [];
    const cues = await narrate(deps, spec, "af_heart", (d) => progress.push(d));
    expect(cues).toHaveLength(want);
    expect(cues[0]).toMatchObject({ scene: 0, url: "/a/v0.wav" });
    expect(cues[0].at).toBeGreaterThan(0);
    const actions = calls
      .filter((c) => c.url === "/api/jobs/action")
      .map((c) => c.body!);
    expect(actions.every((a) => a.action === "voiceover")).toBe(true);
    expect(actions[0].params).toEqual({
      script: "Line 0",
      engine: "kokoro",
      voice: "af_heart",
    });
    expect(progress.at(-1)).toBe(want);
  });

  it("musicBed asks for a bed at least as long as the video", async () => {
    const spec = buildTemplate("title_intro");
    const { calls, deps } = fakeServer([
      { audios: [{ filename: "m.flac", url: "/a/m.flac" }] },
    ]);
    const cue = await musicBed(deps, spec, "calm");
    expect(cue).toEqual({ at: 0, url: "/a/m.flac", scene: -1 });
    const params = calls.find((c) => c.url === "/api/jobs/action")!.body!
      .params as Record<string, unknown>;
    expect(params.prompt).toMatch(/ambient/);
    expect(params.duration).toBeGreaterThanOrEqual(10);
  });

  it("surfaces ComfyUI errors", async () => {
    const { deps } = fakeServer([
      {
        status: {
          status_str: "error",
          messages: [
            [
              "execution_error",
              { node_type: "TextGenerate", exception_message: "boom" },
            ],
          ],
        },
      },
    ]);
    await expect(writeOutline(deps, { brief: "x y z" })).rejects.toThrow(
      /TextGenerate: boom/,
    );
  });

  it("exportFilename slugs the title", () => {
    expect(exportFilename("Hello, World!", "video/mp4", 36)).toBe(
      "cj_motion_hello_world_10.mp4",
    );
    expect(exportFilename("", "video/webm;codecs=vp9", 1)).toBe(
      "cj_motion_video_1.webm",
    );
  });
});

describe("exporter helpers", () => {
  it("prefers mp4, can prefer webm, survives throwing probes", () => {
    expect(pickMimeType(() => true)).toMatch(/^video\/mp4/);
    expect(pickMimeType(() => true, true)).toMatch(/^video\/webm/);
    expect(pickMimeType((t) => t === "video/webm")).toBe("video/webm");
    expect(pickMimeType(() => false)).toBeNull();
    expect(
      pickMimeType((t) => {
        if (t.includes("mp4")) throw new Error("unknown");
        return true;
      }),
    ).toMatch(/webm/);
    expect(extensionFor("video/mp4;codecs=avc1")).toBe("mp4");
    expect(extensionFor("video/webm")).toBe("webm");
  });

  it("export size is the aspect frame, scaled to even pixels", () => {
    const spec = buildTemplate("explainer", {}, { aspect: "4:5" });
    expect(exportSize(spec)).toEqual({ width: 864, height: 1080 });
    const s = exportSize(spec, 0.33);
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
  });

  it("ducks music under narration with ramps", () => {
    const v = [{ at: 2, seconds: 3 }];
    expect(duckGain(0, v)).toBe(0.32);
    expect(duckGain(3, v)).toBeCloseTo(0.12, 9);
    const ramp = duckGain(1.875, v);
    expect(ramp).toBeLessThan(0.32);
    expect(ramp).toBeGreaterThan(0.12);
    expect(duckGain(6, v)).toBe(0.32);
  });
});

describe("motion designer hub card", () => {
  const ctx: EngineContext = {
    catalog: [],
    packIds: new Set(),
    editLoras: null,
  };

  it("is always available (renders in the browser) under Video", () => {
    const [card] = motionCards();
    expect(card.key).toBe(MOTION_DESIGNER_KEY);
    expect(card.available).toBe(true);
    expect(card.nc).toBe(false);
    expect(card.hubCategory).toBe("Video");
    expect(card.aliases).toContain("motion graphics");
    const keys = buildHubCards({ toolCards: [], ctx }).map((c) => c.key);
    expect(keys).toContain(MOTION_DESIGNER_KEY);
  });
});
