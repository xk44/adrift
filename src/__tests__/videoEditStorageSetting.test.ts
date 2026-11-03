/**
 * "Keep uploads for saved projects": a server setting in
 * data/runtime_settings.json (`videoEditRefDays`), default forever.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const D = 24 * 3_600_000;
let dir = "";
let file = "";
let work = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-vedit-setting-"));
  file = path.join(dir, "rt.json");
  work = path.join(dir, "work");
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
  vi.stubEnv("ADRIFT_VIDEO_EDIT_DIR", work);
  vi.stubEnv("ADMIN_API_KEY", "");
  vi.resetModules();
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost:3000/api/settings/video-edit", {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("runtime settings videoEditRefDays", () => {
  it("defaults to forever and sanitizes invalid values to the default", async () => {
    const rt = await import("@/lib/runtimeSettings");
    expect(rt.readVideoEditRefDays()).toBeNull();
    for (const d of [30, 90, 365])
      expect(
        rt.sanitizeRuntimeSettings({ version: 1, videoEditRefDays: d })
          .videoEditRefDays,
      ).toBe(d);
    for (const bad of [0, 7, -90, 91, "90", null, 1e9, 90.5, true])
      expect(
        "videoEditRefDays" in
          rt.sanitizeRuntimeSettings({ version: 1, videoEditRefDays: bad }),
      ).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, videoEditRefDays: 45 }));
    rt.invalidateRuntimeSettingsCache();
    expect(rt.readVideoEditRefDays()).toBeNull();
  });

  it("saves, keeps other settings, and clears back to forever", async () => {
    const rt = await import("@/lib/runtimeSettings");
    rt.writeComfyConnection({ httpUrl: "http://127.0.0.1:8188", mode: "local" });
    rt.writeVideoEditRefDays(90);
    expect(rt.readVideoEditRefDays()).toBe(90);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.videoEditRefDays).toBe(90);
    expect(onDisk.comfy.httpUrl).toBe("http://127.0.0.1:8188");
    rt.writeVideoEditRefDays(null);
    expect(rt.readVideoEditRefDays()).toBeNull();
    expect("videoEditRefDays" in JSON.parse(fs.readFileSync(file, "utf8"))).toBe(
      false,
    );
  });

  it("the sweep follows the saved setting", async () => {
    const rt = await import("@/lib/runtimeSettings");
    const { sweepWorkDir } = await import("@/lib/videoEdit/server");
    const { writeProjectRefs } = await import("@/lib/videoEdit/projectRefs");
    const up = path.join(work, "uploads/old1.mp4");
    fs.mkdirSync(path.dirname(up), { recursive: true });
    fs.writeFileSync(up, Buffer.alloc(1000));
    const t = (Date.now() - 500 * D) / 1000;
    fs.utimesSync(up, t, t);
    writeProjectRefs(
      work,
      { projectId: "project-old1", files: ["uploads/old1.mp4"] },
      Date.now() - 400 * D,
    );
    sweepWorkDir(Date.now(), work, 100);
    expect(fs.existsSync(up)).toBe(true); // forever
    rt.writeVideoEditRefDays(365);
    sweepWorkDir(Date.now(), work, 100);
    expect(fs.existsSync(up)).toBe(false);
  });
});

describe("/api/settings/video-edit", () => {
  it("GET default, PUT valid / invalid, POST releases stale projects", async () => {
    const { GET, PUT, POST } = await import(
      "@/app/api/settings/video-edit/route"
    );
    const { writeProjectRefs } = await import("@/lib/videoEdit/projectRefs");
    expect(await (await GET(req("GET"))).json()).toEqual({
      ok: true,
      keepDays: null,
      projects: 0,
      oldestAt: null,
    });

    let res = await PUT(req("PUT", { keepDays: 30 }));
    expect(await res.json()).toEqual({ ok: true, keepDays: 30 });
    expect((await (await GET(req("GET"))).json()).keepDays).toBe(30);
    for (const bad of [{ keepDays: 45 }, { keepDays: "30" }, {}, []]) {
      res = await PUT(req("PUT", bad));
      expect(res.status).toBe(400);
    }
    expect((await (await GET(req("GET"))).json()).keepDays).toBe(30);
    res = await PUT(req("PUT", { keepDays: null }));
    expect(await res.json()).toEqual({ ok: true, keepDays: null });

    const old = Date.now() - 200 * D;
    writeProjectRefs(work, { projectId: "project-aaaa", files: ["uploads/a1.mp4"] }, old);
    writeProjectRefs(work, { projectId: "project-bbbb", files: ["uploads/b1.mp4"] });
    const g = await (await GET(req("GET"))).json();
    expect(g.projects).toBe(2);
    expect(g.oldestAt).toBe(old);
    for (const bad of [{}, { releaseOlderThanDays: 0 }, { releaseOlderThanDays: 2.5 }, { releaseOlderThanDays: "90" }, { releaseOlderThanDays: 99999 }])
      expect((await POST(req("POST", bad))).status).toBe(400);
    expect(await (await POST(req("POST", { releaseOlderThanDays: 90 }))).json()).toEqual({ ok: true, released: 1 });
    expect((await (await GET(req("GET"))).json()).projects).toBe(1);
  });

  it("requires admin when an admin key is set", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    vi.resetModules();
    const { GET, PUT, POST } = await import(
      "@/app/api/settings/video-edit/route"
    );
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await PUT(req("PUT", { keepDays: 30 }))).status).toBe(401);
    expect((await POST(req("POST", { releaseOlderThanDays: 30 }))).status).toBe(401);
    expect(fs.existsSync(file)).toBe(false);
  });
});
