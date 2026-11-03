import { describe, expect, it, vi } from "vitest";
import type { ImagineRun } from "@/types";

const editPrompts: string[] = [];
vi.mock("@/lib/tools/runTool", async (orig) => {
  const actual = await orig<typeof import("@/lib/tools/runTool")>();
  return {
    ...actual,
    submitEngineEdit: vi.fn(async (args: { prompt: string }) => {
      editPrompts.push(args.prompt);
      const n = editPrompts.length;
      return {
        run_id: `edit${n}`,
        jobs: [{ index: 0, prompt_id: `p-edit-${n}` }],
      } as unknown as ImagineRun;
    }),
  };
});

import {
  CLIPCUT_GARMENTS,
  CLIPCUT_STYLES,
  bpmHintFor,
  ccDependencies,
  ccInvalidate,
  ccNextRunnable,
  ccUpdateStep,
  clipCutAssembleParams,
  clipCutOrder,
  defaultGarments,
  effectiveBeatsPerCut,
  initialClipCut,
  lookPrompt,
  musicSecondsFor,
  planCuts,
  runClipCut,
  type ClipCutDeps,
  type ClipCutInputs,
} from "@/lib/tools/clipCut";
import { beatGrid, type BeatAnalysis } from "@/lib/tools/beats";
import { planAssembly } from "@/lib/oj/pipelineAssemble";
import type { EditEngine } from "@/lib/tools/templates";

// Brand words the public export gate rejects (built from parts on purpose).
const BANNED = new RegExp(
  ["mid" + "journey", "\\bM" + "J\\b", "higgs" + "field"].join("|"),
  "i",
);

describe("ClipCut catalog", () => {
  it("has original styles with 8 settings, a motion and a music bed each", () => {
    expect(CLIPCUT_STYLES.map((s) => s.id)).toEqual([
      "studio",
      "urban",
      "runway",
    ]);
    for (const s of CLIPCUT_STYLES) {
      expect(s.settings).toHaveLength(8);
      expect(new Set(s.settings).size).toBe(8);
      expect(s.bpm).toBeGreaterThanOrEqual(40);
      expect(s.bpm).toBeLessThanOrEqual(220);
      expect(JSON.stringify(s)).not.toMatch(BANNED);
    }
  });

  it("uses the AI Stylist garments and builds identity-keeping look prompts", () => {
    expect(CLIPCUT_GARMENTS.length).toBeGreaterThanOrEqual(8);
    expect(defaultGarments()).toHaveLength(4);
    const urban = CLIPCUT_STYLES[1];
    const p0 = lookPrompt(
      urban,
      CLIPCUT_GARMENTS[0].id,
      0,
      "golden hour --ar 9:16",
    );
    const p9 = lookPrompt(urban, CLIPCUT_GARMENTS[0].id, 9);
    expect(p0).toMatch(/^Dress the person in /);
    expect(p0).toContain(urban.settings[0]);
    expect(p0).toContain("golden hour");
    expect(p0).not.toContain("--ar");
    expect(p0).toMatch(/same person in every look/);
    expect(p9).toContain(urban.settings[1]); // cycles
    expect(p0).not.toMatch(/\.\./);
  });

  it("hints the BPM only for generated music and pads the bed length", () => {
    expect(bpmHintFor({ musicSource: "generate", style: "urban" })).toBe(94);
    expect(
      bpmHintFor({ musicSource: "upload", style: "urban" }),
    ).toBeUndefined();
    expect(musicSecondsFor(5)).toBe(10);
    expect(musicSecondsFor(15)).toBe(17);
    expect(musicSecondsFor(999)).toBe(240);
  });
});

describe("planCuts", () => {
  it("cuts every 2 beats at 120 BPM, cycling looks, on whole frames", () => {
    const beats = beatGrid(120, 20);
    const cuts = planCuts(beats, { looks: 4, beatsPerCut: 2, maxSeconds: 10 });
    expect(cuts).toHaveLength(10);
    expect(cuts.map((c) => c.look)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
    for (const c of cuts) expect(c.seconds).toBeCloseTo(1, 6);
    expect(cuts[cuts.length - 1].end).toBeCloseTo(10, 6);
    // Repeats continue the motion: look 0 starts at 0 then 1 s.
    expect(cuts[0].clipStart).toBe(0);
    expect(cuts[4].clipStart).toBe(1);
    expect(cuts[8].clipStart).toBe(2);
  });

  it("first cut absorbs the intro and boundaries stay frame-quantised without drift", () => {
    const beats = beatGrid(94, 20, 0.31);
    const cuts = planCuts(beats, {
      looks: 3,
      beatsPerCut: 2,
      maxSeconds: 15,
      fps: 24,
    });
    expect(cuts[0].start).toBe(0);
    expect(cuts[0].end).toBeCloseTo(Math.round(beats[2] * 24) / 24, 6);
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i].start).toBeCloseTo(cuts[i - 1].end, 9);
      const k = 2 * (i + 1);
      expect(Math.abs(cuts[i].end - beats[k])).toBeLessThanOrEqual(
        1 / 48 + 1e-9,
      );
    }
    const total = cuts.reduce((a, c) => a + c.seconds, 0);
    expect(total).toBeLessThanOrEqual(15);
    expect(Math.round(total * 24)).toBeCloseTo(total * 24, 6);
  });

  it("doubles beats per cut when cuts would be shorter than 0.5 s", () => {
    const fast = beatGrid(180, 10);
    expect(effectiveBeatsPerCut(fast, 1)).toBe(2);
    expect(effectiveBeatsPerCut(beatGrid(120, 10), 1)).toBe(1);
    const cuts = planCuts(fast, { looks: 2, beatsPerCut: 1, maxSeconds: 5 });
    for (const c of cuts) expect(c.seconds).toBeGreaterThanOrEqual(0.5);
  });

  it("respects the 12-scene cap, the music length and the clip length", () => {
    const beats = beatGrid(120, 60);
    expect(
      planCuts(beats, { looks: 4, beatsPerCut: 1, maxSeconds: 30 }),
    ).toHaveLength(12);
    const short = planCuts(beats, {
      looks: 2,
      beatsPerCut: 2,
      maxSeconds: 30,
      duration: 4.2,
    });
    expect(short[short.length - 1].end).toBeLessThanOrEqual(4.2);
    // 2 s clips: every cut of 1 s restarts the look's clip after one use.
    const wrap = planCuts(beats, {
      looks: 1,
      beatsPerCut: 2,
      maxSeconds: 6,
      clipSeconds: [2],
    });
    expect(wrap.map((c) => c.clipStart)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("falls back to one cut when there are too few beats", () => {
    const cuts = planCuts([0], { looks: 3, beatsPerCut: 2, maxSeconds: 6 });
    expect(cuts).toHaveLength(1);
    expect(cuts[0].seconds).toBe(6);
    expect(planCuts([], { looks: 1, beatsPerCut: 1, maxSeconds: 0.2 })).toEqual(
      [],
    );
  });
});

describe("ClipCut step graph", () => {
  it("orders looks, clips, music, beats, assemble with the right deps", () => {
    const order = clipCutOrder(2);
    expect(order).toEqual([
      "look:0",
      "look:1",
      "clip:0",
      "clip:1",
      "music",
      "beats",
      "assemble",
    ]);
    expect(ccDependencies("clip:1", order)).toEqual(["look:1"]);
    expect(ccDependencies("beats", order)).toEqual(["music"]);
    expect(ccDependencies("assemble", order)).toEqual([
      "clip:0",
      "clip:1",
      "beats",
    ]);
    expect(initialClipCut(20).looks).toBe(8);
  });

  it("invalidates downstream steps and drops the beat analysis", () => {
    let s = initialClipCut(2);
    for (const id of s.order) s = ccUpdateStep(s, id, { status: "done" });
    s = {
      ...s,
      beats: { bpm: 120, beats: [0], onsets: [], duration: 1, confidence: 1 },
    };
    const music = ccInvalidate(s, "music");
    expect(music.steps.music.status).toBe("idle");
    expect(music.steps.beats.status).toBe("idle");
    expect(music.steps.assemble.status).toBe("idle");
    expect(music.steps["clip:0"].status).toBe("done");
    expect(music.beats).toBeNull();
    const look = ccInvalidate(s, "look:1");
    expect(look.steps["clip:1"].status).toBe("idle");
    expect(look.steps["clip:0"].status).toBe("done");
    expect(look.beats).not.toBeNull();
    expect(ccNextRunnable(look)).toBe("look:1");
  });
});

// ---------------------------------------------------------------------------
// Executor against a fake Adrift server
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function server() {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const kindOf = new Map<string, string>();
  let n = 0;
  const mkRun = (kind: string): ImagineRun => {
    n += 1;
    const pid = `p-${kind}-${n}`;
    kindOf.set(pid, kind);
    return {
      run_id: `${kind}${n}`,
      jobs: [{ index: 0, prompt_id: pid }],
    } as unknown as ImagineRun;
  };
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
    if (url === "/api/jobs/seed-run")
      return json({ run: { run_id: `seed${++n}`, jobs: [{ index: 0 }] } });
    if (url === "/api/comfy/upload")
      return json({ ref: "track_x.mp3 [input]" });
    if (url === "/api/jobs/action")
      return json({ run: mkRun(String(body!.action)) });
    if (url.startsWith("/api/comfy/history/")) {
      const pid = decodeURIComponent(url.slice("/api/comfy/history/".length));
      const kind = kindOf.get(pid) ?? (pid.startsWith("p-edit-") ? "edit" : "");
      const id = pid.split("-").pop();
      if (kind === "edit")
        return json({ ok: true, images: [file(`look${id}.png`, "")] });
      if (kind === "music")
        return json({ ok: true, audios: [file(`bed${id}.mp3`, "audio")] });
      return json({ ok: true, videos: [file(`${kind}${id}.mp4`, "video")] });
    }
    return json({ error: "unexpected" }, 500);
  });
  const actions = () =>
    calls
      .filter((c) => c.url === "/api/jobs/action")
      .map((c) => c.body as Record<string, unknown>);
  return { fetchImpl, calls, actions };
}

const ENGINE = {
  id: "krea2_edit",
  label: "Edit",
  kind: "edit",
} as unknown as EditEngine;

const inputs = (over: Partial<ClipCutInputs> = {}): ClipCutInputs => ({
  style: "studio",
  garments: defaultGarments(2),
  photo: {
    source: "upload",
    previewUrl: "blob:x",
    dataUrl: "data:image/png;base64,AAAA",
    width: 768,
    height: 1344,
  } as unknown as ClipCutInputs["photo"],
  engine: ENGINE,
  ctx: {} as ClipCutInputs["ctx"],
  motion: "animate_low",
  musicSource: "generate",
  beatsPerCut: 2,
  seconds: 10,
  size: "720x1280",
  ...over,
});

function deps(
  fetchImpl: ClipCutDeps["fetchImpl"],
  analyzed: { url?: string; hint?: number },
): ClipCutDeps {
  return {
    fetchImpl,
    clientId: "c1",
    onRun: vi.fn(),
    measure: async (_url, kind) => (kind === "audio" ? 12.1 : 4.04),
    sleep: async () => {},
    pollMs: 1,
    analyzeBeats: async (url, opts): Promise<BeatAnalysis> => {
      analyzed.url = url;
      analyzed.hint = opts.bpmHint;
      return {
        bpm: 124,
        beats: beatGrid(124, 12),
        onsets: [],
        duration: 12.1,
        confidence: 0.8,
      };
    },
  };
}

describe("runClipCut", () => {
  it("runs looks, clips, music, beats and a beat-cut assemble", async () => {
    editPrompts.length = 0;
    const { fetchImpl, actions } = server();
    const analyzed: { url?: string; hint?: number } = {};
    const states: string[] = [];
    const final = await runClipCut(
      initialClipCut(2),
      inputs(),
      deps(fetchImpl, analyzed),
      (s) => states.push(s.order.map((id) => s.steps[id].status[0]).join("")),
    );
    expect(final.order.every((id) => final.steps[id].status === "done")).toBe(
      true,
    );
    expect(editPrompts).toHaveLength(2);
    expect(editPrompts[1]).toContain(CLIPCUT_STYLES[0].settings[1]);
    const acts = actions();
    expect(acts.map((a) => a.action)).toEqual([
      "animate_low",
      "animate_low",
      "music",
      "pipeline_assemble",
    ]);
    expect(acts[0].run_id).toBe("edit1");
    const music = acts[2].params as Record<string, unknown>;
    expect(music.prompt).toMatch(/^instrumental, fashion runway house/);
    expect(music.duration).toBe(12);
    expect(music.bpm).toBe(124);
    expect(analyzed.hint).toBe(124);
    expect(analyzed.url).toMatch(/bed\d+\.mp3/);
    const p = acts[3].params as Record<string, unknown>;
    const scenes = p.scenes as {
      video: string;
      seconds: number;
      startSeconds?: number;
    }[];
    expect(p.captions).toBe(false);
    expect(p.musicDb).toBe(0);
    expect(p.music).toMatch(/bed\d+\.mp3/);
    expect(p).not.toHaveProperty("cuts");
    // 124 BPM, 2 beats per cut = 0.9677 s cuts, quantised to frames.
    expect(scenes.length).toBeGreaterThanOrEqual(10);
    expect(scenes[0].video).toMatch(/animate_low\d+\.mp4/);
    expect(scenes[0].video).not.toBe(scenes[1].video);
    expect(scenes[2].video).toBe(scenes[0].video);
    expect(scenes[2].startSeconds).toBeGreaterThan(0.9);
    expect(final.steps.assemble.output?.url).toMatch(
      /pipeline_assemble\d+\.mp4/,
    );
    expect(states.length).toBeGreaterThan(10);
    // The assemble graph accepts the params (startSeconds -> skip frames).
    const plan = planAssembly(p as never);
    expect(plan.scenes[2].skipFrames).toBeGreaterThan(0);
  });

  it("uploads the user's track and detects without a BPM hint", async () => {
    const { fetchImpl, calls, actions } = server();
    const analyzed: { url?: string; hint?: number } = {};
    const final = await runClipCut(
      initialClipCut(2),
      inputs({
        musicSource: "upload",
        track: {
          previewUrl: "blob:track",
          dataUrl: "data:audio/mpeg;base64,AAAA",
          label: "my beat.mp3",
          duration: 30,
        } as ClipCutInputs["track"],
      }),
      deps(fetchImpl, analyzed),
      () => {},
    );
    expect(final.steps.assemble.status).toBe("done");
    expect(calls.some((c) => c.url === "/api/comfy/upload")).toBe(true);
    expect(actions().some((a) => a.action === "music")).toBe(false);
    expect(analyzed.url).toBe("blob:track");
    expect(analyzed.hint).toBeUndefined();
    const p = actions().find((a) => a.action === "pipeline_assemble")!
      .params as Record<string, unknown>;
    expect(p.music).toBe("track_x.mp3 [input]");
  });

  it("assemble params need beats, music and every clip", () => {
    const s = initialClipCut(2);
    expect(() => clipCutAssembleParams(s, inputs())).toThrow(/beats/);
  });
});
