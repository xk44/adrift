/**
 * H3 Long clip + Fix faces: segment planner math (mirrors core
 * create_windows_static_standard and MiniMaxH3TemporalWindow plan_windows),
 * graph builder output linted against the recorded object_info slice, and
 * the Reference to Video UI wiring.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  H3_CONTEXT_WINDOWS_NODE,
  H3_LONG_METHOD_TRADEOFF,
  H3_TEMPORAL_WINDOW_NODE,
  applyH3FixFaces,
  applyH3LongClip,
  h3ContextWindows,
  h3FramesForSeconds,
  h3LatentToFrame,
  h3LongDecodedGb,
  h3LongOverlapFrames,
  h3LongPlanHint,
  h3LongWindowFrames,
  h3LongWindowHint,
  h3SequentialWindows,
  h3SnapFrames,
  h3VideoLatentT,
  planH3LongClip,
} from "@/lib/oj/h3LongClip";
import { buildRefVideoWorkflow } from "@/lib/oj/h3RefVideo";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  pickerVisible,
  sliderVisible,
  type ActionToolSpec,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { formatLintIssue, lintErrors, lintGraph } from "@/lib/tools/graphLint";
import { validatePrompt } from "@/lib/comfy/validatePrompt";

const R2V: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/minimax/r2v.json"),
    "utf-8",
  ),
);
const { _meta: _m, ...OBJECT_INFO } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/h3LongClipNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const run = {
  run_id: "seed-img",
  prompt: "",
  parsedPrompt: "",
  width: 1024,
  height: 1024,
  createdAt: new Date().toISOString(),
  status: "done",
  jobs: [
    {
      seed: 0,
      index: 0,
      status: "done",
      progress: 100,
      images: [
        "http://127.0.0.1:8188/view?filename=a.png&subfolder=qa&type=input",
      ],
    },
  ],
  params: { seed_upload: true },
} as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const lint = (wf: Workflow) =>
  lintErrors(lintGraph(wf, OBJECT_INFO)).map(formatLintIssue);
const build = (params: Record<string, unknown>) =>
  buildRefVideoWorkflow(R2V, run, 0, {
    h3Speed: "turbo8",
    seed: 7,
    secondRefImage: "b.png [input]",
    ...params,
  }).workflow;

/** Python reference: core create_windows_static_standard (latent indices). */
function coreStatic(T: number, L: number, O: number): Array<[number, number]> {
  if (T <= L) return [[0, T]];
  const out: Array<[number, number]> = [];
  const delta = L - O;
  for (let s = 0; s < T; s += delta) {
    if (s + L >= T) {
      out.push([s - (s + L - T), s - (s + L - T) + L]);
      break;
    }
    out.push([s, s + L]);
  }
  return out;
}

describe("H3 latent grid", () => {
  it("maps 17k+5 frames to 5k+2 latents", () => {
    expect(h3VideoLatentT(5)).toBe(2);
    expect(h3VideoLatentT(124)).toBe(37);
    expect(h3VideoLatentT(39)).toBe(12);
    expect(h3VideoLatentT(22)).toBe(7);
    expect(h3VideoLatentT(243)).toBe(72);
  });

  it("snaps frames up to the grid", () => {
    expect(h3SnapFrames(124)).toBe(124);
    expect(h3SnapFrames(125)).toBe(141);
    expect(h3FramesForSeconds(10)).toBe(243);
    expect(h3FramesForSeconds(30)).toBe(736);
    for (let s = 6; s <= 30; s++) {
      const f = h3FramesForSeconds(s);
      expect((f - 5) % 17).toBe(0);
      expect(f).toBeGreaterThanOrEqual(s * 24);
      expect(f - 17).toBeLessThan(s * 24);
    }
  });

  it("latent token -> first frame: chunks of 1,4,4,4,4 from token 0", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(h3LatentToFrame)).toEqual([
      0, 1, 5, 9, 13, 17, 18, 22,
    ]);
    // Every whole-clip latent count lands on the frame count.
    for (let k = 0; k < 40; k++)
      expect(h3LatentToFrame(h3VideoLatentT(5 + 17 * k))).toBe(5 + 17 * k);
  });
});

describe("window planners", () => {
  it("context windows match the core static schedule and cover the clip", () => {
    for (let k = 0; k < 60; k++) {
      const T = 2 + 5 * k;
      const w = h3ContextWindows(T, 37, 12);
      expect(w).toEqual(coreStatic(T, 37, 12));
      expect(w[0][0]).toBe(0);
      expect(w[w.length - 1][1]).toBe(T);
      for (let i = 1; i < w.length; i++)
        expect(w[i][0]).toBeLessThan(w[i - 1][1]);
    }
  });

  it("sequential windows match plan_windows (chunk-aligned, last pulled back)", () => {
    expect(h3SequentialWindows(37, 124, 22)).toEqual([[0, 37]]);
    // 243 frames = 72 latents; win 37, ov 7 -> starts 0, 30, then clamp 35.
    expect(h3SequentialWindows(72, 124, 22)).toEqual([
      [0, 37],
      [30, 67],
      [35, 72],
    ]);
    for (let k = 8; k < 60; k++) {
      const T = 2 + 5 * k;
      const w = h3SequentialWindows(T, 124, 22);
      expect(w[w.length - 1][1]).toBe(T);
      for (const [s] of w) expect(s % 5).toBe(0);
    }
  });

  it("plans a 10 s context clip: 3 windows of 124 frames, ends on the last frame", () => {
    const p = planH3LongClip({ seconds: 10 });
    expect(p.frames).toBe(243);
    expect(p.latentT).toBe(72);
    expect(p.segments).toBe(3);
    expect(p.windows.map((w) => [w.startFrame, w.endFrame])).toEqual([
      [0, 124],
      [85, 209],
      [119, 243],
    ]);
    expect(p.windows[0].endSec).toBeCloseTo(124 / 24);
  });

  it("clamps duration and scales the ETA with segments, quality and faces", () => {
    expect(planH3LongClip({ seconds: 2 }).frames).toBe(h3FramesForSeconds(6));
    expect(planH3LongClip({ seconds: 999 }).frames).toBe(736);
    const base = planH3LongClip({ seconds: 20 });
    expect(planH3LongClip({ seconds: 30 }).etaSeconds).toBeGreaterThan(
      base.etaSeconds,
    );
    expect(
      planH3LongClip({ seconds: 20, resolution: "768" }).etaSeconds,
    ).toBeGreaterThan(base.etaSeconds);
    expect(
      planH3LongClip({ seconds: 20, fixFaces: 2 }).etaSeconds,
    ).toBeGreaterThan(planH3LongClip({ seconds: 20, fixFaces: 1 }).etaSeconds);
  });
});

describe("long clip graph", () => {
  it("is a no-op without longClip", () => {
    const wf = build({});
    expect(byClass(wf, H3_CONTEXT_WINDOWS_NODE)).toHaveLength(0);
    expect(applyH3LongClip(wf, {})).toEqual([]);
    expect(applyH3FixFaces(wf, {})).toEqual([]);
  });

  it("context: sets the snapped length and wraps only the guider's model", () => {
    const wf = build({ longClip: true, longSeconds: 20 });
    expect(lint(wf)).toEqual([]);
    const [[cwId, cw]] = byClass(wf, H3_CONTEXT_WINDOWS_NODE);
    const [[, r2v]] = byClass(wf, "MiniMaxH3ReferenceToVideo");
    expect(r2v.inputs.length).toBe(h3FramesForSeconds(20));
    expect(String(r2v.inputs.prompt)).toContain("20.");
    const [[, guider]] = byClass(wf, "BasicGuider");
    expect(guider.inputs.model).toEqual([cwId, 0]);
    // Window node sits on the SigmaShift tail added by Turbo.
    const src = (cw.inputs.model as [string, number])[0];
    expect(wf[src].class_type).toBe("MiniMaxH3SigmaShift");
    const [[, sched]] = byClass(wf, "BasicScheduler");
    expect(sched.inputs.model).toEqual([src, 0]);
    // Audio: still one VAEDecodeAudio feeding CreateVideo, no re-encode.
    expect(byClass(wf, "VAEDecode")).toHaveLength(1);
    expect(byClass(wf, "VAEDecodeAudio")).toHaveLength(1);
    expect(byClass(wf, "VAEEncode")).toHaveLength(0);
  });

  it("sequential: routes CLIP through the temporal window node", () => {
    const wf = build({
      longClip: true,
      longSeconds: 15,
      longMethod: "sequential",
    });
    expect(lint(wf)).toEqual([]);
    const [[twId]] = byClass(wf, H3_TEMPORAL_WINDOW_NODE);
    const [[, r2v]] = byClass(wf, "MiniMaxH3ReferenceToVideo");
    expect(r2v.inputs.clip).toEqual([twId, 1]);
    expect(wf[twId].inputs.clip).toEqual(["2", 0]);
  });

  it("is idempotent", () => {
    const wf = build({ longClip: true, longSeconds: 12 });
    expect(applyH3LongClip(wf, { longClip: true })).toEqual([]);
  });
});

describe("fix faces graph", () => {
  it("adds one separate, mask-clamped pass per subject, chained in order", () => {
    const wf = build({ longClip: true, longSeconds: 12, fixFaces: 2 });
    expect(lint(wf)).toEqual([]);
    expect(byClass(wf, "SAM3_VideoTrack")).toHaveLength(1);
    const masks = byClass(wf, "SAM3_TrackToMask").map(
      ([, n]) => n.inputs.object_indices,
    );
    expect(masks).toEqual(["0", "1"]);
    const clamps = byClass(wf, "CJMaskedFaceClamp");
    const crops = byClass(wf, "H3FaceTrackCrop");
    expect(clamps).toHaveLength(2);
    expect(crops).toHaveLength(2);
    // Pass 2 starts from pass 1's clamped frames; CreateVideo gets pass 2.
    expect(crops[1][1].inputs.images).toEqual([clamps[0][0], 0]);
    expect(clamps[1][1].inputs.base_images).toEqual([clamps[0][0], 0]);
    const [[, create]] = byClass(wf, "CreateVideo");
    expect(create.inputs.images).toEqual([clamps[1][0], 0]);
    // Each clamp uses its own subject's mask.
    const maskOf = (i: number) =>
      wf[String((clamps[i][1].inputs.mask as [string, number])[0])].inputs
        .mask as [string, number];
    expect(wf[maskOf(0)[0]].inputs.object_indices).toBe("0");
    expect(wf[maskOf(1)[0]].inputs.object_indices).toBe("1");
    // Refine runs on the windowed model, low denoise, soundtrack as ref audio.
    const [[cwId]] = byClass(wf, H3_CONTEXT_WINDOWS_NODE);
    for (const [, n] of byClass(wf, "H3PerFrameDenoise"))
      expect(n.inputs.model).toEqual([cwId, 0]);
    const scheds = byClass(wf, "BasicScheduler");
    expect(scheds.filter(([, n]) => n.inputs.denoise === 0.4)).toHaveLength(2);
    const audio = create.inputs.audio;
    const refineConds = byClass(wf, "MiniMaxH3ReferenceToVideo").slice(1);
    expect(refineConds).toHaveLength(2);
    for (const [, n] of refineConds) {
      expect(n.inputs["ref_audios.ref_audio_0"]).toEqual(audio);
      expect(n.inputs["ref_images.ref_image_1"]).toBeDefined();
    }
  });

  it("works on a single-clip render too", () => {
    const wf = build({ duration: "3", fixFaces: 1 });
    expect(lint(wf)).toEqual([]);
    expect(byClass(wf, "CJMaskedFaceClamp")).toHaveLength(1);
    expect(byClass(wf, H3_CONTEXT_WINDOWS_NODE)).toHaveLength(0);
  });
});

describe("Reference to Video UI", () => {
  const spec = getActionTool("ref_video") as ActionToolSpec;
  const settingsWith = (picks: Record<string, string>): ToolSettings => {
    const s = defaultSettings(spec);
    return { ...s, picks: { ...s.picks, ...picks } };
  };
  const req = (picks: Record<string, string>) =>
    buildActionRequest(spec, settingsWith(picks), null);

  it("defaults send no long-clip or fix-faces params", () => {
    const r = req({});
    expect(r.params.longClip).toBeUndefined();
    expect(r.params.fixFaces).toBeUndefined();
  });

  it("Long clip shows the length slider with segments + ETA and sends the plan params", () => {
    const sl = spec.sliders!.find((x) => x.key === "longSeconds")!;
    expect(sliderVisible(sl, spec, settingsWith({}))).toBe(false);
    const s = settingsWith({
      duration: "long",
      longSeconds: "20",
      fixFaces: "2",
    });
    expect(sliderVisible(sl, spec, s)).toBe(true);
    const hint = sl.hintFor!(20, s);
    expect(hint).toMatch(/\d+ segments/);
    expect(hint).toMatch(/about \d+ (s|min)/);
    const r = req({ duration: "long", longSeconds: "20", fixFaces: "2" });
    expect(r.params).toMatchObject({
      longClip: true,
      longSeconds: 20,
      longMethod: "context",
      fixFaces: 2,
    });
  });
});

describe("window length + overlap", () => {
  it("snaps the window to 17k+5 inside 73..192 (default 124)", () => {
    expect(h3LongWindowFrames(undefined)).toBe(124);
    expect(h3LongWindowFrames("")).toBe(124);
    expect(h3LongWindowFrames(160)).toBe(158);
    expect(h3LongWindowFrames(10)).toBe(73);
    expect(h3LongWindowFrames(999)).toBe(192);
    for (let f = 0; f < 300; f += 7)
      expect((h3LongWindowFrames(f) - 5) % 17).toBe(0);
  });

  it("overlap defaults per method and stays a chunk shorter than the window", () => {
    expect(h3LongOverlapFrames(undefined, "context", 124)).toBe(39);
    expect(h3LongOverlapFrames("auto", "sequential", 124)).toBe(22);
    expect(h3LongOverlapFrames(56, "context", 124)).toBe(56);
    expect(h3LongOverlapFrames(999, "context", 73)).toBe(56);
    expect(h3LongOverlapFrames(0, "context", 124)).toBe(5);
  });

  it("a longer window means fewer segments; more overlap means more", () => {
    const base = planH3LongClip({ seconds: 20 });
    const wide = planH3LongClip({ seconds: 20, windowFrames: 192 });
    const dense = planH3LongClip({ seconds: 20, overlapFrames: 56 });
    expect(wide.windowFrames).toBe(192);
    expect(wide.segments).toBeLessThan(base.segments);
    expect(dense.segments).toBeGreaterThan(base.segments);
    for (const p of [base, wide, dense]) {
      expect(p.windows[0].startFrame).toBe(0);
      expect(p.windows[p.windows.length - 1].endFrame).toBe(p.frames);
    }
  });

  it("hints: VRAM per window, RAM for decoded frames, method tail", () => {
    expect(h3LongWindowHint(124, "768")).toMatch(/fits 24 GB/);
    expect(h3LongWindowHint(192, "768")).toMatch(/more than 24 GB/);
    expect(h3LongWindowHint(192, "480")).toMatch(/480p is safest/);
    // 243 frames at 864x480 float32 RGB = 1.21 GB; Fix faces x2 adds 4 copies.
    expect(h3LongDecodedGb(243, { width: 864, height: 480 })).toBeCloseTo(
      1.209,
      2,
    );
    expect(
      h3LongDecodedGb(243, { width: 864, height: 480 }, 2),
    ).toBeCloseTo(1.209 * 5, 2);
    const size = { width: 864, height: 480 };
    expect(h3LongPlanHint(planH3LongClip({ seconds: 10 }), size)).toMatch(
      /~1\.2 GB RAM.*Single pass/,
    );
    expect(
      h3LongPlanHint(
        planH3LongClip({ seconds: 10, method: "sequential" }),
        size,
      ),
    ).toMatch(/chained in order/);
  });
});

describe("long clip graph: both modes with custom windows", () => {
  it("context windows (single pass): one window node, window/overlap applied, faces keep the windowed model", () => {
    const wf = build({
      longClip: true,
      longSeconds: 24,
      longMethod: "context",
      longWindow: 158,
      longOverlap: 56,
      fixFaces: 1,
    });
    expect(lint(wf)).toEqual([]);
    const cws = byClass(wf, H3_CONTEXT_WINDOWS_NODE);
    expect(cws).toHaveLength(1);
    expect(byClass(wf, H3_TEMPORAL_WINDOW_NODE)).toHaveLength(0);
    const [[cwId, cw]] = cws;
    expect(cw.inputs).toMatchObject({
      context_length: 158,
      context_overlap: 56,
      fuse_method: "pyramid",
      freenoise: true,
    });
    // One sampling pass over the whole clip.
    expect(byClass(wf, "SamplerCustomAdvanced")).toHaveLength(2); // main + 1 face
    const [[, r2v]] = byClass(wf, "MiniMaxH3ReferenceToVideo");
    expect(r2v.inputs.length).toBe(h3FramesForSeconds(24));
    for (const [, n] of byClass(wf, "H3PerFrameDenoise"))
      expect(n.inputs.model).toEqual([cwId, 0]);
  });

  it("chained: temporal window node gets the same window/overlap", () => {
    const wf = build({
      longClip: true,
      longSeconds: 18,
      longMethod: "sequential",
      longWindow: 107,
    });
    expect(lint(wf)).toEqual([]);
    const [[, tw]] = byClass(wf, H3_TEMPORAL_WINDOW_NODE);
    expect(tw.inputs).toMatchObject({
      window_frames: 107,
      overlap_frames: 22,
      carry_overlap: true,
      temporal_windows: true,
    });
    expect(byClass(wf, H3_CONTEXT_WINDOWS_NODE)).toHaveLength(0);
  });

  it("node values land on the node's 17k+5 grid and inside its ranges", () => {
    for (const longMethod of ["context", "sequential"])
      for (const longWindow of [73, 124, 192])
        for (const longOverlap of [5, 22, 39, 56, 300]) {
          const wf = build({
            longClip: true,
            longSeconds: 30,
            longMethod,
            longWindow,
            longOverlap,
          });
          expect(lint(wf)).toEqual([]);
          const [[, n]] = [
            ...byClass(wf, H3_CONTEXT_WINDOWS_NODE),
            ...byClass(wf, H3_TEMPORAL_WINDOW_NODE),
          ];
          const win = Number(n.inputs.context_length ?? n.inputs.window_frames);
          const ov = Number(n.inputs.context_overlap ?? n.inputs.overlap_frames);
          expect((win - 5) % 17).toBe(0);
          expect((ov - 5) % 17).toBe(0);
          expect(ov).toBeLessThan(win);
        }
  });
});

const LIVE_FILE = process.env.LIVE_OBJECT_INFO;
const LIVE: Record<string, unknown> | null =
  LIVE_FILE && fs.existsSync(LIVE_FILE)
    ? JSON.parse(fs.readFileSync(LIVE_FILE, "utf-8"))
    : null;

describe.skipIf(!LIVE)("long clip graphs vs live object_info", () => {
  const graphs: Array<[string, Record<string, unknown>]> = [
    ["context", { longClip: true, longSeconds: 20, longWindow: 158, longOverlap: 56 }],
    ["chained", { longClip: true, longSeconds: 20, longMethod: "sequential" }],
    [
      "context + fix faces",
      { longClip: true, longSeconds: 12, fixFaces: 3 },
    ],
  ];
  it.each(graphs)("%s: every node class installed, inputs valid", (_n, p) => {
    const wf = build(p);
    const missing = [
      ...new Set(Object.values(wf).map((n) => n.class_type)),
    ].filter((c) => !(c in LIVE!));
    expect(missing).toEqual([]);
    // Model files differ per machine; installs are checked by model-status.
    const problems = validatePrompt(wf, LIVE as Record<string, any>)
      .filter(
        (p) =>
          !(
            p.kind === "invalid_combo_value" &&
            /(_name|ckpt|model|lora|vae|clip|unet|detector)/i.test(p.input ?? "")
          ),
      )
      .map((p) => `${p.nodeId} ${p.classType}.${p.input}: ${p.message}`);
    expect(problems).toEqual([]);
  });
});

describe("Reference to Video long clip controls", () => {
  const spec = getActionTool("ref_video") as ActionToolSpec;
  const settingsWith = (picks: Record<string, string>): ToolSettings => {
    const s = defaultSettings(spec);
    return { ...s, picks: { ...s.picks, ...picks } };
  };

  it("method switch: context windows (single pass) by default, chained alt, trade-off line", () => {
    const m = spec.pickers!.find((p) => p.key === "longMethod")!;
    expect(m.options.map((o) => o.id)).toEqual(["context", "sequential"]);
    expect(m.options[0].label).toBe("Context windows (single pass)");
    expect(m.hint).toBe(H3_LONG_METHOD_TRADEOFF);
    expect(m.hint).toMatch(/RAM\/VRAM/);
    expect(m.hint).toMatch(/drift/);
  });

  it("window + overlap controls only show for Long clip", () => {
    const win = spec.sliders!.find((x) => x.key === "longWindow")!;
    const ov = spec.pickers!.find((p) => p.key === "longOverlap")!;
    expect(win.advanced).toBe(true);
    expect(sliderVisible(win, spec, settingsWith({}))).toBe(false);
    expect(pickerVisible(ov, spec, settingsWith({}))).toBe(false);
    const s = settingsWith({ duration: "long" });
    expect(sliderVisible(win, spec, s)).toBe(true);
    expect(pickerVisible(ov, spec, s)).toBe(true);
    expect(win.hintFor!(124, s)).toMatch(/VRAM/);
  });

  it("sends window/overlap; Default overlap is left to the method", () => {
    const r = buildActionRequest(
      spec,
      settingsWith({ duration: "long", longWindow: "160", longOverlap: "56" }),
      null,
    );
    expect(r.params).toMatchObject({ longWindow: 158, longOverlap: 56 });
    const d = buildActionRequest(
      spec,
      settingsWith({ duration: "long", longMethod: "sequential" }),
      null,
    );
    expect(d.params).toMatchObject({ longMethod: "sequential", longWindow: 124 });
    expect(d.params.longOverlap).toBeUndefined();
    const off = buildActionRequest(spec, settingsWith({ longWindow: "192" }), null);
    expect(off.params.longWindow).toBeUndefined();
  });
});
