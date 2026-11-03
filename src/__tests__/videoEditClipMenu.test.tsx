/** Clip menu: AI verbs mapped to installed tools, the range a verb works on, the send-to-tool flow and the menu render. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import { navigateTo } from "@/hooks/useNavSync";
import { showToast } from "@/components/Toast";
import {
  CLIP_VERBS,
  clipMenuRange,
  clipVerbs,
} from "@/lib/videoEdit/clipVerbs";
import {
  clipFromSource,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  buildVideoEditorTools,
  type VideoEditorTool,
} from "@/lib/videoEdit/videoTools";
import { RETAKE_TOOL_KEY } from "@/lib/videoEdit/retake";
import { workMediaUrl } from "@/lib/videoEdit/sourceRef";
import { useVideoEditStore } from "@/store/videoEditStore";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import {
  sendBridge,
  sendRangeToTool,
} from "@/components/editor/video/sendToTool";
import {
  BRIDGE_TOOL_KEYS,
  bridgePlan,
  bridgeTools,
} from "@/lib/videoEdit/bridge";
import { VideoClipMenu } from "@/components/editor/video/VideoClipMenu";
import { VideoTimeline } from "@/components/editor/video/VideoTimeline";

const src = (name: string, duration: number): VideoSource => ({
  url: workMediaUrl(`uploads/${name}.mp4`),
  duration,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
});

const edit = (...d: number[]): EditList => ({
  v: 1,
  clips: d.map((n, i) => clipFromSource(src(`c${i}`, n), `C${i}`)),
});

const S = () => useVideoEditStore.getState();
const render = (el: React.ReactElement) => {
  Object.assign(
    useVideoEditStore.getInitialState(),
    useVideoEditStore.getState(),
  );
  return renderToStaticMarkup(el);
};

describe("clipVerbs", () => {
  const tools = buildVideoEditorTools(null);

  it("maps every verb to a tool in the registry", () => {
    const keys = new Set(tools.map((t) => t.key));
    for (const v of CLIP_VERBS)
      expect(v.keys.some((k) => keys.has(k)), v.id).toBe(true);
    expect(clipVerbs(tools).map((v) => v.id)).toEqual(
      CLIP_VERBS.map((v) => v.id),
    );
  });

  it("drops verbs whose tool is missing and falls back to the next key", () => {
    const some = tools.filter(
      (t) =>
        t.key !== "action:video_object_remove" &&
        t.key !== "action:upscale_video",
    );
    const verbs = clipVerbs(some);
    expect(verbs.find((v) => v.id === "upscale")).toBeUndefined();
    expect(verbs.find((v) => v.id === "remove")?.tool.key).toBe(
      "action:person_remove",
    );
    expect(verbs[0].tool.key).toBe(RETAKE_TOOL_KEY);
    expect(clipVerbs([])).toEqual([]);
  });
});

describe("clipMenuRange", () => {
  const e = edit(2, 3, 1);
  const [a, b] = e.clips;

  it("is the clip without marks", () => {
    expect(clipMenuRange(e, b.id, null, null)).toEqual({
      start: 2,
      end: 5,
      source: "clip",
    });
    expect(clipMenuRange(e, "nope", null, null)).toBeNull();
  });

  it("is the marks when they overlap the clip, else the clip", () => {
    expect(clipMenuRange(e, b.id, 2.5, 3.5)).toEqual({
      start: 2.5,
      end: 3.5,
      source: "marks",
    });
    // Marks on another clip: the clicked clip wins.
    expect(clipMenuRange(e, a.id, 3, 4)).toMatchObject({ source: "clip" });
    // Open-ended marks.
    expect(clipMenuRange(e, b.id, 4, null)).toEqual({
      start: 4,
      end: 6,
      source: "marks",
    });
  });
});

describe("sendRangeToTool", () => {
  beforeEach(() => {
    S().closeProject();
    S().openProject(src("a", 4), "Shot");
    vi.mocked(navigateTo).mockClear();
    vi.mocked(showToast).mockClear();
    useToolHandoffStore.setState({ pending: null, prefill: null });
    vi.unstubAllGlobals();
  });

  const upscale = () =>
    buildVideoEditorTools(null).find(
      (t) => t.key === "action:upscale_video",
    ) as VideoEditorTool;

  it("cuts the range, hands it to the tool and remembers the launch", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ mode: "range", start: 1, end: 2.5 });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            url: workMediaUrl("renders/cut_9.mp4"),
            kind: "video",
            width: 1280,
            height: 720,
            duration: 1.5,
            fps: 24,
            hasAudio: true,
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(useOverlayToolsStore.getState(), "openToolFromLauncher");
    expect(
      await sendRangeToTool(upscale(), { start: 1, end: 2.5, source: "clip" }),
    ).toBe(true);
    const h = useToolHandoffStore.getState().pending!;
    expect(h).toMatchObject({
      toolKey: "action:upscale_video",
      media: "video",
      url: workMediaUrl("renders/cut_9.mp4"),
      origin: "video-editor",
    });
    expect(S().launches.at(-1)).toMatchObject({
      itemId: h.itemId,
      title: upscale().title,
      start: 1,
      end: 2.5,
      cutUrl: workMediaUrl("renders/cut_9.mp4"),
    });
    expect(navigateTo).toHaveBeenCalledWith("tools");
    expect(open).toHaveBeenCalledWith("action:upscale_video", false);
    open.mockRestore();
  });

  it("refuses a range longer than tools take, and reports cut failures", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "disk full" }), {
        status: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await sendRangeToTool(upscale(), { start: 0, end: 500, source: "all" }),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await sendRangeToTool(upscale(), { start: 0, end: 2, source: "clip" }),
    ).toBe(false);
    expect(vi.mocked(showToast).mock.calls.at(-1)?.[0]).toContain("disk full");
    expect(useToolHandoffStore.getState().pending).toBeNull();
  });
});

describe("clip menu render", () => {
  beforeEach(() => {
    S().closeProject();
    S().openProject(src("a", 4), "Shot");
  });

  it("lists the AI verbs and plain edits for the clip", () => {
    const id = S().edit!.clips[0].id;
    S().seek(2);
    const html = render(
      <VideoClipMenu at={{ clipId: id, x: 10, y: 10 }} onClose={() => {}} />,
    );
    expect(html).toContain('role="menu"');
    expect(html).toContain("Selected clip: 00:00.000 - 00:04.000");
    for (const label of ["Retake", "Extend", "Upscale", "Relight / restyle", "Lip-sync"])
      expect(html).toContain(`>${label}<`);
    expect(html).toContain("Split at playhead");
    expect(html).toContain('data-testid="clip-op-reverse"');
    expect(html).toContain("Freeze frame at playhead (2 s)");
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(
      CLIP_VERBS.length + 5,
    );
  });

  it("selected clips get a keyboard-reachable menu button", () => {
    const html = render(<VideoTimeline />);
    expect(html).toContain('aria-label="Actions for clip 1"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});

describe("bridge cut", () => {
  it("plans the cut after a clip and its two frames", () => {
    const e = edit(2, 3, 1);
    expect(bridgePlan(e, e.clips[0].id)).toEqual({
      cut: 2,
      fromT: 2 - 0.5 / 24,
      toT: 2,
      left: 1,
      right: 2,
    });
    expect(bridgePlan(e, e.clips[1].id)?.cut).toBe(5);
    expect(bridgePlan(e, e.clips[2].id)).toBeNull();
    expect(bridgePlan(e, "nope")).toBeNull();
  });

  it("finds start/end-frame tools, local first", () => {
    const keys = bridgeTools(null).map((t) => t.key);
    expect(keys).toEqual([...BRIDGE_TOOL_KEYS]);
  });

  beforeEach(() => {
    S().closeProject();
    S().openProject(src("a", 2), "Shot");
    S().appendSource(src("b", 3), "B");
    vi.mocked(showToast).mockClear();
    useToolHandoffStore.setState({ pending: null, prefill: null });
    vi.unstubAllGlobals();
  });

  it("hands both frames to the tool and records a zero-length launch at the cut", async () => {
    const ts: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.mode).toBe("frame");
        ts.push(body.t);
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: workMediaUrl(`thumbs/f${ts.length}.png`),
              kind: "image",
              width: 1280,
              height: 720,
              duration: 0,
              fps: 0,
              hasAudio: false,
            },
          }),
        );
      }),
    );
    const tool = bridgeTools(null)[0];
    const id = S().edit!.clips[0].id;
    expect(await sendBridge(tool, id)).toBe(true);
    expect(ts.sort()).toEqual([2 - 0.5 / 24, 2]);
    const h = useToolHandoffStore.getState().pending!;
    expect(h).toMatchObject({
      toolKey: "action:ltx25_transition",
      media: "image",
      origin: "video-editor",
      label: "Shot: end of clip 1",
    });
    expect(h.moreImages).toHaveLength(1);
    expect(h.moreImages![0].label).toBe("Shot: start of clip 2");
    expect(new Set([h.url, h.moreImages![0].url]).size).toBe(2);
    expect(S().launches.at(-1)).toMatchObject({
      itemId: h.itemId,
      start: 2,
      end: 2,
    });
  });

  it("refuses the last clip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const last = S().edit!.clips[1].id;
    expect(await sendBridge(bridgeTools(null)[0], last)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the menu offers it only when a next clip exists", () => {
    const [a, b] = S().edit!.clips;
    const first = render(
      <VideoClipMenu at={{ clipId: a.id, x: 0, y: 0 }} onClose={() => {}} />,
    );
    expect(first).toContain('data-testid="clip-verb-bridge"');
    expect(first).toContain("Bridge to next clip");
    const second = render(
      <VideoClipMenu at={{ clipId: b.id, x: 0, y: 0 }} onClose={() => {}} />,
    );
    expect(second).not.toContain("clip-verb-bridge");
  });
});
