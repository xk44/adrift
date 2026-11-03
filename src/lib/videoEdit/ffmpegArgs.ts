/**
 * Video editor: ffmpeg / ffprobe argument builders. Pure (argv arrays for
 * child_process.spawn, never shell strings) so they are unit-testable; the
 * caller supplies already-validated absolute paths.
 */

export interface RenderInput {
  /** Absolute path of the local source file. */
  path: string;
  /** Source seconds. */
  in: number;
  out: number;
  /** Keep this piece's audio (false = silence for its length). */
  audio: boolean;
  /** Playback speed (0.25-4, default 1): output length is (out - in) / speed. */
  speed?: number;
  /** Audio gain (0-2, default 1). */
  volume?: number;
  /** Fade from black / silence and to black / silence, output seconds. */
  fadeIn?: number;
  fadeOut?: number;
  /**
   * Crossfade with the previous piece (output seconds), centred on the cut:
   * the previous piece runs on past its out point and this one starts
   * before its in point (edge frames held where the source has no more).
   */
  xfadeIn?: number;
}

/** An audio file mixed under the pieces (A2 lane). */
export interface LaneInput {
  path: string;
  /** Source seconds. */
  in: number;
  out: number;
  /** Output seconds where it starts. */
  at: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Fill the frame and crop to it, keeping (x, y) of the picture in view. */
export interface RenderFit {
  x: number;
  y: number;
}

export interface RenderOptions {
  width: number;
  height: number;
  fps: number;
  /** Encode an audio track at all (false when every piece is silent). */
  withAudio: boolean;
  /** x264 quality: lower is better; 18 ≈ visually lossless. */
  crf?: number;
  preset?: "ultrafast" | "veryfast" | "fast" | "medium" | "slow";
  /**
   * Convert every piece to BT.709 and tag the output so. Untagged pieces are
   * read as BT.601 (what ffmpeg and ComfyUI assume when they encode RGB),
   * while browsers show untagged HD as BT.709: without this a stitch of an
   * untagged clip plays with shifted colours. Off for HDR sources, whose
   * primaries / transfer a matrix swap cannot convert.
   */
  bt709?: boolean;
  /** Container comment (the Adrift recipe JSON). */
  comment?: string;
  /** Drop metadata copied from the sources (their recipes, titles). */
  stripMetadata?: boolean;
  /** Crop every piece to fill the frame (absent: letterbox). */
  fit?: RenderFit;
  /** Output codecs (default h264: H.264/AAC mp4). */
  codec?: RenderCodec;
  /** Audio clips mixed in at their times (needs withAudio). */
  lane?: LaneInput[];
  /** Duck the clips' own sound under the lane (sidechain compression). */
  duck?: boolean;
  /** EBU R128 loudness normalisation of the final mix (single pass), LUFS. */
  loudnorm?: number;
}

export const DEFAULT_LOUDNORM_LUFS = -14;
/** True peak and range for loudnorm: streaming-safe, gentle on dynamics. */
export const LOUDNORM_TP = -1.5;
export const LOUDNORM_LRA = 11;
export const DUCK_FILTER =
  "sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400";

/** h264 = H.264/AAC mp4, vp9 = VP9/Opus webm, prores = ProRes 422 HQ/PCM mov. */
export type RenderCodec = "h264" | "vp9" | "prores";

/** VP9 constant-quality level per export quality (lower is better). */
export const VP9_CRF = { high: 24, balanced: 31, small: 36 } as const;

export const MAX_RENDER_EDGE = 3840;
export const MAX_RENDER_FPS = 60;
export const DEFAULT_RENDER_FPS = 24;

const sec = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
/** Short decimal for filter options (no exponent, no trailing zeros). */
const dec = (n: number) => String(Math.round(n * 1e6) / 1e6);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/**
 * Put before every -i: local files only (no http/concat/subfile tricks from a
 * crafted container) and only the video demuxers the editor accepts.
 */
export const INPUT_GUARD = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,mp4,matroska,webm",
] as const;

/** INPUT_GUARD for lane audio: the video containers plus plain audio files. */
export const AUDIO_INPUT_GUARD = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,mp4,matroska,webm,mp3,wav,flac,ogg,aac",
] as const;

/** NTSC rates ffprobe reports as 24000/1001 etc. (rounded to 1e-3 by us). */
const NTSC: [number, string][] = [
  [23.976, "24000/1001"],
  [29.97, "30000/1001"],
  [47.952, "48000/1001"],
  [59.94, "60000/1001"],
];

/** fps for ffmpeg: exact rational for NTSC rates, else the decimal. */
export function fpsExpr(fps: number): string {
  const hit = NTSC.find(([v]) => Math.abs(v - fps) < 0.0015);
  if (hit) return hit[1];
  return String(Math.round(fps * 1000) / 1000);
}

/** Exact frames-per-second value (30000/1001 rather than 29.97). */
export function fpsValue(fps: number): number {
  const [a, b] = fpsExpr(fps).split("/").map(Number);
  return b ? a / b : a;
}

/** Whole output frames for a piece of `seconds` (at least one). */
export function pieceFrames(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fpsValue(fps) - 1e-6));
}

/** True for 29.97 / 59.94: timecode is non-drop-frame frame counting. */
export function isNtscRate(fps: number): boolean {
  return NTSC.some(([v]) => Math.abs(v - fps) < 0.0015);
}

/** scale options: convert to BT.709 limited range (from the input's tags). */
export const BT709_SCALE = ":out_color_matrix=bt709:out_range=tv";
/** Tag frames BT.709 so the encoder writes it into the stream (VUI). */
export const BT709_TAGS =
  ",setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

/** Short click-free fade at each cut (seconds). */
export const CUT_FADE = 0.005;

export interface FormatOverrides {
  /** Crop the first piece's frame to this width / height ratio. */
  aspect?: number;
  /** Scale so the short side is this many px (720, 1080). */
  shortSide?: number;
  /** Output frame rate instead of the pieces' top rate. */
  fps?: number;
}

/**
 * Output size / fps for a set of pieces: the first piece's frame (even,
 * capped at MAX_RENDER_EDGE on the long side) and the highest piece fps
 * (capped). Mixed sizes are letterboxed into it. Overrides crop that frame
 * to an aspect, rescale it, or fix the rate.
 */
export function renderFormat(
  pieces: { width: number; height: number; fps: number }[],
  over: FormatOverrides = {},
): { width: number; height: number; fps: number } {
  const first = pieces.find((p) => p.width > 0 && p.height > 0);
  let w = first?.width ?? 1280;
  let h = first?.height ?? 720;
  if (over.aspect && over.aspect > 0) {
    // Largest crop of that shape inside the first frame.
    if (w / h > over.aspect) w = h * over.aspect;
    else h = w / over.aspect;
  }
  if (over.shortSide && over.shortSide > 0) {
    const k = over.shortSide / Math.min(w, h);
    w *= k;
    h *= k;
  }
  const long = Math.max(w, h);
  if (long > MAX_RENDER_EDGE) {
    const k = MAX_RENDER_EDGE / long;
    w *= k;
    h *= k;
  }
  const fpsList = pieces.map((p) => p.fps).filter((f) => f > 0 && f <= 240);
  const fps =
    over.fps && over.fps > 0
      ? Math.min(MAX_RENDER_FPS, over.fps)
      : fpsList.length
        ? Math.min(MAX_RENDER_FPS, Math.max(...fpsList))
        : DEFAULT_RENDER_FPS;
  return {
    width: even(w),
    height: even(h),
    fps: Math.round(fps * 1000) / 1000,
  };
}

/**
 * atempo steps for a speed: each factor kept within 0.5..2, which every
 * ffmpeg build accepts (0.25x = 0.5 * 0.5, 4x = 2 * 2).
 */
export function atempoChain(speed: number): number[] {
  let s = speed;
  const out: number[] = [];
  while (s > 2 + 1e-9) {
    out.push(2);
    s /= 2;
  }
  while (s < 0.5 - 1e-9) {
    out.push(0.5);
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-9 || out.length === 0) out.push(Math.round(s * 1e6) / 1e6);
  return out;
}

const pieceSpeed = (p: RenderInput) =>
  p.speed && Number.isFinite(p.speed) && p.speed > 0 ? p.speed : 1;

/**
 * Join pieces into one file (H.264/AAC mp4 unless opts.codec says
 * otherwise). Each input is seeked with -ss/-t before -i (fast;
 * frame-accurate because it is re-encoded), scaled and padded to one frame
 * size, fps-normalised, then concatenated, or crossfaded where a piece asks
 * for it. Silent or muted pieces get generated silence so audio stays in
 * sync; lane audio is mixed over the result.
 */
export function buildRenderArgs(
  inputs: RenderInput[],
  outPath: string,
  opts: RenderOptions,
): string[] {
  if (inputs.length === 0) throw new Error("nothing to render");
  const W = even(opts.width);
  const H = even(opts.height);
  const fps = opts.fps > 0 ? opts.fps : DEFAULT_RENDER_FPS;
  const rate = fpsExpr(fps);
  const fv = fpsValue(fps);
  const n = inputs.length;
  const lane = opts.withAudio ? (opts.lane ?? []) : [];
  // Video and audio both get the same frame-based length, so every piece
  // stays in sync however many pieces are joined.
  const frames = inputs.map((p) => pieceFrames((p.out - p.in) / pieceSpeed(p), fps));
  // Crossfade frames into each piece; half comes from either side of the cut.
  const xf = inputs.map((p, i) => {
    if (i === 0 || !p.xfadeIn || !(p.xfadeIn > 0)) return 0;
    const f = Math.min(Math.round(p.xfadeIn * fv), frames[i - 1], frames[i]);
    return f >= 2 ? f : 0;
  });
  const head = xf.map((f) => Math.floor(f / 2));
  const tail = inputs.map((_, i) => (i + 1 < n ? xf[i + 1] - head[i + 1] : 0));
  const total = inputs.map((_, i) => frames[i] + head[i] + tail[i]);
  // Head frames the source has before the in point; the rest hold frame one.
  const headReal = inputs.map((p, i) =>
    Math.min(head[i], Math.floor((p.in / pieceSpeed(p)) * fv + 1e-6)),
  );
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  // Read a little past the out point so the last frame is always there; the
  // frame-exact trim below cuts it back.
  const pad = 2 / fv;
  inputs.forEach((p, i) => {
    const sp = pieceSpeed(p);
    const back = (headReal[i] / fv) * sp;
    args.push(
      "-ss",
      sec(Math.max(0, p.in - back)),
      "-t",
      sec(p.out - p.in + back + (tail[i] / fv) * sp + pad * sp),
      ...INPUT_GUARD,
      "-i",
      p.path,
    );
  });
  for (const l of lane) {
    args.push(
      "-ss",
      sec(l.in),
      "-t",
      sec(l.out - l.in),
      ...AUDIO_INPUT_GUARD,
      "-i",
      l.path,
    );
  }
  const filters: string[] = [];
  const pixFmt = opts.codec === "prores" ? "yuv422p10le" : "yuv420p";
  const fit = opts.fit
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase${opts.bt709 ? BT709_SCALE : ""},` +
      `crop=${W}:${H}:(iw-ow)*${dec(clamp01(opts.fit.x))}:(ih-oh)*${dec(clamp01(opts.fit.y))}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease${opts.bt709 ? BT709_SCALE : ""},` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
  // xfade needs one time base on both sides; concat outputs differ from
  // single pieces, so pieces share AVTB whenever anything is crossfaded.
  const tb = xf.some((f) => f > 0) ? ",settb=AVTB" : "";
  inputs.forEach((p, i) => {
    const speed = pieceSpeed(p);
    const dn = frames[i] / fv;
    const d = (total[i] / fv).toFixed(6);
    // Where the clip's own frames start / end inside the extended piece.
    const t0 = head[i] / fv;
    const t1 = t0 + dn;
    const st0 = head[i] > 0 ? t0.toFixed(6) : "0";
    const fadeIn = Math.min(Math.max(0, p.fadeIn ?? 0), dn / 2);
    const fadeOut = Math.min(Math.max(0, p.fadeOut ?? 0), dn / 2);
    const vFade =
      (fadeIn > 0 ? `,fade=t=in:st=${st0}:d=${fadeIn.toFixed(6)}` : "") +
      (fadeOut > 0
        ? `,fade=t=out:st=${(t1 - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`
        : "");
    const freeze = head[i] - headReal[i];
    const tpad =
      (freeze > 0 ? `start_mode=clone:start=${freeze}:` : "") +
      `stop_mode=clone:stop=${tail[i] + 2}`;
    filters.push(
      `[${i}:v]${fit},setsar=1,` +
        (speed !== 1 ? `setpts=(PTS-STARTPTS)/${dec(speed)},` : "") +
        `fps=${rate},format=${pixFmt}${opts.bt709 ? BT709_TAGS : ""},setpts=PTS-STARTPTS,tpad=${tpad},trim=end_frame=${total[i]},setpts=PTS-STARTPTS${vFade}${tb}[v${i}]`,
    );
    if (!opts.withAudio) return;
    if (p.audio) {
      // A user fade replaces the click-free cut fade at that end; a
      // crossfade needs neither.
      const inFade =
        fadeIn > CUT_FADE
          ? `,afade=t=in:st=${st0}:d=${fadeIn.toFixed(6)}`
          : xf[i] > 0 || dn <= CUT_FADE * 4
            ? ""
            : `,afade=t=in:d=${CUT_FADE}`;
      const outFade =
        fadeOut > CUT_FADE
          ? `,afade=t=out:st=${(t1 - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`
          : tail[i] > 0 || dn <= CUT_FADE * 4
            ? ""
            : `,afade=t=out:st=${(t1 - CUT_FADE).toFixed(6)}:d=${CUT_FADE}`;
      const tempo =
        speed !== 1
          ? atempoChain(speed)
              .map((f) => `,atempo=${dec(f)}`)
              .join("")
          : "";
      const hold = freeze > 0 ? `,adelay=delays=${Math.round((freeze / fv) * 48000)}S:all=1` : "";
      const vol =
        p.volume !== undefined && p.volume !== 1
          ? `,volume=${dec(Math.min(2, Math.max(0, p.volume)))}`
          : "";
      filters.push(
        `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `asetpts=PTS-STARTPTS${tempo}${hold},apad,atrim=duration=${d}${vol}${inFade}${outFade}[a${i}]`,
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
  });
  const norm =
    opts.withAudio && opts.loudnorm !== undefined && Number.isFinite(opts.loudnorm);
  const mixOut = norm ? "[amix]" : "[aout]";
  const aOut = lane.length ? "[abase]" : mixOut;
  const pair = (i: number) => `[v${i}]` + (opts.withAudio ? `[a${i}]` : "");
  // Runs of plain cuts are concatenated; runs are joined by crossfades.
  const runs: number[][] = [];
  inputs.forEach((_, i) => {
    if (i === 0 || xf[i] > 0) runs.push([i]);
    else runs[runs.length - 1].push(i);
  });
  const concat = (run: number[], v: string, a: string) =>
    `${run.map(pair).join("")}concat=n=${run.length}:v=1:a=${opts.withAudio ? 1 : 0}${v}${opts.withAudio ? a : ""}`;
  if (runs.length === 1) {
    filters.push(concat(runs[0], "[vout]", aOut));
  } else {
    const runOut = runs.map((run, j) => {
      if (run.length === 1) return { v: `[v${run[0]}]`, a: `[a${run[0]}]` };
      filters.push(concat(run, `[rv${j}]`, `[ra${j}]`));
      return { v: `[rv${j}]`, a: `[ra${j}]` };
    });
    let acc = runOut[0];
    let accFrames = runs[0].reduce((s, i) => s + total[i], 0);
    for (let j = 1; j < runs.length; j += 1) {
      const first = runs[j][0];
      const f = xf[first];
      const last = j === runs.length - 1;
      const v = last ? "[vout]" : `[xv${j}]`;
      const a = last ? aOut : `[xa${j}]`;
      filters.push(
        `${acc.v}${runOut[j].v}xfade=transition=fade:duration=${(f / fv).toFixed(6)}:offset=${((accFrames - f) / fv).toFixed(6)}${v}`,
      );
      if (opts.withAudio)
        filters.push(
          `${acc.a}${runOut[j].a}acrossfade=ns=${Math.round((f / fv) * 48000)}:c1=tri:c2=tri${a}`,
        );
      acc = { v, a };
      accFrames += runs[j].reduce((s, i) => s + total[i], 0) - f;
    }
  }
  if (lane.length) {
    const labels = lane.map((l, j) => {
      const len = Math.max(0, l.out - l.in);
      const fi = Math.min(Math.max(0, l.fadeIn ?? 0), len / 2);
      const fo = Math.min(Math.max(0, l.fadeOut ?? 0), len / 2);
      const gain =
        l.gain !== undefined && l.gain !== 1
          ? `,volume=${dec(Math.min(2, Math.max(0, l.gain)))}`
          : "";
      const delay = Math.round(Math.max(0, l.at) * 48000);
      filters.push(
        `[${n + j}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `asetpts=PTS-STARTPTS,apad,atrim=duration=${len.toFixed(6)}${gain}` +
          (fi > 0 ? `,afade=t=in:d=${fi.toFixed(6)}` : `,afade=t=in:d=${CUT_FADE}`) +
          (fo > 0
            ? `,afade=t=out:st=${(len - fo).toFixed(6)}:d=${fo.toFixed(6)}`
            : `,afade=t=out:st=${Math.max(0, len - CUT_FADE).toFixed(6)}:d=${CUT_FADE}`) +
          (delay > 0 ? `,adelay=delays=${delay}S:all=1` : "") +
          `[l${j}]`,
      );
      return `[l${j}]`;
    });
    // normalize=0: the lane adds to the clips' sound instead of halving it.
    if (opts.duck) {
      let bus = labels[0];
      if (labels.length > 1) {
        filters.push(
          `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[lbus]`,
        );
        bus = "[lbus]";
      }
      // The key is padded: the compressor stops at its shorter input.
      filters.push(
        `${bus}asplit=2[lkey][lmix]`,
        `[lkey]apad[lkeyp]`,
        `[abase][lkeyp]${DUCK_FILTER}[aduck]`,
        `[aduck][lmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0${mixOut}`,
      );
    } else {
      filters.push(
        `[abase]${labels.join("")}amix=inputs=${lane.length + 1}:duration=first:dropout_transition=0:normalize=0${mixOut}`,
      );
    }
  }
  if (norm)
    filters.push(
      `[amix]loudnorm=I=${dec(Math.min(-5, Math.max(-70, opts.loudnorm as number)))}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA},aresample=48000[aout]`,
    );
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (opts.withAudio) args.push("-map", "[aout]");
  const codec = opts.codec ?? "h264";
  if (codec === "prores") {
    // 422 HQ, 10-bit: an edit master for other software, not for browsers.
    args.push(
      "-c:v",
      "prores_ks",
      "-profile:v",
      "3",
      "-vendor",
      "apl0",
      "-pix_fmt",
      "yuv422p10le",
    );
    if (opts.withAudio) args.push("-c:a", "pcm_s16le");
  } else if (codec === "vp9") {
    const crf = opts.crf ?? VP9_CRF.high;
    args.push(
      "-c:v",
      "libvpx-vp9",
      "-crf",
      String(crf),
      "-b:v",
      "0",
      "-deadline",
      "good",
      "-cpu-used",
      crf <= VP9_CRF.high ? "2" : "4",
      "-row-mt",
      "1",
      "-pix_fmt",
      "yuv420p",
    );
    if (opts.withAudio) args.push("-c:a", "libopus", "-b:a", "160k");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      opts.preset ?? "slow",
      "-crf",
      String(opts.crf ?? 17),
      "-pix_fmt",
      "yuv420p",
    );
    if (opts.withAudio) args.push("-c:a", "aac", "-b:a", "192k");
  }
  if (!opts.withAudio) args.push("-an");
  if (opts.stripMetadata) args.push("-map_metadata", "-1");
  if (opts.comment) args.push("-metadata", `comment=${opts.comment}`);
  if (codec !== "vp9") args.push("-movflags", "+faststart");
  args.push(outPath);
  return args;
}

/**
 * yuv -> RGB for a still that feeds the next step ("last frame -> next
 * clip"): full-chroma bicubic, matrix from the stream's tags. The default
 * chroma upsampling measured ~5.8 dB PSNR lower on a 4:2:0 test clip.
 */
export const RGB_FRAME_VF =
  "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24";

/** One PNG frame at source time `t` (accurate seek: decode from -ss). */
export function buildFrameArgs(
  srcPath: string,
  t: number,
  outPath: string,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    sec(Math.max(0, t)),
    ...INPUT_GUARD,
    "-i",
    srcPath,
    "-vf",
    RGB_FRAME_VF,
    "-frames:v",
    "1",
    "-update",
    "1",
    outPath,
  ];
}

/** One input of a composited still (FrameLayer with a local path). */
export interface FrameInput {
  path: string;
  /** Source seconds. */
  t: number;
  weight: number;
  level: number;
}

/**
 * A still blended from several source frames (crossfade) and darkened by
 * fades, as the render draws them: each frame fitted into width x height
 * (letterboxed), scaled to RGB, multiplied by its level, then mixed by
 * weight.
 */
export function buildCompositeFrameArgs(
  layers: FrameInput[],
  outPath: string,
  width: number,
  height: number,
): string[] {
  if (layers.length === 0) throw new Error("nothing to draw");
  const W = Math.max(2, Math.round(width));
  const H = Math.max(2, Math.round(height));
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const l of layers)
    args.push("-ss", sec(Math.max(0, l.t)), ...INPUT_GUARD, "-i", l.path);
  const graph = layers.map((l, i) => {
    const k = Math.min(1, Math.max(0, l.level));
    return (
      `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic+accurate_rnd+full_chroma_int,` +
      `format=gbrp,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1` +
      (k < 1 ? `,colorchannelmixer=rr=${dec(k)}:gg=${dec(k)}:bb=${dec(k)}` : "") +
      `[f${i}]`
    );
  });
  const weights = layers.map((l) => dec(Math.max(0, l.weight))).join(" ");
  graph.push(
    layers.length === 1
      ? "[f0]format=rgb24[out]"
      : `${layers.map((_, i) => `[f${i}]`).join("")}mix=inputs=${layers.length}:weights='${weights}',format=rgb24[out]`,
  );
  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-update",
    "1",
    outPath,
  );
  return args;
}

/**
 * Tiles in a source's filmstrip: about two per second, 8..32. Chosen by the
 * server from the probed length, so one strip serves every zoom level.
 */
export function filmstripTileCount(duration: number): number {
  return Math.max(8, Math.min(32, Math.round(duration * 2)));
}

/** Source times of the filmstrip tiles: the middle of each equal slice. */
export function filmstripTimes(duration: number, count: number): number[] {
  const n = Math.max(1, Math.min(60, Math.round(count)));
  const d = Math.max(0.001, duration);
  return Array.from({ length: n }, (_, i) =>
    Math.min(Math.max(0, d - 0.05), ((i + 0.5) * d) / n),
  );
}

/**
 * Filmstrip sprite: `count` frames tiled in one row, each `tileH` px tall.
 * One input per tile with its own fast seek, so a long source is never
 * decoded end to end.
 */
export function buildFilmstripArgs(
  srcPath: string,
  duration: number,
  count: number,
  tileW: number,
  tileH: number,
  outPath: string,
): string[] {
  const times = filmstripTimes(duration, count);
  const n = times.length;
  const w = even(tileW);
  const h = even(tileH);
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const t of times) args.push("-ss", sec(t), ...INPUT_GUARD, "-i", srcPath);
  const tile = (i: number) =>
    `[${i}:v]trim=end_frame=1,scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h},setsar=1,format=yuvj420p`;
  const graph =
    n === 1
      ? `${tile(0)}[out]`
      : times.map((_, i) => `${tile(i)}[t${i}]`).join(";") +
        `;${times.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${n}[out]`;
  args.push(
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-an",
    "-frames:v",
    "1",
    "-q:v",
    "5",
    "-update",
    "1",
    outPath,
  );
  return args;
}

export function buildProbeArgs(srcPath: string, audio = false): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    ...(audio ? AUDIO_INPUT_GUARD : INPUT_GUARD),
    srcPath,
  ];
}

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  /** PQ / HLG transfer or BT.2020 primaries. */
  hdr: boolean;
}

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

function parseRate(r: unknown): number {
  if (typeof r !== "string") return 0;
  const [a, b] = r.split("/").map(Number);
  if (!Number.isFinite(a) || a <= 0) return 0;
  const v = b && Number.isFinite(b) && b > 0 ? a / b : a;
  return v > 0 && v <= 240 ? Math.round(v * 1000) / 1000 : 0;
}

/** ffprobe JSON → ProbeInfo; null when there is no video stream. */
export function parseProbe(json: unknown): ProbeInfo | null {
  if (!json || typeof json !== "object") return null;
  const o = json as {
    streams?: Record<string, unknown>[];
    format?: Record<string, unknown>;
  };
  const streams = Array.isArray(o.streams) ? o.streams : [];
  const v = streams.find(
    (s) =>
      s.codec_type === "video" &&
      // Cover art in audio files is a one-frame "video" stream.
      !(s.disposition as Record<string, number> | undefined)?.attached_pic,
  );
  if (!v) return null;
  const a = streams.some((s) => s.codec_type === "audio");
  const dur = Number(o.format?.duration) || Number(v.duration) || 0;
  let width = Number(v.width) || 0;
  let height = Number(v.height) || 0;
  // Phone clips: a 90/270° rotation swaps the displayed frame.
  const sideData = Array.isArray(v.side_data_list)
    ? (v.side_data_list as Record<string, unknown>[])
    : [];
  const rotation = Math.abs(
    Number(
      sideData.find((s) => s.rotation !== undefined)?.rotation ??
        (v.tags as Record<string, unknown> | undefined)?.rotate ??
        0,
    ),
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    duration: Math.round(dur * 1e6) / 1e6,
    width,
    height,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
    hasAudio: a,
    videoCodec: typeof v.codec_name === "string" ? v.codec_name : "",
    hdr:
      HDR_TRANSFERS.has(String(v.color_transfer)) ||
      String(v.color_primaries) === "bt2020",
  };
}

/**
 * ffprobe JSON → length of a file's sound; null when it has none.
 * `audioOnly` (an audio file extension) also rejects a picture stream
 * other than cover art: a video renamed to .mp3 is not an audio file.
 */
export function parseAudioProbe(
  json: unknown,
  opts: { audioOnly?: boolean } = {},
): { duration: number } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as {
    streams?: Record<string, unknown>[];
    format?: Record<string, unknown>;
  };
  const streams = Array.isArray(o.streams) ? o.streams : [];
  const a = streams.find((s) => s.codec_type === "audio");
  if (!a) return null;
  if (
    opts.audioOnly &&
    streams.some(
      (s) =>
        s.codec_type === "video" &&
        !(s.disposition as Record<string, number> | undefined)?.attached_pic,
    )
  )
    return null;
  const dur = Number(o.format?.duration) || Number(a.duration) || 0;
  return dur > 0 ? { duration: Math.round(dur * 1e6) / 1e6 } : null;
}

/** Waveform image width for a source: ~80 px per second, 200..4000. */
export function waveformWidth(duration: number): number {
  return Math.max(200, Math.min(4000, Math.round(duration * 80)));
}

/**
 * Whole-source audio waveform as one PNG (transparent background, mono,
 * sqrt scale so quiet passages still show). The timeline slices it per clip
 * like the filmstrip.
 */
export function buildWaveformArgs(
  srcPath: string,
  width: number,
  height: number,
  outPath: string,
  audio = false,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    ...(audio ? AUDIO_INPUT_GUARD : INPUT_GUARD),
    "-i",
    srcPath,
    "-filter_complex",
    `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${even(width)}x${even(height)}:colors=white:scale=sqrt[out]`,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-update",
    "1",
    outPath,
  ];
}

export interface ConformOptions {
  /** Output length in seconds (the video's own length). */
  duration: number;
  /** Second input whose first audio stream replaces the video's sound. */
  audioPath?: string;
  /** Re-time the picture to this rate (frames dropped / repeated). */
  fps?: number;
  /** Stream-copy the picture (no fps change, mp4-safe codec). */
  copyVideo: boolean;
}

/**
 * Conform a tool result before it goes back on the timeline: put the cut's
 * original sound under it (padded with silence / trimmed to the picture)
 * and / or bring it to the edit's frame rate.
 */
export function buildConformArgs(
  videoPath: string,
  outPath: string,
  opts: ConformOptions,
): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", ...INPUT_GUARD, "-i", videoPath];
  if (opts.audioPath) args.push(...INPUT_GUARD, "-i", opts.audioPath);
  args.push("-map", "0:v:0");
  if (opts.audioPath) args.push("-map", "1:a:0");
  else args.push("-map", "0:a:0?");
  if (opts.copyVideo && !opts.fps) {
    args.push("-c:v", "copy");
  } else {
    const vf = [
      ...(opts.fps ? [`fps=${fpsExpr(opts.fps)}`] : []),
      "format=yuv420p",
    ].join(",");
    args.push("-vf", vf, "-c:v", "libx264", "-preset", "fast", "-crf", "12");
  }
  if (opts.audioPath)
    args.push(
      "-af",
      "aresample=48000,aformat=channel_layouts=stereo,apad",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
    );
  else args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-t", sec(opts.duration), "-movflags", "+faststart", outPath);
  return args;
}

/** Longest piece Reverse takes (ffmpeg's reverse holds every frame in memory). */
export const MAX_REVERSE_SECONDS = 10;
export const MAX_FREEZE_SECONDS = 10;

/** Source [in, out) played backwards (picture and sound), near-lossless H.264. */
export function buildReverseArgs(
  srcPath: string,
  inT: number,
  outT: number,
  outPath: string,
  hasAudio: boolean,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    sec(inT),
    "-t",
    sec(outT - inT),
    ...INPUT_GUARD,
    "-i",
    srcPath,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-vf",
    "reverse,format=yuv420p",
    ...(hasAudio
      ? ["-af", "areverse", "-c:a", "aac", "-b:a", "192k"]
      : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "12",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

/** The frame at source time `t` held for `seconds` (silent), at `fps`. */
export function buildFreezeArgs(
  srcPath: string,
  t: number,
  seconds: number,
  fps: number,
  outPath: string,
): string[] {
  const rate = fpsExpr(fps > 0 ? fps : DEFAULT_RENDER_FPS);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    sec(Math.max(0, t)),
    ...INPUT_GUARD,
    "-i",
    srcPath,
    "-map",
    "0:v:0",
    "-vf",
    `trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${sec(seconds + 1)},fps=${rate},format=yuv420p`,
    "-an",
    "-t",
    sec(seconds),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "12",
    "-tune",
    "stillimage",
    "-movflags",
    "+faststart",
    outPath,
  ];
}
