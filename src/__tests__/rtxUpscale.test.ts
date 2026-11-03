/**
 * Upscale video engine "NVIDIA RTX" (Nvidia_RTX_Nodes_ComfyUI,
 * packs/rtx): graph, builder, registry + tool wiring, node check and the
 * proprietary-SDK licence class.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  RTX_DEFAULT_QUALITY,
  RTX_MAX_PIXEL_FRAMES,
  RTX_UPSCALE_ACTION,
  buildRtxUpscaleWorkflow,
  rtxScaleExpression,
} from "@/lib/oj/rtxUpscale";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import { routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { setupHint } from "@/lib/tools/setupHint";
import {
  RTX_NODES_INSTALL,
  actionAvailability,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  nodePackReason,
  optionBlocksFor,
  pickBlock,
  pickerVisible,
  type ModelStatusResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { actionsForTool, buildToolDocRows } from "@/lib/tools/toolsDoc";
import { requiredActionFamilies } from "@/lib/tools/openWeightsGen";
import weightClasses from "@/lib/tools/toolWeightClasses.json";
import rtxObjectInfo from "./fixtures/rtxNodes.objectInfo.json";
import type { ImagineRun, Workflow } from "@/types";

const ROOT = process.cwd();
const WORKFLOWS_DIR = path.join(ROOT, "public/workflows");
const RTX = "packs/rtx/rtx_upscale.json";
const raw = () => fs.readFileSync(path.join(WORKFLOWS_DIR, RTX), "utf-8");
const load = (): Workflow => JSON.parse(raw());
const graphNodes = (wf: Workflow) =>
  Object.fromEntries(
    Object.entries(wf).filter(([id]) => id !== "_meta"),
  ) as Workflow;

const VID = "/api/comfy/view?filename=fox.mp4&subfolder=video&type=output";
const run = (videos: string[] = [VID], seed = 11): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    width: 832,
    height: 480,
    jobs: [
      {
        seed,
        index: 0,
        status: "completed",
        progress: 100,
        images: [],
        videos,
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const hits = byClass(wf, cls);
  expect(hits, cls).toHaveLength(1);
  return hits[0];
};
const link = (v: unknown) => v as [string, number];
const spec = getActionTool("upscale_video")!;
const settings = (picks: Record<string, string>): ToolSettings => {
  const s = defaultSettings(spec);
  return { ...s, picks: { ...s.picks, ...picks } };
};
const status = (tools: Record<string, string[]>): ModelStatusResponse =>
  ({
    tools: Object.fromEntries(
      Object.entries(tools).map(([k, missing]) => [k, { missing }]),
    ),
  }) as ModelStatusResponse;

/** Evaluate a ComfyMathExpression the way Python would (// = floor div). */
function evalExpr(expr: string, vars: Record<string, number>): number {
  const js = expr
    .replace(/\(([^()]+)\) \/\/ (\d+)/g, "Math.floor(($1) / $2)")
    .replace(/(\d+) \/\/ \(([^()]+)\)/g, "Math.floor($1 / ($2))");
  const names = Object.keys(vars);
  return Number(
    Function(
      "min",
      "max",
      ...names,
      `return ${js}`,
    )(Math.min, Math.max, ...names.map((n) => vars[n])),
  );
}

/** Output size + kept frames the graph computes for a source clip. */
function plan(wf: Workflow, w: number, h: number, frames: number) {
  const [, vsr] = one(wf, "RTXVideoSuperResolution");
  const widthNode = wf[link(vsr.inputs["resize_type.width"])[0]];
  const heightNode = wf[link(vsr.inputs["resize_type.height"])[0]];
  const scaleNode = wf[link(widthNode.inputs["values.b"])[0]];
  const s = evalExpr(String(scaleNode.inputs.expression), { a: w, b: h });
  const W = evalExpr(String(widthNode.inputs.expression), { a: w, b: s });
  const H = evalExpr(String(heightNode.inputs.expression), { a: h, b: s });
  const [, trim] = byClass(wf, "ImageFromBatch")[0];
  const cap = wf[link(trim.inputs.length)[0]];
  const kept = evalExpr(String(cap.inputs.expression), {
    a: W,
    b: H,
    c: frames,
  });
  return { W, H, kept };
}

describe("rtx_upscale graph", () => {
  it("is wired in the registry and routes to the video host", () => {
    const actions = registry.actions as Record<string, Record<string, unknown>>;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[RTX_UPSCALE_ACTION]).toMatchObject({
      template: RTX_UPSCALE_ACTION,
      requiresImage: false,
      group: "upscale",
    });
    expect(templates[RTX_UPSCALE_ACTION].file).toBe(RTX);
    expect(actionBuilderFor(RTX_UPSCALE_ACTION)).toBeTypeOf("function");
    expect(
      resolveWorkflow({ templateOrAction: RTX_UPSCALE_ACTION, packId: "krea2" })
        .workflowPath,
    ).toBe(RTX);
    expect(VIDEO_INPUT_ACTIONS.has(RTX_UPSCALE_ACTION)).toBe(true);
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({ action: RTX_UPSCALE_ACTION, workflowPath: RTX }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("LoadVideo -> RTX VSR -> CreateVideo (source fps + audio) -> SaveVideo", () => {
    const wf = load();
    const [loadId] = one(wf, "LoadVideo");
    const [compId, comp] = one(wf, "GetVideoComponents");
    expect(comp.inputs.video).toEqual([loadId, 0]);
    const [vsrId, vsr] = one(wf, "RTXVideoSuperResolution");
    expect(vsr.inputs).toMatchObject({
      resize_type: "target dimensions",
      quality: RTX_DEFAULT_QUALITY,
      strength: 1,
      image_encoding: "8-bit RGB",
    });
    const [trimId, trim] = one(wf, "ImageFromBatch");
    expect(trim.inputs.image).toEqual([compId, 0]);
    expect(vsr.inputs.images).toEqual([trimId, 0]);
    const [createId, create] = one(wf, "CreateVideo");
    expect(create.inputs).toEqual({
      images: [vsrId, 0],
      fps: [compId, 2],
      audio: [compId, 1],
    });
    const [, save] = one(wf, "SaveVideo");
    expect(save.inputs.video).toEqual([createId, 0]);
    expect(save.inputs.filename_prefix).toBe("video/CJ_Upscale_RTX");
  });

  it("matches the live node's inputs (dynamic combo + quality options)", () => {
    const info = (
      rtxObjectInfo as unknown as Record<
        string,
        {
          input: {
            required: Record<string, [unknown, Record<string, unknown>]>;
          };
        }
      >
    ).RTXVideoSuperResolution.input.required;
    const [, vsr] = one(load(), "RTXVideoSuperResolution");
    const opts = info.resize_type[1].options as {
      key: string;
      inputs: { required: Record<string, unknown> };
    }[];
    const target = opts.find((o) => o.key === vsr.inputs.resize_type)!;
    expect(target).toBeDefined();
    for (const k of Object.keys(target.inputs.required))
      expect(vsr.inputs[`resize_type.${k}`]).toBeDefined();
    expect(info.quality[1].options).toContain(RTX_DEFAULT_QUALITY);
    expect(info.image_encoding[1].options).toContain(vsr.inputs.image_encoding);
    expect(missingAgainstObjectInfo(graphNodes(load()), {})).toContain(
      "node:RTXVideoSuperResolution",
    );
  });

  it("resolves every link, uses no API nodes, no personal paths, no SDK files", () => {
    const wf = load();
    for (const [id, node] of Object.entries(graphNodes(wf)))
      for (const [k, v] of Object.entries(node.inputs ?? {}))
        if (Array.isArray(v) && typeof v[0] === "string")
          expect(wf[v[0]], `${id}.${k} -> ${v[0]}`).toBeDefined();
    expect(raw()).not.toMatch(/\/Users\/|\/home\/|\/mnt\/|[A-Z]:\\\\/);
    expect(raw()).not.toMatch(/\.(dll|so|whl|trt|engine)\b/);
    const classes = Object.values(graphNodes(wf)).map((n) => n.class_type);
    expect(classes.some((c) => /wavespeed|api/i.test(c ?? ""))).toBe(false);
    // No weight files: the models ship inside the SDK.
    expect(workflowModelRequirements(graphNodes(wf))).toEqual([]);
  });

  it("the repo vendors no NVIDIA SDK binaries", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", ".git", "private"].includes(e.name))
          continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/nvidia[_-]?vfx|nvvfx|NVVideoEffects/i.test(e.name))
          hits.push(p);
      }
    };
    walk(path.join(ROOT, "public"));
    walk(path.join(ROOT, "comfy_nodes"));
    expect(hits).toEqual([]);
  });
});

describe("rtx_upscale builder", () => {
  it("sets the source clip, the size expression and the quality", () => {
    const { workflow, slots, seed } = buildRtxUpscaleWorkflow(
      load(),
      run([VID], 77),
      0,
      { scale: "1080p" },
    );
    const [loadId, loadNode] = one(workflow, "LoadVideo");
    expect(loadNode.inputs.file).toBe("video/fox.mp4 [output]");
    expect(slots.imageInputId).toBe(loadId);
    const [vsrId, vsr] = one(workflow, "RTXVideoSuperResolution");
    expect(slots.ksamplerId).toBe(vsrId);
    expect(vsr.inputs.quality).toBe(RTX_DEFAULT_QUALITY);
    expect(seed).toBe(77);
    const scale = byClass(workflow, "ComfyMathExpression").find(
      ([, n]) => n._meta?.title === "Scale factor",
    )!;
    expect(scale[1].inputs.expression).toBe(rtxScaleExpression("1080p"));
  });

  it("2x is the default; unknown picks fall back to 2x", () => {
    expect(rtxScaleExpression(undefined)).toBe(rtxScaleExpression("2x"));
    expect(rtxScaleExpression("8k")).toBe(rtxScaleExpression("2x"));
    const def = buildRtxUpscaleWorkflow(load(), run(), 0, {});
    expect(plan(def.workflow, 832, 480, 97)).toEqual({
      W: 1664,
      H: 960,
      kept: 97,
    });
  });

  it.each([
    // size pick, source w x h, expected output w x h
    ["2x", 1280, 720, 2560, 1440],
    ["2x", 2560, 1440, 3840, 2160], // stops at a 3840 long side
    ["2x", 3840, 2160, 3840, 2160], // never below 1x
    ["1080p", 854, 480, 1920, 1080],
    ["1080p", 480, 854, 1080, 1920], // vertical: short side 1080
    ["1080p", 320, 180, 1280, 720], // at most 4x
    ["4k", 1920, 1080, 3840, 2160],
    ["4k", 1280, 720, 3840, 2160],
    ["4k", 832, 480, 3328, 1920], // 4x cap
  ])("%s: %ix%i -> %ix%i, dims /8", (scale, w, h, W, H) => {
    const { workflow } = buildRtxUpscaleWorkflow(load(), run(), 0, { scale });
    const out = plan(workflow, w, h, 10);
    expect([out.W, out.H]).toEqual([W, H]);
    expect(out.W % 8).toBe(0);
    expect(out.H % 8).toBe(0);
  });

  it("caps frames to the RAM budget (240 at 4K, 960 at 1080p) and 4096", () => {
    expect(RTX_MAX_PIXEL_FRAMES / (3840 * 2160)).toBe(240);
    expect(RTX_MAX_PIXEL_FRAMES / (1920 * 1080)).toBe(960);
    const wf = load();
    const [capId, cap] = byClass(wf, "ComfyMathExpression").find(([, n]) =>
      String(n.inputs.expression).includes(String(RTX_MAX_PIXEL_FRAMES)),
    )!;
    expect(one(wf, "ImageFromBatch")[1].inputs.length).toEqual([capId, 1]);
    // Budget is on the output size, not the source.
    const [, vsr] = one(wf, "RTXVideoSuperResolution");
    expect(cap.inputs["values.a"]).toEqual(vsr.inputs["resize_type.width"]);
    expect(cap.inputs["values.b"]).toEqual(vsr.inputs["resize_type.height"]);
    const four = buildRtxUpscaleWorkflow(wf, run(), 0, { scale: "4k" });
    expect(plan(four.workflow, 1920, 1080, 600).kept).toBe(240);
    expect(plan(four.workflow, 1920, 1080, 100).kept).toBe(100);
    const hd = buildRtxUpscaleWorkflow(wf, run(), 0, { scale: "1080p" });
    expect(plan(hd.workflow, 960, 540, 2000).kept).toBe(960);
    expect(plan(hd.workflow, 64, 64, 9000).kept).toBe(4096);
  });

  it("throws without a source video or the RTX node", () => {
    expect(() => buildRtxUpscaleWorkflow(load(), run([]), 0)).toThrow(
      /no video/,
    );
    const wf = load();
    const [vsrId] = one(wf, "RTXVideoSuperResolution");
    delete wf[vsrId];
    expect(() => buildRtxUpscaleWorkflow(wf, run(), 0)).toThrow(
      /missing RTXVideoSuperResolution/,
    );
  });
});

describe("Upscale video engine picker: NVIDIA RTX", () => {
  it("is opt-in (Fast stays the default) and labelled proprietary", () => {
    expect(buildActionRequest(spec, settings({}), null).action).toBe(
      "video_upscale",
    );
    const engine = spec.pickers!.find((p) => p.key === "engine")!;
    expect(engine.options[0].id).toBe("fast");
    const rtx = engine.options.find((o) => o.id === "rtx")!;
    expect(rtx).toMatchObject({ requiresTool: RTX_UPSCALE_ACTION });
    expect(rtx.label).toMatch(/^NVIDIA RTX/);
    expect(rtx.label).toMatch(/proprietary/i);
    expect(rtx.hint).toMatch(/not generative/i);
    expect(rtx.hint).toMatch(/proprietary/i);
  });

  it("routes to rtx_upscale with the size pick", () => {
    for (const scale of ["2x", "1080p", "4k"])
      expect(
        buildActionRequest(spec, settings({ engine: "rtx", scale }), null),
      ).toEqual({
        action: RTX_UPSCALE_ACTION,
        params: { scale },
        overrides: {},
      });
    const size = spec.pickers!.find((p) => p.key === "scale")!;
    const model = spec.pickers!.find((p) => p.key === "model")!;
    expect(pickerVisible(size, spec, settings({ engine: "rtx" }))).toBe(true);
    expect(pickerVisible(model, spec, settings({ engine: "rtx" }))).toBe(false);
    const req = buildActionRequest(
      spec,
      settings({ engine: "rtx", scale: "4k" }),
      null,
    );
    const { workflow } = actionBuilderFor(req.action)!(
      load(),
      run(),
      0,
      req.params,
    );
    expect(one(workflow, "LoadVideo")[1].inputs.file).toBe(
      "video/fox.mp4 [output]",
    );
  });

  it("the hidden tool checks the RTX node class (no weights)", () => {
    const t = getActionTool(RTX_UPSCALE_ACTION)!;
    expect(t).toMatchObject({
      hidden: true,
      requireStatusEntry: true,
      modelCheck: { pack: "rtx", action: RTX_UPSCALE_ACTION },
      nodePack: {
        id: "Nvidia_RTX_Nodes_ComfyUI",
        nodes: ["RTXVideoSuperResolution"],
      },
    });
    expect(t.videoInput).toBeTruthy();
  });

  it("missing node -> install the pack + pip install nvidia-vfx", () => {
    const t = getActionTool(RTX_UPSCALE_ACTION)!;
    const av = actionAvailability(
      t,
      new Set(),
      null,
      status({ rtx_upscale: ["node:RTXVideoSuperResolution"] }),
    );
    expect(av.available).toBe(false);
    expect(av.reason).toBe(
      `The Nvidia_RTX_Nodes_ComfyUI pack isn't installed on this server (missing nodes: RTXVideoSuperResolution). ${RTX_NODES_INSTALL}`,
    );
    expect(av.reason).toContain(
      "https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI",
    );
    expect(av.reason).toContain(
      "pip install nvidia-vfx --extra-index-url https://pypi.nvidia.com",
    );
    expect(av.reason).not.toContain("comfy_nodes/");
    expect(setupHint(av.reason)).toBe(
      "Needs the Nvidia_RTX_Nodes_ComfyUI pack",
    );
    expect(
      actionAvailability(t, new Set(), null, status({ rtx_upscale: [] }))
        .available,
    ).toBe(true);
    // Other packs keep the copy-from-comfy_nodes fix.
    expect(
      nodePackReason(getActionTool("vectorize")!, ["node:CJVectorize"]),
    ).toContain("Copy comfy_nodes/cj_image_tools");
  });

  it("blocks only the RTX option while its nodes are missing", () => {
    const blocks = optionBlocksFor(
      spec,
      new Set(["utility", "seedvr2", "flashvsr", "ltx25", "rtx"]),
      null,
      status({
        upscale_video: [],
        upscale_seedvr2: [],
        flashvsr_upscale: [],
        ltx_upscale_x2: [],
        rtx_upscale: ["node:RTXVideoSuperResolution"],
      }),
    );
    expect(Object.keys(blocks?.engine ?? {})).toEqual(["rtx"]);
    const card = { optionBlocks: blocks };
    expect(pickBlock(card, spec, settings({ engine: "rtx" }))).toBe(
      blocks!.engine.rtx,
    );
    expect(pickBlock(card, spec, settings({ engine: "fast" }))).toBeNull();
  });
});

describe("licence: proprietary SDK, never open", () => {
  const classes = (weightClasses as { classes: Record<string, string> })
    .classes;

  it("the RTX engine is 'check', not open; Upscale video stays open", () => {
    expect(classes[`action:${RTX_UPSCALE_ACTION}`]).toBe("check");
    expect(classes["action:upscale_video"]).toBe("open");
    // The card's required families do not include the optional engine.
    const required = requiredActionFamilies(spec, (rel) =>
      JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8")),
    );
    expect(required).not.toBeNull();
    expect(required!.map((f) => f.id)).not.toContain("nvidia-vfx");
  });

  it("the docs list the SDK on the engine and on Upscale video", () => {
    expect(actionsForTool(spec)).toContain(RTX_UPSCALE_ACTION);
    const { rows } = buildToolDocRows((rel) =>
      JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8")),
    );
    for (const key of [
      `action:${RTX_UPSCALE_ACTION}`,
      "action:upscale_video",
    ]) {
      const row = rows.find((r) => r.key === key)!;
      const fam = row.families.find((f) => f.id === "nvidia-vfx");
      expect(fam, key).toMatchObject({
        license: "NVIDIA proprietary SDK (nvidia-vfx)",
        commercial: "unverified",
      });
    }
    const engine = rows.find((r) => r.key === `action:${RTX_UPSCALE_ACTION}`)!;
    expect(engine.commercial).toBe("unverified");
  });
});
