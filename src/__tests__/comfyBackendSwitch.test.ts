/**
 * Switching the ComfyUI URL (wizard / Settings) must show the new backend's
 * nodes and models right away: server caches are keyed by base URL and
 * dropped on every connection write; browser caches clear on the change
 * signal. fetch is stubbed (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const A = "http://192.0.2.10:8188";
const B = "http://192.0.2.20:8188";
const LOCAL = "http://127.0.0.1:3000";
const CONN = `${LOCAL}/api/settings/comfy-connection`;

let dir: string;
let file: string;
/** What each fake ComfyUI answers; mutate to simulate new installs. */
let backends: Record<string, { ckpts: string[] }>;
let calls: string[];

function objectInfo(ckpts: string[]) {
  return {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [ckpts] } } },
  };
}

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  calls.push(url);
  const base = Object.keys(backends).find((b) => url.startsWith(b));
  if (!base) return Promise.reject(new TypeError("offline"));
  const b = backends[base];
  if (url.endsWith("/object_info"))
    return Promise.resolve(Response.json(objectInfo(b.ckpts)));
  if (url.includes("/view_metadata/loras"))
    return Promise.resolve(
      Response.json({ ss_base_model_version: `from ${base}` }),
    );
  return Promise.resolve(new Response("nope", { status: 404 }));
}

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: {
      host: new URL(url).host,
      origin: LOCAL,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function load() {
  vi.resetModules();
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", file);
  vi.stubEnv("ADMIN_API_KEY", "");
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("COMFY_HTTP_URL", "");
  vi.stubEnv("COMFY_BEARER", "");
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  const conn = await import("@/app/api/settings/comfy-connection/route");
  const oic = await import("@/lib/comfy/objectInfoCache");
  return { conn, oic };
}

async function connect(
  conn: Awaited<ReturnType<typeof load>>["conn"],
  url: string,
) {
  const res = await conn.PUT(req("PUT", CONN, { url, mode: "lan" }));
  expect(res.status).toBe(200);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-switch-"));
  file = path.join(dir, "runtime_settings.json");
  backends = {
    [A]: { ckpts: ["a.safetensors"] },
    [B]: { ckpts: ["b.safetensors"] },
  };
  calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("server caches follow the ComfyUI URL", () => {
  it("object_info: switching A -> B serves B's nodes on the next call", async () => {
    const { conn, oic } = await load();
    await connect(conn, A);
    const a = await oic.getObjectInfoCached();
    expect(JSON.stringify(a)).toContain("a.safetensors");
    await connect(conn, B);
    const b = await oic.getObjectInfoCached();
    expect(JSON.stringify(b)).toContain("b.safetensors");
    expect(JSON.stringify(b)).not.toContain("a.safetensors");
  });

  it("object_info: switching back to A within the TTL refetches (save invalidates)", async () => {
    const { conn, oic } = await load();
    await connect(conn, A);
    await oic.getObjectInfoCached();
    await connect(conn, B);
    await oic.getObjectInfoCached();
    backends[A].ckpts = ["a.safetensors", "a2-new.safetensors"];
    await connect(conn, A);
    const again = await oic.getObjectInfoCached();
    expect(JSON.stringify(again)).toContain("a2-new.safetensors");
  });

  it("forgetting the connection (DELETE) also drops the caches", async () => {
    const { conn, oic } = await load();
    await connect(conn, A);
    await oic.getObjectInfoCached();
    const n = calls.filter((c) => c.endsWith("/object_info")).length;
    const del = await conn.DELETE(req("DELETE", CONN));
    expect(del.status).toBe(200);
    // Back on the default URL (unreachable here): nothing stale from A.
    expect(await oic.getObjectInfoCached()).toBeNull();
    expect(calls.filter((c) => c.endsWith("/object_info")).length).toBe(n + 1);
  });

  it("checkpoint list is keyed by URL (even without the route's invalidation)", async () => {
    const { conn } = await load();
    const http = await import("@/lib/comfy/http");
    await connect(conn, A);
    expect(await http.fetchAvailableCheckpoints()).toEqual(["a.safetensors"]);
    // Point Adrift at B through the env (no PUT, so nothing was cleared).
    vi.stubEnv("COMFY_HTTP_URL", B);
    expect(await http.fetchAvailableCheckpoints()).toEqual(["b.safetensors"]);
  });

  it("LoRA metadata cache is keyed by URL", async () => {
    const { conn } = await load();
    const route = await import("@/app/api/comfy/lora-metadata/route");
    const get = () =>
      route.GET(
        new NextRequest(
          `${LOCAL}/api/comfy/lora-metadata?filename=x.safetensors`,
          {
            headers: { host: "127.0.0.1:3000" },
          },
        ),
      );
    await connect(conn, A);
    const first = await (await get()).json();
    expect(JSON.stringify(first)).toContain(A);
    await connect(conn, B);
    const second = await (await get()).json();
    expect(second.cached).toBe(false);
    expect(JSON.stringify(second)).toContain(B);
  });

  it("invalidateComfyBackendCaches clears object_info for the same URL", async () => {
    const { conn, oic } = await load();
    await connect(conn, A);
    await oic.getObjectInfoCached();
    backends[A].ckpts = ["fresh.safetensors"];
    expect(JSON.stringify(await oic.getObjectInfoCached())).not.toContain(
      "fresh",
    );
    const { invalidateComfyBackendCaches } =
      await import("@/lib/comfy/backendCaches");
    invalidateComfyBackendCaches();
    expect(JSON.stringify(await oic.getObjectInfoCached())).toContain("fresh");
  });
});

describe("browser backend-change signal", () => {
  it("backendKey changes with URL or token, not with a trailing slash", async () => {
    const { backendKey } = await import("@/lib/comfy/backendChange");
    expect(backendKey(null)).toBeNull();
    expect(backendKey({ httpUrl: `${A}/`, hasToken: false })).toBe(
      backendKey({ httpUrl: A, hasToken: false }),
    );
    expect(backendKey({ httpUrl: A, hasToken: false })).not.toBe(
      backendKey({ httpUrl: B, hasToken: false }),
    );
    expect(backendKey({ httpUrl: A, hasToken: false })).not.toBe(
      backendKey({ httpUrl: A, hasToken: true }),
    );
  });

  it("notify runs every registered clearer, survives a throwing one, and unsubscribes", async () => {
    vi.resetModules();
    const m = await import("@/lib/comfy/backendChange");
    const cache = new Map([["k", 1]]);
    const off = m.onComfyBackendChange(() => cache.clear());
    m.onComfyBackendChange(() => {
      throw new Error("boom");
    });
    const later = vi.fn();
    m.onComfyBackendChange(later);
    m.notifyComfyBackendChanged();
    expect(cache.size).toBe(0);
    expect(later).toHaveBeenCalledTimes(1);
    off();
    cache.set("k", 2);
    m.notifyComfyBackendChanged();
    expect(cache.size).toBe(1);
  });

  it("getBackendProfile refetches after clearBackendProfile", async () => {
    vi.resetModules();
    const bp = await import("@/lib/models/backendProfile");
    const stats = (name: string) => ({
      system: { os: "linux", ram_total: 64 * 1024 ** 3 },
      devices: [
        { name: `cuda:0 ${name}`, type: "cuda", vram_total: 24 * 1024 ** 3 },
      ],
    });
    let gpu = "GPU A";
    const f = vi.fn(async () => Response.json(stats(gpu)));
    const p1 = await bp.getBackendProfile({
      fetchImpl: f as unknown as typeof fetch,
    });
    gpu = "GPU B";
    const cached = await bp.getBackendProfile({
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(cached).toBe(p1);
    bp.clearBackendProfile();
    const p2 = await bp.getBackendProfile({
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(p2?.displayName).toContain("GPU B");
  });
});
