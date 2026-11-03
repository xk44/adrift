// @vitest-environment node
/**
 * "Add Adrift to ComfyUI": /api/setup/overlay (status + install) and the pure
 * helpers behind it (pack install, CSP frame-ancestors).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  OVERLAY_PACK,
  inspectOverlayPack,
  installOverlayPack,
  overlayScriptsLoaded,
  remoteInstallSteps,
  normalizeAdriftUrl,
} from "@/lib/overlay/install";
import {
  buildFrameAncestors,
  frameAncestorsFromEnv,
  originAllowed,
} from "@/lib/overlay/frameAncestors";

let tmp: string;
let src: string;
let customNodes: string;

function makeSource(dir: string) {
  fs.mkdirSync(path.join(dir, "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "__init__.py"), "WEB_DIRECTORY = 'web'\n");
  fs.writeFileSync(path.join(dir, "web", "adrift_overlay.js"), "// bridge\n");
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cj-overlay-")));
  src = path.join(tmp, "src", OVERLAY_PACK);
  makeSource(src);
  customNodes = path.join(tmp, "ComfyUI", "custom_nodes");
  fs.mkdirSync(customNodes, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  vi.doUnmock("@/lib/comfy/comfyFetch");
  vi.doUnmock("@/lib/overlay/install");
});

describe("installOverlayPack", () => {
  const dest = () => path.join(customNodes, OVERLAY_PACK);

  it("links the pack and writes the Adrift URL", () => {
    expect(inspectOverlayPack(customNodes, src)).toBe("missing");
    const r = installOverlayPack({
      customNodesDir: customNodes,
      sourceDir: src,
      adriftUrl: "http://127.0.0.1:3000",
      platform: "darwin",
    });
    expect(r).toMatchObject({ ok: true, action: "linked", state: "linked" });
    expect(fs.lstatSync(dest()).isSymbolicLink()).toBe(true);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(src, "web", "adrift_config.json"), "utf8"),
    );
    expect(cfg).toEqual({ adriftUrl: "http://127.0.0.1:3000" });
  });

  it("is idempotent: a second install only refreshes the URL", () => {
    const opts = {
      customNodesDir: customNodes,
      sourceDir: src,
      platform: "darwin" as const,
    };
    installOverlayPack({ ...opts, adriftUrl: "http://localhost:3000" });
    const r = installOverlayPack({ ...opts, adriftUrl: "http://localhost:4000" });
    expect(r).toMatchObject({ ok: true, action: "updated", state: "linked" });
  });

  it("copies on Windows (no config from the source, fresh one written)", () => {
    fs.writeFileSync(
      path.join(src, "web", "adrift_config.json"),
      '{"adriftUrl":"http://old:1"}',
    );
    const r = installOverlayPack({
      customNodesDir: customNodes,
      sourceDir: src,
      adriftUrl: "http://localhost:3000",
      platform: "win32",
    });
    expect(r).toMatchObject({ ok: true, action: "copied", state: "copy" });
    expect(fs.lstatSync(dest()).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dest(), "web", "adrift_config.json"), "utf8"),
      ).adriftUrl,
    ).toBe("http://localhost:3000");
  });

  it("falls back to a copy when the link fails", () => {
    const r = installOverlayPack({
      customNodesDir: customNodes,
      sourceDir: src,
      adriftUrl: null,
      platform: "linux",
      symlink: () => {
        throw new Error("EPERM");
      },
    });
    expect(r).toMatchObject({ ok: true, action: "copied", state: "copy" });
  });

  it("never overwrites an unrelated folder", () => {
    fs.mkdirSync(dest());
    fs.writeFileSync(path.join(dest(), "mine.txt"), "keep");
    const r = installOverlayPack({
      customNodesDir: customNodes,
      sourceDir: src,
      adriftUrl: "http://localhost:3000",
      platform: "darwin",
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("other");
    expect(fs.readdirSync(dest())).toEqual(["mine.txt"]);
  });

  it("never replaces a foreign link", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    makeSource(elsewhere);
    fs.symlinkSync(elsewhere, dest(), "dir");
    const r = installOverlayPack({
      customNodesDir: customNodes,
      sourceDir: src,
      adriftUrl: "http://localhost:3000",
      platform: "darwin",
    });
    expect(r).toMatchObject({ ok: false, state: "other" });
    expect(fs.realpathSync(dest())).toBe(elsewhere);
    expect(fs.existsSync(path.join(elsewhere, "web", "adrift_config.json"))).toBe(
      false,
    );
  });

  it("reports a missing custom_nodes folder", () => {
    const r = installOverlayPack({
      customNodesDir: path.join(tmp, "nope"),
      sourceDir: src,
      adriftUrl: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/custom_nodes/);
  });
});

describe("overlay helpers", () => {
  it("finds the bridge in ComfyUI's /extensions list", () => {
    expect(
      overlayScriptsLoaded([
        "/extensions/core/a.js",
        "/extensions/adrift_overlay/adrift_overlay.js",
      ]),
    ).toEqual(["/extensions/adrift_overlay/adrift_overlay.js"]);
    expect(overlayScriptsLoaded(["/extensions/x/other.js"])).toEqual([]);
    expect(overlayScriptsLoaded({})).toEqual([]);
  });

  it("normalizes the Adrift URL to an http(s) origin", () => {
    expect(normalizeAdriftUrl("http://localhost:3000/settings")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeAdriftUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeAdriftUrl("")).toBeNull();
  });

  it("remote steps name the pack, the config file and the URL", () => {
    const s = remoteInstallSteps("http://adrift.local:3000");
    expect(s).toContain("custom_nodes/adrift_overlay/web/adrift_config.json");
    expect(s).toContain('"adriftUrl": "http://adrift.local:3000"');
    expect(s).toMatch(/Restart ComfyUI/);
  });

  it("frame-ancestors include the configured ComfyUI and its loopback twin", () => {
    const list = buildFrameAncestors({
      comfyUrls: ["http://127.0.0.1:8190/", "https://comfy.example.com/x"],
      extra: "https://extra.example.com",
    });
    expect(list).toContain("'self'");
    expect(list).toContain("http://localhost:8188");
    expect(list).toContain("http://localhost:8190");
    expect(list).toContain("http://127.0.0.1:8190");
    expect(list).toContain("https://comfy.example.com");
    expect(list).toContain("https://extra.example.com");
    expect(originAllowed(list, "https://comfy.example.com")).toBe(true);
    expect(originAllowed(list, "https://evil.example.com")).toBe(false);
  });

  it("frame-ancestors read saved settings; env URL replaces the saved main", () => {
    const file = path.join(tmp, "rs.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        comfy: { httpUrl: "http://saved.example.com:8188" },
        comfyInstances: [{ httpUrl: "http://second.example.com:8188" }],
      }),
    );
    const saved = frameAncestorsFromEnv(
      { ADRIFT_RUNTIME_SETTINGS_FILE: file } as unknown as NodeJS.ProcessEnv,
      tmp,
    );
    expect(saved).toContain("http://saved.example.com:8188");
    expect(saved).toContain("http://second.example.com:8188");
    const pinned = frameAncestorsFromEnv(
      {
        ADRIFT_RUNTIME_SETTINGS_FILE: file,
        COMFY_HTTP_URL: "http://pinned.example.com:8188",
      } as unknown as NodeJS.ProcessEnv,
      tmp,
    );
    expect(pinned).toContain("http://pinned.example.com:8188");
    expect(pinned).not.toContain("http://saved.example.com:8188");
    expect(pinned).toContain("http://second.example.com:8188");
  });
});

const LOCAL = "http://127.0.0.1:3000";

function req(method: string, headers: Record<string, string> = {}) {
  const url = `${LOCAL}/api/setup/overlay`;
  return new NextRequest(url, {
    method,
    headers: { host: new URL(url).host, ...headers },
  });
}

async function loadRoute(opts: {
  key?: string;
  comfyUrl?: string;
  extensions?: unknown;
}) {
  vi.resetModules();
  vi.stubEnv("ADMIN_API_KEY", opts.key ?? "");
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("COMFY_ROOT", path.join(tmp, "ComfyUI"));
  vi.stubEnv("COMFY_HTTP_URL", opts.comfyUrl ?? "http://127.0.0.1:8188");
  vi.stubEnv(
    "ADRIFT_RUNTIME_SETTINGS_FILE",
    path.join(tmp, "runtime_settings.json"),
  );
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  const comfyFetch = vi.fn(async () =>
    opts.extensions === undefined
      ? (() => {
          throw new Error("ECONNREFUSED");
        })()
      : new Response(JSON.stringify(opts.extensions), { status: 200 }),
  );
  vi.doMock("@/lib/comfy/comfyFetch", () => ({
    comfyFetch,
    comfyBaseUrl: () => (opts.comfyUrl ?? "http://127.0.0.1:8188"),
  }));
  const actual = await vi.importActual<typeof import("@/lib/overlay/install")>(
    "@/lib/overlay/install",
  );
  vi.doMock("@/lib/overlay/install", () => ({
    ...actual,
    overlaySourceDir: () => src,
  }));
  const route = await import("@/app/api/setup/overlay/route");
  return { route, comfyFetch };
}

describe("/api/setup/overlay", () => {
  const SAME = { origin: LOCAL };

  it("GET: local ComfyUI, not installed, ComfyUI unreachable", async () => {
    const { route } = await loadRoute({});
    const res = await route.GET(req("GET", SAME));
    expect(res.status).toBe(200);
    const { status } = await res.json();
    expect(status).toMatchObject({
      comfyLocal: true,
      customNodes: true,
      installed: "missing",
      loaded: null,
      adriftUrl: LOCAL,
      frameAllowed: true,
    });
    expect(status.customNodesDir).toBe(customNodes);
  });

  it("POST installs, then GET sees it linked and loaded", async () => {
    const { route } = await loadRoute({
      extensions: ["/extensions/adrift_overlay/adrift_overlay.js"],
    });
    const res = await route.POST(req("POST", SAME));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({ ok: true, state: "linked" });
    expect(body.status).toMatchObject({
      installed: "linked",
      configUrl: LOCAL,
      loaded: true,
    });
  });

  it("GET: installed but ComfyUI not restarted yet -> loaded false", async () => {
    const { route } = await loadRoute({ extensions: ["/extensions/core/x.js"] });
    await route.POST(req("POST", SAME));
    const { status } = await (await route.GET(req("GET", SAME))).json();
    expect(status.installed).toBe("linked");
    expect(status.loaded).toBe(false);
  });

  it("POST never overwrites an existing folder (409)", async () => {
    fs.mkdirSync(path.join(customNodes, OVERLAY_PACK));
    fs.writeFileSync(path.join(customNodes, OVERLAY_PACK, "keep.txt"), "x");
    const { route } = await loadRoute({});
    const res = await route.POST(req("POST", SAME));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status.installed).toBe("other");
    expect(body.error).toMatch(/Move it aside/);
    expect(fs.readdirSync(path.join(customNodes, OVERLAY_PACK))).toEqual([
      "keep.txt",
    ]);
  });

  it("remote ComfyUI: GET gives steps, POST refuses without touching disk", async () => {
    const { route } = await loadRoute({ comfyUrl: "http://gpu.example.com:8188" });
    const { status } = await (await route.GET(req("GET", SAME))).json();
    expect(status.comfyLocal).toBe(false);
    expect(status.customNodesDir).toBeNull();
    expect(status.installed).toBeNull();
    expect(status.remoteSteps).toContain(`"adriftUrl": "${LOCAL}"`);
    const res = await route.POST(req("POST", SAME));
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(customNodes, OVERLAY_PACK))).toBe(false);
  });

  it("with ADMIN_API_KEY: no key, no access", async () => {
    const { route } = await loadRoute({ key: "k-123" });
    expect((await route.GET(req("GET", SAME))).status).toBe(401);
    expect((await route.POST(req("POST", SAME))).status).toBe(401);
    expect(fs.existsSync(path.join(customNodes, OVERLAY_PACK))).toBe(false);
  });
});
