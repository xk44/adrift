/**
 * Video editor clip effects UI layer: coalesced undo, ripple-delete / snap
 * keys, snapping + waveform geometry, player fade / crop math, and smoke
 * renders of the Clip panel and export settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import { MERGE_WINDOW_MS, useVideoEditStore } from "@/store/videoEditStore";
import {
  addClip,
  clipFromSource,
  emptyEditList,
  setTransition,
  timelineDuration,
  updateClip,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import { videoKeyAction } from "@/lib/videoEdit/keys";
import { DEFAULT_EXPORT } from "@/lib/videoEdit/requests";
import {
  snapTargets,
  snapTime,
  stripSlots,
  waveSlice,
} from "@/lib/videoEdit/timelineLayout";
import { runVideoAction } from "@/components/editor/video/useVideoKeys";
import {
  ExportSettingsBox,
  VideoClipPanel,
} from "@/components/editor/video/VideoClipPanel";
import { VideoExportPanel } from "@/components/editor/video/VideoPanels";
import { VideoTimeline } from "@/components/editor/video/VideoTimeline";
import { VideoTransport } from "@/components/editor/video/VideoTransport";
import { fadeGain, frameRect } from "@/components/editor/video/VideoPlayer";

const src = (name: string, duration: number): VideoSource => ({
  url: `/api/video-edit/media?file=uploads/${name}.mp4`,
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
});

const render = (el: React.ReactElement) => {
  Object.assign(
    useVideoEditStore.getInitialState(),
    useVideoEditStore.getState(),
  );
  return renderToStaticMarkup(el);
};

const S = () => useVideoEditStore.getState();

beforeEach(() => {
  vi.useRealTimers();
  S().closeProject();
  if (!S().snap) S().toggleSnap();
  S().setExportSettings({ resolution: "keep", fps: 0, quality: "high" });
});

describe("coalesced undo", () => {
  it("folds a slider drag into one undo step per control", () => {
    vi.useFakeTimers();
    S().openProject(src("a", 4), "A");
    const id = S().edit!.clips[0].id;
    for (const v of [1.1, 1.5, 2])
      S().apply((e) => updateClip(e, id, { speed: v }), `${id}:speed`);
    expect(S().past).toHaveLength(1);
    // Another control starts its own step.
    S().apply((e) => updateClip(e, id, { volume: 0.5 }), `${id}:volume`);
    expect(S().past).toHaveLength(2);
    // The same control after a pause is a new step too.
    vi.advanceTimersByTime(MERGE_WINDOW_MS + 10);
    S().apply((e) => updateClip(e, id, { volume: 0.4 }), `${id}:volume`);
    expect(S().past).toHaveLength(3);
    S().undo();
    S().undo();
    expect(S().edit!.clips[0]).toMatchObject({ speed: 2 });
    expect(S().edit!.clips[0].volume).toBeUndefined();
    S().undo();
    expect(S().edit!.clips[0].speed).toBeUndefined();
  });

  it("does not merge into a step that was undone", () => {
    S().openProject(src("a", 4), "A");
    const id = S().edit!.clips[0].id;
    S().apply((e) => updateClip(e, id, { speed: 2 }), "k");
    S().undo();
    S().apply((e) => updateClip(e, id, { speed: 3 }), "k");
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(S().edit!.clips[0].speed).toBeUndefined();
  });
});

describe("keys", () => {
  it("maps Shift+Delete to ripple delete and N to snapping", () => {
    expect(videoKeyAction({ key: "Delete", shiftKey: true })).toEqual({
      kind: "rippleDelete",
    });
    expect(videoKeyAction({ key: "Backspace", shiftKey: true })).toEqual({
      kind: "rippleDelete",
    });
    expect(videoKeyAction({ key: "N" })).toEqual({ kind: "snap" });
  });

  it("ripple-deletes in → out and parks the playhead at the cut", () => {
    S().openProject(src("a", 4), "A");
    S().appendSource(src("b", 6), "B");
    S().setIn(3);
    S().setOut(5);
    runVideoAction({ kind: "rippleDelete" });
    expect(timelineDuration(S().edit!)).toBeCloseTo(8);
    expect(S().inPoint).toBeNull();
    expect(S().outPoint).toBeNull();
    expect(S().playhead).toBe(3);
    S().undo();
    expect(timelineDuration(S().edit!)).toBeCloseTo(10);
  });

  it("toggles snapping", () => {
    S().openProject(src("a", 4), "A");
    expect(S().snap).toBe(true);
    runVideoAction({ kind: "snap" });
    expect(S().snap).toBe(false);
    runVideoAction({ kind: "snap" });
    expect(S().snap).toBe(true);
  });
});

describe("timeline geometry", () => {
  it("snaps to the nearest target within tolerance", () => {
    expect(snapTime(4.05, [0, 4, 10], 0.1)).toBe(4);
    expect(snapTime(4.2, [0, 4, 10], 0.1)).toBe(4.2);
    expect(snapTime(5, [4.9, 5.05], 0.2)).toBe(5.05);
    let l = addClip(emptyEditList(), clipFromSource(src("a", 4), "A", "a"));
    l = addClip(l, clipFromSource(src("b", 2), "B", "b"));
    expect(snapTargets(l, 1.5, null, 5)).toEqual([0, 4, 6, 1.5, 5]);
    expect(snapTargets(l, null, 2, null)).toEqual([0, 4, 6, 2]);
  });

  it("slices the waveform and filmstrip by speed", () => {
    const clip = { ...clipFromSource(src("a", 10), "A", "a"), in: 2, speed: 2 };
    expect(waveSlice(clip, 10, 10)).toEqual({ offset: -10, size: 50 });
    expect(waveSlice({ in: 0 }, 0, 10)).toEqual({ offset: 0, size: 0 });
    const strip = { count: 10, tileWidth: 16, tileHeight: 9 };
    // 2x: the last slot of an 8 s block shows the source's end, not its middle.
    const slots = stripSlots({ ...clip, in: 0, out: 10 }, 100, 48, strip);
    expect(slots.at(-1)!.tile).toBe(9);
    const slow = stripSlots(
      { ...clip, in: 0, out: 10, speed: 1 },
      100,
      48,
      strip,
    );
    expect(slow.at(-1)!.tile).toBe(9);
    expect(slots.length).toBeLessThan(slow.length);
  });
});

describe("player preview math", () => {
  it("fade gain ramps at the clip ends", () => {
    const c = {
      ...clipFromSource(src("a", 4), "A", "a"),
      fadeIn: 1,
      fadeOut: 2,
    };
    expect(fadeGain(c, 0)).toBe(0);
    expect(fadeGain(c, 0.5)).toBe(0.5);
    expect(fadeGain(c, 1.5)).toBe(1);
    expect(fadeGain(c, 3)).toBe(0.5);
    expect(fadeGain(clipFromSource(src("a", 4), "A", "a"), 0)).toBe(1);
  });

  it("places the crop guide by aspect + focus", () => {
    const pic = { x: 0, y: 10, w: 160, h: 90 };
    expect(frameRect(pic, { aspect: "1:1", x: 0, y: 0.5 })).toEqual({
      x: 0,
      y: 10,
      w: 90,
      h: 90,
    });
    expect(frameRect(pic, { aspect: "1:1", x: 1, y: 0.5 }).x).toBe(70);
    const tall = frameRect(pic, { aspect: "21:9", x: 0.5, y: 1 });
    expect(tall.w).toBe(160);
    expect(tall.y + tall.h).toBeCloseTo(100);
  });
});

describe("panels", () => {
  it("Clip panel: prompt without a selection, controls with one", () => {
    S().openProject(src("a", 4), "Shot");
    S().selectClip(null);
    expect(render(<VideoClipPanel />)).toContain(
      "Click a clip on the timeline",
    );
    const id = S().edit!.clips[0].id;
    S().selectClip(id);
    S().apply((e) => updateClip(e, id, { speed: 2, fadeIn: 0.5 }));
    const html = render(<VideoClipPanel />);
    expect(html).toContain("Clip 1: Shot");
    expect(html).toContain("2×");
    expect(html).toContain('id="vclip-speed"');
    expect(html).toContain('id="vclip-volume"');
    expect(html).toContain("0.50 s");
    expect(html).toContain("2.00 s on the timeline");
  });

  it("Split follows the playhead in timeline time at any speed", () => {
    S().openProject(src("a", 4), "Shot");
    const id = S().edit!.clips[0].id;
    S().selectClip(id);
    S().apply((e) => updateClip(e, id, { speed: 0.5 }));
    const splitBtn = (html: string) =>
      html.match(/<button[^>]*title="Split at the playhead \(S\)"[^>]*>/)![0];
    S().seek(0);
    expect(splitBtn(render(<VideoClipPanel />))).toMatch(/ disabled=""/);
    // 6 s into an 8 s (0.5x) clip: past the source length, still splittable.
    S().seek(6);
    expect(splitBtn(render(<VideoClipPanel />))).not.toMatch(/ disabled=""/);
    expect(splitBtn(render(<VideoTransport />))).not.toMatch(/ disabled=""/);
  });

  it("drops saved export settings the render route would reject", () => {
    const merge = useVideoEditStore.persist.getOptions().merge!;
    const cur = useVideoEditStore.getState();
    const bad = merge(
      { exportSettings: { resolution: "4k", fps: 24, quality: "high" } },
      cur,
    );
    expect(bad.exportSettings).toEqual(DEFAULT_EXPORT);
    const good = merge(
      { exportSettings: { resolution: "720", fps: 30, quality: "small" } },
      cur,
    );
    expect(good.exportSettings).toEqual({
      resolution: "720",
      fps: 30,
      quality: "small",
      format: "mp4",
    });
  });

  it("timeline shows the speed badge and fade wedge", () => {
    S().openProject(src("a", 4), "Shot");
    const id = S().edit!.clips[0].id;
    S().apply((e) => updateClip(e, id, { speed: 0.5, fadeOut: 1 }));
    const html = render(<VideoTimeline />);
    expect(html).toContain("0.5×");
    expect(html).toContain("0.5x speed");
    expect(html).toContain("polygon(0 0, 100% 0, 100% 100%)");
    expect(html).toContain('aria-label="Snapping"');
  });

  it("export settings render inside the Export panel", () => {
    S().openProject(src("a", 4), "Shot");
    S().setExportSettings({ resolution: "720", quality: "small" });
    const box = render(<ExportSettingsBox />);
    expect(box).toContain("9:16");
    expect(box).toMatch(/<option value="720" selected="">720p<\/option>/);
    expect(box).toMatch(
      /<option value="small" selected="">Small file<\/option>/,
    );
    expect(render(<VideoExportPanel />)).toContain(
      'data-testid="video-export-settings"',
    );
    S().apply((e) => ({ ...e, frame: { aspect: "9:16", x: 0.5, y: 0.5 } }));
    expect(render(<ExportSettingsBox />)).toContain('id="vexp-x"');
  });

  it("export settings: loudness and ducking checkboxes, off by default", () => {
    S().openProject(src("a", 4), "Shot");
    const box = render(<ExportSettingsBox />);
    expect(box).toContain("Normalise loudness (-14 LUFS)");
    expect(box).toMatch(/<input type="checkbox" data-testid="vexp-loudnorm"\/>/);
    expect(box).toMatch(/data-testid="vexp-duck" disabled=""\/>/);
    S().addAudio({ url: "/api/video-edit/media?f=uploads%2Fs.wav", duration: 4 }, "VO", 0);
    S().setExportSettings({ loudnorm: true, duck: true });
    const on = render(<ExportSettingsBox />);
    expect(on).toMatch(/data-testid="vexp-loudnorm" checked=""/);
    expect(on).toMatch(/data-testid="vexp-duck" checked=""/);
    expect(on).not.toMatch(/data-testid="vexp-duck"[^>]*disabled/);
  });
});

describe("transitions and the audio lane (UI)", () => {
  const song = { url: "/api/video-edit/media?f=uploads%2Fs.mp3", duration: 8 };

  it("clip panel: transition chips on later clips, Delete / S act on lane clips", () => {
    S().openProject(src("a", 4), "A");
    S().appendSource(src("b", 4), "B");
    const [a, b] = S().edit!.clips;
    S().selectClip(a.id);
    expect(render(<VideoClipPanel />)).not.toContain('data-testid="video-transition"');
    S().selectClip(b.id);
    let html = render(<VideoClipPanel />);
    expect(html).toContain("Transition from clip 1");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Cut</);
    S().apply((e) => setTransition(e, b.id, { type: "dip", d: 0.5 }));
    html = render(<VideoClipPanel />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Dip to black</);
    expect(html).toContain('id="vclip-trans-d"');

    S().addAudio(song, "Song", 1);
    const lane = S().edit!.audio!;
    expect(S().selectedAudioId).toBe(lane[0].id);
    expect(S().selectedClipId).toBeNull();
    html = render(<VideoClipPanel />);
    expect(html).toContain('data-testid="video-audio-panel"');
    expect(html).toContain("Audio: Song");
    S().seek(3);
    runVideoAction({ kind: "split" });
    expect(S().edit!.audio).toHaveLength(2);
    expect(S().edit!.clips).toHaveLength(2);
    runVideoAction({ kind: "delete" });
    expect(S().edit!.audio).toHaveLength(1);
    expect(S().edit!.clips).toHaveLength(2);
    expect(S().selectedAudioId).toBeNull();
  });

  it("timeline draws transition markers, the band and lane clips", () => {
    S().openProject(src("a", 4), "A");
    S().appendSource(src("b", 4), "B");
    let html = render(<VideoTimeline />);
    expect(html).toContain('data-testid="audio-lane"');
    expect(html).toContain("Drop music or voice-over here");
    expect(html).toContain('aria-label="Add a crossfade into clip 2"');
    const b = S().edit!.clips[1];
    S().apply((e) => setTransition(e, b.id, { type: "crossfade", d: 1 }));
    S().addAudio(song, "Song", 6);
    html = render(<VideoTimeline />);
    expect(html).toContain("Crossfade into clip 2, 1.00 seconds");
    expect(html).toContain('data-testid="transition-band"');
    expect(html).toContain("Audio 1: Song, at 6.00 seconds, 8.00 seconds");
    // Past the end of the video: hatched as not exported.
    expect(html).toContain("not exported");
  });
});
