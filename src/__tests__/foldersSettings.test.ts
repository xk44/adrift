/**
 * Folders (setup wizard + Settings): resolver precedence, the folder check,
 * the save rules and the /api/settings/dirs routes' auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  invalidateRuntimeSettingsCache,
  isValidDirSetting,
  readRuntimeSettings,
  writeDirs,
} from "@/lib/runtimeSettings";
import {
  adriftDataDir,
  adriftDataPath,
  comfyInputDir,
  comfyIsLocalMachine,
  comfyModelsDir,
  comfyModelsPath,
  comfyOutputDir,
  expandHome,
  resolveDirs,
  resolvedComfyRoot,
  tildePath,
} from "@/lib/paths/resolveDirs";
import { checkDir, isSystemPath, parseDirInput } from "@/lib/paths/validateDir";
import { saveDirs } from "@/lib/paths/dirsStatus";

const ENV_KEYS = [
  "COMFY_ROOT",
  "COMFY_MODELS_DIR",
  "COMFY_INPUT_DIR",
  "COMFYUI_OUTPUT_DIR",
  "ADRIFT_DATA_DIR",
  "COMFY_HTTP_URL",
];

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-dirs-"));
  file = path.join(tmp, "runtime_settings.json");
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
  invalidateRuntimeSettingsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/rateLimit");
  invalidateRuntimeSettingsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeComfy(
  dir: string,
  opts: { main?: boolean; models?: boolean } = {},
) {
  fs.mkdirSync(dir, { recursive: true });
  if (opts.main !== false) fs.writeFileSync(path.join(dir, "main.py"), "");
  if (opts.models !== false) fs.mkdirSync(path.join(dir, "models"));
}

describe("resolveDirs precedence", () => {
  it("defaults: ../ComfyUI and <cwd>/data, subfolders follow the root", () => {
    const root = path.join(process.cwd(), "../ComfyUI");
    expect(resolvedComfyRoot()).toBe(root);
    expect(comfyModelsDir()).toBe(path.join(root, "models"));
    expect(comfyInputDir()).toBe(path.join(root, "input"));
    expect(comfyOutputDir()).toBe(path.join(root, "output"));
    expect(adriftDataDir()).toBe(path.join(process.cwd(), "data"));
    const all = resolveDirs();
    for (const r of Object.values(all)) expect(r.source).toBe("default");
  });

  it("saved values apply; models/input/output follow a saved root", () => {
    const root = path.join(tmp, "comfy");
    writeDirs({ comfyRoot: root, data: path.join(tmp, "lib") });
    expect(resolvedComfyRoot()).toBe(root);
    expect(comfyModelsDir()).toBe(path.join(root, "models"));
    expect(comfyOutputDir(root)).toBe(path.join(root, "output"));
    expect(adriftDataPath("adrift.db")).toBe(
      path.join(tmp, "lib", "adrift.db"),
    );
    expect(resolveDirs().comfyRoot.source).toBe("saved");
    expect(resolveDirs().models.source).toBe("default");
  });

  it("env wins over saved for every folder", () => {
    writeDirs({
      comfyRoot: path.join(tmp, "saved-comfy"),
      models: path.join(tmp, "saved-models"),
      data: path.join(tmp, "saved-data"),
    });
    vi.stubEnv("COMFY_ROOT", path.join(tmp, "env-comfy"));
    vi.stubEnv("COMFY_MODELS_DIR", path.join(tmp, "env-models"));
    vi.stubEnv("ADRIFT_DATA_DIR", path.join(tmp, "env-data"));
    expect(resolvedComfyRoot()).toBe(path.join(tmp, "env-comfy"));
    expect(comfyModelsDir()).toBe(path.join(tmp, "env-models"));
    expect(adriftDataDir()).toBe(path.join(tmp, "env-data"));
    const all = resolveDirs();
    expect(all.comfyRoot).toMatchObject({
      source: "env",
      saved: path.join(tmp, "saved-comfy"),
    });
    expect(all.models.source).toBe("env");
    expect(all.data.source).toBe("env");
  });

  it("a folder override only applies to the root in use", () => {
    const root = path.join(tmp, "comfy");
    writeDirs({ comfyRoot: root, models: path.join(tmp, "big-disk") });
    expect(comfyModelsDir(root)).toBe(path.join(tmp, "big-disk"));
    expect(comfyModelsPath(root, "loras")).toBe(
      path.join(tmp, "big-disk", "loras"),
    );
    // Another install (tests, a second ComfyUI) keeps its own models/.
    const other = path.join(tmp, "other");
    expect(comfyModelsDir(other)).toBe(path.join(other, "models"));
  });

  it("~ expands to the home folder; tildePath round-trips", () => {
    vi.stubEnv("COMFY_ROOT", "~/ComfyUI");
    expect(resolvedComfyRoot()).toBe(path.join(os.homedir(), "ComfyUI"));
    expect(expandHome("~/x", "/home/ana")).toBe("/home/ana/x");
    expect(expandHome("~", "/home/ana")).toBe("/home/ana");
    expect(tildePath("/home/ana/ComfyUI", "/home/ana")).toBe("~/ComfyUI");
    expect(tildePath("/home/anabel/x", "/home/ana")).toBe("/home/anabel/x");
    expect(tildePath("/srv/comfy", "/home/ana")).toBe("/srv/comfy");
  });

  it("comfyIsLocalMachine follows the ComfyUI address", () => {
    expect(comfyIsLocalMachine()).toBe(true);
    vi.stubEnv("COMFY_HTTP_URL", "http://192.168.1.40:8188");
    expect(comfyIsLocalMachine()).toBe(false);
    vi.stubEnv("COMFY_HTTP_URL", "http://[::1]:8188");
    expect(comfyIsLocalMachine()).toBe(true);
  });
});

describe("runtime settings `dirs`", () => {
  it("writeDirs sets, clears and keeps other keys", () => {
    writeDirs({ comfyRoot: "~/ComfyUI", data: "/srv/adrift" });
    writeDirs({ data: null });
    expect(readRuntimeSettings().dirs).toEqual({ comfyRoot: "~/ComfyUI" });
    writeDirs({ comfyRoot: null });
    expect(readRuntimeSettings().dirs).toBeUndefined();
  });

  it("drops invalid values when reading", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        dirs: {
          comfyRoot: "relative/path",
          models: "/ok",
          data: "bad\u0000",
          nope: "/x",
        },
      }),
    );
    invalidateRuntimeSettingsCache();
    expect(readRuntimeSettings().dirs).toEqual({ models: "/ok" });
  });

  it("isValidDirSetting", () => {
    for (const v of ["~", "~/a", "/a", "C:\\ComfyUI", "\\\\nas\\share"])
      expect(isValidDirSetting(v), v).toBe(true);
    for (const v of [
      "",
      "a/b",
      "./x",
      3,
      null,
      "/a\nb",
      "/" + "x".repeat(2000),
    ])
      expect(isValidDirSetting(v), String(v)).toBe(false);
  });
});

describe("validateDir", () => {
  it("refuses system folders", () => {
    for (const p of [
      "/",
      "/System",
      "/etc",
      "/etc/x",
      "/usr",
      "/usr/bin",
      "/bin",
      "/dev",
      "C:\\",
      "C:\\Windows",
      "c:\\windows\\system32",
      "C:\\Program Files\\x",
    ])
      expect(isSystemPath(p), p).toBe(true);
    for (const p of [
      "/usr/local/comfy",
      "/srv/comfy",
      "/home/ana",
      "D:\\ComfyUI",
      "/Users/ana/etc",
    ])
      expect(isSystemPath(p), p).toBe(false);
    expect(parseDirInput("/etc").ok).toBe(false);
    expect(parseDirInput("relative").ok).toBe(false);
  });

  it("Windows paths only for a remote ComfyUI's folders on a posix host", () => {
    if (path.sep !== "/") return;
    expect(parseDirInput("D:\\ComfyUI").ok).toBe(false);
    expect(parseDirInput("D:\\ComfyUI", undefined, true)).toMatchObject({
      ok: true,
      display: "D:\\ComfyUI",
    });
  });

  it("ComfyUI folder: ok, missing main.py, missing models, missing", () => {
    const root = path.join(tmp, "ComfyUI");
    makeComfy(root);
    expect(checkDir("comfyRoot", root, { comfyLocal: true })).toMatchObject({
      status: "ok",
      exists: true,
    });
    fs.rmSync(path.join(root, "main.py"));
    expect(checkDir("comfyRoot", root, { comfyLocal: true })).toMatchObject({
      status: "warn",
      reason: expect.stringMatching(/main\.py/),
    });
    const bare = path.join(tmp, "bare");
    makeComfy(bare, { models: false });
    expect(checkDir("comfyRoot", bare, { comfyLocal: true }).reason).toMatch(
      /models/,
    );
    expect(
      checkDir("comfyRoot", path.join(tmp, "nope"), { comfyLocal: true }),
    ).toMatchObject({
      status: "error",
      canCreate: false,
    });
  });

  it("notes extra_model_paths.yaml", () => {
    const root = path.join(tmp, "ComfyUI");
    makeComfy(root);
    fs.writeFileSync(path.join(root, "extra_model_paths.yaml"), "a: b\n");
    expect(checkDir("comfyRoot", root, { comfyLocal: true }).notes[0]).toMatch(
      /extra_model_paths\.yaml/,
    );
  });

  it("missing folder warns and is only created on request", () => {
    const out = path.join(tmp, "renders", "out");
    const c = checkDir("output", out, { comfyLocal: true });
    expect(c).toMatchObject({ status: "warn", canCreate: true, exists: false });
    expect(fs.existsSync(out)).toBe(false);
    const made = checkDir("output", out, { comfyLocal: true, create: true });
    expect(made).toMatchObject({ status: "ok", created: true, exists: true });
    expect(fs.statSync(out).isDirectory()).toBe(true);
  });

  it("a file is not a folder", () => {
    const f = path.join(tmp, "file.txt");
    fs.writeFileSync(f, "x");
    expect(checkDir("data", f, { comfyLocal: true })).toMatchObject({
      status: "error",
      reason: expect.stringMatching(/file/),
    });
  });

  it("~ paths expand against home and display with ~", () => {
    fs.mkdirSync(path.join(tmp, "lib"));
    expect(
      checkDir("data", "~/lib", { comfyLocal: true, home: tmp }),
    ).toMatchObject({
      status: "ok",
      display: "~/lib",
    });
  });

  it("remote ComfyUI: its folders are not checked or created; data still is", () => {
    const where = path.join(tmp, "remote-out");
    const c = checkDir("output", where, { comfyLocal: false, create: true });
    expect(c).toMatchObject({ status: "remote", canCreate: false });
    expect(c.reason).toMatch(/not checked/);
    expect(fs.existsSync(where)).toBe(false);
    expect(
      checkDir("data", path.join(tmp, "nope"), { comfyLocal: false }).status,
    ).toBe("warn");
  });

  it("never lists folder contents", () => {
    const spy = vi.spyOn(fs, "readdirSync");
    const root = path.join(tmp, "ComfyUI");
    makeComfy(root);
    checkDir("comfyRoot", root, { comfyLocal: true });
    checkDir("models", path.join(root, "models"), { comfyLocal: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("saveDirs", () => {
  it("stores custom values, null for the default, follows a new root", () => {
    const root = path.join(tmp, "comfy");
    const r = saveDirs({
      comfyRoot: root,
      models: path.join(root, "models"), // the default for that root
      output: path.join(tmp, "renders"),
      data: path.join(process.cwd(), "data"), // the default
    });
    expect(r).toEqual({ ok: true });
    expect(readRuntimeSettings().dirs).toEqual({
      comfyRoot: tildePath(root),
      output: tildePath(path.join(tmp, "renders")),
    });
  });

  it("env-set folders refuse with 409; bad input 400; unknown keys 400", () => {
    vi.stubEnv("ADRIFT_DATA_DIR", path.join(tmp, "env-data"));
    expect(saveDirs({ data: path.join(tmp, "x") })).toMatchObject({
      ok: false,
      status: 409,
      key: "data",
    });
    expect(saveDirs({ models: "/etc" })).toMatchObject({
      status: 400,
      key: "models",
    });
    expect(saveDirs({ models: "relative" })).toMatchObject({ status: 400 });
    expect(saveDirs({ downloads: "/srv/x" })).toMatchObject({ status: 400 });
    expect(saveDirs(["x"])).toMatchObject({ status: 400 });
  });

  it("null / empty clears a saved folder", () => {
    writeDirs({ output: "/srv/renders" });
    expect(saveDirs({ output: null })).toEqual({ ok: true });
    expect(readRuntimeSettings().dirs).toBeUndefined();
  });
});

// ── Routes ───────────────────────────────────────────────────────────────
const LOCAL = "http://127.0.0.1:3000";

function req(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return new NextRequest(url, {
    method,
    headers: { host: new URL(url).host, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loadRoutes(opts: { key?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("ADMIN_API_KEY", opts.key ?? "");
  vi.stubEnv("SESSION_SECRET", "");
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  const main = await import("@/app/api/settings/dirs/route");
  const check = await import("@/app/api/settings/dirs/check/route");
  return { main, check };
}

describe("/api/settings/dirs", () => {
  const SAME = { origin: LOCAL, "content-type": "application/json" };

  it("GET lists every folder in ~ form with source and check", async () => {
    const { main } = await loadRoutes();
    const res = await main.GET(req("GET", `${LOCAL}/api/settings/dirs`));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.comfyLocal).toBe(true);
    expect(j.dirs.map((d: { key: string }) => d.key)).toEqual([
      "comfyRoot",
      "models",
      "input",
      "output",
      "data",
    ]);
    const home = os.homedir();
    for (const d of j.dirs) {
      expect(d.display.startsWith(home + path.sep)).toBe(false);
      expect(d).toHaveProperty("check.status");
    }
  });

  it("PUT saves from loopback same-origin; refuses cross-origin and remote hosts", async () => {
    const { main } = await loadRoutes();
    const root = path.join(tmp, "comfy");
    makeComfy(root);
    const ok = await main.PUT(
      req("PUT", `${LOCAL}/api/settings/dirs`, SAME, {
        dirs: { comfyRoot: root },
      }),
    );
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.dirs[0]).toMatchObject({ key: "comfyRoot", source: "saved" });
    expect(j.dirs[0].check.status).toBe("ok");

    const evil = await main.PUT(
      req(
        "PUT",
        `${LOCAL}/api/settings/dirs`,
        { ...SAME, origin: "http://evil.test" },
        { dirs: { comfyRoot: null } },
      ),
    );
    expect(evil.status).toBe(403);
    const lan = await main.PUT(
      req(
        "PUT",
        "http://192.168.1.5:3000/api/settings/dirs",
        { "content-type": "application/json" },
        { dirs: { comfyRoot: null } },
      ),
    );
    expect(lan.status).toBeGreaterThanOrEqual(401);
    expect(readRuntimeSettings().dirs?.comfyRoot).toBe(tildePath(root));
  });

  it("PUT answers 409 for an env-set folder", async () => {
    vi.stubEnv("COMFY_ROOT", path.join(tmp, "env-comfy"));
    const { main } = await loadRoutes();
    const res = await main.PUT(
      req("PUT", `${LOCAL}/api/settings/dirs`, SAME, {
        dirs: { comfyRoot: path.join(tmp, "x") },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/COMFY_ROOT/);
  });

  it("with ADMIN_API_KEY: no key, no access", async () => {
    const { main, check } = await loadRoutes({ key: "k-123" });
    expect(
      (await main.GET(req("GET", `${LOCAL}/api/settings/dirs`))).status,
    ).toBe(401);
    const c = await check.POST(
      req("POST", `${LOCAL}/api/settings/dirs/check`, SAME, {
        key: "data",
        path: tmp,
      }),
    );
    expect(c.status).toBe(401);
  });

  it("check: validates, creates only on request, rejects unknown keys", async () => {
    const { check } = await loadRoutes();
    const where = path.join(tmp, "lib");
    const a = await check.POST(
      req("POST", `${LOCAL}/api/settings/dirs/check`, SAME, {
        key: "data",
        path: where,
      }),
    );
    expect((await a.json()).check).toMatchObject({
      status: "warn",
      canCreate: true,
    });
    expect(fs.existsSync(where)).toBe(false);
    const b = await check.POST(
      req("POST", `${LOCAL}/api/settings/dirs/check`, SAME, {
        key: "data",
        path: where,
        create: true,
      }),
    );
    expect((await b.json()).check).toMatchObject({
      status: "ok",
      created: true,
    });
    const sys = await check.POST(
      req("POST", `${LOCAL}/api/settings/dirs/check`, SAME, {
        key: "data",
        path: "/etc",
        create: true,
      }),
    );
    expect((await sys.json()).check.status).toBe("error");
    const bad = await check.POST(
      req("POST", `${LOCAL}/api/settings/dirs/check`, SAME, {
        key: "downloads",
        path: where,
      }),
    );
    expect(bad.status).toBe(400);
    const cross = await check.POST(
      req(
        "POST",
        `${LOCAL}/api/settings/dirs/check`,
        { ...SAME, origin: "http://evil.test" },
        { key: "data", path: where },
      ),
    );
    expect(cross.status).toBe(403);
  });
});
