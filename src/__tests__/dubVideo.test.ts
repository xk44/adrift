import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import pipelineNodes from "./fixtures/pipelineNodes.objectInfo.json";
import dubNodes from "./fixtures/dubNodes.objectInfo.json";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  DUB_MUX_ACTION,
  DUB_TRANSCRIBE_ACTION,
  DUB_TRANSLATE_ACTION,
  DUB_VOICE_ACTION,
  DUB_WHISPER_MODEL,
  buildDubMuxWorkflow,
  buildDubTranscribeWorkflow,
  buildDubTranslateWorkflow,
  buildDubVoiceWorkflow,
  dubSeconds,
} from "@/lib/oj/dubVideo";
import { VIDEO_LIPSYNC_MAX_SECONDS } from "@/lib/oj/videoLipsync";
import { getPack } from "@/lib/oj/packs";
import {
  CHATTERBOX_DUB_LANGS,
  DUB_AUDIO_MAX_SECONDS,
  DUB_BACKGROUND_KEEP_DEFAULT,
  DUB_BACKGROUND_MIN_DB,
  DUB_BACKGROUND_STORAGE_KEY,
  DUB_DEFAULT_ENGINE,
  DUB_LANGUAGES,
  DUB_LIPSYNC_MAX_SECONDS,
  DUB_MAX_CHARS,
  DUB_TRANSLATE_MAX_TOKENS,
  DUB_VOICE_REF_SECONDS,
  cleanTranslation,
  dubBackgroundDb,
  dubBackgroundFromPref,
  dubBackgroundLevel,
  dubCanRerun,
  dubInvalidate,
  dubNextRunnable,
  dubOrder,
  dubOverrunSeconds,
  dubProgress,
  dubResolveEngine,
  dubSpanSeconds,
  cleanSpeakerScript,
  dubIsSpeakerScript,
  dubSpeakerCount,
  dubSpeakerRefs,
  dubBestCopy,
  dubSpeechSegments,
  dubSpeakerScript,
  dubTranslatePrompt,
  dubUpdateStep,
  initialDub,
  lengthHint,
  parseTranscription,
  readDubBackground,
  withBackground,
  withTranscript,
  withTranslation,
  writeDubBackground,
  type DubState,
} from "@/lib/tools/dubVideo";
import { toolTitle } from "@/lib/tools/toolNames";
import {
  buildHubToolEntries,
  filterLightboxTools,
} from "@/lib/ui/lightboxTools";
import { runDub, type DubDeps, type DubInputs } from "@/lib/tools/dubRunner";
import {
  DUB_VIDEO_KEY,
  dubVideoCard,
  pipelineCards,
} from "@/lib/tools/pipelineCards";
import { buildHubCards } from "@/lib/tools/hub";
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
const OBJECT_INFO = { ...pipelineNodes, ...dubNodes } as Record<
  string,
  unknown
>;
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
      const spec = all[key.split(".")[0]];
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
      // File pickers (LoadAudio / VHS_LoadVideo) list host files; skip those.
      if (
        opts &&
        key !== "audio" &&
        key !== "video" &&
        !opts.includes(String(value))
      )
        errors.push(`${id}.${key}: ${String(value)} not in options`);
    }
    for (const req of Object.keys(info.input.required ?? {})) {
      if (
        !Object.keys(node.inputs).some(
          (k) => k === req || k.startsWith(`${req}.`),
        )
      )
        errors.push(`${id}: missing required ${req}`);
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

describe("dub video actions", () => {
  const ACTIONS = [
    [
      DUB_TRANSCRIBE_ACTION,
      buildDubTranscribeWorkflow,
      "packs/audio/dub_transcribe.json",
    ],
    [
      DUB_TRANSLATE_ACTION,
      buildDubTranslateWorkflow,
      "packs/pipeline/script.json",
    ],
    [DUB_VOICE_ACTION, buildDubVoiceWorkflow, "packs/audio/dub_voice.json"],
    [DUB_MUX_ACTION, buildDubMuxWorkflow, "packs/audio/dub_mux.json"],
  ] as const;

  it("are registered with builders and templates", () => {
    for (const [action, builder, file] of ACTIONS) {
      expect(reg.actions[action]?.requiresImage).toBe(false);
      expect(reg.actions[action]?.group).toBe("audio");
      expect(reg.templates[reg.actions[action].template].file).toBe(file);
      expect(actionBuilderFor(action)).toBe(builder);
    }
    expect(VIDEO_INPUT_ACTIONS.has(DUB_TRANSCRIBE_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(DUB_VOICE_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(DUB_MUX_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(DUB_TRANSLATE_ACTION)).toBe(false);
  });

  it("audio-pack graphs are listed in the audio pack (pc video host)", () => {
    const audio = getPack("audio");
    expect(audio?.workflows.dub_transcribe).toBe(
      "packs/audio/dub_transcribe.json",
    );
    expect(audio?.workflows.dub_voice).toBe("packs/audio/dub_voice.json");
    expect(audio?.workflows.dub_mux).toBe("packs/audio/dub_mux.json");
  });

  it("templates are valid as shipped", () => {
    for (const [action] of ACTIONS) {
      const wf = load(action);
      expect(validate(wf), action).toEqual([]);
    }
  });

  it("limits match the lipsync builder", () => {
    expect(DUB_LIPSYNC_MAX_SECONDS).toBe(VIDEO_LIPSYNC_MAX_SECONDS);
  });

  it("transcribe reads the clip's audio track and trims the span", () => {
    const { workflow } = buildDubTranscribeWorkflow(
      load(DUB_TRANSCRIBE_ACTION),
      clipRun(),
      0,
      { seconds: 12, language: "fr" },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const [[, load1]] = byClass(workflow, "LoadAudio");
    expect(load1.inputs.audio).toBe("talk.mp4 [input]");
    const [[, trim]] = byClass(workflow, "TrimAudioDuration");
    expect(trim.inputs.duration).toBe(12);
    const [[asrId, asr]] = byClass(workflow, "CJWhisperASR");
    expect(asr.inputs.language).toBe("french");
    expect(asr.inputs.task).toBe("transcribe");
    expect(asr.inputs.model_path).toBe(DUB_WHISPER_MODEL);
    expect(asr.inputs.keep_loaded).toBe(false);
    const sources = byClass(workflow, "PreviewAny").map(
      ([, n]) => n.inputs.source,
    );
    expect(sources).toEqual([
      [asrId, 0],
      [asrId, 1],
    ]);
  });

  it("transcribe defaults to auto + clip length, clamps, rejects junk", () => {
    const wf = buildDubTranscribeWorkflow(
      load(DUB_TRANSCRIBE_ACTION),
      clipRun(),
      0,
    ).workflow;
    expect(byClass(wf, "CJWhisperASR")[0][1].inputs.language).toBe("auto");
    expect(byClass(wf, "TrimAudioDuration")[0][1].inputs.duration).toBe(9.5);
    const long = buildDubTranscribeWorkflow(
      load(DUB_TRANSCRIBE_ACTION),
      clipRun(),
      0,
      {
        seconds: 999,
      },
    ).workflow;
    expect(byClass(long, "TrimAudioDuration")[0][1].inputs.duration).toBe(
      DUB_AUDIO_MAX_SECONDS,
    );
    expect(() =>
      buildDubTranscribeWorkflow(load(DUB_TRANSCRIBE_ACTION), clipRun(), 0, {
        language: "klingon",
      }),
    ).toThrow(/spoken language/);
    expect(() =>
      buildDubTranscribeWorkflow(load(DUB_TRANSCRIBE_ACTION), textRun(), 0),
    ).toThrow(/no video/);
  });

  it("every dub language maps to a Whisper option", () => {
    const opts = dubNodes.CJWhisperASR.input.optional.language[0] as string[];
    for (const l of DUB_LANGUAGES) expect(opts).toContain(l.whisper);
    expect(DUB_LANGUAGES).toHaveLength(25);
  });

  it("translate builds a text-only LLM graph with the length-matched prompt", () => {
    const { workflow, seed } = buildDubTranslateWorkflow(
      load(DUB_TRANSLATE_ACTION),
      textRun(),
      0,
      {
        transcript: "The lighthouse keeper waves at every passing boat.",
        target: "de",
        source: "en",
        seconds: 4.2,
        seed: 5,
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    expect(byClass(workflow, "LoadImage")).toHaveLength(0);
    const [[, gen]] = byClass(workflow, "TextGenerate");
    expect(gen.inputs.image).toBeUndefined();
    const prompt = String(gen.inputs.prompt);
    expect(prompt).toContain("into German");
    expect(prompt).toContain("Original (English):");
    expect(prompt).toContain("The lighthouse keeper waves");
    expect(prompt).toContain("about 4.2 seconds, 8 words");
    expect(gen.inputs.max_length).toBe(DUB_TRANSLATE_MAX_TOKENS);
    expect(gen.inputs["sampling_mode.seed"]).toBe(5);
    expect(seed).toBe(5);
  });

  it("translate rejects empty text and unknown languages", () => {
    const b = (p: Record<string, unknown>) =>
      buildDubTranslateWorkflow(load(DUB_TRANSLATE_ACTION), textRun(), 0, p);
    expect(() => b({ transcript: "", target: "es" })).toThrow(/empty/);
    expect(() => b({ transcript: "hi", target: "xx" })).toThrow(/target/);
    expect(() => b({ transcript: "hi", target: "es", source: "xx" })).toThrow(
      /source/,
    );
    expect(() =>
      b({ transcript: "hi", target: "es", source: "auto" }),
    ).not.toThrow();
  });

  it("voice clones the clip's own speaker with VibeVoice-1.5B", () => {
    const { workflow, seed } = buildDubVoiceWorkflow(
      load(DUB_VOICE_ACTION),
      clipRun(),
      0,
      { text: "  Hola a todos,\n bienvenidos. ", seed: 0 },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const [[, la]] = byClass(workflow, "LoadAudio");
    expect(la.inputs.audio).toBe("talk.mp4 [input]");
    const [[trimId, trim]] = byClass(workflow, "TrimAudioDuration");
    expect(trim.inputs.duration).toBe(DUB_VOICE_REF_SECONDS);
    const [[, tts]] = byClass(workflow, "VibeVoiceTTS");
    expect(tts.inputs.text).toBe("[1] Hola a todos, bienvenidos.");
    expect(tts.inputs.model_name).toBe("VibeVoice-1.5B");
    expect(tts.inputs.voice_preset).toBe("None");
    expect(tts.inputs.speaker_1_voice).toEqual([trimId, 0]);
    expect(seed).toBe(1);
    expect(byClass(workflow, "SaveAudioMP3")).toHaveLength(1);
    expect(() =>
      buildDubVoiceWorkflow(load(DUB_VOICE_ACTION), clipRun(), 0, {
        text: " ",
      }),
    ).toThrow(/translate/);
    const huge = buildDubVoiceWorkflow(load(DUB_VOICE_ACTION), clipRun(), 0, {
      text: "a".repeat(5000),
    }).workflow;
    expect(
      String(byClass(huge, "VibeVoiceTTS")[0][1].inputs.text).length,
    ).toBeLessThanOrEqual(DUB_MAX_CHARS + 4);
  });

  it("mux lays the uploaded speech over capped 25 fps frames", () => {
    const { workflow } = buildDubMuxWorkflow(
      load(DUB_MUX_ACTION),
      clipRun(),
      0,
      {
        audioRef: "dub_voice_x.mp3 [input]",
        seconds: 9.5,
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const [[vhsId, vhs]] = byClass(workflow, "VHS_LoadVideo");
    expect(vhs.inputs.video).toBe("talk.mp4 [input]");
    expect(vhs.inputs.force_rate).toBe(25);
    expect(vhs.inputs.frame_load_cap).toBe(238);
    expect(vhs.inputs.custom_width).toBe(1280);
    expect(vhs.inputs.custom_height).toBe(0);
    const [[laId, la]] = byClass(workflow, "LoadAudio");
    expect(la.inputs.audio).toBe("dub_voice_x.mp3 [input]");
    const [[, cv]] = byClass(workflow, "CreateVideo");
    expect(cv.inputs.images).toEqual([vhsId, 0]);
    expect(cv.inputs.audio).toEqual([laId, 0]);
    expect(cv.inputs.fps).toBe(25);
    expect(() =>
      buildDubMuxWorkflow(load(DUB_MUX_ACTION), clipRun(), 0, {
        audioRef: "voice.mp3 [output]",
      }),
    ).toThrow(/audioRef/);
    expect(() =>
      buildDubMuxWorkflow(load(DUB_MUX_ACTION), clipRun(), 0, {
        audioRef: "../x.mp3 [input]",
      }),
    ).toThrow(/audioRef/);
  });

  it("mux keeps the original audio under the speech when asked", () => {
    const { workflow } = buildDubMuxWorkflow(
      load(DUB_MUX_ACTION),
      clipRun(),
      0,
      {
        audioRef: "dub_voice_x.mp3 [input]",
        framesRef: "dub_lipsync_y.mp4 [input]",
        background_db: -12,
        seconds: 3.2,
      },
    );
    expect(validate(workflow)).toEqual([]);
    expect(missingAgainstObjectInfo(workflow, OBJECT_INFO)).toEqual([]);
    const [[, vhs]] = byClass(workflow, "VHS_LoadVideo");
    expect(vhs.inputs.video).toBe("dub_lipsync_y.mp4 [input]");
    expect(vhs.inputs.frame_load_cap).toBe(80);
    const loads = byClass(workflow, "LoadAudio");
    expect(loads.map(([, n]) => n.inputs.audio).sort()).toEqual([
      "dub_voice_x.mp3 [input]",
      "talk.mp4 [input]",
    ]);
    const speechId = loads.find(
      ([, n]) => n.inputs.audio === "dub_voice_x.mp3 [input]",
    )![0];
    const origId = loads.find(
      ([, n]) => n.inputs.audio === "talk.mp4 [input]",
    )![0];
    const [[trimId, trim]] = byClass(workflow, "TrimAudioDuration");
    expect(trim.inputs.audio).toEqual([origId, 0]);
    expect(trim.inputs.start_index).toBe(0);
    expect(trim.inputs.duration).toBe(3.2);
    const [[volId, vol]] = byClass(workflow, "AudioAdjustVolume");
    expect(vol.inputs.audio).toEqual([trimId, 0]);
    expect(vol.inputs.volume).toBe(-12);
    const [[mergeId, merge]] = byClass(workflow, "AudioMerge");
    // audio1 sets the length: the original span, so trailing room tone stays.
    expect(merge.inputs.audio1).toEqual([volId, 0]);
    expect(merge.inputs.audio2).toEqual([speechId, 0]);
    expect(merge.inputs.merge_method).toBe("add");
    const [[, cv]] = byClass(workflow, "CreateVideo");
    expect(cv.inputs.audio).toEqual([mergeId, 0]);
  });

  it("mux without a background drops the mix nodes; rejects bad refs and gains", () => {
    const { workflow } = buildDubMuxWorkflow(
      load(DUB_MUX_ACTION),
      clipRun(),
      0,
      { audioRef: "dub_voice_x.mp3 [input]", seconds: 4 },
    );
    for (const cls of ["AudioMerge", "AudioAdjustVolume", "TrimAudioDuration"])
      expect(byClass(workflow, cls)).toHaveLength(0);
    expect(byClass(workflow, "LoadAudio")).toHaveLength(1);
    const base = { audioRef: "dub_voice_x.mp3 [input]", seconds: 4 };
    for (const bad of [
      { background_db: 3 },
      { background_db: DUB_BACKGROUND_MIN_DB - 1 },
      { background_db: "loud" },
      { framesRef: "../x.mp4 [input]" },
      { framesRef: "x.mp4 [output]" },
    ])
      expect(() =>
        buildDubMuxWorkflow(load(DUB_MUX_ACTION), clipRun(), 0, {
          ...base,
          ...bad,
        }),
      ).toThrow(/background_db|framesRef/);
  });

  it("dubSeconds falls back to the lipsync span when the clip length is unknown", () => {
    expect(dubSeconds(clipRun({ params: {} } as Partial<ImagineRun>), {})).toBe(
      DUB_LIPSYNC_MAX_SECONDS,
    );
    expect(dubSeconds(clipRun(), { seconds: 0.2 })).toBe(1);
  });
});

describe("dub video planning", () => {
  it("flags speech that outlasts the dubbed span", () => {
    const voiced = (mode: "lipsync" | "audio", seconds: number) =>
      dubUpdateStep(initialDub(mode), "voice", {
        status: "done",
        output: { url: "u", ref: "audio/a.mp3 [output]", seconds },
      });
    expect(dubOverrunSeconds(initialDub("lipsync"), 10)).toBeNull();
    expect(dubOverrunSeconds(voiced("lipsync", 10.2), 10)).toBeNull();
    expect(dubOverrunSeconds(voiced("lipsync", 12.36), 10.56)).toBe(1.8);
    // The span is capped by the mode: a 20 s clip lipsyncs 14.76 s.
    expect(dubOverrunSeconds(voiced("lipsync", 16), 20)).toBe(1.2);
    expect(dubOverrunSeconds(voiced("audio", 16), 20)).toBeNull();
  });

  it("prompt counts words, or characters for CJK", () => {
    expect(lengthHint("one two  three")).toBe("3 words");
    expect(lengthHint("word")).toBe("1 word");
    expect(lengthHint("灯台守が手を振る")).toBe("8 characters");
    const p = dubTranslatePrompt({ transcript: "Good morning", target: "ja" });
    expect(p).toContain("into Japanese");
    expect(p).toContain("2 words");
    expect(p).toContain("Original:\nGood morning");
    expect(() =>
      dubTranslatePrompt({ transcript: "x", target: "zz" }),
    ).toThrow();
  });

  it("cleanTranslation strips thinking, fences, labels and quotes", () => {
    expect(cleanTranslation('<think>hmm</think>\n"Hola, mundo."')).toBe(
      "Hola, mundo.",
    );
    expect(cleanTranslation("```\nTranslation: Bonjour à tous\n```")).toBe(
      "Bonjour à tous",
    );
    expect(cleanTranslation("Translation (German): «Guten Tag»")).toBe(
      "Guten Tag",
    );
    expect(cleanTranslation("「こんにちは」")).toBe("こんにちは");
    expect(cleanTranslation("  line one\nline two ")).toBe("line one line two");
    expect(cleanTranslation("x".repeat(3000))).toHaveLength(DUB_MAX_CHARS);
  });

  it("parseTranscription accepts either output order", () => {
    const seg = JSON.stringify([
      { start: 0, end: 1.5, text: " Hello there." },
      { start: 1.5, end: 3, text: "Nice boat." },
      { start: "x", end: 1, text: "bad" },
    ]);
    const a = parseTranscription(["Hello there. Nice boat.", seg]);
    const b = parseTranscription([seg, "Hello there. Nice boat."]);
    expect(a).toEqual(b);
    expect(a.transcript).toBe("Hello there. Nice boat.");
    expect(a.segments).toHaveLength(2);
    expect(a.segments[0]).toEqual({ start: 0, end: 1.5, text: "Hello there." });
    expect(parseTranscription([seg]).transcript).toBe(
      "Hello there. Nice boat.",
    );
    expect(parseTranscription(["[laughs] hi", "[]"]).transcript).toBe(
      "[laughs] hi",
    );
    expect(parseTranscription(["", "[]"]).transcript).toBe("");
  });

  it("span is the clip length capped per mode", () => {
    expect(dubSpanSeconds("lipsync", 30)).toBe(14.76);
    expect(dubSpanSeconds("audio", 30)).toBe(30);
    expect(dubSpanSeconds("audio", 8.123)).toBe(8.12);
    expect(dubSpanSeconds("audio", null)).toBe(30);
  });

  it("step graph is linear and invalidation drops downstream text", () => {
    expect(dubOrder("lipsync")).toEqual([
      "transcribe",
      "translate",
      "voice",
      "lipsync",
    ]);
    expect(dubOrder("audio").at(-1)).toBe("mux");
    let s = initialDub("audio");
    expect(dubNextRunnable(s)).toBe("transcribe");
    expect(dubCanRerun(s, "voice")).toBe(false);
    s = {
      ...dubUpdateStep(s, "transcribe", { status: "done" }),
      transcript: "hi",
    };
    s = {
      ...dubUpdateStep(s, "translate", { status: "done" }),
      translation: "hola",
    };
    expect(dubNextRunnable(s)).toBe("voice");
    expect(dubProgress(s)).toEqual({ done: 2, total: 4 });
    s = dubUpdateStep(s, "voice", { status: "error", error: "x" });
    expect(dubNextRunnable(s)).toBeNull();
    const t = dubInvalidate(s, "translate");
    expect(t.transcript).toBe("hi");
    expect(t.translation).toBe("");
    expect(t.steps.voice.status).toBe("idle");
    expect(dubInvalidate(s, "transcribe").transcript).toBe("");
  });

  it("background level maps to a dB gain, 0 = replace", () => {
    expect(dubBackgroundDb(0)).toBeNull();
    expect(dubBackgroundDb(100)).toBe(0);
    expect(dubBackgroundDb(50)).toBe(-6);
    expect(dubBackgroundDb(25)).toBe(-12);
    expect(dubBackgroundDb(10)).toBe(-20);
    expect(dubBackgroundDb(1)).toBe(DUB_BACKGROUND_MIN_DB);
    expect(dubBackgroundLevel(-5)).toBe(0);
    expect(dubBackgroundLevel(150)).toBe(100);
    expect(dubBackgroundLevel(Number.NaN)).toBe(0);
    expect(dubBackgroundLevel("50")).toBe(0);
    expect(dubBackgroundLevel(12.6)).toBe(13);
  });

  it("lipsync adds a mix step only when the original audio is kept", () => {
    expect(dubOrder("lipsync", 25).at(-1)).toBe("mix");
    expect(dubOrder("lipsync", 0).at(-1)).toBe("lipsync");
    expect(dubOrder("audio", 25)).toEqual([
      "transcribe",
      "translate",
      "voice",
      "mux",
    ]);
    expect(initialDub("lipsync", 30).background).toBe(30);
    let s = initialDub("lipsync");
    for (const id of ["transcribe", "translate", "voice", "lipsync"])
      s = dubUpdateStep(s, id, { status: "done" });
    const on = withBackground(s, 20);
    expect(on.order.at(-1)).toBe("mix");
    expect(on.steps.lipsync.status).toBe("done");
    expect(on.steps.mix.status).toBe("idle");
    expect(dubNextRunnable(on)).toBe("mix");
    const off = withBackground(
      { ...on, steps: { ...on.steps, mix: { id: "mix", status: "done" } } },
      0,
    );
    expect(off.order).not.toContain("mix");
    expect(off.steps.mix).toBeUndefined();
    expect(withBackground(off, 0)).toBe(off);
    let a = initialDub("audio");
    for (const id of a.order) a = dubUpdateStep(a, id, { status: "done" });
    const re = withBackground(a, 40);
    expect(re.steps.mux.status).toBe("idle");
    expect(re.steps.voice.status).toBe("done");
  });

  it("editing the transcript re-translates", () => {
    let s = initialDub("audio");
    s = {
      ...dubUpdateStep(s, "transcribe", { status: "done" }),
      transcript: "The lighthouse keeper waves.",
    };
    const before = withTranscript(s, "The lighthouse keeper waved.");
    expect(before.transcript).toBe("The lighthouse keeper waved.");
    expect(before.steps.transcribe.status).toBe("done");
    s = {
      ...dubUpdateStep(before, "translate", { status: "done" }),
      translation: "El farero saluda.",
    };
    s = dubUpdateStep(s, "voice", { status: "done" });
    const e = withTranscript(s, "x".repeat(DUB_MAX_CHARS + 50));
    expect(e.transcript).toHaveLength(DUB_MAX_CHARS);
    expect(e.translation).toBe("");
    expect(e.steps.transcribe.status).toBe("done");
    expect(e.steps.translate.status).toBe("idle");
    expect(e.steps.voice.status).toBe("idle");
    expect(dubNextRunnable(e)).toBe("translate");
  });

  it("auto voice engine: Chatterbox where it speaks the language natively", () => {
    expect(DUB_DEFAULT_ENGINE).toBe("auto");
    expect(dubResolveEngine("auto", "en")).toBe("vibevoice");
    expect(dubResolveEngine("auto", "zh")).toBe("vibevoice");
    for (const l of ["es", "de", "ja", "sv", "he"])
      expect(dubResolveEngine("auto", l)).toBe("chatterbox");
    for (const l of ["uk", "id", "vi"])
      expect(dubResolveEngine("auto", l)).toBe("vibevoice");
    expect(dubResolveEngine("vibevoice", "es")).toBe("vibevoice");
    expect(dubResolveEngine("chatterbox", "en")).toBe("chatterbox");
    expect(CHATTERBOX_DUB_LANGS.size).toBe(22);
  });

  it("editing the translation re-voices", () => {
    let s = initialDub("lipsync");
    for (const id of ["transcribe", "translate", "voice", "lipsync"])
      s = dubUpdateStep(s, id, { status: "done" });
    const e = withTranslation({ ...s, translation: "a" }, "b");
    expect(e.translation).toBe("b");
    expect(e.steps.translate.status).toBe("done");
    expect(e.steps.voice.status).toBe("idle");
    expect(e.steps.lipsync.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function server(
  opts: {
    failAction?: string;
    translation?: string;
    previewFirst?: boolean;
    speakerSegments?: unknown[];
    retrySegments?: unknown[];
    failMessage?: string;
    retryFails?: boolean;
  } = {},
) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const retried = new Set<string>();
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
      if ((body!.params as { retry?: boolean })?.retry) retried.add(pid);
      return json({
        run: { run_id: `${kind}${n}`, jobs: [{ index: 0, prompt_id: pid }] },
      });
    }
    if (url.startsWith("/api/comfy/history/")) {
      const pid = decodeURIComponent(url.slice("/api/comfy/history/".length));
      const kind = kindOf.get(pid) ?? "";
      if (kind === opts.failAction || (opts.retryFails && retried.has(pid)))
        return json({
          ok: true,
          status: {
            status_str: "error",
            messages: [
              [
                "execution_error",
                {
                  node_type: "CJWhisperASR",
                  exception_message: opts.failMessage ?? "boom",
                },
              ],
            ],
          },
        });
      switch (kind) {
        case "dub_transcribe_speakers":
          return json({
            ok: true,
            texts: [
              {
                text: JSON.stringify(
                  (retried.has(pid) ? opts.retrySegments : null) ??
                  opts.speakerSegments ?? [
                    { speaker: 0, start: 0, end: 2, text: "Hello there." },
                    { speaker: 1, start: 2, end: 5, text: "Hi, I am Mara." },
                  ],
                ),
              },
            ],
          });
        case "dub_transcribe":
          return json({
            ok: true,
            texts: [
              { text: "The lighthouse keeper waves." },
              {
                text: JSON.stringify([
                  { start: 0, end: 2.1, text: "The lighthouse keeper waves." },
                ]),
              },
            ],
          });
        case "dub_translate":
          return json({
            ok: true,
            texts: [
              {
                text:
                  opts.translation ?? '<think>ok</think>"El farero saluda."',
              },
            ],
          });
        case "dub_voice":
        case "dub_voice_chatterbox":
          // Live ComfyUI lists the TTS node's temp preview before the save.
          return json({
            ok: true,
            audios: [
              ...(opts.previewFirst
                ? [
                    {
                      filename: "ComfyUI_temp_x_00001.flac",
                      subfolder: "",
                      type: "temp",
                      url: "/api/comfy/image?filename=ComfyUI_temp_x_00001.flac&subfolder=&type=temp",
                    },
                  ]
                : []),
              file("adrift_dub_1.mp3", "audio"),
            ],
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

const inputs = (over: Partial<DubInputs> = {}): DubInputs => ({
  video: {
    id: "v1",
    previewUrl: "blob:x",
    dataUrl: "data:video/mp4;base64,AAAA",
    label: "talk.mp4",
    duration: 20,
    width: 1920,
    height: 1080,
  },
  mode: "lipsync",
  target: "es",
  source: "auto",
  engine: "vibevoice",
  seed: 7,
  ...over,
});

const deps = (fetchImpl: DubDeps["fetchImpl"]): DubDeps => ({
  fetchImpl,
  clientId: "c1",
  onRun: vi.fn(),
  measure: async (_u, kind) => (kind === "audio" ? 3.2 : 3.2),
  toDataUrl: async () => "data:audio/mpeg;base64,AAAA",
  sleep: async () => {},
  pollMs: 0,
});

describe("dub video runner", () => {
  it("runs transcribe -> translate -> voice -> lipsync", async () => {
    const srv = server();
    const d = deps(srv.fetchImpl);
    const states: DubState[] = [];
    const end = await runDub(initialDub("lipsync"), inputs(), d, (s) =>
      states.push(s),
    );
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    expect(end.transcript).toBe("The lighthouse keeper waves.");
    expect(end.segments).toHaveLength(1);
    expect(end.translation).toBe("El farero saluda.");
    expect(end.steps.lipsync.output?.url).toContain("video_lipsync.mp4");
    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "dub_transcribe",
      "dub_translate",
      "dub_voice",
      "video_lipsync",
    ]);
    // Clip uploaded + seeded once; every clip step uses that run.
    const seeds = srv.calls.filter((c) => c.url === "/api/jobs/seed-run");
    expect(seeds).toHaveLength(2); // clip + text-only translate seed
    expect(seeds[0].body).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 20,
    });
    expect(seeds[1].body).toMatchObject({ text_only: true });
    const clipRunId = acts[0].run_id;
    expect(acts[2].run_id).toBe(clipRunId);
    expect(acts[3].run_id).toBe(clipRunId);
    expect(acts[1].run_id).not.toBe(clipRunId);
    expect(acts[0].params).toMatchObject({
      seconds: 14.76,
      language: "auto",
      seed: 7,
    });
    expect(acts[1].params).toMatchObject({
      transcript: "The lighthouse keeper waves.",
      target: "es",
      seconds: 14.76,
    });
    expect(acts[2].params).toMatchObject({ text: "El farero saluda." });
    expect(acts[3].params).toMatchObject({
      audio_seconds: 3.2,
      video_seconds: 20,
      seed: 7,
    });
    expect(
      String(
        acts[3].params && (acts[3].params as Record<string, unknown>).audioRef,
      ),
    ).toMatch(/\.mp3 \[input\]$/);
    expect(states.some((s) => s.steps.voice.status === "running")).toBe(true);
  });

  it("audio-only mode muxes instead of lipsyncing", async () => {
    const srv = server();
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", target: "fr" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.mux.status).toBe("done");
    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "dub_transcribe",
      "dub_translate",
      "dub_voice",
      "dub_mux",
    ]);
    expect(acts[0].params).toMatchObject({ seconds: 20 });
    expect(acts[3].params).toMatchObject({ seconds: 20 });
  });

  it("stops at a failed step and resumes from it", async () => {
    const srv = server({ failAction: "dub_transcribe" });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.transcribe.status).toBe("error");
    expect(end.steps.transcribe.error).toContain("CJWhisperASR: boom");
    expect(end.steps.translate.status).toBe("idle");
    expect(srv.actions()).toHaveLength(1);
  });

  it("an edited translation is what gets voiced", async () => {
    const srv = server();
    const d = deps(srv.fetchImpl);
    let s = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      d,
      () => {},
    );
    s = withTranslation(s, "Texto corregido.");
    s = await runDub(s, inputs({ mode: "audio" }), d, () => {});
    const voices = srv.actions().filter((a) => a.action === "dub_voice");
    expect(voices.at(-1)!.params).toMatchObject({ text: "Texto corregido." });
    // The clip was not uploaded again.
    expect(
      srv.calls.filter(
        (c) => c.url === "/api/jobs/seed-run" && !c.body?.text_only,
      ),
    ).toHaveLength(1);
  });

  it("keeps the original audio: lipsync then a mix over the lipsynced frames", async () => {
    const srv = server();
    const end = await runDub(
      initialDub("lipsync", 25),
      inputs(),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "dub_transcribe",
      "dub_translate",
      "dub_voice",
      "video_lipsync",
      "dub_mux",
    ]);
    const lip = acts[3].params as Record<string, unknown>;
    const mix = acts[4].params as Record<string, unknown>;
    expect(mix.audioRef).toBe(lip.audioRef);
    expect(String(mix.framesRef)).toMatch(/\.mp4 \[input\]$/);
    expect(mix).toMatchObject({ background_db: -12, seconds: 3.2, seed: 7 });
    expect(acts[4].run_id).toBe(acts[0].run_id);
    // The speech is uploaded once and reused by lipsync + mix.
    const mp3s = srv.calls.filter(
      (c) =>
        c.url === "/api/comfy/upload" &&
        String(c.body?.filename).endsWith(".mp3"),
    );
    expect(mp3s).toHaveLength(1);
    expect(end.steps.mix.output?.url).toContain("dub_mux.mp4");
  });

  it("audio-only mode passes the background gain to the mux", async () => {
    const srv = server();
    await runDub(
      initialDub("audio", 50),
      inputs({ mode: "audio" }),
      deps(srv.fetchImpl),
      () => {},
    );
    const mux = srv.actions().at(-1)!;
    expect(mux.action).toBe("dub_mux");
    expect(mux.params).toMatchObject({ background_db: -6, seconds: 20 });
    expect(mux.params).not.toHaveProperty("framesRef");
  });

  it("the saved keep-original level reaches the mux gain (default -18 dB)", async () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    // Nothing saved: switch off, level ready at the default.
    expect(readDubBackground(store)).toEqual({
      keep: false,
      level: DUB_BACKGROUND_KEEP_DEFAULT,
    });
    expect(dubBackgroundFromPref(readDubBackground(store))).toBe(0);
    writeDubBackground(store, { keep: true, level: DUB_BACKGROUND_KEEP_DEFAULT });
    expect(JSON.parse(mem.get(DUB_BACKGROUND_STORAGE_KEY)!)).toEqual({
      keep: true,
      level: 12,
    });
    const level = dubBackgroundFromPref(readDubBackground(store));
    expect(dubBackgroundDb(level)).toBe(-18);

    const srv = server();
    await runDub(
      initialDub("audio", level),
      inputs({ mode: "audio" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(srv.actions().at(-1)!.params).toMatchObject({ background_db: -18 });

    // Switch off keeps the level for next time; the mix replaces the audio.
    writeDubBackground(store, { keep: false, level: 30 });
    expect(readDubBackground(store)).toEqual({ keep: false, level: 30 });
    expect(dubBackgroundFromPref(readDubBackground(store))).toBe(0);
  });

  it("bad or blocked saved settings fall back to the default", () => {
    const bad = (raw: string | null) => ({
      getItem: () => raw,
      setItem: () => {},
    });
    const off = { keep: false, level: DUB_BACKGROUND_KEEP_DEFAULT };
    expect(readDubBackground(null)).toEqual(off);
    expect(readDubBackground(bad("{not json"))).toEqual(off);
    expect(readDubBackground(bad('{"keep":"yes","level":0}'))).toEqual(off);
    expect(readDubBackground(bad('{"keep":true,"level":250}'))).toEqual({
      keep: true,
      level: 100,
    });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDubBackground(throwing)).toEqual(off);
    expect(() => writeDubBackground(throwing, off)).not.toThrow();
  });

  it("without a background the mux sends no gain", async () => {
    const srv = server();
    await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(srv.actions().at(-1)!.params).not.toHaveProperty("background_db");
  });

  it("script review pauses before the voice, then Continue runs through", async () => {
    const srv = server();
    const d = { ...deps(srv.fetchImpl), pauseBefore: "voice" as const };
    let s = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      d,
      () => {},
    );
    expect(s.steps.translate.status).toBe("done");
    expect(s.steps.voice.status).toBe("idle");
    expect(srv.actions()).toHaveLength(2);
    s = withTranscript(s, "The keeper waves.");
    s = await runDub(s, inputs({ mode: "audio" }), d, () => {});
    // A transcript edit re-translates and pauses again for review.
    expect(
      srv
        .actions()
        .map((a) => a.action)
        .at(-1),
    ).toBe("dub_translate");
    expect(srv.actions().at(-1)!.params).toMatchObject({
      transcript: "The keeper waves.",
    });
    expect(s.steps.voice.status).toBe("idle");
    s = await runDub(s, inputs({ mode: "audio" }), d, () => {});
    expect(s.order.every((id) => s.steps[id].status === "done")).toBe(true);
    expect(
      srv
        .actions()
        .map((a) => a.action)
        .slice(-2),
    ).toEqual(["dub_voice", "dub_mux"]);
  });

  it("auto engine voices Spanish with Chatterbox and English with VibeVoice", async () => {
    const srv = server();
    await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", engine: undefined, target: "es" }),
      deps(srv.fetchImpl),
      () => {},
    );
    const es = srv
      .actions()
      .find((a) => String(a.action).startsWith("dub_voice"))!;
    expect(es.action).toBe("dub_voice_chatterbox");
    expect(es.params).toMatchObject({ language: "es" });
    const srv2 = server();
    await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", engine: "auto", target: "en" }),
      deps(srv2.fetchImpl),
      () => {},
    );
    expect(srv2.actions().map((a) => a.action)).toContain("dub_voice");
  });

  it("keeps the saved speech file, not the TTS node's temp preview", async () => {
    const srv = server({ previewFirst: true });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.voice.output?.ref).toBe("audio/adrift_dub_1.mp3 [output]");
  });

  it("pauses after a voice that outlasts the clip, then Continue cuts it", async () => {
    const srv = server();
    const long = {
      ...deps(srv.fetchImpl),
      measure: async (_u: string, kind: "audio" | "video") =>
        kind === "audio" ? 12.4 : 10.56,
    };
    const clip = inputs({
      video: { ...inputs().video, duration: 10.56 },
    });
    let s = await runDub(initialDub("lipsync"), clip, long, () => {});
    expect(s.steps.voice.status).toBe("done");
    expect(s.steps.lipsync.status).toBe("idle");
    expect(dubOverrunSeconds(s, 10.56)).toBe(1.8);
    expect(srv.actions().map((a) => a.action)).not.toContain("video_lipsync");
    // Continue (a call that starts at lipsync) runs through and cuts.
    s = await runDub(s, clip, long, () => {});
    expect(s.steps.lipsync.status).toBe("done");
    // Opting out runs straight through.
    const srv2 = server();
    const end = await runDub(
      initialDub("lipsync"),
      clip,
      { ...long, fetchImpl: srv2.fetchImpl, pauseOnOverrun: false },
      () => {},
    );
    expect(end.steps.lipsync.status).toBe("done");
  });

  it("an empty transcript fails the transcribe step", async () => {
    const srv = server();
    const silent = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/comfy/history/"))
        return json({ ok: true, texts: [{ text: "" }, { text: "[]" }] });
      return srv.fetchImpl(url, init);
    });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio" }),
      deps(silent),
      () => {},
    );
    expect(end.steps.transcribe.status).toBe("error");
    expect(end.steps.transcribe.error).toMatch(/No speech/);
  });
});

describe("dub with real audio: music and gaps", () => {
  const segs = [
    { speaker: 0, start: 0, end: 90, text: "[Music]" },
    { speaker: 0, start: 90, end: 92, text: "Close your eyes." },
    { speaker: 1, start: 92, end: 93, text: "Why now?" },
    { speaker: 0, start: 93, end: 100, text: "[Environmental Sounds]" },
    { speaker: 0, start: 100, end: 101, text: "Okay." },
    { speaker: 1, start: 101, end: 104, text: "Nothing at all." },
    { speaker: 1, start: 104.2, end: 106, text: "The same." },
  ];

  it("drops bracketed non-speech, keeps speech that holds brackets", () => {
    const speech = dubSpeechSegments(segs);
    expect(speech.map((s) => s.text)).not.toContain("[Music]");
    expect(speech).toHaveLength(5);
    expect(
      dubSpeechSegments([{ start: 0, end: 1, text: "[laughs] Fine." }]),
    ).toHaveLength(1);
    expect(dubSpeakerScript(speech)).not.toMatch(/Music|Environmental/);
  });

  it("clones from unbroken speech only", () => {
    const refs = dubSpeakerRefs(dubSpeechSegments(segs));
    expect(refs).toEqual([
      { speaker: 1, start: 90, seconds: 2 },
      { speaker: 2, start: 101, seconds: 5 },
    ]);
  });

  it("numbers speakers even when a turn starts before the last one ends", () => {
    const refs = dubSpeakerRefs([
      { speaker: 0, start: 0, end: 6, text: "a" },
      { speaker: 1, start: 5, end: 9, text: "b" },
      { speaker: 0, start: 6, end: 6.5, text: "c" },
      { speaker: 1, start: 9, end: 12, text: "d" },
    ]);
    expect(refs.map((r) => r.speaker).sort()).toEqual([1, 2]);
  });

  it("never spans a gap, even for one speaker", () => {
    const refs = dubSpeakerRefs([
      { speaker: 0, start: 0, end: 2, text: "a" },
      { speaker: 0, start: 30, end: 33, text: "b" },
    ]);
    expect(refs).toEqual([{ speaker: 1, start: 30, seconds: 3 }]);
  });
});

describe("dub video runner with several speakers", () => {
  it("transcribes with speakers and clones a voice per speaker", async () => {
    const srv = server({ translation: "[1] Hola.\n[2] Soy Mara." });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several", engine: "chatterbox" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    expect(end.transcript).toBe("[1] Hello there.\n[2] Hi, I am Mara.");
    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "dub_transcribe_speakers",
      "dub_translate",
      "dub_voice",
      "dub_mux",
    ]);
    expect((acts[2] as { params: Record<string, unknown> }).params.text).toBe("[1] Hola.\n[2] Soy Mara.");
    expect((acts[2] as { params: Record<string, unknown> }).params.speakers).toEqual([
      { speaker: 1, start: 0, seconds: 2 },
      { speaker: 2, start: 2, seconds: 3 },
    ]);
  });

  it.each([
    ["one speaker", [[0, 0, 5, "Hi."]], /Only one speaker/],
    ["a thin voice reference", [[0, 0, 5, "Hi."], [1, 5, 5.7, "No."]], /Speaker 2 has under 2 s/],
  ])("stops on %s", async (_n, rows, err) => {
    const segments = (rows as [number, number, number, string][]).map(([speaker, start, end, text]) => ({ speaker, start, end, text }));
    const srv = server({ speakerSegments: segments });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.transcribe.status).toBe("error");
    expect(end.steps.transcribe.error).toMatch(err as RegExp);
  });

  it("retries a one-speaker result on a repeated clip and keeps the fullest copy", async () => {
    const srv = server({
      speakerSegments: [{ speaker: 0, start: 0, end: 5, text: "Hi. Hello there." }],
      // 10 s clip: copies start at 0, 11 and 22 s. The middle one has the most speech.
      retrySegments: [
        { speaker: 2, start: 0, end: 3, text: "Hi." },
        { speaker: 2, start: 11, end: 14, text: "Hi." },
        { speaker: 1, start: 14, end: 17.5, text: "Hello there." },
        { speaker: 1, start: 25, end: 27, text: "Hello there." },
      ],
    });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several", video: { ...inputs().video, duration: 10 } }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.transcribe.status).toBe("done");
    expect(end.transcript).toBe("[1] Hi.\n[2] Hello there.");
  });

  it("stops on the one-speaker message when the retry fails", async () => {
    const srv = server({
      speakerSegments: [{ speaker: 0, start: 0, end: 5, text: "Hi. Hello there." }],
      retryFails: true,
    });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.transcribe.status).toBe("error");
    expect(end.steps.transcribe.error).toMatch(/Only one speaker found/);
  });

  it("explains a transcription the model never finished", async () => {
    const srv = server({
      failAction: "dub_transcribe_speakers",
      failMessage: "Transcription failed: Unterminated string starting at: line 1",
    });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.transcribe.error).toMatch(/Long music with no talking/);
    expect(end.steps.transcribe.error).not.toMatch(/Unterminated/);
    expect(srv.actions()).toHaveLength(1);
  });

  it("does not retry a clip that already split", async () => {
    const srv = server({ retrySegments: [{ speaker: 0, start: 0, end: 1, text: "Wrong." }] });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.transcript).not.toMatch(/Wrong/);
  });

  it("refuses a translation that changed who speaks", async () => {
    const srv = server({ translation: "[1] Hola. Soy Mara." });
    const end = await runDub(
      initialDub("audio"),
      inputs({ mode: "audio", speakers: "several" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.translate.status).toBe("error");
    expect(end.steps.translate.error).toMatch(/who speaks when/);
  });
});

describe("dub video hub card", () => {
  const ctx = (packs: string[] | null): EngineContext => ({
    catalog: packs ? [] : null,
    packIds: packs ? new Set(packs) : null,
    editLoras: null,
  });

  it("is available with the audio pack and listed in the hub", () => {
    expect(dubVideoCard(ctx(null)).checking).toBe(true);
    expect(dubVideoCard(ctx([])).available).toBe(false);
    expect(dubVideoCard(ctx([])).unavailableReason).toBeTruthy();
    const card = dubVideoCard(ctx(["audio"]));
    expect(card.available).toBe(true);
    expect(card.hubCategory).toBe("Audio");
    expect(card.aliases).toContain("translate video");
    expect(card.title).toBe("Video Translator");
    expect(toolTitle(DUB_VIDEO_KEY)).toBe("Video Translator");
    for (const a of [
      "Dub Video",
      "translate",
      "dub",
      "dubbing",
      "localize",
      "language",
    ])
      expect(card.aliases).toContain(a);
    expect(pipelineCards(ctx(["audio"])).map((c) => c.key)).not.toContain(
      DUB_VIDEO_KEY,
    );
    const keys = buildHubCards({ toolCards: [], ctx: ctx(["audio"]) }).map(
      (c) => c.key,
    );
    expect(keys).toContain(DUB_VIDEO_KEY);
  });
});

describe("video translator in the lightbox", () => {
  it("is offered for videos (hand-off to the runner), not images", () => {
    const tools = buildHubToolEntries();
    const entry = tools.find((t) => t.key === DUB_VIDEO_KEY);
    expect(entry).toBeDefined();
    expect(entry!.media).toEqual(["video"]);
    expect(entry!.title).toBe("Video Translator");
    expect(entry!.target).toEqual({ kind: "open", toolKey: DUB_VIDEO_KEY });
    const find = (media: "image" | "video", query: string) =>
      filterLightboxTools(tools, { media, external: false, query }).map(
        (t) => t.key,
      );
    for (const q of ["translate", "dubbing", "localize", "video translator"])
      expect(find("video", q)).toContain(DUB_VIDEO_KEY);
    expect(find("image", "translate")).not.toContain(DUB_VIDEO_KEY);
  });
});

describe("dub with several speakers", () => {
  const segs = [
    { speaker: 3, start: 0, end: 3.5, text: "Hello there," },
    { speaker: 3, start: 3.5, end: 4, text: "friend." },
    { speaker: 7, start: 4, end: 9, text: "Hi, I am Mara." },
    { speaker: 3, start: 9, end: 10, text: "Neat." },
  ];

  it("turns segments into one labelled line per turn, numbered by first voice", () => {
    expect(dubSpeakerScript(segs)).toBe(
      "[1] Hello there, friend.\n[2] Hi, I am Mara.\n[1] Neat.",
    );
    expect(dubSpeakerCount(segs)).toBe(2);
  });

  it("clones each speaker from their longest turn", () => {
    expect(dubSpeakerRefs(segs)).toEqual([
      { speaker: 1, start: 0, seconds: 4 },
      { speaker: 2, start: 4, seconds: 5 },
    ]);
    expect(
      dubSpeakerRefs([{ speaker: 0, start: 2, end: 60, text: "long" }])[0]
        .seconds,
    ).toBe(DUB_VOICE_REF_SECONDS);
  });

  it("keeps the speaker when parsing the ASR segments", () => {
    const { segments } = parseTranscription([
      '[{"speaker":1,"text":"Hi","start":0,"end":1}]',
    ]);
    expect(segments[0].speaker).toBe(1);
  });

  it("cleans a model reply into labelled lines and joins wrapped ones", () => {
    expect(
      cleanSpeakerScript(
        "<think>x</think>\n```\n[1] Hola,\namigo.\n\n[2]: Soy Mara.\n```",
      ),
    ).toBe("[1] Hola, amigo.\n[2] Soy Mara.");
  });

  it("the translate prompt keeps labels only for a labelled script", () => {
    const multi = dubTranslatePrompt({
      transcript: "[1] Hi\n[2] Hello",
      target: "es",
    });
    expect(multi).toMatch(/Keep every label/);
    expect(multi).toContain("[1] Hi\n[2] Hello");
    expect(
      dubTranslatePrompt({ transcript: "Hi there", target: "es" }),
    ).not.toMatch(/Keep every label/);
    expect(dubIsSpeakerScript("[1] Hi there, line one.\nand more")).toBe(false);
  });

  const base = () => load(DUB_VOICE_ACTION);

  it("cuts one clone reference per speaker", () => {
    const { workflow: g } = buildDubVoiceWorkflow(base(), clipRun(), 0, {
      text: "[1] Hola\n[2] Soy Mara",
      speakers: [
        { speaker: 1, start: 0, seconds: 4 },
        { speaker: 2, start: 4, seconds: 5 },
      ],
    });
    const tts = g["3"].inputs;
    expect(tts.text).toBe("[1] Hola\n[2] Soy Mara");
    expect(tts.speaker_1_voice).toEqual(["2", 0]);
    expect(g["2"].inputs).toMatchObject({ start_index: 0, duration: 4 });
    const [id] = tts.speaker_2_voice as [string, number];
    expect(g[id].class_type).toBe("TrimAudioDuration");
    expect(g[id].inputs).toMatchObject({
      audio: ["1", 0],
      start_index: 4,
      duration: 5,
    });
  });

  it("refuses a script line with no voice, and a fifth speaker", () => {
    const one = [{ speaker: 1, start: 0, seconds: 4 }];
    expect(() =>
      buildDubVoiceWorkflow(base(), clipRun(), 0, {
        text: "[1] Hola\n[2] Soy Mara",
        speakers: one,
      }),
    ).toThrow(/no voice for speaker \[2\]/);
    expect(() =>
      buildDubVoiceWorkflow(base(), clipRun(), 0, {
        text: "[1] Hola",
        speakers: [1, 2, 3, 4, 5].map((speaker) => ({
          speaker,
          start: 0,
          seconds: 1,
        })),
      }),
    ).toThrow(/at most 4/);
  });

  it("a one-voice dub is unchanged", () => {
    const { workflow: g } = buildDubVoiceWorkflow(base(), clipRun(), 0, {
      text: "Hola\namigo",
    });
    expect(g["3"].inputs.text).toBe("[1] Hola amigo");
    expect(g["3"].inputs.speaker_2_voice).toBeUndefined();
  });
});

describe("dubBestCopy", () => {
  it("drops gap and overflow segments and clamps to the clip", () => {
    const got = dubBestCopy(
      [
        { speaker: 3, start: 10.5, end: 10.9, text: "In the gap." },
        { speaker: 3, start: 11, end: 25, text: "Runs long." },
        { speaker: 0, start: 99, end: 100, text: "Past the last copy." },
      ],
      10,
    );
    expect(got).toEqual([{ speaker: 0, start: 0, end: 10, text: "Runs long." }]);
  });
});
