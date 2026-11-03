/**
 * Video editor transitions (crossfade / dip) and the A2 audio lane: model
 * ops, render segments, the ffmpeg filter graph, and (with a local ffmpeg)
 * a real export of both.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EditListError,
  MAX_AUDIO_CLIPS,
  addAudioClip,
  audioClipFromSource,
  audioSegments,
  clipFromSource,
  effectiveFades,
  moveAudioClip,
  moveClip,
  parseEditList,
  rangeSegments,
  removeAudioClip,
  replaceRange,
  setTransition,
  splitAt,
  splitAudioAt,
  transitionAt,
  trimAudio,
  updateAudioClip,
  updateClip,
  type AudioSource,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  AUDIO_INPUT_GUARD,
  buildProbeArgs,
  buildRenderArgs,
  parseAudioProbe,
  parseProbe,
  type RenderInput,
} from "@/lib/videoEdit/ffmpegArgs";
import { crossfadePartner } from "@/components/editor/video/VideoPlayer";
import { clipAt } from "@/lib/videoEdit/editList";

const vsrc = (
  name: string,
  duration: number,
  hasAudio = true,
): VideoSource => ({
  url: `/api/comfy/image?filename=${name}.mp4&subfolder=&type=output`,
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio,
});
const asrc = (name: string, duration: number): AudioSource => ({
  url: `/api/comfy/image?filename=${name}.mp3&subfolder=&type=output`,
  duration,
});

let n = 0;
const id = () => `x${++n}`;

/** Clip a: source 0..4 used 1..3 (2 s); clip b: 0..4 used 0..2 (2 s). */
function two(): EditList {
  const a = { ...clipFromSource(vsrc("a", 4), "A"), id: "a", in: 1, out: 3 };
  const b = { ...clipFromSource(vsrc("b", 4), "B"), id: "b", in: 0, out: 2 };
  return { v: 1, clips: [a, b] };
}

describe("transitions: model", () => {
  it("sets, rounds, clamps and clears the transition into a clip", () => {
    const l = setTransition(two(), "b", { type: "crossfade", d: 0.73 });
    expect(l.clips[1].transitionIn).toEqual({ type: "crossfade", d: 0.75 });
    expect(setTransition(l, "b", { type: "crossfade", d: 0.75 })).toBe(l);
    expect(
      setTransition(l, "b", { type: "dip", d: 99 }).clips[1].transitionIn,
    ).toEqual({ type: "dip", d: 3 });
    expect(
      setTransition(l, "b", { type: "dip", d: 0 }).clips[1].transitionIn?.d,
    ).toBe(0.1);
    const cleared = setTransition(l, "b", null);
    expect("transitionIn" in cleared.clips[1]).toBe(false);
    expect(setTransition(cleared, "b", null)).toBe(cleared);
    expect(
      setTransition(l, "b", { type: "wipe" as "dip", d: 1 }).clips[1],
    ).not.toHaveProperty("transitionIn");
  });

  it("plays no longer than either clip and never into the first clip", () => {
    let l = setTransition(two(), "b", { type: "crossfade", d: 3 });
    expect(transitionAt(l, 1)).toEqual({ type: "crossfade", d: 2 });
    l = updateClip(l, "a", { speed: 4 }); // a is now 0.5 s
    expect(transitionAt(l, 1)?.d).toBe(0.5);
    l = setTransition(l, "a", { type: "dip", d: 1 });
    expect(transitionAt(l, 0)).toBeNull();
    expect(transitionAt(l, 5)).toBeNull();
  });

  it("effective fades: dip widens both sides, crossfade replaces them", () => {
    let l = updateClip(two(), "a", { fadeOut: 0.2 });
    l = updateClip(l, "b", { fadeIn: 0.8 });
    expect(effectiveFades(l)).toEqual([
      { fadeIn: 0, fadeOut: 0.2 },
      { fadeIn: 0.8, fadeOut: 0 },
    ]);
    const dip = setTransition(l, "b", { type: "dip", d: 1 });
    expect(effectiveFades(dip)).toEqual([
      { fadeIn: 0, fadeOut: 0.5 },
      { fadeIn: 0.8, fadeOut: 0 },
    ]);
    const x = setTransition(l, "b", { type: "crossfade", d: 1 });
    expect(effectiveFades(x)).toEqual([
      { fadeIn: 0, fadeOut: 0 },
      { fadeIn: 0, fadeOut: 0 },
    ]);
  });

  it("split, move and range edits keep a transition on its own cut only", () => {
    const l = setTransition(two(), "b", { type: "crossfade", d: 0.5 });
    const split = splitAt(l, 3, () => "b2");
    expect(split.clips.map((c) => c.transitionIn?.type ?? null)).toEqual([
      null,
      "crossfade",
      null,
    ]);
    // Moving keeps it with the clip (it is "into this clip").
    expect(moveClip(l, 1, 0).clips[0].transitionIn?.type).toBe("crossfade");
    expect(transitionAt(moveClip(l, 1, 0), 0)).toBeNull();
    // A range edit that cuts b's head drops b's transition.
    const z = { ...clipFromSource(vsrc("z", 1), "Z"), id: "z" };
    const rep = replaceRange(l, 1.5, 2.5, z, () => "b3");
    expect(rep.clips.map((c) => c.id)).toEqual(["a", "z", "b"]);
    expect(rep.clips[2]).not.toHaveProperty("transitionIn");
  });

  it("render segments carry the crossfade only across a whole cut", () => {
    const l = setTransition(two(), "b", { type: "crossfade", d: 0.5 });
    const all = rangeSegments(l);
    expect(all.map((s) => s.xfadeIn)).toEqual([undefined, 0.5]);
    expect(all.map((s) => [s.fadeIn, s.fadeOut])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    // A range starting at b's head has no previous piece to blend with.
    expect(rangeSegments(l, 2, 4)[0].xfadeIn).toBeUndefined();
    expect(rangeSegments(l, 1, 4)[1].xfadeIn).toBe(0.5);
    const dip = setTransition(two(), "b", { type: "dip", d: 0.6 });
    const ds = rangeSegments(dip);
    expect(ds.map((s) => s.xfadeIn)).toEqual([undefined, undefined]);
    expect(ds.map((s) => [s.fadeIn, s.fadeOut])).toEqual([
      [0, 0.3],
      [0.3, 0],
    ]);
  });

  it("parses transitions and rejects bad ones", () => {
    const ok = () => true;
    const l = setTransition(two(), "b", { type: "dip", d: 0.4 });
    expect(
      parseEditList(JSON.parse(JSON.stringify(l)), ok).clips[1].transitionIn,
    ).toEqual({ type: "dip", d: 0.4 });
    for (const t of [
      { type: "wipe", d: 1 },
      { type: "dip", d: 9 },
      { type: "dip" },
      "x",
    ]) {
      const raw = JSON.parse(JSON.stringify(two()));
      raw.clips[1].transitionIn = t;
      expect(() => parseEditList(raw, ok)).toThrow(EditListError);
    }
  });

  it("preview partner: the other clip and its weight around a crossfade", () => {
    const l = setTransition(two(), "b", { type: "crossfade", d: 1 });
    const at = (t: number) => crossfadePartner(l, clipAt(l, t)!);
    expect(at(1)).toBeNull();
    // 0.25 s before the cut: b (in 0, so held at 0) at weight 0.25.
    const before = at(1.75)!;
    expect(before.clip.id).toBe("b");
    expect(before.sourceTime).toBe(0);
    expect(before.weight).toBeCloseTo(0.25);
    // 0.25 s after: a read past its out point, weight 0.25.
    const after = at(2.25)!;
    expect(after.clip.id).toBe("a");
    expect(after.sourceTime).toBeCloseTo(3.25);
    expect(after.weight).toBeCloseTo(0.25);
    expect(at(2.6)).toBeNull();
    const dip = setTransition(two(), "b", { type: "dip", d: 1 });
    expect(crossfadePartner(dip, clipAt(dip, 1.9)!)).toBeNull();
  });
});

describe("A2 lane: model", () => {
  const withSong = (): EditList =>
    addAudioClip(
      two(),
      audioClipFromSource(asrc("song", 10), "Song", 0.5, "s1"),
    );

  it("adds at a start, caps the lane and removes", () => {
    const l = withSong();
    expect(l.audio).toEqual([
      {
        id: "s1",
        src: asrc("song", 10),
        start: 0.5,
        in: 0,
        out: 10,
        label: "Song",
      },
    ]);
    let full = l;
    for (let i = 1; i < MAX_AUDIO_CLIPS + 3; i += 1)
      full = addAudioClip(
        full,
        audioClipFromSource(asrc("s", 1), "s", 0, `k${i}`),
      );
    expect(full.audio).toHaveLength(MAX_AUDIO_CLIPS);
    const gone = removeAudioClip(l, "s1");
    expect(gone).not.toHaveProperty("audio");
    expect(removeAudioClip(gone, "s1")).toBe(gone);
  });

  it("moves (never before 0) and trims (in edge keeps the sound in place)", () => {
    let l = moveAudioClip(withSong(), "s1", -3);
    expect(l.audio![0].start).toBe(0);
    l = moveAudioClip(l, "s1", 1);
    l = trimAudio(l, "s1", 2, 6);
    expect(l.audio![0]).toMatchObject({ in: 2, out: 6, start: 3 });
    // Pulling the in edge back cannot move the start before 0.
    l = trimAudio(l, "s1", 0, 6);
    expect(l.audio![0]).toMatchObject({ in: 0, start: 1 });
    l = moveAudioClip(l, "s1", 0.5);
    expect(trimAudio(l, "s1", 0, 6).audio![0]).toMatchObject({
      in: 0,
      start: 0.5,
    });
    // Out past the file clamps; a too-short clip keeps the minimum.
    expect(trimAudio(l, "s1", 0, 40).audio![0].out).toBe(10);
    expect(trimAudio(l, "s1", 0, 0.01).audio![0].out).toBeCloseTo(0.08);
  });

  it("gain / fades / mute store only non-defaults; split keeps the outer fades", () => {
    let l = updateAudioClip(withSong(), "s1", {
      gain: 0.5,
      fadeIn: 1,
      fadeOut: 2,
    });
    expect(l.audio![0]).toMatchObject({ gain: 0.5, fadeIn: 1, fadeOut: 2 });
    expect(updateAudioClip(l, "s1", { gain: 0.5 })).toBe(l);
    const back = updateAudioClip(l, "s1", { gain: 1, fadeIn: 0, muted: false });
    expect(back.audio![0]).not.toHaveProperty("gain");
    expect(back.audio![0]).not.toHaveProperty("fadeIn");
    expect(back.audio![0]).not.toHaveProperty("muted");
    l = splitAudioAt(l, "s1", 3, () => "s2");
    expect(
      l.audio!.map((a) => [a.id, a.start, a.in, a.out, a.fadeIn, a.fadeOut]),
    ).toEqual([
      ["s1", 0.5, 0, 2.5, 1, undefined],
      ["s2", 3, 2.5, 10, undefined, 2],
    ]);
    expect(splitAudioAt(l, "s2", 3.01)).toBe(l);
  });

  it("segments: clipped to the video and the export range, muted ones dropped", () => {
    let l = withSong(); // video 4 s; song 0.5..10.5
    l = updateAudioClip(l, "s1", { fadeIn: 0.4, fadeOut: 1 });
    l = addAudioClip(l, {
      ...audioClipFromSource(asrc("vo", 2), "VO", 1, "v1"),
      muted: true,
    });
    expect(audioSegments(l)).toEqual([
      {
        url: asrc("song", 10).url,
        in: 0,
        out: 3.5,
        at: 0.5,
        gain: 1,
        fadeIn: 0.4,
        fadeOut: 0,
      },
    ]);
    // Range 1..3: the song starts 0.5 s before it, so its head is cut.
    expect(audioSegments(l, 1, 3)).toEqual([
      {
        url: asrc("song", 10).url,
        in: 0.5,
        out: 2.5,
        at: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
      },
    ]);
    l = moveAudioClip(l, "s1", 5);
    expect(audioSegments(l)).toEqual([]);
  });

  it("parses the lane and rejects bad clips", () => {
    const ok = () => true;
    const l = updateAudioClip(withSong(), "s1", { gain: 1.5, fadeOut: 1 });
    const parsed = parseEditList(JSON.parse(JSON.stringify(l)), ok);
    expect(parsed.audio).toEqual(l.audio);
    expect(
      parseEditList(JSON.parse(JSON.stringify(two())), ok),
    ).not.toHaveProperty("audio");
    const bad = (patch: Record<string, unknown>, audioOk = ok) => {
      const raw = JSON.parse(JSON.stringify(l));
      Object.assign(raw.audio[0], patch);
      return () => parseEditList(raw, ok, audioOk);
    };
    expect(bad({ start: -1 })).toThrow(/bad start/);
    expect(bad({ in: 5, out: 4 })).toThrow(/in\/out/);
    expect(bad({ out: 11 })).toThrow(/in\/out/);
    expect(bad({ gain: 3 })).toThrow(/gain/);
    expect(bad({ fadeIn: -1 })).toThrow(/fadeIn/);
    expect(bad({}, () => false)).toThrow(/unsupported source/);
    const many = JSON.parse(JSON.stringify(l));
    many.audio = Array(MAX_AUDIO_CLIPS + 1).fill(many.audio[0]);
    expect(() => parseEditList(many, ok)).toThrow(/at most/);
    expect(() =>
      parseEditList({ ...JSON.parse(JSON.stringify(l)), audio: {} }, ok),
    ).toThrow(EditListError);
  });
});

const fc = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
const opts = { width: 320, height: 180, fps: 24, withAudio: true };

describe("buildRenderArgs: transitions and lane", () => {
  const A: RenderInput = { path: "/w/a.mp4", in: 1, out: 3, audio: true };
  const B: RenderInput = { path: "/w/b.mp4", in: 2, out: 4, audio: true };

  it("without transitions or lane: one concat straight to the outputs", () => {
    const g = fc(buildRenderArgs([A, B], "/o.mp4", opts));
    expect(g).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]");
    expect(g).not.toContain("xfade");
    expect(g).not.toContain("amix");
    expect(g).toContain("tpad=stop_mode=clone:stop=2,trim=end_frame=48,");
  });

  it("crossfade: handles on both sides, xfade + acrossfade at the cut", () => {
    const args = buildRenderArgs([A, { ...B, xfadeIn: 0.5 }], "/o.mp4", opts);
    const g = fc(args);
    // Centred on the cut (2 s): 12 frames, 6 from b's head (seeked back 0.25 s), 6 past a's out.
    expect(
      args.slice(args.indexOf("/w/b.mp4") - 9, args.indexOf("/w/b.mp4") - 5),
    ).toEqual(["-ss", "1.750", "-t", "2.333"]);
    expect(g).toContain("tpad=stop_mode=clone:stop=8,trim=end_frame=54,");
    expect(g).toContain("tpad=stop_mode=clone:stop=2,trim=end_frame=54,");
    expect(g).toContain(
      "[v0][v1]xfade=transition=fade:duration=0.500000:offset=1.750000[vout]",
    );
    expect(g).toContain("[a0][a1]acrossfade=ns=24000:c1=tri:c2=tri[aout]");
    // No click-guard fades at the crossfaded ends.
    expect(g).not.toMatch(/\[1:a\][^;]*afade=t=in/);
    expect(g).not.toMatch(/\[0:a\][^;]*afade=t=out/);
  });

  it("crossfade into a clip with no footage before its in point freezes frame one", () => {
    const g = fc(
      buildRenderArgs(
        [A, { ...B, in: 0, out: 2, xfadeIn: 0.5 }],
        "/o.mp4",
        opts,
      ),
    );
    expect(g).toContain("tpad=start_mode=clone:start=6:stop_mode=clone:stop=2");
    expect(g).toContain(`adelay=delays=${Math.round((6 / 24) * 48000)}S:all=1`);
  });

  it("concats plain-cut runs and folds the runs with crossfades", () => {
    const C: RenderInput = { path: "/w/c.mp4", in: 0, out: 2, audio: false };
    const g = fc(
      buildRenderArgs([A, B, { ...C, xfadeIn: 1 }, { ...A }], "/o.mp4", opts),
    );
    expect(g).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[rv0][ra0]");
    expect(g).toContain("[v2][a2][v3][a3]concat=n=2:v=1:a=1[rv1][ra1]");
    // Run 0: 48 + 60 (12 tail) frames; offset = 108 - 24 frames.
    expect(g).toContain(
      "[rv0][rv1]xfade=transition=fade:duration=1.000000:offset=3.500000[vout]",
    );
    expect(g).toContain("[ra0][ra1]acrossfade=ns=48000");
    // One time base on both xfade inputs (concat outputs and single pieces).
    expect(g.match(/settb=AVTB\[v\d\]/g)).toHaveLength(4);
  });

  it("drops a crossfade shorter than two frames or into the first piece", () => {
    const g = fc(
      buildRenderArgs(
        [
          { ...A, xfadeIn: 1 },
          { ...B, xfadeIn: 0.05 },
        ],
        "/o.mp4",
        opts,
      ),
    );
    expect(g).not.toContain("xfade");
  });

  it("lane: guarded inputs, trimmed, gained, faded, delayed and mixed at unity", () => {
    const args = buildRenderArgs([A, B], "/o.mp4", {
      ...opts,
      lane: [
        { path: "/w/song.mp3", in: 2, out: 5, at: 0.5, gain: 0.5, fadeIn: 1 },
        { path: "/w/vo.wav", in: 0, out: 1, at: 0 },
      ],
    });
    const i = args.indexOf("/w/song.mp3");
    expect(args.slice(i - 9, i)).toEqual([
      "-ss",
      "2.000",
      "-t",
      "3.000",
      ...AUDIO_INPUT_GUARD,
      "-i",
    ]);
    const g = fc(args);
    expect(g).toContain("concat=n=2:v=1:a=1[vout][abase]");
    expect(g).toContain(
      "[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=3.000000,volume=0.5,afade=t=in:d=1.000000,afade=t=out:st=2.995000:d=0.005,adelay=delays=24000S:all=1[l0]",
    );
    expect(g).toMatch(
      /\[3:a\][^;]*atrim=duration=1\.000000,afade=t=in:d=0\.005,[^;]*\[l1\]/,
    );
    expect(g).not.toMatch(/\[3:a\][^;]*adelay/);
    expect(g).toContain(
      "[abase][l0][l1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]",
    );
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual([
      "-map",
      "[vout]",
      "-map",
      "[aout]",
    ]);
  });

  it("lane is ignored when the render has no audio", () => {
    const args = buildRenderArgs([A], "/o.mp4", {
      ...opts,
      withAudio: false,
      lane: [{ path: "/w/song.mp3", in: 0, out: 1, at: 0 }],
    });
    expect(args).not.toContain("/w/song.mp3");
    expect(args).toContain("-an");
  });

  it("audio probe: duration from the format, else the first audio stream", () => {
    expect(
      parseAudioProbe({
        format: { duration: "4.5" },
        streams: [{ codec_type: "audio" }],
      }),
    ).toEqual({ duration: 4.5 });
    expect(
      parseAudioProbe({ streams: [{ codec_type: "video", duration: "3" }] }),
    ).toBeNull();
    expect(parseAudioProbe(null)).toBeNull();
    expect(buildProbeArgs("/w/s.mp3", true).join(" ")).toContain(
      AUDIO_INPUT_GUARD.join(" "),
    );
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const haveFfmpeg = !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-xf-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!haveFfmpeg)("real ffmpeg: crossfade + lane", () => {
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r;
  };
  /** Mean volume (dB) of [from, from + d) of a file's audio. */
  const meanDb = (file: string, from: number, d: number) => {
    const r = run(ffmpeg!, [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(from),
      "-t",
      String(d),
      "-i",
      file,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
    return m && m[1] !== "-inf" ? Number(m[1]) : -200;
  };

  it("renders a crossfaded, silent-video timeline with music mixed in at 1 s", () => {
    const a = path.join(tmp, "a.mp4");
    const b = path.join(tmp, "b.mp4");
    const song = path.join(tmp, "song.mp3");
    const silentClip = (out: string, src: string) =>
      run(ffmpeg!, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `${src}=size=160x90:rate=24:duration=3`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        out,
      ]);
    silentClip(a, "testsrc");
    silentClip(b, "testsrc2");
    run(ffmpeg!, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=5",
      "-c:a",
      "libmp3lame",
      song,
    ]);
    expect(
      parseAudioProbe(
        JSON.parse(run(ffprobe!, buildProbeArgs(song, true)).stdout),
      )?.duration,
    ).toBeGreaterThan(4.9);
    const out = path.join(tmp, "xf.mp4");
    run(
      ffmpeg!,
      buildRenderArgs(
        [
          { path: a, in: 0.5, out: 2.5, audio: false },
          { path: b, in: 0, out: 2, audio: false, xfadeIn: 1 },
          { path: a, in: 1, out: 3, audio: false, speed: 2, fadeIn: 0.3 },
        ],
        out,
        {
          width: 160,
          height: 90,
          fps: 24,
          withAudio: true,
          preset: "ultrafast",
          lane: [{ path: song, in: 0, out: 3, at: 1, gain: 0.8, fadeOut: 0.5 }],
        },
      ),
    );
    const info = parseProbe(
      JSON.parse(run(ffprobe!, buildProbeArgs(out)).stdout),
    )!;
    // 2 + 2 + 1 s: transitions do not change the length.
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(4.95);
    expect(info.duration).toBeLessThan(5.1);
    const frames = run(ffprobe!, [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      out,
    ]).stdout.trim();
    expect(Number(frames)).toBe(120);
    // Silence before the lane starts, music after it.
    expect(meanDb(out, 0, 0.9)).toBeLessThan(-80);
    expect(meanDb(out, 1.5, 1)).toBeGreaterThan(-40);
  }, 60_000);
});
