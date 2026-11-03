/**
 * Video editor: A2 lane ripple on V1 edits, crossfade / dip-aware stills,
 * loudness normalisation + ducking in the export graph, and audio-file
 * probing. With a local ffmpeg, real stills, exports and probes too.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addAudioClip,
  audioClipFromSource,
  clipFromSource,
  frameLayers,
  removeClip,
  replaceRange,
  rippleAudio,
  rippleDelete,
  setTransition,
  trimClip,
  updateClip,
  type AudioClip,
  type AudioSource,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  AUDIO_INPUT_GUARD,
  DEFAULT_LOUDNORM_LUFS,
  DUCK_FILTER,
  buildCompositeFrameArgs,
  buildProbeArgs,
  buildRenderArgs,
  parseAudioProbe,
  parseProbe,
  type RenderInput,
} from "@/lib/videoEdit/ffmpegArgs";
import { AUDIO_SOURCE_EXT } from "@/lib/videoEdit/sourceRef";

const vsrc = (name: string, duration: number): VideoSource => ({
  url: `/api/comfy/image?filename=${name}.mp4&subfolder=&type=output`,
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
});
const asrc = (name: string, duration: number): AudioSource => ({
  url: `/api/comfy/image?filename=${name}.mp3&subfolder=&type=output`,
  duration,
});

let n = 0;
const id = () => `x${++n}`;

/** Clips a, b, c: 2 s each (source 0..2 of 4), at 0, 2, 4. */
function three(): EditList {
  const c = (k: string) => ({
    ...clipFromSource(vsrc(k, 4), k.toUpperCase()),
    id: k,
    in: 0,
    out: 2,
  });
  return { v: 1, clips: [c("a"), c("b"), c("c")] };
}

function withLane(
  list: EditList,
  lane: { id: string; start: number; len?: number }[],
): EditList {
  return lane.reduce(
    (l, a) =>
      addAudioClip(l, {
        ...audioClipFromSource(asrc(a.id, 10), a.id, a.start, a.id),
        out: a.len ?? 1,
      }),
    list,
  );
}

const lane = (l: EditList) =>
  Object.fromEntries(
    (l.audio ?? []).map((c: AudioClip) => [c.id, [c.start, c.out]]),
  );

describe("ripple edits carry the A2 lane", () => {
  it("ripple delete shifts later lane clips and snaps ones inside the gap", () => {
    const l = withLane(three(), [
      { id: "before", start: 0.2, len: 0.2 },
      { id: "inside", start: 1 },
      { id: "after", start: 5 },
    ]);
    const r = rippleDelete(l, 0.5, 1.5, id);
    expect(lane(r)).toEqual({
      before: [0.2, 0.2],
      inside: [0.5, 1],
      after: [4, 1],
    });
  });

  it("a lane clip spanning the cut keeps its start and is cut short at the next moved clip", () => {
    const l = withLane(three(), [
      { id: "long", start: 0, len: 3 },
      { id: "next", start: 3.2 },
      { id: "overlap", start: 1 },
    ]);
    const r = rippleDelete(l, 0.5, 1.5, id);
    // "next" moves to 2.2, so "long" ends there; "overlap" already
    // overlapped "long" and does not cut it.
    expect(lane(r)).toEqual({
      long: [0, 2.2],
      next: [2.2, 1],
      overlap: [0.5, 1],
    });
  });

  it("trimming a clip shorter / longer shifts the lane after it", () => {
    const l = withLane(three(), [
      { id: "early", start: 0.5 },
      { id: "mid", start: 1.5 },
      { id: "late", start: 3 },
    ]);
    const shorter = trimClip(l, "a", 0, 1);
    expect(lane(shorter)).toEqual({
      early: [0.5, 0.5],
      mid: [1, 1],
      late: [2, 1],
    });
    const longer = trimClip(l, "a", 0, 3);
    expect(lane(longer)).toEqual({
      early: [0.5, 1],
      mid: [1.5, 1],
      late: [4, 1],
    });
  });

  it("speed changes and clip removal ripple too", () => {
    const l = withLane(three(), [{ id: "s", start: 4.5 }]);
    expect(lane(updateClip(l, "b", { speed: 2 }))).toEqual({ s: [3.5, 1] });
    expect(lane(removeClip(l, "b"))).toEqual({ s: [2.5, 1] });
    expect(lane(updateClip(l, "b", { volume: 0.5 }))).toEqual({ s: [4.5, 1] });
  });

  it("replaceRange shifts by the length difference", () => {
    const l = withLane(three(), [{ id: "s", start: 5 }]);
    const ins = {
      ...clipFromSource(vsrc("n", 8), "N"),
      id: "n",
      in: 0,
      out: 3,
    };
    // [2, 4) (2 s) replaced by 3 s.
    expect(lane(replaceRange(l, 2, 4, ins, id))).toEqual({ s: [6, 1] });
  });

  it("rippleAudio: no lane / no delta is a no-op; never moves before the cut", () => {
    const plain = three();
    expect(rippleAudio(plain, 2, -1)).toBe(plain);
    const l = withLane(three(), [{ id: "s", start: 3 }]);
    expect(rippleAudio(l, 2, 0)).toBe(l);
    expect(lane(rippleAudio(l, 4, -3))).toEqual({ s: [1, 1] });
  });
});

describe("frameLayers: stills follow transitions", () => {
  const xf = () => setTransition(three(), "b", { type: "crossfade", d: 1 });

  it("a plain frame is one full layer", () => {
    expect(frameLayers(three(), 1)).toEqual([
      { url: vsrc("a", 4).url, time: 1, weight: 1, level: 1 },
    ]);
    expect(frameLayers(three(), 99)).toHaveLength(1);
  });

  it("inside a crossfade blends both clips at the transition progress", () => {
    const into = frameLayers(xf(), 2.25);
    expect(into).toHaveLength(2);
    expect(into[0]).toMatchObject({ url: vsrc("b", 4).url, time: 0.25 });
    expect(into[0].weight).toBeCloseTo(0.75);
    expect(into[1]).toMatchObject({ url: vsrc("a", 4).url });
    expect(into[1].weight).toBeCloseTo(0.25);
    // a is held at its source end past its out point.
    expect(into[1].time).toBeCloseTo(2.25);
    const out = frameLayers(xf(), 1.75);
    expect(out[0]).toMatchObject({ url: vsrc("a", 4).url, time: 1.75 });
    expect(out[0].weight).toBeCloseTo(0.75);
    expect(out[1].weight).toBeCloseTo(0.25);
    expect(out[1].time).toBe(0);
    // Mid-cut: half and half.
    expect(frameLayers(xf(), 2)[0].weight).toBeCloseTo(0.5);
    // Outside the window: one clip.
    expect(frameLayers(xf(), 1.4)).toHaveLength(1);
    expect(frameLayers(xf(), 2.6)).toHaveLength(1);
  });

  it("dip to black darkens towards the cut", () => {
    const dip = setTransition(three(), "b", { type: "dip", d: 1 });
    const at = (t: number) => frameLayers(dip, t);
    expect(at(1)).toHaveLength(1);
    expect(at(1)[0].level).toBe(1);
    expect(at(1.75)[0].level).toBeCloseTo(0.5);
    expect(at(2)[0]).toMatchObject({ url: vsrc("b", 4).url, level: 0 });
    expect(at(2.25)[0].level).toBeCloseTo(0.5);
    expect(at(2.5)[0].level).toBe(1);
  });

  it("clip fades darken a still too", () => {
    const l = updateClip(three(), "a", { fadeIn: 1 });
    expect(frameLayers(l, 0.25)[0].level).toBeCloseTo(0.25);
    expect(frameLayers(l, 1.5)[0].level).toBe(1);
  });
});

describe("buildCompositeFrameArgs", () => {
  it("fits, darkens and mixes each frame by weight", () => {
    const args = buildCompositeFrameArgs(
      [
        { path: "/w/b.mp4", t: 0.25, weight: 0.75, level: 1 },
        { path: "/w/a.mp4", t: 2, weight: 0.25, level: 0.5 },
      ],
      "/w/out.png",
      1280,
      720,
    );
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    const ss = args.reduce<string[]>(
      (o, a, i) => (a === "-ss" ? [...o, args[i + 1]] : o),
      [],
    );
    expect(ss.map(Number)).toEqual([0.25, 2]);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:v]trim=end_frame=1");
    expect(graph).toContain("pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black");
    expect(graph).not.toMatch(/\[0:v\][^;]*colorchannelmixer/);
    expect(graph).toMatch(
      /\[1:v\][^;]*colorchannelmixer=rr=0\.5:gg=0\.5:bb=0\.5\[f1\]/,
    );
    expect(graph).toContain(
      "[f0][f1]mix=inputs=2:weights='0.75 0.25',format=rgb24[out]",
    );
    expect(args.slice(-1)).toEqual(["/w/out.png"]);
  });

  it("a single darkened frame skips the mix", () => {
    const args = buildCompositeFrameArgs(
      [{ path: "/w/a.mp4", t: 1, weight: 1, level: 0 }],
      "/w/o.png",
      640,
      360,
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("colorchannelmixer=rr=0:gg=0:bb=0[f0]");
    expect(graph).toContain("[f0]format=rgb24[out]");
    expect(graph).not.toContain("mix=");
    expect(() => buildCompositeFrameArgs([], "/w/o.png", 2, 2)).toThrow();
  });
});

describe("buildRenderArgs: loudness + ducking", () => {
  const clips: RenderInput[] = [
    { path: "/w/a.mp4", in: 0, out: 2, audio: true },
    { path: "/w/b.mp4", in: 0, out: 2, audio: true },
  ];
  const base = { width: 1280, height: 720, fps: 24, withAudio: true };
  const song = { path: "/w/s.mp3", in: 0, out: 3, at: 1 };
  const graphOf = (opts: Parameters<typeof buildRenderArgs>[2]) => {
    const a = buildRenderArgs(clips, "/w/o.mp4", opts);
    return a[a.indexOf("-filter_complex") + 1];
  };

  it("is off by default", () => {
    const g = graphOf({ ...base, lane: [song] });
    expect(g).not.toContain("loudnorm");
    expect(g).not.toContain("sidechaincompress");
    expect(g).toContain("normalize=0[aout]");
  });

  it("normalises the final mix single-pass to the target", () => {
    expect(DEFAULT_LOUDNORM_LUFS).toBe(-14);
    const g = graphOf({ ...base, lane: [song], loudnorm: -14 });
    expect(g).toContain("normalize=0[amix]");
    expect(g).toContain(
      "[amix]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]",
    );
    const noLane = graphOf({ ...base, loudnorm: -14 });
    expect(noLane).toMatch(/concat=n=2:v=1:a=1\[vout\]\[amix\]/);
    expect(noLane).toContain("[amix]loudnorm=I=-14");
    expect(graphOf({ ...base, loudnorm: -200 })).toContain("loudnorm=I=-70:");
    expect(graphOf({ ...base, withAudio: false, loudnorm: -14 })).not.toContain(
      "loudnorm",
    );
  });

  it("ducks the clips' sound under the lane with a padded key", () => {
    const g = graphOf({ ...base, lane: [song], duck: true });
    expect(g).toContain("[l0]asplit=2[lkey][lmix]");
    expect(g).toContain("[lkey]apad[lkeyp]");
    expect(g).toContain(`[abase][lkeyp]${DUCK_FILTER}[aduck]`);
    expect(g).toContain(
      "[aduck][lmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]",
    );
    const two = graphOf({
      ...base,
      lane: [song, { ...song, at: 3 }],
      duck: true,
      loudnorm: -16,
    });
    expect(two).toContain(
      "[l0][l1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[lbus]",
    );
    expect(two).toContain("[lbus]asplit=2[lkey][lmix]");
    expect(two).toContain("normalize=0[amix]");
    expect(two).toContain("loudnorm=I=-16:");
    // Ducking without a lane does nothing.
    expect(graphOf({ ...base, duck: true })).not.toContain("sidechain");
  });
});

describe("audio files on the A2 lane", () => {
  it("accepts the usual audio extensions", () => {
    for (const ext of ["wav", "mp3", "m4a", "flac", "ogg", "WAV"])
      expect(AUDIO_SOURCE_EXT.test(`song.${ext}`)).toBe(true);
    expect(AUDIO_SOURCE_EXT.test("song.mp4")).toBe(false);
    expect(AUDIO_SOURCE_EXT.test("song.exe")).toBe(false);
  });

  it("an audio extension needs an audio stream and no picture stream", () => {
    const a = { codec_type: "audio", duration: "3.5" };
    const fmt = { format: { duration: "3.5" } };
    expect(
      parseAudioProbe({ streams: [a], ...fmt }, { audioOnly: true }),
    ).toEqual({ duration: 3.5 });
    const cover = { codec_type: "video", disposition: { attached_pic: 1 } };
    expect(
      parseAudioProbe({ streams: [a, cover], ...fmt }, { audioOnly: true }),
    ).toEqual({ duration: 3.5 });
    const video = { codec_type: "video", disposition: { attached_pic: 0 } };
    expect(
      parseAudioProbe({ streams: [video, a], ...fmt }, { audioOnly: true }),
    ).toBeNull();
    expect(parseAudioProbe({ streams: [video, a], ...fmt })).toEqual({
      duration: 3.5,
    });
    expect(
      parseAudioProbe({ streams: [video], ...fmt }, { audioOnly: true }),
    ).toBeNull();
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const haveFfmpeg = !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-rm-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!haveFfmpeg)(
  "real ffmpeg: stills, loudness, audio files",
  () => {
    const run = (bin: string, args: string[]) => {
      const r = spawnSync(bin, args, { timeout: 60_000 });
      if (r.status !== 0) throw new Error(String(r.stderr).slice(-800));
      return r;
    };
    const lavfi = (src: string, out: string, extra: string[]) =>
      run(ffmpeg!, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        src,
        ...extra,
        out,
      ]);
    const solid = (name: string, color: string) => {
      const out = path.join(tmp, `${name}.mp4`);
      lavfi(`color=c=${color}:size=64x36:rate=24:duration=2`, out, [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv444p",
        "-qp",
        "0",
      ]);
      return out;
    };
    /** Mean RGB of a still. */
    const rgb = (png: string) => {
      const buf = run(ffmpeg!, [
        "-hide_banner",
        "-i",
        png,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]).stdout as Buffer;
      const sum = [0, 0, 0];
      for (let i = 0; i < buf.length; i += 3)
        for (let k = 0; k < 3; k += 1) sum[k] += buf[i + k];
      return sum.map((s) => s / (buf.length / 3));
    };

    it("blends a crossfade and darkens a dip in a still", () => {
      const red = solid("red", "red");
      const blue = solid("blue", "blue");
      const white = solid("white", "white");
      const mix = path.join(tmp, "mix.png");
      run(
        ffmpeg!,
        buildCompositeFrameArgs(
          [
            { path: red, t: 0.5, weight: 0.75, level: 1 },
            { path: blue, t: 0.5, weight: 0.25, level: 1 },
          ],
          mix,
          64,
          36,
        ),
      );
      const [r, , b] = rgb(mix);
      expect(r).toBeGreaterThan(170);
      expect(r).toBeLessThan(205);
      expect(b).toBeGreaterThan(50);
      expect(b).toBeLessThan(80);
      const dip = path.join(tmp, "dip.png");
      run(
        ffmpeg!,
        buildCompositeFrameArgs(
          [{ path: white, t: 0.5, weight: 1, level: 0.5 }],
          dip,
          64,
          36,
        ),
      );
      for (const c of rgb(dip)) {
        expect(c).toBeGreaterThan(110);
        expect(c).toBeLessThan(145);
      }
    }, 60_000);

    it("ducks and loudness-normalises a real export to about -14 LUFS", () => {
      const clip = path.join(tmp, "talk.mp4");
      run(ffmpeg!, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=24:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        clip,
      ]);
      const song = path.join(tmp, "song.wav");
      lavfi("sine=frequency=220:duration=3", song, []);
      const out = path.join(tmp, "norm.mp4");
      run(
        ffmpeg!,
        buildRenderArgs([{ path: clip, in: 0, out: 4, audio: true }], out, {
          width: 160,
          height: 90,
          fps: 24,
          withAudio: true,
          preset: "ultrafast",
          lane: [{ path: song, in: 0, out: 2, at: 1 }],
          duck: true,
          loudnorm: DEFAULT_LOUDNORM_LUFS,
        }),
      );
      const info = parseProbe(
        JSON.parse(String(run(ffprobe!, buildProbeArgs(out)).stdout)),
      )!;
      expect(info.hasAudio).toBe(true);
      expect(info.duration).toBeGreaterThan(3.9);
      expect(info.duration).toBeLessThan(4.2);
      const r = run(ffmpeg!, [
        "-hide_banner",
        "-nostdin",
        "-i",
        out,
        "-af",
        "ebur128",
        "-f",
        "null",
        "-",
      ]);
      const m = /I:\s+(-?[\d.]+) LUFS\s+Threshold/.exec(
        String(r.stderr).split("Summary:").pop() ?? "",
      );
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m![1]) - DEFAULT_LOUDNORM_LUFS)).toBeLessThan(1.5);
    }, 60_000);

    it("probes wav, mp3, m4a, flac and ogg as lane audio; rejects a renamed video", () => {
      const codecs: Record<string, string[]> = {
        wav: [],
        mp3: ["-c:a", "libmp3lame"],
        m4a: ["-c:a", "aac"],
        flac: [],
        ogg: [],
      };
      for (const [ext, extra] of Object.entries(codecs)) {
        const f = path.join(tmp, `tone.${ext}`);
        lavfi("sine=frequency=330:duration=2", f, extra);
        const probe = JSON.parse(
          String(run(ffprobe!, buildProbeArgs(f, true)).stdout),
        );
        const got = parseAudioProbe(probe, { audioOnly: true });
        expect(got, ext).not.toBeNull();
        expect(got!.duration).toBeGreaterThan(1.9);
      }
      const fake = path.join(tmp, "fake.m4a");
      run(ffmpeg!, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x36:rate=24:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-f",
        "mp4",
        fake,
      ]);
      const probe = JSON.parse(
        String(run(ffprobe!, buildProbeArgs(fake, true)).stdout),
      );
      expect(parseAudioProbe(probe)).not.toBeNull();
      expect(parseAudioProbe(probe, { audioOnly: true })).toBeNull();
      expect(AUDIO_INPUT_GUARD.length).toBeGreaterThan(0);
    }, 60_000);
  },
);
