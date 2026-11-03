/**
 * Accepting a tool result: keep the range's original sound and the edit's
 * frame rate (plan defaults, request parsing, ffmpeg argv + a real run,
 * the place flow and the result card).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import { conformPlan } from "@/lib/videoEdit/conform";
import {
  clipFromSource,
  splitAt,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  INPUT_GUARD,
  buildConformArgs,
  buildProbeArgs,
  parseProbe,
} from "@/lib/videoEdit/ffmpegArgs";
import { parseConformRequest } from "@/lib/videoEdit/requests";
import { workMediaUrl } from "@/lib/videoEdit/sourceRef";
import { useVideoEditStore, type VideoResult } from "@/store/videoEditStore";
import {
  VideoResultsPanel,
  placeResult,
  resultConform,
} from "@/components/editor/video/VideoPanels";

const src = (
  name: string,
  duration: number,
  fps = 24,
  hasAudio = true,
): VideoSource => ({
  url: workMediaUrl(`uploads/${name}.mp4`),
  duration,
  width: 1280,
  height: 720,
  fps,
  hasAudio,
});

const edit = (...sources: VideoSource[]): EditList => ({
  v: 1,
  clips: sources.map((s) => clipFromSource(s, "c")),
});

const result = (over: Partial<VideoResult> = {}): VideoResult => ({
  id: "run:0",
  title: "Upscale",
  runId: "run",
  jobIndex: 0,
  start: 1,
  end: 3,
  cutUrl: workMediaUrl("renders/cut_1.mp4"),
  kind: "video",
  url: "/out.mp4",
  source: src("out", 2, 16, false),
  at: 1,
  ...over,
});

describe("conformPlan", () => {
  it("keeps the range's sound and rate under a silent 16 fps result", () => {
    const p = conformPlan(edit(src("a", 5)), 1, 3, src("o", 2, 16, false));
    expect(p).toEqual({
      rangeHasAudio: true,
      keepAudio: true,
      editFps: 24,
      fpsDiffers: true,
      matchFps: true,
    });
  });

  it("leaves a result's own sound and a smoothing pass alone", () => {
    const p = conformPlan(edit(src("a", 5)), 1, 3, src("o", 2, 48, true));
    expect(p.keepAudio).toBe(false);
    expect(p.rangeHasAudio).toBe(true);
    expect(p.fpsDiffers).toBe(true);
    expect(p.matchFps).toBe(false);
  });

  it("has no sound to keep from muted or silent clips", () => {
    const e = edit(src("a", 5, 24, false));
    expect(conformPlan(e, 0, 2, src("o", 2)).rangeHasAudio).toBe(false);
    const m = edit(src("a", 5));
    m.clips[0] = { ...m.clips[0], muted: true };
    expect(conformPlan(m, 0, 2, src("o", 2, 24)).rangeHasAudio).toBe(false);
    expect(conformPlan(m, 0, 2, src("o", 2, 24)).fpsDiffers).toBe(false);
  });

  it("reads the rate where the range starts, and handles an insert point", () => {
    const e = edit(src("a", 2, 24), src("b", 2, 30));
    expect(conformPlan(e, 2.5, 3, src("o", 1, 30)).fpsDiffers).toBe(false);
    expect(conformPlan(e, 2, 2, src("o", 1, 30)).editFps).toBe(30);
  });

  it("user choices override the defaults", () => {
    const e = edit(src("a", 5));
    expect(resultConform(e, result())).toMatchObject({
      keepAudio: true,
      matchFps: 24,
    });
    expect(
      resultConform(e, result({ keepAudio: false, matchFps: false })),
    ).toMatchObject({ keepAudio: false, matchFps: null });
  });

  it("an insert (bridge) has no cut sound to keep, even when ticked", () => {
    const e = edit(src("a", 2), src("b", 2));
    const bridge = result({ start: 2, end: 2, cutUrl: "", keepAudio: true });
    const c = resultConform(e, bridge);
    expect(c.keepAudio).toBe(false);
    expect(c.plan?.rangeHasAudio).toBe(false);
    expect(c.matchFps).toBe(24);
  });
});

describe("parseConformRequest", () => {
  const v = workMediaUrl("uploads/a.mp4");
  it("accepts audio and / or fps", () => {
    expect(parseConformRequest({ video: v, audio: v })).toMatchObject({
      ok: true,
      value: { fps: 0 },
    });
    expect(parseConformRequest({ video: v, fps: 24 })).toMatchObject({
      ok: true,
      value: { audio: null, fps: 24 },
    });
  });
  it.each([
    [{}, "video"],
    [{ video: "/etc/passwd.mp4", fps: 24 }, "video"],
    [{ video: v, audio: "../x.mp4" }, "audio"],
    [{ video: v, fps: 500 }, "fps"],
    [{ video: v, fps: "24" }, "fps"],
    [{ video: v }, "nothing"],
  ])("rejects %j", (body, word) => {
    const r = parseConformRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(word);
  });
});

describe("buildConformArgs", () => {
  it("copies the picture and lays the cut's sound under it", () => {
    const args = buildConformArgs("/w/v b.mp4", "/w/out.mp4", {
      duration: 2.5,
      audioPath: "/w/cut;rm.mp4",
      copyVideo: true,
    });
    expect(args).toContain("/w/v b.mp4");
    expect(args).toContain("/w/cut;rm.mp4");
    expect(args.filter((a) => a === INPUT_GUARD[1])).toHaveLength(2);
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0 -c:v copy");
    expect(args).toContain("aresample=48000,aformat=channel_layouts=stereo,apad");
    expect(args.slice(-5)).toEqual([
      "-t",
      "2.500",
      "-movflags",
      "+faststart",
      "/w/out.mp4",
    ]);
  });

  it("re-times when asked (re-encoding, keeping the result's own sound)", () => {
    const args = buildConformArgs("/w/v.webm", "/w/o.mp4", {
      duration: 2,
      fps: 29.97,
      copyVideo: true,
    });
    expect(args).toContain("fps=30000/1001,format=yuv420p");
    expect(args).not.toContain("copy");
    expect(args.join(" ")).toContain("-map 0:a:0?");
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const haveFfmpeg = !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-conform-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!haveFfmpeg)("real ffmpeg conform", () => {
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r.stdout;
  };
  const probe = (p: string) =>
    parseProbe(JSON.parse(run(ffprobe!, buildProbeArgs(p))))!;

  it("puts a shorter cut's sound under a silent 16 fps result at 24 fps", () => {
    const silent = path.join(tmp, "res.mp4");
    const cut = path.join(tmp, "cut.mp4");
    run(ffmpeg!, [
      "-hide_banner", "-y", "-f", "lavfi",
      "-i", "testsrc=size=160x90:rate=16:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent,
    ]);
    run(ffmpeg!, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", cut,
    ]);
    const out = path.join(tmp, "conformed.mp4");
    run(
      ffmpeg!,
      buildConformArgs(silent, out, {
        duration: probe(silent).duration,
        audioPath: cut,
        fps: 24,
        copyVideo: true,
      }),
    );
    const po = probe(out);
    expect(po).toMatchObject({ fps: 24, hasAudio: true, width: 160 });
    // The picture's length; the 2 s of sound is padded with silence.
    expect(po.duration).toBeGreaterThan(2.9);
    expect(po.duration).toBeLessThan(3.1);

    const copied = path.join(tmp, "copied.mp4");
    run(
      ffmpeg!,
      buildConformArgs(silent, copied, {
        duration: probe(silent).duration,
        audioPath: cut,
        copyVideo: true,
      }),
    );
    expect(probe(copied)).toMatchObject({ fps: 16, hasAudio: true });
  }, 60_000);
});

const S = () => useVideoEditStore.getState();
const render = (el: React.ReactElement) => {
  Object.assign(
    useVideoEditStore.getInitialState(),
    useVideoEditStore.getState(),
  );
  return renderToStaticMarkup(el);
};

describe("placing a result", () => {
  beforeEach(() => {
    S().closeProject();
    S().openProject(src("a", 5), "Shot");
    vi.unstubAllGlobals();
  });

  it("conforms first, then replaces the range with the conformed clip", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        video: src("out", 2).url,
        audio: workMediaUrl("renders/cut_1.mp4"),
        fps: 24,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          url: workMediaUrl("uploads/conf.mp4"),
          info: { duration: 2, width: 1280, height: 720, fps: 24, hasAudio: true },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    S().addResult(result());
    expect(await placeResult(S().results[0], "replace")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const clips = S().edit!.clips;
    expect(clips).toHaveLength(3);
    expect(clips[1].src).toMatchObject({
      url: workMediaUrl("uploads/conf.mp4"),
      fps: 24,
      hasAudio: true,
    });
    expect(clips[1].madeBy).toBe("Upscale");
    expect(S().results).toHaveLength(0);
  });

  it("skips the server when nothing needs changing, keeps the result on failure", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    S().addResult(result({ keepAudio: false, matchFps: false }));
    expect(await placeResult(S().results[0], "append")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(S().edit!.clips.at(-1)!.src.url).toBe(src("out", 2).url);

    S().addResult(result({ id: "run:1" }));
    expect(await placeResult(S().results[0], "replace")).toBe(false);
    expect(S().results.map((r) => r.id)).toEqual(["run:1"]);
  });

  it("result card offers the sound / rate choices, and Insert for a cut point", () => {
    S().addResult(result());
    let html = render(<VideoResultsPanel />);
    expect(html).toContain("Keep the original sound");
    expect(html).toContain("Match the edit&#x27;s 24 fps");
    expect(html).toContain("Replace range");
    S().removeResult("run:0");
    S().apply((e) => splitAt(e, 2));
    S().addResult(
      result({ id: "b:0", start: 2, end: 2, source: src("br", 1, 24, true) }),
    );
    html = render(<VideoResultsPanel />);
    expect(html).toContain("Insert at cut");
    expect(html).not.toContain("Compare");
    expect(html).not.toContain("Match the edit");
  });
});
