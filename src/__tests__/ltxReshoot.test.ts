/**
 * Re-shoot (src/lib/oj/ltxReshoot.ts, packs/ltx25/vfx_reshoot.json): the
 * clip's first frame is re-angled by Qwen-Image 2.1 + the qma camera LoRA,
 * then LTX-2.5 i2v animates it. Pack checked against the pc object_info
 * snapshot (fixtures/ltxVfxNodes.objectInfo.json).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import ltxNodes from "./fixtures/ltxVfxNodes.objectInfo.json";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LTX_RESHOOT_ACTION,
  LTX_RESHOOT_DEFAULTS,
  LTX_RESHOOT_DISTANCES,
  LTX_RESHOOT_HEIGHTS,
  LTX_RESHOOT_MAX_FRAMES,
  LTX_RESHOOT_ORBITS,
  reshootAngle,
  reshootQwenPrompt,
  reshootVideoPrompt,
} from "@/lib/oj/ltxReshoot";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";

const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<string, { template: string; requiresImage?: boolean }>;
};
const FILE = reg.templates[reg.actions[LTX_RESHOOT_ACTION].template].file;
const raw = (): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", FILE), "utf8"),
  );
const load = (): Workflow =>
  Object.fromEntries(
    Object.entries(raw()).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

type Spec = [string, Record<string, unknown>];
const INFO = ltxNodes as unknown as Record<
  string,
  {
    input: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  }
>;

/** "parent.child" keys of dynamic combos and autogrow inputs. */
function subInput(
  declared: Record<string, unknown>,
  inputs: Record<string, unknown>,
  key: string,
): boolean {
  const dot = key.indexOf(".");
  if (dot < 0) return false;
  const parent = key.slice(0, dot);
  const child = key.slice(dot + 1);
  const spec = declared[parent] as Spec | undefined;
  if (!spec) return false;
  if (spec[0] === "COMFY_AUTOGROW_V3") {
    const names = (spec[1].template as { names?: string[] })?.names ?? [];
    return names.includes(child);
  }
  if (spec[0] !== "COMFY_DYNAMICCOMBO_V3") return false;
  const options = spec[1].options as
    | { key: string; inputs?: Record<string, Record<string, unknown>> }[]
    | undefined;
  const picked = options?.find((o) => o.key === inputs[parent]);
  return child in { ...picked?.inputs?.required, ...picked?.inputs?.optional };
}

function problems(wf: Workflow): string[] {
  const out = validatePrompt(wf, INFO).map(
    (p) => `${p.nodeId} ${p.kind}: ${p.message}`,
  );
  for (const [id, node] of Object.entries(wf)) {
    const info = INFO[node.class_type];
    if (!info) continue;
    const declared = { ...info.input.required, ...info.input.optional };
    for (const key of Object.keys(node.inputs))
      if (!(key in declared) && !subInput(declared, node.inputs, key))
        out.push(`${id}.${key}: undeclared input`);
  }
  return out;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.keys(wf).filter((id) => wf[id].class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const ids = byClass(wf, cls);
  expect(ids).toHaveLength(1);
  return wf[ids[0]].inputs;
};

const clipRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1920,
    height: 1080,
    createdAt: "2026-10-25T00:00:00Z",
    status: "done",
    params: { video_seconds: 3 },
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [
          "http://127.0.0.1:8188/view?filename=kitchen.mp4&subfolder=&type=input",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const build = (run: ImagineRun, params: Record<string, unknown> = {}) =>
  actionBuilderFor(LTX_RESHOOT_ACTION)!(load(), run, 0, {
    seed: 7,
    prompt: "the chef flips a pancake",
    ...params,
  });

describe("Re-shoot registry and pack", () => {
  it("registers a video-input action on packs/ltx25/vfx_reshoot.json", () => {
    expect(FILE).toBe("packs/ltx25/vfx_reshoot.json");
    expect(actionBuilderFor(LTX_RESHOOT_ACTION)).toBeTypeOf("function");
    expect(VIDEO_INPUT_ACTIONS.has(LTX_RESHOOT_ACTION)).toBe(true);
    expect(reg.actions[LTX_RESHOOT_ACTION].requiresImage).toBe(false);
  });

  it("raw pack validates against the pc object_info", () => {
    const meta = raw()._meta as { title?: string; description?: string };
    expect(meta.title).toMatch(/^LTX VFX/);
    expect(meta.description).toMatch(/re-generated/i);
    expect(problems(load())).toEqual([]);
  });

  it("re-angles the first frame with the Qwen 2.1 camera LoRA", () => {
    const wf = load();
    const loras = byClass(wf, "LoraLoaderModelOnly").map((id) =>
      String(wf[id].inputs.lora_name),
    );
    expect(loras).toEqual([
      "edit_tools/qwen-image-2.1-qma-camera-angles.safetensors",
    ]);
    const qwen = one(wf, "TextEncodeQwenImage21");
    const frame = String((qwen["images.image_1"] as unknown[])[0]);
    expect(wf[frame].class_type).toBe("ImageFromBatch");
    expect(wf[frame].inputs).toMatchObject({ batch_index: 0, length: 1 });
  });
});

describe("Re-shoot builder", () => {
  it("picks angles from the Camera angle tool options, defaults on junk", () => {
    expect(LTX_RESHOOT_ORBITS.length).toBeGreaterThan(3);
    expect(LTX_RESHOOT_HEIGHTS.length).toBeGreaterThan(2);
    expect(LTX_RESHOOT_DISTANCES.length).toBeGreaterThan(1);
    const def = reshootAngle({ orbit: "nope", height: 3 });
    expect(def.orbit.id).toBe(LTX_RESHOOT_DEFAULTS.orbit);
    expect(def.height.id).toBe(LTX_RESHOOT_DEFAULTS.height);
    expect(def.distance.id).toBe(LTX_RESHOOT_DEFAULTS.distance);
    const back = reshootAngle({ orbit: LTX_RESHOOT_ORBITS.at(-1)!.id });
    expect(reshootQwenPrompt(back)).toBe(
      `<qma> ${back.orbit.text} ${back.height.text} ${back.distance.text}`,
    );
    expect(reshootVideoPrompt(back, "  a dog runs.  ")).toMatch(
      /^The same scene filmed again from a new camera position: .+\. a dog runs\.$/,
    );
  });

  it("wires the clip, angle, size, length and seed", () => {
    const orbit = LTX_RESHOOT_ORBITS[2].id;
    const { workflow, slots, seed } = build(clipRun(), { orbit });
    expect(problems(workflow)).toEqual([]);
    expect(seed).toBe(7);
    expect(one(workflow, "LoadVideo").file).toBe("kitchen.mp4 [input]");
    expect(slots.imageInputId).toBe(byClass(workflow, "LoadVideo")[0]);
    const angle = reshootAngle({ orbit });
    expect(one(workflow, "TextEncodeQwenImage21").prompt).toBe(
      reshootQwenPrompt(angle),
    );
    expect(one(workflow, "KSampler")).toMatchObject({
      seed: 7,
      steps: 30,
      cfg: 3,
    });
    for (const id of byClass(workflow, "RandomNoise"))
      expect(workflow[id].inputs.noise_seed).toBe(7);
    expect(workflow[slots.posTextId].inputs.text).toBe(
      reshootVideoPrompt(angle, "the chef flips a pancake"),
    );
    // 3 s at 24 fps → 73 frames (8n+1), landscape.
    const latent = one(workflow, "EmptyLTXVLatentVideo") as {
      width: number;
      height: number;
      length: number;
    };
    expect(latent.length).toBe(73);
    expect(latent.width).toBeGreaterThan(latent.height);
    const portrait = one(
      build(clipRun({ width: 1080, height: 1920 })).workflow,
      "EmptyLTXVLatentVideo",
    ) as { width: number; height: number };
    expect(portrait.height).toBeGreaterThan(portrait.width);
  });

  it("caps long clips at 5 s and needs a prompt and a clip", () => {
    const long = build(clipRun({ params: { video_seconds: 30 } } as never));
    expect(one(long.workflow, "EmptyLTXVLatentVideo").length).toBe(
      LTX_RESHOOT_MAX_FRAMES,
    );
    expect(() => build(clipRun(), { prompt: "  " })).toThrow(
      /prompt is required/,
    );
    const noClip = clipRun();
    noClip.jobs[0].videos = [];
    expect(() => build(noClip)).toThrow(/no video/);
  });
});

describe("Re-shoot tools page", () => {
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(getActionTool(LTX_RESHOOT_ACTION)),
    ...over,
  });

  it("spec: LTX VFX clip tool with angle pickers and a model check", () => {
    const spec = getActionTool(LTX_RESHOOT_ACTION)!;
    expect(spec.category).toBe("LTX VFX");
    expect(spec.subtitle).toMatch(/^LTX VFX: /);
    expect(spec.videoInput).toBeTruthy();
    expect(spec.modelCheck).toEqual({
      pack: "ltx25",
      action: LTX_RESHOOT_ACTION,
    });
  });

  it("requests carry the picked angle", () => {
    const req = buildActionRequest(
      getActionTool(LTX_RESHOOT_ACTION)!,
      settings({
        text: "a dog runs",
        picks: { orbit: "back", height: "high-angle", distance: "wide" },
        seed: 4,
      }),
      null,
    );
    expect(req).toMatchObject({
      action: LTX_RESHOOT_ACTION,
      params: {
        prompt: "a dog runs",
        orbit: "back",
        height: "high-angle",
        distance: "wide",
        seed: 4,
      },
    });
    const def = buildActionRequest(
      getActionTool(LTX_RESHOOT_ACTION)!,
      settings({ text: "x" }),
      null,
    );
    expect(def?.params).toMatchObject(LTX_RESHOOT_DEFAULTS);
  });
});
