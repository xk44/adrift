import { describe, expect, it } from "vitest";
import {
  beatGrid,
  detectBeats,
  downmix,
  estimateTempo,
  onsetEnvelope,
  pickOnsets,
} from "@/lib/tools/beats";

const SR = 22050;

/** Deterministic PRNG so the noise is the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Click track: short decaying noise bursts on every beat, optional noise floor. */
function clickTrack(
  bpm: number,
  seconds: number,
  opts: { offset?: number; noise?: number; accent?: boolean } = {},
) {
  const out = new Float32Array(Math.round(seconds * SR));
  const rand = rng(7);
  for (let i = 0; i < out.length; i++) out[i] = (opts.noise ?? 0) * rand();
  const period = 60 / bpm;
  let k = 0;
  for (let t = opts.offset ?? 0; t < seconds; t += period, k++) {
    const start = Math.round(t * SR);
    const amp = opts.accent && k % 4 === 0 ? 1 : 0.7;
    for (let i = 0; i < 0.03 * SR && start + i < out.length; i++)
      out[start + i] += amp * rand() * 2 * Math.exp(-i / (0.006 * SR));
  }
  return out;
}

/** Kick drum: 55 Hz sine with a fast pitch/amplitude decay per beat. */
function kickTrack(bpm: number, seconds: number, offset: number) {
  const out = new Float32Array(Math.round(seconds * SR));
  const rand = rng(11);
  for (let i = 0; i < out.length; i++) out[i] = 0.02 * rand();
  const period = 60 / bpm;
  for (let t = offset; t < seconds; t += period) {
    const start = Math.round(t * SR);
    let phase = 0;
    for (let i = 0; i < 0.25 * SR && start + i < out.length; i++) {
      const f = 55 + 120 * Math.exp(-i / (0.02 * SR));
      phase += (2 * Math.PI * f) / SR;
      out[start + i] += 0.9 * Math.sin(phase) * Math.exp(-i / (0.08 * SR));
    }
  }
  return out;
}

function nearestError(beats: number[], truth: number[]): number {
  return Math.max(
    ...truth.map((t) => Math.min(...beats.map((b) => Math.abs(b - t)))),
  );
}

describe("beat detection", () => {
  it("finds 120 BPM and the beat times of a click track", () => {
    const a = detectBeats(clickTrack(120, 10, { noise: 0.01 }), SR);
    expect(a.bpm).toBeGreaterThan(118);
    expect(a.bpm).toBeLessThan(122);
    expect(a.confidence).toBeGreaterThan(0.2);
    const truth = beatGrid(120, 9.5, 0).slice(1);
    expect(nearestError(a.beats, truth)).toBeLessThan(0.025);
    expect(a.duration).toBeCloseTo(10, 1);
  });

  it("handles a kick drum at 95 BPM with an offset start", () => {
    const a = detectBeats(kickTrack(95, 12, 0.31), SR);
    expect(Math.abs(a.bpm - 95)).toBeLessThan(2.5);
    const truth = beatGrid(95, 11.5, 0.31).slice(1);
    expect(nearestError(a.beats, truth)).toBeLessThan(0.03);
  });

  it("prefers the musical octave (no 2x / 0.5x error) on 140 BPM", () => {
    const a = detectBeats(clickTrack(140, 10, { accent: true }), SR);
    expect(Math.abs(a.bpm - 140)).toBeLessThan(3);
  });

  it("uses a BPM hint to lock the search window", () => {
    // 75 BPM clicks could read as 150; the hint pins 150.
    const a = detectBeats(clickTrack(150, 8), SR, { bpmHint: 150 });
    expect(Math.abs(a.bpm - 150)).toBeLessThan(3);
    const t = estimateTempo(onsetEnvelope(clickTrack(150, 8), SR), 150);
    expect(t).not.toBeNull();
  });

  it("falls back to an even grid on silence", () => {
    const a = detectBeats(new Float32Array(SR * 4), SR, { bpmHint: 100 });
    expect(a.confidence).toBe(0);
    expect(a.bpm).toBe(100);
    expect(a.beats[0]).toBe(0);
    expect(a.beats[1]).toBeCloseTo(0.6, 3);
    expect(a.beats.length).toBe(7);
  });

  it("picks onsets at least 0.1 s apart", () => {
    const on = pickOnsets(onsetEnvelope(clickTrack(120, 4), SR));
    expect(on.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < on.length; i++)
      expect(on[i] - on[i - 1]).toBeGreaterThanOrEqual(0.099);
  });

  it("downmixes channels by averaging", () => {
    const m = downmix([
      Float32Array.from([1, 0, 1]),
      Float32Array.from([0, 0, -1]),
    ]);
    expect(Array.from(m)).toEqual([0.5, 0, 0]);
  });

  it("builds an even grid", () => {
    expect(beatGrid(120, 2)).toEqual([0, 0.5, 1, 1.5]);
    expect(beatGrid(60, 2.5, 0.25)).toEqual([0.25, 1.25, 2.25]);
  });
});
