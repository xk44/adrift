/**
 * Multiple ComfyUI machines: saved-settings model + migration, env parity
 * with the old two-host setup, routing (role filter, least busy, unreachable
 * skip, pinning), per-machine marker subfolders, per-machine tokens, the
 * /api/settings/comfy-instances routes and the cross-machine exclusive mode.
 * No network: every ComfyUI call is mocked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import {
  _resetBackendStateForTests,
  backendForSubfolder,
  backendUrlForSubfolder,
  candidateBackendUrls,
  exclusiveBackendsEnabled,
  exclusiveBackendsSource,
  hasMultipleBackends,
  listBackends,
  otherBackendUrls,
  otherGroupUrls,
  pickBackend,
  preferredVideoBackendUrl,
  rememberPromptBackend,
  routeBackend,
  routeBackendUrl,
  routeCandidates,
  stageInputsForBackend,
  stagingSubfolder,
  tagOutputsForBackend,
  type QueueCounts,
} from "@/lib/comfy/backends";
import { withComfyAuth } from "@/lib/comfy/comfyFetch";
import {
  invalidateRuntimeSettingsCache,
  readRuntimeSettings,
  sanitizeRuntimeSettings,
  writeComfyInstances,
  type ComfyInstanceSetting,
} from "@/lib/runtimeSettings";
import { validateInstancesPut } from "@/lib/comfy/instancesSettings";
import type { Workflow } from "@/types";

const MAIN = "http://mac:8188";
const PC = "http://pc:8288";
const A = "http://10.0.0.21:8188";
const B = "http://10.0.0.22:8188";
const WARM = "http://127.0.0.1:8189";

const ENV_KEYS = [
  "COMFY_VIDEO_HTTP_URL",
  "COMFY_VIDEO_ACTIONS",
  "COMFY_VIDEO_PACKS",
  "COMFY_EXCLUSIVE_BACKENDS",
  "COMFY_VIDEO_OUTPUT_SUBFOLDER",
  "CJ_H3_WARM_URL",
  "COMFY_BEARER",
  "COMFY_HTTP_URL",
  "ADRIFT_RUNTIME_SETTINGS_FILE",
];
const savedEnv: Record<string, string | undefined> = {};
let dir: string;
let file: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-instances-"));
  file = path.join(dir, "runtime_settings.json");
  process.env.ADRIFT_RUNTIME_SETTINGS_FILE = file;
  invalidateRuntimeSettingsCache();
  _resetBackendStateForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  invalidateRuntimeSettingsCache();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

function inst(
  id: string,
  httpUrl: string,
  extra: Partial<ComfyInstanceSetting> = {},
): ComfyInstanceSetting {
  return { id, name: id, httpUrl, role: "all", enabled: true, ...extra };
}

function saveDoc(doc: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...doc }));
  invalidateRuntimeSettingsCache();
}

const q = (running: number, pending = 0): QueueCounts => ({
  running,
  pending,
});

function queueDeps(map: Record<string, QueueCounts | null>) {
  const fetchQueue = vi.fn(async (u: string) => map[u] ?? null);
  return { fetchQueue };
}

// ------------------------------------------------------------ settings model

describe("runtime settings: comfyInstances", () => {
  it("sanitizes: bad ids/urls/roles dropped, reserved ids refused, dupes dropped, capped", () => {
    const raw = {
      version: 1,
      comfy: { httpUrl: MAIN, mode: "lan" },
      comfyInstances: [
        inst("pc", PC),
        inst("pc", A), // duplicate id
        inst("dupe-url", PC), // duplicate url
        inst("same-as-main", MAIN), // the main connection's url
        inst("main", A), // reserved
        inst("video", A), // reserved
        inst("Bad_ID", A),
        { ...inst("badrole", A), role: "gpu" },
        inst("badurl", "ftp://x"),
        ...Array.from({ length: 10 }, (_, i) =>
          inst(`m${i}`, `http://10.0.1.${i + 1}:8188`),
        ),
      ],
      comfyMain: { name: "Studio", role: "image" },
      comfyExclusive: true,
    };
    const s = sanitizeRuntimeSettings(raw);
    const ids = s.comfyInstances!.map((i) => i.id);
    expect(ids[0]).toBe("pc");
    expect(ids).not.toContain("main");
    expect(ids).not.toContain("video");
    expect(ids).not.toContain("Bad_ID");
    // An unknown role on disk degrades to "all" (read side is lenient).
    expect(s.comfyInstances!.find((i) => i.id === "badrole")?.role).toBe("all");
    expect(ids).not.toContain("badurl");
    expect(ids).not.toContain("dupe-url");
    expect(ids).not.toContain("same-as-main");
    expect(ids.length).toBe(7); // 8 machines in total incl. main
    expect(ids).not.toContain("m6"); // the overflow is cut
    expect(s.comfyMain).toEqual({ name: "Studio", role: "image" });
    expect(s.comfyExclusive).toBe(true);
  });

  it("migration: an existing single connection is machine 'main' with role all, file untouched", () => {
    saveDoc({ comfy: { httpUrl: "http://10.0.0.9:8188", mode: "lan" } });
    const before = fs.readFileSync(file, "utf8");
    const b = listBackends();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      id: "default",
      settingsId: "main",
      role: "all",
      enabled: true,
      primary: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("writeComfyInstances: undefined leaves, empty/null deletes", () => {
    writeComfyInstances({
      instances: [inst("pc", PC)],
      main: { name: "Mac" },
      exclusive: false,
    });
    invalidateRuntimeSettingsCache();
    expect(readRuntimeSettings()).toMatchObject({
      comfyInstances: [{ id: "pc" }],
      comfyMain: { name: "Mac" },
      comfyExclusive: false,
    });
    writeComfyInstances({ exclusive: null });
    invalidateRuntimeSettingsCache();
    expect(readRuntimeSettings().comfyInstances).toHaveLength(1);
    expect(readRuntimeSettings().comfyExclusive).toBeUndefined();
    writeComfyInstances({ instances: [], main: null });
    invalidateRuntimeSettingsCache();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(doc).sort()).toEqual(["version"]);
  });
});

// ------------------------------------------------------------ env parity

describe("env parity (no saved machines)", () => {
  it("single host: one backend, everything default, no probe", async () => {
    const deps = queueDeps({});
    expect(listBackends().map((b) => b.id)).toEqual(["default"]);
    expect(hasMultipleBackends()).toBe(false);
    expect(routeBackend({ packId: "minimax" })).toBe("default");
    expect(routeBackendUrl({ action: "animate" })).toBeUndefined();
    expect((await pickBackend({ packId: "h3" }, deps)).id).toBe("default");
    expect(deps.fetchQueue).not.toHaveBeenCalled();
    expect(otherBackendUrls()).toEqual([]);
    expect(candidateBackendUrls()).toEqual([MAIN, WARM]);
    expect(stagingSubfolder("default")).toBe("adrift-xfer");
    expect(exclusiveBackendsEnabled()).toBe(false);
  });

  it("env two-host: ids, marker, routing and exclusive exactly as before; no probe", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = `${PC}/`;
    const deps = queueDeps({});
    const b = listBackends();
    expect(b.map((x) => [x.id, x.url, x.role, x.marker])).toEqual([
      ["default", MAIN, "all", undefined],
      ["video", PC, "video", "adrift-video"],
    ]);
    expect(routeBackend({ packId: "minimax" })).toBe("video");
    expect(routeBackend({ packId: "h3" })).toBe("default");
    expect(routeBackendUrl({ packId: "minimax" })).toBe(PC);
    expect((await pickBackend({ packId: "minimax" }, deps)).id).toBe("video");
    expect((await pickBackend({ packId: "h3" }, deps)).id).toBe("default");
    expect(deps.fetchQueue).not.toHaveBeenCalled();
    expect(preferredVideoBackendUrl()).toBe(PC);
    expect(backendForSubfolder("adrift-video/clips")).toBe("video");
    expect(stagingSubfolder("video")).toBe("adrift-video/xfer");
    expect(exclusiveBackendsEnabled()).toBe(true);
    expect(exclusiveBackendsSource()).toBe("default");
    expect(otherGroupUrls(PC)).toEqual([MAIN, WARM]);
    expect(otherGroupUrls(MAIN)).toEqual([PC]);
  });

  it("an empty settings file and no settings file behave the same", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const snap = () =>
      JSON.stringify([
        listBackends(),
        candidateBackendUrls(),
        exclusiveBackendsEnabled(),
        otherGroupUrls(PC),
      ]);
    const withFile = (saveDoc({}), snap());
    delete process.env.ADRIFT_RUNTIME_SETTINGS_FILE;
    invalidateRuntimeSettingsCache();
    expect(snap()).toBe(withFile);
  });
});

// ------------------------------------------------------------ routing

describe("routing across saved machines", () => {
  it("role filter: video jobs -> role video, else role all; images -> image/all", () => {
    saveDoc({
      comfyInstances: [
        inst("img", A, { role: "image" }),
        inst("vid", B, { role: "video" }),
      ],
    });
    expect(routeCandidates({ packId: "minimax" }).map((b) => b.id)).toEqual([
      "vid",
    ]);
    expect(routeCandidates({ packId: "h3" }).map((b) => b.id)).toEqual([
      "default",
      "img",
    ]);
    expect(routeCandidates({ action: "transition" }).map((b) => b.id)).toEqual([
      "vid",
    ]);
    // No video machine: role "all" ones take video.
    saveDoc({ comfyInstances: [inst("img", A, { role: "image" })] });
    expect(routeCandidates({ packId: "minimax" }).map((b) => b.id)).toEqual([
      "default",
    ]);
  });

  it("disabled machines are never routed to but stay viewable/pollable", () => {
    saveDoc({
      comfyInstances: [inst("vid", B, { role: "video", enabled: false })],
    });
    expect(routeBackend({ packId: "minimax" })).toBe("default");
    expect(otherBackendUrls()).toEqual([B]);
    expect(candidateBackendUrls()).toContain(B);
    expect(backendUrlForSubfolder("adrift-vid/x")).toBe(B);
  });

  it("main can be restricted: role image sends video to the others", () => {
    saveDoc({
      comfyMain: { role: "image" },
      comfyInstances: [inst("pc", A)],
    });
    expect(routeBackend({ packId: "minimax" })).toBe("pc");
    expect(routeCandidates({ packId: "h3" }).map((b) => b.id)).toEqual([
      "default",
      "pc",
    ]);
  });

  it("nothing qualifies -> main", () => {
    saveDoc({
      comfyMain: { role: "video" },
      comfyInstances: [inst("v2", A, { role: "video" })],
    });
    expect(routeCandidates({ packId: "h3" }).map((b) => b.id)).toEqual([
      "default",
    ]);
  });

  it("least busy wins; ties keep list order; unreachable skipped; all down -> first", async () => {
    saveDoc({ comfyInstances: [inst("a", A), inst("b", B)] });
    const job = { packId: "h3" };
    expect(
      (
        await pickBackend(
          job,
          queueDeps({ [MAIN]: q(2), [A]: q(0, 1), [B]: q(0) }),
        )
      ).id,
    ).toBe("b");
    expect(
      (
        await pickBackend(
          job,
          queueDeps({ [MAIN]: q(1), [A]: q(1), [B]: q(1) }),
        )
      ).id,
    ).toBe("default");
    expect(
      (
        await pickBackend(
          job,
          queueDeps({ [MAIN]: null, [A]: q(3), [B]: null }),
        )
      ).id,
    ).toBe("a");
    expect((await pickBackend(job, queueDeps({}))).id).toBe("default");
  });

  it("pinning: a remembered prompt is looked up on its machine first", () => {
    saveDoc({ comfyInstances: [inst("a", A), inst("b", B)] });
    expect(candidateBackendUrls()).toEqual([MAIN, WARM, A, B]);
    rememberPromptBackend("p1", `${B}/`);
    expect(candidateBackendUrls("p1")).toEqual([B, MAIN, WARM, A]);
  });

  it("env video host and saved machines coexist (env first, deduped by url)", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    saveDoc({ comfyInstances: [inst("a", A), inst("dupe", PC)] });
    expect(listBackends().map((b) => b.id)).toEqual(["default", "video", "a"]);
    expect(routeBackend({ packId: "minimax" })).toBe("video");
  });
});

// ------------------------------------------------------------ markers

describe("per-machine marker subfolders", () => {
  const graph = (): Workflow =>
    ({
      "1": { class_type: "SaveImage", inputs: { filename_prefix: "Adrift" } },
      "2": { class_type: "KSampler", inputs: { seed: 1 } },
    }) as unknown as Workflow;

  it("tags non-main outputs with adrift-<id>, main stays unprefixed", () => {
    saveDoc({ comfyInstances: [inst("pc", A)] });
    const g = graph();
    expect(tagOutputsForBackend(g, "default")).toBe(0);
    expect(g["1"].inputs.filename_prefix).toBe("Adrift");
    expect(tagOutputsForBackend(g, "pc")).toBe(1);
    expect(g["1"].inputs.filename_prefix).toBe("adrift-pc/Adrift");
    expect(tagOutputsForBackend(g, "pc")).toBe(0); // idempotent
  });

  it("/view routing by first subfolder segment", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    saveDoc({ comfyInstances: [inst("a", A), inst("b", B)] });
    expect(backendForSubfolder("adrift-a")).toBe("a");
    expect(backendForSubfolder("adrift-b/deep/er")).toBe("b");
    expect(backendForSubfolder("adrift-video")).toBe("video");
    expect(backendForSubfolder("adrift-c")).toBe("default");
    expect(backendForSubfolder("x/adrift-a")).toBe("default");
    expect(backendForSubfolder(undefined)).toBe("default");
    expect(backendUrlForSubfolder("adrift-b")).toBe(B);
    expect(stagingSubfolder("a")).toBe("adrift-a/xfer");
  });

  it("cross-machine input copy: other machine's file is staged onto the target", async () => {
    saveDoc({ comfyInstances: [inst("a", A), inst("b", B)] });
    const wf = {
      "1": {
        class_type: "LoadImage",
        inputs: { image: "adrift-a/pic.png [output]" },
      },
      "2": { class_type: "LoadImage", inputs: { image: "local.png [input]" } },
    } as unknown as Workflow;
    const download = vi.fn(async (_base: string, _ref: unknown) => new Uint8Array([1]));
    const upload = vi.fn(
      async (_base: string, _d: unknown, name: string, sub: string) =>
        `${sub}/${name} [input]`,
    );
    const n = await stageInputsForBackend(wf, "b", { download, upload });
    expect(n).toBe(2); // the main machine's input also has to move
    expect(download.mock.calls.map((c) => c[0])).toEqual([A, MAIN]);
    expect(upload.mock.calls.every((c) => c[0] === B)).toBe(true);
    expect(wf["1"].inputs.image).toBe(
      "adrift-b/xfer/output__adrift-a__pic.png [input]",
    );
  });
});

// ------------------------------------------------------------ tokens

describe("per-machine tokens", () => {
  const auth = (base?: string) =>
    new Headers(withComfyAuth({}, base).headers).get("authorization");

  it("a saved machine uses its own token only; main + env video use the main one", () => {
    process.env.COMFY_BEARER = "main-tok";
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    saveDoc({
      comfyInstances: [inst("a", A, { authToken: "a-tok" }), inst("b", B)],
    });
    expect(auth(MAIN)).toBe("Bearer main-tok");
    expect(auth(PC)).toBe("Bearer main-tok");
    expect(auth(`${A}/`)).toBe("Bearer a-tok");
    expect(auth(B)).toBeNull(); // never leaks the main token
    expect(auth()).toBe("Bearer main-tok");
  });
});

// ------------------------------------------------------------ PUT validation

describe("validateInstancesPut", () => {
  const ok = (
    body: Record<string, unknown>,
    cur: ComfyInstanceSetting[] = [],
  ) => {
    const r = validateInstancesPut(body, cur, [MAIN]);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const err = (
    body: Record<string, unknown>,
    cur: ComfyInstanceSetting[] = [],
  ) => {
    const r = validateInstancesPut(body, cur, [MAIN]);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("normalizes urls, generates ids, defaults role/enabled", () => {
    const r = ok({ instances: [{ name: " PC ", url: "10.0.0.21" }] });
    const [i] = r.update.instances!;
    expect(i).toMatchObject({
      name: "PC",
      httpUrl: A,
      role: "all",
      enabled: true,
    });
    expect(i.id).toMatch(/^m-[0-9a-f]{6}$/);
  });

  it("rejects bad urls, duplicates, reserved/invalid ids, bad roles, cap", () => {
    expect(err({ instances: [{ url: "ftp://x" }] })).toMatch(/Machine 2/);
    expect(err({ instances: [{ url: "javascript:alert(1)" }] })).toBeTruthy();
    expect(err({ instances: [{ url: MAIN }] })).toMatch(/already/);
    expect(err({ instances: [{ url: A }, { url: `${A}/` }] })).toMatch(
      /already/,
    );
    expect(err({ instances: [{ id: "main", url: A }] })).toMatch(/invalid id/);
    expect(err({ instances: [{ id: "video", url: A }] })).toMatch(/invalid id/);
    expect(
      err({
        instances: [
          { id: "x", url: A },
          { id: "x", url: B },
        ],
      }),
    ).toMatch(/duplicate/);
    expect(err({ instances: [{ url: A, role: "gpu" }] })).toMatch(/role/);
    expect(err({ instances: [{ url: A, enabled: "yes" }] })).toMatch(/enabled/);
    expect(err({ instances: [{ url: A, token: "a b" }] })).toBeTruthy();
    expect(err({ instances: "nope" })).toMatch(/list/);
    expect(
      err({
        instances: Array.from({ length: 8 }, (_, n) => ({
          url: `http://10.0.2.${n + 1}:8188`,
        })),
      }),
    ).toMatch(/At most 8/);
    expect(err({ exclusive: "yes" })).toMatch(/exclusive/);
    expect(err({ main: { role: "gpu" } })).toMatch(/role/);
  });

  it("keeps a saved token only for the same id at the same url", () => {
    const cur = [inst("pc", A, { authToken: "s3cret" })];
    expect(
      ok({ instances: [{ id: "pc", url: A }] }, cur).update.instances![0]
        .authToken,
    ).toBe("s3cret");
    expect(
      ok({ instances: [{ id: "pc", url: B }] }, cur).update.instances![0]
        .authToken,
    ).toBeUndefined();
    expect(
      ok({ instances: [{ id: "other", url: A }] }, cur).update.instances![0]
        .authToken,
    ).toBeUndefined();
    expect(
      ok({ instances: [{ id: "pc", url: A, clearToken: true }] }, cur).update
        .instances![0].authToken,
    ).toBeUndefined();
    expect(
      ok({ instances: [{ id: "pc", url: A, token: "new" }] }, cur).update
        .instances![0].authToken,
    ).toBe("new");
  });

  it("main defaults collapse to null", () => {
    expect(ok({ main: { name: "", role: "all" } }).update.main).toBeNull();
    expect(ok({ main: { name: "Mac", role: "video" } }).update.main).toEqual({
      name: "Mac",
      role: "video",
    });
  });
});

// ------------------------------------------------------------ exclusive

describe("exclusive mode across N machines", () => {
  it("precedence: env > saved > implicit (env video host)", () => {
    saveDoc({ comfyInstances: [inst("a", A)] });
    expect(exclusiveBackendsEnabled()).toBe(false);
    saveDoc({ comfyInstances: [inst("a", A)], comfyExclusive: true });
    expect(exclusiveBackendsEnabled()).toBe(true);
    expect(exclusiveBackendsSource()).toBe("saved");
    process.env.COMFY_EXCLUSIVE_BACKENDS = "0";
    expect(exclusiveBackendsEnabled()).toBe(false);
    expect(exclusiveBackendsSource()).toBe("env");
    delete process.env.COMFY_EXCLUSIVE_BACKENDS;
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    saveDoc({ comfyInstances: [inst("a", A)], comfyExclusive: false });
    expect(exclusiveBackendsEnabled()).toBe(false);
  });

  it("needs two enabled machines", () => {
    saveDoc({
      comfyInstances: [inst("a", A, { enabled: false })],
      comfyExclusive: true,
    });
    expect(exclusiveBackendsEnabled()).toBe(false);
  });

  it("otherGroupUrls covers every other enabled machine (main + warm as one)", () => {
    saveDoc({
      comfyInstances: [
        inst("a", A),
        inst("b", B),
        inst("off", "http://10.0.0.30:8188", { enabled: false }),
      ],
    });
    expect(otherGroupUrls(A)).toEqual([MAIN, WARM, B]);
    expect(otherGroupUrls(MAIN)).toEqual([A, B]);
    expect(otherGroupUrls(WARM)).toEqual([A, B]);
  });
});

// ------------------------------------------------------------ API routes

const LOCAL = "http://127.0.0.1:3000";
const SAME = { origin: LOCAL, "content-type": "application/json" };
const API = `${LOCAL}/api/settings/comfy-instances`;

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

const STATS = {
  system: { os: "linux", ram_total: 64e9, comfyui_version: "0.42.0" },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
      type: "cuda",
      index: 0,
      vram_total: 25503596544,
      vram_free: 2e10,
    },
  ],
};

async function loadRoutes(
  fetchImpl: (
    u: string,
    init?: RequestInit,
  ) => Promise<Response> = async () => {
    throw new TypeError("offline");
  },
) {
  vi.resetModules();
  process.env.ADMIN_API_KEY = "";
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  const main = await import("@/app/api/settings/comfy-instances/route");
  const test = await import("@/app/api/settings/comfy-instances/test/route");
  const rs = await import("@/lib/runtimeSettings");
  rs.invalidateRuntimeSettingsCache();
  return { main, test, fetchMock };
}

describe("/api/settings/comfy-instances", () => {
  it("PUT saves, GET lists; tokens never come back", async () => {
    const { main } = await loadRoutes();
    const put = await main.PUT(
      req("PUT", API, SAME, {
        main: { name: "Mac" },
        instances: [
          {
            name: "PC",
            url: "10.0.0.21",
            role: "video",
            token: "tok-SECRET-1",
          },
        ],
        exclusive: true,
      }),
    );
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(putText).not.toContain("tok-SECRET-1");
    const putBody = JSON.parse(putText);
    expect(putBody.instances.map((i: { name: string }) => i.name)).toEqual([
      "Mac",
      "PC",
    ]);
    expect(putBody.instances[1]).toMatchObject({
      url: A,
      role: "video",
      hasToken: true,
      editable: true,
    });
    expect(putBody.exclusive).toMatchObject({ enabled: true, source: "saved" });
    expect(fs.readFileSync(file, "utf8")).toContain("tok-SECRET-1");

    const get = await main.GET(req("GET", API));
    const getText = await get.text();
    expect(getText).not.toContain("tok-SECRET-1");
    expect(JSON.parse(getText).instances).toHaveLength(2);

    // Re-saving the list without a token keeps it (same id + url).
    const id = putBody.instances[1].id;
    await main.PUT(
      req("PUT", API, SAME, {
        instances: [{ id, name: "PC", url: A, role: "all", enabled: true }],
      }),
    );
    expect(
      JSON.parse(fs.readFileSync(file, "utf8")).comfyInstances[0],
    ).toMatchObject({
      id,
      role: "all",
      authToken: "tok-SECRET-1",
    });
  });

  it("PUT rejects cross-site writes and bad bodies", async () => {
    const { main } = await loadRoutes();
    const evil = await main.PUT(
      req(
        "PUT",
        API,
        { origin: "http://evil.example", "content-type": "application/json" },
        { instances: [] },
      ),
    );
    expect(evil.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(file)).toBe(false);
    const bad = await main.PUT(
      req("PUT", API, SAME, { instances: [{ url: "ftp://x" }] }),
    );
    expect(bad.status).toBe(400);
    const arr = await main.PUT(req("PUT", API, SAME, [1]));
    expect(arr.status).toBe(400);
  });

  it("POST /test reports version + GPU + queue and reuses a saved token by id", async () => {
    saveDoc({ comfyInstances: [inst("pc", A, { authToken: "pc-tok" })] });
    const { test, fetchMock } = await loadRoutes(async (u) => {
      if (u.endsWith("/system_stats"))
        return new Response(JSON.stringify(STATS), { status: 200 });
      if (u.endsWith("/queue"))
        return new Response(
          JSON.stringify({ queue_running: [1], queue_pending: [1, 2] }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    });
    const res = await test.POST(
      req("POST", `${API}/test`, SAME, { url: A, id: "pc" }),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({
      reachable: true,
      comfyuiVersion: "0.42.0",
      queue: { running: 1, pending: 2 },
    });
    expect(body.result.gpuName).toMatch(/4090/);
    expect(body.result.memoryGb).toBeGreaterThan(20);
    expect(JSON.stringify(body)).not.toContain("pc-tok");
    const headers = fetchMock.mock.calls.map((c) =>
      new Headers((c[1] as RequestInit | undefined)?.headers).get(
        "authorization",
      ),
    );
    expect(headers.every((h) => h === "Bearer pc-tok")).toBe(true);

    // A different url with that id does not get the saved token.
    fetchMock.mockClear();
    await test.POST(req("POST", `${API}/test`, SAME, { url: B, id: "pc" }));
    expect(
      fetchMock.mock.calls.every(
        (c) =>
          !new Headers((c[1] as RequestInit | undefined)?.headers).has(
            "authorization",
          ),
      ),
    ).toBe(true);
  });

  it("POST /test: unreachable and invalid urls", async () => {
    const { test } = await loadRoutes();
    const down = await (
      await test.POST(req("POST", `${API}/test`, SAME, { url: A }))
    ).json();
    expect(down.result.reachable).toBe(false);
    const bad = await test.POST(
      req("POST", `${API}/test`, SAME, { url: "file:///etc/passwd" }),
    );
    expect(bad.status).toBe(400);
  });
});
