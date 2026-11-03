/**
 * wan-animate pack: "Animate character" (Wan Animate 2 motion transfer) and
 * "Lipsync / talking photo" (InfiniteTalk) — pure builders, pack/registry
 * wiring, tool specs/requests, audio upload + seed-run legs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  WAN_ANIMATE_BG_MODEL,
  WAN_ANIMATE_DISTILL_UNET,
  WAN_ANIMATE_FULL_UNET,
  WAN_ANIMATE_LORA,
  WAN_ANIMATE_MAX_FRAMES,
  buildWanAnimateWorkflow,
  wanAnimateDims,
  wanAnimateMode,
  wanAnimatePrompt,
} from "@/lib/oj/wanAnimate";
import {
  LIPSYNC_FPS,
  LIPSYNC_MAX_FRAMES,
  LIPSYNC_MAX_SECONDS,
  buildLipsyncWorkflow,
  lipsyncDims,
  lipsyncPlan,
} from "@/lib/oj/lipsync";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import { isAudioFilename, parseInputRef } from "@/lib/seedRun";
import { safeUploadName, uploadMimeType } from "@/lib/comfy/uploadName";
import {
  ACTION_TOOLS,
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { audioUploadName, submitActionTool } from "@/lib/tools/runTool";

const WF_DIR = path.join(process.cwd(), "public/workflows");
const graph = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WF_DIR, rel), "utf-8"));
const WA = graph("packs/wan-animate/wan_animate.json");
const LIP = graph("packs/wan-animate/lipsync.json");

const view = (name: string) =>
  `http://127.0.0.1:8188/view?filename=${name}&subfolder=&type=input`;

function run(
  job: Partial<ImagineRun["jobs"][number]>,
  extra: Partial<ImagineRun> = {},
): ImagineRun {
  return {
    run_id: "r",
    prompt: "",
    parsedPrompt: "",
    width: 480,
    height: 832,
    createdAt: "",
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [], ...job },
    ],
    params: {},
    ...extra,
  } as ImagineRun;
}

const nodesOf = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

/** Every [id, slot] link points at an existing node. */
function linksResolve(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    if (id === "_meta") continue;
    for (const v of Object.values(node.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
        expect(wf[v[0]], `${id} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("wan-animate graphs", () => {
  it("use pc filenames, core nodes and no personal paths", () => {
    for (const g of [WA, LIP]) {
      const text = JSON.stringify(g);
      expect(text).not.toMatch(/\/Users\/|\/home\/|h3-relay/i);
      linksResolve(g);
    }
    expect(nodesOf(WA, "UNETLoader")[0][1].inputs.unet_name).toBe(
      WAN_ANIMATE_DISTILL_UNET,
    );
    expect(nodesOf(WA, "WanAnimate2Cache")).toHaveLength(1);
    expect(nodesOf(WA, "ContextWindowsManual")).toHaveLength(1);
    // No BiRefNet in the base graph: model-status must not require it.
    expect(nodesOf(WA, "LoadBackgroundRemovalModel")).toHaveLength(0);
    expect(nodesOf(LIP, "ModelPatchLoader")[0][1].inputs.name).toBe(
      "wan2.1_infiniteTalk_single_fp16.safetensors",
    );
    expect(nodesOf(LIP, "CreateVideo")[0][1].inputs.audio).toEqual(["3", 0]);
  });

  it("are registered in the pack, registry and action builders", () => {
    const pack = getPack("wan-animate");
    expect(pack?.workflows).toMatchObject({
      wan_animate: "packs/wan-animate/wan_animate.json",
      lipsync: "packs/wan-animate/lipsync.json",
    });
    expect(resolveWorkflow({ templateOrAction: "wan_animate", packId: "wan-animate" }).workflowPath).toMatch(
      /wan_animate\.json$/,
    );
    expect(resolveWorkflow({ templateOrAction: "lipsync", packId: "wan-animate" }).workflowPath).toMatch(/lipsync\.json$/);
    const r = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(r.templates.wan_animate.file).toBe(
      "packs/wan-animate/wan_animate.json",
    );
    expect(r.actions.lipsync.requiresImage).toBe(true);
    expect(r.actions.wan_animate.requiresImage).toBe(false);
    expect(ACTION_BUILDERS.wan_animate).toBe(buildWanAnimateWorkflow);
    expect(ACTION_BUILDERS.lipsync).toBe(buildLipsyncWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has("wan_animate")).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has("lipsync")).toBe(false);
  });
});

describe("buildWanAnimateWorkflow", () => {
  const src = run(
    { videos: [view("clip.mp4")] },
    { width: 1080, height: 1920 },
  );
  const params = { secondRefImage: "cj/robot.png [input]", seed: 7 };

  it("points the clip + character at the uploads and sizes from the clip", () => {
    const { workflow, seed } = buildWanAnimateWorkflow(WA, src, 0, params);
    expect(seed).toBe(7);
    expect(workflow["1"].inputs.file).toBe("clip.mp4 [input]");
    expect(workflow["7"].inputs.image).toBe("cj/robot.png [input]");
    expect(workflow["3"].inputs.length).toBe(WAN_ANIMATE_MAX_FRAMES);
    expect(workflow["22"].inputs).toMatchObject({ width: 480, height: 832 });
    expect(workflow["4"].inputs["resize_type.width"]).toBe(480);
    expect(workflow["8"].inputs["resize_type.height"]).toBe(832);
    expect(workflow["25"].inputs.noise_seed).toBe(7);
    expect(workflow["18"].inputs.unet_name).toBe(WAN_ANIMATE_DISTILL_UNET);
    expect(nodesOf(workflow, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(nodesOf(workflow, "RemoveBackground")).toHaveLength(0);
    linksResolve(workflow);
    // base graph untouched
    expect(WA["1"].inputs.file).toBe("");
  });

  it("speed=quality swaps to the full checkpoint + lightx2v at 6 steps", () => {
    const { workflow } = buildWanAnimateWorkflow(WA, src, 0, {
      ...params,
      speed: "quality",
    });
    expect(workflow["18"].inputs.unet_name).toBe(WAN_ANIMATE_FULL_UNET);
    const [[loraId, lora]] = nodesOf(workflow, "LoraLoaderModelOnly");
    expect(lora.inputs).toMatchObject({
      model: ["18", 0],
      lora_name: WAN_ANIMATE_LORA,
    });
    expect(workflow["19"].inputs.model).toEqual([loraId, 0]);
    expect(workflow["24"].inputs.steps).toBe(6);
    linksResolve(workflow);
  });

  it("mode=replace composites a BiRefNet matte over the source frames", () => {
    const { workflow } = buildWanAnimateWorkflow(WA, src, 0, {
      ...params,
      mode: "replace",
    });
    expect(
      nodesOf(workflow, "LoadBackgroundRemovalModel")[0][1].inputs
        .bg_removal_name,
    ).toBe(WAN_ANIMATE_BG_MODEL);
    const [[compId, comp]] = nodesOf(workflow, "ImageCompositeMasked");
    expect(comp.inputs.source).toEqual(["28", 0]);
    const dest = workflow[(comp.inputs.destination as [string, number])[0]];
    expect(dest.inputs.image).toEqual(["4", 0]);
    expect(workflow["29"].inputs.images).toEqual([compId, 0]);
    linksResolve(workflow);
  });

  it("puts an optional character description into the prompt", () => {
    const { workflow } = buildWanAnimateWorkflow(WA, src, 0, {
      ...params,
      character: "a teal robot",
    });
    expect(workflow["14"].inputs.text).toContain("a teal robot");
    expect(wanAnimatePrompt()).toContain(
      "the character in the reference image",
    );
  });

  it("rejects missing clip / character and graph drift", () => {
    expect(() => buildWanAnimateWorkflow(WA, run({}), 0, params)).toThrow(
      /no video/,
    );
    expect(() => buildWanAnimateWorkflow(WA, src, 0, {})).toThrow(
      /secondRefImage/,
    );
    const broken = structuredClone(WA);
    broken["22"].class_type = "KSampler";
    expect(() => buildWanAnimateWorkflow(broken, src, 0, params)).toThrow(
      /out of sync/,
    );
  });

  it("dims and mode helpers", () => {
    expect(wanAnimateDims(1920, 1080)).toEqual({ width: 832, height: 480 });
    expect(wanAnimateDims(480, 832)).toEqual({ width: 480, height: 832 });
    expect(wanAnimateDims(1000, 1000)).toEqual({ width: 480, height: 480 });
    expect(wanAnimateMode("replace")).toBe("replace");
    expect(wanAnimateMode("nope")).toBe("animate");
  });
});

describe("buildLipsyncWorkflow", () => {
  const src = run({ images: [view("face.png")] }, { width: 768, height: 1024 });

  it("plans frames/segments from the speech length (capped)", () => {
    expect(lipsyncPlan(3)).toEqual({
      frames: 75,
      segments: 1,
      truncated: false,
    });
    expect(lipsyncPlan(6.8)).toEqual({
      frames: 170,
      segments: 3,
      truncated: false,
    });
    expect(lipsyncPlan(undefined)).toMatchObject({ frames: 81, segments: 1 });
    expect(lipsyncPlan(0.1).frames).toBe(25);
    expect(lipsyncPlan(60)).toEqual({
      frames: LIPSYNC_MAX_FRAMES,
      segments: 5,
      truncated: true,
    });
    expect(LIPSYNC_MAX_FRAMES).toBe(369);
    expect(LIPSYNC_MAX_SECONDS).toBeCloseTo(14.76);
  });

  it("single pass: sets photo/audio/size and trims video + audio to the speech", () => {
    const { workflow } = buildLipsyncWorkflow(LIP, src, 0, {
      audioRef: "cj/hi.wav [input]",
      audio_seconds: 2,
      seed: 3,
    });
    expect(workflow["1"].inputs.image).toBe("face.png [input]");
    expect(workflow["2"].inputs.audio).toBe("cj/hi.wav [input]");
    expect(workflow["16"].inputs).toMatchObject({
      width: 480,
      height: 640,
      length: 81,
    });
    expect(workflow["19"].inputs.noise_seed).toBe(3);
    expect(workflow["23"].inputs).toMatchObject({
      image: ["22", 0],
      length: 50,
    });
    expect(workflow["3"].inputs.duration).toBe(2);
    expect(workflow["24"].inputs).toMatchObject({
      fps: LIPSYNC_FPS,
      audio: ["3", 0],
    });
    expect(nodesOf(workflow, "WanInfiniteTalkToVideo")).toHaveLength(1);
  });

  it("chains extra passes with previous_frames for longer speech", () => {
    const { workflow } = buildLipsyncWorkflow(LIP, src, 0, {
      audioRef: "a.wav [input]",
      audio_seconds: 6.8,
    });
    const talks = nodesOf(workflow, "WanInfiniteTalkToVideo");
    expect(talks).toHaveLength(3);
    const [, second] = talks[1];
    expect(second.inputs.previous_frames).toEqual(["22", 0]);
    expect(second.inputs.model).toEqual(["8", 0]);
    const [, third] = talks[2];
    const prev =
      workflow[(third.inputs.previous_frames as [string, number])[0]];
    expect(prev.class_type).toBe("ImageBatch");
    const drops = nodesOf(workflow, "ImageFromBatch").filter(([, n]) =>
      Array.isArray(n.inputs.batch_index),
    );
    expect(drops).toHaveLength(2);
    expect(workflow["23"].inputs.length).toBe(170);
    expect(workflow["3"].inputs.duration).toBe(6.8);
    linksResolve(workflow);
  });

  it("falls back to the seeded job audio; errors without speech", () => {
    const seeded = run(
      { images: [view("face.png")], audios: [view("speech.mp3")] },
      { params: { audio_seconds: 4 } },
    );
    const { workflow } = buildLipsyncWorkflow(LIP, seeded, 0, {});
    expect(workflow["2"].inputs.audio).toBe("speech.mp3 [input]");
    expect(workflow["23"].inputs.length).toBe(100);
    expect(() => buildLipsyncWorkflow(LIP, src, 0, {})).toThrow(/speech/);
    expect(() =>
      buildLipsyncWorkflow(LIP, src, 0, { audioRef: "../x.wav [input]" }),
    ).toThrow(/audioRef/);
    expect(() =>
      buildLipsyncWorkflow(LIP, run({}), 0, { audioRef: "a.wav [input]" }),
    ).toThrow(/no image/);
  });

  it("frames, speech trim and mux share the 25 fps clock (no drift)", () => {
    // InfiniteTalk's audio windows are 25 fps-native; the photo has no rate
    // of its own, so video length = frames / 25 must equal the trimmed speech.
    for (const secs of [1.7, 4.04, 7.33, 11.9]) {
      const { workflow } = buildLipsyncWorkflow(LIP, src, 0, {
        audioRef: "a.wav [input]",
        audio_seconds: secs,
      });
      const frames = workflow["23"].inputs.length as number;
      const fps = workflow["24"].inputs.fps as number;
      expect(fps).toBe(LIPSYNC_FPS);
      expect(frames).toBe(Math.ceil(secs * LIPSYNC_FPS));
      expect(
        Math.abs(frames / fps - (workflow["3"].inputs.duration as number)),
      ).toBeLessThan(1e-9);
    }
  });

  it("dims follow the photo aspect", () => {
    expect(lipsyncDims(1024, 1024)).toEqual({ width: 480, height: 480 });
    expect(lipsyncDims(1920, 1080)).toEqual({ width: 832, height: 480 });
  });
});

describe("tool specs + requests", () => {
  it("sits next to character_swap, with model checks", () => {
    const ids = ACTION_TOOLS.map((t) => t.id);
    expect(ids.indexOf("wan_animate")).toBe(ids.indexOf("character_swap") + 1);
    expect(getActionTool("wan_animate")).toMatchObject({
      videoInput: "Motion clip",
      secondImage: "Character photo",
      modelCheck: { pack: "wan-animate", action: "wan_animate" },
    });
    expect(getActionTool("lipsync")).toMatchObject({
      audioInput: "Speech audio",
      modelCheck: { pack: "wan-animate", action: "lipsync" },
    });
  });

  it("maps pickers/text to builder params", () => {
    const wa = getActionTool("wan_animate")!;
    const s = defaultSettings(wa);
    expect(buildActionRequest(wa, s, null, "c.png [input]")).toEqual({
      action: "wan_animate",
      params: {
        pack_id: "wan-animate",
        secondRefImage: "c.png [input]",
        mode: "animate",
        speed: "fast",
      },
      overrides: {},
    });
    const r = buildActionRequest(
      wa,
      { ...s, text: "robot", picks: { mode: "replace", speed: "quality" } },
      null,
      "c.png [input]",
    );
    expect(r.params).toMatchObject({
      mode: "replace",
      speed: "quality",
      character: "robot",
    });
    expect(() => buildActionRequest(wa, s, null)).toThrow(ToolInputError);

    const lip = getActionTool("lipsync")!;
    expect(
      buildActionRequest(lip, defaultSettings(lip), null, undefined, {
        ref: "a.wav [input]",
        seconds: 4.2,
      }).params,
    ).toEqual({
      pack_id: "wan-animate",
      audioRef: "a.wav [input]",
      audio_seconds: 4.2,
    });
    expect(() => buildActionRequest(lip, defaultSettings(lip), null)).toThrow(
      /speech/,
    );
  });

  it("submitActionTool uploads the audio and sends it to seed-run + action", async () => {
    const lip = getActionTool("lipsync")!;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      const json =
        url === "/api/comfy/upload"
          ? { ok: true, ref: `${body.filename} [input]` }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: { run_id: "R", jobs: [{ index: 0 }] } }
            : { ok: true, run: { run_id: "NEW", jobs: [] } };
      return { ok: true, status: 200, json: async () => json };
    });
    const image = {
      id: "p",
      source: "upload" as const,
      previewUrl: "data:image/png;base64,AA",
      dataUrl: "data:image/png;base64,AA",
      label: "p.png",
      width: 480,
      height: 640,
    };
    const audio = {
      id: "a",
      previewUrl: "data:audio/mpeg;base64,AA",
      dataUrl: "data:audio/mpeg;base64,AA",
      label: "speech.MP3",
      duration: 5.5,
    };
    await expect(
      submitActionTool({
        fetchImpl,
        spec: lip,
        settings: defaultSettings(lip),
        editLoras: null,
        image,
        secondImage: null,
        clientId: "c",
      }),
    ).rejects.toThrow(/speech audio/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const out = await submitActionTool({
      fetchImpl,
      spec: lip,
      settings: defaultSettings(lip),
      editLoras: null,
      image,
      secondImage: null,
      audio,
      clientId: "c",
    });
    expect(out.run_id).toBe("NEW");
    const [upAudio, upImage, seed, action] = calls;
    expect(upAudio.body.filename).toMatch(/^cj_audio_.*\.mp3$/);
    expect(upImage.url).toBe("/api/comfy/upload");
    expect(seed.body).toMatchObject({
      audio: `${upAudio.body.filename} [input]`,
      audio_duration: 5.5,
    });
    expect(action.body).toMatchObject({
      action: "lipsync",
      params: {
        audioRef: `${upAudio.body.filename} [input]`,
        audio_seconds: 5.5,
      },
    });
  });
});

describe("audio uploads", () => {
  it("names, MIME types and input refs", () => {
    expect(safeUploadName("my voice.m4a")).toBe("my_voice.m4a");
    expect(safeUploadName("x.ogg")).toBe("cj_ref.png");
    expect(uploadMimeType("a.wav")).toBe("audio/wav");
    expect(uploadMimeType("a.mp3")).toBe("audio/mpeg");
    expect(uploadMimeType("a.m4a")).toBe("audio/mp4");
    expect(uploadMimeType("a.flac")).toBe("audio/flac");
    expect(isAudioFilename("a.FLAC")).toBe(true);
    expect(parseInputRef("a.wav [input]")).toBeNull();
    expect(parseInputRef("cj/a.wav [input]", { allowAudio: true })).toEqual({
      filename: "a.wav",
      subfolder: "cj",
    });
    expect(audioUploadName("talk.flac")).toMatch(/^cj_audio_.*\.flac$/);
    expect(audioUploadName("noext")).toMatch(/\.wav$/);
  });
});

describe("POST /api/jobs/seed-run with audio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });
  const post = (body: unknown) =>
    new NextRequest("http://localhost:3000/api/jobs/seed-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("puts the speech in job.audios with its duration", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/jobs/seed-run/route");
    const { comfyImageRefFromViewUrl } = await import("@/lib/oj/engine");
    const res = await POST(
      post({
        ref: "p.png [input]",
        audio: "cj/s.wav [input]",
        audio_duration: 6.8,
      }),
    );
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.jobs[0].images).toHaveLength(1);
    expect(comfyImageRefFromViewUrl(run.jobs[0].audios[0])).toBe(
      "cj/s.wav [input]",
    );
    expect(run.params).toEqual({ seed_upload: true, audio_seconds: 6.8 });
    expect(
      (await POST(post({ ref: "p.png [input]", audio: "s.png [input]" })))
        .status,
    ).toBe(400);
    expect(
      (await POST(post({ ref: "p.png [input]", audio: "../s.wav [input]" })))
        .status,
    ).toBe(400);
    const plain = await (await POST(post({ ref: "p.png [input]" }))).json();
    expect(plain.run.jobs[0].audios).toBeUndefined();
  });
});
