/**
 * SeedVR2 model choice (3B / 7B / 7B sharp) and color match, for the photo
 * card and the video card's Best engine: builder, request params, option
 * blocks from model-status, setup listing.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import {
  SEEDVR2_COLOR_METHODS,
  SEEDVR2_MODELS,
  buildSeedvr2UpscaleWorkflow,
  seedvr2ColorMethod,
  seedvr2Model,
} from "@/lib/oj/seedvr2Upscale";
import {
  buildActionRequest,
  getActionTool,
  optionBlocksFor,
  pickBlock,
  type ModelStatusResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { resolveToolSetup } from "@/lib/tools/setupRequirements";
import { setupHint } from "@/lib/tools/setupHint";
import type { ImagineRun, Workflow } from "@/types";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-seedvr2-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const PACK = "packs/seedvr2/seedvr2_upscale.json";
const loadRel = (rel: string): Workflow | null => {
  const p = path.join(WORKFLOWS_DIR, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
};
const load = () => loadRel(PACK) as Workflow;

const IMG = "/api/comfy/view?filename=fox.png&subfolder=&type=output";
const VID = "/api/comfy/view?filename=fox.mp4&subfolder=video&type=output";
const run = (videos?: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    width: 832,
    height: 480,
    jobs: [
      {
        seed: 3,
        index: 0,
        status: "completed",
        progress: 100,
        images: [IMG],
        ...(videos ? { videos } : {}),
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const ofClass = (wf: Workflow, cls: string) =>
  Object.values(wf).filter((n) => n.class_type === cls);

const settings = (picks: Record<string, string>) =>
  ({ text: "", picks }) as unknown as ToolSettings;

const status = (
  options: ModelStatusResponse["options"],
): ModelStatusResponse => ({
  tools: { upscale_seedvr2: { missing: [] }, upscale_video: { missing: [] } },
  options,
});

describe("seedvr2 builder: model + color", () => {
  it.each([
    ["fast", "seedvr2_3b_fp8_e4m3fn.safetensors"],
    ["quality", "seedvr2_7b_fp8_e4m3fn.safetensors"],
    ["sharp", "seedvr2_7b_sharp_fp8_e4m3fn.safetensors"],
    ["bogus", "seedvr2_3b_fp8_e4m3fn.safetensors"],
  ])("model %s loads %s, one loader left", (model, file) => {
    for (const videos of [undefined, [VID]]) {
      const { workflow } = buildSeedvr2UpscaleWorkflow(load(), run(videos), 0, {
        model,
      });
      const loaders = ofClass(workflow, "UNETLoader");
      expect(loaders).toHaveLength(1);
      expect(loaders[0].inputs.unet_name).toBe(file);
      expect(
        Object.values(workflow).some((n) => n._meta?.optional === true),
      ).toBe(false);
    }
  });

  it("sets the post-process color match (lab default)", () => {
    for (const videos of [undefined, [VID]]) {
      const post = (params: Record<string, unknown>) =>
        ofClass(
          buildSeedvr2UpscaleWorkflow(load(), run(videos), 0, params).workflow,
          "SeedVR2PostProcessing",
        )[0].inputs.color_correction_method;
      expect(post({})).toBe("lab");
      expect(post({ color: "wavelet" })).toBe("wavelet");
      expect(post({ color: "none" })).toBe("none");
      expect(post({ color: "sepia" })).toBe("lab");
    }
  });

  it("color methods match the core node's options", () => {
    expect([...SEEDVR2_COLOR_METHODS]).toEqual([
      "lab",
      "wavelet",
      "adain",
      "none",
    ]);
    expect(seedvr2ColorMethod(" AdaIN ")).toBe("adain");
    expect(seedvr2Model("SHARP")).toBe(SEEDVR2_MODELS.sharp);
  });
});

describe("pack requirements", () => {
  it("only the 3B default gates the tool", () => {
    expect(
      workflowModelRequirements(load()).map((r) => `${r.dir}/${r.file}`),
    ).toEqual([
      "vae/seedvr2_ema_vae_fp16.safetensors",
      "diffusion_models/seedvr2_3b_fp8_e4m3fn.safetensors",
    ]);
  });

  it("setup lists the 7B files as optional downloads", () => {
    const opt = resolveToolSetup("action:upscale_seedvr2", loadRel)!.options[0];
    const f = (name: string) => opt.files.find((x) => x.file === name);
    expect(f(SEEDVR2_MODELS.fast)?.optional).toBe(false);
    for (const name of [SEEDVR2_MODELS.quality, SEEDVR2_MODELS.sharp]) {
      const file = f(name);
      expect(file, name).toBeDefined();
      expect(file!.optional).toBe(true);
      expect(file!.folder).toBe("diffusion_models/");
      expect(file!.source).toBe("Comfy-Org/SeedVR2");
      expect(file!.bytes).toBe(8240979248);
      expect(file!.command).toContain(`diffusion_models/${name}`);
    }
  });
});

describe("tool cards", () => {
  it("photo card sends model + color", () => {
    expect(
      buildActionRequest(
        getActionTool("upscale_seedvr2")!,
        settings({ model: "sharp", color: "wavelet" }),
        null,
      ),
    ).toEqual({
      action: "seedvr2_upscale",
      params: { media: "image", scale: "2x", model: "sharp", color: "wavelet" },
      overrides: {},
    });
  });

  it("video card Best engine sends model + color; Fast ignores them", () => {
    const spec = getActionTool("upscale_video")!;
    expect(
      buildActionRequest(
        spec,
        settings({ engine: "best", model: "quality", color: "none" }),
        null,
      ).params,
    ).toEqual({ media: "video", scale: "2x", model: "quality", color: "none" });
    const fast = buildActionRequest(
      spec,
      settings({ model: "sharp", color: "none" }),
      null,
    );
    expect(fast.action).toBe("video_upscale");
    expect(fast.params).not.toHaveProperty("color");
    for (const key of ["model", "color"]) {
      expect(spec.pickers!.find((p) => p.key === key)?.showWhen).toEqual({
        key: "engine",
        value: "best",
      });
    }
  });

  it("both cards offer 3B / 7B / 7B sharp with a VRAM hint", () => {
    for (const id of ["upscale_seedvr2", "upscale_video"]) {
      const picker = getActionTool(id)!.pickers!.find(
        (p) => p.key === "model",
      )!;
      expect(picker.options.map((o) => o.id)).toEqual([
        "fast",
        "quality",
        "sharp",
      ]);
      expect(picker.options[0].requiresOption).toBeUndefined();
      expect(picker.hint).toMatch(/VRAM/);
      expect(picker.hint).toMatch(/24 GB/);
    }
  });

  it("a missing 7B blocks only that pick, with a setup hint", () => {
    const spec = getActionTool("upscale_seedvr2")!;
    const blocks = optionBlocksFor(
      spec,
      null,
      null,
      status({
        seedvr2_7b: {
          file: SEEDVR2_MODELS.quality,
          missing: [`diffusion_models/${SEEDVR2_MODELS.quality}`],
        },
        seedvr2_7b_sharp: { file: SEEDVR2_MODELS.sharp, missing: [] },
      }),
    );
    expect(Object.keys(blocks?.model ?? {})).toEqual(["quality"]);
    const card = { optionBlocks: blocks };
    const block = pickBlock(card, spec, settings({ model: "quality" }))!;
    expect(block.checking).toBe(false);
    expect(setupHint(block.reason, block.model)).toBe("Needs SeedVR2 7B model");
    expect(pickBlock(card, spec, settings({ model: "sharp" }))).toBeNull();
    expect(pickBlock(card, spec, settings({}))).toBeNull();
  });

  it("video card: the block applies only on the Best engine", () => {
    const spec = getActionTool("upscale_video")!;
    const blocks = optionBlocksFor(
      spec,
      null,
      null,
      status({
        seedvr2_7b_sharp: {
          file: SEEDVR2_MODELS.sharp,
          missing: [`diffusion_models/${SEEDVR2_MODELS.sharp}`],
        },
      }),
    );
    const card = { optionBlocks: blocks };
    expect(
      pickBlock(card, spec, settings({ engine: "best", model: "sharp" })),
    ).not.toBeNull();
    expect(pickBlock(card, spec, settings({ model: "sharp" }))).toBeNull();
  });

  it("an older server without option entries does not block", () => {
    const spec = getActionTool("upscale_seedvr2")!;
    expect(
      optionBlocksFor(spec, null, null, status(undefined)),
    ).toBeUndefined();
  });
});

describe("GET /api/tools/model-status", () => {
  it("reports the 7B / 7B sharp DiTs as model options", async () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    delete process.env.COMFY_VIDEO_HTTP_URL;
    try {
      const { GET } = await import("@/app/api/tools/model-status/route");
      const get = async () =>
        (
          await GET(new NextRequest("http://localhost/api/tools/model-status"))
        ).json();
      let body = await get();
      expect(body.options.seedvr2_7b).toEqual({
        file: SEEDVR2_MODELS.quality,
        missing: [`diffusion_models/${SEEDVR2_MODELS.quality}`],
      });
      expect(body.options.seedvr2_7b_sharp.missing).toEqual([
        `diffusion_models/${SEEDVR2_MODELS.sharp}`,
      ]);

      const dir = path.join(tmpRoot, "models", "diffusion_models");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, SEEDVR2_MODELS.sharp), "");
      body = await get();
      expect(body.options.seedvr2_7b_sharp.missing).toEqual([]);
      expect(body.options.seedvr2_7b.missing).toHaveLength(1);
    } finally {
      if (prev !== undefined) process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });
});
