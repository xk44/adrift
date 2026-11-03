/**
 * Memory hygiene: system_stats parsing (Mac unified + CUDA fixtures), preflight
 * thresholds, free-on-switch trigger logic, and the client submit guard with a
 * mocked fetch (never touches the live ComfyUI).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import mac from "./fixtures/system-stats/mac-mps-128gb.json";
import cuda from "./fixtures/system-stats/cuda-4090.json";
import {
  parseSystemStats,
  preflightMemory,
  estimatePackMemoryGb,
  shouldFreeOnSwitch,
  packFamilyGroup,
  resolveSubmitPackId,
  PACK_MEMORY_ESTIMATES,
  FREE_MEMORY_BODY,
} from "@/lib/comfy/memory";
import {
  runSubmitMemoryGuard,
  noteSubmittedPack,
  getLastSubmittedPackId,
  resetSubmitGuardForTests,
} from "@/lib/comfy/memoryClient";

const macSnap = parseSystemStats(mac)!;
const cudaSnap = parseSystemStats(cuda)!;

describe("parseSystemStats", () => {
  it("Mac MPS: unified, RAM-based capacity at 75% working set", () => {
    expect(macSnap.unified).toBe(true);
    expect(macSnap.deviceType).toBe("mps");
    expect(macSnap.capacityGb).toBe(96);
    expect(macSnap.freeGb).toBeCloseTo(94.73, 1);
  });

  it("CUDA: VRAM-based, not unified", () => {
    expect(cudaSnap.unified).toBe(false);
    expect(cudaSnap.capacityGb).toBeCloseTo(23.99, 1);
    expect(cudaSnap.freeGb).toBeCloseTo(22, 1);
    expect(cudaSnap.ramTotalGb).toBe(64);
  });

  it("accepts Adrift's camelCase /api/comfy/system shape", () => {
    const s = parseSystemStats({
      system: { os: "linux", ramTotal: 64 * 1024 ** 3, ramFree: 1 },
      devices: [
        { type: "cuda", vramTotal: 8 * 1024 ** 3, vramFree: 4 * 1024 ** 3 },
      ],
    });
    expect(s).toMatchObject({ capacityGb: 8, freeGb: 4, unified: false });
  });

  it("darwin without a device entry is still unified", () => {
    const s = parseSystemStats({
      system: { os: "darwin", ram_total: 32 * 1024 ** 3, ram_free: 0 },
      devices: [],
    });
    expect(s?.unified).toBe(true);
    expect(s?.capacityGb).toBe(24);
  });

  it("garbage -> null", () => {
    expect(parseSystemStats(null)).toBeNull();
    expect(parseSystemStats({ system: {} })).toBeNull();
  });
});

describe("preflight thresholds", () => {
  it("estimate table: every entry sane, megapixel scaling", () => {
    for (const [id, e] of Object.entries(PACK_MEMORY_ESTIMATES)) {
      expect([id, e.gb > 0 && !!e.group]).toEqual([id, true]);
    }
    expect(estimatePackMemoryGb("sdxl")).toBe(8);
    expect(estimatePackMemoryGb("krea2", 2)).toBe(40);
    expect(estimatePackMemoryGb("ltxv", 4)).toBe(18);
    expect(estimatePackMemoryGb("nope")).toBeUndefined();
  });

  it.each([
    // [snapshot, pack, sameFamilyResident, level, lowVram]
    ["cuda", "sdxl", false, "ok", false],
    ["cuda", "sd15", false, "ok", false],
    ["cuda", "flux3", false, "ok", false],
    ["cuda", "zimage", false, "ok", false],
    ["cuda", "ltxv", false, "ok", false],
    ["cuda", "flux", false, "exceeds", true],
    ["cuda", "krea2", false, "exceeds", true],
    ["cuda", "minimax", false, "exceeds", true],
    ["mac", "krea2", false, "ok", false],
    ["mac", "qwen-image-edit", false, "ok", false],
    ["mac", "minimax", false, "tight", true],
    ["mac", "minimax", true, "ok", false],
    ["mac", "custom-pack", false, "unknown", false],
  ] as const)("%s %s resident=%s -> %s", (snap, pack, same, level, low) => {
    const r = preflightMemory(snap === "mac" ? macSnap : cudaSnap, pack, {
      sameFamilyResident: same,
    });
    expect(r.level).toBe(level);
    expect(r.lowVram).toBe(low);
    if (level === "exceeds" || level === "tight")
      expect(r.message).toBeTruthy();
  });

  it("messages name the budget kind", () => {
    expect(preflightMemory(cudaSnap, "krea2").message).toMatch(/VRAM/);
    expect(preflightMemory(macSnap, "minimax").message).toMatch(
      /unified memory/,
    );
    const small = { ...macSnap, capacityGb: 48, freeGb: 40 };
    expect(preflightMemory(small, "minimax").message).toMatch(
      /Metal working-set/,
    );
  });

  it("small card flags lowVram even for SD", () => {
    const card8 = { ...cudaSnap, capacityGb: 8, freeGb: 7 };
    expect(preflightMemory(card8, "sdxl")).toMatchObject({
      level: "ok",
      lowVram: true,
    });
  });

  it("hd megapixels can push a fitting pack over", () => {
    const tight = { ...cudaSnap, capacityGb: 24, freeGb: 23.99 };
    expect(preflightMemory(tight, "flux3").level).toBe("ok");
    expect(preflightMemory(tight, "flux3", { megapixels: 4 }).level).toBe(
      "exceeds",
    );
  });

  it("no snapshot -> unknown, never blocks", () => {
    expect(preflightMemory(null, "minimax").level).toBe("unknown");
  });
});

describe("free-on-switch trigger", () => {
  it.each([
    [null, "krea2", true, false],
    ["krea2", "krea2", true, false],
    ["krea2", "krea2-raw", true, false],
    ["krea2", "krea2-draft", true, false],
    ["sd15", "sdxl", true, false],
    ["sdxl", "krea2", true, true],
    ["krea2", "minimax", true, true],
    ["krea2", "minimax", false, false],
    ["krea2", undefined, true, false],
    ["custom-a", "custom-b", true, true],
  ] as const)("%s -> %s (enabled=%s) => %s", (a, b, en, want) => {
    expect(shouldFreeOnSwitch(a, b, en)).toBe(want);
  });

  it("unknown pack is its own group; free body is the full unload", () => {
    expect(packFamilyGroup("custom-x")).toBe("custom-x");
    expect(FREE_MEMORY_BODY).toEqual({
      unload_models: true,
      free_memory: true,
    });
  });
});

describe("resolveSubmitPackId", () => {
  const ckpt = (c: string) => (c.includes("xl") ? "sdxl" : "sd15");
  it.each([
    [{ video: true }, null, "ltx25"],
    [{ video: true, vmodel: "wan" }, null, "wan"],
    [{ packId: "minimax", video: true }, null, "minimax"],
    [{ packId: "qwen-image-21" }, "t2i.json", "qwen-image-21"],
    [{}, "packs/krea2/t2i.json", "krea2"],
    [{}, "krea2_draft.json", "krea2-draft"],
    [{}, "krea2_controlnet.json", "krea2"],
    [{}, "zimageturbo.json", "zimage"],
    [{}, "wan22_t2v.json", "wan"],
    [{}, "saved:my-graph", undefined],
    [{ model: "sd_xl_base.safetensors" }, "__overlay__/x", undefined],
    [{ model: "sd_xl_base.safetensors" }, "t2i.json", "sdxl"],
    [{}, "t2i.json", undefined],
  ] as const)("%j @ %s -> %s", (params, wf, want) => {
    expect(
      resolveSubmitPackId({
        params: params as Record<string, unknown>,
        workflowPath: wf,
        checkpointFamilyToPack: ckpt,
      }),
    ).toBe(want);
  });
});

describe("runSubmitMemoryGuard (mocked fetch)", () => {
  type Call = { url: string; method: string; body?: unknown };
  const mkFetch = (
    stats: unknown,
    calls: Call[],
    opts: { fail?: boolean } = {},
  ) =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (opts.fail) throw new Error("offline");
      return new Response(
        init?.method === "POST"
          ? JSON.stringify({ ok: true })
          : JSON.stringify(stats),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

  beforeEach(() => resetSubmitGuardForTests());

  it("only ever calls the Adrift proxy, never ComfyUI directly", async () => {
    const calls: Call[] = [];
    await runSubmitMemoryGuard(
      "a cat --packId krea2",
      null,
      {},
      { fetchImpl: mkFetch(mac, calls), previousPackId: "sdxl" },
    );
    expect(calls.every((c) => c.url === "/api/comfy/system")).toBe(true);
  });

  it("family switch: preflight GET, then free POST (before the caller queues)", async () => {
    const calls: Call[] = [];
    const notify = vi.fn();
    const r = await runSubmitMemoryGuard(
      "a cat",
      "packs/krea2/t2i.json",
      {},
      { fetchImpl: mkFetch(mac, calls), previousPackId: "sdxl", notify },
    );
    expect(r).toMatchObject({ proceed: true, packId: "krea2", freed: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1].body).toEqual({ action: "free" });
    expect(notify).toHaveBeenCalledWith(
      "Unloaded sdxl models before switching to krea2",
      "info",
    );
    expect(r.prompt).toBe("a cat");
  });

  it("same family: no free", async () => {
    const calls: Call[] = [];
    const r = await runSubmitMemoryGuard(
      "a cat --packId krea2-raw",
      null,
      {},
      { fetchImpl: mkFetch(mac, calls), previousPackId: "krea2" },
    );
    expect(r.freed).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("first submit of the session: no free", async () => {
    const calls: Call[] = [];
    await runSubmitMemoryGuard(
      "a cat --packId krea2",
      null,
      {},
      { fetchImpl: mkFetch(mac, calls) },
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("setting off: no free; preflight off: no GET", async () => {
    const calls: Call[] = [];
    await runSubmitMemoryGuard(
      "a cat --packId krea2",
      null,
      { freeOnFamilySwitch: false, memoryPreflight: false },
      { fetchImpl: mkFetch(mac, calls), previousPackId: "sdxl" },
    );
    expect(calls).toEqual([]);
  });

  it("exceeds + user cancels -> proceed false, no free", async () => {
    const calls: Call[] = [];
    const confirmImpl = vi.fn((_m: string) => false);
    const r = await runSubmitMemoryGuard(
      "a cat --packId krea2",
      null,
      {},
      { fetchImpl: mkFetch(cuda, calls), previousPackId: "sdxl", confirmImpl },
    );
    expect(confirmImpl).toHaveBeenCalledOnce();
    expect(confirmImpl.mock.calls[0][0]).toMatch(/Submit anyway\?/);
    expect(r.proceed).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("exceeds + user accepts -> appends --lowvram, then frees", async () => {
    const calls: Call[] = [];
    const r = await runSubmitMemoryGuard(
      "a cat --packId krea2",
      null,
      {},
      {
        fetchImpl: mkFetch(cuda, calls),
        previousPackId: "sdxl",
        confirmImpl: () => true,
      },
    );
    expect(r.proceed).toBe(true);
    expect(r.prompt).toBe("a cat --packId krea2 --lowvram");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("tight -> warning toast; pinned tiled setting/flags suppress --lowvram", async () => {
    const notify = vi.fn();
    const r1 = await runSubmitMemoryGuard(
      "a --video --vmodel minimax",
      null,
      { tiledVae: "off", freeOnFamilySwitch: false },
      { fetchImpl: mkFetch(mac, []), notify },
    );
    expect(r1.preflight?.level).toBe("tight");
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/minimax/),
      "warning",
    );
    expect(r1.prompt).toBe("a --video --vmodel minimax");

    const r2 = await runSubmitMemoryGuard(
      "a --packId krea2 --tiledvae-off",
      null,
      {},
      { fetchImpl: mkFetch(cuda, []), confirmImpl: () => true },
    );
    expect(r2.prompt).toBe("a --packId krea2 --tiledvae-off");
  });

  it("network failure degrades to proceed unchanged", async () => {
    const r = await runSubmitMemoryGuard(
      "a --packId krea2",
      null,
      {},
      { fetchImpl: mkFetch(null, [], { fail: true }), previousPackId: "sdxl" },
    );
    expect(r).toMatchObject({
      proceed: true,
      freed: false,
      prompt: "a --packId krea2",
    });
  });

  it("unclassifiable workflow -> no network at all", async () => {
    const calls: Call[] = [];
    const r = await runSubmitMemoryGuard(
      "a",
      "saved:foo",
      {},
      { fetchImpl: mkFetch(mac, calls), previousPackId: "sdxl" },
    );
    expect(r.packId).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("module tracker records accepted submits only via noteSubmittedPack", () => {
    expect(getLastSubmittedPackId()).toBeNull();
    noteSubmittedPack(undefined);
    expect(getLastSubmittedPackId()).toBeNull();
    noteSubmittedPack("krea2");
    expect(getLastSubmittedPackId()).toBe("krea2");
  });
});
