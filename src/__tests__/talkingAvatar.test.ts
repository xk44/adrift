/**
 * wan-animate pack: "Talking avatar" (Wan2.2-S2V 14B, core nodes) — pure
 * builder over the real graph, length plan, pack/registry/tools wiring.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  TALK_CHUNK_LENGTH,
  TALK_FPS,
  TALK_MAX_CHUNKS,
  TALK_MAX_FRAMES,
  TALK_MAX_SECONDS,
  TALK_NODES as N,
  TALK_PROMPT,
  buildTalkingAvatarWorkflow,
  talkingAvatarDims,
  talkingAvatarPlan,
} from "@/lib/oj/talkingAvatar";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";

const WF_DIR = path.join(process.cwd(), "public/workflows");
const TALK: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(WF_DIR, "packs/wan-animate/talking_avatar.json"),
    "utf-8",
  ),
);

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

const view = (name: string) =>
  `http://127.0.0.1:8188/view?filename=${name}&subfolder=&type=input`;
const src = run({ images: [view("face.png")] });

const nodesOf = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

function linksResolve(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    if (id === "_meta") continue;
    for (const v of Object.values(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("talking_avatar graph", () => {
  it("uses the S2V unet, wav2vec2, Lightning LoRA and muxes the trimmed audio", () => {
    expect(nodesOf(TALK, "UNETLoader")[0][1].inputs.unet_name).toBe(
      "wan2.2_s2v_14B_fp8_scaled.safetensors",
    );
    expect(
      nodesOf(TALK, "AudioEncoderLoader")[0][1].inputs.audio_encoder_name,
    ).toBe("wav2vec2_large_english_fp16.safetensors");
    expect(TALK[N.lora].inputs.lora_name).toMatch(/Lightning.*4steps/);
    expect(TALK[N.mux].inputs.audio).toEqual([N.trim, 0]);
    expect(JSON.stringify(TALK)).not.toMatch(/\/Users\/|\/home\//);
    linksResolve(TALK);
  });

  it("is registered in the pack, registry, builders, tools and hub", () => {
    expect(getPack("wan-animate")?.workflows).toMatchObject({
      talking_avatar: "packs/wan-animate/talking_avatar.json",
    });
    expect(
      resolveWorkflow({
        templateOrAction: "talking_avatar",
        packId: "wan-animate",
      }).workflowPath,
    ).toMatch(/talking_avatar\.json$/);
    const r = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(r.templates.talking_avatar.file).toBe(
      "packs/wan-animate/talking_avatar.json",
    );
    expect(r.actions.talking_avatar).toMatchObject({
      template: "talking_avatar",
      requiresImage: true,
    });
    expect(ACTION_BUILDERS.talking_avatar).toBe(buildTalkingAvatarWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has("talking_avatar")).toBe(false);
    expect(getActionTool("talking_avatar")).toMatchObject({
      requiredPack: "wan-animate",
      audioInput: "Speech or song",
      modelCheck: { pack: "wan-animate", action: "talking_avatar" },
    });
    expect(CARD_OVERRIDES["action:talking_avatar"]).toBeDefined();
  });
});

describe("talkingAvatarPlan / dims", () => {
  it("follows the audio length, chunked by 5 s, capped", () => {
    expect(talkingAvatarPlan(undefined)).toEqual({
      frames: 77,
      chunks: 1,
      truncated: false,
    });
    expect(talkingAvatarPlan(3)).toEqual({
      frames: 48,
      chunks: 1,
      truncated: false,
    });
    expect(talkingAvatarPlan(4.8)).toMatchObject({ frames: 77, chunks: 1 });
    expect(talkingAvatarPlan(5)).toMatchObject({ frames: 80, chunks: 2 });
    expect(talkingAvatarPlan(9)).toMatchObject({ frames: 144, chunks: 2 });
    expect(talkingAvatarPlan(0.2).frames).toBe(16);
    expect(talkingAvatarPlan(60)).toEqual({
      frames: TALK_MAX_FRAMES,
      chunks: TALK_MAX_CHUNKS,
      truncated: true,
    });
    expect(TALK_MAX_FRAMES).toBe(237);
    expect(TALK_MAX_SECONDS).toBeCloseTo(14.81, 2);
  });

  it("keeps the photo aspect at ~640x640 on a /16 grid", () => {
    expect(talkingAvatarDims(1024, 1024)).toEqual({ width: 640, height: 640 });
    expect(talkingAvatarDims(480, 832)).toEqual({ width: 480, height: 848 });
    expect(talkingAvatarDims(100, 1000)).toEqual(talkingAvatarDims(9, 16));
    expect(talkingAvatarDims()).toEqual({ width: 640, height: 640 });
  });
});

describe("buildTalkingAvatarWorkflow", () => {
  it("wires photo, audio, prompt, dims and one fast chunk", () => {
    const { workflow, slots, seed } = buildTalkingAvatarWorkflow(TALK, src, 0, {
      audioRef: "speech.wav [input]",
      audio_seconds: 3,
      seed: 7,
    });
    expect(seed).toBe(7);
    expect(workflow[N.photo].inputs.image).toBe("face.png [input]");
    expect(workflow[N.audio].inputs.audio).toBe("speech.wav [input]");
    expect(workflow[N.pos].inputs.text).toBe(TALK_PROMPT);
    expect(workflow[N.s2v].inputs).toMatchObject({
      width: 480,
      height: 848,
      length: TALK_CHUNK_LENGTH,
    });
    expect(workflow[N.sampler].inputs).toMatchObject({
      steps: 4,
      cfg: 1,
      seed: 7,
    });
    expect(workflow[N.trim].inputs.duration).toBe(3);
    expect(workflow[N.frames].inputs).toMatchObject({
      batch_index: 3,
      length: 48,
    });
    expect(workflow[N.mux].inputs.fps).toBe(TALK_FPS);
    expect(nodesOf(workflow, "WanSoundImageToVideoExtend")).toHaveLength(0);
    expect(slots).toMatchObject({
      ksamplerId: N.sampler,
      imageInputId: N.photo,
    });
    linksResolve(workflow);
    // Base graph untouched.
    expect(TALK[N.photo].inputs.image).toBe("");
  });

  it("frames, audio trim and mux share the 16 fps S2V clock (no drift)", () => {
    for (const secs of [1.7, 4.04, 7.33, 11.9]) {
      const { workflow } = buildTalkingAvatarWorkflow(TALK, src, 0, {
        audioRef: "a.wav [input]",
        audio_seconds: secs,
      });
      const frames = workflow[N.frames].inputs.length as number;
      const fps = workflow[N.mux].inputs.fps as number;
      expect(fps).toBe(TALK_FPS);
      expect(frames).toBe(Math.ceil(secs * TALK_FPS));
      // duration is rounded to 0.01 s: well under one frame.
      expect(
        Math.abs(frames / fps - (workflow[N.trim].inputs.duration as number)),
      ).toBeLessThan(0.01);
    }
  });

  it("chains extend chunks for longer audio and decodes the full latent", () => {
    const { workflow } = buildTalkingAvatarWorkflow(TALK, src, 0, {
      audioRef: "song.mp3 [input]",
      audio_seconds: 12,
      prompt: "  a singer on stage ",
      seed: 100,
    });
    const ext = nodesOf(workflow, "WanSoundImageToVideoExtend");
    expect(ext).toHaveLength(2);
    const samplers = nodesOf(workflow, "KSampler");
    expect(samplers.map(([, n]) => n.inputs.seed).sort()).toEqual([
      100, 101, 102,
    ]);
    // Second extend continues from the first concat.
    const cats = nodesOf(workflow, "LatentConcat").filter(
      ([id]) => id !== N.concat,
    );
    expect(cats).toHaveLength(2);
    expect(ext[1][1].inputs.video_latent).toEqual([cats[0][0], 0]);
    expect(workflow[N.cut].inputs.samples).toEqual([cats[1][0], 0]);
    expect(workflow[N.concat].inputs.samples2).toEqual([cats[1][0], 0]);
    expect(workflow[N.frames].inputs.length).toBe(192);
    expect(workflow[N.trim].inputs.duration).toBe(12);
    expect(workflow[N.pos].inputs.text).toBe("a singer on stage");
    linksResolve(workflow);
  });

  it("quality mode drops the LoRA and samples 20 steps at CFG 6", () => {
    const { workflow } = buildTalkingAvatarWorkflow(TALK, src, 0, {
      audioRef: "a.wav [input]",
      mode: "quality",
    });
    expect(workflow[N.lora]).toBeUndefined();
    expect(workflow[N.shift].inputs.model).toEqual(["6", 0]);
    expect(workflow[N.sampler].inputs).toMatchObject({ steps: 20, cfg: 6 });
    linksResolve(workflow);
  });

  it("falls back to the seed-run audio and rejects missing/bad input", () => {
    const seeded = run({
      images: [view("face.png")],
      audios: [view("voice.wav")],
    });
    const { workflow } = buildTalkingAvatarWorkflow(TALK, seeded, 0, {});
    expect(workflow[N.audio].inputs.audio).toBe("voice.wav [input]");
    expect(() => buildTalkingAvatarWorkflow(TALK, src, 0, {})).toThrow(/audio/);
    expect(() =>
      buildTalkingAvatarWorkflow(TALK, src, 0, {
        audioRef: "../x.wav [input]",
      }),
    ).toThrow(/audioRef/);
    expect(() =>
      buildTalkingAvatarWorkflow(TALK, run({}), 0, {
        audioRef: "a.wav [input]",
      }),
    ).toThrow(/image/);
  });
});

describe("talking_avatar request", () => {
  it("maps audio, mode and scene text to builder params", () => {
    const spec = getActionTool("talking_avatar")!;
    const s = defaultSettings(spec);
    expect(
      buildActionRequest(spec, s, null, undefined, {
        ref: "a.wav [input]",
        seconds: 6.5,
      }),
    ).toEqual({
      action: "talking_avatar",
      params: {
        pack_id: "wan-animate",
        audioRef: "a.wav [input]",
        audio_seconds: 6.5,
        mode: "fast",
      },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        { ...s, text: "a singer", picks: { mode: "quality" } },
        null,
        undefined,
        { ref: "a.wav [input]" },
      ).params,
    ).toEqual({
      pack_id: "wan-animate",
      audioRef: "a.wav [input]",
      mode: "quality",
      prompt: "a singer",
    });
    expect(() => buildActionRequest(spec, s, null)).toThrow(ToolInputError);
  });
});
