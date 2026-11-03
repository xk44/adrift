import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { getPack } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import { TEXT_ONLY_ACTIONS } from "@/lib/oj/audioGen";
import { routeBackend } from "@/lib/comfy/backends";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  ADD_SOUND_DEFAULT_NEGATIVE,
  ADD_SOUND_MAX_SECONDS,
  addSoundSeconds,
  buildAddSoundWorkflow,
  buildVoiceoverWorkflow,
  VOICEOVER_DEFAULT_VOICE,
  VOICEOVER_KOKORO_DEFAULT_VOICE,
  VOICEOVER_KOKORO_NODE,
  VOICEOVER_KOKORO_VOICES,
  VOICEOVER_MAX_CHARS,
  VOICEOVER_STOCK_VOICES,
  stockVoiceLabel,
  voiceoverScript,
} from "@/lib/oj/voiceSound";
import {
  audioActive,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  pickerVisible,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { PLACEHOLDERS } from "@/lib/tools/templates";
import { textOnlySeedRun } from "@/lib/seedRun";
import { submitTextTool, type ToolAudio } from "@/lib/tools/runTool";

const PACKS = path.join(process.cwd(), "public/workflows/packs");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(PACKS, rel), "utf8")) as Workflow;

const VIEW = "http://h/view?filename=";
const clipRun = (seconds?: number): ImagineRun => ({
  run_id: "v1",
  prompt: "",
  parsedPrompt: "",
  width: 832,
  height: 480,
  createdAt: "2026-10-23T00:00:00Z",
  status: "done",
  jobs: [
    {
      seed: 0,
      index: 0,
      status: "done",
      progress: 100,
      images: [],
      videos: [`${VIEW}cj_clip_a.mp4&subfolder=&type=input`],
    },
  ],
  params: {
    seed_upload: true,
    ...(seconds !== undefined ? { video_seconds: seconds } : {}),
  },
});

function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && !wf[v[0]]) {
        out.push(`${id}.${key}->${v[0]}`);
      }
    }
  }
  return out;
}

describe("voiceover builder", () => {
  const base = load("audio/voiceover.json");
  const text = textOnlySeedRun("t1", "x");

  it("sets script, voice sample and seed", () => {
    const { workflow, seed } = buildVoiceoverWorkflow(base, text, 0, {
      script: "  Hello   there.\r\n\r\n\r\nSecond line. ",
      audioRef: "cj_audio_1.wav [input]",
      seed: 7,
    });
    expect(seed).toBe(7);
    expect(workflow["1"].inputs.audio).toBe("cj_audio_1.wav [input]");
    expect(workflow["2"].inputs.text).toBe("Hello there.\n\nSecond line.");
    expect(workflow["2"].inputs.seed).toBe(7);
    expect(workflow["2"].inputs.model_name).toBe("VibeVoice-1.5B");
    expect(workflow["2"].inputs.speaker_1_voice).toEqual(["1", 0]);
    expect(workflow["2"].inputs.voice_preset).toBe("None");
    expect(workflow["2"].inputs.cfg_scale).toBe(1.3);
    expect(workflow["3"].class_type).toBe("SaveAudioMP3");
    expect(danglingLinks(workflow)).toEqual([]);
    // base untouched
    expect(base["2"].inputs.text).toBe("");
    expect(base["2"].inputs.speaker_1_voice).toBeUndefined();
  });

  it("defaults to a stock voice: Realtime-0.5B, no LoadAudio", () => {
    expect(base["2"].inputs.model_name).toBe("VibeVoice-Realtime-0.5B");
    expect(base["2"].inputs.voice_preset).toBe(VOICEOVER_DEFAULT_VOICE);
    const { workflow, seed } = buildVoiceoverWorkflow(base, text, 0, {
      script: "Hello there.",
      seed: 3,
    });
    expect(seed).toBe(3);
    expect(workflow["1"]).toBeUndefined();
    expect(workflow["2"].inputs.model_name).toBe("VibeVoice-Realtime-0.5B");
    expect(workflow["2"].inputs.voice_preset).toBe("en-Emma_woman");
    expect(workflow["2"].inputs.cfg_scale).toBe(1.5);
    expect(workflow["2"].inputs.speaker_1_voice).toBeUndefined();
    expect(workflow["2"].inputs.text).toBe("Hello there.");
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("stock engine: picks the voice, ignores a sample, rejects unknown voices", () => {
    const { workflow } = buildVoiceoverWorkflow(base, text, 0, {
      script: "Hallo.",
      engine: "stock",
      voice: "de-Spk1_woman",
      audioRef: "a.wav [input]",
    });
    expect(workflow["2"].inputs.voice_preset).toBe("de-Spk1_woman");
    expect(workflow["1"]).toBeUndefined();
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, {
        script: "Hi.",
        engine: "stock",
        voice: "../evil",
      }),
    ).toThrow(/unknown stock voice/);
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, { script: "Hi.", engine: "x" }),
    ).toThrow(/unknown engine/);
  });

  it("kokoro engine: swaps node 2 to CJKokoroTTS, drops LoadAudio, clamps speed", () => {
    const { workflow, seed } = buildVoiceoverWorkflow(base, text, 0, {
      script: "Hello from Kokoro.",
      engine: "kokoro",
      voice: "bm_george",
      speed: 3,
      seed: 9,
      audioRef: "a.wav [input]",
    });
    expect(seed).toBe(9);
    expect(workflow["1"]).toBeUndefined();
    expect(workflow["2"].class_type).toBe(VOICEOVER_KOKORO_NODE);
    expect(workflow["2"].inputs).toEqual({
      text: "Hello from Kokoro.",
      voice: "bm_george",
      speed: 2,
    });
    expect(workflow["3"].inputs.audio).toEqual(["2", 0]);
    expect(danglingLinks(workflow)).toEqual([]);
    expect(base["2"].class_type).toBe("VibeVoiceTTS");
    const def = buildVoiceoverWorkflow(base, text, 0, {
      script: "Hi.",
      engine: "kokoro",
    }).workflow;
    expect(def["2"].inputs.voice).toBe(VOICEOVER_KOKORO_DEFAULT_VOICE);
    expect(def["2"].inputs.speed).toBe(1);
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, {
        script: "Hi.",
        engine: "kokoro",
        voice: "jf_alpha",
      }),
    ).toThrow(/unknown Kokoro voice/);
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, {
        script: "Hi.",
        engine: "kokoro",
        voice: "../x",
      }),
    ).toThrow(/unknown Kokoro voice/);
  });

  it("kokoro voices: 41 ids (no ja/zh), af_heart first, readable labels", () => {
    expect(VOICEOVER_KOKORO_VOICES).toHaveLength(41);
    expect(new Set(VOICEOVER_KOKORO_VOICES.map((v) => v.id)).size).toBe(41);
    expect(VOICEOVER_KOKORO_VOICES[0]).toEqual({
      id: "af_heart",
      label: "Heart (US English, woman)",
    });
    for (const v of VOICEOVER_KOKORO_VOICES) {
      expect(v.id).toMatch(/^[abefhip][fm]_[a-z]+$/);
      expect(v.label).not.toBe(v.id);
    }
  });

  it("stock voices: 25 Microsoft prompts, English first, readable labels", () => {
    expect(VOICEOVER_STOCK_VOICES).toHaveLength(25);
    expect(new Set(VOICEOVER_STOCK_VOICES.map((v) => v.id)).size).toBe(25);
    expect(VOICEOVER_STOCK_VOICES[0].id).toBe(VOICEOVER_DEFAULT_VOICE);
    expect(stockVoiceLabel("en-Emma_woman")).toBe("Emma (English, woman)");
    expect(stockVoiceLabel("de-Spk0_man")).toBe("Voice 1 (German, man)");
    expect(stockVoiceLabel("in-Samuel_man")).toBe(
      "Samuel (English, Indian, man)",
    );
    for (const v of VOICEOVER_STOCK_VOICES) {
      expect(v.id).toMatch(/^[a-z]{2}-[A-Za-z0-9]+_(man|woman)$/);
      expect(v.label).not.toBe(v.id);
    }
  });

  it("seed 0 becomes 1 (VibeVoice treats 0 as random)", () => {
    const { seed } = buildVoiceoverWorkflow(base, text, 0, {
      script: "Hi.",
      audioRef: "a.wav [input]",
      seed: 0,
    });
    expect(seed).toBe(1);
  });

  it("falls back to the job's audio, else requires a voice sample", () => {
    const withAudio: ImagineRun = {
      ...text,
      jobs: [
        { ...text.jobs[0], audios: [`${VIEW}voice.wav&subfolder=&type=input`] },
      ],
    };
    const { workflow } = buildVoiceoverWorkflow(base, withAudio, 0, {
      prompt: "Hi.",
    });
    expect(workflow["1"].inputs.audio).toBe("voice.wav [input]");
    expect(workflow["2"].inputs.model_name).toBe("VibeVoice-1.5B");
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, { script: "Hi.", engine: "clone" }),
    ).toThrow(/voice sample/);
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, {
        script: "Hi.",
        audioRef: "../etc/passwd [input]",
      }),
    ).toThrow(/audioRef/);
    expect(() =>
      buildVoiceoverWorkflow(base, text, 0, { audioRef: "a.wav [input]" }),
    ).toThrow(/script/);
  });

  it("caps the script length", () => {
    expect(voiceoverScript({ script: "a".repeat(5000) })).toHaveLength(
      VOICEOVER_MAX_CHARS,
    );
  });
});

describe("add_sound builder", () => {
  const base = load("audio/add_sound.json");

  it("uses the clip length for duration and frame cap", () => {
    const { workflow, seed } = buildAddSoundWorkflow(base, clipRun(4.04), 0, {
      prompt: "waves on rocks",
      seed: 11,
    });
    expect(seed).toBe(11);
    expect(workflow["1"].inputs.file).toBe("cj_clip_a.mp4 [input]");
    expect(workflow["4"].inputs.video).toBe("cj_clip_a.mp4 [input]");
    expect(workflow["2"].inputs.duration).toBe(4.04);
    expect(workflow["4"].inputs.frame_load_cap).toBe(101);
    expect(workflow["4"].inputs.force_rate).toBe(25);
    expect(workflow["7"].inputs.duration).toBe(4.04);
    expect(workflow["7"].inputs.prompt).toBe("waves on rocks");
    expect(workflow["7"].inputs.negative_prompt).toBe(
      ADD_SOUND_DEFAULT_NEGATIVE,
    );
    expect(workflow["7"].inputs.seed).toBe(11);
    expect(workflow["8"].inputs.audio).toEqual(["7", 0]);
    expect(workflow["8"].inputs.images).toEqual(["3", 0]);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("caps long / unknown clips and honours an explicit empty negative", () => {
    const long = buildAddSoundWorkflow(base, clipRun(42), 0, {
      negative_prompt: "",
    }).workflow;
    expect(long["7"].inputs.duration).toBe(ADD_SOUND_MAX_SECONDS);
    expect(long["4"].inputs.frame_load_cap).toBe(250);
    expect(long["7"].inputs.prompt).toBe("");
    expect(long["7"].inputs.negative_prompt).toBe("");
    expect(addSoundSeconds(undefined)).toBe(ADD_SOUND_MAX_SECONDS);
    expect(addSoundSeconds("3.5")).toBe(3.5);
  });

  it("needs a source clip", () => {
    const run = clipRun(3);
    run.jobs[0].videos = [];
    expect(() => buildAddSoundWorkflow(base, run, 0, {})).toThrow(/no video/);
  });
});

describe("wiring", () => {
  it.each([
    ["voiceover", "packs/audio/voiceover.json"],
    ["add_sound", "packs/audio/add_sound.json"],
  ])("%s", (action, rel) => {
    const actions = registry.actions as Record<
      string,
      { template: string; requiresImage?: boolean; group?: string }
    >;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[action].requiresImage).toBe(false);
    expect(actions[action].group).toBe("audio");
    expect(templates[actions[action].template].file).toBe(rel);
    expect(getPack("audio")?.workflows[action]).toBe(rel);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    vi.stubEnv("COMFY_VIDEO_HTTP_URL", "http://video:8188");
    try {
      expect(routeBackend({ action, workflowPath: rel })).toBe("video");
    } finally {
      vi.unstubAllEnvs();
    }
    const raw = fs.readFileSync(
      path.join(process.cwd(), "public/workflows", rel),
      "utf8",
    );
    expect(raw).not.toMatch(/\/Users\/|\/home\/|\/mnt\/|[A-Z]:\\\\/);
  });

  it("add_sound is clip-sourced, voiceover is text-only", () => {
    expect(VIDEO_INPUT_ACTIONS.has("add_sound")).toBe(true);
    expect(TEXT_ONLY_ACTIONS.has("voiceover")).toBe(true);
    expect(TEXT_ONLY_ACTIONS.has("add_sound")).toBe(false);
  });

  it("model check flags missing MMAudio weights from object_info", () => {
    const wf = load("audio/add_sound.json");
    const files = ["mmaudio_vae_44k_fp16.safetensors"];
    const info: Record<string, unknown> = {
      LoadVideo: {},
      "Video Slice": {},
      GetVideoComponents: {},
      VHS_LoadVideo: {},
      CreateVideo: {},
      SaveVideo: {},
      MMAudioSampler: {},
      MMAudioModelLoader: { input: { required: { mmaudio_model: [files] } } },
      MMAudioFeatureUtilsLoader: {
        input: {
          required: {
            vae_model: [files],
            synchformer_model: [files],
            clip_model: [files],
          },
        },
      },
    };
    expect(missingAgainstObjectInfo(wf, info)).toEqual([
      "mmaudio/mmaudio_large_44k_v2_fp16.safetensors",
      "mmaudio/mmaudio_synchformer_fp16.safetensors",
      "mmaudio/apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
    ]);
    delete info.MMAudioSampler;
    expect(missingAgainstObjectInfo(wf, info)).toContain("node:MMAudioSampler");
  });
});

describe("tools page + hub", () => {
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(),
    ...over,
  });

  it("voiceover request: stock voice by default, no sample needed", () => {
    const spec = getActionTool("voiceover")!;
    expect(spec.noSourceInput).toBe(true);
    const [engine, voice] = spec.pickers!;
    expect(engine.options.map((o) => o.id)).toEqual(["stock", "kokoro", "clone"]);
    expect(voice.dropdown).toBe(true);
    expect(voice.options).toHaveLength(VOICEOVER_STOCK_VOICES.length);
    expect(pickerVisible(voice, spec, settings())).toBe(true);
    expect(audioActive(spec, settings())).toBe(false);
    expect(() => buildActionRequest(spec, settings(), null)).toThrow(/script/i);
    expect(
      buildActionRequest(spec, settings({ text: "Hi there", seed: 5 }), null),
    ).toEqual({
      action: "voiceover",
      params: {
        pack_id: "audio",
        script: "Hi there",
        engine: "stock",
        voice: "en-Emma_woman",
        seed: 5,
      },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        settings({ text: "Hi", picks: { voice: "jp-Spk1_woman" } }),
        null,
      ).params.voice,
    ).toBe("jp-Spk1_woman");
  });

  it("voiceover request: kokoro engine sends its voice + pace", () => {
    const spec = getActionTool("voiceover")!;
    const kv = spec.pickers!.find((p) => p.key === "kokoro_voice")!;
    const pace = spec.pickers!.find((p) => p.key === "pace")!;
    expect(pickerVisible(kv, spec, settings())).toBe(false);
    const k = settings({ text: "Hi", picks: { engine: "kokoro" } });
    expect(pickerVisible(kv, spec, k)).toBe(true);
    expect(pickerVisible(pace, spec, k)).toBe(true);
    expect(audioActive(spec, k)).toBe(false);
    expect(buildActionRequest(spec, k, null)).toEqual({
      action: "voiceover",
      params: {
        pack_id: "audio",
        script: "Hi",
        engine: "kokoro",
        voice: "af_heart",
        speed: 1,
      },
      overrides: {},
    });
    const req = buildActionRequest(
      spec,
      settings({
        text: "Hi",
        picks: { engine: "kokoro", kokoro_voice: "ff_siwis", pace: "1.15" },
      }),
      null,
    );
    expect(req.params).toMatchObject({ voice: "ff_siwis", speed: 1.15 });
  });

  it("voiceover request: clone engine carries the voice sample", () => {
    const spec = getActionTool("voiceover")!;
    expect(spec.audioInput).toBe("Voice sample");
    expect(spec.audioNote).toMatch(/Lipsync/);
    const clone = (over: Partial<ToolSettings> = {}) =>
      settings({ picks: { engine: "clone" }, ...over });
    expect(audioActive(spec, clone())).toBe(true);
    expect(pickerVisible(spec.pickers![1], spec, clone())).toBe(false);
    expect(() =>
      buildActionRequest(spec, clone({ text: "Hi" }), null),
    ).toThrow(/voice sample/);
    expect(
      buildActionRequest(
        spec,
        clone({ text: "Hi there", seed: 5 }),
        null,
        undefined,
        { ref: "a.wav [input]" },
      ),
    ).toEqual({
      action: "voiceover",
      params: {
        pack_id: "audio",
        script: "Hi there",
        engine: "clone",
        audioRef: "a.wav [input]",
        seed: 5,
      },
      overrides: {},
    });
  });

  it("add_sound request: optional prompt + negative", () => {
    const spec = getActionTool("add_sound")!;
    expect(spec.videoInput).toBe("Silent clip");
    expect(buildActionRequest(spec, settings(), null).params).toEqual({
      pack_id: "audio",
    });
    expect(
      buildActionRequest(
        spec,
        settings({ text: "rain", secondText: "music" }),
        null,
      ).params,
    ).toEqual({ pack_id: "audio", prompt: "rain", negative_prompt: "music" });
  });

  it("hub cards: Audio section, add_sound is NC, placeholders retired", () => {
    expect(CARD_OVERRIDES["action:voiceover"]).toMatchObject({ hub: "Audio" });
    expect(CARD_OVERRIDES["action:add_sound"]).toMatchObject({
      hub: "Audio",
      nc: true,
    });
    expect(PLACEHOLDERS.map((p) => p.id)).not.toContain("voiceover");
    expect(PLACEHOLDERS.map((p) => p.id)).not.toContain("sound_fx");
  });

  it("submitTextTool uploads the voice sample, seeds a text run, queues voiceover", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, body });
      const payload =
        url === "/api/comfy/upload"
          ? { ok: true, ref: "cj_audio_x.wav [input]" }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: textOnlySeedRun("seed-1", body.prompt) }
            : {
                ok: true,
                run: { ...textOnlySeedRun("act-1", "x"), status: "queued" },
              };
      return { ok: true, status: 200, json: async () => payload };
    });
    const audio: ToolAudio = {
      id: "a",
      previewUrl: "blob:x",
      dataUrl: "data:audio/wav;base64,AAAA",
      label: "me.wav",
      duration: 6.5,
    };
    const spec = getActionTool("voiceover")!;
    const clone = settings({ text: "Hello", picks: { engine: "clone" } });
    await expect(
      submitTextTool({
        fetchImpl,
        spec,
        settings: clone,
        clientId: "c1",
      }),
    ).rejects.toThrow(/voice sample/);
    expect(calls).toHaveLength(0);
    const run = await submitTextTool({
      fetchImpl,
      spec,
      settings: clone,
      audio,
      clientId: "c1",
    });
    expect(run.run_id).toBe("act-1");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    expect(calls[0].body.filename).toMatch(/^cj_audio_.*\.wav$/);
    expect(calls[1].body).toEqual({ text_only: true, prompt: "Hello" });
    expect(calls[2].body).toMatchObject({
      run_id: "seed-1",
      action: "voiceover",
      params: {
        pack_id: "audio",
        script: "Hello",
        engine: "clone",
        audioRef: "cj_audio_x.wav [input]",
      },
    });
  });

  it("submitTextTool with a stock voice uploads nothing", async () => {
    const urls: string[] = [];
    let actionBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      urls.push(url);
      if (url === "/api/jobs/action") actionBody = body;
      const payload =
        url === "/api/jobs/seed-run"
          ? { ok: true, run: textOnlySeedRun("seed-2", body.prompt) }
          : { ok: true, run: { ...textOnlySeedRun("act-2", "x") } };
      return { ok: true, status: 200, json: async () => payload };
    });
    const run = await submitTextTool({
      fetchImpl,
      spec: getActionTool("voiceover")!,
      settings: settings({ text: "Hello", picks: { voice: "en-Carter_man" } }),
      // A leftover sample from the clone engine is ignored.
      audio: {
        id: "a",
        previewUrl: "blob:x",
        dataUrl: "data:audio/wav;base64,AAAA",
        label: "me.wav",
        duration: 6.5,
      },
      clientId: "c1",
    });
    expect(run.run_id).toBe("act-2");
    expect(urls).toEqual(["/api/jobs/seed-run", "/api/jobs/action"]);
    expect(actionBody.params).toEqual({
      pack_id: "audio",
      script: "Hello",
      engine: "stock",
      voice: "en-Carter_man",
    });
  });

  it("model check requires the stock voice prompt on the backend", () => {
    const wf = load("audio/voiceover.json");
    const info: Record<string, unknown> = {
      LoadAudio: {},
      SaveAudioMP3: {},
      VibeVoiceTTS: {
        input: {
          required: {
            model_name: [["VibeVoice-1.5B", "VibeVoice-Realtime-0.5B"]],
          },
          optional: { voice_preset: [["None", "en-Emma_woman"]] },
        },
      },
    };
    expect(missingAgainstObjectInfo(wf, info)).toEqual([]);
    (info.VibeVoiceTTS as { input: { optional: Record<string, unknown> } })
      .input.optional.voice_preset = [["None"]];
    expect(missingAgainstObjectInfo(wf, info)).toEqual([
      "tts/VibeVoice/voices/en-Emma_woman",
    ]);
  });
});
