/**
 * Music video tool: planner, param validation, graph builders, runner (mock
 * fetch), hub card gating.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import { getPack } from "@/lib/oj/packs";
import {
  MV_NODES,
  buildMusicVideoAssembleWorkflow,
  buildMusicVideoStemsWorkflow,
  buildMusicVideoWorkflow,
} from "@/lib/oj/musicVideo";
import {
  MUSIC_VIDEO_ACTION,
  MUSIC_VIDEO_ASSEMBLE_ACTION,
  MUSIC_VIDEO_KEY,
  MUSIC_VIDEO_STEMS_ACTION,
  MV_FPS,
  MV_MAX_SEGMENT_SECONDS,
  MV_MIN_SEGMENT_SECONDS,
  barPhase,
  cleanBeats,
  h3Frames,
  lastFrameRef,
  musicVideoCard,
  normalizeAssembleParams,
  normalizeSegmentParams,
  planMusicVideo,
  renderFrames,
  segmentJobs,
  segmentPrompt,
  stemOf,
  stemsAvailable,
  type MvPlan,
} from "@/lib/tools/musicVideo";
import {
  musicVideoError,
  runMusicVideo,
  runMusicVideoStems,
} from "@/lib/tools/musicVideoRunner";
import { LIKENESS_TOOL_KEYS } from "@/lib/tools/h3License";
import type { EngineContext } from "@/lib/tools/templates";

const PACKS = path.join(process.cwd(), "public/workflows/packs/minimax");
const load = (f: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(PACKS, f), "utf8"));
const RUN = {} as ImagineRun;

/** 120 bpm beats over a 40 s song. */
const BEATS = Array.from({ length: 80 }, (_, i) => +(0.5 * (i + 1)).toFixed(3));

function tiles(p: MvPlan) {
  let f = 0;
  for (const s of p.segments) {
    expect(s.startFrame).toBe(f);
    expect(s.frames).toBeGreaterThan(0);
    f += s.frames;
  }
  expect(f).toBe(p.frames);
}

describe("planner", () => {
  it("h3Frames rounds up to 17k + 5", () => {
    expect([1, 5, 6, 22, 23, 120, 121].map(h3Frames)).toEqual([
      5, 5, 22, 22, 39, 124, 124,
    ]);
    for (let n = 1; n < 400; n++) {
      const f = h3Frames(n);
      expect(f).toBeGreaterThanOrEqual(n);
      expect((f - 5) % 17).toBe(0);
    }
  });

  it("cleans beats and falls back to a bpm grid", () => {
    expect(cleanBeats([3, 1, 1.02, -1, 99, NaN], 10, 120)).toEqual([1, 3]);
    expect(cleanBeats([1], 3, 60)).toEqual([1, 2]);
  });

  it("finds the bar phase from onsets", () => {
    const onsets = BEATS.filter((_, i) => i % 4 === 2);
    expect(barPhase(BEATS, onsets)).toBe(2);
    expect(barPhase(BEATS, [])).toBe(0);
  });

  it("one segment for a short window", () => {
    const p = planMusicVideo({ duration: 6, beats: BEATS, bpm: 120 });
    expect(p.segments).toHaveLength(1);
    expect(p.frames).toBe(144);
    tiles(p);
  });

  it("cuts a window on beats near the target, tiling every frame", () => {
    const p = planMusicVideo({
      duration: 40,
      start: 4.2,
      seconds: 20,
      beats: BEATS,
      bpm: 120,
      target: 5,
    });
    expect(p.start).toBe(4.2);
    expect(p.seconds).toBe(20);
    expect(p.frames).toBe(480);
    tiles(p);
    expect(p.segments.length).toBeGreaterThanOrEqual(3);
    expect(p.segments.length).toBeLessThanOrEqual(5);
    for (const s of p.segments) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(
        MV_MIN_SEGMENT_SECONDS - 0.05,
      );
      expect(s.end - s.start).toBeLessThanOrEqual(
        MV_MAX_SEGMENT_SECONDS + 0.05,
      );
      expect(renderFrames(s)).toBeLessThanOrEqual(362);
    }
    // inner cuts land on (window-relative) beats: song beats are on 0.5 s,
    // the window starts at 4.2 s, so cuts sit at x.3 / x.8
    for (const s of p.segments.slice(1))
      expect(Math.abs((s.start + 4.2) * 2 - Math.round((s.start + 4.2) * 2))).toBeLessThan(0.05 + 1e-9);
  });

  it("accepts window-relative beats from the stem pass", () => {
    const p = planMusicVideo({
      duration: 40,
      start: 10,
      seconds: 12,
      beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7],
      beatsInWindow: true,
      bpm: 120,
      target: 5,
    });
    tiles(p);
    expect(p.segments.length).toBe(2);
  });

  it("rejects too-short songs", () => {
    expect(() =>
      planMusicVideo({ duration: 1, beats: [], bpm: null }),
    ).toThrow();
  });
});

const TOKEN = "abc123def";
const segParams = (over: Record<string, unknown> = {}) => ({
  song: "cj_audio_x.mp3 [input]",
  songStart: 4,
  index: 1,
  startFrame: 120,
  frames: 96,
  refs: ["a.png [input]", "b.png [input]"],
  prompt: "A music video. --ar 3:2",
  aspect: "9:16",
  token: TOKEN,
  prevFrame: lastFrameRef(TOKEN, 0),
  seed: 9,
  ...over,
});

describe("params", () => {
  it("validates segment params", () => {
    const p = normalizeSegmentParams(segParams());
    expect(p.prompt).not.toContain("--");
    expect(p.aspect).toBe("9:16");
    expect(p.prevFrame).toBe(
      "video/adrift_ctx/CJ_MTV_abc123def/seg01_last_00001_.png [output]",
    );
    for (const bad of [
      { song: "../x.mp3 [input]" },
      { song: "x.png [input]" },
      { refs: [] },
      { refs: ["a.png", "b.png", "c.png", "d.png"] },
      { index: -1 },
      { frames: 400 },
      { token: "BAD!" },
      { prevFrame: "elsewhere.png [output]" },
      { prevFrame: undefined },
      { vocals: "v.txt [output]" },
    ])
      expect(
        () => normalizeSegmentParams(segParams(bad)),
        JSON.stringify(bad),
      ).toThrow(/music_video/);
    // first segment needs no previous frame
    expect(
      normalizeSegmentParams(segParams({ index: 0, prevFrame: undefined }))
        .prevFrame,
    ).toBeUndefined();
  });

  it("validates assemble params", () => {
    const ok = {
      clips: ["video/a.mp4 [output]", "video/b.mp4 [output]"],
      frames: [100, 20],
      song: "s.wav [input]",
    };
    expect(normalizeAssembleParams(ok).frames).toEqual([100, 20]);
    expect(() => normalizeAssembleParams({ ...ok, frames: [1] })).toThrow();
    expect(() =>
      normalizeAssembleParams({
        ...ok,
        clips: ["x.png [output]", "y.mp4 [output]"],
      }),
    ).toThrow();
  });

  it("builds per-segment jobs with chained last frames and lip-sync only with vocals", () => {
    const plan = planMusicVideo({
      duration: 20,
      beats: BEATS,
      bpm: 120,
      target: 5,
    });
    const files = { song: "s.mp3 [input]", images: ["a.png [input]"] };
    const opts = {
      style: "neon city",
      shots: ["close-up", "wide shot"],
      lipsync: [true, false],
      aspect: "16:9" as const,
      seed: 5,
    };
    const jobs = segmentJobs(plan, files, opts, TOKEN);
    expect(jobs).toHaveLength(plan.segments.length);
    expect(jobs[0].prevFrame).toBeUndefined();
    expect(jobs[0].vocals).toBeUndefined();
    expect(jobs[0].prompt).toContain("close-up.");
    expect(jobs[0].prompt).not.toContain("lips in sync");
    jobs
      .slice(1)
      .forEach((j, i) => expect(j.prevFrame).toBe(lastFrameRef(TOKEN, i)));
    expect(jobs.map((j) => j.seed)).toEqual(jobs.map((_, i) => 5 + i));
    for (const j of jobs) expect(() => normalizeSegmentParams(j)).not.toThrow();
    const withVocals = segmentJobs(
      plan,
      { ...files, vocals: "audio/v.flac [output]" },
      opts,
      TOKEN,
    );
    expect(withVocals[0].vocals).toBe("audio/v.flac [output]");
    expect(withVocals[0].prompt).toContain("lips in sync");
    expect(withVocals[1].vocals).toBeUndefined();
  });

  it("segment prompt tags the refs", () => {
    expect(segmentPrompt({ style: "", refs: 2 })).toContain(
      "<Picture 1>, <Picture 2>",
    );
    expect(segmentPrompt({ style: "x", refs: 0 })).toMatch(/^A music video\./);
  });
});

describe("builders", () => {
  it("are registered for the minimax pack", () => {
    const reg = registry as unknown as {
      actions: Record<string, { template?: string }>;
    };
    for (const a of [
      MUSIC_VIDEO_ACTION,
      MUSIC_VIDEO_ASSEMBLE_ACTION,
      MUSIC_VIDEO_STEMS_ACTION,
    ]) {
      expect(Object.hasOwn(ACTION_BUILDERS, a), a).toBe(true);
      expect(reg.actions[a]?.template, a).toBeTruthy();
      expect(JSON.stringify(getPack("minimax")?.workflows)).toContain(`${a}.json`);
    }
    expect(LIKENESS_TOOL_KEYS).toContain(MUSIC_VIDEO_KEY);
  });

  it("segment > 0: anchors the previous frame, drops it, slices guide + song", () => {
    const { workflow: w, seed } = buildMusicVideoWorkflow(
      load("music_video.json"),
      RUN,
      0,
      segParams(),
    );
    const N = MV_NODES;
    expect(seed).toBe(9);
    const r2v = w[N.r2v].inputs;
    expect([r2v.width, r2v.height, r2v.length]).toEqual([
      480,
      864,
      h3Frames(97),
    ]);
    expect(r2v["ref_images.ref_image_0"]).toEqual([N.ref0, 0]);
    expect(r2v["ref_images.ref_image_1"]).toEqual(["16", 0]);
    expect(w["16"].inputs.image).toBe("b.png [input]");
    expect(w[N.prevImage].inputs.image).toBe(lastFrameRef(TOKEN, 0));
    expect(w[N.guider].inputs.conditioning).toEqual([N.addGuide, 0]);
    expect(w[N.addGuide].inputs.frame_idx).toBe(0);
    // guide audio from frame 119 (song 4 + 119/24 s) over the rendered span
    expect(w[N.guideSlice].inputs).toMatchObject({
      audio: [N.song, 0],
      start_index: +(4 + 119 / 24).toFixed(3),
      duration: +(h3Frames(97) / 24).toFixed(3),
    });
    expect(w[N.kept].inputs).toMatchObject({ batch_index: 1, length: 96 });
    expect(w[N.songSlice].inputs).toMatchObject({
      start_index: 9,
      duration: 4,
    });
    expect(w[N.lastFrame].inputs).toMatchObject({ batch_index: 95, length: 1 });
    expect(w[N.lastSave].inputs.filename_prefix).toBe(
      "video/adrift_ctx/CJ_MTV_abc123def/seg02_last",
    );
    expect(w[N.lastSave]._meta).toMatchObject({ adrift_sidecar: true });
    expect(w[N.save].inputs.filename_prefix).toBe(
      "video/adrift_mtv/CJ_MTV_abc123def_seg02",
    );
    expect(w[N.freezeMask].inputs).toMatchObject({ width: 480, height: 864 });
  });

  it("segment 0 drops the guide image; vocals become the window-relative guide", () => {
    const { workflow: w } = buildMusicVideoWorkflow(
      load("music_video.json"),
      RUN,
      0,
      {
        ...segParams({
          index: 0,
          startFrame: 0,
          frames: 120,
          prevFrame: undefined,
        }),
        vocals: "audio/adrift_mtv/CJ_MTV_vocals_00001_.flac [output]",
      },
    );
    const N = MV_NODES;
    expect(w[N.prevImage]).toBeUndefined();
    expect(w[N.addGuide]).toBeUndefined();
    expect(w[N.guider].inputs.conditioning).toEqual([N.r2v, 0]);
    expect(w[N.r2v].inputs.length).toBe(124);
    expect(w["37"].inputs.audio).toMatch(/CJ_MTV_vocals/);
    expect(w[N.guideSlice].inputs).toMatchObject({
      audio: ["37", 0],
      start_index: 0,
    });
    expect(w[N.kept].inputs).toMatchObject({ batch_index: 0, length: 120 });
    // no dangling links
    for (const [id, node] of Object.entries(w))
      if (id !== "_meta")
      for (const v of Object.values(node.inputs))
        if (Array.isArray(v) && typeof v[0] === "string")
          expect(w[v[0]], String(v[0])).toBeDefined();
  });

  it("assemble chains the clips and lays the song slice under them", () => {
    const { workflow: w } = buildMusicVideoAssembleWorkflow(
      load("music_video_assemble.json"),
      RUN,
      0,
      {
        clips: [
          "video/a.mp4 [output]",
          "video/b.mp4 [output]",
          "video/c.mp4 [output]",
        ],
        frames: [120, 96, 24],
        song: "s.mp3 [input]",
        songStart: 2,
        token: TOKEN,
      },
    );
    expect(w["1"].inputs).toMatchObject({
      video: "video/a.mp4 [output]",
      frame_load_cap: 120,
      force_rate: MV_FPS,
    });
    expect(w["10"].inputs).toMatchObject({
      video: "video/b.mp4 [output]",
      frame_load_cap: 96,
    });
    expect(w["13"].class_type).toBe("ImageBatch");
    expect(w["4"].inputs.images).toEqual(["13", 0]);
    expect(w["3"].inputs).toMatchObject({ start_index: 2, duration: 10 });
    expect(w["5"].inputs.filename_prefix).toBe(
      `video/adrift_mtv/CJ_MTV_${TOKEN}`,
    );
  });

  it("stems trims the window", () => {
    const { workflow: w } = buildMusicVideoStemsWorkflow(
      load("music_video_stems.json"),
      RUN,
      0,
      {
        song: "s.mp3 [input]",
        songStart: 3,
        seconds: 12,
      },
    );
    expect(w["2"].inputs).toMatchObject({ start_index: 3, duration: 12 });
    expect(w["3"].class_type).toBe("CJAudioStems");
    expect(() =>
      buildMusicVideoStemsWorkflow(load("music_video_stems.json"), RUN, 0, {
        song: "s.mp3 [input]",
      }),
    ).toThrow(/music_video_stems/);
  });
});

describe("runner (mock fetch)", () => {
  function mockFetch(stems = false) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200 });
      if (url === "/api/comfy/upload")
        return json({ ref: `${body.filename} [input]` });
      if (url === "/api/jobs/seed-run")
        return json({ run: { run_id: "seed", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action") {
        n++;
        return json({
          run: { run_id: `r${n}`, jobs: [{ index: 0, prompt_id: `p${n}` }] },
          prompt_id: `p${n}`,
        });
      }
      if (url.startsWith("/api/comfy/history/")) {
        const file = (filename: string, subfolder: string) => ({
          filename,
          subfolder,
          type: "output",
          url: `/api/comfy/view?filename=${filename}&subfolder=${subfolder}&type=output`,
        });
        return json(
          stems
            ? {
                status: "completed",
                videos: [],
                images: [],
                audios: [
                  file("CJ_MTV_drums_00001_.flac", "audio/adrift_mtv"),
                  file("CJ_MTV_vocals_00001_.flac", "audio/adrift_mtv"),
                ],
              }
            : {
                status: "completed",
                videos: [file(`CJ_MTV_${n}_00001_.mp4`, "video/adrift_mtv")],
                images: [],
                audios: [],
              },
        );
      }
      return new Response("nope", { status: 404 });
    };
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  const deps = (fetchImpl: typeof fetch) => ({
    fetchImpl,
    clientId: "c",
    pollMs: 0,
    sleep: async () => {},
    measure: async () => 10,
  });

  it("renders segments in order, chaining last frames, then assembles", async () => {
    const { calls, fetchImpl } = mockFetch();
    const plan = planMusicVideo({
      duration: 30,
      start: 0,
      seconds: 12,
      beats: BEATS,
      bpm: 120,
      target: 5,
    });
    expect(plan.segments.length).toBe(2);
    const seen: string[] = [];
    const res = await runMusicVideo(
      {
        songRef: "cj_audio_s.mp3 [input]",
        refs: [{ dataUrl: "data:image/png;base64,AA" }],
        plan,
      },
      { style: "glam rock", aspect: "16:9", seed: 1 },
      deps(fetchImpl),
      (p) => seen.push(`${p.phase}${p.index ?? ""}${p.clip ? "+" : ""}`),
    );
    const acts = calls
      .filter((c) => c.url === "/api/jobs/action")
      .map((c) => c.body);
    expect(acts.map((a) => a.action)).toEqual([
      MUSIC_VIDEO_ACTION,
      MUSIC_VIDEO_ACTION,
      MUSIC_VIDEO_ASSEMBLE_ACTION,
    ]);
    const [s0, s1, asm] = acts.map((a) => a.params as Record<string, unknown>);
    expect(s0.prevFrame).toBeUndefined();
    expect(s1.prevFrame).toBe(lastFrameRef(s0.token as string, 0));
    expect(asm.clips).toEqual(res.segments.map((s) => s.ref));
    expect(asm.frames).toEqual(plan.segments.map((s) => s.frames));
    expect(res.video.seconds).toBe(10);
    expect(seen).toEqual([
      "upload",
      "segment0",
      "segment0+",
      "segment1",
      "segment1+",
      "assemble",
    ]);
  });

  it("stems step returns the drum + vocal stems", async () => {
    const { calls, fetchImpl } = mockFetch(true);
    const st = await runMusicVideoStems(
      "s.mp3 [input]",
      { start: 2, seconds: 12 },
      deps(fetchImpl),
    );
    expect(st.drums?.ref).toBe(
      "audio/adrift_mtv/CJ_MTV_drums_00001_.flac [output]",
    );
    expect(st.vocals?.ref).toBe(
      "audio/adrift_mtv/CJ_MTV_vocals_00001_.flac [output]",
    );
    const act = calls.find((c) => c.url === "/api/jobs/action")!.body;
    expect(act).toMatchObject({
      action: MUSIC_VIDEO_STEMS_ACTION,
      params: { songStart: 2, seconds: 12 },
    });
  });

  it("needs a reference and explains a missing stems node", async () => {
    const { fetchImpl } = mockFetch();
    const plan = planMusicVideo({ duration: 6, beats: [], bpm: 120 });
    await expect(
      runMusicVideo(
        { songRef: "s.mp3 [input]", refs: [], plan },
        { style: "", aspect: "1:1" },
        deps(fetchImpl),
      ),
    ).rejects.toThrow(/character or style image/);
    expect(
      musicVideoError(new Error("node CJAudioStems does not exist")).message,
    ).toMatch(/cj_stems/);
    expect(stemOf("CJ_MTV_bass_00001_.flac")).toBeNull();
  });
});

describe("hub card", () => {
  const ctx = (ids: string[] | null) =>
    ({ packIds: ids ? new Set(ids) : undefined }) as unknown as EngineContext;

  it("is gated on the MiniMax pack and its models", () => {
    expect(musicVideoCard(ctx(null)).checking).toBe(true);
    expect(musicVideoCard(ctx([])).available).toBe(false);
    expect(musicVideoCard(ctx(["minimax"])).available).toBe(true);
    const missing = musicVideoCard(ctx(["minimax"]), {
      tools: {
        music_video: {
          missing: ["minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
        },
      },
    });
    expect(missing.available).toBe(false);
    expect(missing.unavailableReason).toMatch(/Missing/);
  });

  it("stems are optional and only on when model-status says so", () => {
    expect(stemsAvailable(null)).toBe(false);
    expect(
      stemsAvailable({
        tools: { music_video_stems: { missing: ["node:CJAudioStems"] } },
      }),
    ).toBe(false);
    expect(
      stemsAvailable({ tools: { music_video_stems: { missing: [] } } }),
    ).toBe(true);
  });
});
