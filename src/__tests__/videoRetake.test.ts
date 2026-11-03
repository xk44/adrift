/**
 * Video Retake (packs/ltx25/video_retake.json, src/lib/oj/videoRetake.ts,
 * src/lib/videoEdit/retake.ts): range -> frame / latent math (8n+1, 8x
 * temporal compression), latent mask + pixel alpha ramps, editor cut
 * window, builder wiring for each audio mode linted against the recorded
 * object_info fixture, and the card request.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  VIDEO_RETAKE_ACTION,
  VIDEO_RETAKE_MAX_FRAMES,
  VIDEO_RETAKE_MAX_LATENTS,
  VIDEO_RETAKE_NEGATIVE,
  VRT_NODES,
  buildVideoRetakeWorkflow,
  maskLevel,
  maskRuns,
  videoRetakeCut,
  videoRetakeFrames,
  videoRetakeGenSize,
  videoRetakeLatentCount,
  videoRetakeLatentMask,
  videoRetakeLatentOf,
  videoRetakePixelAlpha,
  videoRetakePixelsOf,
  videoRetakeRange,
} from "@/lib/oj/videoRetake";
import {
  RETAKE_TOOL_KEY,
  retakePlan,
  retakePrefillPicks,
} from "@/lib/videoEdit/retake";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { formatLintIssue, lintErrors, lintGraph } from "@/lib/tools/graphLint";

const PACK = "packs/ltx25/video_retake.json";
const graph = (): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows", PACK),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as Workflow;
};
const OBJECT_INFO = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/graphLint.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const VIDEO_URL =
  "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=cj&type=input";

function run(): ImagineRun {
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
  } as unknown as ImagineRun;
}

const build = (params: Record<string, unknown> = {}) =>
  buildVideoRetakeWorkflow(graph(), run(), 0, {
    retake_start: 2,
    retake_end: 3,
    sourceFps: 24,
    seed: 7,
    ...params,
  });

/** Expands a 1x1 EmptyImage / ImageBatch chain back to its 0..1 values. */
function chainValues(wf: Workflow, link: unknown): number[] {
  const [id] = link as [string, number];
  const node = wf[id];
  if (node.class_type === "EmptyImage") {
    const level = ((node.inputs.color as number) >> 16) & 255;
    return new Array(node.inputs.batch_size as number).fill(level / 255);
  }
  expect(node.class_type).toBe("ImageBatch");
  return [
    ...chainValues(wf, node.inputs.image1),
    ...chainValues(wf, node.inputs.image2),
  ];
}

describe("frame / latent index math", () => {
  it("frame counts snap up to 8n+1 and cap at the window", () => {
    expect(videoRetakeFrames(1)).toBe(1);
    expect(videoRetakeFrames(2)).toBe(9);
    expect(videoRetakeFrames(9)).toBe(9);
    expect(videoRetakeFrames(10)).toBe(17);
    expect(videoRetakeFrames(120)).toBe(121);
    expect(videoRetakeFrames(500)).toBe(121);
    for (let n = 1; n <= 200; n++)
      expect((videoRetakeFrames(n) - 1) % 8).toBe(0);
    expect(videoRetakeLatentCount(121)).toBe(16);
    expect(VIDEO_RETAKE_MAX_LATENTS).toBe(16);
    expect(videoRetakeLatentCount(49)).toBe(7);
  });

  it("pixel <-> latent: frame 0 alone, then 8 frames per latent", () => {
    expect(videoRetakeLatentOf(0)).toBe(0);
    expect(videoRetakeLatentOf(1)).toBe(1);
    expect(videoRetakeLatentOf(8)).toBe(1);
    expect(videoRetakeLatentOf(9)).toBe(2);
    expect(videoRetakeLatentOf(120)).toBe(15);
    expect(videoRetakePixelsOf(0)).toEqual([0, 0]);
    expect(videoRetakePixelsOf(1)).toEqual([1, 8]);
    expect(videoRetakePixelsOf(15)).toEqual([113, 120]);
    for (let k = 0; k < 16; k++) {
      const [a, b] = videoRetakePixelsOf(k);
      expect(videoRetakeLatentOf(a)).toBe(k);
      expect(videoRetakeLatentOf(b)).toBe(k);
    }
  });

  it("seconds -> frame range; open edges; empty range throws", () => {
    expect(videoRetakeRange(2, 3, 24)).toEqual({
      start: 48,
      end: 72,
      openStart: false,
      openEnd: false,
    });
    expect(videoRetakeRange(0, 1, 30)).toMatchObject({
      start: 0,
      end: 30,
      openStart: true,
    });
    expect(videoRetakeRange(1, 4.5, 30)).toMatchObject({
      end: 121,
      openEnd: true,
    });
    expect(videoRetakeRange(1, 2, 24, true)).toMatchObject({
      end: 121,
      openEnd: true,
    });
    expect(videoRetakeRange(1, undefined, 24)).toMatchObject({ openEnd: true });
    expect(videoRetakeRange("1.5", "2", 24)).toMatchObject({
      start: 36,
      end: 48,
    });
    expect(() => videoRetakeRange(3, 2, 24)).toThrow(/empty/);
    expect(() => videoRetakeRange(6, 7, 24)).toThrow(/empty/);
  });
});

describe("mask ramps", () => {
  it("latent mask: strength on the range latents, one ramp latent each side", () => {
    const m = videoRetakeLatentMask({ start: 48, end: 72 }, 1);
    expect(m).toHaveLength(16);
    // frames 48..71 -> latents 6..9
    expect(m.slice(6, 10)).toEqual([1, 1, 1, 1]);
    expect(m[5]).toBeCloseTo(0.5);
    expect(m[10]).toBeCloseTo(0.5);
    expect(m.slice(0, 5).every((v) => v === 0)).toBe(true);
    expect(m.slice(11).every((v) => v === 0)).toBe(true);
    const weak = videoRetakeLatentMask({ start: 48, end: 72 }, 0.6);
    expect(weak[7]).toBeCloseTo(0.6);
    expect(weak[5]).toBeCloseTo(0.3);
    const edge = videoRetakeLatentMask({ start: 0, end: 121 }, 1);
    expect(edge.every((v) => v === 1)).toBe(true);
  });

  it("pixel alpha: 0 outside the range, ramps inside closed edges only", () => {
    const r = videoRetakeRange(2, 3, 24);
    const a = videoRetakePixelAlpha(r, 4);
    expect(a).toHaveLength(VIDEO_RETAKE_MAX_FRAMES);
    expect(a.slice(0, 48).every((v) => v === 0)).toBe(true);
    expect(a.slice(72).every((v) => v === 0)).toBe(true);
    expect(a.slice(48, 53)).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect(a.slice(67, 72).map((v) => Math.round(v * 10) / 10)).toEqual([
      1, 0.8, 0.6, 0.4, 0.2,
    ]);
    const open = videoRetakePixelAlpha(videoRetakeRange(0, 4.9, 24, true), 4);
    expect(open.every((v) => v === 1)).toBe(true);
  });

  it("8-bit levels and run-length encoding", () => {
    expect(maskLevel(-1)).toBe(0);
    expect(maskLevel(0.5)).toBe(128);
    expect(maskLevel(2)).toBe(255);
    expect(maskRuns([0, 0, 0.5, 1, 1, 1, 0])).toEqual([
      { level: 0, count: 2 },
      { level: 128, count: 1 },
      { level: 255, count: 3 },
      { level: 0, count: 1 },
    ]);
  });

  it("gen size is /32, keeps aspect and never upscales past the source", () => {
    expect(videoRetakeGenSize(1280, 720)).toEqual({ width: 1024, height: 576 });
    expect(videoRetakeGenSize(1280, 720, 768)).toEqual({
      width: 768,
      height: 448,
    });
    expect(videoRetakeGenSize(720, 1280)).toEqual({ width: 576, height: 1024 });
    expect(videoRetakeGenSize(640, 360)).toEqual({ width: 640, height: 352 });
  });
});

describe("editor cut window", () => {
  it("adds context each side within the window", () => {
    const c = videoRetakeCut(5, 6, 20, 24)!;
    expect(c).toEqual({
      cutStart: 4,
      cutEnd: 7,
      retakeStart: 1,
      retakeEnd: 2,
      toEnd: false,
    });
  });

  it("clamps to the clip; marks a range that reaches the end", () => {
    expect(videoRetakeCut(0.5, 2, 10, 24)).toMatchObject({
      cutStart: 0,
      retakeStart: 0.5,
    });
    expect(videoRetakeCut(8, 10, 10, 24)).toMatchObject({
      cutEnd: 10,
      toEnd: true,
    });
  });

  it("whole cut fits 121 frames and stays under the End slider max", () => {
    for (const fps of [12, 24, 30, 60]) {
      const c = videoRetakeCut(10, 11, 100, fps)!;
      const span = c.cutEnd - c.cutStart;
      expect(Math.round(span * fps)).toBeLessThanOrEqual(
        VIDEO_RETAKE_MAX_FRAMES - 1,
      );
      expect(c.retakeEnd).toBeLessThan(5);
    }
    expect(videoRetakeCut(0, 6, 100, 24)).toBeNull();
    expect(videoRetakeCut(2, 2, 100, 24)).toBeNull();
  });

  it("editor plan + card prefill (0.1 s steps cover the range)", () => {
    expect(retakePlan({ start: 0, end: 10, source: "all" }, 10, 24).ok).toBe(
      false,
    );
    const p = retakePlan({ start: 5.03, end: 6.07, source: "marks" }, 20, 24);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const picks = retakePrefillPicks(p.cut);
    expect(Number(picks.retake_start)).toBeLessThanOrEqual(p.cut.retakeStart);
    expect(Number(picks.retake_end)).toBeGreaterThanOrEqual(p.cut.retakeEnd);
    expect(picks.retake_to_end).toBe("");
    expect(RETAKE_TOOL_KEY).toBe("action:video_retake");
  });
});

describe("builder wiring", () => {
  it("registered as a video-input action with a builder and template", () => {
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_RETAKE_ACTION)).toBe(true);
    expect(actionBuilderFor(VIDEO_RETAKE_ACTION)).toBe(
      buildVideoRetakeWorkflow,
    );
    const reg = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string }>;
    };
    expect(reg.actions[VIDEO_RETAKE_ACTION].template).toBe("video_retake");
    expect(reg.templates.video_retake.file).toBe(PACK);
  });

  it("pack lints clean against object_info", () => {
    const errors = lintErrors(lintGraph(graph(), OBJECT_INFO));
    expect(errors.map(formatLintIssue)).toEqual([]);
  });

  for (const audio of ["keep", "follow", "regen"] as const) {
    it(`audio=${audio}: lints clean, masks and audio wired`, () => {
      const { workflow: wf, seed } = build({ audio, prompt: "the fox leaps" });
      const errors = lintErrors(lintGraph(wf, OBJECT_INFO));
      expect(errors.map(formatLintIssue)).toEqual([]);
      const N = VRT_NODES;
      expect(seed).toBe(7);
      expect(wf[N.noise].inputs.noise_seed).toBe(7);
      expect(wf[N.pos].inputs.text).toBe("the fox leaps");
      expect(wf[N.neg].inputs.text).toBe(VIDEO_RETAKE_NEGATIVE);
      expect(wf[N.load].inputs.file).toMatch(/clip\.mp4/);
      expect(wf[N.genScale].inputs).toMatchObject({ width: 1024, height: 576 });

      const lat = chainValues(wf, wf[N.latentMaskCut].inputs.image);
      expect(lat).toHaveLength(16);
      expect(lat[7]).toBe(1);
      expect(lat[0]).toBe(0);
      const pix = chainValues(wf, wf[N.pixelMask].inputs.image);
      expect(pix).toHaveLength(121);
      expect(pix.slice(0, 48).every((v) => v === 0)).toBe(true);
      expect(pix.slice(72).every((v) => v === 0)).toBe(true);
      expect(pix[60]).toBe(1);

      // Composite: source frames are the destination, generated pasted in.
      expect(wf[N.composite].inputs.destination).toEqual([N.components, 0]);
      expect(wf[N.composite].inputs.mask).toEqual([N.pixelMask, 0]);
      expect(wf[N.video].inputs.images).toEqual([N.composite, 0]);

      const av = wf[N.av].inputs.audio_latent;
      if (audio === "keep") {
        expect(av).toEqual([N.emptyAudio, 0]);
        expect(wf[N.video].inputs.audio).toEqual([N.components, 1]);
        expect(wf[N.audioEncode]).toBeUndefined();
        expect(wf[N.audioDecode]).toBeUndefined();
      } else if (audio === "follow") {
        expect(av).toEqual([N.audioFreeze, 0]);
        expect(wf[N.video].inputs.audio).toEqual([N.components, 1]);
        expect(wf[N.emptyAudio]).toBeUndefined();
      } else {
        expect(av).toEqual([N.audioMask, 1]);
        expect(wf[N.audioMask].inputs).toMatchObject({
          audio_start_time: 2,
          audio_end_time: 3,
          max_length: "partial",
        });
        expect(wf[N.video].inputs.audio).toEqual([N.audioDecode, 0]);
        expect(wf[N.emptyAudio]).toBeUndefined();
      }
      // Every link points at a node that exists.
      for (const [id, node] of Object.entries(wf)) {
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
            expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
          }
        }
      }
    });
  }

  it("strength scales the latent mask; fps from the client", () => {
    const { workflow: wf } = build({ strength: 0.5, sourceFps: 30 });
    const lat = chainValues(wf, wf[VRT_NODES.latentMaskCut].inputs.image);
    // 2..3 s at 30 fps = frames 60..89 -> latents 8..12
    expect(lat[10]).toBeCloseTo(128 / 255);
    expect(lat[3]).toBe(0);
  });

  it("rejects a run without a video", () => {
    const r = run();
    r.jobs[0].videos = [];
    expect(() => buildVideoRetakeWorkflow(graph(), r, 0, {})).toThrow(
      /no video/,
    );
  });
});

describe("card request", () => {
  it("builds params from sliders, prompt and seed", () => {
    const spec = getActionTool("video_retake")!;
    expect(spec.subtitle.length).toBeLessThanOrEqual(90);
    const settings = { ...defaultSettings(spec), text: "the fox leaps" };
    settings.picks.retake_start = "1";
    settings.picks.retake_end = "2.5";
    settings.seed = 42;
    const req = buildActionRequest(spec, settings, null);
    expect(req.action).toBe("video_retake");
    expect(req.params).toMatchObject({
      retake_start: 1,
      retake_end: 2.5,
      strength: 1,
      audio: "keep",
      prompt: "the fox leaps",
      seed: 42,
    });
    expect(req.params.retake_to_end).toBeUndefined();
    settings.picks.retake_to_end = "1";
    expect(buildActionRequest(spec, settings, null).params.retake_to_end).toBe(
      true,
    );
    settings.picks.retake_end = "0.5";
    expect(() => buildActionRequest(spec, settings, null)).toThrow(/after/);
  });
});
