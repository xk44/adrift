import { execFileSync } from "child_process";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  badSegment,
  buildQcArgs,
  evaluateQc,
  expectationsFromGraph,
  expectationsFromParams,
  fmtTime,
  mergeExpect,
  parseQcStderr,
  reseedGraph,
  shouldAutoReroll,
  type QcDetections,
  type QcProbe,
} from "@/lib/videoQc/qc";
import {
  DEFAULT_VIDEO_QC,
  resolveVideoQcSettings,
  sanitizeVideoQcSettings,
} from "@/lib/videoQc/settings";

// Recorded from ffmpeg 8/9 on a clip with 2-3.5s black, 3.5-5.5s frozen,
// audio silent after 3s (7s total).
const STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'synth.mp4':
  Duration: 00:00:07.00, start: 0.000000, bitrate: 151 kb/s
[Parsed_scdet_3 @ 0x7b5d032f40] lavfi.scd.score: 40.799, lavfi.scd.time: 2
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_start: 2
[Parsed_silencedetect_0 @ 0x7b5d031ec0] silence_start: 3.000499
[Parsed_blackdetect_1 @ 0x7b5d032dc0] black_start:2 black_end:3.5 black_duration:1.5
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_duration: 1.5
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_end: 3.5
[Parsed_scdet_3 @ 0x7b5d032f40] lavfi.scd.score: 43.005, lavfi.scd.time: 3.5
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_start: 3.5
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_duration: 2
[Parsed_freezedetect_2 @ 0x7b5d032e80] lavfi.freezedetect.freeze_end: 5.5
[Parsed_scdet_3 @ 0x7b5d032f40] lavfi.scd.score: 26.059, lavfi.scd.time: 5.541667
[Parsed_silencedetect_0 @ 0x7b5d031ec0] silence_end: 7 | silence_duration: 3.999501
[out#0/null @ 0x7b5d031a40] video:3kB audio:328kB subtitle:0kB`;

const T = DEFAULT_VIDEO_QC;
const PROBE: QcProbe = {
  duration: 7,
  width: 320,
  height: 240,
  fps: 24,
  hasAudio: true,
};
const NONE: QcDetections = { black: [], freeze: [], jumps: [], silence: [] };

describe("parseQcStderr", () => {
  it("reads black, freeze, scene and silence lines", () => {
    const d = parseQcStderr(STDERR, 7);
    expect(d.black).toEqual([{ start: 2, end: 3.5 }]);
    expect(d.freeze).toEqual([
      { start: 2, end: 3.5 },
      { start: 3.5, end: 5.5 },
    ]);
    expect(d.jumps).toEqual([
      { time: 2, score: 40.799 },
      { time: 3.5, score: 43.005 },
      { time: 5.542, score: 26.059 },
    ]);
    expect(d.silence).toEqual([{ start: 3, end: 7 }]);
  });

  it("closes spans still open at EOF at the duration", () => {
    const d = parseQcStderr(
      [
        "[Parsed_freezedetect_2 @ 0x1] lavfi.freezedetect.freeze_start: 4.2",
        "[Parsed_silencedetect_0 @ 0x2] silence_start: -0.01",
      ].join("\n"),
      6,
    );
    expect(d.freeze).toEqual([{ start: 4.2, end: 6 }]);
    expect(d.silence).toEqual([{ start: 0, end: 6 }]);
    expect(parseQcStderr("silence_start: 1", 0).silence).toEqual([]);
  });

  it("ignores unrelated output", () => {
    expect(parseQcStderr("frame= 168 fps=0.0 q=-0.0 size=N/A\n", 7)).toEqual(
      NONE,
    );
  });
});

describe("buildQcArgs", () => {
  it("one pass, audio filter only when there is audio", () => {
    const a = buildQcArgs("/x.mp4", T, true);
    expect(a.join(" ")).toContain(
      "blackdetect=d=0.3:pix_th=0.1,freezedetect=n=-60dB:d=1,scdet=threshold=14",
    );
    expect(a.join(" ")).toContain("silencedetect=n=-50dB:d=2");
    expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(buildQcArgs("/x.mp4", T, false).join(" ")).not.toContain("0:a:0");
  });
});

describe("evaluateQc", () => {
  it("synthetic clip: black + freeze + one real jump warn", () => {
    const r = evaluateQc(PROBE, parseQcStderr(STDERR, 7), {}, T);
    expect(r.status).toBe("warn");
    const kinds = r.issues.map((i) => `${i.kind}@${i.start}`);
    // Freeze inside the black span and jumps at black edges are not repeated.
    expect(kinds).toEqual(["black@2", "freeze@3.5", "jump@5.542"]);
    // Silence is ignored when the tool isn't expected to have sound.
    expect(r.issues.some((i) => i.kind === "silence")).toBe(false);
  });

  it("passes a clean clip", () => {
    expect(evaluateQc(PROBE, NONE, {}, T)).toMatchObject({
      status: "pass",
      issues: [],
    });
  });

  it("fails an unreadable file", () => {
    const r = evaluateQc(null, NONE, {}, T);
    expect(r.status).toBe("fail");
    expect(r.issues[0].kind).toBe("unreadable");
  });

  it("fails when black / frozen / jumps pass their limits", () => {
    expect(
      evaluateQc(PROBE, { ...NONE, black: [{ start: 0, end: 3 }] }, {}, T)
        .status,
    ).toBe("fail");
    expect(
      evaluateQc(PROBE, { ...NONE, freeze: [{ start: 1, end: 5 }] }, {}, T)
        .status,
    ).toBe("fail");
    const jumps = [1, 2.5, 4].map((time) => ({ time, score: 50 }));
    expect(evaluateQc(PROBE, { ...NONE, jumps }, {}, T).status).toBe("fail");
    expect(
      evaluateQc(PROBE, { ...NONE, jumps: jumps.slice(0, 2) }, {}, T).status,
    ).toBe("warn");
  });

  it("drops low scores and jumps at stitch seams", () => {
    const det = {
      ...NONE,
      jumps: [
        { time: 3, score: 60 },
        { time: 4, score: 5 },
      ],
    };
    expect(evaluateQc(PROBE, det, { seams: [3.1] }, T).status).toBe("pass");
  });

  it("audio checks run only for tools that should have sound", () => {
    const silent = { ...NONE, silence: [{ start: 0, end: 7 }] };
    expect(evaluateQc(PROBE, silent, { audio: true }, T).issues).toEqual([
      expect.objectContaining({ kind: "silence", severity: "fail" }),
    ]);
    const part = { ...NONE, silence: [{ start: 3, end: 7 }] };
    expect(evaluateQc(PROBE, part, { audio: true }, T).status).toBe("warn");
    const noTrack = evaluateQc(
      { ...PROBE, hasAudio: false },
      NONE,
      { audio: true },
      T,
    );
    expect(noTrack.issues[0]).toMatchObject({
      kind: "no_audio",
      severity: "fail",
    });
  });

  it("compares duration, fps and size with the request", () => {
    // 97 frames @ 24 fps = 4.04s; 7s is way over.
    const long = evaluateQc(PROBE, NONE, { frames: 97, fps: 24 }, T);
    expect(long.issues.map((i) => i.kind)).toEqual(["duration"]);
    expect(long.status).toBe("warn");
    // Off by one frame is fine.
    expect(
      evaluateQc({ ...PROBE, duration: 4 }, NONE, { frames: 97, fps: 24 }, T)
        .status,
    ).toBe("pass");
    expect(
      evaluateQc({ ...PROBE, duration: 1.5 }, NONE, { duration: 5 }, T).status,
    ).toBe("fail");
    expect(
      evaluateQc(PROBE, NONE, { fps: 16 }, T).issues.map((i) => i.kind),
    ).toEqual(["fps"]);
    expect(
      evaluateQc(PROBE, NONE, { width: 640, height: 480 }, T).issues[0].kind,
    ).toBe("resolution");
    // Upscaled with the same shape is fine.
    expect(evaluateQc(PROBE, NONE, { width: 160, height: 120 }, T).status).toBe(
      "pass",
    );
  });
});

describe("expectations", () => {
  it("reads fps, frames, size and wired audio from the graph", () => {
    const graph = {
      "1": {
        class_type: "EmptyHunyuanLatentVideo",
        inputs: { width: 832, height: 480, length: 81 },
      },
      "2": { class_type: "CreateVideo", inputs: { fps: 16, images: ["9", 0] } },
      "3": {
        class_type: "SaveVideo",
        inputs: { video: ["2", 0], audio: ["7", 0] },
      },
    };
    expect(expectationsFromGraph(graph)).toEqual({
      fps: 16,
      frames: 81,
      width: 832,
      height: 480,
      audio: true,
    });
  });

  it("leaves size/frames unchecked with several latent nodes", () => {
    const graph = {
      "1": { class_type: "WanImageToVideo", inputs: { width: 1, height: 1 } },
      "2": { class_type: "WanImageToVideo", inputs: { width: 2, height: 2 } },
    };
    expect(expectationsFromGraph(graph)).toEqual({});
    expect(expectationsFromGraph(null)).toEqual({});
  });

  const stitch = {
    clips: [
      { video: "a/one.mp4 [output]", seconds: 3 },
      { video: "a/two.mp4 [output]", seconds: 4 },
      { video: "three.mp4 [output]", seconds: 2 },
    ],
    transition: "fade",
    fadeSeconds: 0.5,
    audio: true,
  };

  it("stitch params give seams, duration and audio", () => {
    expect(expectationsFromParams(stitch)).toEqual({
      seams: [2.5, 6],
      duration: 8,
      audio: true,
    });
    expect(
      mergeExpect({ fps: 24 }, expectationsFromParams(stitch)),
    ).toMatchObject({ fps: 24, seams: [2.5, 6], audio: true });
  });

  it("maps the worst timed issue to its source clip", () => {
    const issues = [
      {
        kind: "jump" as const,
        severity: "warn" as const,
        start: 1,
        end: 1,
        message: "",
      },
      {
        kind: "freeze" as const,
        severity: "fail" as const,
        start: 3,
        end: 5,
        message: "",
      },
    ];
    expect(badSegment({ issues }, stitch)).toEqual({
      index: 1,
      video: "a/two.mp4 [output]",
    });
    expect(badSegment({ issues }, { clips: [] })).toBeNull();
    expect(badSegment({ issues: [] }, stitch)).toBeNull();
  });
});

describe("reseedGraph", () => {
  it("replaces literal seeds only, without touching the input", () => {
    const graph = {
      "3": { class_type: "KSampler", inputs: { seed: 5, steps: 20 } },
      "10": { class_type: "RandomNoise", inputs: { noise_seed: 7 } },
      "11": { class_type: "KSampler", inputs: { seed: ["12", 0] } },
    };
    const r = reseedGraph(graph, () => 0.5);
    expect(r.changed).toBe(2);
    expect(r.seed).toBe(2 ** 47);
    const g = r.graph as typeof graph;
    expect(g["3"].inputs.seed).toBe(2 ** 47);
    expect(g["10"].inputs.noise_seed).toBe(2 ** 47);
    expect(g["11"].inputs.seed).toEqual(["12", 0]);
    expect(graph["3"].inputs.seed).toBe(5);
  });

  it("never keeps the old seed", () => {
    const r = reseedGraph({ "1": { inputs: { seed: 0 } } }, () => 0);
    expect((r.graph["1"] as { inputs: { seed: number } }).inputs.seed).toBe(1);
    expect(reseedGraph({ "1": { inputs: { steps: 4 } } }).changed).toBe(0);
  });
});

describe("shouldAutoReroll", () => {
  const on = { autoReroll: true, maxTries: 2 };
  it("only failed clips, while tries remain, once per clip", () => {
    expect(shouldAutoReroll("fail", 1, on, false)).toBe(true);
    expect(shouldAutoReroll("fail", 2, on, false)).toBe(true);
    expect(shouldAutoReroll("fail", 3, on, false)).toBe(false);
    expect(shouldAutoReroll("warn", 1, on, false)).toBe(false);
    expect(shouldAutoReroll("fail", 1, on, true)).toBe(false);
    expect(
      shouldAutoReroll("fail", 1, { autoReroll: false, maxTries: 5 }, false),
    ).toBe(false);
  });
});

describe("video QC settings", () => {
  it("defaults: on, auto re-roll off", () => {
    expect(resolveVideoQcSettings(null)).toMatchObject({
      enabled: true,
      autoReroll: false,
      maxTries: 2,
    });
  });

  it("keeps valid non-default keys, clamped", () => {
    expect(
      sanitizeVideoQcSettings({
        autoReroll: true,
        maxTries: 9.4,
        jumpFailCount: 4.4,
        blackPixel: 0.1,
        silenceDb: "x",
        bogus: 1,
      }),
    ).toEqual({ autoReroll: true, maxTries: 5, jumpFailCount: 4 });
    expect(sanitizeVideoQcSettings({ enabled: true })).toBeNull();
    expect(sanitizeVideoQcSettings([])).toBeNull();
  });

  it("formats timestamps", () => {
    expect(fmtTime(3.04)).toBe("3s");
    expect(fmtTime(62.34)).toBe("1:02.3");
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-filters"], { stdio: "pipe" });
    execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasFfmpeg())("real ffmpeg pass", () => {
  it("finds the black and frozen stretches in a synthetic clip", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "videoqc-"));
    const clip = path.join(dir, "synth.mp4");
    const src = "s=320x240:r=24";
    // 0-2 moving, 2-3.5 black, 3.5-5.5 one still frame, 5.5-7 moving;
    // a tone for 3s then silence.
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=${src}:d=2`,
        "-f",
        "lavfi",
        "-i",
        `color=c=black:${src}:d=1.5`,
        "-f",
        "lavfi",
        "-i",
        `color=c=0x3366cc:${src}:d=2`,
        "-f",
        "lavfi",
        "-i",
        `testsrc2=${src}:d=1.5`,
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:d=3",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono:d=4",
        "-filter_complex",
        "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[2:v]format=yuv420p[c];[3:v]format=yuv420p[d];" +
          "[a][b][c][d]concat=n=4:v=1:a=0[v];[4:a]aresample=44100,aformat=channel_layouts=mono[s];[s][5:a]concat=n=2:v=0:a=1[au]",
        "-map",
        "[v]",
        "-map",
        "[au]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clip,
      ],
      { stdio: "pipe" },
    );
    // Runtime settings / DB are not touched by analyzeVideoFile.
    const { analyzeVideoFile } = await import("@/lib/videoQc/server");
    const r = await analyzeVideoFile(clip, T, { audio: true, fps: 24 });
    expect(r.probe?.duration).toBeCloseTo(7, 0);
    const black = r.issues.find((i) => i.kind === "black");
    expect(black?.start).toBeCloseTo(2, 1);
    expect(black?.end).toBeCloseTo(3.5, 1);
    const freeze = r.issues.find((i) => i.kind === "freeze");
    expect(freeze?.start).toBeCloseTo(3.5, 1);
    expect(freeze?.end).toBeCloseTo(5.5, 1);
    const silence = r.issues.find((i) => i.kind === "silence");
    expect(silence?.start).toBeCloseTo(3, 0);
    expect(r.status).toBe("warn");
  }, 60_000);
});
