// @vitest-environment node
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import { showToast } from "@/components/Toast";
import {
  buildFreezeArgs,
  buildProbeArgs,
  buildReverseArgs,
  MAX_REVERSE_SECONDS,
  parseProbe,
} from "@/lib/videoEdit/ffmpegArgs";
import { parseDeriveRequest } from "@/lib/videoEdit/requests";
import {
  clipLength,
  timelineDuration,
  updateClip,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import { workMediaUrl } from "@/lib/videoEdit/sourceRef";
import { useVideoEditStore } from "@/store/videoEditStore";
import { freezeAt, reverseClip } from "@/components/editor/video/clipOps";
import { VideoClipPanel } from "@/components/editor/video/VideoClipPanel";

const v = workMediaUrl("uploads/a.mp4");

describe("parseDeriveRequest", () => {
  it("accepts reverse and freeze", () => {
    expect(
      parseDeriveRequest({ op: "reverse", video: v, in: 1, out: 3 }),
    ).toMatchObject({
      ok: true,
      value: { op: "reverse", in: 1, out: 3, video: { kind: "work" } },
    });
    expect(
      parseDeriveRequest({ op: "freeze", video: v, t: 2, seconds: 2 }),
    ).toMatchObject({
      ok: true,
      value: { op: "freeze", t: 2, seconds: 2, fps: 0 },
    });
  });

  it("rejects bad input", () => {
    const bad = [
      null,
      { op: "reverse", video: "/etc/passwd", in: 0, out: 1 },
      { op: "spin", video: v },
      { op: "reverse", video: v, in: 2, out: 2 },
      { op: "reverse", video: v, in: 0, out: MAX_REVERSE_SECONDS + 1 },
      { op: "freeze", video: v, t: -1, seconds: 2 },
      { op: "freeze", video: v, t: 1, seconds: 0 },
      { op: "freeze", video: v, t: 1, seconds: 11 },
      { op: "freeze", video: v, t: 1, seconds: 2, fps: 500 },
    ];
    for (const b of bad) expect(parseDeriveRequest(b).ok).toBe(false);
    expect(parseDeriveRequest({ op: "x", video: v })).toEqual({
      ok: false,
      error: "op must be reverse or freeze",
    });
  });
});

describe("derive ffmpeg args", () => {
  it("reverse cuts the range and flips picture and sound", () => {
    const a = buildReverseArgs("/s.mp4", 1, 3.5, "/o.mp4", true);
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4)).toEqual([
      "-ss",
      "1.000",
      "-t",
      "2.500",
    ]);
    expect(a[a.indexOf("-vf") + 1]).toBe("reverse,format=yuv420p");
    expect(a[a.indexOf("-af") + 1]).toBe("areverse");
    expect(a.at(-1)).toBe("/o.mp4");
    const silent = buildReverseArgs("/s.mp4", 0, 1, "/o.mp4", false);
    expect(silent).toContain("-an");
    expect(silent).not.toContain("-af");
  });

  it("freeze holds one frame for the length at the rate", () => {
    const a = buildFreezeArgs("/s.mp4", 2, 3, 30, "/o.mp4");
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf).toContain("trim=end_frame=1");
    expect(vf).toContain("tpad=stop_mode=clone");
    expect(vf).toContain("fps=30");
    expect(a[a.indexOf("-t") + 1]).toBe("3.000");
    expect(a).toContain("-an");
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-derive-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!ffmpeg || !ffprobe || !fs.existsSync(ffprobe))(
  "real reverse / freeze",
  () => {
    const run = (bin: string, args: string[]) => {
      const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0) throw new Error(r.stderr.slice(-800));
      return r.stdout;
    };
    const probe = (p: string) =>
      parseProbe(JSON.parse(run(ffprobe!, buildProbeArgs(p))))!;

    it("makes playable clips of the right length", () => {
      const src = path.join(tmp, "src.mp4");
      run(ffmpeg!, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=24:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        src,
      ]);
      const rev = path.join(tmp, "rev.mp4");
      run(ffmpeg!, buildReverseArgs(src, 0.5, 1.5, rev, true));
      const pr = probe(rev);
      expect(pr).toMatchObject({ width: 320, height: 180, hasAudio: true });
      expect(pr.duration).toBeGreaterThan(0.9);
      expect(pr.duration).toBeLessThan(1.15);

      const frz = path.join(tmp, "frz.mp4");
      run(ffmpeg!, buildFreezeArgs(src, 1.9, 2, 30, frz));
      const pf = probe(frz);
      expect(pf).toMatchObject({ width: 320, hasAudio: false, fps: 30 });
      expect(pf.duration).toBeGreaterThan(1.9);
      expect(pf.duration).toBeLessThan(2.1);
    }, 60_000);
  },
);

const S = () => useVideoEditStore.getState();
const source: VideoSource = {
  url: v,
  duration: 4,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
};
const derived = (duration: number, hasAudio: boolean) => ({
  ok: true,
  url: workMediaUrl("uploads/d.mp4"),
  file: "uploads/d.mp4",
  info: { duration, width: 1280, height: 720, fps: 24, hasAudio },
});

describe("clip ops", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    S().closeProject();
    S().openProject(source, "Shot");
    vi.mocked(showToast).mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reverse swaps the source and keeps the clip's fx", async () => {
    const id = S().edit!.clips[0].id;
    S().apply((e) =>
      ({ ...e, clips: e.clips.map((c) => ({ ...c, in: 1, out: 3 })) }),
    );
    S().apply((e) => updateClip(e, id, { speed: 2, volume: 0.5 }));
    const before = S().edit!.clips[0];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(derived(before.out - before.in, true))),
    );
    expect(await reverseClip(id)).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      op: "reverse",
      video: v,
      in: before.in,
      out: before.out,
    });
    const c = S().edit!.clips[0];
    expect(c).toMatchObject({
      id,
      in: 0,
      out: before.out - before.in,
      speed: 2,
      volume: 0.5,
      label: "Shot (reversed)",
    });
    expect(c.src.url).toBe(workMediaUrl("uploads/d.mp4"));
    S().undo();
    expect(S().edit!.clips[0].src.url).toBe(v);
  });

  it("reverse refuses long clips without calling the server", async () => {
    S().closeProject();
    S().openProject({ ...source, duration: 30 }, "Long");
    expect(await reverseClip(S().edit!.clips[0].id)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });

  it("freeze inserts a still at the playhead and grows the timeline", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(derived(2, false))),
    );
    expect(await freezeAt(1.5, 2)).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      op: "freeze",
      video: v,
      t: 1.5,
      seconds: 2,
      fps: 24,
    });
    const e = S().edit!;
    expect(e.clips.map((c) => c.label)).toEqual([
      "Shot",
      "Shot freeze",
      "Shot",
    ]);
    expect(clipLength(e.clips[0])).toBeCloseTo(1.5);
    expect(timelineDuration(e)).toBeCloseTo(6);
  });

  it("server errors leave the edit alone and toast", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "boom" }), {
        status: 500,
      }),
    );
    const before = S().edit;
    expect(await freezeAt(1, 2)).toBe(false);
    expect(S().edit).toBe(before);
    expect(vi.mocked(showToast).mock.calls[0][0]).toContain("boom");
  });

  it("clip panel shows reverse and freeze controls", () => {
    S().selectClip(S().edit!.clips[0].id);
    Object.assign(
      useVideoEditStore.getInitialState(),
      useVideoEditStore.getState(),
    );
    const html = renderToStaticMarkup(
      (<VideoClipPanel />) as React.ReactElement,
    );
    expect(html).toContain('data-testid="video-clip-timeops"');
    expect(html).toContain("Reverse");
    expect(html).toContain(
      'aria-label="Freeze frame: hold 2 s at the playhead"',
    );
  });
});
