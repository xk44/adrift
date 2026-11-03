/**
 * GET /api/setup/first-run: reachability + Create model status. ComfyUI is
 * stubbed (comfyFetch / object_info); nothing is queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  comfyFetch: vi.fn(),
  getObjectInfoCached: vi.fn(),
  loadPackWorkflow: vi.fn(),
  requireAdmin: vi.fn(),
  env: {
    COMFY_HTTP_URL: "http://user:pw@127.0.0.1:18188/base?x=1",
    COMFY_ROOT: "/srv/ComfyUI",
    COMFY_DEFAULT_CHECKPOINT: "",
  },
  pack: {
    id: "sdxl",
    name: "SDXL",
    modelFamily: "sdxl",
    workflows: { t2i: "t2i.json" },
  },
}));

vi.mock("@/lib/env", () => ({ env: h.env }));
vi.mock("@/lib/auth", () => ({
  requireAdmin: (r: unknown) => h.requireAdmin(r),
}));
vi.mock("@/lib/comfy/comfyFetch", () => ({
  comfyFetch: (...a: unknown[]) => h.comfyFetch(...a),
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: () => h.getObjectInfoCached(),
}));
vi.mock("@/lib/oj/packs", () => ({ getDefaultPack: () => h.pack }));
vi.mock("@/lib/tools/editTools", () => ({
  loadPackWorkflow: (rel: string) => h.loadPackWorkflow(rel),
}));

import { GET } from "@/app/api/setup/first-run/route";

const T2I = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" } },
};
const info = (ckpts: string[]) => ({
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [ckpts] } } },
});

function req(q = "") {
  return new NextRequest(`http://127.0.0.1:3000/api/setup/first-run${q}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.COMFY_DEFAULT_CHECKPOINT = "";
  h.pack.modelFamily = "sdxl";
  h.pack.id = "sdxl";
  h.pack.name = "SDXL";
  h.requireAdmin.mockReturnValue({ ok: true });
  h.comfyFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  h.loadPackWorkflow.mockResolvedValue(T2I);
  h.getObjectInfoCached.mockResolvedValue(info(["a.safetensors"]));
});

describe("GET /api/setup/first-run", () => {
  it("is admin-gated", async () => {
    h.requireAdmin.mockReturnValue({
      ok: false,
      response: new Response("no", { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.comfyFetch).not.toHaveBeenCalled();
  });

  it("ready: reachable, model in use, URL stripped of credentials/path", async () => {
    const res = await GET(req());
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      comfy: { reachable: true, url: "http://127.0.0.1:18188" },
      comfyRoot: "/srv/ComfyUI",
      createModel: {
        state: "ok",
        packId: "sdxl",
        packName: "SDXL",
        using: "a.safetensors",
        missing: [],
      },
    });
    expect(h.comfyFetch).toHaveBeenCalledWith(
      "/system_stats",
      expect.anything(),
    );
    expect(h.loadPackWorkflow).toHaveBeenCalledWith("t2i.json");
  });

  it("offline: unreachable and the model check is skipped", async () => {
    h.comfyFetch.mockRejectedValue(new TypeError("fetch failed"));
    const body = await (await GET(req())).json();
    expect(body.comfy.reachable).toBe(false);
    expect(body.createModel.state).toBe("unknown");
    expect(h.getObjectInfoCached).not.toHaveBeenCalled();
  });

  it("non-2xx system_stats counts as unreachable", async () => {
    h.comfyFetch.mockResolvedValue(new Response("", { status: 502 }));
    const body = await (await GET(req())).json();
    expect(body.comfy.reachable).toBe(false);
  });

  it("no checkpoints on an SDXL pack: offers the pinned starter", async () => {
    h.getObjectInfoCached.mockResolvedValue(info([]));
    const body = await (await GET(req())).json();
    expect(body.createModel.state).toBe("fail");
    expect(body.createModel.missing).toEqual(["checkpoints/*"]);
    expect(body.createModel.starter.file).toBe("sd_xl_base_1.0.safetensors");
  });

  it("no starter for other model families", async () => {
    h.pack.modelFamily = "flux";
    h.getObjectInfoCached.mockResolvedValue(info([]));
    const body = await (await GET(req())).json();
    expect(body.createModel.state).toBe("fail");
    expect(body.createModel.starter).toBeUndefined();
  });

  it("Krea 2 default with its model missing: offers the images-best starter pack", async () => {
    h.pack.id = "krea2";
    h.pack.name = "Krea 2";
    h.pack.modelFamily = "krea2";
    h.loadPackWorkflow.mockResolvedValue({
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: "krea2_turbo_bf16.safetensors" },
      },
    });
    h.getObjectInfoCached.mockResolvedValue({
      UNETLoader: { input: { required: { unet_name: [[]] } } },
    });
    const body = await (await GET(req())).json();
    expect(body.createModel.state).toBe("fail");
    expect(body.createModel.packId).toBe("krea2");
    expect(body.createModel.starter).toBeUndefined();
    expect(body.createModel.starterPack).toMatchObject({
      id: "images-best",
      command:
        "node scripts/fetch-models.mjs --pack images-best --comfy /srv/ComfyUI --yes",
    });
    // A picked model never gets the pack hint.
    const picked = await (await GET(req("?model=x.safetensors"))).json();
    expect(picked.createModel.starterPack).toBeUndefined();
  });

  it("checks the picked model (?model=) without offering the starter", async () => {
    const body = await (await GET(req("?model=gone.safetensors"))).json();
    expect(body.createModel).toMatchObject({
      state: "fail",
      missing: ["checkpoints/gone.safetensors"],
    });
    expect(body.createModel.starter).toBeUndefined();
  });

  it("object_info unavailable: unknown, never a crash", async () => {
    h.getObjectInfoCached.mockResolvedValue(null);
    expect((await (await GET(req())).json()).createModel.state).toBe("unknown");
    h.getObjectInfoCached.mockRejectedValue(new Error("boom"));
    expect((await (await GET(req())).json()).createModel.state).toBe("unknown");
  });
});
