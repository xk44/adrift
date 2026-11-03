import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import pipelineNodes from "./fixtures/pipelineNodes.objectInfo.json";
import dubNodes from "./fixtures/dubNodes.objectInfo.json";
import chatterboxNodes from "./fixtures/chatterboxNodes.objectInfo.json";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import { getPack } from "@/lib/oj/packs";
import {
  VOICE_CHANGE_ACTION,
  VOICE_CHANGE_VIDEO_ACTION,
  buildVoiceChangeVideoWorkflow,
  buildVoiceChangeWorkflow,
} from "@/lib/oj/voiceChange";
import {
  DUB_VOICE_CHATTERBOX_ACTION,
  buildDubVoiceChatterboxWorkflow,
} from "@/lib/oj/dubVideo";
import {
  VOICE_CHANGE_FPS,
  VOICE_CHANGE_MAX_AUDIO_SECONDS,
  VOICE_CHANGE_MAX_VIDEO_SECONDS,
  VOICE_CHANGE_TARGET_REF_SECONDS,
  voiceChangeCfg,
  voiceChangeSpan,
  voiceChangeSteps,
} from "@/lib/tools/voiceChanger";
import {
  runVoiceChange,
  type VoiceChangeInputs,
} from "@/lib/tools/voiceChangerRunner";
import {
  CHATTERBOX_DUB_LANGS,
  DUB_CHATTERBOX_REF_SECONDS,
  DUB_DEFAULT_ENGINE,
  DUB_LANGUAGES,
  dubEngineSupports,
  dubResolveEngine,
  initialDub,
} from "@/lib/tools/dubVideo";
import { runDub, type DubDeps, type DubInputs } from "@/lib/tools/dubRunner";
import { VOICE_CHANGER_KEY, voiceChangerCard } from "@/lib/tools/pipelineCards";
import { buildHubCards } from "@/lib/tools/hub";
import type { RunnerDeps } from "@/lib/tools/pipelineRunner";
import type { EngineContext } from "@/lib/tools/templates";

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<
    string,
    { template: string; requiresImage?: boolean; group?: string }
  >;
};
const load = (action: string): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(PACKS, reg.templates[reg.actions[action].template].file),
      "utf8",
    ),
  ) as Workflow;

type InputSpec = [unknown, Record<string, unknown>?];
const OBJECT_INFO = {
  ...pipelineNodes,
  ...dubNodes,
  ...chatterboxNodes,
} as Record<string, unknown>;
const INFO = OBJECT_INFO as unknown as Record<
  string,
  { input: Record<string, Record<string, InputSpec>>; output: string[] }
>;

function options(spec: InputSpec): string[] | null {
  if (Array.isArray(spec[0])) return spec[0] as string[];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options))
    return spec[1]!.options as string[];
  return null;
}

/** object_info check: classes, declared inputs, combo values, links, required. */
function validate(wf: Workflow): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    const info = INFO[node.class_type];
    if (!info) {
      errors.push(`${id}: unknown class ${node.class_type}`);
      continue;
    }
    const all = {
      ...info.input.required,
      ...info.input.optional,
      ...info.input.hidden,
    };
    for (const [key, value] of Object.entries(node.inputs)) {
      const spec = all[key];
      if (!spec) {
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
        continue;
      }
      if (Array.isArray(value)) {
        if (typeof value[0] === "string" && !wf[value[0]])
          errors.push(`${id}.${key}: link to missing node ${value[0]}`);
        continue;
      }
      const opts = options(spec);
      if (
        opts &&
        key !== "audio" &&
        key !== "video" &&
        !opts.includes(String(value))
      )
        errors.push(`${id}.${key}: ${String(value)} not in options`);
      const range = spec[1] as { min?: number; max?: number } | undefined;
      if (typeof value === "number" && range) {
        if (typeof range.min === "number" && value < range.min)
          errors.push(`${id}.${key}: ${value} < ${range.min}`);
        if (typeof range.max === "number" && value > range.max)
          errors.push(`${id}.${key}: ${value} > ${range.max}`);
      }
    }
    for (const req of Object.keys(info.input.required ?? {})) {
      if (!(req in node.inputs)) errors.push(`${id}: missing required ${req}`);
    }
  }
  return errors;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );

const clipRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1920,
    height: 1080,
    createdAt: "2026-10-25T00:00:00Z",
    status: "done",
    params: { video_seconds: 9.5 },
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [
          "http://127.0.0.1:8188/view?filename=talk.mp4&subfolder=&type=input",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const textRun = (): ImagineRun =>
  ({
    ...clipRun(),
    params: {},
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images: [] }],
  }) as unknown as ImagineRun;

describe("voice changer plan", () => {
  it("maps knobs to ChatterboxVC values with safe fallbacks", () => {
    expect(voiceChangeSteps("fast")).toBe(10);
    expect(voiceChangeSteps("best")).toBe(25);
    expect(voiceChangeSteps("nope")).toBe(10);
    expect(voiceChangeCfg("natural")).toBe(0.5);
    expect(voiceChangeCfg("strong")).toBe(1.0);
    expect(voiceChangeCfg(undefined)).toBe(0.7);
  });

  it("caps the converted span per source", () => {
    expect(voiceChangeSpan("audio", 45)).toBe(45);
    expect(voiceChangeSpan("audio", 600)).toBe(VOICE_CHANGE_MAX_AUDIO_SECONDS);
    expect(voiceChangeSpan("video", 90)).toBe(VOICE_CHANGE_MAX_VIDEO_SECONDS);
    expect(voiceChangeSpan("video", null)).toBe(VOICE_CHANGE_MAX_VIDEO_SECONDS);
    expect(voiceChangeSpan("audio", 0.1)).toBe(0.5);
  });
});

describe("voice changer actions", () => {
  const ACTIONS = [
    [
      VOICE_CHANGE_ACTION,
      buildVoiceChangeWorkflow,
      "packs/audio/voice_change.json",
    ],
    [
      VOICE_CHANGE_VIDEO_ACTION,
      buildVoiceChangeVideoWorkflow,
      "packs/audio/voice_change_video.json",
    ],
    [
      DUB_VOICE_CHATTERBOX_ACTION,
      buildDubVoiceChatterboxWorkflow,
      "packs/audio/dub_voice_chatterbox.json",
    ],
  ] as const;

  it("are registered with builders, templates and the audio pack", () => {
    const audio = getPack("audio");
    for (const [action, builder, file] of ACTIONS) {
      expect(reg.actions[action]?.requiresImage).toBe(false);
      expect(reg.actions[action]?.group).toBe("audio");
      expect(reg.templates[reg.actions[action].template].file).toBe(file);
      expect(actionBuilderFor(action)).toBe(builder);
      expect(audio?.workflows[action]).toBe(file);
    }
    expect(VIDEO_INPUT_ACTIONS.has(VOICE_CHANGE_VIDEO_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(DUB_VOICE_CHATTERBOX_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(VOICE_CHANGE_ACTION)).toBe(false);
  });

  it("templates are valid as shipped and pin the local model pack", () => {
    for (const [action] of ACTIONS) {
      const wf = load(action);
      expect(validate(wf), action).toEqual([]);
      expect(missingAgainstObjectInfo(wf, OBJECT_INFO), action).toEqual([]);
      const tts = [
        ...byClass(wf, "ChatterboxVC"),
        ...byClass(wf, "ChatterboxMTLTTS"),
      ];
      expect(tts).toHaveLength(1);
      expect(tts[0][1].inputs.model_pack_name).toBe("chatterbox_local");
      expect(tts[0][1].inputs.use_watermark).toBe(false);
    }
  });

  it("voice_change converts the uploaded speech toward the target sample", () => {
    const { workflow, slots } = buildVoiceChangeWorkflow(
      load(VOICE_CHANGE_ACTION),
      textRun(),
      0,
      {
        sourceAudioRef: "speech.wav [input]",
        audioRef: "target.mp3 [input]",
        seconds: 42,
        quality: "best",
        match: "strong",
      },
    );
    expect(validate(workflow)).toEqual([]);
    const [[vcId, vc]] = byClass(workflow, "ChatterboxVC");
    expect(vc.inputs.n_timesteps).toBe(25);
    expect(vc.inputs.flow_cfg_scale).toBe(1.0);
    const srcTrim = workflow[(vc.inputs.source_audio as [string, number])[0]];
    expect(srcTrim.inputs.duration).toBe(42);
    expect(
      workflow[(srcTrim.inputs.audio as [string, number])[0]].inputs.audio,
    ).toBe("speech.wav [input]");
    const tgtTrim =
      workflow[(vc.inputs.target_voice_audio as [string, number])[0]];
    expect(tgtTrim.inputs.duration).toBe(VOICE_CHANGE_TARGET_REF_SECONDS);
    expect(
      workflow[(tgtTrim.inputs.audio as [string, number])[0]].inputs.audio,
    ).toBe("target.mp3 [input]");
    expect(slots.ksamplerId).toBe(vcId);
    const [[, save]] = byClass(workflow, "SaveAudioMP3");
    expect(save.inputs.audio).toEqual([vcId, 0]);
  });

  it("without a target sample the built-in voice is used", () => {
    const { workflow } = buildVoiceChangeWorkflow(
      load(VOICE_CHANGE_ACTION),
      textRun(),
      0,
      { sourceAudioRef: "speech.wav [input]" },
    );
    expect(validate(workflow)).toEqual([]);
    const [[, vc]] = byClass(workflow, "ChatterboxVC");
    expect(vc.inputs.target_voice_audio).toBeUndefined();
    expect(byClass(workflow, "LoadAudio")).toHaveLength(1);
    expect(byClass(workflow, "TrimAudioDuration")).toHaveLength(1);
    expect(vc.inputs.n_timesteps).toBe(10);
    expect(vc.inputs.flow_cfg_scale).toBe(0.7);
    // Default span = the cap.
    const [[, trim]] = byClass(workflow, "TrimAudioDuration");
    expect(trim.inputs.duration).toBe(VOICE_CHANGE_MAX_AUDIO_SECONDS);
  });

  it("rejects missing or unsafe refs", () => {
    const base = load(VOICE_CHANGE_ACTION);
    expect(() => buildVoiceChangeWorkflow(base, textRun(), 0, {})).toThrow(
      /sourceAudioRef/,
    );
    expect(() =>
      buildVoiceChangeWorkflow(base, textRun(), 0, {
        sourceAudioRef: "../secret.wav [input]",
      }),
    ).toThrow(/sourceAudioRef/);
    expect(() =>
      buildVoiceChangeWorkflow(base, textRun(), 0, {
        sourceAudioRef: "speech.wav [output]",
      }),
    ).toThrow(/sourceAudioRef/);
    expect(() =>
      buildVoiceChangeWorkflow(base, textRun(), 0, {
        sourceAudioRef: "speech.wav [input]",
        audioRef: "voice.mp3 [output]",
      }),
    ).toThrow(/audioRef/);
  });

  it("voice_change_video converts the clip's audio and remuxes it", () => {
    const { workflow } = buildVoiceChangeVideoWorkflow(
      load(VOICE_CHANGE_VIDEO_ACTION),
      clipRun(),
      0,
      { audioRef: "target.mp3 [input]", seconds: 12 },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const [[vcId, vc]] = byClass(workflow, "ChatterboxVC");
    const srcTrim = workflow[(vc.inputs.source_audio as [string, number])[0]];
    expect(srcTrim.inputs.duration).toBe(12);
    expect(
      workflow[(srcTrim.inputs.audio as [string, number])[0]].inputs.audio,
    ).toBe("talk.mp4 [input]");
    const [[, vhs]] = byClass(workflow, "VHS_LoadVideo");
    expect(vhs.inputs.video).toBe("talk.mp4 [input]");
    expect(vhs.inputs.force_rate).toBe(VOICE_CHANGE_FPS);
    expect(vhs.inputs.frame_load_cap).toBe(12 * VOICE_CHANGE_FPS);
    // 1920x1080 is over the 1280 long-edge cap.
    expect(vhs.inputs.custom_width).toBe(1280);
    const [[, create]] = byClass(workflow, "CreateVideo");
    expect(create.inputs.audio).toEqual([vcId, 0]);
    expect(create.inputs.fps).toBe(VOICE_CHANGE_FPS);
    expect(byClass(workflow, "SaveVideo")).toHaveLength(1);
  });

  it("voice_change_video falls back to the clip length, capped", () => {
    const { workflow } = buildVoiceChangeVideoWorkflow(
      load(VOICE_CHANGE_VIDEO_ACTION),
      clipRun({ params: { video_seconds: 75 } } as Partial<ImagineRun>),
      0,
      {},
    );
    const [[, vc]] = byClass(workflow, "ChatterboxVC");
    expect(vc.inputs.target_voice_audio).toBeUndefined();
    const srcTrim = workflow[(vc.inputs.source_audio as [string, number])[0]];
    expect(srcTrim.inputs.duration).toBe(VOICE_CHANGE_MAX_VIDEO_SECONDS);
    const [[, vhs]] = byClass(workflow, "VHS_LoadVideo");
    expect(vhs.inputs.frame_load_cap).toBe(
      VOICE_CHANGE_MAX_VIDEO_SECONDS * VOICE_CHANGE_FPS,
    );
    expect(() =>
      buildVoiceChangeVideoWorkflow(
        load(VOICE_CHANGE_VIDEO_ACTION),
        textRun(),
        0,
        {},
      ),
    ).toThrow(/no video/);
  });
});

describe("dub voice: Chatterbox engine", () => {
  it("supported languages are a subset of the dub targets", () => {
    const ids = new Set(DUB_LANGUAGES.map((l) => l.id));
    for (const l of CHATTERBOX_DUB_LANGS) expect(ids.has(l)).toBe(true);
    const info = chatterboxNodes.ChatterboxMTLTTS.input.required
      .language[1] as {
      options: string[];
    };
    for (const l of CHATTERBOX_DUB_LANGS) expect(info.options).toContain(l);
    for (const l of ["uk", "id", "vi"]) {
      expect(dubEngineSupports("chatterbox", l)).toBe(false);
      expect(dubEngineSupports("vibevoice", l)).toBe(true);
    }
    expect(DUB_DEFAULT_ENGINE).toBe("auto");
  });

  it("builds the clone graph in the target language", () => {
    const { workflow, seed } = buildDubVoiceChatterboxWorkflow(
      load(DUB_VOICE_CHATTERBOX_ACTION),
      clipRun(),
      0,
      { text: "  El farero\n saluda. ", language: "es", seed: 0 },
    );
    expect(validate(workflow)).toEqual([]);
    expect(seed).toBe(1);
    const [[, tts]] = byClass(workflow, "ChatterboxMTLTTS");
    expect(tts.inputs.text).toBe("El farero saluda.");
    expect(tts.inputs.language).toBe("es");
    expect(tts.inputs.seed).toBe(1);
    expect(tts.inputs.model_version).toBe("t3_mtl23ls_v3.safetensors");
    expect(tts.inputs.crash_protection_template).toBe("");
    const trim = workflow[(tts.inputs.audio_prompt as [string, number])[0]];
    expect(trim.class_type).toBe("TrimAudioDuration");
    expect(trim.inputs.duration).toBe(DUB_CHATTERBOX_REF_SECONDS);
    const [[, load1]] = byClass(workflow, "LoadAudio");
    expect(load1.inputs.audio).toBe("talk.mp4 [input]");
  });

  it("clone: false drops the clip reference (stock conds.pt voice)", () => {
    const { workflow } = buildDubVoiceChatterboxWorkflow(
      load(DUB_VOICE_CHATTERBOX_ACTION),
      clipRun(),
      0,
      { text: "Bonjour.", language: "fr", clone: false, seed: 3 },
    );
    expect(validate(workflow)).toEqual([]);
    const [[, tts]] = byClass(workflow, "ChatterboxMTLTTS");
    expect(tts.inputs).not.toHaveProperty("audio_prompt");
    expect(tts.inputs.language).toBe("fr");
    expect(byClass(workflow, "LoadAudio")).toHaveLength(0);
    expect(byClass(workflow, "TrimAudioDuration")).toHaveLength(0);
    expect(byClass(workflow, "SaveAudioMP3")).toHaveLength(1);
    expect(() =>
      buildDubVoiceChatterboxWorkflow(
        load(DUB_VOICE_CHATTERBOX_ACTION),
        clipRun(),
        0,
        { text: "Bonjour.", language: "fr", clone: "no" },
      ),
    ).toThrow(/clone/);
  });

  it("refuses unsupported languages and empty scripts", () => {
    const base = load(DUB_VOICE_CHATTERBOX_ACTION);
    expect(() =>
      buildDubVoiceChatterboxWorkflow(base, clipRun(), 0, {
        text: "Привіт",
        language: "uk",
      }),
    ).toThrow(/cannot speak/);
    expect(() =>
      buildDubVoiceChatterboxWorkflow(base, clipRun(), 0, {
        text: " ",
        language: "es",
      }),
    ).toThrow(/translate/);
  });
});

// ---------------------------------------------------------------------------
// Runners (mock fetch)
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function server() {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const kindOf = new Map<string, string>();
  let n = 0;
  const file = (name: string, sub: string) => ({
    filename: name,
    subfolder: sub,
    type: "output",
    url: `/api/comfy/image?filename=${name}&subfolder=${sub}&type=output`,
  });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({ url, body });
    if (url === "/api/comfy/upload")
      return json({
        ref: `up${++n}${String(body?.filename).slice(-4)} [input]`,
      });
    if (url === "/api/jobs/seed-run")
      return json({ run: { run_id: `seed${++n}`, jobs: [{ index: 0 }] } });
    if (url === "/api/jobs/action") {
      const kind = String(body!.action);
      const pid = `p-${kind}-${++n}`;
      kindOf.set(pid, kind);
      return json({
        run: { run_id: `${kind}${n}`, jobs: [{ index: 0, prompt_id: pid }] },
      });
    }
    if (url.startsWith("/api/comfy/history/")) {
      const pid = decodeURIComponent(url.slice("/api/comfy/history/".length));
      const kind = kindOf.get(pid) ?? "";
      switch (kind) {
        case "dub_transcribe":
          return json({ ok: true, texts: [{ text: "Hello there." }] });
        case "dub_translate":
          return json({ ok: true, texts: [{ text: "Hola." }] });
        case "voice_change":
        case "dub_voice":
        case "dub_voice_chatterbox":
          return json({ ok: true, audios: [file(`${kind}.mp3`, "audio")] });
        case "voice_change_video":
          return json({
            ok: true,
            audios: [file("adrift_vc_1.mp3", "audio")],
            videos: [file("adrift_vc_1.mp4", "video")],
          });
        default:
          return json({ ok: true, videos: [file(`${kind}.mp4`, "video")] });
      }
    }
    return json({ error: "unexpected" }, 500);
  });
  const actions = () =>
    calls
      .filter((c) => c.url === "/api/jobs/action")
      .map((c) => c.body as Record<string, unknown>);
  return { fetchImpl, calls, actions };
}

const deps = (fetchImpl: RunnerDeps["fetchImpl"]): RunnerDeps => ({
  fetchImpl,
  clientId: "c1",
  onRun: vi.fn(),
  measure: async () => 4.5,
  sleep: async () => {},
  pollMs: 0,
});

const audioFile = (label: string, duration: number | null = 8) => ({
  id: label,
  previewUrl: "blob:a",
  dataUrl: "data:audio/wav;base64,AAAA",
  label,
  duration,
});

const video = {
  id: "v1",
  previewUrl: "blob:v",
  dataUrl: "data:video/mp4;base64,AAAA",
  label: "talk.mp4",
  duration: 20,
  width: 1920,
  height: 1080,
};

describe("voice changer runner", () => {
  it("audio: uploads target + speech, seeds text-only, returns the MP3", async () => {
    const srv = server();
    const inputs: VoiceChangeInputs = {
      source: "audio",
      audio: audioFile("speech.wav", 200),
      target: audioFile("target.mp3"),
      quality: "best",
      match: "natural",
    };
    const res = await runVoiceChange(inputs, deps(srv.fetchImpl));
    expect(res.audio.url).toContain("voice_change.mp3");
    expect(res.audio.seconds).toBe(4.5);
    expect(res.video).toBeUndefined();
    const uploads = srv.calls.filter((c) => c.url === "/api/comfy/upload");
    expect(uploads).toHaveLength(2);
    const seed = srv.calls.find((c) => c.url === "/api/jobs/seed-run");
    expect(seed?.body?.text_only).toBe(true);
    const [act] = srv.actions();
    expect(act.action).toBe("voice_change");
    const params = act.params as Record<string, unknown>;
    expect(params.audioRef).toMatch(/\.mp3 \[input\]$/);
    expect(params.sourceAudioRef).toMatch(/\.wav \[input\]$/);
    expect(params.seconds).toBe(VOICE_CHANGE_MAX_AUDIO_SECONDS);
    expect(params.quality).toBe("best");
    expect(params.match).toBe("natural");
    // The params it sends build a valid graph.
    const built = buildVoiceChangeWorkflow(
      load(VOICE_CHANGE_ACTION),
      textRun(),
      0,
      params,
    );
    expect(validate(built.workflow)).toEqual([]);
  });

  it("video: seeds the clip and returns speech + remuxed clip", async () => {
    const srv = server();
    const res = await runVoiceChange(
      { source: "video", video },
      deps(srv.fetchImpl),
    );
    expect(res.video?.url).toContain("adrift_vc_1.mp4");
    expect(res.audio.url).toContain("adrift_vc_1.mp3");
    const uploads = srv.calls.filter((c) => c.url === "/api/comfy/upload");
    expect(uploads).toHaveLength(1);
    const seed = srv.calls.find((c) => c.url === "/api/jobs/seed-run");
    expect(seed?.body?.ref).toMatch(/\.mp4 \[input\]$/);
    const [act] = srv.actions();
    expect(act.action).toBe("voice_change_video");
    const params = act.params as Record<string, unknown>;
    expect(params.audioRef).toBeUndefined();
    expect(params.seconds).toBe(20);
  });

  it("refuses to run without the source", async () => {
    const srv = server();
    await expect(
      runVoiceChange({ source: "audio" }, deps(srv.fetchImpl)),
    ).rejects.toThrow(/speech/);
    await expect(
      runVoiceChange({ source: "video" }, deps(srv.fetchImpl)),
    ).rejects.toThrow(/clip/);
    expect(srv.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("dub runner engine picker", () => {
  const dubInputs = (over: Partial<DubInputs> = {}): DubInputs => ({
    video,
    mode: "audio",
    target: "es",
    source: "auto",
    seed: 7,
    ...over,
  });
  const dubDeps = (fetchImpl: DubDeps["fetchImpl"]): DubDeps => ({
    ...deps(fetchImpl),
    toDataUrl: async () => "data:audio/mpeg;base64,AAAA",
  });

  it("VibeVoice when picked", async () => {
    const srv = server();
    await runDub(
      initialDub("audio"),
      dubInputs({ engine: "vibevoice" }),
      dubDeps(srv.fetchImpl),
      () => {},
    );
    expect(srv.actions().map((a) => a.action)).toEqual([
      "dub_transcribe",
      "dub_translate",
      "dub_voice",
      "dub_mux",
    ]);
  });

  it("Chatterbox voices with dub_voice_chatterbox in the target language", async () => {
    const srv = server();
    const end = await runDub(
      initialDub("audio"),
      dubInputs({ engine: "chatterbox", target: "fr" }),
      dubDeps(srv.fetchImpl),
      () => {},
    );
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "dub_transcribe",
      "dub_translate",
      "dub_voice_chatterbox",
      "dub_mux",
    ]);
    const voice = acts[2].params as Record<string, unknown>;
    expect(voice).toMatchObject({ text: "Hola.", language: "fr", seed: 7 });
    expect(end.steps.voice.output?.url).toContain("dub_voice_chatterbox.mp3");
  });

  it("voice clone off uses the Chatterbox stock voice whatever the engine", async () => {
    expect(dubResolveEngine("vibevoice", "en", false)).toBe("chatterbox");
    const srv = server();
    const end = await runDub(
      initialDub("audio"),
      dubInputs({ engine: "vibevoice", target: "de", clone: false }),
      dubDeps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.voice.status).toBe("done");
    const voice = srv
      .actions()
      .find((a) => a.action === "dub_voice_chatterbox")!;
    expect(voice.params).toMatchObject({ language: "de", clone: false });
    const srv2 = server();
    const vi2 = await runDub(
      initialDub("audio"),
      dubInputs({ target: "vi", clone: false }),
      dubDeps(srv2.fetchImpl),
      () => {},
    );
    expect(vi2.steps.voice.status).toBe("error");
    expect(vi2.steps.voice.error).toMatch(/No stock voice speaks Vietnamese/);
  });

  it("Chatterbox fails the voice step for unsupported targets", async () => {
    const srv = server();
    const end = await runDub(
      initialDub("audio"),
      dubInputs({ engine: "chatterbox", target: "vi" }),
      dubDeps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.voice.status).toBe("error");
    expect(end.steps.voice.error).toMatch(/Chatterbox cannot speak Vietnamese/);
    expect(srv.actions().map((a) => a.action)).not.toContain(
      "dub_voice_chatterbox",
    );
  });
});

describe("voice changer hub card", () => {
  const ctx = (packs: string[] | null): EngineContext => ({
    catalog: packs ? [] : null,
    packIds: packs ? new Set(packs) : null,
    editLoras: null,
  });

  it("needs the audio pack and is commercial-safe", () => {
    expect(voiceChangerCard(ctx(null)).checking).toBe(true);
    expect(voiceChangerCard(ctx([])).available).toBe(false);
    expect(voiceChangerCard(ctx([])).unavailableReason).toBeTruthy();
    const card = voiceChangerCard(ctx(["audio"]));
    expect(card.available).toBe(true);
    expect(card.nc).toBe(false);
    expect(card.hubCategory).toBe("Audio");
    expect(card.icon).toBe("AudioWaveform");
  });

  it("is listed in the hub", () => {
    const cards = buildHubCards({ toolCards: [], ctx: ctx(["audio"]) });
    const card = cards.find((c) => c.key === VOICE_CHANGER_KEY);
    expect(card?.title).toBe("Voice Changer");
    expect(card?.aliases).toContain("speech to speech");
  });
});
