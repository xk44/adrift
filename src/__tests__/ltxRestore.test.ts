/**
 * Restore (src/lib/oj/ltxRestore.ts, packs/ltx25/vfx_restore*.json): five
 * LTX-2.5 restoration IC-LoRAs behind one card with a mode picker. Packs are
 * checked against the recorded LTX-2.5 object_info, builders against the
 * model-card settings.
 */
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import ltxNodes from "./fixtures/ltxVfxNodes.objectInfo.json";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { routeBackend } from "@/lib/comfy/backends";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LTX_RESTORE_ACTION,
  LTX_RESTORE_ACTIONS,
  LTX_RESTORE_COLORIZE_ACTION,
  LTX_RESTORE_DEBLUR_ACTION,
  LTX_RESTORE_DECOMPRESS_ACTION,
  LTX_RESTORE_MODES,
  LTX_RESTORE_REFINE_ACTION,
  ltxRestoreDims,
  ltxRestorePrompt,
  ltxRestoreStrength,
} from "@/lib/oj/ltxRestore";
import { LTX_BUILTIN_IC_LORA_FILES } from "@/lib/oj/ltxCommunityLoras";
import {
  actionAvailability,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { toHubCard } from "@/lib/tools/hub";
import { isNewCard } from "@/lib/tools/hubVisuals";
import { actionLabel } from "@/lib/runProvenance";
import modelSizes from "@/lib/tools/modelSizes.json";

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<
    string,
    { template: string; requiresImage?: boolean; group?: string }
  >;
};
const packFile = (action: string) =>
  reg.templates[reg.actions[action].template].file;
const raw = (action: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(PACKS, packFile(action)), "utf8"));
const load = (action: string): Workflow =>
  Object.fromEntries(
    Object.entries(raw(action)).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

const INFO = ltxNodes as unknown as Record<
  string,
  {
    input: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  }
>;

function problems(wf: Workflow): string[] {
  const out = validatePrompt(wf, INFO).map(
    (p) => `${p.nodeId} ${p.kind}: ${p.message}`,
  );
  for (const [id, node] of Object.entries(wf)) {
    const info = INFO[node.class_type];
    if (!info) continue;
    const declared = { ...info.input.required, ...info.input.optional };
    for (const key of Object.keys(node.inputs))
      if (!(key in declared)) out.push(`${id}.${key}: undeclared input`);
  }
  return out;
}

const one = (wf: Workflow, cls: string) => {
  const ids = Object.keys(wf).filter((id) => wf[id].class_type === cls);
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
    createdAt: "2026-10-31T00:00:00Z",
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
          "http://127.0.0.1:8188/view?filename=old.mp4&subfolder=&type=input",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const build = (
  action: string,
  run: ImagineRun = clipRun(),
  params: Record<string, unknown> = {},
) => actionBuilderFor(action)!(load(action), run, 0, { seed: 7, ...params });

describe("Restore registry and packs", () => {
  it("registers five clip-input actions on packs/ltx25/vfx_restore*.json", () => {
    expect(LTX_RESTORE_ACTIONS).toEqual([
      LTX_RESTORE_ACTION,
      LTX_RESTORE_DEBLUR_ACTION,
      LTX_RESTORE_DECOMPRESS_ACTION,
      LTX_RESTORE_COLORIZE_ACTION,
      LTX_RESTORE_REFINE_ACTION,
    ]);
    for (const action of LTX_RESTORE_ACTIONS) {
      expect(reg.actions[action]).toMatchObject({
        requiresImage: false,
        group: "refine",
      });
      expect(packFile(action)).toMatch(/^packs\/ltx25\/vfx_restore/);
      expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(true);
      expect(actionBuilderFor(action)).toBeTypeOf("function");
    }
  });

  it("raw packs validate against the LTX-2.5 object_info", () => {
    for (const action of LTX_RESTORE_ACTIONS) {
      expect(problems(load(action)), action).toEqual([]);
      const meta = raw(action)._meta as { description: string };
      expect(meta.description).toMatch(/LTX-2 Community License/);
    }
  });

  it("each pack loads its mode's IC-LoRA through GetICLoRAParameters", () => {
    for (const action of LTX_RESTORE_ACTIONS) {
      const wf = load(action);
      const lora = one(wf, "LoraLoaderModelOnly");
      expect(lora.lora_name).toBe(LTX_RESTORE_MODES[action].lora);
      expect(lora.model).toEqual([
        Object.keys(wf).find((id) => wf[id].class_type === "UNETLoader"),
        0,
      ]);
      expect(LTX_BUILTIN_IC_LORA_FILES).toContain(lora.lora_name);
      const params = one(wf, "GetICLoRAParameters");
      const guide = one(wf, "LTXVAddGuide");
      expect(guide.frame_idx).toBe(0);
      expect(guide.strength).toBe(1);
      const loraId = Object.keys(wf).find(
        (id) => wf[id].class_type === "LoraLoaderModelOnly",
      );
      expect(params.iclora_model).toEqual([loraId, 0]);
      expect(guide.iclora_parameters).toEqual([
        Object.keys(wf).find(
          (id) => wf[id].class_type === "GetICLoRAParameters",
        ),
        0,
      ]);
      expect(one(wf, "LTXVDualCFGGuider").model).toEqual([loraId, 0]);
      expect(one(wf, "KSamplerSelect").sampler_name).toBe("euler_ancestral");
      expect(one(wf, "LTXVDualCFGGuider")).toMatchObject({
        video_cfg: 1,
        audio_cfg: 1,
      });
      expect(one(wf, "LTXVCropGuides")).toBeTruthy();
      expect(one(wf, "VAEDecodeTiled")).toBeTruthy();
      expect(one(wf, "CreateVideo").fps).toBe(24);
    }
  });

  it("every LoRA has a gated size row (missing-model downloads)", () => {
    const files = (
      modelSizes as unknown as {
        files: Record<string, { source: string; gated?: boolean }>;
      }
    ).files;
    for (const mode of Object.values(LTX_RESTORE_MODES)) {
      const row = files[path.basename(mode.lora)];
      expect(row, mode.lora).toBeDefined();
      expect(row.source).toMatch(/^Lightricks\/LTX-2\.5-22b-IC-LoRA-/);
      expect(row.gated).toBe(true);
    }
  });

  it("built workflows validate for every mode", () => {
    for (const action of LTX_RESTORE_ACTIONS)
      expect(problems(build(action).workflow), action).toEqual([]);
  });
});

describe("Restore builder", () => {
  it("follows the source length (8n+1, 24 fps) and orientation", () => {
    const wf = build(LTX_RESTORE_ACTION).workflow;
    expect(one(wf, "LoadVideo").file).toBe("old.mp4 [input]");
    expect(one(wf, "VideoFrameSample").num_frames).toBe(65);
    expect(one(wf, "Video Slice").duration).toBeCloseTo(65 / 24, 3);
    expect(one(wf, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 960,
      height: 544,
      length: 65,
    });
    expect(one(wf, "ImageScale")).toMatchObject({ width: 960, height: 544 });
    expect(one(wf, "LTXVEmptyLatentAudio")).toMatchObject({
      frames_number: 65,
      frame_rate: 24,
    });
    expect(one(wf, "LTXVConditioning").frame_rate).toBe(24);
    expect(one(wf, "CreateVideo").audio).toEqual([
      Object.keys(wf).find((id) => wf[id].class_type === "GetVideoComponents"),
      1,
    ]);
    expect(one(wf, "RandomNoise").noise_seed).toBe(7);

    const tall = build(
      LTX_RESTORE_REFINE_ACTION,
      clipRun({ width: 1080, height: 1920, params: { video_seconds: 30 } }),
    ).workflow;
    expect(one(tall, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 576,
      height: 1024,
      length: 97,
    });
    expect(ltxRestoreDims(LTX_RESTORE_DEBLUR_ACTION)).toEqual({
      width: 960,
      height: 544,
    });
  });

  it("prompts use the model-card templates around the scene", () => {
    expect(ltxRestorePrompt(LTX_RESTORE_DEBLUR_ACTION, "a red bus.")).toMatch(
      /^Reference shows a red bus, heavily out of focus.*DEBLUR a red bus\. Subject identity/,
    );
    expect(ltxRestorePrompt(LTX_RESTORE_DECOMPRESS_ACTION, "")).toMatch(
      /macroblocking, chroma bleed, and ringing.*ENHANCE QUALITY the scene\./,
    );
    expect(ltxRestorePrompt(LTX_RESTORE_COLORIZE_ACTION, "a harbour")).toMatch(
      /^Reference shows a black-and-white shot of a harbour\..*COLORIZE a harbour in vivid, natural colors\./,
    );
    expect(ltxRestorePrompt(LTX_RESTORE_ACTION, "1920s Paris street")).toBe(
      "1920s Paris street, natural colour, sharp photographic detail, natural grain, high resolution footage.",
    );
    expect(ltxRestorePrompt(LTX_RESTORE_REFINE_ACTION, "")).toBe(
      "sharp photographic detail, crisp natural texture, fine surface detail, clean edges, natural film grain, high resolution footage",
    );
    const wf = build(LTX_RESTORE_COLORIZE_ACTION, clipRun(), {
      prompt: "a harbour",
    }).workflow;
    const texts = Object.values(wf)
      .filter((n) => n.class_type === "CLIPTextEncode")
      .map((n) => n.inputs.text as string);
    expect(texts.some((t) => t.includes("COLORIZE a harbour"))).toBe(true);
  });

  it("strength defaults to 1.0 and is clamped to 0.5..1.5", () => {
    expect(ltxRestoreStrength(undefined)).toBe(1);
    expect(ltxRestoreStrength("0.8")).toBe(0.8);
    expect(ltxRestoreStrength(0.1)).toBe(0.5);
    expect(ltxRestoreStrength(4)).toBe(1.5);
    const wf = build(LTX_RESTORE_DEBLUR_ACTION, clipRun(), {
      strength: 0.85,
    }).workflow;
    expect(one(wf, "LoraLoaderModelOnly").strength_model).toBe(0.85);
  });

  it("the mode decides the LoRA, whatever pack it is handed", () => {
    const { workflow } = actionBuilderFor(LTX_RESTORE_COLORIZE_ACTION)!(
      load(LTX_RESTORE_ACTION),
      clipRun(),
      0,
      { seed: 1 },
    );
    expect(one(workflow, "LoraLoaderModelOnly").lora_name).toBe(
      LTX_RESTORE_MODES[LTX_RESTORE_COLORIZE_ACTION].lora,
    );
  });

  it("rejects a run without a clip", () => {
    expect(() =>
      build(LTX_RESTORE_ACTION, clipRun({ jobs: [] } as Partial<ImagineRun>)),
    ).toThrow(/no video/);
  });
});

describe("Restore tools page and hub", () => {
  const spec = getActionTool(LTX_RESTORE_ACTION)!;
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(spec),
    ...over,
  });

  it("one card, clip input, mode picker over the five actions", () => {
    expect(spec.videoInput).toBeTruthy();
    expect(spec.modelCheck).toEqual({
      pack: "ltx25",
      action: LTX_RESTORE_ACTION,
    });
    const mode = spec.pickers!.find((p) => p.key === "mode")!;
    expect(mode.paramOnly).toBeFalsy();
    expect(mode.options.map((o) => o.id)).toEqual(LTX_RESTORE_ACTIONS);
    for (const action of LTX_RESTORE_ACTIONS.slice(1))
      expect(getActionTool(action)).toBeUndefined();
  });

  it("the request queues the picked mode's action", () => {
    expect(buildActionRequest(spec, settings(), null)).toEqual({
      action: LTX_RESTORE_ACTION,
      params: { strength: 1 },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        settings({
          text: "a 1950s street",
          seed: 5,
          picks: { mode: LTX_RESTORE_COLORIZE_ACTION, strength: "0.85" },
        }),
        null,
      ),
    ).toEqual({
      action: LTX_RESTORE_COLORIZE_ACTION,
      params: { prompt: "a 1950s street", strength: 0.85, seed: 5 },
      overrides: {},
    });
  });

  it("stays disabled until model-status lists the weights", () => {
    expect(actionAvailability(spec, null, null, { tools: {} }).available).toBe(
      false,
    );
    expect(
      actionAvailability(spec, null, null, {
        tools: { [spec.id]: { missing: [] } },
      }).available,
    ).toBe(true);
  });

  it("hub card in Video, LTX licence (not NC), marked new", () => {
    const [card] = buildToolCards({
      catalog: [],
      packIds: null,
      editLoras: null,
      modelStatus: { tools: { [LTX_RESTORE_ACTION]: { missing: [] } } },
    }).filter((c) => c.id === LTX_RESTORE_ACTION);
    const hub = toHubCard(card, null);
    expect(hub.hubCategory).toBe("Video");
    expect(hub.model).toMatch(/^LTX-2\.5 IC-LoRA Restore/);
    expect(hub.nc).toBe(false);
    expect(hub.aliases).toEqual(
      expect.arrayContaining(["deblur", "colorize", "old footage"]),
    );
    expect(isNewCard(hub)).toBe(true);
  });

  it("history labels name the card and the mode", () => {
    expect(actionLabel(LTX_RESTORE_ACTION)).toBe("Restore video");
    expect(actionLabel(LTX_RESTORE_DEBLUR_ACTION)).toBe("Restore video · Deblur");
    expect(actionLabel(LTX_RESTORE_REFINE_ACTION)).toBe(
      "Restore video · Refine details",
    );
  });
});

describe("Restore routing", () => {
  afterEach(() => {
    delete process.env.COMFY_VIDEO_HTTP_URL;
  });

  it("runs on the video host", () => {
    process.env.COMFY_VIDEO_HTTP_URL = "http://pc:8288/";
    for (const action of LTX_RESTORE_ACTIONS)
      expect(routeBackend({ action, workflowPath: packFile(action) })).toBe(
        "video",
      );
  });
});
