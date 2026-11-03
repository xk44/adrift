/**
 * Blender detection (lib/blender/detect.ts), the saved Settings path, the
 * /api/settings/blender route and the "Open in Blender" button state. Fake
 * fs/exec only: no real Blender is run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectBlender,
  normalizeBlenderPath,
  parseBlenderPathInput,
  probeBlenderVersion,
  resolveBlender,
  type ExecFileFn,
  type FsProbe,
} from "@/lib/blender/detect";
import {
  invalidateRuntimeSettingsCache,
  readBlenderPathSetting,
  sanitizeRuntimeSettings,
  writeBlenderPathSetting,
} from "@/lib/runtimeSettings";
import { BLENDER_NOT_FOUND, blenderOpenButton } from "@/lib/mesh/blenderLinks";
import { blenderStatusLine } from "@/components/settings/BlenderSettings";

const fakeFs = (
  files: string[],
  dirs: Record<string, string[]> = {},
): FsProbe => ({
  exists: (p) => files.includes(p),
  readdir: (p) => dirs[p] ?? [],
});

const MAC_APP = "/Applications/Blender.app/Contents/MacOS/Blender";

describe("resolveBlender precedence", () => {
  it("env wins over the saved path and auto-detect", () => {
    const s = resolveBlender({
      platform: "darwin",
      env: { BLENDER_PATH: "/env/blender" },
      saved: "/saved/blender",
      probe: fakeFs(["/env/blender", "/saved/blender", MAC_APP]),
    });
    expect(s).toEqual({ path: "/env/blender", source: "env" });
  });

  it("the saved path wins over auto-detect", () => {
    const s = resolveBlender({
      platform: "darwin",
      env: {},
      saved: "/saved/blender",
      probe: fakeFs(["/saved/blender", MAC_APP]),
    });
    expect(s).toEqual({ path: "/saved/blender", source: "settings" });
  });

  it("a missing configured path is reported and skipped", () => {
    const s = resolveBlender({
      platform: "darwin",
      env: { BLENDER_PATH: "/gone/blender" },
      saved: null,
      probe: fakeFs([MAC_APP]),
    });
    expect(s).toEqual({
      path: MAC_APP,
      source: "auto",
      missing: { source: "env", path: "/gone/blender" },
    });
  });

  it("none when nothing exists", () => {
    expect(
      resolveBlender({
        platform: "linux",
        env: {},
        saved: null,
        probe: fakeFs([]),
      }),
    ).toEqual({ path: null, source: "none" });
  });

  it("expands ~ and maps a pasted Blender.app on macOS", () => {
    const s = resolveBlender({
      platform: "darwin",
      env: {},
      saved: "~/Apps/Blender.app",
      home: "/Users/u",
      probe: fakeFs(["/Users/u/Apps/Blender.app/Contents/MacOS/Blender"]),
    });
    expect(s.path).toBe("/Users/u/Apps/Blender.app/Contents/MacOS/Blender");
    expect(normalizeBlenderPath("/opt/Blender.app", "linux")).toBe(
      "/opt/Blender.app",
    );
  });
});

describe("resolveBlender per platform", () => {
  it("mac: ~/Applications when /Applications has none", () => {
    const user = "/Users/u/Applications/Blender.app/Contents/MacOS/Blender";
    const s = resolveBlender({
      platform: "darwin",
      env: { HOME: "/Users/u" },
      saved: null,
      probe: fakeFs([user]),
    });
    expect(s).toEqual({ path: user, source: "auto" });
  });

  it("windows: newest Blender Foundation version first", () => {
    const foundation = "C:\\Program Files\\Blender Foundation";
    const exe = (v: string) => `${foundation}\\Blender ${v}\\blender.exe`;
    const s = resolveBlender({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      saved: null,
      probe: fakeFs([exe("4.2"), exe("4.10")], {
        [foundation]: ["Blender 4.2", "Blender 4.10", "notes.txt"],
      }),
    });
    expect(s.path).toBe(exe("4.10"));
  });

  it("linux: PATH lookup", () => {
    const s = resolveBlender({
      platform: "linux",
      env: { PATH: "/opt/tools:/usr/games" },
      saved: null,
      probe: fakeFs(["/usr/games/blender"]),
    });
    expect(s).toEqual({ path: "/usr/games/blender", source: "auto" });
  });

  it("linux: snap before PATH, flatpak with a hint", () => {
    expect(
      resolveBlender({
        platform: "linux",
        env: { PATH: "/x" },
        saved: null,
        probe: fakeFs(["/snap/bin/blender", "/x/blender"]),
      }).path,
    ).toBe("/snap/bin/blender");
    const flat = resolveBlender({
      platform: "linux",
      env: { HOME: "/home/u" },
      saved: null,
      probe: fakeFs([
        "/home/u/.local/share/flatpak/exports/bin/org.blender.Blender",
      ]),
    });
    expect(flat.source).toBe("auto");
    expect(flat.hint).toMatch(/Flatpak/);
  });
});

describe("probeBlenderVersion", () => {
  const fakeExec = (stdout: string, err: Error | null = null) =>
    vi.fn<Parameters<ExecFileFn>, unknown>((_file, _args, _opts, cb) => {
      cb(err, stdout, "");
      return undefined;
    });

  it("runs --version via execFile with a timeout and parses it", async () => {
    const exec = fakeExec(
      "Color management: x\nBlender 4.2.3 LTS\n\tbuild date: …\n",
    );
    await expect(
      probeBlenderVersion("/b/blender", { execFile: exec, timeoutMs: 1234 }),
    ).resolves.toBe("4.2.3");
    expect(exec).toHaveBeenCalledWith(
      "/b/blender",
      ["--version"],
      expect.objectContaining({ timeout: 1234, windowsHide: true }),
      expect.any(Function),
    );
  });

  it("undefined on error, odd output, or a throwing exec", async () => {
    await expect(
      probeBlenderVersion("/b", {
        execFile: fakeExec("", new Error("ETIMEDOUT")),
      }),
    ).resolves.toBeUndefined();
    await expect(
      probeBlenderVersion("/b", { execFile: fakeExec("Python 3.11\n") }),
    ).resolves.toBeUndefined();
    const throwing: ExecFileFn = () => {
      throw new Error("EACCES");
    };
    await expect(
      probeBlenderVersion("/b", { execFile: throwing }),
    ).resolves.toBeUndefined();
  });

  it("detectBlender adds the version, and runs nothing when none is found", async () => {
    const exec = fakeExec("Blender 5.1.0\n");
    await expect(
      detectBlender({
        platform: "darwin",
        env: {},
        saved: null,
        probe: fakeFs([MAC_APP]),
        execFile: exec,
      }),
    ).resolves.toEqual({ path: MAC_APP, source: "auto", version: "5.1.0" });
    const none = vi.fn<Parameters<ExecFileFn>, unknown>();
    await expect(
      detectBlender({
        platform: "linux",
        env: {},
        saved: null,
        probe: fakeFs([]),
        execFile: none,
      }),
    ).resolves.toEqual({ path: null, source: "none" });
    expect(none).not.toHaveBeenCalled();
  });
});

describe("parseBlenderPathInput", () => {
  const probe = fakeFs(["/opt/blender-4.2/blender", "/bin/sh"]);

  it("empty or null clears", () => {
    expect(parseBlenderPathInput(null, { probe })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseBlenderPathInput("  ", { probe })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("accepts an existing Blender file", () => {
    expect(
      parseBlenderPathInput(" /opt/blender-4.2/blender ", {
        platform: "linux",
        probe,
      }),
    ).toEqual({ ok: true, value: "/opt/blender-4.2/blender" });
  });

  it.each([
    [42, /string/],
    ["blender", /full path/],
    ["/bin/sh", /isn't a Blender/],
    ["/nope/blender", /No file/],
    ["\\\\evil\\share\\blender.exe", /network share/],
    ["//evil/share/blender", /network share/],
  ])("rejects %s", (raw, msg) => {
    const r = parseBlenderPathInput(raw, { platform: "linux", probe });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe("blenderPath in runtime settings", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-blender-"));
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(tmp, "rs.json"));
    invalidateRuntimeSettingsCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/rateLimit");
    vi.doUnmock("@/lib/blender/detect");
    invalidateRuntimeSettingsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips and drops relative paths", () => {
    expect(readBlenderPathSetting()).toBeNull();
    writeBlenderPathSetting("~/bin/blender");
    expect(readBlenderPathSetting()).toBe("~/bin/blender");
    writeBlenderPathSetting(null);
    expect(readBlenderPathSetting()).toBeNull();
    expect(
      sanitizeRuntimeSettings({ blenderPath: "bin/blender" }).blenderPath,
    ).toBeUndefined();
  });

  it("the saved path feeds resolveBlender", () => {
    writeBlenderPathSetting("/saved/blender");
    expect(
      resolveBlender({
        platform: "linux",
        env: {},
        probe: fakeFs(["/saved/blender"]),
      }),
    ).toEqual({ path: "/saved/blender", source: "settings" });
  });

  describe("/api/settings/blender", () => {
    const URL_ = "http://127.0.0.1:3000/api/settings/blender";
    const req = (method: string, body?: unknown) =>
      new NextRequest(URL_, {
        method,
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    async function load() {
      vi.resetModules();
      vi.stubEnv("ADMIN_API_KEY", "");
      vi.stubEnv("SESSION_SECRET", "");
      vi.stubEnv("BLENDER_PATH", "");
      vi.doMock("@/lib/rateLimit", () => ({
        withRateLimit: () => ({ ok: true }),
      }));
      vi.doMock("@/lib/blender/detect", async (orig) => ({
        ...(await orig<typeof import("@/lib/blender/detect")>()),
        detectBlender: async () => ({ path: null, source: "none" }),
      }));
      return import("@/app/api/settings/blender/route");
    }

    it("GET reports status; PUT saves a real file, rejects others, clears", async () => {
      const exe = path.join(tmp, "blender");
      fs.writeFileSync(exe, "");
      const route = await load();
      expect(await (await route.GET(req("GET"))).json()).toEqual({
        ok: true,
        path: null,
        source: "none",
        saved: null,
        envPath: null,
      });
      const put = await route.PUT(req("PUT", { path: exe }));
      expect(put.status).toBe(200);
      expect((await put.json()).saved).toBe(exe);
      const bad = await route.PUT(
        req("PUT", { path: path.join(tmp, "nope", "blender") }),
      );
      expect(bad.status).toBe(400);
      const cleared = await route.PUT(req("PUT", { path: "" }));
      expect((await cleared.json()).saved).toBeNull();
    });

    it("refuses a cross-origin write", async () => {
      const route = await load();
      const res = await route.PUT(
        new NextRequest(URL_, {
          method: "PUT",
          headers: {
            host: "127.0.0.1:3000",
            origin: "http://evil.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ path: null }),
        }),
      );
      expect(res.status).toBe(403);
    });
  });
});

describe("Open in Blender button + Settings status line", () => {
  it("hidden off this computer or when the check failed", () => {
    expect(blenderOpenButton(null)).toEqual({ show: false });
    expect(blenderOpenButton({ available: false, reason: "remote" })).toEqual({
      show: false,
    });
  });

  it("disabled with the reason when Blender is missing", () => {
    expect(
      blenderOpenButton({ available: false, reason: "no-blender" }),
    ).toEqual({
      show: true,
      disabled: true,
      title: BLENDER_NOT_FOUND,
    });
    expect(BLENDER_NOT_FOUND).toMatch(/BLENDER_PATH/);
  });

  it("names the Blender it will start", () => {
    const b = blenderOpenButton({
      available: true,
      path: MAC_APP,
      version: "4.2.3",
    });
    expect(b).toMatchObject({ show: true, disabled: false });
    if (b.show) expect(b.title).toContain(`Blender 4.2.3 (${MAC_APP})`);
  });

  it("status line", () => {
    const base = { saved: null, envPath: null };
    expect(
      blenderStatusLine({
        ...base,
        path: MAC_APP,
        version: "4.2.3",
        source: "auto",
      }),
    ).toBe(`Blender 4.2.3 at ${MAC_APP} (auto-detected)`);
    expect(blenderStatusLine({ ...base, path: null, source: "none" })).toMatch(
      /not found/,
    );
  });
});
