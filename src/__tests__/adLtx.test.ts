import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import pipelineNodes from "./fixtures/pipelineNodes.objectInfo.json";
import {
  AD_ASPECT,
  AD_CLIP_MAX_FRAMES,
  AD_CLIP_MIN_FRAMES,
  AD_PRODUCT_SOUND_DB,
  AD_PROMPT_MAX_CHARS,
  AD_SHOTS,
  adClipDims,
  adClipFrames,
  adClipLength,
  adClipParams,
  adClipPrompt,
  adShotPlan,
  adShotRole,
} from "@/lib/tools/adLtx";
import {
  LTX25_FPS,
  LTX25_MAX_LENGTH,
  LTX25_PACK_ID,
  ltx25Length,
} from "@/lib/oj/ltx25";
import { buildLtx25AnimateWorkflow } from "@/lib/oj/ltx25Tools";
import { buildPipelineAssembleWorkflow } from "@/lib/oj/pipelineAssemble";
import registry from "@/lib/oj/registry.json";
import {
  editScene,
  initialState,
  parseScript,
  scriptPrompt,
  updateStep,
  withScript,
} from "@/lib/tools/pipelines";

const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<string, { template: string }>;
};
const loadAction = (action: string): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "public/workflows",
        reg.templates[reg.actions[action].template].file,
      ),
      "utf8",
    ),
  ) as Workflow;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

describe("Click to Ad LTX frame math", () => {
  it("snaps every length up to the 8n+1 grid inside 3-8 s", () => {
    for (let s = 0.1; s <= 12; s += 0.13) {
      const f = adClipFrames(s);
      expect((f - 1) % 8).toBe(0);
      expect(ltx25Length(f)).toBe(f);
      expect(f).toBeGreaterThanOrEqual(AD_CLIP_MIN_FRAMES);
      expect(f).toBeLessThanOrEqual(AD_CLIP_MAX_FRAMES);
      expect(f).toBeLessThanOrEqual(LTX25_MAX_LENGTH);
      // Rounded up: the clip covers the requested time (until the cap).
      if (s <= 8) expect(f / LTX25_FPS).toBeGreaterThanOrEqual(s);
    }
    expect(AD_CLIP_MIN_FRAMES).toBe(3 * 24 + 1);
    expect(AD_CLIP_MAX_FRAMES).toBe(8 * 24 + 1);
    expect(adClipFrames(5)).toBe(121);
    expect(adClipFrames(5.01)).toBe(129);
    expect(adClipFrames(NaN)).toBe(97);
  });

  it("sizes clips from the narration (+ tail) or the shot default", () => {
    expect(adClipLength("hero", null)).toEqual({ frames: 121, seconds: 5.042 });
    expect(adClipLength("hook", undefined).frames).toBe(73);
    // 4.4 s narration + 0.35 s tail = 4.75 s -> 115 -> 121 frames.
    expect(adClipLength("lifestyle", 4.4).frames).toBe(121);
    expect(adClipLength("end", 30).frames).toBe(AD_CLIP_MAX_FRAMES);
  });

  it("vertical size is /32, ~0.9 MP and a 2x of a /32 first pass", () => {
    const d = adClipDims();
    expect(d).toEqual({
      width: 704,
      height: 1280,
      stageWidth: 352,
      stageHeight: 640,
    });
    for (const v of [d.width, d.height, d.stageWidth, d.stageHeight])
      expect(v % 32).toBe(0);
    expect(d.height).toBeGreaterThan(d.width);
    expect(d.width / d.height).toBeCloseTo(9 / 16, 1);
    const mp = d.width * d.height;
    expect(mp).toBeGreaterThan(0.8e6);
    expect(mp).toBeLessThanOrEqual(1024 * 1024);
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(1920);
  });
});

describe("Click to Ad shot plan + prompts", () => {
  it("orders hook, hero orbit, lifestyle, end card", () => {
    expect([0, 1, 2, 3].map((i) => adShotRole(i, 4))).toEqual([
      "hook",
      "hero",
      "lifestyle",
      "end",
    ]);
    expect([0, 1, 2].map((i) => adShotRole(i, 3))).toEqual([
      "hook",
      "hero",
      "end",
    ]);
    expect(adShotRole(4, 6)).toBe("lifestyle");
    expect(adShotPlan(4, false)).toHaveLength(4);
    expect(adShotPlan(3, true)[0]).toMatch(/presenter/);
  });

  it("writes one flowing paragraph: action, product lock, camera, light, sound", () => {
    for (const role of Object.keys(AD_SHOTS) as (keyof typeof AD_SHOTS)[]) {
      const p = adClipPrompt({ role, level: "animate_low" });
      expect(p).not.toMatch(/\n/);
      expect(p).toContain(AD_SHOTS[role].action);
      expect(p).toMatch(/keeps its exact shape, colours and label/);
      expect(p).toContain(AD_SHOTS[role].camera);
      expect(p).toMatch(/lighting and setting stay exactly/);
      expect(p).toContain(AD_SHOTS[role].sound);
      expect(p.split(/\s+/).length).toBeLessThanOrEqual(200);
      // Sentences are complete and present tense-ish (no imperative "Make").
      expect(p).toMatch(/\.$/);
    }
    expect(adClipPrompt({ role: "hero" })).toMatch(/half orbit/);
  });

  it("uses the script's motion + sound and skips the default camera when one is named", () => {
    const p = adClipPrompt({
      role: "lifestyle",
      motion: "Steam curls from the mug as the camera slowly pushes in",
      sound: "soft kettle hiss, a spoon clinking",
      level: "animate_high",
    });
    expect(p.startsWith("Steam curls from the mug")).toBe(true);
    expect(p).not.toContain(AD_SHOTS.lifestyle.camera);
    expect(p).toMatch(/sound design: soft kettle hiss, a spoon clinking\./);
    expect(p).toMatch(/bold and energetic/);
    const noCam = adClipPrompt({ role: "hook", motion: "Bubbles rise" });
    expect(noCam).toContain(AD_SHOTS.hook.camera);
  });

  it("presenter scene speaks the narration as quoted dialogue", () => {
    const p = adClipPrompt({
      role: "hook",
      presenter: true,
      narration: 'I never leave home without "this" bottle',
    });
    expect(p).toMatch(/They say: "I never leave home without this bottle\."/);
    expect(p).toMatch(/close-mic voice/);
  });

  it("strips parser syntax and caps the prompt", () => {
    const p = adClipPrompt({
      role: "hero",
      motion: `spin --ar 1:1 :: ${"x ".repeat(800)}`,
    });
    expect(p).not.toMatch(/--|::/);
    expect(p.length).toBeLessThanOrEqual(AD_PROMPT_MAX_CHARS);
  });

  it("action params always target the LTX-2.5 pack, vertical", () => {
    const params = adClipParams({ role: "end", speechSeconds: 2 });
    expect(params).toMatchObject({
      pack_id: LTX25_PACK_ID,
      ar: AD_ASPECT,
      frames: 73,
    });
  });
});

describe("Click to Ad script", () => {
  it("asks for the shot plan and a sound line per scene", () => {
    const p = scriptPrompt({
      kind: "ad",
      topic: "a ceramic pour-over coffee set",
      scenes: 4,
      preset: "showcase",
    });
    expect(p).toMatch(/Scene 1: a scroll-stopping hook/);
    expect(p).toMatch(/Scene 2: the product hero shot: a slow orbit/);
    expect(p).toMatch(/Scene 3: a lifestyle shot/);
    expect(p).toMatch(/Scene 4: the end card/);
    expect(p).toMatch(/sound: the shot's sound design/);
    expect(p).toContain('"sound": "..."');
  });

  it("parses the sound line and an edit re-renders only that clip", () => {
    const script = parseScript(
      JSON.stringify({
        title: "Pour",
        scenes: [
          {
            narration: "Slow mornings.",
            visual: "v1",
            motion: "m1",
            sfx: "drip",
          },
          { narration: "Better coffee.", visual: "v2", motion: "m2" },
        ],
      }),
    );
    expect(script.scenes[0].sound).toBe("drip");
    expect(script.scenes[1].sound).toBeUndefined();
    let s = withScript(initialState({ kind: "ad", music: false }), script);
    for (const id of s.order) s = updateStep(s, id, { status: "done" });
    const edited = editScene(s, 1, { sound: "cup set down on wood" });
    expect(edited.script!.scenes[1].sound).toBe("cup set down on wood");
    expect(edited.steps["clip:1"].status).toBe("idle");
    expect(edited.steps["clip:0"].status).toBe("done");
    expect(edited.steps["voice:1"].status).toBe("done");
    expect(edited.steps.assemble.status).toBe("idle");
  });

  it("presenter narration edits redo the talking clip (LTX speaks it)", () => {
    const script = parseScript(
      JSON.stringify({
        scenes: [
          { narration: "Hi there friends.", visual: "v", motion: "m" },
          { narration: "Look closer.", visual: "v", motion: "m" },
        ],
      }),
    );
    let s = withScript(
      initialState({ kind: "ad", presenter: true, music: false }),
      script,
    );
    for (const id of s.order) s = updateStep(s, id, { status: "done" });
    const edited = editScene(s, 0, { narration: "Hello again." });
    expect(edited.steps["clip:0"].status).toBe("idle");
    expect(edited.steps["clip:1"].status).toBe("done");
  });
});

describe("LTX builder + assembly for the ad", () => {
  const square = {
    run_id: "p",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: "2026-10-24T00:00:00Z",
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: ["/api/comfy/view?filename=pack.png&subfolder=&type=output"],
      },
    ],
    params: {},
  } as unknown as ImagineRun;

  it("ltx25_animate honours ar=9:16 and the frame count, audio in sync", () => {
    const params = adClipParams({ role: "hero", speechSeconds: 3.1 });
    const { workflow } = buildLtx25AnimateWorkflow(
      loadAction("ltx25_animate"),
      square,
      0,
      params,
    );
    const [[, latent]] = byClass(workflow, "EmptyLTXVLatentVideo");
    const d = adClipDims();
    expect(latent.inputs).toMatchObject({
      width: d.stageWidth,
      height: d.stageHeight,
      length: params.frames,
    });
    const [[, audio]] = byClass(workflow, "LTXVEmptyLatentAudio");
    expect(audio.inputs).toMatchObject({
      frames_number: params.frames,
      frame_rate: 24,
    });
    const [[, unet]] = byClass(workflow, "UNETLoader");
    expect(String(unet.inputs.unet_name)).toMatch(/ltx-2\.5/);
    expect(byClass(workflow, "LTXVAudioVAEDecode")).toHaveLength(1);
    const [[, enc]] = byClass(workflow, "CLIPTextEncode");
    expect(enc.inputs.text).toBe(params.prompt);
  });

  it("without ar the clip still follows the source aspect", () => {
    const { workflow } = buildLtx25AnimateWorkflow(
      loadAction("ltx25_animate"),
      square,
      0,
      {},
    );
    const [[, latent]] = byClass(workflow, "EmptyLTXVLatentVideo");
    expect(latent.inputs.width).toBe(latent.inputs.height);
  });

  it("mixes each clip's LTX sound under the narration", () => {
    const { workflow } = buildPipelineAssembleWorkflow(
      loadAction("pipeline_assemble"),
      square,
      0,
      {
        scenes: [
          {
            video: "video/a.mp4 [output]",
            clipSeconds: 3.04,
            seconds: 3.04,
            clipAudioDb: 0,
          },
          {
            video: "video/b.mp4 [output]",
            audio: "audio/vo.mp3 [output]",
            clipSeconds: 5.04,
            seconds: 5.04,
            clipAudioDb: AD_PRODUCT_SOUND_DB,
          },
          { video: "video/c.mp4 [output]", clipSeconds: 3, seconds: 3 },
        ],
        captions: false,
        prefix: "video/adrift_ad",
      },
    );
    const merges = byClass(workflow, "AudioMerge");
    expect(merges).toHaveLength(2);
    const loads = byClass(workflow, "VHS_LoadVideo").map(([id]) => id);
    // Scene 1 (presenter): clip audio straight from VHS output 2.
    expect(merges[0][1].inputs.audio2).toEqual([loads[0], 2]);
    // Scene 2: clip audio lowered first.
    const vol = byClass(workflow, "AudioAdjustVolume");
    expect(vol).toHaveLength(1);
    expect(vol[0][1].inputs).toEqual({
      audio: [loads[1], 2],
      volume: AD_PRODUCT_SOUND_DB,
    });
    expect(merges[1][1].inputs.audio2).toEqual([vol[0][0], 0]);
    // Every link points at a real output slot of a known core/VHS class.
    const info = pipelineNodes as unknown as Record<
      string,
      { output: string[] }
    >;
    for (const [id, node] of Object.entries(workflow)) {
      if (id.startsWith("_")) continue;
      expect(info[node.class_type], node.class_type).toBeTruthy();
      for (const v of Object.values(node.inputs)) {
        if (!Array.isArray(v) || typeof v[0] !== "string") continue;
        const src = workflow[v[0]];
        expect(src, `${id} -> ${v[0]}`).toBeTruthy();
        expect(v[1]).toBeLessThan(info[src.class_type].output.length);
      }
    }
    expect(info.VHS_LoadVideo.output[2]).toBe("AUDIO");
  });
});
