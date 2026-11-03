import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { GalleryImage, ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import pipelineNodes from "./fixtures/pipelineNodes.objectInfo.json";
import stitchNodes from "./fixtures/stitchNodes.objectInfo.json";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  STITCH_CLIPS_ACTION,
  buildStitchClipsWorkflow,
  planStitch,
} from "@/lib/oj/stitchClips";
import {
  STITCH_CLIPS_KEY,
  STITCH_MAX_CLIPS,
  clipRefFromUrl,
  recentVideoClips,
  stitchClipsCard,
  stitchFps,
  stitchParams,
  stitchValidation,
  type StitchClip,
} from "@/lib/tools/stitchClips";
import {
  fetchClipFps,
  measureClips,
  runStitch,
  withSourceClipFps,
} from "@/lib/tools/stitchRunner";
import { buildHubCards } from "@/lib/tools/hub";
import type { RunnerDeps } from "@/lib/tools/pipelineRunner";
import type { EngineContext } from "@/lib/tools/templates";

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string; kind: string }>;
  actions: Record<
    string,
    { template: string; requiresImage?: boolean; group?: string }
  >;
};
const base = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        PACKS,
        reg.templates[reg.actions[STITCH_CLIPS_ACTION].template].file,
      ),
      "utf8",
    ),
  ) as Workflow;

type InputSpec = [unknown, Record<string, unknown>?];
const OBJECT_INFO = { ...pipelineNodes, ...stitchNodes } as Record<
  string,
  unknown
>;
const INFO = OBJECT_INFO as unknown as Record<
  string,
  {
    input: Record<string, Record<string, InputSpec>>;
    output: string[];
  }
>;

function options(spec: InputSpec): string[] | null {
  if (Array.isArray(spec[0])) return spec[0] as string[];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options))
    return spec[1]!.options as string[];
  return null;
}

/**
 * object_info check: classes, declared inputs, combo values, ranges,
 * required inputs, and link targets (node exists, output slot exists and
 * its type is the input's type).
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
    const all = { ...info.input.required, ...info.input.optional };
    for (const [key, value] of Object.entries(node.inputs)) {
      const spec = all[key];
      if (!spec) {
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
        continue;
      }
      if (Array.isArray(value)) {
        const [src, slot] = value as [string, number];
        const from = wf[src];
        if (!from) {
          errors.push(`${id}.${key}: link to missing node ${src}`);
          continue;
        }
        const outType = INFO[from.class_type]?.output[slot];
        const want = Array.isArray(spec[0]) ? "COMBO" : spec[0];
        if (outType !== want)
          errors.push(`${id}.${key}: ${String(outType)} into ${String(want)}`);
        continue;
      }
      const opts = options(spec);
      if (opts && key !== "video" && !opts.includes(String(value)))
        errors.push(`${id}.${key}: ${String(value)} not in options`);
      const range = spec[1] as { min?: number; max?: number } | undefined;
      if (typeof value === "number" && range) {
        if (typeof range.min === "number" && value < range.min)
          errors.push(`${id}.${key}: ${value} < ${range.min}`);
        if (typeof range.max === "number" && value > range.max)
          errors.push(`${id}.${key}: ${value} > ${range.max}`);
      }
    }
    for (const req of Object.keys(info.input.required ?? {}))
      if (!(req in node.inputs)) errors.push(`${id}: missing required ${req}`);
  }
  return errors;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );

const seedRun = {
  run_id: "seed1",
  prompt: "stitch clips",
  jobs: [{ index: 0 }],
} as unknown as ImagineRun;

const build = (params: Record<string, unknown>) =>
  buildStitchClipsWorkflow(base(), seedRun, 0, params);

const ref = (n: number) =>
  `video/shot_${String(n).padStart(5, "0")}_.mp4 [output]`;
const view = (n: number) =>
  `/api/comfy/image?filename=shot_${String(n).padStart(5, "0")}_.mp4&subfolder=video&type=output`;

/** Walk the image chain feeding CreateVideo and count frames per clip. */
function frameCount(wf: Workflow, frames: number[]): number {
  const loads = byClass(wf, "VHS_LoadVideo").map(([id]) => id);
  const count = (id: string, slot = 0): number => {
    const n = wf[id];
    const link = (k: string) => n.inputs[k] as [string, number];
    switch (n.class_type) {
      case "VHS_LoadVideo":
        return frames[loads.indexOf(id)];
      case "ImageScale":
        return count(...link("image"));
      case "ImageBatch":
        return count(...link("image1")) + count(...link("image2"));
      case "ImageBlend":
        return count(...link("image1"));
      case "ImageFromBatch":
        return n.inputs.length as number;
      case "VHS_SplitImages": {
        const total = count(...link("images"));
        const at = n.inputs.split_index as number;
        const i = at < 0 ? total + at : at;
        return slot === 0 ? i : total - i;
      }
      default:
        throw new Error(`unexpected ${n.class_type}`);
    }
  };
  const create = byClass(wf, "CreateVideo")[0][1];
  return count(...(create.inputs.images as [string, number]));
}

describe("stitch_clips registry wiring", () => {
  it("has a template + action and a builder", () => {
    expect(reg.actions[STITCH_CLIPS_ACTION]).toMatchObject({
      template: "stitch_clips",
      requiresImage: false,
    });
    expect(reg.templates.stitch_clips.file).toBe(
      "packs/utility/stitch_clips.json",
    );
    expect(actionBuilderFor(STITCH_CLIPS_ACTION)).toBe(
      buildStitchClipsWorkflow,
    );
    // Source is a text seed; the clips travel in params.
    expect(VIDEO_INPUT_ACTIONS.has(STITCH_CLIPS_ACTION)).toBe(false);
  });

  it("pack template validates and uses no models", () => {
    const wf = base();
    expect(validate(wf)).toEqual([]);
    expect(missingAgainstObjectInfo(wf, OBJECT_INFO)).toEqual([]);
    expect(byClass(wf, "SaveVideo")).toHaveLength(1);
  });
});

describe("planStitch", () => {
  it("defaults to a 24 fps hard cut without sound", () => {
    const plan = planStitch({ clips: [ref(1), ref(2)] });
    expect(plan).toMatchObject({
      fps: 24,
      transition: "cut",
      fadeFrames: 0,
      audio: false,
      width: null,
      prefix: "video/adrift_stitch",
      totalSeconds: null,
    });
  });

  it("rejects bad clip lists", () => {
    expect(() => planStitch({ clips: [ref(1)] })).toThrow(/at least 2/);
    expect(() =>
      planStitch({ clips: Array.from({ length: 9 }, (_, i) => ref(i)) }),
    ).toThrow(/at most 8/);
    expect(() => planStitch({ clips: [ref(1), "../etc/passwd"] })).toThrow(
      /clip 2/,
    );
    expect(() =>
      planStitch({ clips: [ref(1), "video/still_00001_.png [output]"] }),
    ).toThrow(/clip 2/);
    expect(() =>
      planStitch({ clips: [{ video: ref(1), seconds: -1 }, ref(2)] }),
    ).toThrow(/seconds/);
    expect(() => planStitch({ clips: "nope" })).toThrow(/at least 2/);
  });

  it("caps the total length", () => {
    expect(() =>
      planStitch({
        clips: [
          { video: ref(1), seconds: 40 },
          { video: ref(2), seconds: 30 },
        ],
      }),
    ).toThrow(/longer than 60s/);
  });

  it("keeping sound needs every clip length", () => {
    expect(() =>
      planStitch({
        clips: [{ video: ref(1), seconds: 4 }, ref(2)],
        audio: true,
      }),
    ).toThrow(/clip 2's seconds/);
  });

  it("converts the crossfade to frames and caps it by clip length", () => {
    expect(
      planStitch({ clips: [ref(1), ref(2)], transition: "fade" }).fadeFrames,
    ).toBe(12);
    expect(
      planStitch({
        clips: [ref(1), ref(2)],
        transition: "fade",
        fadeSeconds: 1,
        fps: 30,
      }).fadeFrames,
    ).toBe(24);
    // 0.5 s clip = 12 frames -> at most 6 blended per seam.
    expect(
      planStitch({
        clips: [{ video: ref(1), seconds: 0.5 }, ref(2)],
        transition: "fade",
        fadeSeconds: 1,
      }).fadeFrames,
    ).toBe(6);
    // Too short to blend: falls back to a cut.
    const tiny = planStitch({
      clips: [{ video: ref(1), seconds: 0.1 }, ref(2)],
      transition: "fade",
    });
    expect(tiny.transition).toBe("cut");
    expect(tiny.fadeFrames).toBe(0);
  });

  it("clamps fps and validates size + prefix", () => {
    expect(planStitch({ clips: [ref(1), ref(2)], fps: 120 }).fps).toBe(30);
    expect(planStitch({ clips: [ref(1), ref(2)], fps: "5" }).fps).toBe(12);
    expect(
      planStitch({ clips: [ref(1), ref(2)], width: 721, height: 1280 }),
    ).toMatchObject({ width: 722, height: 1280 });
    expect(() => planStitch({ clips: [ref(1), ref(2)], width: 720 })).toThrow(
      /height/,
    );
    expect(planStitch({ clips: [ref(1), ref(2)], prefix: "../x" }).prefix).toBe(
      "video/adrift_stitch",
    );
    expect(
      planStitch({ clips: [ref(1), ref(2)], prefix: "video/scene_3" }).prefix,
    ).toBe("video/scene_3");
  });
});

describe("buildStitchClipsWorkflow", () => {
  it("hard cut: one loader per clip, matched to clip 1's size", () => {
    const { workflow, slots, seed } = build({
      clips: [ref(1), ref(2), ref(3)],
    });
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const loads = byClass(workflow, "VHS_LoadVideo");
    expect(loads.map(([, n]) => n.inputs.video)).toEqual([
      ref(1),
      ref(2),
      ref(3),
    ]);
    expect(loads.every(([, n]) => n.inputs.force_rate === 24)).toBe(true);
    const size = byClass(workflow, "GetImageSize");
    expect(size).toHaveLength(1);
    expect(size[0][1].inputs.image).toEqual([loads[0][0], 0]);
    const scales = byClass(workflow, "ImageScale");
    expect(scales).toHaveLength(2);
    for (const [, s] of scales) {
      expect(s.inputs.width).toEqual([size[0][0], 0]);
      expect(s.inputs.height).toEqual([size[0][0], 1]);
    }
    expect(byClass(workflow, "ImageBatch")).toHaveLength(2);
    expect(byClass(workflow, "ImageBlend")).toHaveLength(0);
    expect(frameCount(workflow, [97, 121, 49])).toBe(97 + 121 + 49);
    const create = byClass(workflow, "CreateVideo")[0][1];
    expect(create.inputs.fps).toBe(24);
    expect(create.inputs.audio).toBeUndefined();
    const save = workflow[slots.ksamplerId];
    expect(save.class_type).toBe("SaveVideo");
    expect(save.inputs.video).toEqual([
      byClass(workflow, "CreateVideo")[0][0],
      0,
    ]);
    expect(save.inputs.filename_prefix).toBe("video/adrift_stitch");
    expect(slots.posTextInputName).toBe("filename_prefix");
    expect(seed).toBe(0);
    expect(workflow._meta).toBeTruthy();
  });

  it("explicit size scales every clip to constants", () => {
    const { workflow } = build({
      clips: [ref(1), ref(2)],
      width: 720,
      height: 1280,
    });
    expect(validate(workflow)).toEqual([]);
    expect(byClass(workflow, "GetImageSize")).toHaveLength(0);
    const scales = byClass(workflow, "ImageScale");
    expect(scales).toHaveLength(2);
    expect(scales.every(([, s]) => s.inputs.width === 720)).toBe(true);
  });

  it("crossfade: K blended frames per seam, sum - (N-1)K frames", () => {
    const { workflow } = build({
      clips: [ref(1), ref(2), ref(3)],
      transition: "fade",
      fadeSeconds: 0.25,
    });
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const k = 6;
    const blends = byClass(workflow, "ImageBlend");
    expect(blends).toHaveLength(2 * k);
    const factors = blends.slice(0, k).map(([, b]) => b.inputs.blend_factor);
    expect(factors).toEqual([0.14, 0.29, 0.43, 0.57, 0.71, 0.86]);
    const splits = byClass(workflow, "VHS_SplitImages");
    expect(splits.map(([, s]) => s.inputs.split_index)).toEqual([-k, k, -k, k]);
    expect(frameCount(workflow, [97, 121, 49])).toBe(97 + 121 + 49 - 2 * k);
  });

  it("sound: per-clip track padded + trimmed to its share, chained", () => {
    const { workflow } = build({
      clips: [
        { video: ref(1), seconds: 4 },
        { video: ref(2), seconds: 5, audio: false },
        { video: ref(3), seconds: 3 },
      ],
      transition: "fade",
      fadeSeconds: 0.5,
      audio: true,
    });
    expect(validate(workflow)).toEqual([]);
    const loads = byClass(workflow, "VHS_LoadVideo").map(([id]) => id);
    const silences = byClass(workflow, "EmptyAudio").map(
      ([, n]) => n.inputs.duration,
    );
    // 12 crossfade frames at 24 fps leave each clip but the last 0.5 s short.
    expect(silences).toEqual([3.5, 4.5, 3]);
    const trims = byClass(workflow, "TrimAudioDuration");
    expect(trims.map(([, n]) => n.inputs.duration)).toEqual([3.5, 3]);
    const pads = byClass(workflow, "AudioConcat").filter(([, n]) =>
      loads.includes((n.inputs.audio1 as [string, number])[0]),
    );
    // Clip 2 is silent: its sound track is never read.
    expect(pads.map(([, n]) => n.inputs.audio1)).toEqual([
      [loads[0], 2],
      [loads[2], 2],
    ]);
    const create = byClass(workflow, "CreateVideo")[0][1];
    const track = workflow[(create.inputs.audio as [string, number])[0]];
    expect(track.class_type).toBe("AudioConcat");
    expect(frameCount(workflow, [96, 120, 72])).toBe(96 + 120 + 72 - 2 * 12);
  });

  it("rejects a workflow without SaveVideo", () => {
    expect(() =>
      buildStitchClipsWorkflow({}, seedRun, 0, { clips: [ref(1), ref(2)] }),
    ).toThrow(/SaveVideo/);
  });

  it("builds the max clip count with crossfades", () => {
    const { workflow } = build({
      clips: Array.from({ length: STITCH_MAX_CLIPS }, (_, i) => ref(i + 1)),
      transition: "fade",
      fadeSeconds: 1,
      fps: 30,
    });
    expect(validate(workflow)).toEqual([]);
    expect(byClass(workflow, "ImageBlend")).toHaveLength(7 * 24);
  });
});

describe("stitch client helpers", () => {
  it("clipRefFromUrl reads view URLs and bare refs", () => {
    expect(clipRefFromUrl(view(3))).toBe(ref(3));
    expect(clipRefFromUrl(ref(3))).toBe(ref(3));
    expect(clipRefFromUrl("/view?filename=a.webm&type=output&subfolder=")).toBe(
      "a.webm [output]",
    );
    expect(clipRefFromUrl("/api/comfy/image?filename=a.png&type=output")).toBe(
      null,
    );
    expect(
      clipRefFromUrl("/api/comfy/image?filename=a.mp4&subfolder=../x"),
    ).toBe(null);
    expect(clipRefFromUrl("")).toBe(null);
    expect(clipRefFromUrl(undefined)).toBe(null);
  });

  it("recentVideoClips keeps local, visible, unique videos in order", () => {
    const item = (id: string, over: Partial<GalleryImage>) =>
      ({ id, url: "", prompt: `p ${id}`, ...over }) as GalleryImage;
    const clips = recentVideoClips([
      item("a", { videoUrl: view(1) }),
      item("b", {}),
      item("c", { videoUrl: view(2), hidden: true }),
      item("d", {
        videoUrl: view(3),
        external: { source: "civitai", id: 1 },
      }),
      item("e", { videoUrl: view(1) }),
      item("f", { videoUrl: view(4) }),
    ]);
    expect(clips.map((c) => c.id)).toEqual(["a", "f"]);
    expect(clips[0]).toMatchObject({ ref: ref(1), url: view(1), label: "p a" });
    expect(recentVideoClips([item("a", { videoUrl: view(1) })], 0)).toEqual([]);
  });

  it("stitchValidation explains what is missing", () => {
    const c = (n: number, seconds?: number): StitchClip => ({
      ref: ref(n),
      seconds,
    });
    expect(stitchValidation([c(1)])).toMatch(/at least 2/);
    expect(stitchValidation([c(1), c(2)])).toBeNull();
    expect(stitchValidation([c(1, 40), c(2, 30)])).toMatch(/limit is 60/);
    expect(stitchValidation([c(1, 4), c(2)], { audio: true })).toMatch(
      /length/,
    );
    expect(stitchValidation([c(1, 4), c(2, 4)], { audio: true })).toBeNull();
  });

  it("stitchParams round-trips through the builder's plan", () => {
    const params = stitchParams(
      [
        { ref: ref(1), seconds: 4.12345 },
        { ref: ref(2), seconds: 3, audio: false },
      ],
      { transition: "fade", fps: 30, audio: true },
    );
    expect(params).toEqual({
      clips: [
        { video: ref(1), seconds: 4.123 },
        { video: ref(2), seconds: 3, audio: false },
      ],
      transition: "fade",
      fps: 30,
      audio: true,
      fadeSeconds: 0.5,
    });
    expect(planStitch(params)).toMatchObject({ fadeFrames: 15, audio: true });
    expect(() => stitchParams([{ ref: ref(1) }])).toThrow(/at least 2/);
    expect(() =>
      stitchParams([{ ref: ref(1) }, { ref: "x.png [output]" }]),
    ).toThrow(/Clip 2/);
    expect(stitchParams([{ ref: ref(1) }, { ref: ref(2) }], {})).toEqual({
      clips: [{ video: ref(1) }, { video: ref(2) }],
      transition: "cut",
      fps: 24,
      audio: false,
    });
  });
});

describe("runStitch", () => {
  function server() {
    const calls: { url: string; body: Record<string, unknown> | null }[] = [];
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      calls.push({ url, body });
      if (url === "/api/jobs/seed-run")
        return json({ run: { run_id: "seed1", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action")
        return json({
          run: { run_id: "stitch1", jobs: [{ index: 0, prompt_id: "p1" }] },
        });
      if (url === "/api/comfy/history/p1")
        return json({
          ok: true,
          videos: [
            {
              filename: "adrift_stitch_00001_.mp4",
              subfolder: "video",
              type: "output",
              url: "/api/comfy/image?filename=adrift_stitch_00001_.mp4&subfolder=video&type=output",
            },
          ],
        });
      return json({ error: "unexpected" }, 500);
    });
    return { fetchImpl, calls };
  }
  const deps = (
    fetchImpl: RunnerDeps["fetchImpl"],
    measure: RunnerDeps["measure"] = async () => 4.5,
  ): RunnerDeps => ({
    fetchImpl,
    clientId: "c1",
    onRun: vi.fn(),
    measure,
    sleep: async () => {},
    pollMs: 0,
  });

  it("seeds a text run, queues stitch_clips with refs, returns the clip", async () => {
    const srv = server();
    const d = deps(srv.fetchImpl);
    const res = await runStitch(
      [
        { ref: ref(1), url: view(1) },
        { ref: ref(2), seconds: 3 },
      ],
      { transition: "fade", audio: true },
      d,
    );
    expect(res.runId).toBe("stitch1");
    expect(res.video).toMatchObject({
      ref: "video/adrift_stitch_00001_.mp4 [output]",
      seconds: 4.5,
    });
    expect(srv.calls.map((c) => c.url)).toEqual([
      "/api/jobs/seed-run",
      "/api/jobs/action",
      "/api/comfy/history/p1",
    ]);
    const act = srv.calls[1].body!;
    expect(act).toMatchObject({
      run_id: "seed1",
      job_index: 0,
      action: STITCH_CLIPS_ACTION,
      client_id: "c1",
    });
    expect(act.params).toMatchObject({
      clips: [
        { video: ref(1), seconds: 4.5 },
        { video: ref(2), seconds: 3 },
      ],
      transition: "fade",
      audio: true,
    });
    expect(d.onRun).toHaveBeenCalledTimes(1);
  });

  it("fails before queueing when a clip length is unknown and sound is on", async () => {
    const srv = server();
    await expect(
      runStitch(
        [{ ref: ref(1), url: view(1) }, { ref: ref(2) }],
        { audio: true },
        deps(srv.fetchImpl, async () => null),
      ),
    ).rejects.toThrow(/length/);
    expect(srv.fetchImpl).not.toHaveBeenCalled();
  });

  it("measureClips only measures clips with a url and no length", async () => {
    const measure = vi.fn(async () => 2);
    const out = await measureClips(
      [
        { ref: ref(1), url: view(1) },
        { ref: ref(2), url: view(2), seconds: 5 },
        { ref: ref(3) },
      ],
      deps(vi.fn(), measure),
    );
    expect(out.map((c) => c.seconds)).toEqual([2, 5, undefined]);
    expect(measure).toHaveBeenCalledTimes(1);
  });
});

describe("stitch hub card", () => {
  const ctx: EngineContext = {
    catalog: [],
    packIds: new Set<string>(),
    editLoras: null,
  } as unknown as EngineContext;

  it("is a model-free Video tool listed in the hub", () => {
    const card = stitchClipsCard();
    expect(card).toMatchObject({
      key: STITCH_CLIPS_KEY,
      kind: "special",
      hubCategory: "Video",
      available: true,
      nc: false,
      icon: "Clapperboard",
    });
    const cards = buildHubCards({ toolCards: [], ctx });
    expect(cards.filter((c) => c.key === STITCH_CLIPS_KEY)).toHaveLength(1);
  });
});

describe("stitch source fps + letterbox", () => {
  it("keeps fractional fps and halves fast rates", () => {
    expect(stitchFps(29.97)).toBe(29.97);
    expect(stitchFps(23.976)).toBe(23.976);
    expect(stitchFps(59.94)).toBe(29.97);
    expect(stitchFps(60)).toBe(30);
    expect(stitchFps(50)).toBe(25);
    expect(stitchFps(5)).toBe(12);
    expect(stitchFps(undefined)).toBe(24);
    expect(stitchFps(Number.NaN)).toBe(24);
  });

  it("planStitch uses sourceFps when fps is absent, fit defaults to crop", () => {
    const clips = [ref(1), ref(2)];
    expect(planStitch({ clips, sourceFps: 29.97 }).fps).toBe(29.97);
    expect(planStitch({ clips, fps: 24, sourceFps: 30 }).fps).toBe(24);
    expect(planStitch({ clips }).fit).toBe("crop");
    expect(planStitch({ clips, fit: "letterbox" }).fit).toBe("letterbox");
    expect(planStitch({ clips, fit: "stretch" }).fit).toBe("crop");
  });

  it("source fps reaches the loaders and CreateVideo", () => {
    const { workflow } = build({ clips: [ref(1), ref(2)], fps: 29.97 });
    expect(validate(workflow)).toEqual([]);
    const loads = byClass(workflow, "VHS_LoadVideo");
    expect(loads.every(([, n]) => n.inputs.force_rate === 29.97)).toBe(true);
    expect(byClass(workflow, "CreateVideo")[0][1].inputs.fps).toBe(29.97);
  });

  it("letterbox pads clips to clip 1's frame with black bars", () => {
    const { workflow } = build({
      clips: [ref(1), ref(2), ref(3)],
      fit: "letterbox",
    });
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    expect(byClass(workflow, "ImageScale")).toHaveLength(0);
    const size = byClass(workflow, "GetImageSize")[0][0];
    const pads = byClass(workflow, "ResizeAndPadImage");
    expect(pads).toHaveLength(2);
    for (const [, p] of pads) {
      expect(p.inputs).toMatchObject({
        target_width: [size, 0],
        target_height: [size, 1],
        padding_color: "black",
        interpolation: "lanczos",
      });
    }
    const sized = build({
      clips: [ref(1), ref(2)],
      fit: "letterbox",
      width: 720,
      height: 1280,
    }).workflow;
    expect(validate(sized)).toEqual([]);
    expect(byClass(sized, "ResizeAndPadImage")).toHaveLength(2);
  });

  it("stitchParams copies clip 1's fps for 'source' and passes fit", () => {
    const clips = [
      { ref: ref(1), fps: 23.976 },
      { ref: ref(2), fps: 30 },
    ];
    expect(stitchParams(clips, { fps: "source", fit: "letterbox" })).toEqual({
      clips: [{ video: ref(1) }, { video: ref(2) }],
      transition: "cut",
      fps: 23.976,
      audio: false,
      fit: "letterbox",
    });
    expect(
      stitchParams([{ ref: ref(1) }, { ref: ref(2) }], { fps: "source" }).fps,
    ).toBe(24);
    expect(stitchParams(clips, { fit: "crop" }).fit).toBeUndefined();
  });

  it("withSourceClipFps probes clip 1 only when needed", async () => {
    const probe = vi.fn(async () => 29.97);
    const clips: StitchClip[] = [
      { ref: ref(1), url: view(1) },
      { ref: ref(2), url: view(2) },
    ];
    expect(await withSourceClipFps(clips, { fps: 24 }, probe)).toBe(clips);
    expect(probe).not.toHaveBeenCalled();
    const out = await withSourceClipFps(clips, { fps: "source" }, probe);
    expect(probe).toHaveBeenCalledWith(view(1));
    expect(out[0].fps).toBe(29.97);
    expect(out[1]).toBe(clips[1]);
    const known = [{ ...clips[0], fps: 25 }, clips[1]];
    expect(await withSourceClipFps(known, { fps: "source" }, probe)).toBe(
      known,
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("fetchClipFps returns null for failed or non-MP4 responses", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 404 }));
    expect(await fetchClipFps("/x.mp4", bad)).toBeNull();
    const webm = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    expect(await fetchClipFps("/x.webm", webm)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await fetchClipFps("/x.mp4", boom)).toBeNull();
  });
});
