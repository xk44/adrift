/**
 * Material Maps (Marigold V2): graph shape (one single-step branch per map,
 * as in the Comfy-Org blueprints), builder variants (map selection, detail),
 * live node classes, registry, routing, hub card, licence family and the
 * tool spec → request.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  MATERIAL_BRANCH,
  MATERIAL_DETAIL_MP,
  MATERIAL_ID,
  MATERIAL_MAPS_ACTION,
  MATERIAL_MAP_KINDS,
  MATERIAL_OFFSET,
  buildMaterialMapsWorkflow,
  materialBranchIds,
  materialDetailMp,
  materialMapsSelected,
} from "@/lib/oj/materialMaps";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { TOOL_NAMES } from "@/lib/tools/toolNames";
import { MODEL_FAMILIES } from "@/lib/tools/toolsDoc";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const FILE = "packs/qwen-edit-2509/material_maps.json";
const RAW = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/workflows", FILE), "utf-8"),
);
const load = (): Workflow => {
  const { _meta, ...wf } = structuredClone(RAW);
  return wf as Workflow;
};

const LIVE_INFO_FILE = process.env.LIVE_OBJECT_INFO;
const LIVE: Record<string, unknown> | null =
  LIVE_INFO_FILE && fs.existsSync(LIVE_INFO_FILE)
    ? JSON.parse(fs.readFileSync(LIVE_INFO_FILE, "utf-8"))
    : null;

const IMG = "/api/comfy/view?filename=brick.png&subfolder=&type=input";
const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 1024,
    jobs: [{ seed: 5, index: 0, status: "done", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
  }) as unknown as ImagineRun;

const build = (params: Record<string, unknown> = {}) =>
  buildMaterialMapsWorkflow(load(), run([IMG]), 0, params).workflow;

const node = (kind: keyof typeof MATERIAL_BRANCH, offset: number) =>
  String(MATERIAL_BRANCH[kind] + offset);

function expectLinksResolve(wf: Workflow) {
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
    }
  }
}

const saves = (wf: Workflow) =>
  Object.values(wf)
    .filter((n) => n.class_type === "SaveImage")
    .map((n) => n.inputs.filename_prefix);

const FILES = {
  depth: ["marigold_v2_depth_log_stage2", "marigold_v2_depth"],
  normals: ["marigold_v2_normals", "marigold_v2_normals"],
  albedo: ["marigold_v2_albedo", "marigold_v2_albedo"],
} as const;

const VARIANTS: Record<string, unknown>[] = [
  {},
  { depth: "off" },
  { normals: "off", albedo: "off", detail: "high" },
];

describe("material_maps graph", () => {
  it("one blueprint branch per map, sharing image, UNET, sampler and sigmas", () => {
    const wf = load();
    expectLinksResolve(wf);
    expect(wf[MATERIAL_ID.unet].inputs.unet_name).toBe(
      "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
    );
    expect(wf[MATERIAL_ID.sigmas].inputs.sigmas).toBe("0.5, 0");
    expect(wf[MATERIAL_ID.sampler].inputs.sampler_name).toBe("euler");
    expect(wf[MATERIAL_ID.noise].class_type).toBe("DisableNoise");
    expect(wf[MATERIAL_ID.scale].inputs.megapixels).toBe(1);
    for (const kind of MATERIAL_MAP_KINDS) {
      const [lora, cond] = FILES[kind];
      const ids = materialBranchIds(kind);
      expect(ids.map((id) => wf[id].class_type)).toEqual([
        "LoraLoaderModelOnly",
        "ModelSamplingAuraFlow",
        "ConditioningLoader",
        "BasicGuider",
        "VAELoader",
        "VAEEncode",
        "SamplerCustomAdvanced",
        "VAEDecode",
        "MarigoldV2PostProcess",
        "ImageScale",
        "SaveImage",
      ]);
      expect(wf[node(kind, 0)].inputs).toMatchObject({
        model: [MATERIAL_ID.unet, 0],
        lora_name: `${lora}.safetensors`,
        strength_model: 1,
      });
      expect(wf[node(kind, 1)].inputs).toMatchObject({
        shift: 1.73,
        sampling: "img_to_img_velocity",
      });
      expect(wf[node(kind, 2)].inputs.conditioning_name).toBe(
        `${cond}_conditioning.safetensors`,
      );
      expect(wf[node(kind, 4)].inputs.vae_name).toBe(`${lora}_vae.safetensors`);
      expect(wf[node(kind, 5)].inputs.pixels).toEqual([MATERIAL_ID.scale, 0]);
      expect(wf[node(kind, 6)].inputs).toMatchObject({
        noise: [MATERIAL_ID.noise, 0],
        sampler: [MATERIAL_ID.sampler, 0],
        sigmas: [MATERIAL_ID.sigmas, 0],
      });
      expect(
        wf[node(kind, MATERIAL_OFFSET.postProcess)].inputs.prediction,
      ).toBe(kind);
      expect(wf[node(kind, 9)].inputs).toMatchObject({
        width: [MATERIAL_ID.size, 0],
        height: [MATERIAL_ID.size, 1],
      });
      expect(wf[node(kind, MATERIAL_OFFSET.save)].inputs.filename_prefix).toBe(
        `CJ_Marigold/${kind}`,
      );
    }
  });

  it("requires every map's LoRA, VAE and conditioning on disk", () => {
    const files = workflowModelRequirements(load()).map(
      (r) => `${r.dir}/${r.file}`,
    );
    expect(files).toContain(
      "diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
    );
    for (const [lora, cond] of Object.values(FILES)) {
      expect(files).toContain(`loras/${lora}.safetensors`);
      expect(files).toContain(`vae/${lora}_vae.safetensors`);
      expect(files).toContain(`embeddings/${cond}_conditioning.safetensors`);
    }
  });

  it.skipIf(!LIVE)(
    "uses only node classes, inputs and files present on the GPU box",
    () => {
      for (const params of VARIANTS) {
        for (const n of Object.values(build(params))) {
          const spec = LIVE![n.class_type] as
            { input: { required?: object; optional?: object } } | undefined;
          expect(spec, n.class_type).toBeDefined();
          const known = new Set([
            ...Object.keys(spec!.input.required ?? {}),
            ...Object.keys(spec!.input.optional ?? {}),
          ]);
          for (const name of Object.keys(n.inputs))
            expect(known.has(name), `${n.class_type}.${name}`).toBe(true);
        }
      }
      const opts = (cls: string, input: string) =>
        JSON.stringify((LIVE![cls] as any).input.required[input]);
      for (const [lora, cond] of Object.values(FILES)) {
        expect(opts("LoraLoaderModelOnly", "lora_name")).toContain(lora);
        expect(opts("VAELoader", "vae_name")).toContain(`${lora}_vae`);
        expect(opts("ConditioningLoader", "conditioning_name")).toContain(cond);
      }
      expect(opts("MarigoldV2PostProcess", "prediction")).toBe(
        JSON.stringify([
          "COMBO",
          { multiselect: false, options: [...MATERIAL_MAP_KINDS] },
        ]),
      );
    },
  );
});

describe("material_maps builder", () => {
  it("patches the image and keeps all three maps by default", () => {
    const { workflow, slots, seed } = buildMaterialMapsWorkflow(
      load(),
      run([IMG]),
      0,
      {},
    );
    expect(workflow[MATERIAL_ID.loadImage].inputs.image).toBe(
      "brick.png [input]",
    );
    expect(slots.imageInputId).toBe(MATERIAL_ID.loadImage);
    expect(seed).toBe(5);
    expect(saves(workflow)).toEqual([
      "CJ_Marigold/depth",
      "CJ_Marigold/normals",
      "CJ_Marigold/albedo",
    ]);
    expect(workflow[MATERIAL_ID.scale].inputs.megapixels).toBe(
      MATERIAL_DETAIL_MP.standard,
    );
  });

  it("drops unselected branches whole", () => {
    const wf = build({ depth: "off", normals: "off", detail: "high" });
    expectLinksResolve(wf);
    expect(saves(wf)).toEqual(["CJ_Marigold/albedo"]);
    for (const id of [
      ...materialBranchIds("depth"),
      ...materialBranchIds("normals"),
    ])
      expect(wf[id]).toBeUndefined();
    expect(wf[MATERIAL_ID.scale].inputs.megapixels).toBe(2);
    expect(Object.keys(wf)).toHaveLength(
      Object.keys(MATERIAL_ID).length + materialBranchIds("albedo").length,
    );
  });

  it("sanitizes params", () => {
    expect(materialMapsSelected({})).toEqual(["depth", "normals", "albedo"]);
    expect(materialMapsSelected({ depth: false, albedo: "OFF" })).toEqual([
      "normals",
    ]);
    expect(materialDetailMp("bogus")).toBe(1);
    expect(materialDetailMp("High")).toBe(2);
  });

  it("refuses no maps and a run without an image", () => {
    expect(() =>
      build({ depth: "off", normals: "off", albedo: "off" }),
    ).toThrow(/at least one map/);
    expect(() => buildMaterialMapsWorkflow(load(), run([]), 0, {})).toThrow(
      /no image/,
    );
  });
});

describe("material_maps registration", () => {
  it("is registered, routed to the video host and on the Image hub", () => {
    const reg = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(reg.templates.material_maps.file).toBe(FILE);
    expect(reg.actions.material_maps).toMatchObject({
      template: "material_maps",
      requiresImage: true,
    });
    expect(actionBuilderFor(MATERIAL_MAPS_ACTION)).toBe(
      buildMaterialMapsWorkflow,
    );
    expect(
      resolveWorkflow({ templateOrAction: MATERIAL_MAPS_ACTION }).workflowPath,
    ).toBe(FILE);
    expect(DEFAULT_VIDEO_PACKS).toContain("qwen-edit-2509");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({ action: MATERIAL_MAPS_ACTION, workflowPath: FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
    expect(CARD_OVERRIDES["action:material_maps"]).toMatchObject({
      hub: "Image",
      model: "Marigold V2",
    });
    expect(TOOL_NAMES["action:material_maps"].aliases).toContain("pbr");
  });

  it("labels the Marigold V2 weights Apache-2.0", () => {
    const fam = (file: string) =>
      MODEL_FAMILIES.find((f) => f.match.test(file.toLowerCase()));
    for (const [lora, cond] of Object.values(FILES)) {
      for (const f of [
        `loras/${lora}.safetensors`,
        `vae/${lora}_vae.safetensors`,
        `embeddings/${cond}_conditioning.safetensors`,
      ])
        expect(fam(f)).toMatchObject({
          id: "marigold-v2",
          license: "Apache-2.0",
          commercial: "yes",
        });
    }
    expect(
      fam("geometry_estimation/moge_3_vitg_fp16.safetensors"),
    ).toMatchObject({ id: "moge3", license: "MIT" });
  });

  it("tool spec sends the picks and needs at least one map", () => {
    const spec = getActionTool("material_maps")!;
    expect(spec.modelCheck).toEqual({
      pack: "qwen-edit-2509",
      action: "material_maps",
    });
    expect(spec.pickers?.map((p) => p.hint ?? "").join(" ")).toMatch(/PBR/);
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null)).toMatchObject({
      action: "material_maps",
      params: {
        depth: "on",
        normals: "on",
        albedo: "on",
        detail: "standard",
      },
    });
    s.picks.depth = "off";
    s.picks.detail = "high";
    expect(buildActionRequest(spec, s, null).params).toMatchObject({
      depth: "off",
      normals: "on",
      detail: "high",
    });
    s.picks.normals = "off";
    s.picks.albedo = "off";
    expect(() => buildActionRequest(spec, s, null)).toThrow(ToolInputError);
  });
});
