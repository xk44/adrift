/** Video editor pure helpers: tool registry, smart selection, hand-off, run routing, keys, timeline layout. */
import { describe, expect, it } from "vitest";
import type { ImagineRun } from "@/types";
import {
  addClip,
  clipFromSource,
  emptyEditList,
  splitAt,
  timelineDuration,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  addPickPoint,
  annotateVideoTool,
  buildVideoEditorTools,
  filterVideoEditorTools,
  fitRect,
  toolRange,
  toolWindowSeconds,
  picksToOccurrences,
  rangeWarning,
  routeVideoToolRun,
  videoToolHandoff,
  videoToolNote,
  type SelectionPick,
} from "@/lib/videoEdit/videoTools";
import {
  isTypingTarget,
  nextEditPoint,
  trimEndAt,
  trimStartAt,
  videoKeyAction,
} from "@/lib/videoEdit/keys";
import {
  dropIndex,
  rulerLabel,
  rulerStep,
  rulerTicks,
  stripSlots,
} from "@/lib/videoEdit/timelineLayout";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_MAX_OCCURRENCES,
} from "@/lib/tools/smartTrack";
import { ACTION_TOOLS } from "@/lib/tools/toolsPage";

const src = (name: string, duration: number): VideoSource => ({
  url: `/api/video-edit/media?file=uploads/${name}.mp4`,
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
});

let n = 0;
const ids = () => `k${++n}`;

function threeClips(): EditList {
  let l = emptyEditList();
  l = addClip(l, clipFromSource(src("a", 4), "A", ids()));
  l = addClip(l, clipFromSource(src("b", 2), "B", ids()));
  l = addClip(l, clipFromSource(src("c", 3), "C", ids()));
  return l;
}

describe("video tool registry", () => {
  const tools = buildVideoEditorTools(null);

  it("lists only open-in-Tools tools that take a clip", () => {
    expect(tools.length).toBeGreaterThan(3);
    for (const t of tools) {
      expect(t.media).toContain("video");
      expect(t.target.kind).toBe("open");
    }
  });

  it("includes every smart-track action that is installed as a video tool", () => {
    const specIds = new Set(tools.map((t) => t.specId));
    const videoActions = ACTION_TOOLS.filter(
      (s) => SMART_TRACK_ACTIONS.has(s.id) && s.videoInput,
    ).map((s) => s.id);
    for (const id of videoActions) {
      if (specIds.has(id)) {
        const t = tools.find((x) => x.specId === id)!;
        expect(t.smartSelect).toBe(true);
        expect(videoToolNote(t)).toMatch(/^Mask/);
      }
    }
  });

  it("picks up new video tools generically (no hard-coded list)", () => {
    const fake = annotateVideoTool({
      key: "action:video_brand_new",
      title: "Brand New",
      subtitle: "",
      group: "Video",
      icon: "film",
      media: ["video"],
      localOnly: false,
      aliases: [],
      target: { kind: "open", toolKey: "action:video_brand_new" },
    });
    expect(fake.specId).toBe("video_brand_new");
    expect(fake.smartSelect).toBe(false);
    expect(fake.window).toBeNull();
  });

  it("filters by query", () => {
    const first = tools[0];
    const hit = filterVideoEditorTools(tools, first.title.slice(0, 5));
    expect(hit.some((t) => t.key === first.key)).toBe(true);
    expect(filterVideoEditorTools(tools, "zzzz-no-such-tool")).toHaveLength(0);
  });

  it("reads the processed window from the tool spec, not its label", () => {
    const byId = (id: string) => tools.find((t) => t.specId === id);
    for (const t of tools) {
      const spec = ACTION_TOOLS.find((s) => s.id === t.specId);
      if (spec?.videoWindow) expect(t.window).toEqual(spec.videoWindow);
    }
    const vace = byId("vace_restyle");
    if (vace) expect(toolWindowSeconds(vace, 60)).toBeCloseTo(81 / 16, 2);
    const remove = byId("video_object_remove");
    if (remove) expect(toolWindowSeconds(remove, 30)).toBeCloseTo(73 / 24, 2);
    // Native-rate windows depend on the clip's fps.
    const w = { window: { maxFrames: 81 } };
    expect(toolWindowSeconds(w, 24)).toBeCloseTo(3.375, 3);
    expect(toolWindowSeconds(w, 60)).toBeCloseTo(1.35, 3);
    expect(toolWindowSeconds({ window: null }, 24)).toBeNull();
  });

  it("every windowed video spec matches its builder caps", () => {
    for (const s of ACTION_TOOLS) {
      if (!s.videoWindow) continue;
      expect(s.videoInput, s.id).toBeTruthy();
      const secs = toolWindowSeconds({ window: s.videoWindow }, 24)!;
      expect(secs, s.id).toBeGreaterThan(1);
      expect(secs, s.id).toBeLessThanOrEqual(25);
    }
  });

  it("clamps the sent / replaced range to the tool window (rest survives)", () => {
    const t = { window: { maxFrames: 73, fps: 24 } };
    expect(toolRange(t, 10, 30, 24)).toEqual({ start: 10, end: 10 + 3.041 });
    expect(toolRange(t, 10, 12, 24)).toEqual({ start: 10, end: 12 });
    expect(toolRange({ window: null }, 10, 30, 24)).toEqual({ start: 10, end: 30 });
  });

  it("warns only when the range is longer than the tool window", () => {
    const x = { title: "X", window: { seconds: 3 } };
    expect(rangeWarning(x, 2.5, 24)).toBeNull();
    expect(rangeWarning(x, 6, 24)).toMatch(/first 3 s/);
    expect(rangeWarning({ title: "X", window: null }, 60, 24)).toBeNull();
  });
});

describe("smart selection", () => {
  const frame = 1 / 24;

  it("groups clicks on the same frame and sorts picks by time", () => {
    let p: SelectionPick[] = [];
    p = addPickPoint(p, 2, { x: 0.5, y: 0.5 }, false, frame);
    p = addPickPoint(p, 1, { x: 0.2, y: 0.3 }, false, frame);
    p = addPickPoint(p, 2.01, { x: 0.6, y: 0.5 }, true, frame);
    expect(p.map((k) => k.t)).toEqual([1, 2]);
    expect(p[1].positive).toHaveLength(1);
    expect(p[1].negative).toHaveLength(1);
  });

  it("clamps points into the frame and caps occurrences", () => {
    let p: SelectionPick[] = [];
    p = addPickPoint(p, 0, { x: -1, y: 2 }, false, frame);
    expect(p[0].positive[0]).toEqual({ x: 0, y: 1 });
    for (let i = 1; i < 20; i += 1)
      p = addPickPoint(p, i, { x: 0.5, y: 0.5 }, false, frame);
    expect(p.length).toBe(SMART_TRACK_MAX_OCCURRENCES);
  });

  it("maps picks inside the range + window to cut-relative pixel occurrences", () => {
    const picks: SelectionPick[] = [
      { t: 0.5, positive: [{ x: 0.5, y: 0.5 }], negative: [] },
      { t: 4.5, positive: [{ x: 0, y: 1 }], negative: [{ x: 1, y: 0 }] },
      { t: 5, positive: [], negative: [{ x: 0.1, y: 0.1 }] },
      { t: 8.5, positive: [{ x: 0.5, y: 0.5 }], negative: [] },
    ];
    const occ = picksToOccurrences(picks, 4, 7, { width: 101, height: 51 });
    expect(occ).toEqual([
      {
        t: 0.5,
        positive: [{ x: 0, y: 50 }],
        negative: [{ x: 100, y: 0 }],
      },
    ]);
    // No window: the whole range counts.
    expect(
      picksToOccurrences(picks, 4, 10, { width: 101, height: 51 }).map(
        (o) => o.t,
      ),
    ).toEqual([0.5, 4.5]);
  });

  it("places picks inside the letterbox of a differently sized clip", () => {
    // 4:3 clip in a 16:9 cut: pillarboxed, 1200 wide box centered at x=360.
    expect(fitRect(1920, 1080, 640, 480)).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    const picks: SelectionPick[] = [
      { t: 1, positive: [{ x: 0, y: 0.5 }], negative: [] },
    ];
    const occ = picksToOccurrences(
      picks,
      0,
      2,
      { width: 1920, height: 1080 },
      () => ({ width: 640, height: 480 }),
    );
    expect(occ[0].positive[0]).toEqual({ x: 240, y: 540 });
  });
});

describe("tool hand-off and results", () => {
  const tool = {
    key: "action:video_object_remove",
    target: { kind: "open" as const, toolKey: "action:video_object_remove" },
  };

  it("hands a cut range to the tool with the video-editor origin", () => {
    const h = videoToolHandoff(
      tool,
      {
        url: "/api/video-edit/media?file=renders/x.mp4",
        width: 640,
        height: 360,
        duration: 2,
      },
      "Shot 00:01-00:03",
      [{ t: 0, positive: [{ x: 1, y: 2 }], negative: [] }],
      42,
    );
    expect(h).toMatchObject({
      toolKey: "action:video_object_remove",
      media: "video",
      origin: "video-editor",
      width: 640,
      height: 360,
      at: 42,
    });
    expect(h.smartTrack).toHaveLength(1);
    const plain = videoToolHandoff(
      tool,
      { url: "u.mp4", width: 1, height: 1, duration: 1 },
      "x",
      [],
      1,
    );
    expect("smartTrack" in plain).toBe(false);
  });

  const run = (jobs: Partial<ImagineRun["jobs"][number]>[]): ImagineRun =>
    ({
      run_id: "r1",
      jobs: jobs.map((j, index) => ({
        index,
        seed: 1,
        status: "done",
        progress: 1,
        images: [],
        ...j,
      })),
    }) as unknown as ImagineRun;

  it("routes finished runs: video, still, failure, waiting", () => {
    const t = { title: "Remove" };
    expect(routeVideoToolRun(t, undefined)).toEqual({ kind: "wait" });
    expect(routeVideoToolRun(t, run([{ status: "running" }]))).toEqual({
      kind: "wait",
    });
    expect(
      routeVideoToolRun(
        t,
        run([
          { images: ["/api/comfy/image?filename=out_00001.mp4&type=output"] },
        ]),
      ),
    ).toMatchObject({
      kind: "done",
      outputs: [{ kind: "video", runId: "r1", jobIndex: 0 }],
    });
    expect(
      routeVideoToolRun(
        t,
        run([{ videos: ["/v/a.webm"], images: ["/p.png"] } as never]),
      ),
    ).toMatchObject({
      kind: "done",
      outputs: [{ kind: "video", url: "/v/a.webm" }],
    });
    expect(routeVideoToolRun(t, run([{ images: ["/x.png"] }]))).toMatchObject({
      kind: "done",
      outputs: [{ kind: "image", url: "/x.png" }],
    });
    // Batch runs: every finished variant comes back, failed ones are skipped.
    const batch = routeVideoToolRun(
      t,
      run([
        { videos: ["/v/1.mp4"] } as never,
        { status: "error", error: "OOM" },
        { videos: ["/v/3.mp4"] } as never,
      ]),
    );
    expect(batch.kind === "done" && batch.outputs.map((o) => o.url)).toEqual([
      "/v/1.mp4",
      "/v/3.mp4",
    ]);
    expect(
      routeVideoToolRun(t, run([{ status: "error", error: "OOM" }])),
    ).toEqual({
      kind: "failed",
      message: "Remove failed: OOM",
    });
  });
});

describe("keyboard map", () => {
  it("maps NLE keys", () => {
    expect(videoKeyAction({ key: " " })).toEqual({ kind: "togglePlay" });
    expect(videoKeyAction({ key: "j" })).toEqual({ kind: "shuttle", dir: -1 });
    expect(videoKeyAction({ key: "K" })).toEqual({ kind: "shuttle", dir: 0 });
    expect(videoKeyAction({ key: "l" })).toEqual({ kind: "shuttle", dir: 1 });
    expect(videoKeyAction({ key: "L", shiftKey: true })).toEqual({
      kind: "loop",
    });
    expect(videoKeyAction({ key: "ArrowLeft" })).toEqual({
      kind: "step",
      frames: -1,
    });
    expect(videoKeyAction({ key: "ArrowRight", shiftKey: true })).toEqual({
      kind: "stepSeconds",
      seconds: 1,
    });
    expect(videoKeyAction({ key: "i" })).toEqual({ kind: "markIn" });
    expect(videoKeyAction({ key: "I", shiftKey: true })).toEqual({
      kind: "goIn",
    });
    expect(videoKeyAction({ key: "s" })).toEqual({ kind: "split" });
    expect(videoKeyAction({ key: "Backspace" })).toEqual({ kind: "delete" });
    expect(videoKeyAction({ key: "z", metaKey: true })).toEqual({
      kind: "undo",
    });
    expect(videoKeyAction({ key: "z", ctrlKey: true, shiftKey: true })).toEqual(
      { kind: "redo" },
    );
    // Other modified keys are left to the browser / app.
    expect(videoKeyAction({ key: "s", metaKey: true })).toBeNull();
    expect(videoKeyAction({ key: "j", altKey: true })).toBeNull();
    expect(videoKeyAction({ key: "q" })).toBeNull();
  });

  it("finds cuts and trims to the playhead", () => {
    const l = threeClips(); // cuts at 4, 6; end 9
    expect(nextEditPoint(l, 1, 1)).toBe(4);
    expect(nextEditPoint(l, 4, 1)).toBe(6);
    expect(nextEditPoint(l, 6, -1)).toBe(4);
    expect(nextEditPoint(l, 0.5, -1)).toBe(0);
    const a = trimStartAt(l, 1);
    expect(a.clips[0].in).toBeCloseTo(1);
    expect(timelineDuration(a)).toBeCloseTo(8);
    const b = trimEndAt(l, 5);
    expect(b.clips[1].out).toBeCloseTo(1);
    // At a cut there is nothing to trim.
    expect(trimStartAt(l, 4)).toBe(l);
  });

  it("ignores typing targets", () => {
    expect(
      isTypingTarget({
        tagName: "INPUT",
        type: "text",
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isTypingTarget({
        tagName: "INPUT",
        type: "range",
      } as unknown as EventTarget),
    ).toBe(false);
    expect(
      isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isTypingTarget({
        tagName: "DIV",
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("timeline layout", () => {
  it("spaces ruler labels by zoom", () => {
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(1000)).toBe(0.1);
    expect(rulerTicks(3, 1)).toEqual([0, 1, 2, 3]);
    expect(rulerTicks(0, 1)).toEqual([0]);
    expect(rulerLabel(65, 5)).toBe("1:05");
    expect(rulerLabel(1.5, 0.5)).toBe("0:01.5");
    expect(rulerLabel(0.25, 0.25)).toBe("0:00.25");
  });

  it("fills a clip with aspect-correct thumbnail slots from its source range", () => {
    const clip = { in: 2, out: 4, src: src("a", 10) };
    const strip = { count: 10, tileWidth: 160, tileHeight: 90 };
    const slots = stripSlots(clip, 100, 48, strip);
    const slotW = (160 / 90) * 48;
    expect(slots.length).toBe(Math.ceil(200 / slotW));
    expect(slots[0]).toMatchObject({ left: 0, tile: 2 });
    expect(
      slots[slots.length - 1].left + slots[slots.length - 1].width,
    ).toBeCloseTo(200);
    for (const s of slots) expect(s.tile).toBeLessThanOrEqual(3);
    expect(stripSlots(clip, 100, 48, { ...strip, count: 0 })).toEqual([]);
  });

  it("computes the drop slot for a dragged clip", () => {
    const l = threeClips(); // A 0-4, B 4-6, C 6-9
    expect(dropIndex(l, 0, 0.5)).toBe(0);
    expect(dropIndex(l, 0, 5.5)).toBe(1);
    expect(dropIndex(l, 0, 8)).toBe(2);
    expect(dropIndex(l, 2, 0.1)).toBe(0);
  });

  it("split keeps the timeline length", () => {
    const l = threeClips();
    expect(timelineDuration(splitAt(l, 1, ids))).toBeCloseTo(
      timelineDuration(l),
    );
  });
});
