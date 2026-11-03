import { describe, expect, it } from "vitest";
import {
  AD_STYLES,
  ASSEMBLE_FPS,
  DEFAULT_CLIP_SECONDS,
  NARRATION_MAX_CHARS,
  SCENE_MAX_SECONDS,
  SCRIPT_SCENES,
  SHORTS_TONES,
  ScriptParseError,
  assembleParamsFor,
  clampScenes,
  dependencies,
  editScene,
  estimateSpeechSeconds,
  fileRef,
  initialState,
  invalidate,
  isSafeFileRef,
  nextRunnable,
  parseScript,
  parseStepId,
  planOrder,
  presetFor,
  progressOf,
  sceneSeconds,
  scriptPrompt,
  stepId,
  updateStep,
  withOptions,
  withScript,
  wrapCaption,
  AUDIO_EXT,
  VIDEO_EXT,
  type PipelineScript,
  type PipelineState,
} from "@/lib/tools/pipelines";

const SCRIPT: PipelineScript = {
  title: "Why the sky is blue",
  music: "soft piano, ambient",
  scenes: [
    {
      narration: "Sunlight is a mix of colours.",
      visual: "sunbeam through clouds",
      motion: "slow pan",
    },
    {
      narration: "Air scatters blue light the most.",
      visual: "tiny glowing particles",
      motion: "drift",
    },
    {
      narration: "So the whole sky glows blue.",
      visual: "wide blue sky over hills",
      motion: "push in",
    },
  ],
};

function doneAll(state: PipelineState): PipelineState {
  let s = state;
  for (const id of s.order) {
    const { kind, scene } = parseStepId(id);
    const ext =
      kind === "voice" || kind === "music"
        ? "mp3"
        : kind === "image"
          ? "png"
          : "mp4";
    s = updateStep(s, id, {
      status: "done",
      runId: `r-${id}`,
      output: {
        url: `/api/comfy/image?filename=${kind}${scene ?? ""}.${ext}`,
        ref: `${kind === "voice" || kind === "music" ? "audio" : "video"}/${kind}${scene ?? ""}.${ext} [output]`,
        seconds: kind === "voice" ? 2 : kind === "clip" ? 4.04 : null,
      },
    });
  }
  return s;
}

describe("pipeline presets", () => {
  it.each([
    ["shorts", SHORTS_TONES],
    ["ad", AD_STYLES],
  ] as const)("%s catalog is well-formed and original", (_k, list) => {
    expect(list.length).toBeGreaterThanOrEqual(3);
    const ids = new Set<string>();
    for (const p of list) {
      expect(p.id).toMatch(/^[a-z_]+$/);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.label.trim().length).toBeGreaterThan(1);
      expect(p.hint.length).toBeGreaterThan(10);
      expect(p.music.length).toBeGreaterThan(3);
      // No brand / platform / style-code data in preset copy.
      const text = `${p.label} ${p.hint} ${p.music}`.toLowerCase();
      for (const bad of [
        "higgsfield",
        "--sref",
        "tiktok",
        "nike",
        "apple",
      ]) {
        expect(text).not.toContain(bad);
      }
    }
  });

  it("presetFor falls back to the first preset", () => {
    expect(presetFor("shorts", "nope")).toBe(SHORTS_TONES[0]);
    expect(presetFor("ad", AD_STYLES[1].id)).toBe(AD_STYLES[1]);
  });

  it("clampScenes keeps the scene count in range", () => {
    expect(clampScenes(1)).toBe(SCRIPT_SCENES.min);
    expect(clampScenes(99)).toBe(SCRIPT_SCENES.max);
    expect(clampScenes("4")).toBe(4);
    expect(clampScenes("x")).toBe(SCRIPT_SCENES.default);
  });
});

describe("scriptPrompt", () => {
  it("shorts prompt carries topic, scene count, tone and JSON shape", () => {
    const p = scriptPrompt({
      kind: "shorts",
      topic: "how bees make honey",
      scenes: 4,
      preset: "facts",
    });
    expect(p).toContain("how bees make honey");
    expect(p).toContain("exactly 4 scenes");
    expect(p).toContain(presetFor("shorts", "facts").hint);
    expect(p).toMatch(/JSON only/);
    expect(p).toMatch(/no real people/);
  });

  it("ad prompt keeps the product and adds the presenter scene on request", () => {
    const plain = scriptPrompt({
      kind: "ad",
      topic: "a steel water bottle",
      scenes: 3,
      preset: "showcase",
    });
    expect(plain).toContain("product photo");
    expect(plain).toMatch(/keeps the product exactly/);
    expect(plain).not.toMatch(/presenter/);
    const ugc = scriptPrompt({
      kind: "ad",
      topic: "",
      scenes: 3,
      preset: "ugc",
      presenter: true,
    });
    expect(ugc).toMatch(/original,\s+fictional person/);
  });

  it("caps the topic length", () => {
    const p = scriptPrompt({
      kind: "shorts",
      topic: "a".repeat(5000),
      scenes: 3,
      preset: "story",
    });
    expect(p.length).toBeLessThan(3000);
  });
});

describe("parseScript", () => {
  it("parses fenced JSON after a think block", () => {
    const raw =
      "<think>planning...</think>\n```json\n" +
      JSON.stringify({ title: "T", music: "lofi", scenes: SCRIPT.scenes }) +
      "\n```";
    const s = parseScript(raw);
    expect(s.title).toBe("T");
    expect(s.music).toBe("lofi");
    expect(s.scenes).toHaveLength(3);
    expect(s.scenes[1].motion).toBe("drift");
  });

  it("repairs trailing commas and accepts alias keys", () => {
    const raw =
      'Sure! {"title":"Ad","shots":[{"voiceover":"Meet the bottle.","image_prompt":"on a desk","camera":"orbit"},],}';
    const s = parseScript(raw, { fallbackMusic: "upbeat" });
    expect(s.scenes).toEqual([
      { narration: "Meet the bottle.", visual: "on a desk", motion: "orbit" },
    ]);
    expect(s.music).toBe("upbeat");
  });

  it("uses narration as the visual when none is given and trims to maxScenes", () => {
    const scenes = Array.from({ length: 6 }, (_, i) => ({
      narration: `Line number ${i}`,
    }));
    const s = parseScript(JSON.stringify({ scenes }), {
      maxScenes: 4,
      fallbackTitle: "Topic",
    });
    expect(s.scenes).toHaveLength(4);
    expect(s.scenes[0].visual).toBe("Line number 0");
    expect(s.title).toBe("Topic");
  });

  it("falls back to numbered lines", () => {
    const s = parseScript(
      "1. A lighthouse on a stormy cliff\n2. Waves crash against the rocks below",
    );
    expect(s.scenes).toHaveLength(2);
    expect(s.scenes[1].narration).toBe("Waves crash against the rocks below");
  });

  it("clamps field lengths", () => {
    const s = parseScript(
      JSON.stringify({ scenes: [{ narration: "x".repeat(900), visual: "v" }] }),
    );
    expect(s.scenes[0].narration.length).toBe(NARRATION_MAX_CHARS);
  });

  it("throws a ScriptParseError on garbage", () => {
    expect(() => parseScript("ok")).toThrow(ScriptParseError);
  });
});

describe("pipeline step model", () => {
  it("plans script first, then scenes by kind, music, assemble", () => {
    expect(planOrder(2, { kind: "shorts", music: true })).toEqual([
      "script",
      "image:0",
      "image:1",
      "voice:0",
      "voice:1",
      "clip:0",
      "clip:1",
      "music",
      "assemble",
    ]);
    expect(planOrder(1, { kind: "shorts", music: false })).not.toContain(
      "music",
    );
    expect(planOrder(0, { kind: "shorts" })).toEqual(["script"]);
  });

  it("presenter speaks on camera (no voice step); assemble waits for everything", () => {
    const opts = { kind: "ad" as const, presenter: true, music: true };
    const order = planOrder(2, opts);
    expect(order).not.toContain("voice:0");
    expect(dependencies("clip:0", order, opts)).toEqual(["image:0"]);
    expect(dependencies("clip:1", order, opts)).toEqual(["image:1"]);
    expect(dependencies("assemble", order, opts)).toEqual([
      "voice:1",
      "clip:0",
      "clip:1",
      "music",
    ]);
    expect(stepId("clip", 1)).toBe("clip:1");
    expect(parseStepId("voice:3")).toEqual({ kind: "voice", scene: 3 });
  });

  it("runs in order, skips failures and resumes after invalidate", () => {
    let s = withScript(initialState({ kind: "shorts", music: true }), SCRIPT);
    s = updateStep(s, "script", { status: "done" });
    expect(nextRunnable(s)).toBe("image:0");
    s = updateStep(s, "image:0", { status: "error", error: "boom" });
    expect(nextRunnable(s)).toBe("image:1");
    for (const id of [
      "image:1",
      "image:2",
      "voice:0",
      "voice:1",
      "voice:2",
      "clip:1",
      "clip:2",
      "music",
    ])
      s = updateStep(s, id, { status: "done" });
    // clip:0 and assemble are blocked by the failed image.
    expect(nextRunnable(s)).toBeNull();
    s = invalidate(s, "image:0");
    expect(s.steps["image:0"].status).toBe("idle");
    expect(nextRunnable(s)).toBe("image:0");
    expect(progressOf(s)).toEqual({ done: 9, total: 12 });
  });

  it("invalidate resets downstream steps only", () => {
    const s = invalidate(
      doneAll(
        withScript(initialState({ kind: "shorts", music: true }), SCRIPT),
      ),
      "image:1",
    );
    expect(s.steps["image:1"].status).toBe("idle");
    expect(s.steps["clip:1"].status).toBe("idle");
    expect(s.steps.assemble.status).toBe("idle");
    expect(s.steps["clip:0"].status).toBe("done");
    expect(s.steps["voice:1"].status).toBe("done");
    expect(s.steps["clip:1"].output).toBeUndefined();
  });

  it("editScene redoes only what used the changed field", () => {
    const base = doneAll(
      withScript(initialState({ kind: "shorts", music: true }), SCRIPT),
    );
    const narr = editScene(base, 0, { narration: "New line here." });
    expect(narr.script!.scenes[0].narration).toBe("New line here.");
    expect(narr.steps["voice:0"].status).toBe("idle");
    expect(narr.steps.assemble.status).toBe("idle");
    expect(narr.steps["image:0"].status).toBe("done");
    const motion = editScene(base, 1, { motion: "orbit" });
    expect(motion.steps["clip:1"].status).toBe("idle");
    expect(motion.steps["image:1"].status).toBe("done");
    const visual = editScene(base, 2, { visual: "a meadow" });
    expect(visual.steps["image:2"].status).toBe("idle");
    expect(visual.steps["clip:2"].status).toBe("idle");
    expect(
      editScene(base, 0, { narration: SCRIPT.scenes[0].narration }),
    ).toEqual(base);
  });

  it("withOptions toggles the music step and re-does the presenter image", () => {
    const base = doneAll(
      withScript(initialState({ kind: "ad", music: true }), SCRIPT),
    );
    const noMusic = withOptions(base, { kind: "ad", music: false });
    expect(noMusic.order).not.toContain("music");
    expect(noMusic.steps.assemble.status).toBe("idle");
    expect(noMusic.steps["clip:0"].status).toBe("done");
    const presenter = withOptions(base, {
      kind: "ad",
      music: true,
      presenter: true,
    });
    expect(presenter.steps["image:0"].status).toBe("idle");
    expect(presenter.steps["clip:0"].status).toBe("idle");
    expect(presenter.steps["image:1"].status).toBe("done");
  });
});

describe("pipeline timing + assembly params", () => {
  it("estimates speech and stretches scenes to the narration", () => {
    expect(
      estimateSpeechSeconds(
        "one two three four five six seven eight nine ten eleven twelve thirteen",
      ),
    ).toBe(5);
    expect(sceneSeconds(4, 2)).toBe(4);
    expect(sceneSeconds(4, 6)).toBe(6.35);
    expect(sceneSeconds(null, null)).toBe(DEFAULT_CLIP_SECONDS);
    expect(sceneSeconds(4, 60)).toBe(SCENE_MAX_SECONDS);
  });

  it("wraps captions and ellipsizes overflow", () => {
    expect(wrapCaption("a short line")).toBe("a short line");
    const w = wrapCaption(
      "one two three four five six seven eight nine ten",
      10,
      2,
    );
    expect(w.split("\n")).toHaveLength(2);
    expect(w.endsWith("...")).toBe(true);
  });

  it("collects refs, captions and lengths from finished steps", () => {
    const s = doneAll(
      withScript(initialState({ kind: "ad", music: true }), SCRIPT),
    );
    const p = assembleParamsFor(s, {
      size: "720x1280",
      captions: true,
      musicDb: -12,
    });
    expect(p.prefix).toBe("video/adrift_ad");
    expect(p.fps).toBe(ASSEMBLE_FPS);
    expect(p.music).toBe("audio/music.mp3 [output]");
    expect(p.musicDb).toBe(-12);
    expect(p.scenes[0]).toEqual({
      video: "video/clip0.mp4 [output]",
      audio: "audio/voice0.mp3 [output]",
      caption: SCRIPT.scenes[0].narration,
      clipSeconds: 4.04,
      seconds: 4.04,
      // Ad clips are LTX-2.5 with sound: product foley under the narration.
      clipAudioDb: -12,
    });
  });

  it("throws while a clip is missing", () => {
    const s = withScript(initialState({ kind: "shorts" }), SCRIPT);
    expect(() =>
      assembleParamsFor(s, { size: "720x1280", captions: true }),
    ).toThrow(/no clip/);
  });
});

describe("file refs", () => {
  it("builds refs from history entries and rejects traversal", () => {
    expect(
      fileRef({ filename: "a_00001_.mp4", subfolder: "video", type: "output" }),
    ).toBe("video/a_00001_.mp4 [output]");
    expect(fileRef({ filename: "a.mp3" })).toBe("a.mp3 [output]");
    expect(fileRef({ filename: "a.mp4", subfolder: "../etc" })).toBeNull();
    expect(fileRef({ filename: "a.exe" })).toBeNull();
    expect(fileRef({ filename: "a.mp4", type: "models" })).toBeNull();
  });

  it("validates refs by extension", () => {
    expect(isSafeFileRef("video/x.mp4 [output]", VIDEO_EXT)).toBe(true);
    expect(isSafeFileRef("video/x.mp4 [output]", AUDIO_EXT)).toBe(false);
    expect(isSafeFileRef("x.mp3 [input]", AUDIO_EXT)).toBe(true);
    expect(isSafeFileRef("../x.mp3 [input]", AUDIO_EXT)).toBe(false);
    expect(isSafeFileRef("x.mp3", AUDIO_EXT)).toBe(false);
    expect(isSafeFileRef(42)).toBe(false);
  });
});
