import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  graphClasses,
  nodeHealth,
  nodeRequirements,
  type PackGraphs,
} from "@/lib/health/nodeHealth";

const realLoad = async (rel: string) =>
  JSON.parse(
    await readFile(join(process.cwd(), "public", "workflows", rel), "utf8"),
  );

describe("graphClasses", () => {
  it("reads API and UI graphs and drops frontend-only nodes", () => {
    expect(
      graphClasses({
        "1": { class_type: "KSampler" },
        "2": { class_type: "Note" },
        "3": { class_type: "KSampler" },
      }),
    ).toEqual(["KSampler"]);
    expect(
      graphClasses({ nodes: [{ type: "SaveImage" }, { type: "Reroute" }] }),
    ).toEqual(["SaveImage"]);
    expect(graphClasses(null)).toEqual([]);
  });
});

describe("nodeRequirements", () => {
  const packs: PackGraphs[] = [
    { id: "base", modelFamily: "sdxl", workflows: { t2i: "a", i2i: "b" } },
    { id: "krea2", modelFamily: "krea2", workflows: { t2i: "c" } },
    { id: "broken", modelFamily: "x", workflows: { t2i: "missing" } },
  ];
  const graphs: Record<string, unknown> = {
    a: { "1": { class_type: "KSampler" }, "2": { class_type: "SaveImage" } },
    b: { "1": { class_type: "KSampler" }, "2": { class_type: "LoadImage" } },
    c: {
      "1": { class_type: "KSampler" },
      "2": { class_type: "ConditioningKrea2Rebalance" },
    },
  };
  const load = async (rel: string) => {
    if (!(rel in graphs)) throw new Error("ENOENT");
    return graphs[rel];
  };

  it("required = default t2i; optional = per-pack extras incl. engine nodes", async () => {
    const req = await nodeRequirements(packs, "base", load);
    expect(req.required).toEqual(["KSampler", "SaveImage"]);
    expect(req.optional.base).toEqual(["LoadImage"]);
    expect(req.optional.krea2).toEqual([
      "ConditioningKrea2Rebalance",
      "Krea2ProjectorTuner",
    ]);
    expect(req.optional.broken).toBeUndefined();
  });

  it("a missing optional node never fails; a missing required one does", async () => {
    const req = await nodeRequirements(packs, "base", load);
    const optionalGone = nodeHealth(req, { KSampler: {}, SaveImage: {} });
    expect(optionalGone.ok).toBe(true);
    expect(optionalGone.missing).toEqual([]);
    expect(optionalGone.checked).toBe(2);
    expect(optionalGone.optional.krea2).toContain("Krea2ProjectorTuner");
    const requiredGone = nodeHealth(req, { KSampler: {} });
    expect(requiredGone.ok).toBe(false);
    expect(requiredGone.missing).toEqual(["SaveImage"]);
  });

  it("real packs: SeFi nodes are optional (sefi pack only)", async () => {
    const { getAllPacks, getDefaultPack } = await import("@/lib/oj/packs");
    const def = getDefaultPack();
    const req = await nodeRequirements(getAllPacks(), def.id, realLoad);
    expect(req.required.length).toBeGreaterThan(0);
    expect(req.required).not.toContain("SeFiGenerate");
    const owners = Object.entries(req.optional)
      .filter(([, c]) => c.includes("SeFiGenerate"))
      .map(([id]) => id);
    expect(owners.every((id) => id === "sefi")).toBe(true);
    const everything = Object.fromEntries(req.required.map((c) => [c, {}]));
    expect(nodeHealth(req, everything).ok).toBe(true);
  });
});

describe("GET /api/health?nodes=1", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/comfy/comfyFetch");
    vi.resetModules();
  });

  async function route(objectInfo: Record<string, unknown> | "offline") {
    vi.resetModules();
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.doMock("@/lib/comfy/comfyFetch", () => ({
      comfyFetch: vi.fn(async (p: string) => {
        if (objectInfo === "offline") throw new Error("offline");
        return new Response(
          JSON.stringify(p === "/object_info" ? objectInfo : {}),
          { status: 200 },
        );
      }),
    }));
    return import("@/app/api/health/route");
  }
  const get = (r: Awaited<ReturnType<typeof route>>) =>
    r.GET(new NextRequest("http://localhost/api/health?nodes=1"));

  it("labels an unreachable ComfyUI offline", async () => {
    const body = await (await get(await route("offline"))).json();
    expect(body).toMatchObject({
      comfyui: "disconnected",
      nodesStatus: "offline",
    });
    expect(body.nodes).toBeUndefined();
  });

  it("reports required missing and optional per pack", async () => {
    const body = await (await get(await route({ KSampler: {} }))).json();
    expect(body.comfyui).toBe("connected");
    expect(body.nodesStatus).toBe("missing");
    expect(body.nodes.missing.length).toBeGreaterThan(0);
    expect(body.nodes.checked).toBeGreaterThan(0);
    expect(body.nodes.ok).toBe(false);
    expect(typeof body.nodes.optional).toBe("object");
  });

  it("is ok when only optional nodes are missing", async () => {
    const { getAllPacks, getDefaultPack } = await import("@/lib/oj/packs");
    const req = await nodeRequirements(
      getAllPacks(),
      getDefaultPack().id,
      realLoad,
    );
    const info = Object.fromEntries(req.required.map((c) => [c, {}]));
    const body = await (await get(await route(info))).json();
    expect(body.nodesStatus).toBe("ok");
    expect(body.nodes.missing).toEqual([]);
    expect(Object.keys(body.nodes.optional).length).toBeGreaterThan(0);
  });

  it("plain /api/health has no node fields", async () => {
    const r = await route({});
    const body = await (
      await r.GET(new NextRequest("http://localhost/api/health"))
    ).json();
    expect(body.nodes).toBeUndefined();
    expect(body.nodesStatus).toBeUndefined();
  });
});
