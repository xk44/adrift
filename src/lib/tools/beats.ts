/**
 * Client-side beat detection for ClipCut (beat-synced look reels). Pure DSP
 * on a mono Float32Array so it runs under vitest on synthetic audio; the
 * browser wrapper (analyzeAudioUrl) only decodes the file with WebAudio.
 *
 *   1. onset envelope   log-energy flux of the signal and of its first
 *                       difference (hats / snares), half-wave rectified,
 *                       minus a moving mean
 *   2. tempo            autocorrelation of the envelope over 70-180 BPM
 *                       (or +-6% around a known BPM), weighted towards
 *                       ~120 BPM to avoid octave errors, parabolic refine
 *   3. beat grid        best phase for that period, then each beat snaps to
 *                       a nearby envelope peak (tolerates small drift)
 */

export const BEAT_HOP = 512;
export const BEAT_WINDOW = 1024;
export const BPM_RANGE = { min: 70, max: 180 } as const;
/** Allowed tempo error around a known BPM (generated music). */
export const BPM_HINT_TOLERANCE = 0.06;
export const DEFAULT_BPM = 120;

export interface BeatAnalysis {
  bpm: number;
  /** Beat times in seconds (grid, peak-snapped). */
  beats: number[];
  /** Strong onsets in seconds (peak-picked envelope). */
  onsets: number[];
  duration: number;
  /** 0..1, autocorrelation peak strength; 0 = fallback grid. */
  confidence: number;
}

export interface OnsetEnvelope {
  env: Float32Array;
  /** Seconds per envelope frame. */
  hopSeconds: number;
  /**
   * Seconds to add to frame * hopSeconds: frame f first "sees" a transient
   * at sample s when f * hop is between s - win and s - win + hop.
   */
  latency: number;
}

/** Onset strength per hop (non-negative, mean-removed). */
export function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  hop = BEAT_HOP,
  win = BEAT_WINDOW,
): OnsetEnvelope {
  const frames = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  const logE = new Float32Array(frames);
  const logD = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let e = 0;
    let d = 0;
    let prev = start > 0 ? samples[start - 1] : 0;
    for (let i = start; i < start + win; i++) {
      const x = samples[i];
      e += x * x;
      const dx = x - prev;
      d += dx * dx;
      prev = x;
    }
    logE[f] = Math.log(1e-10 + e / win);
    logD[f] = Math.log(1e-10 + d / win);
  }
  const raw = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    raw[f] =
      Math.max(0, logE[f] - logE[f - 1]) + Math.max(0, logD[f] - logD[f - 1]);
  }
  // Moving-mean removal (~0.4 s) keeps only the transients.
  const hopSeconds = hop / sampleRate;
  const half = Math.max(1, Math.round(0.2 / hopSeconds));
  const env = new Float32Array(frames);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) sum += raw[++hi];
    while (lo < f - half) sum -= raw[lo++];
    const mean = sum / (hi - lo + 1);
    env[f] = Math.max(0, raw[f] - mean);
  }
  return { env, hopSeconds, latency: (win - hop / 2) / sampleRate };
}

/** [1 2 1]/4 blur, twice: widens 1-frame spikes so fractional periods still correlate. */
function smooth(env: Float32Array): Float32Array {
  let cur = env;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(cur.length);
    for (let i = 0; i < cur.length; i++)
      out[i] =
        0.25 * (cur[i - 1] ?? cur[i]) + 0.5 * cur[i] + 0.25 * (cur[i + 1] ?? cur[i]);
    cur = out;
  }
  return cur;
}

function autocorr(env: Float32Array, lag: number): number {
  let s = 0;
  for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
  return s;
}

/** Tempo from the envelope; null when there is no periodic structure. */
export function estimateTempo(
  e: OnsetEnvelope,
  bpmHint?: number,
): { bpm: number; periodFrames: number; confidence: number } | null {
  const { hopSeconds } = e;
  const env = smooth(e.env);
  const zero = autocorr(env, 0);
  if (!(zero > 1e-9)) return null;
  const hint =
    typeof bpmHint === "number" && bpmHint >= 40 && bpmHint <= 240
      ? bpmHint
      : null;
  const minBpm = hint ? hint * (1 - BPM_HINT_TOLERANCE) : BPM_RANGE.min;
  const maxBpm = hint ? hint * (1 + BPM_HINT_TOLERANCE) : BPM_RANGE.max;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / hopSeconds));
  const maxLag = Math.min(env.length - 2, Math.ceil(60 / minBpm / hopSeconds));
  if (maxLag <= minLag) return null;
  const ac: number[] = [];
  for (let lag = 0; lag <= maxLag + 1; lag++)
    ac[lag] = lag >= minLag - 1 ? autocorr(env, lag) : 0;
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSeconds);
    // Log-Gaussian tempo prior around 120 BPM (octave errors), off with a hint.
    const prior = hint
      ? 1
      : Math.exp(-0.5 * (Math.log2(bpm / DEFAULT_BPM) / 0.9) ** 2);
    const score = ac[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || ac[best] <= 0) return null;
  // Parabolic refinement to a fractional lag.
  const a = ac[best - 1] ?? ac[best];
  const b = ac[best];
  const c = ac[best + 1] ?? ac[best];
  const denom = a - 2 * b + c;
  const offset =
    denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const periodFrames = best + offset;
  return {
    bpm: Math.round((60 / (periodFrames * hopSeconds)) * 10) / 10,
    periodFrames,
    confidence: Math.max(0, Math.min(1, b / zero)),
  };
}

/** Strong onsets: local maxima above mean + 1 std, at least 0.1 s apart. */
export function pickOnsets(e: OnsetEnvelope): number[] {
  const { env, hopSeconds, latency } = e;
  const n = env.length;
  if (!n) return [];
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of env) variance += (v - mean) ** 2;
  const threshold = mean + Math.sqrt(variance / n);
  const gap = Math.max(1, Math.round(0.1 / hopSeconds));
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v <= threshold || v < env[i - 1] || v < env[i + 1]) continue;
    if (i - last < gap) continue;
    out.push(Math.round((i * hopSeconds + latency) * 1000) / 1000);
    last = i;
  }
  return out;
}

/** Evenly spaced grid (seconds) from `start` to `duration`. */
export function beatGrid(bpm: number, duration: number, start = 0): number[] {
  const period = 60 / (bpm > 0 ? bpm : DEFAULT_BPM);
  const out: number[] = [];
  for (let t = start; t < duration - 1e-6; t += period)
    out.push(Math.round(t * 1000) / 1000);
  return out;
}

/** Full analysis of mono samples. */
export function detectBeats(
  samples: Float32Array,
  sampleRate: number,
  opts: { bpmHint?: number } = {},
): BeatAnalysis {
  const duration = samples.length / sampleRate;
  const e = onsetEnvelope(samples, sampleRate);
  const tempo = estimateTempo(e, opts.bpmHint);
  const onsets = pickOnsets(e);
  if (!tempo) {
    const bpm = opts.bpmHint && opts.bpmHint > 0 ? opts.bpmHint : DEFAULT_BPM;
    return {
      bpm,
      beats: beatGrid(bpm, duration),
      onsets,
      duration,
      confidence: 0,
    };
  }
  const { env, hopSeconds } = e;
  const P = tempo.periodFrames;
  // Best phase: grid that collects the most onset energy.
  let bestPhase = 0;
  let bestScore = -1;
  const steps = Math.max(1, Math.ceil(P));
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let t = p; t < env.length; t += P) s += env[Math.round(t)] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestPhase = p;
    }
  }
  // Snap each grid beat to the strongest frame within +-8% of a period.
  const radius = Math.max(1, Math.round(P * 0.08));
  const beats: number[] = [];
  for (let t = bestPhase; t < env.length; t += P) {
    const c = Math.round(t);
    let at = c;
    let peak = env[c] ?? 0;
    for (let k = c - radius; k <= c + radius; k++) {
      if (k < 0 || k >= env.length) continue;
      if (env[k] > peak * 1.5) {
        peak = env[k];
        at = k;
      }
    }
    beats.push(Math.round((at * hopSeconds + e.latency) * 1000) / 1000);
  }
  return {
    bpm: tempo.bpm,
    beats,
    onsets,
    duration,
    confidence: Math.round(tempo.confidence * 1000) / 1000,
  };
}

/** Average all channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Browser only: fetch + decode an audio URL with WebAudio, then detect. */
export async function analyzeAudioUrl(
  url: string,
  opts: { bpmHint?: number } = {},
): Promise<BeatAnalysis> {
  const Ctx =
    typeof window !== "undefined"
      ? (window.OfflineAudioContext ??
        (
          window as unknown as {
            webkitOfflineAudioContext?: typeof OfflineAudioContext;
          }
        ).webkitOfflineAudioContext)
      : undefined;
  if (!Ctx)
    throw new Error("This browser can't decode audio for beat detection.");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read the music (${res.status})`);
  const data = await res.arrayBuffer();
  // 22.05 kHz is plenty for onsets and halves the work.
  const ctx = new Ctx(1, 1, 22050);
  const buf = await ctx.decodeAudioData(data);
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) =>
    buf.getChannelData(i),
  );
  return detectBeats(downmix(channels), buf.sampleRate, opts);
}
