/**
 * Video editor ffmpeg/ffprobe argv builders. Pure checks always; when a
 * local ffmpeg exists, the built commands also run on synthetic testsrc
 * clips (CPU only, a few seconds) to prove the filter graphs are valid.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BT709_SCALE,
  BT709_TAGS,
  RGB_FRAME_VF,
  atempoChain,
  buildWaveformArgs,
  waveformWidth,
  buildFilmstripArgs,
  buildFrameArgs,
  buildProbeArgs,
  buildRenderArgs,
  filmstripTileCount,
  filmstripTimes,
  fpsExpr,
  INPUT_GUARD,
  isNtscRate,
  parseProbe,
  pieceFrames,
  renderFormat,
} from "@/lib/videoEdit/ffmpegArgs";

describe("buildRenderArgs", () => {
  const odd = "/w/b b;echo $(x) `y`.mp4";
  const inputs = [
    { path: "/w/a.mp4", in: 1, out: 3.5, audio: true },
    { path: odd, in: 0, out: 2, audio: false },
  ];

  it("is an argv array: paths stay single arguments", () => {
    const args = buildRenderArgs(inputs, "/w/out.mp4", {
      width: 1280,
      height: 720,
      fps: 24,
      withAudio: true,
    });
    expect(args).toContain(odd);
    expect(args.at(-1)).toBe("/w/out.mp4");
    const i = args.indexOf("/w/a.mp4");
    // -t reads two frames past the out point; the frame-exact trim cuts it.
    expect(args.slice(i - 9, i + 1)).toEqual([
      "-ss",
      "1.000",
      "-t",
      "2.583",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,mp4,matroska,webm",
      "-i",
      "/w/a.mp4",
    ]);
  });

  it("guards every input: local files and video demuxers only", () => {
    const all = [
      buildRenderArgs(inputs, "/o.mp4", {
        width: 64,
        height: 64,
        fps: 24,
        withAudio: true,
      }),
      buildFrameArgs("/a.mp4", 1, "/f.png"),
      buildFilmstripArgs("/a.mp4", 10, 8, 32, 18, "/s.jpg"),
    ];
    for (const args of all) {
      args.forEach((a, i) => {
        if (a === "-i")
          expect(args.slice(i - 4, i)).toEqual([...INPUT_GUARD]);
      });
    }
    const probe = buildProbeArgs("/a.mp4");
    expect(probe.slice(-5, -1)).toEqual([...INPUT_GUARD]);
  });

  it("cuts video and audio to the same whole-frame length, NTSC exact", () => {
    const args = buildRenderArgs(
      [{ path: "/a.mp4", in: 0.5, out: 1.7, audio: true }],
      "/o.mp4",
      { width: 640, height: 360, fps: 29.97, withAudio: true },
    );
    const fc = args[args.indexOf("-filter_complex") + 1];
    // 1.2 s at 30000/1001 = 35.96 -> 36 frames = 1.201200 s
    expect(fc).toContain("fps=30000/1001");
    expect(fc).toContain("trim=end_frame=36");
    expect(fc).toContain("atrim=duration=1.201200");
    // click-free cut: 5 ms fades at both ends
    expect(fc).toContain("afade=t=in:d=0.005");
    expect(fc).toContain("afade=t=out:st=1.196200:d=0.005");
  });

  it("fills muted pieces with silence and concats v+a", () => {
    const args = buildRenderArgs(inputs, "/o.mp4", {
      width: 1279,
      height: 721,
      fps: 30,
      withAudio: true,
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:a]aresample=48000");
    expect(fc).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=2.000000");
    expect(fc).not.toContain("[1:a]");
    expect(fc).toContain("scale=1280:722"); // even dimensions
    expect(fc).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]");
    expect(args).toEqual(
      expect.arrayContaining(["-c:a", "aac", "-map", "[aout]"]),
    );
  });

  it("drops audio entirely when nothing is audible", () => {
    const args = buildRenderArgs(inputs, "/o.mp4", {
      width: 640,
      height: 360,
      fps: 24,
      withAudio: false,
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).not.toContain("anullsrc");
    expect(fc).toContain("concat=n=2:v=1:a=0[vout]");
    expect(args).toContain("-an");
  });

  it("encodes finals at x264 slow / crf 17, yuv420p, AAC 192k by default", () => {
    const args = buildRenderArgs(inputs, "/o.mp4", {
      width: 640,
      height: 360,
      fps: 24,
      withAudio: true,
    });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-c:v")).toBe("libx264");
    expect(at("-preset")).toBe("slow");
    expect(at("-crf")).toBe("17");
    expect(at("-pix_fmt")).toBe("yuv420p");
    expect(at("-b:a")).toBe("192k");
    expect(args).toContain("+faststart");
  });

  it("converts and tags BT.709 only when asked (SDR sources)", () => {
    const opts = { width: 640, height: 360, fps: 24, withAudio: false };
    const fc = (bt709?: boolean) => {
      const args = buildRenderArgs(inputs, "/o.mp4", { ...opts, bt709 });
      return args[args.indexOf("-filter_complex") + 1];
    };
    const on = fc(true);
    // every piece: matrix conversion in its scale, tags after format
    expect(on.split(BT709_SCALE)).toHaveLength(3);
    expect(on.split(`format=yuv420p${BT709_TAGS},`)).toHaveLength(3);
    expect(on).toContain(
      "scale=640:360:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv,",
    );
    const off = fc(false);
    expect(off).not.toContain("color_matrix");
    expect(off).not.toContain("setparams");
    expect(fc()).toBe(off);
  });

  it("extracts frames as full-chroma RGB", () => {
    const args = buildFrameArgs("/a.mp4", 1, "/f.png");
    expect(args[args.indexOf("-vf") + 1]).toBe(RGB_FRAME_VF);
    expect(RGB_FRAME_VF).toContain("full_chroma_int");
    expect(args.indexOf("-vf")).toBeGreaterThan(args.indexOf("-i"));
  });

  it("refuses an empty render", () => {
    expect(() =>
      buildRenderArgs([], "/o.mp4", {
        width: 1,
        height: 1,
        fps: 1,
        withAudio: false,
      }),
    ).toThrow();
  });
});

describe("renderFormat", () => {
  it("uses the first frame size, caps 4K and takes the top fps", () => {
    expect(
      renderFormat([
        { width: 1920, height: 1080, fps: 24 },
        { width: 640, height: 480, fps: 30 },
      ]),
    ).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(renderFormat([{ width: 7680, height: 4320, fps: 120 }])).toEqual({
      width: 3840,
      height: 2160,
      fps: 60,
    });
    expect(renderFormat([{ width: 0, height: 0, fps: 0 }])).toEqual({
      width: 1280,
      height: 720,
      fps: 24,
    });
  });
});

describe("other builders", () => {
  it("frame / filmstrip / probe", () => {
    expect(buildFrameArgs("/a.mp4", -1, "/f.png")).toEqual(
      expect.arrayContaining(["-ss", "0.000", "-frames:v", "1"]),
    );
    // One fast-seeked input per tile, stacked in a row.
    const strip = buildFilmstripArgs("/a.mp4", 10, 4, 97, 55, "/s.jpg");
    expect(strip.filter((a) => a === "-i")).toHaveLength(4);
    expect(strip.filter((a) => a === "-ss")).toEqual(["-ss", "-ss", "-ss", "-ss"]);
    expect(strip[strip.indexOf("-ss") + 1]).toBe("1.250");
    const fc = strip[strip.indexOf("-filter_complex") + 1];
    expect(fc).toContain("hstack=inputs=4");
    expect(fc).toContain("crop=98:56");
    const one = buildFilmstripArgs("/a.mp4", 10, 1, 32, 18, "/s.jpg");
    expect(one[one.indexOf("-filter_complex") + 1]).not.toContain("hstack");
    expect(filmstripTimes(10, 500)).toHaveLength(60);
    expect(filmstripTileCount(1)).toBe(8);
    expect(filmstripTileCount(9)).toBe(18);
    expect(filmstripTileCount(600)).toBe(32);
    expect(buildProbeArgs("/a.mp4").at(-1)).toBe("/a.mp4");
  });

  it("maps NTSC rates to exact rationals", () => {
    expect(fpsExpr(29.97)).toBe("30000/1001");
    expect(fpsExpr(23.976)).toBe("24000/1001");
    expect(fpsExpr(59.94)).toBe("60000/1001");
    expect(fpsExpr(25)).toBe("25");
    expect(isNtscRate(29.97)).toBe(true);
    expect(isNtscRate(30)).toBe(false);
    expect(pieceFrames(1.2, 29.97)).toBe(36);
    expect(pieceFrames(0.001, 24)).toBe(1);
  });
});

describe("parseProbe", () => {
  it("reads duration, size, fps, audio and rotation", () => {
    expect(
      parseProbe({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30000/1001",
            side_data_list: [{ rotation: -90 }],
          },
          { codec_type: "audio" },
        ],
        format: { duration: "12.5" },
      }),
    ).toEqual({
      duration: 12.5,
      width: 1080,
      height: 1920,
      fps: 29.97,
      hasAudio: true,
      videoCodec: "h264",
      hdr: false,
    });
  });

  it("flags HDR (PQ / HLG transfer or BT.2020 primaries)", () => {
    const v = (extra: Record<string, unknown>) =>
      parseProbe({
        streams: [{ codec_type: "video", width: 8, height: 8, ...extra }],
        format: { duration: "1" },
      })!.hdr;
    expect(v({ color_transfer: "smpte2084" })).toBe(true);
    expect(v({ color_transfer: "arib-std-b67" })).toBe(true);
    expect(v({ color_primaries: "bt2020" })).toBe(true);
    expect(v({ color_transfer: "bt709", color_primaries: "bt709" })).toBe(false);
    expect(v({})).toBe(false);
  });

  it("ignores cover art and rejects audio-only files", () => {
    expect(
      parseProbe({
        streams: [
          { codec_type: "audio" },
          { codec_type: "video", disposition: { attached_pic: 1 } },
        ],
      }),
    ).toBeNull();
    expect(parseProbe(null)).toBeNull();
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const haveFfmpeg = !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!haveFfmpeg)("real ffmpeg", () => {
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r.stdout;
  };
  const probe = (p: string) =>
    parseProbe(JSON.parse(run(ffprobe!, buildProbeArgs(p))))!;

  it("renders mixed clips (audio + silent, different sizes) and extracts frames", () => {
    const a = path.join(tmp, "a.mp4");
    const b = path.join(tmp, "b.mp4");
    run(ffmpeg!, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=24:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      a,
    ]);
    run(ffmpeg!, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=240x240:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      b,
    ]);
    const pa = probe(a);
    expect(pa).toMatchObject({
      width: 320,
      height: 180,
      fps: 24,
      hasAudio: true,
    });
    expect(probe(b).hasAudio).toBe(false);

    const out = path.join(tmp, "out.mp4");
    run(
      ffmpeg!,
      buildRenderArgs(
        [
          { path: a, in: 0.5, out: 2, audio: true },
          { path: b, in: 0, out: 1, audio: false },
        ],
        out,
        {
          ...renderFormat([pa, probe(b)]),
          withAudio: true,
          preset: "ultrafast",
        },
      ),
    );
    const po = probe(out);
    expect(po).toMatchObject({ width: 320, height: 180, hasAudio: true });
    expect(po.duration).toBeGreaterThan(2.3);
    expect(po.duration).toBeLessThan(2.7);

    const png = path.join(tmp, "f.png");
    run(ffmpeg!, buildFrameArgs(out, 1.2, png));
    expect(fs.statSync(png).size).toBeGreaterThan(100);

    const strip = path.join(tmp, "s.jpg");
    run(ffmpeg!, buildFilmstripArgs(a, pa.duration, 8, 64, 36, strip));
    expect(fs.statSync(strip).size).toBeGreaterThan(100);
  }, 60_000);

  it("trim + re-join round-trips near-losslessly and tags BT.709", () => {
    // Untagged source (what an RGB -> yuv420p encode without tags gives).
    const src = path.join(tmp, "rt_src.mp4");
    run(ffmpeg!, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=2",
      "-c:v",
      "libx264",
      "-crf",
      "10",
      "-pix_fmt",
      "yuv420p",
      src,
    ]);
    const out = path.join(tmp, "rt_out.mp4");
    // Cut at 0.5 s and re-join: two pieces from one source, 36 frames.
    run(
      ffmpeg!,
      buildRenderArgs(
        [
          { path: src, in: 0.5, out: 1, audio: false },
          { path: src, in: 1, out: 2, audio: false },
        ],
        out,
        { width: 320, height: 180, fps: 24, withAudio: false, bt709: true },
      ),
    );
    const tags = run(ffprobe!, [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "stream=pix_fmt,color_space,color_primaries,color_transfer,nb_frames",
      "-of",
      "json",
      out,
    ]);
    expect(JSON.parse(tags).streams[0]).toMatchObject({
      pix_fmt: "yuv420p",
      color_space: "bt709",
      color_primaries: "bt709",
      color_transfer: "bt709",
      nb_frames: "36",
    });
    // Compare in RGB, each side decoded by its own tags (as a player would).
    const r = spawnSync(
      ffmpeg!,
      [
        "-hide_banner",
        "-i",
        out,
        "-i",
        src,
        "-lavfi",
        "[0:v]format=rgb24,setpts=PTS-STARTPTS[a];" +
          "[1:v]trim=start_frame=12:end_frame=48,format=rgb24,setpts=PTS-STARTPTS[b];" +
          "[a][b]psnr",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    const psnr = Number(/average:([\d.]+)/.exec(r.stderr)?.[1]);
    expect(psnr).toBeGreaterThan(35);
  }, 60_000);
});

describe("speed / volume / fades / frame", () => {
  const fmt = { width: 1280, height: 720, fps: 24, withAudio: true };
  const graph = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

  it("chains atempo within 0.5..2", () => {
    expect(atempoChain(1)).toEqual([1]);
    expect(atempoChain(4)).toEqual([2, 2]);
    expect(atempoChain(3)).toEqual([2, 1.5]);
    expect(atempoChain(0.25)).toEqual([0.5, 0.5]);
    expect(atempoChain(0.3)).toEqual([0.5, 0.6]);
  });

  it("retimes video + audio and reads speed x source seconds", () => {
    const args = buildRenderArgs(
      [{ path: "/w/a.mp4", in: 0, out: 4, audio: true, speed: 2 }],
      "/w/o.mp4",
      fmt,
    );
    // 4 s of source + two output frames at 2x.
    expect(args.slice(3, 7)).toEqual(["-ss", "0.000", "-t", "4.167"]);
    expect(graph(args)).toBe(
      "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1," +
        "setpts=(PTS-STARTPTS)/2,fps=24,format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=2,trim=end_frame=48,setpts=PTS-STARTPTS[v0];" +
        "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atempo=2,apad,atrim=duration=2.000000," +
        "afade=t=in:d=0.005,afade=t=out:st=1.995000:d=0.005[a0];" +
        "[v0][a0]concat=n=1:v=1:a=1[vout][aout]",
    );
  });

  it("applies volume and user fades (replacing the cut fades)", () => {
    const g = graph(
      buildRenderArgs(
        [{ path: "/w/a.mp4", in: 0, out: 2, audio: true, volume: 0.5, fadeIn: 0.5, fadeOut: 0.25 }],
        "/w/o.mp4",
        fmt,
      ),
    );
    expect(g).toContain("trim=end_frame=48,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.500000,fade=t=out:st=1.750000:d=0.250000[v0]");
    expect(g).toContain("atrim=duration=2.000000,volume=0.5,afade=t=in:st=0:d=0.500000,afade=t=out:st=1.750000:d=0.250000[a0]");
    expect(g).not.toContain("d=0.005");
  });

  it("crops to fill with a focus point instead of letterboxing", () => {
    const g = graph(
      buildRenderArgs([{ path: "/w/a.mp4", in: 0, out: 1, audio: false }], "/w/o.mp4", {
        ...fmt,
        width: 608,
        height: 1080,
        withAudio: false,
        fit: { x: 0.25, y: 7 },
      }),
    );
    expect(g.startsWith("[0:v]scale=608:1080:force_original_aspect_ratio=increase,crop=608:1080:(iw-ow)*0.25:(ih-oh)*1,setsar=1,")).toBe(true);
    expect(g).not.toContain("color=black");
  });

  it("renderFormat overrides: aspect crop, short side, fps", () => {
    const p = [{ width: 1920, height: 1080, fps: 30 }];
    expect(renderFormat(p, { aspect: 9 / 16 })).toEqual({ width: 608, height: 1080, fps: 30 });
    expect(renderFormat(p, { shortSide: 720 })).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(renderFormat(p, { aspect: 1, shortSide: 720, fps: 24 })).toEqual({ width: 720, height: 720, fps: 24 });
    expect(renderFormat(p, { fps: 240 }).fps).toBe(60);
    // Upscaling past 4K is capped.
    expect(renderFormat([{ width: 640, height: 4000, fps: 24 }], { shortSide: 1080 }).height).toBe(3840);
  });

  it("waveform argv", () => {
    expect(waveformWidth(0.5)).toBe(200);
    expect(waveformWidth(10)).toBe(800);
    expect(waveformWidth(600)).toBe(4000);
    const args = buildWaveformArgs("/w/a b.mp4", 801, 63, "/w/w.png");
    expect(args.slice(args.indexOf("-i") - 4, args.indexOf("-i") + 2)).toEqual([...INPUT_GUARD, "-i", "/w/a b.mp4"]);
    expect(args).toContain("[0:a:0]aformat=channel_layouts=mono,showwavespic=s=802x64:colors=white:scale=sqrt[out]");
    expect(args.at(-1)).toBe("/w/w.png");
  });
});

describe.skipIf(!haveFfmpeg)("real ffmpeg: speed, fades, crop, waveform", () => {
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r.stdout;
  };
  const probe = (p: string) =>
    parseProbe(JSON.parse(run(ffprobe!, buildProbeArgs(p))))!;

  it("renders 2x + 0.5x pieces with fades into a 9:16 crop, and draws a waveform", () => {
    const a = path.join(tmp, "fx.mp4");
    run(ffmpeg!, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", a,
    ]);
    const pa = probe(a);
    const out = path.join(tmp, "fx_out.mp4");
    const fmt = renderFormat([pa], { aspect: 9 / 16, fps: 30 });
    expect(fmt).toEqual({ width: 102, height: 180, fps: 30 });
    run(
      ffmpeg!,
      buildRenderArgs(
        [
          { path: a, in: 0, out: 2, audio: true, speed: 2, fadeIn: 0.3 },
          { path: a, in: 2, out: 3, audio: true, speed: 0.5, volume: 0.5, fadeOut: 0.5 },
        ],
        out,
        { ...fmt, withAudio: true, preset: "ultrafast", fit: { x: 0.5, y: 0.5 } },
      ),
    );
    const po = probe(out);
    expect(po).toMatchObject({ width: 102, height: 180, fps: 30, hasAudio: true });
    // 2 s at 2x (1 s) + 1 s at 0.5x (2 s).
    expect(po.duration).toBeGreaterThan(2.9);
    expect(po.duration).toBeLessThan(3.15);

    const png = path.join(tmp, "wave.png");
    run(ffmpeg!, buildWaveformArgs(a, waveformWidth(pa.duration), 48, png));
    const head = fs.readFileSync(png);
    // PNG IHDR: width / height big-endian at 16 / 20; colour type 6 = RGBA.
    expect([head.readUInt32BE(16), head.readUInt32BE(20), head[25]]).toEqual([320, 48, 6]);
  }, 60_000);
});
