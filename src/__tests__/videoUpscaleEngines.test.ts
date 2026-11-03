/**
 * Upscale video engines FlashVSR (WanVideoWrapper, packs/flashvsr) and
 * LTX x2 (LTX-2.5 Pixel Spatial Upscaler IC-LoRA, packs/ltx25): graphs,
 * builders, registry + tool wiring, model requirements and licences.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  FLASHVSR_DECODE_PIXEL_FRAMES,
  FLASHVSR_UPSCALE_ACTION,
  FLASHVSR_MAX_SHORT_SIDE,
  buildFlashvsrUpscaleWorkflow,
  flashvsrResizeInputs,
} from "@/lib/oj/flashvsrUpscale";
import {
  LTX_UPSCALE_X2_ACTION,
  buildLtxUpscaleX2Workflow,
} from "@/lib/oj/ltxUpscaleX2";
import { routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { downloadCommand } from "@/lib/tools/setupRequirements";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  optionBlocksFor,
  pickBlock,
  pickerVisible,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { actionsForTool, familyFor } from "@/lib/tools/toolsDoc";
import modelSizes from "@/lib/tools/modelSizes.json";
import weightClasses from "@/lib/tools/toolWeightClasses.json";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const FLASHVSR = "packs/flashvsr/flashvsr_upscale.json";
const LTX = "packs/ltx25/upscale_x2.json";
const LTX_LORA =
  "ltx25/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors";
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));

const VID = "/api/comfy/view?filename=fox.mp4&subfolder=video&type=output";
const run = (videos: string[] = [VID], seed = 11): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    width: 832,
    height: 480,
    jobs: [
      {
        seed,
        index: 0,
        status: "completed",
        progress: 100,
        images: [],
        videos,
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const hits = byClass(wf, cls);
  expect(hits, cls).toHaveLength(1);
  return hits[0];
};
const settings = (picks: Record<string, string>): ToolSettings => {
  const s = defaultSettings(getActionTool("upscale_video")!);
  return { ...s, picks: { ...s.picks, ...picks } };
};

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    if (id === "_meta") continue;
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} -> ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("registry wiring", () => {
  const actions = registry.actions as Record<string, Record<string, unknown>>;
  const templates = registry.templates as Record<string, { file: string }>;

  it.each([
    [FLASHVSR_UPSCALE_ACTION, FLASHVSR],
    [LTX_UPSCALE_X2_ACTION, LTX],
  ])("%s -> %s", (action, file) => {
    expect(actions[action]).toMatchObject({
      template: action,
      requiresImage: false,
      group: "upscale",
    });
    expect(templates[action].file).toBe(file);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    expect(
      resolveWorkflow({ templateOrAction: action, packId: "krea2" })
        .workflowPath,
    ).toBe(file);
    expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(true);
  });

  it("graphs route to the video host when one is configured", () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({
          action: FLASHVSR_UPSCALE_ACTION,
          workflowPath: FLASHVSR,
        }),
      ).toBe("video");
      expect(
        routeBackend({ action: LTX_UPSCALE_X2_ACTION, workflowPath: LTX }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("graphs resolve every link and carry no personal paths", () => {
    for (const f of [FLASHVSR, LTX]) {
      expectLinksResolve(load(f));
      const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf-8");
      expect(raw).not.toMatch(/\/Users\/|\/home\/|\/mnt\/|[A-Z]:\\\\/);
    }
  });
});

describe("flashvsr_upscale", () => {
  it("uses only local WanVideoWrapper + core nodes (no API nodes)", () => {
    const classes = Object.values(load(FLASHVSR)).map((n) => n.class_type);
    expect(classes).toContain("WanVideoAddFlashVSRInput");
    expect(classes).toContain("WanVideoFlashVSRDecoderLoader");
    expect(classes.some((c) => /wavespeed|api/i.test(c ?? ""))).toBe(false);
  });

  it("sets the source clip, the size and the seed", () => {
    const { workflow, slots, seed } = buildFlashvsrUpscaleWorkflow(
      load(FLASHVSR),
      run([VID], 77),
      0,
      { scale: "1080p" },
    );
    const [loadId, loadNode] = one(workflow, "LoadVideo");
    expect(loadNode.inputs.file).toBe("video/fox.mp4 [output]");
    expect(slots.imageInputId).toBe(loadId);
    const [samplerId, sampler] = one(workflow, "WanVideoSampler");
    expect(sampler.inputs.seed).toBe(77);
    expect(seed).toBe(77);
    expect(slots.ksamplerId).toBe(samplerId);
    const resizes = byClass(workflow, "ResizeImageMaskNode").map(
      ([, n]) => n.inputs,
    );
    expect(resizes[0]).toMatchObject(flashvsrResizeInputs("1080p"));
    expect(resizes[0]["resize_type.multiplier"]).toBeUndefined();
    // The /16 fit stays untouched.
    expect(resizes[1]).toMatchObject({
      resize_type: "scale to multiple",
      "resize_type.multiple": 16,
    });
  });

  it("clips cap at 1080p like Best; 2x is the default", () => {
    expect(flashvsrResizeInputs("4k")).toEqual(flashvsrResizeInputs("1080p"));
    const def = buildFlashvsrUpscaleWorkflow(load(FLASHVSR), run(), 0, {});
    const [, resize] = byClass(def.workflow, "ResizeImageMaskNode")[0];
    expect(resize.inputs.resize_type).toBe("scale by multiplier");
    // 2x is computed in-graph: min(2, 1440 / source short side).
    const mult = resize.inputs["resize_type.multiplier"] as [string, number];
    const clamp = def.workflow[mult[0]];
    expect(clamp.class_type).toBe("ComfyMathExpression");
    expect(clamp.inputs.expression).toBe(
      `min(2, ${FLASHVSR_MAX_SHORT_SIDE} / min(a, b))`,
    );
    const size = def.workflow[(clamp.inputs["values.a"] as [string, number])[0]];
    expect(size.class_type).toBe("GetImageSize");
    // Measured from the source frames, not the resized ones.
    expect(size.inputs.image).toEqual(resize.inputs.input);
    expect(clamp.inputs["values.b"]).toEqual([
      (clamp.inputs["values.a"] as [string, number])[0],
      1,
    ]);
    expectLinksResolve(def.workflow);
    // 1080p / 4k picks are fixed sizes: no clamp nodes.
    const fixed = buildFlashvsrUpscaleWorkflow(load(FLASHVSR), run(), 0, {
      scale: "1080p",
    });
    expect(byClass(fixed.workflow, "GetImageSize")).toHaveLength(1);
  });

  it("2x clamp math: 2x up to 720p, 1440p short side above", () => {
    const m = (w: number, h: number) =>
      Math.min(2, FLASHVSR_MAX_SHORT_SIDE / Math.min(w, h));
    expect(m(854, 480)).toBe(2);
    expect(m(1280, 720)).toBe(2);
    expect(Math.round(1056 * m(1920, 1056))).toBe(1440);
    expect(Math.round(2160 * m(3840, 2160))).toBe(1440);
  });

  it("keeps source length, fps and audio; long clips use context windows", () => {
    const wf = load(FLASHVSR);
    const [sizeId] = one(wf, "GetImageSize");
    const [compId] = one(wf, "GetVideoComponents");
    const [ctxId] = one(wf, "WanVideoContextOptions");
    const [, sampler] = one(wf, "WanVideoSampler");
    expect(sampler.inputs.context_options).toEqual([ctxId, 0]);
    expect(sampler.inputs).toMatchObject({ steps: 1, cfg: 1 });
    const [, create] = one(wf, "CreateVideo");
    expect(create.inputs.fps).toEqual([compId, 2]);
    expect(create.inputs.audio).toEqual([compId, 1]);
    const cut = wf[(create.inputs.images as [string, number])[0]];
    const [capId] = byClass(wf, "ComfyMathExpression").filter(
      ([, n]) => String(n.inputs.expression).startsWith("min("),
    )[0];
    expect(wf[capId].inputs["values.c"]).toEqual([sizeId, 2]);
    expect(cut.inputs.length).toEqual([capId, 1]);
  });

  it("caps the clip to the decode memory budget before sampling", () => {
    // The TCDecoder decodes every frame on the GPU at once (no tiling):
    // 360 frames at 1080p ran out of memory on a 24 GB card, 241 did not.
    const wf = load(FLASHVSR);
    const [sizeId] = one(wf, "GetImageSize");
    const caps = byClass(wf, "ComfyMathExpression").filter(([, n]) =>
      String(n.inputs.expression).startsWith("min("),
    );
    expect(caps).toHaveLength(1);
    const [capId, cap] = caps[0];
    expect(cap.inputs.expression).toBe(
      `min(c, max(1, ${FLASHVSR_DECODE_PIXEL_FRAMES} // (a * b)))`,
    );
    expect(cap.inputs["values.a"]).toEqual([sizeId, 0]);
    expect(cap.inputs["values.b"]).toEqual([sizeId, 1]);
    expect(FLASHVSR_DECODE_PIXEL_FRAMES / (1920 * 1080)).toBe(240);
    const trims = byClass(wf, "ImageFromBatch").filter(
      ([, n]) =>
        JSON.stringify(n.inputs.image) ===
        JSON.stringify(wf[sizeId].inputs.image),
    );
    expect(trims).toHaveLength(1);
    const [trimId, trim] = trims[0];
    expect(trim.inputs.batch_index).toBe(0);
    expect(trim.inputs.length).toEqual([capId, 1]);
    // Everything downstream of the source reads the capped clip.
    const [, pad] = byClass(wf, "ComfyMathExpression").find(
      ([id]) => id !== capId,
    )!;
    expect(pad.inputs["values.a"]).toEqual([capId, 1]);
    const [, batch] = one(wf, "ImageBatch");
    expect(batch.inputs.image1).toEqual([trimId, 0]);
    const last = byClass(wf, "ImageFromBatch").find(
      ([, n]) => n.inputs.batch_index === -1,
    )!;
    expect(last[1].inputs.image).toEqual([trimId, 0]);
  });

  it("skips the frame the sampler prepends, so output frame i is source frame i", () => {
    // WanVideoSampler feeds [frame 0, frames..., last x3] to the LQ projection,
    // so decoded frame i+1 is source frame i (measured 1-frame lag at index 0).
    const wf = load(FLASHVSR);
    const [, create] = one(wf, "CreateVideo");
    const cut = wf[(create.inputs.images as [string, number])[0]];
    expect(cut.inputs.batch_index).toBe(1);
    // Padding leaves at least one frame past the clip for the shifted cut.
    const [, math] = byClass(wf, "ComfyMathExpression").find(
      ([, n]) => !String(n.inputs.expression).startsWith("min("),
    )!;
    const expr = String(math.inputs.expression);
    const pad = (a: number) =>
      Number(
        Function(
          "a",
          `return ${expr.replace(/\(([^()]+)\) \/\/ 4/, "Math.floor(($1) / 4)")}`,
        )(a),
      );
    for (const a of [1, 2, 4, 5, 96, 97, 98, 360]) {
      expect(pad(a)).toBeGreaterThanOrEqual(a + 1);
      expect((pad(a) - 1) % 4).toBe(0);
      expect(pad(a) - a).toBeLessThanOrEqual(4);
    }
  });

  it("throws without a source video", () => {
    expect(() =>
      buildFlashvsrUpscaleWorkflow(load(FLASHVSR), run([]), 0, {}),
    ).toThrow(/no video/);
  });
});

describe("ltx_upscale_x2", () => {
  it("loads the pixel upscaler IC-LoRA at 1.0 on the distilled model", () => {
    const wf = load(LTX);
    const [loraId, lora] = one(wf, "LoraLoaderModelOnly");
    expect(lora.inputs).toMatchObject({
      lora_name: LTX_LORA,
      strength_model: 1,
    });
    const [, params] = one(wf, "GetICLoRAParameters");
    expect(params.inputs.iclora_model).toEqual([loraId, 0]);
    const [, ctx] = one(wf, "LTXVContextWindows");
    expect(ctx.inputs.model).toEqual([loraId, 0]);
  });

  it("output is exactly 2x the guide (reference_downscale_factor 2)", () => {
    const wf = load(LTX);
    const [, latent] = one(wf, "EmptyLTXVLatentVideo");
    const [, guide] = one(wf, "LTXVAddGuide");
    const scale = wf[(guide.inputs.image as [string, number])[0]];
    for (const [dim, src] of [
      ["width", "width"],
      ["height", "height"],
    ] as const) {
      const doubled = wf[(latent.inputs[dim] as [string, number])[0]];
      expect(doubled.inputs.expression).toBe("2 * a");
      expect(doubled.inputs["values.a"]).toEqual(scale.inputs[src]);
    }
  });

  it("sets the source clip and seed and exposes the prompt slots", () => {
    const { workflow, slots, seed } = buildLtxUpscaleX2Workflow(
      load(LTX),
      run(),
      0,
      { seed: 1234 },
    );
    const [loadId, loadNode] = one(workflow, "LoadVideo");
    expect(loadNode.inputs.file).toBe("video/fox.mp4 [output]");
    expect(slots.imageInputId).toBe(loadId);
    expect(one(workflow, "RandomNoise")[1].inputs.noise_seed).toBe(1234);
    expect(seed).toBe(1234);
    expect(workflow[slots.posTextId].class_type).toBe("CLIPTextEncode");
    expect(workflow[slots.negTextId].class_type).toBe("CLIPTextEncode");
    expect(slots.posTextId).not.toBe(slots.negTextId);
    // No seed param: the source job's seed.
    expect(buildLtxUpscaleX2Workflow(load(LTX), run([VID], 5), 0).seed).toBe(5);
  });
});

describe("Upscale video engine picker", () => {
  const spec = getActionTool("upscale_video")!;

  it("Fast stays the default; the new engines route to their actions", () => {
    expect(buildActionRequest(spec, settings({}), null).action).toBe(
      "video_upscale",
    );
    expect(
      buildActionRequest(
        spec,
        settings({ engine: "flashvsr", scale: "4k" }),
        null,
      ),
    ).toEqual({
      action: FLASHVSR_UPSCALE_ACTION,
      params: { scale: "4k" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        settings({ engine: "ltx_x2", scale: "4k" }),
        null,
      ),
    ).toEqual({ action: LTX_UPSCALE_X2_ACTION, params: {}, overrides: {} });
  });

  it("Size hides for LTX x2 (always 2x); Model only shows for Best", () => {
    const size = spec.pickers!.find((p) => p.key === "scale")!;
    const model = spec.pickers!.find((p) => p.key === "model")!;
    for (const engine of ["fast", "best", "flashvsr"])
      expect(pickerVisible(size, spec, settings({ engine }))).toBe(true);
    expect(pickerVisible(size, spec, settings({ engine: "ltx_x2" }))).toBe(
      false,
    );
    expect(pickerVisible(model, spec, settings({ engine: "flashvsr" }))).toBe(
      false,
    );
  });

  it("hidden model-check tools gate each engine on its own weights", () => {
    for (const [id, pack] of [
      [FLASHVSR_UPSCALE_ACTION, "flashvsr"],
      [LTX_UPSCALE_X2_ACTION, "ltx25"],
    ]) {
      const t = getActionTool(id)!;
      expect(t).toMatchObject({
        hidden: true,
        requireStatusEntry: true,
        modelCheck: { pack, action: id },
      });
      expect(t.videoInput).toBeTruthy();
    }
    const blocks = optionBlocksFor(
      spec,
      new Set(["utility", "seedvr2", "flashvsr", "ltx25"]),
      null,
      {
        tools: {
          upscale_video: { missing: [] },
          upscale_seedvr2: { missing: [] },
          flashvsr_upscale: {
            missing: ["vae/Wan2_1_FlashVSR_TCDecoder_fp32.safetensors"],
          },
          ltx_upscale_x2: { missing: [] },
          rtx_upscale: { missing: [] },
        },
      } as never,
    );
    expect(Object.keys(blocks?.engine ?? {})).toEqual(["flashvsr"]);
    const card = { optionBlocks: blocks };
    expect(pickBlock(card, spec, settings({ engine: "flashvsr" }))).toBe(
      blocks!.engine.flashvsr,
    );
    expect(pickBlock(card, spec, settings({ engine: "ltx_x2" }))).toBeNull();
  });

  it("builds end to end from the card", () => {
    for (const engine of ["flashvsr", "ltx_x2"]) {
      const req = buildActionRequest(spec, settings({ engine }), null);
      const file = req.action === FLASHVSR_UPSCALE_ACTION ? FLASHVSR : LTX;
      const { workflow } = actionBuilderFor(req.action)!(
        load(file),
        run(),
        0,
        req.params,
      );
      expect(one(workflow, "LoadVideo")[1].inputs.file).toBe(
        "video/fox.mp4 [output]",
      );
    }
  });
});

describe("models + licences", () => {
  it("lists every weight each graph loads", () => {
    const files = (rel: string) =>
      workflowModelRequirements(load(rel)).map((r) => `${r.dir}/${r.file}`);
    expect(files(FLASHVSR)).toEqual([
      "diffusion_models/WanVideo/FlashVSR/Wan2_1_FlashVSR_LQ_proj_model_bf16.safetensors",
      "diffusion_models/WanVideo/FlashVSR/Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors",
      "text_encoders/umt5-xxl-enc-fp8_e4m3fn.safetensors",
      "vae/Wan2_1_FlashVSR_TCDecoder_fp32.safetensors",
    ]);
    expect(files(LTX)).toContain(`loras/${LTX_LORA}`);
  });

  it("FlashVSR + umT5 are Apache-2.0; the LTX LoRA is LTX-licence gated", () => {
    for (const f of [
      "diffusion_models/WanVideo/FlashVSR/Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors",
      "vae/Wan2_1_FlashVSR_TCDecoder_fp32.safetensors",
    ])
      expect(familyFor(f)).toMatchObject({
        id: "flashvsr",
        license: "Apache-2.0",
        commercial: "yes",
      });
    expect(
      familyFor("text_encoders/umt5-xxl-enc-fp8_e4m3fn.safetensors"),
    ).toMatchObject({ id: "wan-shared", commercial: "yes" });
    expect(familyFor(`loras/${LTX_LORA}`)).toMatchObject({
      id: "ltx-25-vfx",
      license: "LTX-2 Community License",
      commercial: "restricted",
    });
    const sizes = (
      modelSizes as unknown as {
        files: Record<string, { gated?: boolean; source: string }>;
      }
    ).files;
    expect(sizes[path.basename(LTX_LORA)]).toMatchObject({
      source: "Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler",
      gated: true,
    });
    const classes = (weightClasses as { classes: Record<string, string> })
      .classes;
    expect(classes["action:flashvsr_upscale"]).toBe("open");
    expect(classes["action:ltx_upscale_x2"]).toBe("cap");
  });

  it("the card's doc lists all engine graphs", () => {
    expect(actionsForTool(getActionTool("upscale_video")!)).toEqual(
      expect.arrayContaining([
        "seedvr2_upscale",
        FLASHVSR_UPSCALE_ACTION,
        LTX_UPSCALE_X2_ACTION,
      ]),
    );
  });

  it("download commands land where the graph reads", () => {
    const info = { source: "Kijai/WanVideo_comfy" };
    expect(
      downloadCommand(
        "Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors",
        "diffusion_models/WanVideo/FlashVSR/",
        info,
      ).command,
    ).toBe(
      `hf download Kijai/WanVideo_comfy FlashVSR/Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors --local-dir "$COMFYUI/models/diffusion_models/WanVideo"`,
    );
    expect(
      downloadCommand(
        "Wan2_1_FlashVSR_TCDecoder_fp32.safetensors",
        "vae/",
        info,
      ).command,
    ).toBe(
      `hf download Kijai/WanVideo_comfy FlashVSR/Wan2_1_FlashVSR_TCDecoder_fp32.safetensors --local-dir "$COMFYUI/models/vae" && mv "$COMFYUI/models/vae/FlashVSR/Wan2_1_FlashVSR_TCDecoder_fp32.safetensors" "$COMFYUI/models/vae/"`,
    );
  });
});
