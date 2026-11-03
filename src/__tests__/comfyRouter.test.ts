/**
 * Per-job machine routing (src/lib/comfy/router.ts): capability filter,
 * scoring, pins, legacy passthrough and notSent-only failover. No network:
 * health / object_info / queuePrompt are injected.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://main.test:8188", COMFY_ROOT: "/nonexistent" },
}));

import {
  applyJobBackend,
  checkCapability,
  countModelFiles,
  fp8DiffusionWeights,
  pinKeys,
  planRoute,
  queuePromptRouted,
  rankInstances,
  type InstanceHealth,
  type RouterDeps,
} from "@/lib/comfy/router";
import { sanitizeComfyRouting } from "@/lib/comfy/routingSettings";
import { ComfyAPIError, isConnectFailure } from "@/lib/comfy/http";
import { _resetBackendStateForTests, listBackends } from "@/lib/comfy/backends";
import { writeComfyInstances, writeComfyRouting } from "@/lib/runtimeSettings";
import type { MemorySnapshot } from "@/lib/comfy/memory";
import type { ComfyQueueResult, Workflow } from "@/types";

const MAIN = "http://main.test:8188";
const PC = "http://pc.test:8188";
const MAC = "http://mac.test:8188";

let dir = "";
const savedSettingsFile = process.env.ADRIFT_RUNTIME_SETTINGS_FILE;
const ENV_KEYS = [
  "COMFY_VIDEO_HTTP_URL",
  "CJ_H3_WARM_URL",
  "COMFY_EXCLUSIVE_BACKENDS",
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-router-"));
});
afterAll(() => {
  if (savedSettingsFile === undefined)
    delete process.env.ADRIFT_RUNTIME_SETTINGS_FILE;
  else process.env.ADRIFT_RUNTIME_SETTINGS_FILE = savedSettingsFile;
});
let n = 0;
beforeEach(() => {
  process.env.ADRIFT_RUNTIME_SETTINGS_FILE = path.join(dir, `s${n++}.json`);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  _resetBackendStateForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function twoMachines(
  extra: {
    auto?: boolean;
    pins?: Record<string, string>;
    priorities?: Record<string, number>;
  } = {},
) {
  writeComfyInstances({
    instances: [
      { id: "pc", name: "PC", httpUrl: PC, role: "all", enabled: true },
      { id: "mac", name: "Mac", httpUrl: MAC, role: "all", enabled: true },
    ],
  });
  writeComfyRouting(sanitizeComfyRouting(extra));
}

// object_info fixtures

const cuda: MemorySnapshot = {
  deviceType: "cuda",
  deviceName: "GPU",
  unified: false,
  capacityGb: 24,
  freeGb: 20,
  ramTotalGb: 64,
  ramFreeGb: 40,
};
const mps: MemorySnapshot = {
  deviceType: "mps",
  unified: true,
  capacityGb: 96,
  freeGb: 80,
  ramTotalGb: 128,
  ramFreeGb: 100,
};

function info(
  unets: string[],
  extraNodes: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    UNETLoader: {
      input: {
        required: {
          unet_name: [unets],
          weight_dtype: [["default", "fp8_e4m3fn"]],
        },
      },
      output: ["MODEL"],
    },
    SaveImage: {
      input: {
        required: { images: ["IMAGE"], filename_prefix: ["STRING", {}] },
      },
      output: [],
    },
  };
  for (const n of extraNodes)
    out[n] = { input: { required: {} }, output: ["IMAGE"] };
  return out;
}

const graph = (unet: string, extra?: string): Workflow =>
  ({
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: unet, weight_dtype: "default" },
    },
    ...(extra ? { "2": { class_type: extra, inputs: {} } } : {}),
  }) as unknown as Workflow;

const health = (over: Partial<InstanceHealth> = {}): InstanceHealth => ({
  reachable: true,
  queue: { running: 0, pending: 0 },
  device: cuda,
  checkedAt: 0,
  ...over,
});

describe("sanitizeComfyRouting", () => {
  it("keeps valid keys, drops junk and zero priorities", () => {
    expect(
      sanitizeComfyRouting({
        auto: true,
        pins: { upscale: "pc", "Bad Key": "pc", vary: "../x" },
        priorities: { pc: 3, mac: 0, main: 99, video: 1.5 },
      }),
    ).toEqual({ auto: true, pins: { upscale: "pc" }, priorities: { pc: 3 } });
    expect(sanitizeComfyRouting({ pins: {} })).toBeNull();
    expect(sanitizeComfyRouting("nope")).toBeNull();
  });
});

describe("isConnectFailure", () => {
  it("detects refused / unknown host through cause and AggregateError", () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    });
    expect(isConnectFailure(refused)).toBe(true);
    const agg = Object.assign(new Error("x"), {
      errors: [{ code: "ECONNREFUSED" }, { code: "EHOSTUNREACH" }],
    });
    expect(
      isConnectFailure(new TypeError("fetch failed", { cause: agg })),
    ).toBe(true);
  });
  it("treats resets / timeouts as possibly-sent", () => {
    expect(
      isConnectFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })),
    ).toBe(false);
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    expect(isConnectFailure(timeout)).toBe(false);
    const mixed = Object.assign(new Error("x"), {
      errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }],
    });
    expect(isConnectFailure(mixed)).toBe(false);
  });
});

describe("checkCapability", () => {
  it("passes when every node and file exists", () => {
    const r = checkCapability(
      graph("flux_bf16.safetensors"),
      info(["flux_bf16.safetensors"]),
      cuda,
    );
    expect(r).toMatchObject({
      ok: true,
      missingNodes: [],
      missingModels: [],
      deviceIssues: [],
    });
  });
  it("reports missing nodes and missing model files", () => {
    const r = checkCapability(
      graph("other.safetensors", "FancyNode"),
      info(["flux_bf16.safetensors"]),
      cuda,
    );
    expect(r.ok).toBe(false);
    expect(r.missingNodes).toEqual(["FancyNode"]);
    expect(r.missingModels).toEqual(["other.safetensors"]);
  });
  it("counts an installed precision sibling as available", () => {
    const r = checkCapability(
      graph("flux_bf16.safetensors"),
      info(["flux_fp8_scaled.safetensors"]),
      cuda,
    );
    expect(r.ok).toBe(true);
  });
  it("MPS: fp8 diffusion weights are a device issue unless a non-fp8 sibling exists", () => {
    const fp8Only = checkCapability(
      graph("flux_bf16.safetensors"),
      info(["flux_fp8_scaled.safetensors"]),
      mps,
    );
    expect(fp8Only.ok).toBe(false);
    expect(fp8Only.deviceIssues[0]).toMatch(/fp8.*MPS/);
    const asked = checkCapability(
      graph("flux_fp8_scaled.safetensors"),
      info(["flux_fp8_scaled.safetensors", "flux_bf16.safetensors"]),
      mps,
    );
    expect(asked.ok).toBe(false);
    const sibling = checkCapability(
      graph("flux_fp16.safetensors"),
      info(["flux_fp8_scaled.safetensors", "flux_bf16.safetensors"]),
      mps,
    );
    expect(sibling.ok).toBe(true);
    // CUDA loads fp8 fine.
    expect(
      checkCapability(
        graph("flux_fp8_scaled.safetensors"),
        info(["flux_fp8_scaled.safetensors"]),
        cuda,
      ).ok,
    ).toBe(true);
  });
  it("memory: discrete GPU may offload to RAM (penalty), beyond that excluded", () => {
    const g = graph("flux_bf16.safetensors");
    const i = info(["flux_bf16.safetensors"]);
    expect(checkCapability(g, i, cuda, { memoryGb: 20 }).penalty).toBe(0);
    expect(checkCapability(g, i, cuda, { memoryGb: 40 })).toMatchObject({
      ok: true,
      penalty: 2,
    });
    expect(checkCapability(g, i, cuda, { memoryGb: 100 }).ok).toBe(false);
    expect(checkCapability(g, i, mps, { memoryGb: 100 }).ok).toBe(false);
  });
  it("fp8DiffusionWeights ignores gguf and text encoders", () => {
    expect(
      fp8DiffusionWeights({
        a: {
          class_type: "UnetLoaderGGUF",
          inputs: { unet_name: "x_fp8.gguf" },
        },
        b: {
          class_type: "CLIPLoader",
          inputs: { clip_name: "t5_fp8_e4m3fn.safetensors" },
        },
        c: {
          class_type: "UNETLoader",
          inputs: { unet_name: "m.safetensors", weight_dtype: "fp8_e4m3fn" },
        },
      } as unknown as Workflow),
    ).toEqual(["m.safetensors (fp8_e4m3fn)"]);
  });
  it("countModelFiles counts distinct loader files", () => {
    expect(countModelFiles(info(["a.safetensors", "b.gguf"]))).toBe(2);
  });
});

function deps(
  infos: Record<string, Record<string, unknown> | null>,
  healths: Record<string, InstanceHealth>,
  queue?: RouterDeps["queue"],
): Partial<RouterDeps> {
  return {
    objectInfo: vi.fn(async (url: string) => infos[url] ?? null),
    health: vi.fn(
      async (url: string) => healths[url] ?? health({ reachable: false }),
    ),
    ...(queue ? { queue } : {}),
    log: () => {},
  };
}

describe("rankInstances", () => {
  it("orders by priority minus queue, excludes offline and incapable", async () => {
    twoMachines({ priorities: { mac: 2 } });
    const ok = info(["flux_bf16.safetensors"]);
    const ranked = await rankInstances(
      graph("flux_bf16.safetensors"),
      listBackends(),
      { priorities: { mac: 2 } },
      {
        deps: deps(
          { [MAIN]: ok, [PC]: ok, [MAC]: info([]) },
          {
            [MAIN]: health({ queue: { running: 1, pending: 0 } }),
            [PC]: health({ queue: { running: 0, pending: 0 } }),
            [MAC]: health({ device: mps }),
          },
        ),
      },
    );
    expect(
      ranked.map((r) => [r.instance.settingsId, r.score, r.excluded ?? null]),
    ).toEqual([
      ["pc", 0, null],
      ["main", -1, null],
      ["mac", 2, "missing files: flux_bf16.safetensors"],
    ]);
  });
  it("ties keep list order; offline machines are excluded", async () => {
    twoMachines();
    const ok = info(["flux_bf16.safetensors"]);
    const ranked = await rankInstances(
      graph("flux_bf16.safetensors"),
      listBackends(),
      {},
      {
        deps: deps(
          { [MAIN]: ok, [PC]: ok, [MAC]: ok },
          { [MAIN]: health(), [PC]: health() },
        ),
      },
    );
    expect(ranked.map((r) => r.instance.settingsId)).toEqual([
      "main",
      "pc",
      "mac",
    ]);
    expect(ranked[2].excluded).toBe("offline");
  });
  it("re-reads object_info before ruling a machine out", async () => {
    twoMachines();
    const stale = info([]);
    const fresh = info(["flux_bf16.safetensors"]);
    const objectInfo = vi.fn(async (_url: string, f: boolean) =>
      f ? fresh : stale,
    );
    const ranked = await rankInstances(
      graph("flux_bf16.safetensors"),
      [listBackends()[1]],
      {},
      {
        deps: { objectInfo, health: async () => health() },
      },
    );
    expect(ranked[0].excluded).toBeUndefined();
    expect(objectInfo).toHaveBeenCalledWith(PC, true);
  });
});

describe("planRoute", () => {
  const ok = info(["flux_bf16.safetensors"]);
  const g = graph("flux_bf16.safetensors");

  it("single machine: caller's URL, no routing", async () => {
    const plan = await planRoute(g, { action: "vary" }, undefined);
    expect(plan.mode).toBe("single");
    expect(plan.targets).toHaveLength(1);
  });
  it("auto off: legacy target is the caller's backend", async () => {
    twoMachines();
    const plan = await planRoute(g, { action: "vary" }, PC);
    expect(plan.mode).toBe("legacy");
    expect(plan.targets.map((t) => t.instance.settingsId)).toEqual(["pc"]);
  });
  it("pins win over auto, most specific key first", async () => {
    twoMachines({ auto: true, pins: { upscale: "mac", flux: "pc" } });
    expect(pinKeys({ tool: "upscale", packId: "flux" })).toEqual([
      "upscale",
      "flux",
    ]);
    const plan = await planRoute(g, { tool: "upscale", packId: "flux" });
    expect(plan.mode).toBe("pinned");
    expect(plan.targets.map((t) => t.url)).toEqual([MAC]);
    const byPack = await planRoute(g, {
      workflowPath: "/x/public/workflows/packs/flux/a.json",
    });
    expect(byPack.targets.map((t) => t.url)).toEqual([PC]);
  });
  it("a pin to a disabled machine falls back with a note", async () => {
    writeComfyInstances({
      instances: [
        { id: "pc", name: "PC", httpUrl: PC, role: "all", enabled: false },
      ],
    });
    writeComfyRouting({ pins: { vary: "pc" } });
    const plan = await planRoute(g, { action: "vary" });
    expect(plan.mode).toBe("legacy");
    expect(plan.notes[0]).toMatch(/missing or disabled/);
  });
  it("auto: nothing capable -> caller's backend so validation explains", async () => {
    twoMachines({ auto: true });
    const empty = info([]);
    const plan = await planRoute(
      g,
      { action: "vary" },
      undefined,
      deps(
        { [MAIN]: empty, [PC]: empty, [MAC]: empty },
        { [MAIN]: health(), [PC]: health(), [MAC]: health() },
      ),
    );
    expect(plan.targets.map((t) => t.instance.settingsId)).toEqual(["main"]);
    expect(plan.notes[0]).toMatch(/capability check/);
  });
  it("auto: keeps the warm H3 URL when main is the pick", async () => {
    twoMachines({ auto: true });
    const warm = "http://main.test:8189";
    const plan = await planRoute(
      g,
      { action: "vary" },
      warm,
      deps({ [MAIN]: ok }, { [MAIN]: health() }),
    );
    expect(plan.targets[0].url).toBe(warm);
  });
});

describe("queuePromptRouted", () => {
  const ok = info(["flux_bf16.safetensors"]);
  const g = graph("flux_bf16.safetensors");
  const accepted = (id: string): ComfyQueueResult => ({
    prompt_id: id,
    number: 1,
    node_errors: {},
  });
  const notSent = () =>
    new ComfyAPIError("Cannot connect", undefined, undefined, {
      code: "comfy_unreachable",
      notSent: true,
    });

  it("single machine passes the caller's URL through untouched", async () => {
    const queue = vi.fn(async () => accepted("p1"));
    const r = await queuePromptRouted(
      g,
      "c",
      undefined,
      {},
      {},
      { queue, log: () => {} },
    );
    expect(queue).toHaveBeenCalledWith(expect.anything(), "c", undefined, {});
    expect(r).toEqual(accepted("p1"));
  });
  it("legacy multi-host: same URL as before, result names the machine", async () => {
    twoMachines();
    const queue = vi.fn(
      async (_w: Workflow, _c: string, _url?: string) => accepted("p1"),
    );
    const r = await queuePromptRouted(
      g,
      "c",
      PC,
      { action: "vary" },
      {},
      { queue, log: () => {} },
    );
    expect(queue.mock.calls[0][2]).toBe(PC);
    expect(r.backend).toEqual({ id: "pc", name: "PC" });
  });
  it("auto: least busy capable machine; fails over only when not sent", async () => {
    twoMachines({ auto: true });
    const urls: string[] = [];
    const queue = vi.fn(async (_w: Workflow, _c: string, url?: string) => {
      urls.push(url!);
      if (url === PC) throw notSent();
      return accepted("p2");
    });
    const r = await queuePromptRouted(
      g,
      "c",
      undefined,
      { action: "vary" },
      {},
      deps(
        { [MAIN]: ok, [PC]: ok, [MAC]: ok },
        {
          [MAIN]: health({ queue: { running: 1, pending: 2 } }),
          [PC]: health(),
          [MAC]: health({ device: mps, queue: { running: 1, pending: 0 } }),
        },
        queue,
      ),
    );
    expect(urls).toEqual([PC, MAC]);
    expect(r.backend).toEqual({ id: "mac", name: "Mac" });
    expect(r.route?.failedOver).toEqual(["PC"]);
    expect(r.warnings?.at(-1)).toMatch(/PC offline; ran on Mac/);
  });
  it("never resubmits after a possibly-accepted failure", async () => {
    twoMachines({ auto: true });
    const queue = vi.fn(async () => {
      throw new ComfyAPIError("timed out", 504, undefined, {
        code: "comfy_timeout",
      });
    });
    await expect(
      queuePromptRouted(
        g,
        "c",
        undefined,
        { action: "vary" },
        {},
        deps(
          { [MAIN]: ok, [PC]: ok, [MAC]: ok },
          { [MAIN]: health(), [PC]: health(), [MAC]: health() },
          queue,
        ),
      ),
    ).rejects.toThrow("timed out");
    expect(queue).toHaveBeenCalledTimes(1);
  });
  it("pinned jobs do not fail over", async () => {
    twoMachines({ auto: true, pins: { vary: "pc" } });
    const queue = vi.fn(async () => {
      throw notSent();
    });
    await expect(
      queuePromptRouted(
        g,
        "c",
        undefined,
        { action: "vary" },
        {},
        { queue, log: () => {} },
      ),
    ).rejects.toThrow("Cannot connect");
    expect(queue).toHaveBeenCalledTimes(1);
  });
  it("submits a fresh copy per attempt", async () => {
    twoMachines({ auto: true });
    const seen: Workflow[] = [];
    const queue = vi.fn(async (w: Workflow, _c: string, url?: string) => {
      seen.push(w);
      (w["1"].inputs as Record<string, unknown>).unet_name = "mutated";
      if (url === MAIN) throw notSent();
      return accepted("p3");
    });
    await queuePromptRouted(
      g,
      "c",
      undefined,
      {},
      {},
      deps(
        { [MAIN]: ok, [PC]: ok },
        { [MAIN]: health(), [PC]: health() },
        queue,
      ),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect((g["1"].inputs as Record<string, unknown>).unet_name).toBe(
      "flux_bf16.safetensors",
    );
  });
});

describe("applyJobBackend", () => {
  it("follows the accepting machine", () => {
    expect(
      applyJobBackend(
        { a: 1, comfy_backend: "video" },
        { id: "default", name: "Main" },
      ),
    ).toEqual({ a: 1 });
    expect(applyJobBackend({ a: 1 }, { id: "pc", name: "PC" })).toEqual({
      a: 1,
      comfy_backend: "pc",
    });
    expect(
      applyJobBackend({ a: 1, comfy_backend: "video" }, undefined),
    ).toEqual({ a: 1, comfy_backend: "video" });
  });
});

describe("machineBadges", () => {
  it("shows online / queue / device / counts", async () => {
    const { machineBadges } = await import("@/components/settings/ComfyRoutingSettings");
    const row = {
      id: "pc",
      name: "PC",
      enabled: true,
      online: true,
      queue: { running: 1, pending: 2 },
      device: { type: "cuda", memoryGb: 24, unified: false },
      nodes: 900,
      models: 120,
      infoAt: 0,
      priority: 0,
    };
    expect(machineBadges(row)).toEqual(["online", "3 queued", "CUDA 24 GB", "900 nodes", "120 model files"]);
    expect(machineBadges({ ...row, online: false })).toEqual(["offline"]);
    expect(machineBadges({ ...row, enabled: false })).toEqual(["off"]);
  });
});
