/**
 * POST /api/vault/library/index folder rule, other library writes, the
 * style-mix flag, and Train's fallback when the service is unreachable.
 * Uses temp dirs only. Nothing is spawned and no job can start.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    tmp: nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "vault-index-")),
    ),
  };
});

vi.mock("@/lib/env", () => ({
  env: {
    STYLEVAULT_API_URL: "http://127.0.0.1:8000",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    COMFY_ROOT: `${h.tmp}/comfy`,
    NODE_ENV: "test",
  },
}));
vi.mock("@/lib/features", () => ({ STYLE_CODES_ENABLED: false }));
vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as typeof import("node:child_process");
  const spawn = vi.fn(() => {
    throw new Error("spawn must not run in this test");
  });
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const root = path.join(h.tmp, "datasets");
const inside = path.join(root, "set-a");
const outside = path.join(h.tmp, "elsewhere");
const output = path.join(h.tmp, "comfy", "output");

function call(method: string, segments: string[], body?: unknown) {
  return import("@/app/api/vault/[...path]/route").then((m) => {
    const req = new NextRequest(
      `http://localhost:3000/api/vault/${segments.join("/")}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: typeof body === "string" ? body : JSON.stringify(body),
            }),
      },
    );
    const params = { params: Promise.resolve({ path: segments }) };
    const handler = m[method as "GET" | "POST"];
    return handler(req, params);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchSpy: any;
const savedRoots = process.env.CJ_VAULT_DATASET_ROOTS;

beforeEach(() => {
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  process.env.CJ_VAULT_DATASET_ROOTS = root;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ job: "j1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.CJ_VAULT_DATASET_ROOTS = savedRoots;
});

afterAll(() => {
  fs.rmSync(h.tmp, { recursive: true, force: true });
});

function forwardedFolder(): string {
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)).folder;
}

describe("POST library/index", () => {
  it("forwards a folder under CJ_VAULT_DATASET_ROOTS", async () => {
    const res = await call("POST", ["library", "index"], { folder: inside });
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toContain("/library/index");
    expect(forwardedFolder()).toBe(inside);
  });

  it("source comfy-output resolves to the output folder", async () => {
    const res = await call("POST", ["library", "index"], {
      source: "comfy-output",
    });
    expect(res.status).toBe(200);
    expect(forwardedFolder()).toBe(output);
  });

  it("allows the output folder by path, but not folders beside it", async () => {
    expect(
      (await call("POST", ["library", "index"], { folder: output })).status,
    ).toBe(200);
    fetchSpy.mockClear();
    const res = await call("POST", ["library", "index"], {
      folder: path.join(h.tmp, "comfy"),
    });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a folder outside the roots", async () => {
    const res = await call("POST", ["library", "index"], { folder: outside });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("CJ_VAULT_DATASET_ROOTS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses .. traversal out of a root", async () => {
    const res = await call("POST", ["library", "index"], {
      folder: `${root}/../elsewhere`,
    });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a symlink that leads out of a root", async () => {
    const link = path.join(root, "escape");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(outside, link);
    const res = await call("POST", ["library", "index"], { folder: link });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a sibling sharing the root's prefix", async () => {
    const sibling = `${root}-other`;
    fs.mkdirSync(sibling, { recursive: true });
    const res = await call("POST", ["library", "index"], { folder: sibling });
    expect(res.status).toBe(400);
  });

  it("refuses relative, missing and non-JSON input", async () => {
    for (const body of [
      { folder: "set-a" },
      { folder: path.join(root, "missing") },
      {},
      "not json",
    ]) {
      const res = await call("POST", ["library", "index"], body);
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only the folder, not other fields", async () => {
    await call("POST", ["library", "index"], { folder: inside, extra: "x" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ folder: inside });
  });

  it("reads index status through GET", async () => {
    const res = await call("GET", ["library", "index", "status"]);
    expect(res.status).toBe(200);
  });
});

describe("other writes", () => {
  it("refuses every other POST under library", async () => {
    const res = await call("POST", ["library", "export-by-tag"], {});
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses styles/mix with style codes off", async () => {
    const res = await call("POST", ["styles", "mix"], {});
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Train with the service unreachable", () => {
  beforeEach(() => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
  });

  it("lists backends and jobs from the local trainer", async () => {
    const backends = await call("GET", ["training", "backends"]);
    expect(backends.status).toBe(200);
    const names = (await backends.json()).backends.map(
      (b: { name: string }) => b.name,
    );
    expect(names).toEqual(["musubi-tuner", "ai-toolkit"]);
    const jobs = await call("GET", ["training", "jobs"]);
    expect(jobs.status).toBe(200);
    expect(Array.isArray(await jobs.json())).toBe(true);
  });

  it("explains that cluster training and auto-caption need the service", async () => {
    const cluster = await call("POST", ["training", "jobs"], {
      run_name: "x",
      dataset: { cluster_id: 1 },
      params: {},
    });
    expect(cluster.status).toBe(409);
    expect((await cluster.json()).error).toContain("library service");
    const caption = await call("POST", ["training", "jobs"], {
      run_name: "x",
      dataset: { images_dir: inside },
      params: { auto_caption: true },
    });
    expect(caption.status).toBe(409);
    expect((await caption.json()).error).toContain("library service");
  });

  it("other paths still report the service as unreachable", async () => {
    const res = await call("GET", ["umap", "runs"]);
    expect(res.status).toBe(502);
  });
});

