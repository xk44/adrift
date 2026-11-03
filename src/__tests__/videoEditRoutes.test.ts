/**
 * Video editor API: source URL / work-file validation (path traversal),
 * request ranges, Range headers, and the routes' auth + validation paths
 * (server work mocked; no ffmpeg, no ComfyUI).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clipFromSource } from "@/lib/videoEdit/editList";
import {
  parseByteRange,
  parseRenderRequest,
  parseThumbsRequest,
  uploadExtension,
} from "@/lib/videoEdit/requests";
import {
  isEditableVideoUrl,
  parseSourceUrl,
  parseWorkFile,
  workMediaUrl,
} from "@/lib/videoEdit/sourceRef";

const proxy = (f: string, sub = "", type = "output") =>
  `/api/comfy/image?filename=${encodeURIComponent(f)}&subfolder=${encodeURIComponent(sub)}&type=${type}`;

describe("parseSourceUrl", () => {
  it("accepts proxy, ComfyUI view and work URLs", () => {
    expect(parseSourceUrl(proxy("clip_00001_.mp4", "video"))).toEqual({
      kind: "comfy",
      filename: "clip_00001_.mp4",
      subfolder: "video",
      type: "output",
    });
    expect(
      parseSourceUrl(
        "http://127.0.0.1:8188/view?filename=a.webm&subfolder=&type=temp",
      ),
    ).toMatchObject({ kind: "comfy", type: "temp" });
    expect(parseSourceUrl(workMediaUrl("renders/abc_1.mp4"))).toEqual({
      kind: "work",
      file: "renders/abc_1.mp4",
      area: "renders",
    });
  });

  it.each([
    proxy("../secret.mp4"),
    proxy("a.mp4", "../../etc"),
    proxy("a.mp4", "video/../.."),
    proxy("a.mp4", "/abs"),
    proxy("a.mp4", "a//b"),
    proxy("a/b.mp4"),
    proxy("a.mp4", "", "models"),
    proxy("a.png"),
    proxy("a.mp4\u0000.png"),
    "/api/comfy/image?filename=a.mp4&subfolder=..%2F..&type=output",
    "/api/video-edit/media?f=../data/adrift.db",
    "/api/video-edit/media?f=renders/../../x.mp4",
    "/api/video-edit/media?f=renders/a.b.mp4",
    "/api/video-edit/media?f=secret/a.mp4",
    "/api/video-edit/media?f=thumbs/a.png", // not a video
    "/etc/passwd",
    "file:///etc/passwd.mp4",
    "javascript:alert(1)",
    "/api/other?filename=a.mp4",
    "http://evil.example/api/comfy/image?filename=a.mp4",
    "",
    42,
    null,
  ])("rejects %s", (url) => {
    expect(parseSourceUrl(url)).toBeNull();
  });

  it("allows non-video work files only when asked", () => {
    expect(
      parseSourceUrl(workMediaUrl("thumbs/a.png"), { videoOnly: false }),
    ).toMatchObject({ kind: "work" });
    expect(parseWorkFile("thumbs/a.png")?.ext).toBe("png");
    expect(isEditableVideoUrl(proxy("x.mov"))).toBe(true);
    expect(isEditableVideoUrl(proxy("x.jpg"))).toBe(false);
  });
});

const goodEdit = {
  v: 1,
  clips: [
    clipFromSource(
      {
        url: proxy("a.mp4"),
        duration: 10,
        width: 640,
        height: 360,
        fps: 24,
        hasAudio: true,
      },
      "A",
      "a",
    ),
  ],
};

describe("parseRenderRequest", () => {
  it("defaults to the whole timeline and saving", () => {
    const r = parseRenderRequest({ mode: "mp4", edit: goodEdit });
    expect(r).toMatchObject({
      ok: true,
      value: { start: 0, end: 10, save: true },
    });
  });

  it("validates ranges, frame times and tool range length", () => {
    const bad = (body: Record<string, unknown>) =>
      parseRenderRequest({ edit: goodEdit, ...body });
    expect(bad({ mode: "gif" }).ok).toBe(false);
    expect(bad({ mode: "mp4", start: -1, end: 2 }).ok).toBe(false);
    expect(bad({ mode: "mp4", start: 2, end: 99 }).ok).toBe(false);
    expect(bad({ mode: "mp4", start: 3, end: 3 }).ok).toBe(false);
    expect(bad({ mode: "mp4", start: "0", end: 2 }).ok).toBe(false);
    expect(bad({ mode: "frame" }).ok).toBe(false);
    expect(bad({ mode: "frame", t: 11 }).ok).toBe(false);
    expect(bad({ mode: "frame", t: 2 }).ok).toBe(true);
    const range = bad({ mode: "range", start: 1, end: 4, save: true });
    expect(range).toMatchObject({ ok: true, value: { save: false } });
  });

  it("parses export settings strictly", () => {
    const req = (output: unknown) =>
      parseRenderRequest({ mode: "mp4", edit: goodEdit, output });
    expect(req(undefined)).toMatchObject({
      ok: true,
      value: { output: { resolution: "keep", fps: 0, quality: "high" } },
    });
    expect(req({ resolution: "720", fps: 30, quality: "small" })).toMatchObject({
      ok: true,
      value: { output: { resolution: "720", fps: 30, quality: "small" } },
    });
    for (const bad of [
      { resolution: "4k" },
      { resolution: 720 },
      { fps: 25 },
      { fps: "30" },
      { quality: "lossless" },
      "high",
      [],
    ])
      expect(req(bad).ok).toBe(false);
  });

  it("rejects clip fx and frames out of range", () => {
    const clip = goodEdit.clips[0];
    for (const [extra, msg] of [
      [{ speed: 8 }, "speed"],
      [{ volume: -0.1 }, "volume"],
      [{ fadeOut: 60 }, "fade out"],
    ] as const)
      expect(
        parseRenderRequest({ mode: "mp4", edit: { clips: [{ ...clip, ...extra }] } }),
      ).toMatchObject({ ok: false, error: expect.stringContaining(msg) });
    expect(
      parseRenderRequest({
        mode: "mp4",
        edit: { ...goodEdit, frame: { aspect: "16:10", x: 0.5, y: 0.5 } },
      }),
    ).toMatchObject({ ok: false, error: "bad output frame" });
  });

  it("rejects edit lists with unsafe sources", () => {
    const evil = {
      clips: [
        {
          ...goodEdit.clips[0],
          src: { ...goodEdit.clips[0].src, url: proxy("x.mp4", "../..") },
        },
      ],
    };
    expect(parseRenderRequest({ mode: "mp4", edit: evil })).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported source"),
    });
  });

  it("thumbs bounds", () => {
    expect(parseThumbsRequest({ url: proxy("a.mp4"), count: 0 }).ok).toBe(
      false,
    );
    expect(parseThumbsRequest({ url: proxy("a.mp4"), count: 61 }).ok).toBe(
      false,
    );
    expect(parseThumbsRequest({ url: proxy("a.mp4"), height: 1000 }).ok).toBe(
      false,
    );
    expect(parseThumbsRequest({ url: proxy("a.mp4") })).toMatchObject({
      ok: true,
      value: { count: 24, height: 54, kind: "strip" },
    });
    expect(
      parseThumbsRequest({ url: proxy("a.mp4"), kind: "wave" }),
    ).toMatchObject({ ok: true, value: { kind: "wave" } });
    expect(parseThumbsRequest({ url: proxy("a.mp4"), kind: "exe" }).ok).toBe(
      false,
    );
  });

  it("upload extension", () => {
    expect(uploadExtension("My Clip.MOV")).toBe("mov");
    expect(uploadExtension("x.exe")).toBeNull();
    expect(uploadExtension("x.mp4.sh")).toBeNull();
    expect(uploadExtension("Song.MP3")).toBe("mp3");
    expect(uploadExtension("vo.wav")).toBe("wav");
    expect(uploadExtension("a.M4A")).toBe("m4a");
    expect(uploadExtension("a.flac")).toBe("flac");
    expect(uploadExtension("a.ogg")).toBe("ogg");
    expect(uploadExtension("a.wav.sh")).toBeNull();
  });
});

describe("parseByteRange", () => {
  it("parses single ranges", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5-1", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseByteRange("items=0-1", 100)).toBeNull();
  });
});

// ---- routes -----------------------------------------------------------------

const render = vi.fn();
const probeSource = vi.fn();
const waveform = vi.fn();
const conformResult = vi.fn();
const deriveClip = vi.fn();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-routes-"));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

async function loadRoutes(adminKey = "") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminKey,
      COMFY_ROOT: "/tmp/vedit-no-comfy",
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      NODE_ENV: "test",
    },
  }));
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));
  vi.doMock("@/lib/videoEdit/server", async (orig) => ({
    ...(await orig<typeof import("@/lib/videoEdit/server")>()),
    render,
    probeSource,
    waveform,
    conformResult,
    deriveClip,
  }));
  return {
    render: (await import("@/app/api/video-edit/render/route")).POST,
    probe: (await import("@/app/api/video-edit/probe/route")).POST,
    media: (await import("@/app/api/video-edit/media/route")).GET,
    refs: (await import("@/app/api/video-edit/refs/route")).POST,
    thumbs: (await import("@/app/api/video-edit/thumbs/route")).POST,
    conform: (await import("@/app/api/video-edit/conform/route")).POST,
    derive: (await import("@/app/api/video-edit/derive/route")).POST,
  };
}

const post = (url: string, body: unknown, token?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  render.mockReset();
  probeSource.mockReset();
  waveform.mockReset();
  conformResult.mockReset();
  deriveClip.mockReset();
  vi.stubEnv("ADRIFT_VIDEO_EDIT_DIR", workDir);
});

describe("routes", () => {
  it("require admin when a key is set", async () => {
    const r = await loadRoutes("k");
    expect((await r.render(post("/api/video-edit/render", {}))).status).toBe(
      401,
    );
    expect(
      (
        await r.media(
          new NextRequest(
            "http://localhost/api/video-edit/media?f=renders/a.mp4",
          ),
        )
      ).status,
    ).toBe(401);
    expect(render).not.toHaveBeenCalled();
  });

  it("render: 400 on bad bodies, passes parsed requests through", async () => {
    const r = await loadRoutes();
    expect(
      (await r.render(post("/api/video-edit/render", "{nope"))).status,
    ).toBe(400);
    expect(
      (
        await r.render(
          post("/api/video-edit/render", { mode: "mp4", edit: { clips: [] } }),
        )
      ).status,
    ).toBe(400);
    render.mockResolvedValue({ url: "/x", kind: "video" });
    const res = await r.render(
      post("/api/video-edit/render", {
        mode: "range",
        edit: goodEdit,
        start: 1,
        end: 3,
      }),
    );
    expect(res.status).toBe(200);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "range", start: 1, end: 3, save: false }),
      expect.any(AbortSignal),
    );
  });

  it("render: rejects bad export settings and clip fx before rendering", async () => {
    const r = await loadRoutes();
    for (const body of [
      { mode: "mp4", edit: goodEdit, output: { resolution: "8k" } },
      { mode: "mp4", edit: goodEdit, output: { quality: "best" } },
      { mode: "mp4", edit: { clips: [{ ...goodEdit.clips[0], speed: 0 }] } },
      { mode: "mp4", edit: { ...goodEdit, frame: { aspect: "1:1", x: -1, y: 0 } } },
    ])
      expect((await r.render(post("/api/video-edit/render", body))).status).toBe(400);
    expect(render).not.toHaveBeenCalled();
    render.mockResolvedValue({ url: "/x", kind: "video" });
    const output = { resolution: "1080", fps: 24, quality: "balanced" };
    const ok = await r.render(
      post("/api/video-edit/render", { mode: "mp4", edit: goodEdit, output }),
    );
    expect(ok.status).toBe(200);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ output: { ...output, format: "mp4" } }),
      expect.any(AbortSignal),
    );
  });

  it("thumbs: wave kind goes to the waveform, bad kinds and traversal 400", async () => {
    const r = await loadRoutes();
    expect(
      (await r.thumbs(post("/api/video-edit/thumbs", { url: proxy("a.mp4"), kind: "x" }))).status,
    ).toBe(400);
    expect(
      (
        await r.thumbs(
          post("/api/video-edit/thumbs", { url: proxy("a.mp4", "../.."), kind: "wave" }),
        )
      ).status,
    ).toBe(400);
    expect(waveform).not.toHaveBeenCalled();
    waveform.mockResolvedValue(null);
    const res = await r.thumbs(
      post("/api/video-edit/thumbs", { url: proxy("a.mp4"), kind: "wave", height: 40 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, wave: null });
    expect(waveform).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "comfy", filename: "a.mp4" }),
      40,
      false,
    );
    waveform.mockClear();
    expect(
      (
        await r.thumbs(
          post("/api/video-edit/thumbs", { url: proxy("song.mp3"), kind: "wave", height: 40, audio: true }),
        )
      ).status,
    ).toBe(200);
    expect(waveform).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "song.mp3" }),
      40,
      true,
    );
    expect(
      (
        await r.thumbs(
          post("/api/video-edit/thumbs", { url: proxy("song.mp3"), kind: "wave", height: 40 }),
        )
      ).status,
    ).toBe(400);
  });

  it("refs: registers and releases a project's uploads", async () => {
    const r = await loadRoutes();
    const file = path.join(workDir, "projects", "proj-0001.json");
    const ok = await r.refs(
      post("/api/video-edit/refs", {
        projectId: "proj-0001",
        files: ["uploads/a_1.mp4"],
      }),
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).files).toEqual([
      "uploads/a_1.mp4",
    ]);
    const bad = await r.refs(
      post("/api/video-edit/refs", {
        projectId: "proj-0001",
        files: ["../../x.mp4"],
      }),
    );
    expect(bad.status).toBe(400);
    await r.refs(
      post("/api/video-edit/refs", { projectId: "proj-0001", files: [] }),
    );
    expect(fs.existsSync(file)).toBe(false);
    const key = await loadRoutes("k");
    expect(
      (
        await key.refs(
          post("/api/video-edit/refs", { projectId: "proj-0001", files: [] }),
        )
      ).status,
    ).toBe(401);
  });

  it("conform: validates before touching the server", async () => {
    const r = await loadRoutes();
    const v = workMediaUrl("uploads/a.mp4");
    for (const body of [
      {},
      { video: v },
      { video: "/api/video-edit/media?f=../x.mp4", fps: 24 },
      { video: v, audio: "/etc/passwd" },
    ])
      expect(
        (await r.conform(post("/api/video-edit/conform", body))).status,
      ).toBe(400);
    expect(conformResult).not.toHaveBeenCalled();
    conformResult.mockResolvedValue({ url: "/u", file: "uploads/u.mp4", info: { duration: 1 } });
    const res = await r.conform(
      post("/api/video-edit/conform", { video: v, audio: v, fps: 24 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "/u", info: { duration: 1 } });
    expect(conformResult).toHaveBeenCalledWith(
      expect.objectContaining({ fps: 24, audio: expect.objectContaining({ kind: "work" }) }),
      expect.any(AbortSignal),
    );
  });

  it("derive: validates before touching the server", async () => {
    const r = await loadRoutes();
    const v = workMediaUrl("uploads/a.mp4");
    for (const body of [
      {},
      { op: "reverse", video: v, in: 0, out: 30 },
      { op: "freeze", video: "/etc/passwd", t: 0, seconds: 2 },
    ])
      expect((await r.derive(post("/api/video-edit/derive", body))).status).toBe(400);
    expect(deriveClip).not.toHaveBeenCalled();
    deriveClip.mockResolvedValue({ url: "/d", file: "uploads/d.mp4", info: { duration: 2 } });
    const res = await r.derive(
      post("/api/video-edit/derive", { op: "freeze", video: v, t: 1, seconds: 2 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "/d", info: { duration: 2 } });
    expect(deriveClip).toHaveBeenCalledWith(
      expect.objectContaining({ op: "freeze", t: 1, seconds: 2 }),
      expect.any(AbortSignal),
    );
  });

  it("probe: rejects traversal before touching the server", async () => {
    const r = await loadRoutes();
    const res = await r.probe(
      post("/api/video-edit/probe", { url: proxy("a.mp4", "../../..") }),
    );
    expect(res.status).toBe(400);
    expect(probeSource).not.toHaveBeenCalled();
  });

  it("media: serves work files with ranges, rejects traversal", async () => {
    const r = await loadRoutes();
    fs.mkdirSync(path.join(workDir, "renders"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "renders", "clip_1.mp4"), "0123456789");
    fs.writeFileSync(path.join(workDir, "secret.mp4"), "nope");
    const get = (f: string, range?: string) =>
      r.media(
        new NextRequest(
          `http://localhost/api/video-edit/media?f=${encodeURIComponent(f)}`,
          range ? { headers: { range } } : undefined,
        ),
      );
    const full = await get("renders/clip_1.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");
    const part = await get("renders/clip_1.mp4", "bytes=2-4");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    expect((await get("renders/clip_1.mp4", "bytes=50-")).status).toBe(416);
    expect((await get("renders/missing.mp4")).status).toBe(404);
    for (const f of [
      "../secret.mp4",
      "renders/../secret.mp4",
      "secret.mp4",
      "renders/x.sh",
    ]) {
      expect((await get(f)).status).toBe(400);
    }
  });
});
