/**
 * Post-render video QC: ffmpeg filter arguments, stderr parsers and the
 * pass / warn / fail decision. Pure (no node imports): the server runner is
 * ./server.ts, the badge reads the stored result.
 *
 * One decode pass runs blackdetect + freezedetect + scdet on a downscaled
 * copy and silencedetect on the audio; the probe (ffprobe) gives duration,
 * fps, size and whether there is an audio track at all.
 */

import type { VideoQcThresholds } from "./settings";

export type QcStatus = "pass" | "warn" | "fail";
export type QcIssueKind =
  | "black"
  | "freeze"
  | "jump"
  | "silence"
  | "no_audio"
  | "duration"
  | "fps"
  | "resolution"
  | "unreadable"
  | "safety_filter";

export interface QcIssue {
  kind: QcIssueKind;
  severity: "warn" | "fail";
  /** Seconds into the clip; absent for whole-clip issues. */
  start?: number;
  end?: number;
  message: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface QcDetections {
  black: Span[];
  freeze: Span[];
  jumps: { time: number; score: number }[];
  silence: Span[];
}

export interface QcProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/** What the run asked for (from the graph / run params); all optional. */
export interface QcExpect {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  duration?: number;
  /** The tool produces sound (silence checks only run when true). */
  audio?: boolean;
  /**
   * Seconds where cuts are intended (stitch seams): jumps there are not
   * issues.
   */
  seams?: number[];
}

export interface QcResult {
  status: QcStatus;
  issues: QcIssue[];
  probe?: QcProbe;
  expect?: QcExpect;
}

const SCALE_WIDTH = 480;

/** ffmpeg argv for the detection pass (stderr carries the results). */
export function buildQcArgs(
  input: string,
  t: VideoQcThresholds,
  hasAudio: boolean,
): string[] {
  const vf = [
    `scale=${SCALE_WIDTH}:-2`,
    `blackdetect=d=${t.blackMinSec}:pix_th=${t.blackPixel}`,
    `freezedetect=n=${t.freezeNoiseDb}dB:d=${t.freezeMinSec}`,
    `scdet=threshold=${t.jumpScore}`,
  ].join(",");
  return [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-loglevel",
    "info",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    vf,
    ...(hasAudio
      ? [
          "-map",
          "0:a:0",
          "-af",
          `silencedetect=n=${t.silenceDb}dB:d=${t.silenceMinSec}`,
        ]
      : []),
    "-f",
    "null",
    "-",
  ];
}

const NUM = "(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)";
const BLACK_RE = new RegExp(
  `black_start:\\s*${NUM}\\s+black_end:\\s*${NUM}`,
  "i",
);
const FREEZE_START_RE = new RegExp(`freezedetect\\.freeze_start:\\s*${NUM}`);
const FREEZE_END_RE = new RegExp(`freezedetect\\.freeze_end:\\s*${NUM}`);
const SCD_RE = new RegExp(
  `lavfi\\.scd\\.score:\\s*${NUM},?\\s*lavfi\\.scd\\.time:\\s*${NUM}`,
);
const SILENCE_START_RE = new RegExp(`silence_start:\\s*${NUM}`);
const SILENCE_END_RE = new RegExp(`silence_end:\\s*${NUM}`);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * ffmpeg stderr → detections. Spans still open at EOF (a freeze or silence
 * that runs to the end) are closed at `duration` when it is known.
 */
export function parseQcStderr(stderr: string, duration = 0): QcDetections {
  const out: QcDetections = { black: [], freeze: [], jumps: [], silence: [] };
  let freezeStart: number | null = null;
  let silenceStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = BLACK_RE.exec(line);
    if (m) {
      out.black.push({ start: r3(+m[1]), end: r3(+m[2]) });
      continue;
    }
    if ((m = FREEZE_START_RE.exec(line))) {
      freezeStart = +m[1];
      continue;
    }
    if ((m = FREEZE_END_RE.exec(line))) {
      if (freezeStart !== null)
        out.freeze.push({ start: r3(freezeStart), end: r3(+m[1]) });
      freezeStart = null;
      continue;
    }
    if ((m = SCD_RE.exec(line))) {
      out.jumps.push({ score: +m[1], time: r3(+m[2]) });
      continue;
    }
    if ((m = SILENCE_START_RE.exec(line))) {
      silenceStart = Math.max(0, +m[1]);
      continue;
    }
    if ((m = SILENCE_END_RE.exec(line))) {
      if (silenceStart !== null)
        out.silence.push({ start: r3(silenceStart), end: r3(+m[1]) });
      silenceStart = null;
    }
  }
  if (duration > 0) {
    if (freezeStart !== null && duration > freezeStart)
      out.freeze.push({ start: r3(freezeStart), end: r3(duration) });
    if (silenceStart !== null && duration > silenceStart)
      out.silence.push({ start: r3(silenceStart), end: r3(duration) });
  }
  return out;
}

const len = (s: Span) => Math.max(0, s.end - s.start);
const total = (spans: Span[]) => spans.reduce((a, s) => a + len(s), 0);

function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Black frames are also identical frames: report them once, as black. */
function freezesOutsideBlack(freeze: Span[], black: Span[]): Span[] {
  return freeze.filter((f) => {
    const covered = black.reduce((a, b) => a + overlap(f, b), 0);
    return covered < 0.8 * len(f);
  });
}

/** Seconds as "1.5s" / "1:02.3". */
export function fmtTime(sec: number): string {
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${(Math.round(s * 10) / 10).toFixed(1)}`;
}

const spanText = (s: Span) => `${fmtTime(s.start)}–${fmtTime(s.end)}`;

/** Edges where a jump is expected: clip start, black edges, stitch seams. */
function nearExpectedEdge(
  time: number,
  black: Span[],
  seams: number[] | undefined,
): boolean {
  if (time < 0.05) return true;
  const tol = 0.25;
  if (
    black.some(
      (b) => Math.abs(b.start - time) < tol || Math.abs(b.end - time) < tol,
    )
  )
    return true;
  return (seams ?? []).some((s) => Math.abs(s - time) < tol);
}

export function worstStatus(statuses: Iterable<QcStatus>): QcStatus {
  let out: QcStatus = "pass";
  for (const s of statuses) {
    if (s === "fail") return "fail";
    if (s === "warn") out = "warn";
  }
  return out;
}

/** Probe + detections + expectations → issues and the overall verdict. */
export function evaluateQc(
  probe: QcProbe | null,
  det: QcDetections,
  expect: QcExpect,
  t: VideoQcThresholds,
): QcResult {
  if (!probe || !(probe.duration > 0)) {
    return {
      status: "fail",
      issues: [
        {
          kind: "unreadable",
          severity: "fail",
          message: "No playable video stream",
        },
      ],
      expect,
    };
  }
  const dur = probe.duration;
  const issues: QcIssue[] = [];

  const blackTotal = total(det.black);
  const blackFail = blackTotal >= t.blackFailFraction * dur;
  for (const b of det.black)
    issues.push({
      kind: "black",
      severity: blackFail ? "fail" : "warn",
      start: b.start,
      end: b.end,
      message: `Black frames ${spanText(b)}`,
    });

  const freeze = freezesOutsideBlack(det.freeze, det.black);
  const freezeFail = total(freeze) >= t.freezeFailFraction * dur;
  for (const f of freeze)
    issues.push({
      kind: "freeze",
      severity: freezeFail ? "fail" : "warn",
      start: f.start,
      end: f.end,
      message: `Frozen ${spanText(f)}`,
    });

  const jumps = det.jumps.filter(
    (j) =>
      j.score >= t.jumpScore &&
      !nearExpectedEdge(j.time, det.black, expect.seams),
  );
  const jumpFail = jumps.length >= t.jumpFailCount;
  for (const j of jumps)
    issues.push({
      kind: "jump",
      severity: jumpFail ? "fail" : "warn",
      start: j.time,
      end: j.time,
      message: `Sudden jump at ${fmtTime(j.time)} (score ${Math.round(j.score)})`,
    });

  if (expect.audio) {
    if (!probe.hasAudio) {
      issues.push({
        kind: "no_audio",
        severity: "fail",
        message: "No audio track (this tool should have sound)",
      });
    } else {
      const silentFail = total(det.silence) >= t.silenceFailFraction * dur;
      if (silentFail) {
        issues.push({
          kind: "silence",
          severity: "fail",
          start: 0,
          end: r3(dur),
          message: "Audio is silent",
        });
      } else {
        for (const s of det.silence)
          issues.push({
            kind: "silence",
            severity: "warn",
            start: s.start,
            end: s.end,
            message: `Silent ${spanText(s)}`,
          });
      }
    }
  }

  const tol = t.durationTolerance;
  const wantDur =
    expect.duration ??
    (expect.frames && expect.fps ? expect.frames / expect.fps : undefined);
  if (wantDur && wantDur > 0) {
    // One frame of slack: frame counts like 8k+1 round either way.
    const slack = Math.max(tol * wantDur, 1 / (expect.fps || probe.fps || 24));
    if (dur < 0.5 * wantDur)
      issues.push({
        kind: "duration",
        severity: "fail",
        message: `Only ${fmtTime(dur)} of the requested ${fmtTime(wantDur)}`,
      });
    else if (Math.abs(dur - wantDur) > slack)
      issues.push({
        kind: "duration",
        severity: "warn",
        message: `Length ${fmtTime(dur)}, requested ${fmtTime(wantDur)}`,
      });
  }
  if (
    expect.fps &&
    probe.fps > 0 &&
    Math.abs(probe.fps - expect.fps) > tol * expect.fps
  )
    issues.push({
      kind: "fps",
      severity: "warn",
      message: `${Math.round(probe.fps * 100) / 100} fps, requested ${expect.fps}`,
    });
  if (expect.width && expect.height && probe.width > 0 && probe.height > 0) {
    const wantAr = expect.width / expect.height;
    const ar = probe.width / probe.height;
    // Larger is fine (an upscale pass); smaller or another shape is not.
    const smaller =
      probe.width < expect.width * (1 - tol) ||
      probe.height < expect.height * (1 - tol);
    if (Math.abs(ar - wantAr) / wantAr > 0.03 || smaller)
      issues.push({
        kind: "resolution",
        severity: "warn",
        message: `${probe.width}×${probe.height}, requested ${expect.width}×${expect.height}`,
      });
  }

  issues.sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
  return {
    status: worstStatus(issues.map((i) => i.severity)),
    issues,
    probe,
    expect,
  };
}

// Expectations from the submitted ComfyUI graph (history prompt[2]).

type GraphNode = { class_type?: unknown; inputs?: Record<string, unknown> };
type Graph = Record<string, GraphNode>;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
const isLink = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

const VIDEO_OUT_RE =
  /CreateVideo|VideoCombine|SaveVideo|SaveWEBM|SaveAnimated/i;
const LATENT_VIDEO_RE =
  /^Empty.*(Video|LTXV).*Latent|^Empty.*Latent.*Video|ImageToVideo|ImgToVideo|TextToVideo|FirstLastFrame/i;

/**
 * Requested fps / length / size read from the graph's literal inputs.
 * Frames and size come from the video latent node only when the graph has
 * exactly one (extend / multi-pass graphs are left unchecked).
 */
export function expectationsFromGraph(graph: unknown): QcExpect {
  if (!graph || typeof graph !== "object") return {};
  const nodes = Object.values(graph as Graph).filter(
    (n): n is GraphNode => !!n && typeof n === "object",
  );
  const out: QcExpect = {};
  for (const n of nodes) {
    const ct = String(n.class_type ?? "");
    if (!VIDEO_OUT_RE.test(ct)) continue;
    const fps = num(n.inputs?.fps) ?? num(n.inputs?.frame_rate);
    if (fps) {
      out.fps = fps;
      break;
    }
  }
  const latents = nodes.filter((n) =>
    LATENT_VIDEO_RE.test(String(n.class_type ?? "")),
  );
  if (latents.length === 1) {
    const i = latents[0].inputs ?? {};
    const frames = num(i.length) ?? num(i.num_frames) ?? num(i.frames);
    if (frames && frames > 1) out.frames = frames;
    const w = num(i.width);
    const h = num(i.height);
    if (w && h) {
      out.width = w;
      out.height = h;
    }
  }
  // A saver with sound wired in: the clip should not come out silent.
  if (nodes.some((n) => VIDEO_OUT_RE.test(String(n.class_type ?? "")) && isLink(n.inputs?.audio)))
    out.audio = true;
  return out;
}

/** Stitch runs (params.clips with seconds): seams and per-clip spans. */
export function stitchClipSpans(
  params: Record<string, unknown> | null | undefined,
): { video: string; start: number; end: number }[] | null {
  const clips = params?.clips;
  if (!Array.isArray(clips) || clips.length < 2) return null;
  const fade =
    params?.transition === "fade" && typeof params.fadeSeconds === "number"
      ? params.fadeSeconds
      : 0;
  const spans: { video: string; start: number; end: number }[] = [];
  let at = 0;
  for (const c of clips) {
    const rec = c as Record<string, unknown>;
    const secs = num(rec?.seconds);
    if (typeof rec?.video !== "string" || !secs) return null;
    const start = spans.length === 0 ? 0 : at - fade;
    const end = start + secs;
    spans.push({ video: rec.video, start: r3(start), end: r3(end) });
    at = end;
  }
  return spans;
}

/** Expectations from run params (stitch seams, explicit fps/length/audio). */
export function expectationsFromParams(
  params: Record<string, unknown> | null | undefined,
): QcExpect {
  if (!params) return {};
  const out: QcExpect = {};
  const fps = num(params.fps) ?? num(params.frame_rate);
  if (fps) out.fps = fps;
  const frames =
    num(params.frames) ?? num(params.num_frames) ?? num(params.length);
  if (frames && frames > 1 && Number.isInteger(frames)) out.frames = frames;
  const dur = num(params.duration) ?? num(params.seconds);
  if (dur) out.duration = dur;
  const spans = stitchClipSpans(params);
  if (spans) {
    out.seams = spans.slice(1).map((s) => s.start);
    if (!out.duration) out.duration = r3(spans[spans.length - 1].end);
    if (params.audio === true) out.audio = true;
  }
  return out;
}

/** Graph wins for what it states; params fill the rest. */
export function mergeExpect(graph: QcExpect, params: QcExpect): QcExpect {
  return {
    ...params,
    ...Object.fromEntries(
      Object.entries(graph).filter(([, v]) => v !== undefined),
    ),
    ...(params.seams ? { seams: params.seams } : {}),
    ...(graph.audio || params.audio ? { audio: true } : {}),
  };
}

/**
 * For a stitched clip: the source clip under the worst issue (fail before
 * warn, earliest first), so only that segment is re-rolled.
 */
export function badSegment(
  result: Pick<QcResult, "issues">,
  params: Record<string, unknown> | null | undefined,
): { index: number; video: string } | null {
  const spans = stitchClipSpans(params);
  if (!spans) return null;
  const timed = result.issues
    .filter((i) => typeof i.start === "number")
    .sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1) ||
        (a.start ?? 0) - (b.start ?? 0),
    );
  for (const issue of timed) {
    const mid = ((issue.start ?? 0) + (issue.end ?? issue.start ?? 0)) / 2;
    const index = spans.findIndex((s) => mid >= s.start && mid < s.end);
    if (index >= 0) return { index, video: spans[index].video };
  }
  return null;
}

// Re-roll

const SEED_KEYS = new Set(["seed", "noise_seed"]);
/** Below 2^48 keeps seeds exact in JSON and valid for every sampler. */
const SEED_MAX = 2 ** 48;

/**
 * Copy of the graph with every literal seed / noise_seed replaced by a new
 * random value. Linked seeds (a primitive node) are left alone; the
 * primitive itself carries the literal and is replaced instead.
 */
export function reseedGraph(
  graph: Record<string, unknown>,
  rand: () => number = Math.random,
): { graph: Record<string, unknown>; seed: number | null; changed: number } {
  const copy = JSON.parse(JSON.stringify(graph)) as Graph;
  let first: number | null = null;
  let changed = 0;
  for (const id of Object.keys(copy).sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b),
  )) {
    const inputs = copy[id]?.inputs;
    if (!inputs) continue;
    for (const key of Object.keys(inputs)) {
      if (!SEED_KEYS.has(key) || typeof inputs[key] !== "number") continue;
      let next = Math.floor(rand() * SEED_MAX);
      if (next === inputs[key]) next = (next + 1) % SEED_MAX;
      inputs[key] = next;
      first ??= next;
      changed += 1;
    }
  }
  return { graph: copy as Record<string, unknown>, seed: first, changed };
}

/** Auto re-roll only for a failed clip that still has tries left. */
export function shouldAutoReroll(
  status: QcStatus,
  attempt: number,
  opts: { autoReroll: boolean; maxTries: number },
  alreadyRerolled: boolean,
): boolean {
  return (
    opts.autoReroll &&
    status === "fail" &&
    !alreadyRerolled &&
    attempt <= opts.maxTries
  );
}
