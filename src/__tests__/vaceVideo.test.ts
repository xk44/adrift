/**
 * Wan2.2 Fun VACE video tools (vace_restyle / vace_reframe / vace_extend):
 * graph files, builders, registry wiring and tool-card request mapping.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  VACE_CANVASES,
  VACE_LIGHT_OPTIONS,
  VACE_LOOK_PRESETS,
  VACE_RELIGHT_NEGATIVE,
  buildVaceExtendWorkflow,
  buildVaceReframeWorkflow,
  buildVaceRestyleWorkflow,
  vaceDims,
  VACE_EXTEND_PIXEL_BUDGET,
  vaceColorMatch,
  vaceContextFrames,
  vaceExtendLength,
  vaceExtendOutputSize,
  vaceExtendSourceFrames,
  vaceExtendWindowSeconds,
  vaceTailRefsFromVideoUrl,
  vaceLength,
  vaceReframeFit,
  vaceRestylePrompt,
} from "@/lib/oj/vaceVideo";
import { RELIGHT_PRESETS } from "@/lib/oj/relight";
import { VACE_LOOK_GROUPS } from "@/lib/oj/vacePresets";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  groupOptions,
} from "@/lib/tools/toolsPage";
import { extractOutputs } from "@/lib/comfy/outputs";
import { submitVideoTool, vaceTailContext } from "@/lib/tools/runTool";
import { addMasterOutputs } from "@/lib/output/saveNodes";
import type { ImagineRun, Workflow } from "@/types";

const ACTIONS = ["vace_restyle", "vace_reframe", "vace_extend"] as const;
const PACK_DIR = path.join(process.cwd(), "public/workflows/packs/wan22");
const graph = (name: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(PACK_DIR, `${name}.json`), "utf-8"),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as Workflow;
};

const run = (
  over: Partial<ImagineRun> & { seconds?: number } = {},
): ImagineRun =>
  ({
    run_id: "src",
    prompt: "clip",
    parsedPrompt: "clip",
    width: over.width ?? 1280,
    height: over.height ?? 720,
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "completed",
        progress: 100,
        images: [],
        videos: ["/api/comfy/view?filename=cj%2Fclip.mp4&type=input"],
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: { video_seconds: over.seconds ?? 8.13 },
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, c: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === c);
const one = (wf: Workflow, c: string) => {
  const hits = byClass(wf, c);
  expect(hits).toHaveLength(1);
  return hits[0];
};

/** Every link points at an existing node. */
function expectLinked(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("vace graphs + registry", () => {
  it.each(ACTIONS)("%s is registered, routed and core-only", (action) => {
    const templates = registry.templates as Record<string, { file: string }>;
    const actions = registry.actions as Record<string, Record<string, unknown>>;
    expect(templates[action].file).toBe(`packs/wan22/${action}.json`);
    expect(actions[action]).toMatchObject({
      id: action,
      template: action,
      requiresImage: false,
    });
    expect(resolveWorkflow({ templateOrAction: action }).workflowPath).toBe(
      `packs/wan22/${action}.json`,
    );
    expect(actionBuilderFor(action)).toBeDefined();
    expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(true);

    const wf = graph(action);
    expectLinked(wf);
    const unets = byClass(wf, "UNETLoader").map(([, n]) => n.inputs.unet_name);
    expect(unets).toEqual([
      "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors",
      "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors",
    ]);
    expect(one(wf, "VAELoader")[1].inputs.vae_name).toBe(
      "split_files/vae/wan_2.1_vae.safetensors",
    );
    // Extend encodes at the source fps (GetVideoComponents); the others at 16.
    expect(one(wf, "CreateVideo")[1].inputs.fps).toEqual(
      action === "vace_extend" ? ["30", 2] : 16,
    );
    expect(JSON.stringify(wf)).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe("vace sizing helpers", () => {
  it("snaps length to 4n+1 within [17, 81] at 16 fps", () => {
    expect(vaceLength(undefined)).toBe(81);
    expect(vaceLength(8.13)).toBe(81);
    expect(vaceLength(3)).toBe(45);
    expect(vaceLength(2.1)).toBe(33);
    expect(vaceLength(0.4)).toBe(17);
    for (const s of [1.3, 2.7, 4.9]) expect((vaceLength(s) - 1) % 4).toBe(0);
  });

  it("keeps ~480p, multiples of 16, long edge <= 832", () => {
    expect(vaceDims(1920, 1080)).toEqual({ width: 832, height: 480 });
    expect(vaceDims(1080, 1920)).toEqual({ width: 480, height: 832 });
    expect(vaceDims(1024, 768)).toEqual({ width: 640, height: 480 });
    expect(vaceDims(512, 512)).toEqual({ width: 480, height: 480 });
  });

  it("fits the source inside each canvas with 8-px pads", () => {
    for (const canvas of Object.values(VACE_CANVASES)) {
      if (canvas.width === 832) continue; // 16:9 source into 16:9 throws
      const fit = vaceReframeFit(1280, 720, canvas);
      expect(fit.width + fit.left + fit.right).toBe(canvas.width);
      expect(fit.height + fit.top + fit.bottom).toBe(canvas.height);
      for (const v of [
        fit.width,
        fit.height,
        fit.left,
        fit.top,
        fit.right,
        fit.bottom,
      ])
        expect(v % 8).toBe(0);
    }
    expect(vaceReframeFit(1280, 720, VACE_CANVASES["9:16"])).toEqual({
      width: 480,
      height: 272,
      left: 0,
      top: 280,
      right: 0,
      bottom: 280,
    });
    expect(() => vaceReframeFit(1920, 1080, VACE_CANVASES["16:9"])).toThrow(
      /already has this aspect/,
    );
  });

  it("extend windows", () => {
    expect(vaceExtendLength(3)).toBe(65);
    expect(vaceExtendLength("2")).toBe(49);
    expect(vaceExtendLength(9)).toBe(81);
    expect(vaceExtendSourceFrames(8.13)).toBe(130);
    expect(vaceExtendSourceFrames(60)).toBe(320);
    expect(vaceExtendSourceFrames(undefined)).toBe(81);
  });
});

describe("vace builders", () => {
  it("restyle: prompt, window, balanced sampling, no ref by default", () => {
    const { workflow: wf, seed } = buildVaceRestyleWorkflow(
      graph("vace_restyle"),
      run({ seconds: 3 }),
      0,
      { prompt: "charcoal sketch", seed: 5 },
    );
    expectLinked(wf);
    expect(seed).toBe(5);
    expect(one(wf, "LoadVideo")[1].inputs.file).toBe("cj/clip.mp4 [input]");
    expect(one(wf, "VideoFrameSample")[1].inputs.num_frames).toBe(45);
    expect(one(wf, "Video Slice")[1].inputs.duration).toBe(45 / 16);
    const [vaceId, vace] = one(wf, "WanVaceToVideo");
    expect(vace.inputs).toMatchObject({ width: 832, height: 480, length: 45 });
    expect(vace.inputs.reference_image).toBeUndefined();
    expect(byClass(wf, "LoadImage")).toHaveLength(0);
    const pos = wf[(vace.inputs.positive as [string, number])[0]];
    expect(pos.inputs.text).toBe("charcoal sketch");
    // balanced: no LoRA on the high-noise model, 8 steps cfg 3.5 → 4/8.
    expect(byClass(wf, "LoraLoaderModelOnly")).toHaveLength(1);
    const [hi, lo] = byClass(wf, "KSamplerAdvanced").map(([, n]) => n);
    expect(hi.inputs).toMatchObject({
      steps: 8,
      cfg: 3.5,
      end_at_step: 4,
      noise_seed: 5,
    });
    expect(lo.inputs).toMatchObject({ steps: 8, cfg: 1, start_at_step: 4 });
    const shiftHi = wf[(hi.inputs.model as [string, number])[0]];
    expect(wf[(shiftHi.inputs.model as [string, number])[0]].class_type).toBe(
      "UNETLoader",
    );
    expect(vaceId).toBeDefined();
  });

  it("restyle: optional reference image + fast mode", () => {
    const { workflow: wf } = buildVaceRestyleWorkflow(
      graph("vace_restyle"),
      run(),
      0,
      {
        prompt: "anime",
        secondRefImage: "cj_face_1.png [input]",
        speed: "fast",
      },
    );
    expectLinked(wf);
    const [loadId, load] = one(wf, "LoadImage");
    expect(load.inputs.image).toBe("cj_face_1.png [input]");
    expect(one(wf, "WanVaceToVideo")[1].inputs.reference_image).toEqual([
      loadId,
      0,
    ]);
    expect(byClass(wf, "LoraLoaderModelOnly")).toHaveLength(2);
    const [hi, lo] = byClass(wf, "KSamplerAdvanced").map(([, n]) => n);
    expect(hi.inputs).toMatchObject({ steps: 4, cfg: 1, end_at_step: 2 });
    expect(lo.inputs).toMatchObject({ steps: 4, start_at_step: 2 });
    const shiftHi = wf[(hi.inputs.model as [string, number])[0]];
    expect(wf[(shiftHi.inputs.model as [string, number])[0]].class_type).toBe(
      "LoraLoaderModelOnly",
    );
  });

  it("restyle: rejects missing prompt / bad ref / no video", () => {
    expect(() =>
      buildVaceRestyleWorkflow(graph("vace_restyle"), run(), 0, {}),
    ).toThrow(/prompt/);
    expect(() =>
      buildVaceRestyleWorkflow(graph("vace_restyle"), run(), 0, {
        prompt: "x",
        secondRefImage: "/etc/passwd",
      }),
    ).toThrow(/secondRefImage/);
    const noVideo = run();
    noVideo.jobs[0].videos = [];
    expect(() =>
      buildVaceRestyleWorkflow(graph("vace_restyle"), noVideo, 0, {
        prompt: "x",
      }),
    ).toThrow(/no video/);
  });

  it("reframe: canvas, pads and per-frame mask", () => {
    const { workflow: wf } = buildVaceReframeWorkflow(
      graph("vace_reframe"),
      run({ seconds: 4 }),
      0,
      { aspect: "1:1", prompt: "a red car on a coast road." },
    );
    expectLinked(wf);
    expect(one(wf, "WanVaceToVideo")[1].inputs).toMatchObject({
      width: 624,
      height: 624,
      length: 61,
    });
    expect(one(wf, "ImageScale")[1].inputs).toMatchObject({
      width: 624,
      height: 352,
      crop: "disabled",
    });
    expect(one(wf, "ImagePadForOutpaint")[1].inputs).toMatchObject({
      left: 0,
      right: 0,
      top: 136,
      bottom: 136,
    });
    expect(one(wf, "RepeatImageBatch")[1].inputs.amount).toBe(61);
    const vace = one(wf, "WanVaceToVideo")[1];
    expect(
      wf[(vace.inputs.positive as [string, number])[0]].inputs.text,
    ).toBe(
      "a red car on a coast road. Seamless continuation of the same environment, consistent lighting, cinematic.",
    );
    expect(() =>
      buildVaceReframeWorkflow(graph("vace_reframe"), run(), 0, {}),
    ).toThrow(/describe the scene/);
  });

  it("extend: context tail, masks and output splice", () => {
    const { workflow: wf } = buildVaceExtendWorkflow(
      graph("vace_extend"),
      run({ seconds: 8.13 }),
      0,
      { seconds: 2, prompt: "the car drives on" },
    );
    expectLinked(wf);
    expect(one(wf, "VideoFrameSample")[1].inputs.num_frames).toBe(130);
    expect(wf["21"].inputs.duration).toBe(130 / 16);
    expect(one(wf, "WanVaceToVideo")[1].inputs.length).toBe(49);
    const [ctx, fresh, tail] = byClass(wf, "ImageFromBatch").map(([, n]) => n);
    expect(ctx.inputs).toMatchObject({ batch_index: 113, length: 17 });
    expect(fresh.inputs).toMatchObject({ batch_index: 17, length: 32 });
    const sizes = byClass(wf, "EmptyImage").map(([, n]) => [
      n.inputs.color,
      n.inputs.batch_size,
    ]);
    expect(sizes).toEqual([
      [0x808080, 32],
      [0, 17],
      [0xffffff, 32],
    ]);
    // Generation canvas: squeezed, never cropped (the upscale inverts it).
    expect(wf["24"].inputs).toMatchObject({ width: 832, height: 480, crop: "disabled" });

    // Output: native source frames (straight off the slice) + continuation.
    expect(wf["30"].inputs.video).toEqual(["21", 0]);
    expect(wf["48"].inputs).toEqual({ image1: ["30", 0], image2: ["55", 0] });
    expect(wf["50"].inputs).toMatchObject({
      images: ["47", 0],
      reference: ["40", 0],
      strength: 1,
    });
    expect(wf["56"].inputs).toMatchObject({
      images: ["50", 0],
      src_fps: 16,
      dst_fps: ["30", 2],
      method: "nearest",
    });
    expect(wf["55"].inputs).toMatchObject({
      image: ["56", 0],
      upscale_method: "lanczos",
      width: ["31", 0],
      height: ["31", 1],
    });
    expect(wf["31"].inputs.image).toEqual(["30", 0]);
    expect(wf["16"].inputs).toEqual({
      images: ["48", 0],
      fps: ["30", 2],
      audio: ["58", 0],
    });
    expect(wf["58"].inputs).toMatchObject({ audio1: ["30", 1], audio2: ["57", 0] });
    expect(wf["57"].inputs.duration).toBe(2);
    expect(wf["32"]).toBeUndefined();
    expect(byClass(wf, "LoadImage")).toHaveLength(0);

    // Lossless tail: last 17 of context + continuation, before H.264.
    expect(wf["51"].inputs).toEqual({ image1: ["40", 0], image2: ["50", 0] });
    expect(tail.inputs).toMatchObject({ image: ["51", 0], batch_index: 32, length: 17 });
    const video = String(wf["17"].inputs.filename_prefix);
    const m = /^video\/(CJ_VaceExtend_[a-z0-9]+)$/.exec(video);
    expect(m).not.toBeNull();
    expect(wf["53"].inputs.filename_prefix).toBe(`video/adrift_ctx/${m![1]}/f`);
    expect((wf["53"]._meta as { adrift_sidecar?: boolean }).adrift_sidecar).toBe(true);
    // A fresh token per run (tail folders never collide).
    const again = buildVaceExtendWorkflow(graph("vace_extend"), run(), 0, {});
    expect(again.workflow["17"].inputs.filename_prefix).not.toBe(video);
  });

  it("extend: probed fps, colour strength, 1 s add and >1080p sources", () => {
    const { workflow: wf } = buildVaceExtendWorkflow(
      graph("vace_extend"),
      run({ seconds: 3, width: 3840, height: 2160 }),
      0,
      { seconds: 1, sourceFps: 29.97, color_match: 0.4 },
    );
    expectLinked(wf);
    expect(wf["16"].inputs.fps).toBe(29.97);
    expect(wf["56"].inputs.dst_fps).toBe(29.97);
    expect(wf["50"].inputs.strength).toBe(0.4);
    // 16 new frames < 17: the tail reaches back into the context.
    expect(wf["47"].inputs).toMatchObject({ batch_index: 17, length: 16 });
    expect(wf["52"].inputs).toMatchObject({ batch_index: 16, length: 17 });
    expect(wf["57"].inputs.duration).toBe(1);
    // 4K is output at 1080p pixel count; size probe follows the rescale.
    expect(wf["32"].inputs).toMatchObject({
      image: ["30", 0],
      upscale_method: "lanczos",
      width: 1920,
      height: 1080,
    });
    expect(wf["31"].inputs.image).toEqual(["32", 0]);
    expect(wf["48"].inputs.image1).toEqual(["32", 0]);
  });

  it("extend: lossless context frames replace the H.264 tail", () => {
    const refs = vaceTailRefsFromVideoUrl(
      "/api/comfy/image?filename=CJ_VaceExtend_abc123_00001_.mp4&subfolder=adrift-video%2Fvideo&type=output",
    )!;
    expect(refs).toHaveLength(17);
    expect(refs[0]).toBe(
      "adrift-video/video/adrift_ctx/CJ_VaceExtend_abc123/f_00001_.png [output]",
    );
    expect(refs[16]).toBe(
      "adrift-video/video/adrift_ctx/CJ_VaceExtend_abc123/f_00017_.png [output]",
    );
    const { workflow: wf } = buildVaceExtendWorkflow(
      graph("vace_extend"),
      run({ seconds: 6 }),
      0,
      { seconds: 3, contextFrames: refs },
    );
    expectLinked(wf);
    expect(wf["21"].inputs.duration).toBe(0); // whole clip
    expect(wf["22"]).toBeUndefined();
    expect(wf["23"]).toBeUndefined();
    const loads = byClass(wf, "LoadImage").map(([, n]) => n.inputs.image);
    expect(loads).toEqual(refs);
    expect(wf["40"].inputs).toMatchObject({ image: ["24", 0], batch_index: 0, length: 17 });
    const head = wf["24"].inputs.image as [string, number];
    expect(wf[head[0]].class_type).toBe("ImageBatch");
    // Native output still comes from the clip itself.
    expect(wf["48"].inputs.image1).toEqual(["30", 0]);

    // Clip longer than the window (its end would not match the tail): ignored.
    const long = buildVaceExtendWorkflow(
      graph("vace_extend"),
      run({ seconds: 30 }),
      0,
      { seconds: 3, contextFrames: refs },
    ).workflow;
    expect(byClass(long, "LoadImage")).toHaveLength(0);
    expect(long["22"]).toBeDefined();
  });

  it("extend helpers: tail refs, context validation, window, colour", () => {
    expect(vaceTailRefsFromVideoUrl("/api/comfy/view?filename=CJ_VaceExtend_00001_.mp4&type=output")).toBeNull();
    expect(vaceTailRefsFromVideoUrl("/api/comfy/image?filename=CJ_VaceExtend_x1_00002_.mp4&subfolder=video&type=temp")).toBeNull();
    expect(vaceTailRefsFromVideoUrl("/api/comfy/image?filename=clip.mp4&type=output")).toBeNull();
    expect(vaceTailRefsFromVideoUrl(undefined)).toBeNull();
    expect(
      vaceTailRefsFromVideoUrl("/view?filename=CJ_VaceExtend_q9_00003_.mp4&subfolder=video&type=output")![2],
    ).toBe("video/adrift_ctx/CJ_VaceExtend_q9/f_00003_.png [output]");

    const refs = vaceTailRefsFromVideoUrl(
      "/view?filename=CJ_VaceExtend_q9_00003_.mp4&subfolder=video&type=output",
    )!;
    expect(vaceContextFrames(refs)).toEqual(refs);
    expect(vaceContextFrames(refs.slice(1))).toBeNull();
    expect(vaceContextFrames([...refs.slice(1), "x.png [input]"])).toBeNull();
    expect(vaceContextFrames([...refs.slice(1), "video/other/f.png [output]"])).toBeNull();
    expect(vaceContextFrames([...refs.slice(1), "../adrift_ctx/f.png [output]"])).toBeNull();
    expect(vaceContextFrames("nope")).toBeNull();

    // 720p30: whole clip up to 20 s.
    expect(vaceExtendWindowSeconds(8, { width: 1280, height: 720, fps: 30, addSeconds: 3 })).toBe(8);
    expect(vaceExtendWindowSeconds(60, { width: 1280, height: 720, fps: 30, addSeconds: 3 })).toBe(20);
    // 1080p30: source + continuation <= 12 s.
    expect(vaceExtendWindowSeconds(60, { width: 1920, height: 1080, fps: 30, addSeconds: 4 })).toBeCloseTo(8);
    expect(VACE_EXTEND_PIXEL_BUDGET).toBe(1920 * 1080 * 30 * 12);
    // Never below the 17-frame context.
    expect(vaceExtendWindowSeconds(60, { width: 1920, height: 1080, fps: 240, addSeconds: 4 })).toBe(17 / 16);
    expect(vaceExtendWindowSeconds(undefined)).toBe(81 / 16);

    expect(vaceExtendOutputSize(1920, 1080)).toBeNull();
    expect(vaceExtendOutputSize(undefined, undefined)).toBeNull();
    expect(vaceExtendOutputSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });

    expect(vaceColorMatch(undefined)).toBe(1);
    expect(vaceColorMatch(0)).toBe(0);
    expect(vaceColorMatch("0.25")).toBe(0.25);
    expect(vaceColorMatch(7)).toBe(1);
  });

  it("extend: the lossless tail never reaches the gallery or master outputs", () => {
    const { workflow: wf } = buildVaceExtendWorkflow(graph("vace_extend"), run(), 0, {});
    const name = String(wf["17"].inputs.filename_prefix).slice("video/".length);
    const outputs = extractOutputs(
      {
        outputs: {
          "17": { images: [{ filename: `${name}_00001_.mp4`, subfolder: "video", type: "output" }], animated: [true] },
          "53": {
            images: [1, 2].map((i) => ({
              filename: `f_0000${i}_.png`,
              subfolder: `video/adrift_ctx/${name}`,
              type: "output",
            })),
          },
        },
      },
      wf as never,
    );
    expect(outputs.map((o) => o.nodeId)).toEqual(["17"]);
    // Subfolder alone is enough (graph not at hand).
    expect(
      extractOutputs({
        outputs: {
          "9": { images: [{ filename: "f_00001_.png", subfolder: "adrift-video/video/adrift_ctx/x", type: "output" }] },
        },
      }),
    ).toEqual([]);
    const { added } = addMasterOutputs(wf, { image: "png16" });
    expect(added).toEqual([]);
  });
});

describe("vace tool cards", () => {
  it("map settings to action params", () => {
    const rs = getActionTool("vace_restyle")!;
    expect(rs.secondImageOptional).toBe(true);
    expect(() => buildActionRequest(rs, defaultSettings(rs), null)).toThrow();
    expect(
      buildActionRequest(rs, { ...defaultSettings(rs), text: "anime" }, null),
    ).toEqual({
      action: "vace_restyle",
      params: { speed: "balanced", prompt: "anime" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        rs,
        { ...defaultSettings(rs), text: "anime", picks: { speed: "fast" } },
        null,
        "r.png [input]",
      ).params,
    ).toEqual({
      speed: "fast",
      prompt: "anime",
      secondRefImage: "r.png [input]",
    });

    const rf = getActionTool("vace_reframe")!;
    expect(() => buildActionRequest(rf, defaultSettings(rf), null)).toThrow();
    expect(
      buildActionRequest(rf, { ...defaultSettings(rf), text: "coast" }, null)
        .params,
    ).toEqual({ speed: "balanced", prompt: "coast", aspect: "9:16" });
    const ex = getActionTool("vace_extend")!;
    expect(
      buildActionRequest(
        ex,
        { ...defaultSettings(ex), picks: { seconds: "4" } },
        null,
      ).params,
    ).toEqual({ speed: "balanced", seconds: 4 });
    // Colour match: advanced slider, sent only off its 100 % default.
    const cm = ex.sliders?.find((sl) => sl.key === "color_match");
    expect(cm).toMatchObject({ advanced: true, default: 100, min: 0, max: 100 });
    expect(
      buildActionRequest(
        ex,
        { ...defaultSettings(ex), picks: { color_match: "60" } },
        null,
      ).params,
    ).toEqual({ speed: "balanced", seconds: 3, color_match: 0.6 });
    for (const t of [rs, rf, ex]) {
      expect(t.videoInput).toBeTruthy();
      expect(t.modelCheck).toEqual({ pack: "wan22", action: t.id });
    }
  });
});

describe("extend: lossless tail hand-off (client)", () => {
  const OUT =
    "/api/comfy/image?filename=CJ_VaceExtend_k7_00001_.mp4&subfolder=video&type=output";

  const submit = async (sourceUrl: string | undefined, pngOk: boolean) => {
    let actionBody: { params: Record<string, unknown> } | null = null;
    const probes: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/comfy/image?")) {
        probes.push(url);
        return { ok: pngOk, status: pngOk ? 206 : 404, json: async () => ({}) };
      }
      const body = JSON.parse(String(init?.body));
      if (url === "/api/jobs/action") actionBody = body;
      const json =
        url === "/api/comfy/upload"
          ? { ok: true, ref: `cj/${body.filename} [input]` }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: { run_id: "R", jobs: [{ index: 0 }] } }
            : { ok: true, run: { run_id: "NEW", jobs: [] } };
      return { ok: true, status: 200, json: async () => json };
    });
    const spec = getActionTool("vace_extend")!;
    await submitVideoTool({
      fetchImpl,
      spec,
      settings: defaultSettings(spec),
      video: {
        id: "v",
        previewUrl: "blob:x",
        dataUrl: "data:video/mp4;base64,AAAA",
        label: "clip.mp4",
        duration: 6,
        width: 1280,
        height: 720,
        fps: 24,
        ...(sourceUrl ? { sourceUrl } : {}),
      },
      face: null,
      clientId: "cid",
    });
    return { params: actionBody!.params, probes };
  };

  it("sends contextFrames when the tail PNGs are served", async () => {
    const { params, probes } = await submit(OUT, true);
    expect(params.contextFrames).toEqual(vaceTailRefsFromVideoUrl(OUT));
    expect(params.sourceFps).toBe(24);
    expect(probes).toEqual([
      "/api/comfy/image?filename=f_00001_.png&subfolder=video%2Fadrift_ctx%2FCJ_VaceExtend_k7&type=output",
      "/api/comfy/image?filename=f_00017_.png&subfolder=video%2Fadrift_ctx%2FCJ_VaceExtend_k7&type=output",
    ]);
  });

  it("falls back to the MP4 frames when missing or not an extend output", async () => {
    expect((await submit(OUT, false)).params.contextFrames).toBeUndefined();
    const plain = await submit("/api/comfy/image?filename=x_00001_.mp4&type=output", true);
    expect(plain.params.contextFrames).toBeUndefined();
    expect(plain.probes).toEqual([]);
    expect((await submit(undefined, true)).params.contextFrames).toBeUndefined();
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await vaceTailContext(boom, OUT)).toBeNull();
  });
});

describe("groupOptions", () => {
  it("returns runs of consecutive options sharing a group", () => {
    expect(
      groupOptions([
        { id: "a", label: "A" },
        { id: "b", label: "B", group: "X" },
        { id: "c", label: "C", group: "X" },
        { id: "d", label: "D", group: "Y" },
      ]).map((g) => [g.group, g.options.map((o) => o.id)]),
    ).toEqual([
      ["", ["a"]],
      ["X", ["b", "c"]],
      ["Y", ["d"]],
    ]);
    expect(groupOptions([])).toEqual([]);
  });
});

describe("vace restyle presets (Mixed Media looks + Video Relight)", () => {
  it("ships 37 unique looks and every relight light", () => {
    expect(VACE_LOOK_PRESETS).toHaveLength(37);
    expect(new Set(VACE_LOOK_PRESETS.map((p) => p.id)).size).toBe(37);
    expect(new Set(VACE_LOOK_PRESETS.map((p) => p.label)).size).toBe(37);
    expect(new Set(VACE_LOOK_PRESETS.map((p) => p.prompt)).size).toBe(37);
    for (const p of VACE_LOOK_PRESETS) {
      expect(VACE_LOOK_GROUPS).toContain(p.group);
      expect(p.id).toMatch(/^[a-z_]+$/);
      expect(p.label.length).toBeGreaterThan(2);
      expect(p.prompt.length).toBeGreaterThan(20);
    }
    expect(VACE_LIGHT_OPTIONS.map((o) => o.id).sort()).toEqual(
      Object.keys(RELIGHT_PRESETS).sort(),
    );
  });

  it("composes look, user text and light", () => {
    const water = VACE_LOOK_PRESETS.find((p) => p.id === "watercolor")!;
    expect(vaceRestylePrompt({ look: "watercolor" }).prompt).toBe(water.prompt);
    expect(
      vaceRestylePrompt({ look: "watercolor", prompt: "red car" }).prompt,
    ).toBe(`${water.prompt}, red car`);
    const lit = vaceRestylePrompt({ light: "moonlight" });
    expect(lit.relight).toBe(true);
    expect(lit.negative).toBe(VACE_RELIGHT_NEGATIVE);
    expect(lit.prompt).toContain(`relit with ${RELIGHT_PRESETS.moonlight}`);
    const both = vaceRestylePrompt({ look: "vhs", light: "neon_night" });
    expect(both.relight).toBe(false);
    expect(both.prompt).toContain("relit with neon night lighting");
    expect(vaceRestylePrompt({ look: "none", light: "bogus" }).prompt).toBe("");
  });

  it("builder: look-only run, relight run gets a first-frame reference", () => {
    const look = buildVaceRestyleWorkflow(graph("vace_restyle"), run(), 0, {
      look: "claymation",
    }).workflow;
    const [, vace] = one(look, "WanVaceToVideo");
    expect(
      look[(vace.inputs.positive as [string, number])[0]].inputs.text,
    ).toBe(VACE_LOOK_PRESETS.find((p) => p.id === "claymation")!.prompt);
    expect(vace.inputs.reference_image).toBeUndefined();

    const lit = buildVaceRestyleWorkflow(graph("vace_restyle"), run(), 0, {
      light: "golden_hour",
    }).workflow;
    expectLinked(lit);
    const [, v2] = one(lit, "WanVaceToVideo");
    const ref = lit[(v2.inputs.reference_image as [string, number])[0]];
    expect(ref.class_type).toBe("ImageFromBatch");
    expect(ref.inputs).toMatchObject({ batch_index: 0, length: 1 });
    expect(lit[(v2.inputs.negative as [string, number])[0]].inputs.text).toBe(
      VACE_RELIGHT_NEGATIVE,
    );
  });

  it("tool card: Look/Relight pickers, presets satisfy the prompt", () => {
    const rs = getActionTool("vace_restyle")!;
    expect(rs.text?.required).toBe(false);
    const keys = rs.pickers!.map((p) => p.key);
    expect(keys).toEqual(["look", "light", "speed"]);
    const lookPicker = rs.pickers![0];
    expect(lookPicker.options[0].id).toBe("none");
    expect(lookPicker.options).toHaveLength(38);
    expect(lookPicker.dropdown).toBe(true);
    // "none" first, then one contiguous dropdown section per look group
    expect(groupOptions(lookPicker.options).map((g) => g.group)).toEqual([
      "",
      ...VACE_LOOK_GROUPS,
    ]);
    for (const g of VACE_LOOK_GROUPS)
      expect(
        VACE_LOOK_PRESETS.filter((p) => p.group === g).length,
      ).toBeGreaterThanOrEqual(4);
    expect(rs.pickers![1].options).toHaveLength(9);
    expect(
      buildActionRequest(
        rs,
        { ...defaultSettings(rs), picks: { look: "pixel_art" } },
        null,
      ).params,
    ).toEqual({ speed: "balanced", look: "pixel_art" });
    expect(
      buildActionRequest(
        rs,
        {
          ...defaultSettings(rs),
          text: "rainy street",
          picks: { light: "neon_night", speed: "fast" },
        },
        null,
      ).params,
    ).toEqual({ speed: "fast", prompt: "rainy street", light: "neon_night" });
  });
});
