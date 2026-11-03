/** Video editor edit-list model: timeline math, split/trim/move/replace, validation. */
import { describe, expect, it } from "vitest";
import {
  EditListError,
  MIN_CLIP_SECONDS,
  addClip,
  clipAt,
  clipFromSource,
  clipStarts,
  editPoints,
  emptyEditList,
  formatTimecode,
  moveClip,
  parseEditList,
  rangeSegments,
  removeClip,
  replaceRange,
  setAllMuted,
  setClipMuted,
  snapToFrame,
  splitAt,
  timelineDuration,
  trimClip,
  aspectRatio,
  clipFades,
  clipLength,
  rippleDelete,
  setOutputFrame,
  updateClip,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";

const src = (name: string, duration: number, hasAudio = true): VideoSource => ({
  url: `/api/comfy/image?filename=${name}.mp4&subfolder=&type=output`,
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio,
});

let n = 0;
const ids = () => `id${++n}`;

function twoClips(): EditList {
  let l = emptyEditList();
  l = addClip(l, clipFromSource(src("a", 4), "A", "a"));
  l = addClip(l, clipFromSource(src("b", 6, false), "B", "b"));
  return l;
}

describe("timeline math", () => {
  it("lays clips end to end", () => {
    const l = twoClips();
    expect(timelineDuration(l)).toBe(10);
    expect(clipStarts(l)).toEqual([0, 4]);
    expect(editPoints(l)).toEqual([0, 4, 10]);
  });

  it("maps timeline time to clip + source time; cuts belong to the next clip", () => {
    const l = trimClip(twoClips(), "b", 1, 6); // B plays 1..6
    expect(clipAt(l, 2)).toMatchObject({ index: 0, offset: 2, sourceTime: 2 });
    expect(clipAt(l, 4)).toMatchObject({ index: 1, offset: 0, sourceTime: 1 });
    expect(clipAt(l, 99)).toMatchObject({ index: 1, offset: 5, sourceTime: 6 });
    expect(clipAt(l, -3)).toMatchObject({ index: 0, offset: 0 });
    expect(clipAt(emptyEditList(), 1)).toBeNull();
  });
});

describe("edits", () => {
  it("splits at the playhead and refuses slivers / cut points", () => {
    const l = splitAt(twoClips(), 1.5, ids);
    expect(l.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 1.5],
      [1.5, 4],
      [0, 6],
    ]);
    expect(timelineDuration(l)).toBe(10);
    expect(splitAt(l, 4, ids)).toBe(l); // already a cut
    expect(splitAt(l, MIN_CLIP_SECONDS / 2, ids)).toBe(l);
  });

  it("trims within the source and keeps a minimum length", () => {
    let l = trimClip(twoClips(), "a", -1, 99);
    expect(l.clips[0]).toMatchObject({ in: 0, out: 4 });
    l = trimClip(l, "a", 3.99, 4);
    expect(l.clips[0].out - l.clips[0].in).toBeCloseTo(MIN_CLIP_SECONDS);
    expect(trimClip(l, "nope", 0, 1)).toBe(l);
  });

  it("moves, removes, mutes", () => {
    let l = moveClip(twoClips(), 0, 1);
    expect(l.clips.map((c) => c.id)).toEqual(["b", "a"]);
    expect(moveClip(l, 5, 0)).toBe(l);
    l = setClipMuted(l, "a", true);
    expect(l.clips[1].muted).toBe(true);
    l = setAllMuted(l, false);
    expect(l.clips.every((c) => !c.muted)).toBe(true);
    l = removeClip(l, "b");
    expect(l.clips.map((c) => c.id)).toEqual(["a"]);
  });

  it("never mutates its input", () => {
    const l = twoClips();
    const before = JSON.stringify(l);
    splitAt(l, 2, ids);
    trimClip(l, "a", 1, 2);
    moveClip(l, 0, 1);
    replaceRange(l, 1, 5, clipFromSource(src("r", 4), "R", "r"), ids);
    expect(JSON.stringify(l)).toBe(before);
  });
});

describe("rangeSegments", () => {
  it("covers a range across a cut with source times", () => {
    const l = setClipMuted(twoClips(), "a", true);
    const segs = rangeSegments(l, 3, 5);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ in: 3, out: 4, muted: true });
    expect(segs[1]).toMatchObject({ in: 0, out: 1, hasAudio: false });
    expect(rangeSegments(l)).toHaveLength(2);
    expect(rangeSegments(l, 5, 5)).toEqual([]);
  });
});

describe("replaceRange", () => {
  it("swaps a range for a tool result, trimming straddling clips", () => {
    const l = twoClips();
    const r = clipFromSource(src("r", 2), "Result", "r");
    const out = replaceRange(l, 3, 5, r, ids);
    expect(out.clips.map((c) => [c.label, c.in, c.out])).toEqual([
      ["A", 0, 3],
      ["Result", 0, 2],
      ["B", 1, 6],
    ]);
    expect(timelineDuration(out)).toBe(10);
  });

  it("handles a result with a different length and whole-timeline ranges", () => {
    const out = replaceRange(twoClips(), 0, 10, clipFromSource(src("r", 3), "R", "r"), ids);
    expect(out.clips.map((c) => c.id)).toEqual(["r"]);
    expect(timelineDuration(out)).toBe(3);
  });
});

describe("replaceRange near cuts (exact, nothing dropped or repeated)", () => {
  const len = (l: EditList) => timelineDuration(l);
  const r = () => clipFromSource(src("r", 1), "R", "r");

  it("keeps a sliver of footage just before / after the range", () => {
    // Range starts 0.05 s after the cut at 4 and ends 0.04 s before 10.
    const out = replaceRange(twoClips(), 4.05, 9.96, r(), ids);
    expect(out.clips.map((c) => c.id)).toEqual(["a", "b", "r", expect.any(String)]);
    expect(out.clips[1]).toMatchObject({ in: 0, out: 0.05 });
    expect(out.clips[3]).toMatchObject({ in: 5.96, out: 6 });
    // 10 s - 5.91 s replaced + 1 s result.
    expect(len(out)).toBeCloseTo(10 - 5.91 + 1, 6);
  });

  it("splits one clip into head + result + tail with distinct ids", () => {
    let l = emptyEditList();
    l = addClip(l, clipFromSource(src("a", 10), "A", "a"));
    const out = replaceRange(l, 2, 4, r(), ids);
    expect(out.clips.map((c) => [c.in, c.out])).toEqual([[0, 2], [0, 1], [4, 10]]);
    expect(new Set(out.clips.map((c) => c.id)).size).toBe(3);
  });

  it("drops only sub-half-frame leftovers", () => {
    const out = replaceRange(twoClips(), 4.01, 10, r(), ids);
    expect(out.clips.map((c) => c.id)).toEqual(["a", "r"]);
  });
});

describe("frame grid", () => {
  it("splits and trims on the source frame grid", () => {
    let l = emptyEditList();
    l = addClip(l, clipFromSource(src("a", 4), "A", "a"));
    const split = splitAt(l, 1.01, ids);
    expect(split.clips[0].out).toBeCloseTo(snapToFrame(1.01, 24), 6);
    expect(split.clips[0].out * 24).toBeCloseTo(24, 4);
    const trimmed = trimClip(l, "a", 0.52, 3.3);
    expect(trimmed.clips[0].in * 24).toBeCloseTo(Math.round(0.52 * 24), 4);
    expect(trimmed.clips[0].out * 24).toBeCloseTo(Math.round(3.3 * 24), 4);
    // The file's very end is kept as is.
    expect(trimClip(l, "a", 0, 4).clips[0].out).toBe(4);
  });
});

describe("timecode", () => {
  it("formats frames and snaps", () => {
    expect(formatTimecode(0, 24)).toBe("00:00:00:00");
    expect(formatTimecode(61.5, 24)).toBe("00:01:01:12");
    expect(formatTimecode(3725, 30)).toBe("01:02:05:00");
    expect(formatTimecode(1.25, 0)).toBe("00:01.250");
    expect(snapToFrame(1.03, 24)).toBeCloseTo(1 + 1 / 24);
  });
});

describe("parseEditList", () => {
  const ok = (u: string) => u.startsWith("/api/comfy/image");
  it("accepts a valid list and clamps fields", () => {
    const l = parseEditList(
      { clips: [{ ...clipFromSource(src("a", 4), "A".repeat(500), "a"), extra: 1 }] },
      ok,
    );
    expect(l.clips[0].label).toHaveLength(120);
  });

  it.each([
    [null, "object"],
    [{ clips: [] }, "no clips"],
    [{ clips: [{ src: { url: "/etc/passwd", duration: 4 }, in: 0, out: 1 }] }, "unsupported source"],
    [{ clips: [{ src: { url: "/api/comfy/image?x", duration: 4 }, in: 2, out: 1 }] }, "in/out"],
    [{ clips: [{ src: { url: "/api/comfy/image?x", duration: 4 }, in: -1, out: 1 }] }, "in/out"],
    [{ clips: [{ src: { url: "/api/comfy/image?x", duration: 4 }, in: 0, out: 9 }] }, "in/out"],
    [{ clips: [{ src: { url: "/api/comfy/image?x", duration: NaN }, in: 0, out: 1 }] }, "duration"],
    [{ clips: Array.from({ length: 65 }, () => ({})) }, "at most"],
    [
      { clips: Array.from({ length: 11 }, () => ({ src: { url: "/api/comfy/image?x", duration: 60 }, in: 0, out: 60 })) },
      "longer than",
    ],
  ])("rejects %#", (raw, msg) => {
    expect(() => parseEditList(raw, ok)).toThrow(EditListError);
    expect(() => parseEditList(raw, ok)).toThrow(msg);
  });
});

const clip = (id: string, len: number, fx: Record<string, unknown> = {}) => ({
  ...clipFromSource(src(id, len), id.toUpperCase(), id),
  ...fx,
});

describe("speed", () => {
  it("stretches timeline length and maps source time through it", () => {
    let l = emptyEditList();
    l = addClip(l, clip("a", 4, { speed: 2 }));
    l = addClip(l, clip("b", 2, { speed: 0.5 }));
    expect(clipLength(l.clips[0])).toBe(2);
    expect(timelineDuration(l)).toBe(6);
    expect(clipAt(l, 1)).toMatchObject({ index: 0, offset: 1, sourceTime: 2 });
    expect(clipAt(l, 3)).toMatchObject({ index: 1, offset: 1, sourceTime: 0.5 });
  });

  it("splits in source seconds and keeps fades on the outer ends", () => {
    const l0 = addClip(emptyEditList(), clip("a", 4, { speed: 2, fadeIn: 0.3, fadeOut: 0.4 }));
    const l = splitAt(l0, 0.5, ids);
    expect(l.clips.map((c) => [c.in, c.out, c.fadeIn, c.fadeOut])).toEqual([
      [0, 1, 0.3, undefined],
      [1, 4, undefined, 0.4],
    ]);
    expect(timelineDuration(l)).toBe(2);
  });

  it("render segments carry speed, volume and the fades they own", () => {
    const l0 = addClip(emptyEditList(), clip("a", 4, { speed: 2, volume: 0.5, fadeIn: 0.3, fadeOut: 0.4 }));
    const whole = rangeSegments(l0);
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({ in: 0, out: 4, speed: 2, volume: 0.5, fadeIn: 0.3, fadeOut: 0.4 });
    const mid = rangeSegments(l0, 0.5, 1.5)[0];
    expect(mid).toMatchObject({ in: 1, out: 3, fadeIn: 0, fadeOut: 0 });
    const head = rangeSegments(l0, 0, 0.4)[0];
    expect(head.fadeIn).toBe(0.2); // capped at half the piece
  });

  it("trims to a minimum length in timeline time, not source time", () => {
    const fast = addClip(emptyEditList(), clip("a", 4, { speed: 4 }));
    const t1 = trimClip(fast, "a", 0, 0);
    expect(clipLength(t1.clips[0])).toBeCloseTo(MIN_CLIP_SECONDS, 2);
    const slow = addClip(emptyEditList(), clip("a", 4, { speed: 0.25 }));
    const t2 = trimClip(slow, "a", 0, 0);
    expect(clipLength(t2.clips[0])).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS - 1e-6);
    expect(clipLength(t2.clips[0])).toBeLessThan(MIN_CLIP_SECONDS * 2);
  });

  it("caps fades at half the clip", () => {
    expect(clipFades(clip("a", 2, { fadeIn: 5, fadeOut: 5 }))).toEqual({ fadeIn: 1, fadeOut: 1 });
  });
});

describe("ripple delete", () => {
  it("removes a range across clips and closes the gap", () => {
    const l = rippleDelete(twoClips(), 3, 5, ids);
    expect(l.clips.map((c) => [c.id, c.in, c.out])).toEqual([
      ["a", 0, 3],
      ["b", 1, 6],
    ]);
    expect(timelineDuration(l)).toBe(8);
  });

  it("splits one clip when the range sits inside it", () => {
    const l = rippleDelete(twoClips(), 1, 2, ids);
    expect(l.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 1],
      [2, 4],
      [0, 6],
    ]);
    expect(new Set(l.clips.map((c) => c.id)).size).toBe(3);
  });

  it("is a no-op for empty or everything ranges", () => {
    const l = twoClips();
    expect(rippleDelete(l, 2, 2, ids)).toBe(l);
    expect(rippleDelete(l, 0, 10, ids)).toBe(l);
  });

  it("is speed-aware", () => {
    const l0 = addClip(emptyEditList(), clip("a", 4, { speed: 2 }));
    const l = rippleDelete(l0, 0.5, 1, ids);
    expect(l.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 1],
      [2, 4],
    ]);
  });
});

describe("updateClip / frame", () => {
  it("clamps, rounds and stores defaults as absent", () => {
    let l = updateClip(twoClips(), "a", { speed: 9, volume: 1.234, fadeIn: -1, fadeOut: 0.5 });
    expect(l.clips[0]).toMatchObject({ speed: 4, volume: 1.23, fadeOut: 0.5 });
    expect("fadeIn" in l.clips[0]).toBe(false);
    l = updateClip(l, "a", { speed: 1, volume: 1, fadeOut: 0 });
    expect(["speed", "volume", "fadeOut"].some((k) => k in l.clips[0])).toBe(false);
    expect(updateClip(l, "a", { speed: 1 })).toBe(l);
    expect(updateClip(l, "nope", { speed: 2 })).toBe(l);
  });

  it("sets and clears the export frame", () => {
    const l = twoClips();
    const f = setOutputFrame(l, { aspect: "9:16", x: 2, y: 0.25 });
    expect(f.frame).toEqual({ aspect: "9:16", x: 1, y: 0.25 });
    expect(setOutputFrame(f, { aspect: "9:16", x: 1, y: 0.25 })).toBe(f);
    expect(setOutputFrame(f, null).frame).toBeUndefined();
    expect(setOutputFrame(l, null)).toBe(l);
    expect(aspectRatio("9:16")).toBeCloseTo(0.5625);
  });

  it("parses fx and frame, rejects out-of-range values", () => {
    const ok = (u: string) => u.startsWith("/api/comfy/image");
    const base = clipFromSource(src("a", 4), "A", "a");
    const l = parseEditList(
      { clips: [{ ...base, speed: 2, volume: 0, fadeIn: 1 }], frame: { aspect: "1:1", x: 0.5, y: 0.5 } },
      ok,
    );
    expect(l.clips[0]).toMatchObject({ speed: 2, volume: 0, fadeIn: 1 });
    expect(l.frame).toEqual({ aspect: "1:1", x: 0.5, y: 0.5 });
    for (const [bad, msg] of [
      [{ speed: 0.1 }, "speed must be 0.25-4"],
      [{ speed: "fast" }, "speed must be"],
      [{ volume: 3 }, "volume must be 0-2"],
      [{ fadeIn: -1 }, "fade in must be"],
      [{ fadeOut: 11 }, "fade out must be"],
    ] as const) {
      expect(() => parseEditList({ clips: [{ ...base, ...bad }] }, ok)).toThrow(msg);
    }
    for (const frame of [{ aspect: "2:1", x: 0, y: 0 }, { aspect: "1:1", x: 2, y: 0 }, "1:1"]) {
      expect(() => parseEditList({ clips: [base], frame }, ok)).toThrow("bad output frame");
    }
    // 0.25x stretches past the 10 minute cap.
    const long = { ...clipFromSource(src("l", 160), "L", "l"), speed: 0.25 };
    expect(() => parseEditList({ clips: [long] }, ok)).toThrow("longer than");
  });
});
