/**
 * Video Expand (packs/ltx25/video_expand.json = default engine,
 * packs/wan22/video_expand.json = experimental VACE engine,
 * src/lib/oj/videoExpand.ts):
 * geometry, builder graph, graph lint against the recorded object_info of
 * the reference box (fixtures/videoExpandNodes.objectInfo.json, read-only
 * GET), registry / tool card / lightbox wiring, and the action route with
 * ComfyUI mocked (nothing is queued for real; global fetch throws).
 */
import * as realFs from "fs";
import * as path from "path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  VEX_NODES,
  VIDEO_EXPAND_DEFAULT_PROMPT,
  VIDEO_EXPAND_MAX_EDGE,
  VIDEO_EXPAND_LTX_DEFAULT_PROMPT,
  VIDEO_EXPAND_LTX_WIDE_SUFFIX,
  ltxPromptFor,
  VIDEO_EXPAND_LTX_LORA,
  VIDEO_EXPAND_LTX_MAX_FRAMES,
  VIDEO_EXPAND_LTX_NEGATIVE,
  VIDEO_EXPAND_VACE_MAX_FRAMES,
  VEX_LTX_NODES,
  buildVideoExpandLtxWorkflow,
  buildVideoExpandWanWorkflow,
  videoExpandEngine,
  videoExpandLtxCanvas,
  videoExpandLtxFrames,
  videoExpandLtxPlan,
  videoExpandTemplate,
  VIDEO_EXPAND_MODES,
  buildVideoExpandWorkflow,
  videoExpandCanvas,
  videoExpandPlan,
  videoExpandModeIssue,
} from "@/lib/oj/videoExpand";
import { resolveCardKey } from "@/lib/tools/toolRegistry";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { lintErrors, lintGraph, formatLintIssue } from "@/lib/tools/graphLint";
import { INLINE_TOOLS } from "@/lib/ui/lightboxTools";

const fsAccessSpy = vi.fn();
vi.mock("fs/promises", () => ({
  default: { access: fsAccessSpy, readFile: vi.fn(), mkdir: vi.fn() },
  access: fsAccessSpy,
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  extractImageUrls: vi.fn(() => []),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));
vi.mock("@/lib/comfy/runs", () => ({
  getActiveRun: vi.fn(),
  addActiveRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));

import { queuePrompt } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";

const PACK = "packs/wan22/video_expand.json";
const LTX_PACK = "packs/ltx25/video_expand.json";
const rawPack = (pack = PACK): Record<string, unknown> =>
  JSON.parse(
    realFs.readFileSync(
      path.join(process.cwd(), "public/workflows", pack),
      "utf-8",
    ),
  );
const graph = (pack = PACK): Workflow => {
  const raw = rawPack(pack);
  delete raw._meta;
  return raw as Workflow;
};
const ltxGraph = () => graph(LTX_PACK);
/** Wan VACE builder via the dispatcher (explicit engine). */
const buildWan = (
  wf: Workflow,
  r: ImagineRun,
  i: number,
  params: Record<string, unknown> = {},
) => buildVideoExpandWorkflow(wf, r, i, { engine: "wan", ...params });
const { _meta: _fixtureMeta, ...OBJECT_INFO } = JSON.parse(
  realFs.readFileSync(
    path.join(__dirname, "fixtures/videoExpandNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const VIDEO_URL =
  "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=cj&type=input";

function run(extra: Partial<ImagineRun> = {}): ImagineRun {
  return {
    run_id: "src-video",
    prompt: "a fox running through snowy woods",
    parsedPrompt: "a fox running through snowy woods",
    width: 1280,
    height: 720,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [VIDEO_URL],
      },
    ],
    params: { video_seconds: 6 },
    ...extra,
  } as ImagineRun;
}

const inputs = (wf: Workflow, id: string) =>
  wf[id].inputs as Record<string, unknown>;

function expectLinked(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
      }
    }
  }
}

/** Evaluate a ComfyMathExpression the way simpleeval would (ints only). */
function evalExpr(expr: string, a: number, b = 0): number {
  let js = expr.replace(/\bint\(/g, "Math.trunc(").replace(/\bmin\(/g, "Math.min(");
  // `(...) // N` (no nested parens inside the group) -> Math.floor(.../N)
  js = js.replace(/(\([^()]*\)) \/\/ (\d+)/g, "Math.floor($1 / $2)");
  expect(js, expr).not.toMatch(/\/\//);
  return new Function("a", "b", `return ${js};`)(a, b) as number;
}

/**
 * What the graph's fit + paste-back nodes compute for real decoded frames
 * of rawW x rawH (follows the links, so it checks the wiring too).
 */
function evalFit(
  wf: Workflow,
  rawW: number,
  rawH: number,
  ids: { capW: string; capH: string; outW: string; outH: string; composite: string },
) {
  const math = (id: string, a: number, b?: number) =>
    evalExpr(String(inputs(wf, id).expression), a, b);
  const width = math(ids.capW, rawW, rawH);
  const height = math(ids.capH, rawW, rawH);
  const outW = math(ids.outW, width);
  const outH = math(ids.outH, height);
  const off = (v: unknown, size: number, out: number) => {
    if (typeof v === "number") return v;
    expect(Array.isArray(v)).toBe(true);
    return math((v as [string, number])[0], size, out);
  };
  const c = inputs(wf, ids.composite);
  return {
    width,
    height,
    outW,
    outH,
    x: off(c.x, width, outW),
    y: off(c.y, height, outH),
  };
}

const WAN_FIT = { capW: "46", capH: "47", outW: "42", outH: "43", composite: "53" };
const LTX_FIT = WAN_FIT;

describe("videoExpandPlan geometry", () => {
  const modes = Object.keys(VIDEO_EXPAND_MODES);
  const sizes: [number, number][] = [
    [1280, 720],
    [720, 1280],
    [1920, 1080],
    [640, 480],
    [1080, 1080],
    [853, 480],
  ];

  it.each(sizes)(
    "%ix%i: aligned, even, original inside, cap respected",
    (w, h) => {
      for (const m of modes) {
        let p;
        try {
          p = videoExpandPlan(w, h, m);
        } catch (e) {
          // Only an aspect change to the clip's own aspect may refuse.
          expect(m.startsWith("aspect_"), `${m}: ${(e as Error).message}`).toBe(
            true,
          );
          continue;
        }
        const { out, gen, feather } = p;
        // Output frame = original + pads, even (yuv420), under the cap.
        expect(out.width, m).toBe(p.srcWidth + out.left + out.right);
        expect(out.height, m).toBe(p.srcHeight + out.top + out.bottom);
        expect(out.width % 2, m).toBe(0);
        expect(out.height % 2, m).toBe(0);
        expect(Math.max(out.width, out.height), m).toBeLessThanOrEqual(
          VIDEO_EXPAND_MAX_EDGE,
        );
        for (const s of ["left", "top", "right", "bottom"] as const) {
          expect(out[s], `${m} ${s}`).toBeGreaterThanOrEqual(0);
          // Grey pads on the 8-px grid, source rect / canvas on 16.
          expect(gen[s] % 8, `${m} ${s}`).toBe(0);
          // A side is generated iff it is padded in the output, and only
          // padded sides get a feather ramp.
          // (An odd source size may add 1 px on a non-generated side.)
          if (gen[s] > 0) expect(out[s], `${m} ${s}`).toBeGreaterThan(1);
          else expect(out[s], `${m} ${s}`).toBeLessThanOrEqual(1);
          expect(feather[s] > 0, `${m} ${s}`).toBe(gen[s] > 0);
          expect(feather[s]).toBeLessThanOrEqual(16);
        }
        expect(gen.width % 16).toBe(0);
        expect(gen.height % 16).toBe(0);
        expect(gen.srcWidth % 16).toBe(0);
        expect(gen.srcHeight % 16).toBe(0);
        expect(gen.width).toBe(gen.srcWidth + gen.left + gen.right);
        expect(gen.height).toBe(gen.srcHeight + gen.top + gen.bottom);
        expect(gen.width * gen.height).toBeLessThanOrEqual(1280 * 480);
        // The original's position in the output matches the generation within
        // 1% of the frame (the border lines up with the pasted original).
        expect(
          Math.abs(out.left / out.width - gen.left / gen.width),
        ).toBeLessThan(0.01);
        expect(
          Math.abs(out.top / out.height - gen.top / gen.height),
        ).toBeLessThan(0.01);
        expect(
          Math.abs(p.srcWidth / out.width - gen.srcWidth / gen.width),
        ).toBeLessThan(0.02);
        expect(
          Math.abs(p.srcHeight / out.height - gen.srcHeight / gen.height),
        ).toBeLessThan(0.02);
      }
    },
  );

  it("zoom grows both axes about evenly, pan one side, aspect the short axis", () => {
    const z = videoExpandPlan(1280, 720, "zoom_1_5");
    expect(z.downscaled).toBe(false);
    expect(z.out.width / 1280).toBeGreaterThan(1.45);
    expect(z.out.width / 1280).toBeLessThan(1.6);
    expect(z.out.left).toBe(z.out.right);
    expect(z.out.top).toBe(z.out.bottom);

    const l = videoExpandPlan(1280, 720, "pan_left");
    expect(l.out).toMatchObject({ top: 0, right: 0, bottom: 0, height: 720 });
    expect(l.out.left / 1280).toBeGreaterThan(0.45);
    const d = videoExpandPlan(1280, 720, "pan_down");
    expect(d.out).toMatchObject({ left: 0, top: 0, right: 0, width: 1280 });
    expect(d.out.bottom / 720).toBeGreaterThan(0.45);

    const v = videoExpandPlan(1280, 720, "aspect_9_16");
    expect(v.out.width).toBe(1280);
    expect(v.out.width / v.out.height).toBeCloseTo(9 / 16, 1);
    const wide = videoExpandPlan(720, 1280, "aspect_16_9");
    expect(wide.out.height).toBe(1280);
    expect(wide.out.width / wide.out.height).toBeCloseTo(16 / 9, 1);
  });

  it("refuses an aspect change to the clip's own aspect", () => {
    expect(() => videoExpandPlan(1920, 1080, "aspect_16_9")).toThrow(/aspect/);
    expect(() => videoExpandPlan(1080, 1080, "aspect_1_1")).toThrow(/aspect/);
  });

  it("scales big sources down so the expanded frame stays under the cap", () => {
    const p = videoExpandPlan(1920, 1080, "zoom_2");
    expect(p.downscaled).toBe(true);
    expect(p.srcWidth).toBeLessThan(1920);
    expect(p.out.width).toBeLessThanOrEqual(VIDEO_EXPAND_MAX_EDGE);
    expect(videoExpandPlan(1920, 1080, "zoom_1_25").downscaled).toBe(false);
  });

  it("unknown mode falls back to zoom 1.5x; unknown size to 1280x720", () => {
    expect(videoExpandPlan(1280, 720, "bogus")).toEqual(
      videoExpandPlan(1280, 720, "zoom_1_5"),
    );
    expect(videoExpandPlan(undefined, undefined, "zoom_1_5")).toEqual(
      videoExpandPlan(1280, 720, "zoom_1_5"),
    );
  });

  it("canvas keeps the 832x480 pixel budget at the target aspect", () => {
    expect(videoExpandCanvas(1920, 1080)).toEqual({ width: 848, height: 480 });
    expect(videoExpandCanvas(1080, 1920)).toEqual({ width: 480, height: 848 });
    const pano = videoExpandCanvas(1920, 720);
    expect(Math.max(pano.width, pano.height)).toBeLessThanOrEqual(1280);
  });
});

describe("video_expand graph (wan, experimental)", () => {
  it("pack file has the fixed node classes and is self-consistent", () => {
    const raw = rawPack();
    expect((raw._meta as { title: string }).title).toMatch(/Expand/);
    const wf = graph();
    expectLinked(wf);
    // Fit node already wired (in-graph sizes), same as the builder output.
    expect(inputs(wf, VEX_NODES.cap).width).toEqual(["46", 1]);
    expect(inputs(wf, "53").source).toEqual(["23", 0]);
    // Only core VACE models, no downloads.
    expect(inputs(wf, "1").unet_name).toBe(
      "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors",
    );
    expect(inputs(wf, "2").unet_name).toBe(
      "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors",
    );
  });

  it("builds the outpaint + composite graph for a 16:9 clip", () => {
    const {
      workflow: wf,
      slots,
      seed,
    } = buildWan(graph(), run(), 0, {
      expand: "zoom_1_5",
      seed: 11,
    });
    const p = videoExpandPlan(1280, 720, "zoom_1_5");
    expect(seed).toBe(11);
    expect(slots).toMatchObject({
      ksamplerId: "12",
      posTextId: "9",
      imageInputId: "20",
    });
    expectLinked(wf);
    expect(inputs(wf, "20").file).toBe("cj/clip.mp4 [input]");
    // Native-fps frame window, audio + fps carried to the output.
    expect(inputs(wf, "21")).toMatchObject({
      start_frame: 0,
      length: VIDEO_EXPAND_VACE_MAX_FRAMES,
    });
    expect(inputs(wf, "54")).toMatchObject({
      images: ["53", 0],
      fps: ["22", 2],
      audio: ["22", 1],
    });
    expect(inputs(wf, "55").video).toEqual(["54", 0]);
    // Generation canvas: source scaled into the centre, grey pads, masks.
    expect(inputs(wf, "30")).toMatchObject({
      image: ["23", 0],
      width: p.gen.srcWidth,
      height: p.gen.srcHeight,
      crop: "disabled",
    });
    expect(inputs(wf, "31")).toMatchObject({
      left: p.gen.left,
      top: p.gen.top,
      right: p.gen.right,
      bottom: p.gen.bottom,
      feathering: 0,
    });
    expect(inputs(wf, "11")).toMatchObject({
      width: p.gen.width,
      height: p.gen.height,
      length: ["41", 1],
      control_video: ["31", 0],
      control_masks: ["34", 0],
    });
    expect(inputs(wf, "33").amount).toEqual(["41", 1]);
    expect(inputs(wf, "41").expression).toBe("4 * ((a + 2) // 4) + 1");
    expect(inputs(wf, "16")).toMatchObject({
      image: ["15", 0],
      length: ["24", 2],
    });
    // Fit node (identity here) + composite over the upscaled generation;
    // the in-graph maths reproduces the plan for the nominal size.
    expect(inputs(wf, "23")).toMatchObject({
      image: ["22", 0],
      width: ["46", 1],
      height: ["47", 1],
    });
    expect(inputs(wf, "48").image).toEqual(["23", 0]);
    expect(evalFit(wf, 1280, 720, WAN_FIT)).toEqual({
      width: 1280,
      height: 720,
      outW: p.out.width,
      outH: p.out.height,
      x: p.out.left,
      y: p.out.top,
    });
    expect(inputs(wf, "52")).toMatchObject({
      image: ["16", 0],
      width: ["42", 1],
      height: ["43", 1],
    });
    expect(inputs(wf, "50")).toMatchObject({
      value: 1,
      width: ["48", 0],
      height: ["48", 1],
    });
    expect(inputs(wf, "51")).toMatchObject({ mask: ["50", 0], ...p.feather });
    expect(inputs(wf, "53")).toMatchObject({
      destination: ["52", 0],
      source: ["23", 0],
      x: ["44", 1],
      y: ["45", 1],
      resize_source: false,
      mask: ["51", 0],
    });
    // Source prompt + seamless suffix; balanced speed drops the hi LoRA.
    expect(inputs(wf, "9").text).toMatch(
      /^a fox running through snowy woods\. Seamless/,
    );
    expect(wf["5"]).toBeUndefined();
    expect(inputs(wf, "12")).toMatchObject({
      noise_seed: 11,
      steps: 8,
      cfg: 3.5,
    });
  });

  it("pan: only the padded side is generated and feathered", () => {
    const { workflow: wf } = buildWan(graph(), run(), 0, {
      expand: "pan_right",
      speed: "fast",
    });
    expect(inputs(wf, "31")).toMatchObject({ left: 0, top: 0, bottom: 0 });
    expect(inputs(wf, "31").right).toBeGreaterThan(0);
    expect(inputs(wf, "51")).toMatchObject({ left: 0, top: 0, bottom: 0 });
    expect(inputs(wf, "53")).toMatchObject({ x: 0, y: 0 });
    expect(wf["44"]).toBeUndefined();
    expect(wf["45"]).toBeUndefined();
    // fast: hi LoRA kept and wired.
    expect(wf["5"]).toBeDefined();
    expect(inputs(wf, "7").model).toEqual(["5", 0]);
    expect(inputs(wf, "12")).toMatchObject({ steps: 4, cfg: 1 });
  });

  it("inserts the cap downscale for big sources and feeds it everywhere", () => {
    const { workflow: wf } = buildWan(
      graph(),
      run({ width: 1920, height: 1080 }),
      0,
      { expand: "zoom_2" },
    );
    const p = videoExpandPlan(1920, 1080, "zoom_2");
    expect(p.downscaled).toBe(true);
    expect(wf["23"]?.class_type).toBe("ImageScale");
    expect(inputs(wf, "23").image).toEqual(["22", 0]);
    expect(evalFit(wf, 1920, 1080, WAN_FIT)).toEqual({
      width: p.srcWidth,
      height: p.srcHeight,
      outW: p.out.width,
      outH: p.out.height,
      x: p.out.left,
      y: p.out.top,
    });
    // Raw size (24) stays on the clip (frame count + fit maths).
    expect(inputs(wf, "24").image).toEqual(["22", 0]);
    for (const [id, key] of [
      ["48", "image"],
      ["30", "image"],
      ["53", "source"],
    ] as const) {
      expect(inputs(wf, id)[key], id).toEqual(["23", 0]);
    }
    expectLinked(wf);
  });

  it("prompt: user text, else source prompt, never a seed-upload title", () => {
    const own = buildWan(graph(), run(), 0, {
      prompt: "a beach.",
    });
    expect(inputs(own.workflow, "9").text).toMatch(/^a beach\. Seamless/);
    const seeded = buildWan(
      graph(),
      run({
        prompt: "Expand video",
        parsedPrompt: "Expand video",
        params: { seed_upload: true },
      } as Partial<ImagineRun>),
      0,
      {},
    );
    expect(inputs(seeded.workflow, "9").text).toBe(VIDEO_EXPAND_DEFAULT_PROMPT);
  });

  it("throws without a source video or with a broken pack", () => {
    const noVideo = run();
    noVideo.jobs[0].videos = undefined;
    expect(() => buildWan(graph(), noVideo, 0, {})).toThrow(
      /no video/,
    );
    const broken = graph();
    delete broken["53"];
    expect(() => buildWan(broken, run(), 0, {})).toThrow(/53/);
  });

  it("lints clean against the recorded object_info (pack + every mode)", () => {
    const check = (wf: unknown, label: string) => {
      const errors = lintErrors(lintGraph(wf, OBJECT_INFO));
      expect(errors.map(formatLintIssue), label).toEqual([]);
    };
    check(graph(), "pack");
    for (const [w, h] of [
      [1280, 720],
      [720, 1280],
      [1920, 1080],
    ]) {
      for (const expand of Object.keys(VIDEO_EXPAND_MODES)) {
        let built;
        try {
          built = buildWan(
            graph(),
            run({ width: w, height: h }),
            0,
            {
              expand,
              speed: expand.startsWith("pan") ? "fast" : "balanced",
            },
          );
        } catch {
          continue; // same-aspect refusal
        }
        check(built.workflow, `${w}x${h} ${expand}`);
      }
    }
  });
});

describe("videoExpandLtxPlan geometry (LTX, default engine)", () => {
  const modes = Object.keys(VIDEO_EXPAND_MODES);
  const sizes: [number, number][] = [
    [1280, 720],
    [720, 1280],
    [1920, 1080],
    [640, 480],
    [1080, 1080],
    [853, 480],
  ];

  it.each(sizes)("%ix%i: canvas /32, even source rect, pads line up", (w, h) => {
    for (const edge of [1024, 1280]) {
      for (const m of modes) {
        let p;
        try {
          p = videoExpandLtxPlan(w, h, m, edge);
        } catch (e) {
          expect(m.startsWith("aspect_"), `${m}: ${(e as Error).message}`).toBe(
            true,
          );
          continue;
        }
        const { out, gen, feather } = p;
        const label = `${w}x${h} ${m} @${edge}`;
        expect(gen.width % 32, label).toBe(0);
        expect(gen.height % 32, label).toBe(0);
        expect(Math.max(gen.width, gen.height), label).toBe(edge);
        expect(gen.srcWidth % 2, label).toBe(0);
        expect(gen.srcHeight % 2, label).toBe(0);
        expect(gen.width).toBe(gen.srcWidth + gen.left + gen.right);
        expect(gen.height).toBe(gen.srcHeight + gen.top + gen.bottom);
        // Source aspect kept on the canvas (within rounding).
        expect(
          Math.abs(gen.srcWidth / gen.srcHeight - p.srcWidth / p.srcHeight) /
            (p.srcWidth / p.srcHeight),
          label,
        ).toBeLessThan(0.03);
        expect(out.width).toBe(p.srcWidth + out.left + out.right);
        expect(out.height).toBe(p.srcHeight + out.top + out.bottom);
        expect(out.width % 2).toBe(0);
        expect(out.height % 2).toBe(0);
        expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(
          VIDEO_EXPAND_MAX_EDGE,
        );
        for (const s of ["left", "top", "right", "bottom"] as const) {
          expect(out[s], `${label} ${s}`).toBeGreaterThanOrEqual(0);
          expect(feather[s] > 0, `${label} ${s}`).toBe(gen[s] > 0);
          expect(feather[s]).toBeLessThanOrEqual(48);
        }
        expect(
          Math.abs(out.left / out.width - gen.left / gen.width),
        ).toBeLessThan(0.01);
        expect(
          Math.abs(out.top / out.height - gen.top / gen.height),
        ).toBeLessThan(0.01);
      }
    }
  });

  it("1280x720 zoom 1.5x: 1024x576 canvas, 682x384 inner, pasteback offsets", () => {
    const p = videoExpandLtxPlan(1280, 720, "zoom_1_5");
    expect(p.gen).toEqual({
      width: 1024,
      height: 576,
      srcWidth: 682,
      srcHeight: 384,
      left: 171,
      top: 96,
      right: 171,
      bottom: 96,
    });
    expect(p.out).toEqual({
      width: 1922,
      height: 1080,
      left: 321,
      top: 180,
      right: 321,
      bottom: 180,
    });
    expect(p.feather).toEqual({ left: 48, top: 48, right: 48, bottom: 48 });
    // 1280 / (16/9) = 720 → 736 on the /32 grid.
    expect(videoExpandLtxPlan(1280, 720, "zoom_1_5", 1280).gen).toMatchObject({
      width: 1280,
      height: 736,
    });
    // Unknown edge → 1024.
    expect(videoExpandLtxPlan(1280, 720, "zoom_1_5", 999)).toEqual(p);
  });

  it("pan grows one side only; canvas helper /32", () => {
    const l = videoExpandLtxPlan(1280, 720, "pan_left");
    expect(l.gen).toMatchObject({ top: 0, right: 0, bottom: 0 });
    expect(l.out).toMatchObject({ top: 0, right: 0, bottom: 0, height: 720 });
    expect(l.feather).toMatchObject({ top: 0, right: 0, bottom: 0, left: 48 });
    expect(videoExpandLtxCanvas(1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(videoExpandLtxCanvas(1080, 1920, 1280)).toEqual({
      width: 736,
      height: 1280,
    });
  });

  it("frame count: largest 8n+1 <= min(frames, 121)", () => {
    expect(videoExpandLtxFrames(49)).toBe(49);
    expect(videoExpandLtxFrames(50)).toBe(49);
    expect(videoExpandLtxFrames(56)).toBe(49);
    expect(videoExpandLtxFrames(57)).toBe(57);
    expect(videoExpandLtxFrames(300)).toBe(121);
    expect(videoExpandLtxFrames(1)).toBe(1);
    // The in-graph expression (node 26) computes the same thing.
    const expr = inputs(ltxGraph(), "26").expression as string;
    expect(expr).toBe("8 * ((a - 1) // 8) + 1");
    for (const n of [1, 9, 49, 50, 64, 120, 121]) {
      expect(8 * Math.floor((n - 1) / 8) + 1).toBe(videoExpandLtxFrames(n));
    }
  });
});

describe("video_expand graph (LTX, default engine)", () => {
  it("engine helper: LTX unless explicitly wan", () => {
    expect(videoExpandEngine(undefined)).toBe("ltx");
    expect(videoExpandEngine("")).toBe("ltx");
    expect(videoExpandEngine("vace")).toBe("ltx");
    expect(videoExpandEngine("wan")).toBe("wan");
  });

  it("pack: outpaint IC-LoRA, LTX sampler chain unchanged, core nodes only", () => {
    const raw = rawPack(LTX_PACK);
    expect((raw._meta as { title: string }).title).toMatch(/Expand.*LTX/);
    const wf = ltxGraph();
    expectLinked(wf);
    expect(inputs(wf, VEX_LTX_NODES.cap).width).toEqual(["46", 1]);
    expect(inputs(wf, "53").x).toEqual(["44", 1]);
    expect(inputs(wf, "2")).toMatchObject({
      lora_name: VIDEO_EXPAND_LTX_LORA,
      strength_model: 1,
    });
    expect(inputs(wf, "3").iclora_model).toEqual(["2", 0]);
    expect(inputs(wf, "15").sampler_name).toBe("euler_ancestral");
    expect(wf["16"].class_type).toBe("ManualSigmas");
    expect(inputs(wf, "17")).toMatchObject({ video_cfg: 1, audio_cfg: 1 });
    expect(inputs(wf, "11")).toMatchObject({
      frame_idx: 0,
      strength: 1,
      image: ["32", 0],
      iclora_parameters: ["3", 0],
    });
    // Frame count + fps from the clip.
    expect(inputs(wf, "10").length).toEqual(["26", 1]);
    expect(inputs(wf, "12")).toMatchObject({
      frames_number: ["26", 1],
      frame_rate: ["22", 2],
    });
    expect(inputs(wf, "9").frame_rate).toEqual(["22", 2]);
    expect(inputs(wf, "26")["values.a"]).toEqual(["24", 2]);
    expect(inputs(wf, "27")).toMatchObject({
      image: ["22", 0],
      batch_index: 0,
      length: ["26", 1],
    });
    // Black canvas, one frame per source frame.
    expect(inputs(wf, "31")).toMatchObject({ color: 0, batch_size: ["26", 1] });
    expect(inputs(wf, "32")).toMatchObject({
      destination: ["31", 0],
      source: ["30", 0],
    });
    const banned = /LTXV(Preprocess|Img2Vid|Sampler)|KJ|mtb|Crystools|VideoFrameSample/;
    for (const node of Object.values(wf)) {
      expect(node.class_type).not.toMatch(banned);
    }
    expect(inputs(wf, "8").text).toBe(VIDEO_EXPAND_LTX_NEGATIVE);
  });

  it("builds the guide + pasteback graph (default engine = LTX)", () => {
    const { workflow: wf, slots, seed } = buildVideoExpandWorkflow(
      ltxGraph(),
      run(),
      0,
      { expand: "zoom_1_5", seed: 4242 },
    );
    expect(seed).toBe(4242);
    expect(slots).toMatchObject({
      ksamplerId: "",
      posTextId: "7",
      negTextId: "8",
      latentDimsId: "",
      imageInputId: "20",
    });
    expectLinked(wf);
    expect(inputs(wf, "20").file).toBe("cj/clip.mp4 [input]");
    expect(inputs(wf, "21")).toMatchObject({
      start_frame: 0,
      length: VIDEO_EXPAND_LTX_MAX_FRAMES,
    });
    expect(inputs(wf, "10")).toMatchObject({ width: 1024, height: 576 });
    expect(inputs(wf, "30")).toMatchObject({
      image: ["23", 0],
      width: 682,
      height: 384,
      crop: "disabled",
    });
    expect(inputs(wf, "31")).toMatchObject({ width: 1024, height: 576, color: 0 });
    expect(inputs(wf, "32")).toMatchObject({ x: 171, y: 96, resize_source: false });
    expect(inputs(wf, "23")).toMatchObject({
      image: ["27", 0],
      width: ["46", 1],
      height: ["47", 1],
    });
    expect(inputs(wf, "46")).toMatchObject({
      "values.a": ["24", 0],
      "values.b": ["24", 1],
    });
    expect(inputs(wf, "35").image).toEqual(["23", 0]);
    expect(evalFit(wf, 1280, 720, LTX_FIT)).toEqual({
      width: 1280,
      height: 720,
      outW: 1922,
      outH: 1080,
      x: 321,
      y: 180,
    });
    expect(inputs(wf, "51")).toMatchObject({
      left: 48,
      top: 48,
      right: 48,
      bottom: 48,
    });
    expect(inputs(wf, "52")).toMatchObject({
      image: ["40", 0],
      width: ["42", 1],
      height: ["43", 1],
    });
    expect(inputs(wf, "53")).toMatchObject({
      destination: ["52", 0],
      source: ["23", 0],
      x: ["44", 1],
      y: ["45", 1],
      mask: ["51", 0],
    });
    expect(inputs(wf, "54")).toMatchObject({
      images: ["53", 0],
      fps: ["22", 2],
      audio: ["29", 1],
    });
    expect(inputs(wf, "29").video).toEqual(["28", 0]);
    expect(inputs(wf, "28").length).toEqual(["26", 1]);
    expect(inputs(wf, "14").noise_seed).toBe(4242);
    // No user text: the source run's scene prompt + the wide-shot phrasing.
    expect(inputs(wf, "7").text).toBe(
      `a fox running through snowy woods. ${VIDEO_EXPAND_LTX_WIDE_SUFFIX}`,
    );
    // Explicit "ltx" = same graph.
    expect(
      buildVideoExpandWorkflow(ltxGraph(), run(), 0, {
        expand: "zoom_1_5",
        seed: 4242,
        engine: "ltx",
      }).workflow,
    ).toEqual(wf);
  });

  it("ltxPromptFor: seed-upload title is never the scene; empty falls back", () => {
    const seed = { params: { seed_upload: true }, prompt: "Expand video" } as never;
    expect(ltxPromptFor(seed, {})).toBe(VIDEO_EXPAND_LTX_DEFAULT_PROMPT);
    expect(ltxPromptFor(seed, { prompt: "a fox on a table." })).toBe(
      `a fox on a table. ${VIDEO_EXPAND_LTX_WIDE_SUFFIX}`,
    );
  });

  it("user prompt replaces the default; res 1280 widens the canvas", () => {
    const { workflow: wf } = buildVideoExpandLtxWorkflow(ltxGraph(), run(), 0, {
      prompt: "  a beach   at sunset ",
      res: "1280",
    });
    expect(inputs(wf, "7").text).toBe(`a beach at sunset. ${VIDEO_EXPAND_LTX_WIDE_SUFFIX}`);
    expect(inputs(wf, "10")).toMatchObject({ width: 1280, height: 736 });
    expect(inputs(wf, "31")).toMatchObject({ width: 1280, height: 736 });
  });

  it("pan: only the padded side is black / feathered", () => {
    const { workflow: wf } = buildVideoExpandWorkflow(ltxGraph(), run(), 0, {
      expand: "pan_right",
    });
    expect(inputs(wf, "32")).toMatchObject({ x: 0, y: 0 });
    expect(inputs(wf, "51")).toMatchObject({ left: 0, top: 0, bottom: 0 });
    expect(inputs(wf, "51").right).toBeGreaterThan(0);
    expect(inputs(wf, "53")).toMatchObject({ x: 0, y: 0 });
  });

  it("cap downscale feeds the inner scale, size and pasteback", () => {
    const { workflow: wf } = buildVideoExpandWorkflow(
      ltxGraph(),
      run({ width: 1920, height: 1080 }),
      0,
      { expand: "zoom_2" },
    );
    const p = videoExpandLtxPlan(1920, 1080, "zoom_2");
    expect(p.downscaled).toBe(true);
    expect(inputs(wf, "23").image).toEqual(["27", 0]);
    expect(evalFit(wf, 1920, 1080, LTX_FIT)).toEqual({
      width: p.srcWidth,
      height: p.srcHeight,
      outW: p.out.width,
      outH: p.out.height,
      x: p.out.left,
      y: p.out.top,
    });
    for (const [id, key] of [
      ["30", "image"],
      ["35", "image"],
      ["53", "source"],
    ] as const) {
      expect(inputs(wf, id)[key], id).toEqual(["23", 0]);
    }
    expectLinked(wf);
  });

  it("paste-back follows the real frame size, not the run's recorded size (I3)", () => {
    // The run says 1280x720 (or nothing: 1280x720 fallback); the clip is
    // really something else. Canvas comes from the nominal aspect, but the
    // fit, output size and paste-back offsets come from the decoded frames.
    const cases: Array<[Partial<ImagineRun>, number, number, string]> = [
      [{}, 1920, 1080, "zoom_1_5"],
      [{}, 1278, 718, "zoom_1_5"],
      [{}, 3840, 2160, "zoom_2"],
      [{ width: undefined, height: undefined }, 640, 360, "zoom_1_25"],
      [{}, 1920, 1080, "pan_left"],
      [{}, 1280, 720, "pan_down"],
      [{ width: 1080, height: 1920 }, 720, 1280, "aspect_1_1"],
    ];
    for (const [extra, rw, rh, expand] of cases) {
      const label = `${JSON.stringify(extra)} real ${rw}x${rh} ${expand}`;
      for (const [engine, planFn] of [
        ["ltx", videoExpandLtxPlan],
        ["wan", videoExpandPlan],
      ] as const) {
        const { workflow: wf } = buildVideoExpandWorkflow(
          engine === "ltx" ? ltxGraph() : graph(),
          run(extra),
          0,
          { expand, engine },
        );
        const nominal = planFn(extra.width ?? 1280, extra.height ?? 720, expand);
        // Same canvas as the nominal plan, paste-back as for the real size.
        const real = planFn(rw, rh, expand);
        const fit = evalFit(wf, rw, rh, LTX_FIT);
        const gen = { ...nominal.gen };
        expect(fit.width % 2, label).toBe(0);
        expect(fit.height % 2, label).toBe(0);
        expect(Math.max(fit.outW, fit.outH), label).toBeLessThanOrEqual(
          VIDEO_EXPAND_MAX_EDGE,
        );
        // Source rect scales to where the canvas rect sits.
        expect(fit.x + fit.width, label).toBeLessThanOrEqual(fit.outW);
        expect(fit.y + fit.height, label).toBeLessThanOrEqual(fit.outH);
        const relX = gen.left ? (fit.x + fit.width / 2) / fit.outW : 0;
        const wantX = gen.left ? (gen.left + gen.srcWidth / 2) / gen.width : 0;
        expect(Math.abs(relX - wantX), label).toBeLessThan(0.01);
        const relY = gen.top ? (fit.y + fit.height / 2) / fit.outH : 0;
        const wantY = gen.top ? (gen.top + gen.srcHeight / 2) / gen.height : 0;
        expect(Math.abs(relY - wantY), label).toBeLessThan(0.01);
        if (!gen.left) expect(fit.x, label).toBe(0);
        if (!gen.top) expect(fit.y, label).toBe(0);
        if (!gen.right) expect(fit.x + fit.width, label).toBe(fit.outW);
        if (!gen.bottom) expect(fit.y + fit.height, label).toBe(fit.outH);
        // When the real clip has the nominal aspect, it matches the plan
        // made from the real size exactly.
        if (Math.abs(rw / rh - (extra.width ?? 1280) / (extra.height ?? 720)) < 1e-3) {
          expect(fit, label).toEqual({
            width: real.srcWidth,
            height: real.srcHeight,
            outW: real.out.width,
            outH: real.out.height,
            x: real.out.left,
            y: real.out.top,
          });
        }
      }
    }
  });

  it("start_frame moves the window; audio is trimmed with the frames (I19)", () => {
    const { workflow: wf } = buildVideoExpandWorkflow(ltxGraph(), run(), 0, {
      start_frame: 48,
    });
    expect(inputs(wf, "21")).toMatchObject({ start_frame: 48, length: 121 });
    // Audio comes from a nested crop (relative to the window) with the same
    // 8n+1 length as the frames; VideoTemporalCrop trims audio to the same
    // start/duration as the images.
    expect(inputs(wf, "28")).toMatchObject({
      video: ["21", 0],
      start_frame: 0,
      length: ["26", 1],
    });
    expect(inputs(wf, "27")).toMatchObject({ batch_index: 0, length: ["26", 1] });
    expect(inputs(wf, "54").audio).toEqual(["29", 1]);
    expect(inputs(wf, "12").frames_number).toEqual(["26", 1]);
    // Wan: audio from the same crop as the frames, output = full crop.
    const wan = buildVideoExpandWorkflow(graph(), run(), 0, {
      engine: "wan",
      start_frame: "10",
    }).workflow;
    expect(inputs(wan, "21")).toMatchObject({ start_frame: 10, length: 81 });
    expect(inputs(wan, "54").audio).toEqual(["22", 1]);
    expect(inputs(wan, "16").length).toEqual(["24", 2]);
    for (const bad of [-5, "x", NaN, null]) {
      const w = buildVideoExpandWorkflow(ltxGraph(), run(), 0, { start_frame: bad }).workflow;
      expect(inputs(w, "21").start_frame).toBe(0);
    }
  });

  it("engine mismatch with the graph throws; wan builder rejects the LTX pack", () => {
    expect(() =>
      buildVideoExpandWorkflow(graph(), run(), 0, { engine: "ltx" }),
    ).toThrow(/ltx/);
    expect(() => buildVideoExpandWanWorkflow(ltxGraph(), run(), 0, {})).toThrow(
      /must be/,
    );
    const noVideo = run();
    noVideo.jobs[0].videos = undefined;
    expect(() => buildVideoExpandWorkflow(ltxGraph(), noVideo, 0, {})).toThrow(
      /no video/,
    );
  });

  it("lints clean against the recorded object_info (pack + every mode)", () => {
    const check = (wf: unknown, label: string) => {
      const errors = lintErrors(lintGraph(wf, OBJECT_INFO));
      expect(errors.map(formatLintIssue), label).toEqual([]);
    };
    check(ltxGraph(), "ltx pack");
    for (const [w, h] of [
      [1280, 720],
      [720, 1280],
      [1920, 1080],
    ]) {
      for (const expand of Object.keys(VIDEO_EXPAND_MODES)) {
        for (const res of ["1024", "1280"]) {
          let built;
          try {
            built = buildVideoExpandWorkflow(
              ltxGraph(),
              run({ width: w, height: h }),
              0,
              { expand, res },
            );
          } catch {
            continue; // same-aspect refusal
          }
          check(built.workflow, `${w}x${h} ${expand} ${res}`);
        }
      }
    }
  });
});

describe("video_expand card (critique I16-I18)", () => {
  it("models: LTX graph required, Wan optional, never SDXL via pan_* ids (I16)", async () => {
    // Dynamic: toolsDoc loads editTools, which reads fs (mocked below).
    const { actionsForTool, workflowRelForAction } = await import(
      "@/lib/tools/toolsDoc"
    );
    const spec = getActionTool("video_expand")!;
    const acts = actionsForTool(spec);
    expect(acts).toEqual(["video_expand", "video_expand_wan"]);
    const rels = acts.map(workflowRelForAction);
    expect(rels).toEqual([LTX_PACK, PACK]);
    // pan_left etc. are image actions (SDXL outpaint) - not this card's.
    expect(acts.some((a) => a.startsWith("pan_"))).toBe(false);
    expect(spec.modelCheck).toEqual({ pack: "ltx25", action: "video_expand" });
    const byTool = JSON.parse(
      realFs.readFileSync(
        path.join(process.cwd(), "docs/models-by-tool.json"),
        "utf8",
      ),
    ) as { tools?: unknown[] } | unknown[];
    const rows = (Array.isArray(byTool) ? byTool : (byTool.tools ?? [])) as Array<{
      id: string;
      files: string[];
    }>;
    const row = rows.find((r) => r.id === "video_expand");
    expect(row?.files).toContain(`loras/${VIDEO_EXPAND_LTX_LORA}`);
    expect(row?.files.join(" ")).not.toMatch(/sd_xl|sdxl/i);
    // Same param-only guard on the camera cards (pan_*/zoom ids).
    for (const id of ["camera_move", "wan_camera"] as const) {
      const s2 = getActionTool(id)!;
      for (const a of actionsForTool(s2)) {
        expect(workflowRelForAction(a) ?? "", `${id}:${a}`).not.toMatch(/outpaint/);
      }
    }
  });

  it("Reframe video is retired into Expand video (I17)", () => {
    const old = getActionTool("vace_reframe")!;
    expect(old.hidden).toBe(true);
    expect(resolveCardKey("action:vace_reframe")).toBe("action:video_expand");
    expect(old.category).toBe(getActionTool("video_expand")!.category);
  });

  it("frame window is structured + visible; start frame; aspect issues (I18)", () => {
    const spec = getActionTool("video_expand")!;
    expect(spec.videoWindow).toEqual({ maxFrames: VIDEO_EXPAND_LTX_MAX_FRAMES });
    expect(spec.subtitle).toContain(`${VIDEO_EXPAND_LTX_MAX_FRAMES} frames`);
    expect(spec.subtitle.length).toBeLessThanOrEqual(90);
    expect(spec.text?.hint).toMatch(/MPS/);
    expect(spec.text?.hint).toMatch(/2×.*softer/);
    for (const row of INLINE_TOOLS.filter((t) => t.key.startsWith("inline:v"))) {
      if (!row.key.match(/vzoom|vpan/)) continue;
      expect(row.subtitle).toContain(`${VIDEO_EXPAND_LTX_MAX_FRAMES} frames`);
    }
    // Start frame slider -> params.start_frame.
    const settings = { ...defaultSettings(), text: "a fox" };
    settings.picks.start_frame = "48";
    expect(buildActionRequest(spec, settings, null).params).toMatchObject({
      start_frame: 48,
    });
    expect(
      buildActionRequest(spec, { ...defaultSettings(), text: "a fox" }, null).params.start_frame,
    ).toBeUndefined();
    // The scene description is required (a generic prompt leaves black borders).
    expect(() => buildActionRequest(spec, defaultSettings(), null)).toThrow(/scene description/);
    // The expand picker flags same-aspect modes for the picked clip.
    const picker = spec.pickers!.find((p) => p.key === "expand")!;
    expect(picker.optionIssue?.("aspect_16_9", { width: 1920, height: 1080 })).toMatch(
      /already has this aspect/,
    );
    expect(picker.optionIssue?.("aspect_9_16", { width: 1920, height: 1080 })).toBeNull();
    expect(picker.optionIssue?.("zoom_2", { width: 1920, height: 1080 })).toBeNull();
    expect(videoExpandModeIssue("aspect_1_1", 1000, 1010)).not.toBeNull();
  });
});

describe("video_expand wiring", () => {
  it("registry template + action, builder, video input", () => {
    const reg = registry as unknown as {
      templates: Record<string, { file: string; kind: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    // LTX is the default template; Wan VACE only via engine "wan".
    expect(reg.templates.video_expand.file).toBe(LTX_PACK);
    expect(reg.templates.video_expand_wan.file).toBe(PACK);
    expect(videoExpandTemplate(undefined)).toBe("video_expand");
    expect(videoExpandTemplate("ltx")).toBe("video_expand");
    expect(videoExpandTemplate("bogus")).toBe("video_expand");
    expect(videoExpandTemplate("wan")).toBe("video_expand_wan");
    expect(reg.actions.video_expand).toMatchObject({
      template: "video_expand",
      requiresImage: false,
    });
    expect(actionBuilderFor("video_expand")).toBe(buildVideoExpandWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has("video_expand")).toBe(true);
    expect(resolveWorkflow({ templateOrAction: "video_expand" }).workflowPath).toBe(
      LTX_PACK,
    );
    expect(
      resolveWorkflow({ templateOrAction: "video_expand_wan" }).workflowPath,
    ).toBe(PACK);
  });

  it("tool card states its limits and maps picks to params", () => {
    const spec = getActionTool("video_expand")!;
    expect(spec).toBeDefined();
    expect(spec.category).toBe("Expand");
    expect(spec.videoInput).toBeTruthy();
    expect(spec.modelCheck).toEqual({ pack: "ltx25", action: "video_expand" });
    expect(spec.videoNote).toMatch(/121 frames/);
    expect(spec.videoNote).toMatch(/81 with the experimental Wan/);
    expect(spec.videoNote).toMatch(/audio are kept/);
    expect(spec.text?.hint).toMatch(/2560/);
    expect(spec.text?.hint).toMatch(/unchanged/);
    expect(spec.text?.hint).toMatch(/experimental/);
    const engine = spec.pickers!.find((p) => p.key === "engine")!;
    expect(engine.options[0].id).toBe("ltx");
    expect(engine.options.find((o) => o.id === "wan")!.label).toMatch(
      /experimental/i,
    );
    const s = { ...defaultSettings(), text: "a fox" };
    // Default: LTX at 1024 (no speed knob).
    expect(buildActionRequest(spec, s, null).params).toEqual({
      expand: "zoom_1_5",
      engine: "ltx",
      res: "1024",
      prompt: "a fox",
    });
    expect(
      buildActionRequest(spec, { ...s, picks: { res: "1280" } }, null).params,
    ).toEqual({ expand: "zoom_1_5", engine: "ltx", res: "1280", prompt: "a fox" });
    const picked = {
      ...s,
      text: "neon city street",
      picks: { expand: "aspect_9_16", engine: "wan", speed: "fast" },
    };
    expect(buildActionRequest(spec, picked, null)).toEqual({
      action: "video_expand",
      params: {
        expand: "aspect_9_16",
        engine: "wan",
        speed: "fast",
        prompt: "neon city street",
      },
      overrides: {},
    });
  });

  it("lightbox: zoom + pan rows for videos only", () => {
    const rows = INLINE_TOOLS.filter(
      (t) => t.key === "inline:vzoom" || t.key === "inline:vpan",
    );
    expect(rows).toHaveLength(2);
    for (const t of rows) {
      expect(t.media).toEqual(["video"]);
      expect(t.group).toBe("Reframe");
      if (t.target.kind !== "inline") throw new Error("inline expected");
      for (const v of t.target.variants) {
        expect(v.run).toMatchObject({ kind: "action", action: "video_expand" });
        const params = (v.run as unknown as { params: Record<string, unknown> })
          .params;
        expect(params.engine).toBe("ltx");
        const expand = (v.run as unknown as { params: { expand: string } }).params.expand;
        expect(VIDEO_EXPAND_MODES[expand], expand).toBeDefined();
      }
    }
  });
});

describe("POST /api/jobs/action — video_expand (ComfyUI mocked)", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in this test");
      }),
    );
  });
  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fsAccessSpy.mockResolvedValue(undefined);
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });

  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });

  it("queues the LTX graph by default (engine unspecified)", async () => {
    vi.mocked(getActiveRun).mockReturnValue(run());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(ltxGraph() as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "src-video",
        job_index: 0,
        action: "video_expand",
        params: { expand: "zoom_1_5", seed: 4242 },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/ltx25\/video_expand\.json$/,
    );
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(inputs(queued, "20").file).toBe("cj/clip.mp4 [input]");
    expect(inputs(queued, "31")).toMatchObject({
      width: 1024,
      height: 576,
      color: 0,
    });
    expect(inputs(queued, "32")).toMatchObject({ x: 171, y: 96 });
    expect(evalFit(queued, 1280, 720, LTX_FIT)).toMatchObject({ x: 321, y: 180 });
    expect(inputs(queued, "54").audio).toEqual(["29", 1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("engine wan queues the experimental VACE graph", async () => {
    vi.mocked(getActiveRun).mockReturnValue(run());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(graph() as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "src-video",
        job_index: 0,
        action: "video_expand",
        params: { expand: "pan_up", engine: "wan", speed: "balanced" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/wan22\/video_expand\.json$/,
    );
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(inputs(queued, "20").file).toBe("cj/clip.mp4 [input]");
    expect(inputs(queued, "31")).toMatchObject({
      left: 0,
      right: 0,
      bottom: 0,
    });
    expect(inputs(queued, "31").top).toBeGreaterThan(0);
    expect(inputs(queued, "54").audio).toEqual(["22", 1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("409s on an image-only run", async () => {
    const r = run();
    r.jobs[0].videos = undefined;
    r.jobs[0].images = ["/api/comfy/view?filename=x.png&type=output"];
    vi.mocked(getActiveRun).mockReturnValue(r);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "src-video",
        job_index: 0,
        action: "video_expand",
        params: {},
      }),
    );
    expect(res.status).toBe(409);
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
