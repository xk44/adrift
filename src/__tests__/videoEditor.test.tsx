/** Video editor store (undo/redo, transport, results) and component smoke renders. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import {
  activeRange,
  playheadFps,
  useVideoEditStore,
} from "@/store/videoEditStore";
import { useEditorStore } from "@/store/editorStore";
import {
  clipLength,
  splitAt,
  timelineDuration,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  VideoEditor,
  closeVideoProject,
} from "@/components/editor/video/VideoEditor";
import { VideoTransport } from "@/components/editor/video/VideoTransport";
import { VideoTimeline } from "@/components/editor/video/VideoTimeline";
import {
  VideoExportPanel,
  VideoResultsPanel,
  VideoSelectPanel,
  VideoToolsPanel,
  acceptResult,
  rangeLabel,
} from "@/components/editor/video/VideoPanels";
import { containRect } from "@/components/editor/video/VideoPlayer";
import {
  selectEditorAudio,
  selectEditorVideos,
} from "@/components/editor/editorStartScreen";
import { VideoStartSection } from "@/components/editor/video/VideoStartSection";
import type { GalleryImage } from "@/types";

const src = (name: string, duration: number, fps = 24): VideoSource => ({
  url: `/api/video-edit/media?file=uploads/${name}.mp4`,
  duration,
  width: 1280,
  height: 720,
  fps,
  hasAudio: true,
});

// Static renders read the store's initial-state snapshot (the hook object is a
// copy of the api, so getServerState cannot be swapped). Sync it before render.
const render = (el: React.ReactElement) => {
  Object.assign(
    useVideoEditStore.getInitialState(),
    useVideoEditStore.getState(),
  );
  return renderToStaticMarkup(el);
};

const S = () => useVideoEditStore.getState();

beforeEach(() => {
  S().closeProject();
  S().setSpeed(1);
  if (S().loop) S().toggleLoop();
  useEditorStore.getState().clearSourceImage?.();
});

describe("video edit store", () => {
  it("opens a project as one clip and activates video mode", () => {
    S().openProject(src("a", 5), "Shot");
    expect(S().edit?.clips).toHaveLength(1);
    expect(S().active).toBe(true);
    expect(S().label).toBe("Shot");
    expect(S().selectedClipId).toBe(S().edit!.clips[0].id);
  });

  it("undoes and redoes edits, clamping the transport", () => {
    S().openProject(src("a", 5), "Shot");
    S().appendSource(src("b", 3), "B");
    expect(timelineDuration(S().edit!)).toBeCloseTo(8);
    S().seek(7.5);
    S().setOut(7.9);
    const id = S().edit!.clips[1].id;
    S().apply((e) => ({ ...e, clips: e.clips.filter((c) => c.id !== id) }));
    expect(timelineDuration(S().edit!)).toBeCloseTo(5);
    expect(S().playhead).toBeCloseTo(5);
    expect(S().outPoint).toBeCloseTo(5);
    S().undo();
    expect(S().edit!.clips).toHaveLength(2);
    S().redo();
    expect(S().edit!.clips).toHaveLength(1);
    // No-op edits do not add history.
    const before = S().past.length;
    S().apply((e) => e);
    expect(S().past.length).toBe(before);
  });

  it("shuttles J/K/L with doubling and restarts at the end", () => {
    S().openProject(src("a", 5), "Shot");
    S().shuttle(1);
    expect(S().rate).toBe(1);
    S().shuttle(1);
    expect(S().rate).toBe(2);
    S().shuttle(-1);
    expect(S().rate).toBe(-1);
    S().shuttle(0);
    expect(S().rate).toBe(0);
    S().seek(5);
    S().togglePlay();
    expect(S().playhead).toBe(0);
    expect(S().rate).toBe(1);
    S().togglePlay();
    expect(S().rate).toBe(0);
  });

  it("tracks unsaved edits; closing a dirty project asks first", async () => {
    S().openProject(src("a", 5), "Shot");
    expect(S().projectId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(S().dirty).toBe(false);
    // Nothing edited: closes without asking.
    const never = vi.fn(async () => true);
    expect(await closeVideoProject(never)).toBe(true);
    expect(never).not.toHaveBeenCalled();
    expect(S().edit).toBeNull();
    expect(S().projectId).toBeNull();

    S().openProject(src("a", 5), "Shot");
    S().apply((e) => splitAt(e, 2));
    expect(S().dirty).toBe(true);
    const no = vi.fn(async () => false);
    expect(await closeVideoProject(no)).toBe(false);
    expect(no).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, confirmLabel: "Close project" }),
    );
    expect(S().edit).not.toBeNull();
    S().markSaved();
    expect(S().dirty).toBe(false);
    S().undo();
    expect(S().dirty).toBe(true);
    expect(await closeVideoProject(async () => true)).toBe(true);
    expect(S().edit).toBeNull();
  });

  it("migrates v1 saved projects as unsaved with a fresh id", () => {
    const opts = (
      useVideoEditStore as unknown as {
        persist: {
          getOptions: () => {
            migrate: (s: unknown, v: number) => Record<string, unknown>;
          };
        };
      }
    ).persist.getOptions();
    const out = opts.migrate({ edit: { v: 1, clips: [] }, label: "x" }, 1);
    expect(out.dirty).toBe(true);
    expect(typeof out.projectId).toBe("string");
    expect(opts.migrate({ edit: null }, 1).projectId).toBeUndefined();
  });

  it("keeps in/out ordered", () => {
    S().openProject(src("a", 5), "Shot");
    S().setIn(2);
    S().setOut(1); // before in: in is dropped
    expect(S().inPoint).toBeNull();
    expect(S().outPoint).toBe(1);
  });

  it("works out the active range: marks, then selected clip, then all", () => {
    S().openProject(src("a", 4), "A");
    S().appendSource(src("b", 2), "B");
    const e = S().edit!;
    expect(activeRange(e, 1, 3, null)).toEqual({
      start: 1,
      end: 3,
      source: "marks",
    });
    expect(activeRange(e, null, null, e.clips[1].id)).toEqual({
      start: 4,
      end: 6,
      source: "clip",
    });
    expect(activeRange(e, null, null, null)).toEqual({
      start: 0,
      end: 6,
      source: "all",
    });
    expect(rangeLabel(activeRange(e, 1, 3, null))).toMatch(
      /^In \/ out: .*\(2\.0 s\)$/,
    );
    expect(
      playheadFps(
        { ...e, clips: [e.clips[0], { ...e.clips[1], src: src("c", 2, 30) }] },
        5,
      ),
    ).toBe(30);
  });

  it("tracks a tool run from the launch and accepts its result into the range", () => {
    S().openProject(src("a", 6), "A");
    S().addLaunch({
      itemId: "video-editor:1",
      title: "Relight",
      start: 2,
      end: 4,
      cutUrl: "/cut.mp4",
      at: 1,
    });
    S().addLaunch({
      itemId: "other",
      title: "Upscale",
      start: 0,
      end: 6,
      cutUrl: "/all.mp4",
      at: 0,
    });
    // Paired by the hand-off's itemId, not by whichever launch came last.
    S().trackToolRun("run1", "Relight", "video-editor:1");
    S().trackToolRun("run1", "Relight", "video-editor:1");
    expect(S().toolRuns).toHaveLength(1);
    expect(S().toolRuns[0]).toMatchObject({ start: 2, end: 4 });
    S().addResult({
      id: "run1:0",
      title: "Relight",
      runId: "run1",
      jobIndex: 0,
      start: 2,
      end: 4,
      cutUrl: "/cut.mp4",
      kind: "video",
      url: "/out.mp4",
      source: src("out", 2),
      at: 2,
    });
    expect(S().compareId).toBe("run1:0");
    expect(S().panel).toBe("results");
    expect(acceptResult(S().results[0])).toBe(true);
    const clips = S().edit!.clips;
    expect(clips.map((c) => clipLength(c))).toEqual([2, 2, 2]);
    expect(clips[1].madeBy).toBe("Relight");
    expect(S().results).toHaveLength(0);
    expect(S().compareId).toBeNull();
    S().undo();
    expect(S().edit!.clips).toHaveLength(1);
  });

  it("steps aside when an image is opened in the editor, and can resume", () => {
    S().openProject(src("a", 3), "A");
    useEditorStore.getState().setSourceImage("/img.png");
    expect(S().active).toBe(false);
    expect(S().edit).not.toBeNull();
    S().setActive(true);
    expect(S().active).toBe(true);
  });

  it("maps clicks to the displayed picture", () => {
    expect(containRect(200, 100, 1280, 720)).toMatchObject({ y: 0, h: 100 });
    const r = containRect(100, 100, 1280, 720);
    expect(r.w).toBe(100);
    expect(r.y).toBeCloseTo((100 - 56.25) / 2);
  });
});

describe("video editor components", () => {
  it("renders the editor with accessible transport and timeline", () => {
    S().openProject(src("a", 4), "Test pattern");
    S().apply((e) => splitAt(e, 2));
    const html = render(<VideoEditor />);
    expect(html).toContain('data-testid="video-editor"');
    expect(html).toContain("Test pattern");
    expect(html).toContain('aria-label="Playback and edit controls"');
    expect(html).toContain('aria-label="Split at the playhead"');
    expect(html).toContain('aria-keyshortcuts="J"');
    expect(html).toContain('aria-label="Playhead"');
    expect(html).toContain('aria-label="Trim start of clip 1"');
    expect((html.match(/data-testid="video-clip"/g) ?? []).length).toBe(2);
    expect(html).toContain('role="tablist"');
    expect(html).toContain("00:00:00:00");
  });

  it("renders each panel", () => {
    S().openProject(src("a", 4), "Clip");
    S().setIn(1);
    S().setOut(2);
    const tools = render(<VideoToolsPanel />);
    expect(tools).toContain("In / out: 00:01.000 - 00:02.000");
    expect(tools).toContain("data-lightbox-tool=");
    expect(render(<VideoSelectPanel />)).toContain("Select a subject");
    const exp = render(<VideoExportPanel />);
    expect(exp).toContain("Export video (MP4)");
    expect(exp).toContain("Export in / out only");
    expect(exp).toContain("Save frame at playhead (PNG)");
    expect(render(<VideoResultsPanel />)).toContain(
      "Tool results show up here",
    );
  });

  it("warns when the range is too long for tools", () => {
    S().openProject(src("a", 200), "Long");
    const html = render(<VideoToolsPanel />);
    expect(html).toContain("Tools take at most 120 s");
  });

  it("shows Effects (LTX) with a window warning for a long clip", () => {
    S().openProject(src("a", 9), "Long clip");
    const html = render(<VideoToolsPanel />);
    expect(html).toContain('data-testid="video-ltx-effects"');
    expect(html).toContain("Effects (LTX)");
    for (const id of [
      "day_to_night",
      "add_water",
      "clean_plate",
      "alpha_matte",
      "expand",
    ])
      expect(html).toContain(`data-testid="ltx-effect-${id}"`);
    expect(html).toContain('data-testid="ltx-effect-warnings"');
    expect(html).toContain("the LTX window is 4 s");
  });

  it("no LTX warning when the range fits every window", () => {
    S().openProject(src("a", 3), "Short clip");
    const html = render(<VideoToolsPanel />);
    expect(html).toContain('data-testid="video-ltx-effects"');
    expect(html).not.toContain('data-testid="ltx-effect-warnings"');
  });

  it("transport has an Effects (LTX) button gated on a selected clip", () => {
    S().openProject(src("a", 4), "Clip");
    S().selectClip(null);
    expect(render(<VideoTransport />)).toContain(
      'aria-label="Effects (LTX) (select a clip first)"',
    );
    S().selectClip(S().edit!.clips[0].id);
    expect(render(<VideoTransport />)).toContain(
      'aria-label="Effects (LTX) on the selected clip"',
    );
  });

  it("hides edit buttons on phones (compact)", () => {
    S().openProject(src("a", 4), "Clip");
    const full = render(<VideoTransport />);
    const compact = render(<VideoTransport compact />);
    expect(full).toContain('aria-label="Keyboard shortcuts"');
    expect(compact).not.toContain('aria-label="Keyboard shortcuts"');
    expect(render(<VideoTimeline compact />)).not.toContain("Zoom in timeline");
  });

  it("labels NTSC timecode as non-drop-frame", () => {
    S().openProject(src("a", 4, 29.97), "NTSC");
    expect(render(<VideoTransport />)).toContain(">NDF<");
    S().openProject(src("b", 4, 25), "PAL");
    expect(render(<VideoTransport />)).not.toContain(">NDF<");
  });

  it("copy has no retired brand names", () => {
    S().openProject(src("a", 4), "Clip");
    const html = [
      render(<VideoEditor />),
      render(<VideoExportPanel />),
      render(<VideoSelectPanel />),
      render(<VideoStartSection />),
    ]
      .join("\n")
      .toLowerCase();
    expect(html).not.toContain("mid" + "journey");
    expect(html).not.toContain("comfy" + "journey");
  });
});

describe("start screen videos", () => {
  const item = (id: string, over: Partial<GalleryImage>): GalleryImage =>
    ({
      id,
      url: "/x.png",
      prompt: id,
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    }) as GalleryImage;

  it("lists editable videos newest first, skipping stills, hidden and external", () => {
    const v = (f: string) =>
      `/api/comfy/image?filename=${f}&subfolder=&type=output`;
    const list = selectEditorVideos([
      item("old", { videoUrl: v("a.mp4"), createdAt: "2026-01-01T00:00:00Z" }),
      item("new", { videoUrl: v("b.mp4"), createdAt: "2026-02-01T00:00:00Z" }),
      item("hydrated", { url: v("c.webm"), createdAt: "2026-01-15T00:00:00Z" }),
      item("still", { url: v("d.png") }),
      item("hidden", { videoUrl: v("e.mp4"), hidden: true }),
      item("ext", {
        videoUrl: v("f.mp4"),
        external: { source: "civitai", id: 1 },
      }),
    ]);
    expect(list.map((x) => x.id)).toEqual(["new", "hydrated", "old"]);
  });

  it("lists gallery audio for the A2 lane, newest first", () => {
    const v = (f: string) =>
      `/api/comfy/image?filename=${f}&subfolder=&type=output`;
    const list = selectEditorAudio([
      item("old", { audioUrl: v("a.flac"), createdAt: "2026-01-01T00:00:00Z" }),
      item("new", { audioUrl: v("b.mp3"), createdAt: "2026-02-01T00:00:00Z" }),
      item("dup", { audioUrl: v("b.mp3"), createdAt: "2026-01-02T00:00:00Z" }),
      item("odd", { audioUrl: v("c.exe") }),
      item("hidden", { audioUrl: v("d.wav"), hidden: true }),
      item("none", {}),
    ]);
    expect(list.map((x) => x.id)).toEqual(["new", "old"]);
  });
});
