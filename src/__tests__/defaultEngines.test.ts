/**
 * Defaults that run on a stock install (critique E, D10/D11): video routes
 * to LTX-2.5, Make 3D to TRELLIS.2, and a default graph whose node/model is
 * absent fails with a plain "needs X" message.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { getPack, resolveActionWorkflow, resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  ANIMATE_MOTION_HINTS,
  buildMake3dWorkflow,
  isTrellisWorkflow,
} from "@/lib/oj/defaultEngines";
import {
  DEFAULT_VIDEO_PACK,
  defaultVideoPack,
  settingsVideoModel,
  videoModelFlag,
} from "@/lib/oj/videoDefault";
import { isLtx25Workflow } from "@/lib/oj/ltx25";
import { resolveSubmitPackId } from "@/lib/comfy/memory";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { missingFromProblems, needsMessage } from "@/lib/comfy/needsMessage";

const PUBLIC = path.join(process.cwd(), "public", "workflows");
const load = (rel: string) =>
  JSON.parse(fs.readFileSync(path.join(PUBLIC, rel), "utf8")) as Workflow;

const run = (prompt = "a lighthouse"): ImagineRun =>
  ({
    run_id: "r",
    prompt,
    parsedPrompt: prompt,
    width: 1344,
    height: 768,
    createdAt: "2026-10-27T00:00:00Z",
    status: "done",
    jobs: [
      {
        seed: 1,
        index: 0,
        status: "done",
        progress: 100,
        images: ["/api/comfy/view?filename=still.png&subfolder=&type=input"],
      },
    ],
    params: {},
  }) as unknown as ImagineRun;

const templates = registry.templates as Record<string, { file: string }>;
const actions = registry.actions as Record<string, { template?: string }>;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registry + pack defaults", () => {
  it("video templates point at the LTX-2.5 graphs", () => {
    expect(templates.t2v.file).toBe("packs/ltx25/t2v.json");
    expect(templates.i2v.file).toBe("packs/ltx25/i2v.json");
    expect(templates.t2v.file).toBe(getPack("ltx25")!.workflows.t2v);
    expect(templates.i2v.file).toBe(getPack("ltx25")!.workflows.i2v);
  });

  it("Make 3D uses the TRELLIS.2 graph", () => {
    expect(actions.make_3d.template).toBe("make_3d_trellis");
    expect(templates.make_3d_trellis.file).toBe(
      "packs/trellis2/make_3d_trellis.json",
    );
  });

  it("the SDXL default pack no longer routes video to legacy LTXV graphs", () => {
    const sdxl = getPack("sdxl")!;
    expect(sdxl.workflows.t2v).toBeUndefined();
    expect(sdxl.workflows.i2v).toBeUndefined();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PUBLIC, "packs/sdxl/pack.json"), "utf8"),
    ) as { workflows: Record<string, string> };
    expect(manifest.workflows.t2v).toBeUndefined();
    expect(manifest.workflows.i2v).toBeUndefined();
  });

  it("bare video templates resolve to LTX-2.5", () => {
    expect(resolveWorkflow({ templateOrAction: "i2v" }).workflowPath).toBe(
      "packs/ltx25/i2v.json",
    );
    expect(resolveWorkflow({ templateOrAction: "t2v" }).workflowPath).toBe(
      "packs/ltx25/t2v.json",
    );
  });

  it("animate with an image checkpoint hint still takes the video fallback", () => {
    const r = resolveActionWorkflow(
      {
        templateOrAction: "animate_low",
        template: "i2v",
        checkpointName: "sd_xl_base_1.0.safetensors",
      },
      ["wan", "ltx25"],
    );
    expect(r.workflowPath).toBe(getPack("wan")!.workflows.i2v);
    expect(r.pack?.id).toBe("wan");
  });

  it("Make 3D resolves to the TRELLIS.2 graph", () => {
    const r = resolveActionWorkflow(
      { templateOrAction: "make_3d", template: "make_3d_trellis" },
      [],
    );
    expect(r.workflowPath).toBe("packs/trellis2/make_3d_trellis.json");
  });
});

describe("default video pack", () => {
  it("request, then env, then LTX-2.5", () => {
    expect(DEFAULT_VIDEO_PACK).toBe("ltx25");
    expect(defaultVideoPack(undefined, undefined)).toBe("ltx25");
    expect(defaultVideoPack("  ", "  ")).toBe("ltx25");
    expect(defaultVideoPack(undefined, "wan")).toBe("wan");
    expect(defaultVideoPack("minimax", "wan")).toBe("minimax");
  });

  it("reads CJ_DEFAULT_VIDEO_PACK by default", () => {
    vi.stubEnv("CJ_DEFAULT_VIDEO_PACK", "wan");
    expect(defaultVideoPack()).toBe("wan");
  });

  it("settings: legacy stored ltxv reads as the default and sends no flag", () => {
    expect(settingsVideoModel(undefined)).toBe("ltx25");
    expect(settingsVideoModel("ltxv")).toBe("ltx25");
    expect(settingsVideoModel("wan")).toBe("wan");
    expect(videoModelFlag("ltx25")).toBeUndefined();
    expect(videoModelFlag("ltxv")).toBeUndefined();
    expect(videoModelFlag("minimax")).toBe("minimax");
  });

  it("store default emits no --vmodel; other engines do", async () => {
    const { selectSettingsString, useUIStore } = await import("@/store");
    const base = useUIStore.getState();
    expect(base.settings.videoModel).toBe("ltx25");
    const str = (videoModel: string) =>
      selectSettingsString({
        ...base,
        settings: { ...base.settings, videoModel },
      } as typeof base);
    expect(str("ltx25")).not.toContain("--vmodel");
    expect(str("ltxv")).not.toContain("--vmodel");
    expect(str("wan")).toContain("--vmodel wan");
  });

  it("memory preflight assumes LTX-2.5 for --video", () => {
    expect(resolveSubmitPackId({ params: { video: true } })).toBe("ltx25");
    expect(
      resolveSubmitPackId({ params: { video: true }, defaultVideoPack: "ltxv" }),
    ).toBe("ltx25");
    expect(
      resolveSubmitPackId({ params: { video: true }, defaultVideoPack: "wan" }),
    ).toBe("wan");
  });
});

describe("default action builders", () => {
  it("Animate Low/High on LTX-2.5 use the LTX builder with a motion hint", () => {
    const base = load("packs/ltx25/i2v.json");
    expect(isLtx25Workflow(base)).toBe(true);
    for (const [action, motion] of [
      ["animate_low", "low"],
      ["animate_high", "high"],
    ] as const) {
      const build = actionBuilderFor(action);
      expect(build).toBeTypeOf("function");
      const { workflow } = build!(base, run("a lighthouse"), 0, { seed: 7 });
      const texts = Object.values(workflow)
        .filter((n) => n.class_type === "CLIPTextEncode")
        .map((n) => String((n.inputs as Record<string, unknown>).text));
      expect(texts.some((t) => t.includes(ANIMATE_MOTION_HINTS[motion]))).toBe(
        true,
      );
      expect(texts.some((t) => t.startsWith("a lighthouse"))).toBe(true);
      const images = Object.values(workflow)
        .filter((n) => n.class_type === "LoadImage")
        .map((n) => (n.inputs as Record<string, unknown>).image);
      expect(images).toContain("still.png [input]");
    }
  });

  it("Animate on a non-LTX-2.5 graph keeps the generic path", () => {
    const base = load("packs/wan/i2v.json");
    expect(isLtx25Workflow(base)).toBe(false);
    const { workflow } = actionBuilderFor("animate_low")!(base, run(), 0, {});
    const hint = ANIMATE_MOTION_HINTS.low;
    const texts = Object.values(workflow).map((n) =>
      JSON.stringify(n.inputs ?? {}),
    );
    expect(texts.some((t) => t.includes(hint))).toBe(false);
  });

  it("Make 3D on the TRELLIS.2 graph uses the Trellis builder", () => {
    const base = load("packs/trellis2/make_3d_trellis.json");
    expect(isTrellisWorkflow(base)).toBe(true);
    expect(actionBuilderFor("make_3d")).toBe(buildMake3dWorkflow);
    const { workflow } = buildMake3dWorkflow(base, run(), 0, {});
    const load122 = workflow["122"]?.inputs as Record<string, unknown>;
    expect(String(load122.image)).toContain("still.png");
    expect(isTrellisWorkflow(load("i23d.json"))).toBe(false);
  });
});

describe("missing nodes/models degrade to a needs-X message", () => {
  /** object_info knowing every class of `wf` except `drop`. */
  const infoWithout = (wf: Workflow, drop: string[]) =>
    Object.fromEntries(
      Object.values(wf)
        .map((n) => n.class_type)
        .filter((c) => !drop.includes(c))
        .map((c) => [c, { input: {} }]),
    );

  it("TripoSR graph: names the missing nodes", () => {
    const wf = load("i23d.json");
    const drop = ["TripoSRModelLoader", "TripoSRSampler"];
    const problems = validatePrompt(wf, infoWithout(wf, drop));
    expect(missingFromProblems(problems).nodes).toEqual(drop);
    const msg = needsMessage(problems)!;
    expect(msg).toContain("TripoSRModelLoader and TripoSRSampler");
    expect(msg).toMatch(/^This needs the ComfyUI nodes /);
    expect(msg).not.toMatch(/#\d|class_type|failed validation/);
  });

  it("missing model file reads as a needs-model line", () => {
    const msg = needsMessage([
      {
        kind: "invalid_combo_value",
        nodeId: "1",
        nodeTitle: "Load LoRA",
        classType: "LoraLoaderModelOnly",
        input: "lora_name",
        message: 'Value "ltx25/x.safetensors" is not an available option',
      },
    ]);
    expect(msg).toBe(
      "This needs the model file ltx25/x.safetensors, which isn't installed on this ComfyUI yet. Install it (see Set up this tool), then try again.",
    );
  });

  it("other validation problems keep the original message", () => {
    expect(needsMessage(undefined)).toBeNull();
    expect(
      needsMessage([
        {
          kind: "out_of_range",
          nodeId: "1",
          nodeTitle: "KSampler",
          classType: "KSampler",
          input: "steps",
          message: "Value 0 is below min 1",
        },
      ]),
    ).toBeNull();
  });
});
