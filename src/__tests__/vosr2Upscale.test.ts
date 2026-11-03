/**
 * Photo upscale (VOSR2): pack graph shape against the live node schemas,
 * builder params (scale / color / seed clamps), card → action dispatch,
 * and the bundle-folder model check.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import {
  VOSR2_COLOR_METHODS,
  VOSR2_ID,
  VOSR2_TILES,
  VOSR2_UPSCALE_ACTION,
  buildVosr2UpscaleWorkflow,
  vosr2ColorMethod,
  vosr2Scale,
  vosr2Seed,
} from "@/lib/oj/vosr2Upscale";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import registry from "@/lib/oj/registry.json";
import {
  buildActionRequest,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import type { ImagineRun, Workflow } from "@/types";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-vosr2-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
// Offline backend: the disk check alone decides.
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: async () => null,
}));

const PACK = "packs/vosr2/vosr2_upscale.json";
const load = (): Workflow => {
  const { _meta, ...wf } = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows", PACK),
      "utf-8",
    ),
  );
  void _meta;
  return wf as Workflow;
};

const IMG = "/api/comfy/view?filename=fox.png&subfolder=&type=output";
const VID = "/api/comfy/view?filename=fox.mp4&subfolder=video&type=output";
const run = (job: Record<string, unknown> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    width: 1024,
    height: 1024,
    jobs: [
      {
        seed: 7,
        index: 0,
        status: "completed",
        progress: 100,
        images: [IMG],
        ...job,
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const upscaleInputs = (params: Record<string, unknown> = {}, job = {}) =>
  buildVosr2UpscaleWorkflow(load(), run(job), 0, params).workflow[
    VOSR2_ID.upscale
  ].inputs;

const settings = (picks: Record<string, string>) =>
  ({ text: "", picks }) as unknown as ToolSettings;

describe("vosr2 pack graph", () => {
  it("is LoadImage → VOSR2Upscale (VOSR2ModelLoader) → SaveImage", () => {
    const wf = load();
    expect(
      Object.fromEntries(
        Object.entries(wf).map(([id, n]) => [id, n.class_type]),
      ),
    ).toEqual({
      "1": "LoadImage",
      "2": "VOSR2ModelLoader",
      "3": "VOSR2Upscale",
      "4": "SaveImage",
    });
    expect(wf["3"].inputs.model).toEqual(["2", 0]);
    expect(wf["3"].inputs.image).toEqual(["1", 0]);
    expect(wf["4"].inputs.images).toEqual(["3", 0]);
    expect(wf["2"].inputs).toEqual({ model: "VOSR2", dtype: "default" });
  });

  it("tiles for a 24 GB card: 512 px DiT tiles, 1024 px VAE tiles", () => {
    const pinned = {
      tile_size: 512,
      tile_overlap: 64,
      vae_tile_size: 1024,
      vae_tile_overlap: 32,
    };
    expect(VOSR2_TILES).toEqual(pinned);
    expect(load()["3"].inputs).toMatchObject({
      upscale: 4,
      color_alignment: "wavelet",
      ...pinned,
    });
  });

  // Schema bounds copied from the live object_info (ComfyUI-VOSR2).
  it("every widget value is inside the node's schema", () => {
    const up = load()["3"].inputs;
    const ranges: Record<string, [number, number, number]> = {
      tile_size: [0, 4096, 64],
      tile_overlap: [0, 512, 8],
      vae_tile_size: [0, 8192, 64],
      vae_tile_overlap: [0, 512, 8],
    };
    for (const [key, [min, max, step]] of Object.entries(ranges)) {
      const v = up[key] as number;
      expect(v, key).toBeGreaterThanOrEqual(min);
      expect(v, key).toBeLessThanOrEqual(max);
      expect(v % step, key).toBe(0);
    }
    expect(up.tile_overlap as number).toBeLessThan(up.tile_size as number);
    expect(up.vae_tile_overlap as number).toBeLessThan(
      up.vae_tile_size as number,
    );
    expect([...VOSR2_COLOR_METHODS]).toEqual(["wavelet", "adain", "none"]);
  });
});

describe("vosr2 builder", () => {
  it("wires the source image and the job seed", () => {
    const { workflow, slots, seed } = buildVosr2UpscaleWorkflow(
      load(),
      run(),
      0,
    );
    expect(workflow[VOSR2_ID.loadImage].inputs.image).toBe("fox.png [output]");
    expect(workflow[VOSR2_ID.upscale].inputs.seed).toBe(7);
    expect(seed).toBe(7);
    expect(slots.imageInputId).toBe(VOSR2_ID.loadImage);
  });

  it("scale: 2x / 4x, default and junk → 4x", () => {
    expect(upscaleInputs().upscale).toBe(4);
    expect(upscaleInputs({ scale: "2x" }).upscale).toBe(2);
    expect(upscaleInputs({ scale: "4X" }).upscale).toBe(4);
    expect(upscaleInputs({ scale: 2 }).upscale).toBe(2);
    for (const bad of ["8x", 16, 0, -2, "1080p", null, "2.5x"])
      expect(upscaleInputs({ scale: bad }).upscale, String(bad)).toBe(4);
    expect(vosr2Scale(" 2x ")).toBe(2);
  });

  it("color alignment: wavelet default, adain / none kept, junk → wavelet", () => {
    expect(upscaleInputs().color_alignment).toBe("wavelet");
    expect(upscaleInputs({ color: "adain" }).color_alignment).toBe("adain");
    expect(upscaleInputs({ color: "None" }).color_alignment).toBe("none");
    expect(upscaleInputs({ color: "lab" }).color_alignment).toBe("wavelet");
    expect(vosr2ColorMethod(42)).toBe("wavelet");
  });

  it("seed is clamped to a non-negative integer", () => {
    expect(upscaleInputs({}, { seed: -5 }).seed).toBe(0);
    expect(upscaleInputs({}, { seed: 12.7 }).seed).toBe(12);
    expect(upscaleInputs({}, { seed: undefined }).seed).toBe(0);
    expect(vosr2Seed(Number.NaN)).toBe(0);
  });

  it("tile settings are computed, never taken from params or the graph", () => {
    const wf = load();
    Object.assign(wf[VOSR2_ID.upscale].inputs, {
      tile_size: 0,
      vae_tile_size: 0,
    });
    const up = buildVosr2UpscaleWorkflow(wf, run(), 0, {
      tile_size: 0,
      vae_tile_size: 0,
      tile_overlap: 500,
    }).workflow[VOSR2_ID.upscale].inputs;
    expect(up).toMatchObject(VOSR2_TILES);
    const spec = getActionTool("upscale_vosr2")!;
    expect(spec.pickers!.map((p) => p.key)).toEqual(["scale", "color"]);
    // Only the shared finishing controls; tiling is never a slider.
    expect(spec.sliders!.map((x) => x.key)).toEqual(["strength", "sharpen"]);
  });

  it("image only: a video-only source is rejected", () => {
    expect(() =>
      buildVosr2UpscaleWorkflow(load(), run({ images: [], videos: [VID] }), 0),
    ).toThrow(/no image/);
  });

  it("a graph missing a node fails loudly", () => {
    const wf = load();
    delete wf[VOSR2_ID.loader];
    expect(() => buildVosr2UpscaleWorkflow(wf, run(), 0)).toThrow(
      /VOSR2ModelLoader/,
    );
  });
});

describe("dispatch", () => {
  it("the action resolves to the pack and builder", () => {
    expect(VOSR2_UPSCALE_ACTION).toBe("upscale_vosr2");
    expect(ACTION_BUILDERS[VOSR2_UPSCALE_ACTION]).toBe(
      buildVosr2UpscaleWorkflow,
    );
    const reg = registry as unknown as {
      actions: Record<string, { template: string; requiresImage: boolean }>;
      templates: Record<string, { file: string }>;
    };
    const action = reg.actions[VOSR2_UPSCALE_ACTION];
    expect(action.requiresImage).toBe(true);
    expect(reg.templates[action.template].file).toBe(PACK);
  });

  it("the card sends scale + color (defaults 4x / wavelet)", () => {
    const spec = getActionTool("upscale_vosr2")!;
    expect(spec.title).toBe("Photo upscale (VOSR2)");
    expect(spec.videoInput).toBeFalsy();
    expect(spec.modelCheck).toEqual({ pack: "vosr2", action: "upscale_vosr2" });
    expect(buildActionRequest(spec, settings({}), null)).toEqual({
      action: "upscale_vosr2",
      params: { scale: "4x", color: "wavelet" },
      overrides: {},
    });
    expect(
      buildActionRequest(spec, settings({ scale: "2x", color: "none" }), null)
        .params,
    ).toEqual({ scale: "2x", color: "none" });
    const ids = (key: string) =>
      spec.pickers!.find((p) => p.key === key)!.options.map((o) => o.id);
    expect(ids("scale")).toEqual(["4x", "2x"]);
    expect(ids("color")).toEqual([...VOSR2_COLOR_METHODS]);
  });
});

describe("model check", () => {
  it("the bundle's DiT gates the tool", () => {
    expect(
      workflowModelRequirements(load()).map((r) => `${r.dir}/${r.file}`),
    ).toEqual(["vosr2/VOSR2/checkpoints/ema_model.safetensors"]);
  });

  it("model-status reports the bundle missing until its DiT is on disk", async () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    delete process.env.COMFY_VIDEO_HTTP_URL;
    try {
      const { GET } = await import("@/app/api/tools/model-status/route");
      const get = async () =>
        (
          await GET(new NextRequest("http://localhost/api/tools/model-status"))
        ).json();
      fs.mkdirSync(path.join(tmpRoot, "custom_nodes", "ComfyUI-VOSR2"), {
        recursive: true,
      });
      let body = await get();
      expect(body.tools.upscale_vosr2.missing).toEqual([
        "vosr2/VOSR2/checkpoints/ema_model.safetensors",
      ]);
      // An empty bundle folder is not enough.
      const dir = path.join(tmpRoot, "models", "vosr2", "VOSR2", "checkpoints");
      fs.mkdirSync(dir, { recursive: true });
      body = await get();
      expect(body.tools.upscale_vosr2.missing).toHaveLength(1);
      fs.writeFileSync(path.join(dir, "ema_model.safetensors"), "");
      body = await get();
      expect(body.tools.upscale_vosr2.missing).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });
});
