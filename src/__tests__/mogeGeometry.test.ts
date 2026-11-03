/**
 * Depth & Normals (MoGe-2 / MoGe-3): graph shape, builder variants (photo /
 * panorama, mesh light (default) / full / preview / off, normal + depth conventions, detail,
 * opt-in MoGe-3 giant), live node
 * classes, registry, routing, hub card, tool spec → request, and the history
 * text output that carries the FOV.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  MOGE3_REFINE_STEPS,
  MOGE_DETAIL_LEVELS,
  MOGE_GEOMETRY_ACTION,
  MOGE_ID,
  buildMogeGeometryWorkflow,
  mogeDetail,
  mogeMesh,
  mogeModel,
  mogeSource,
} from "@/lib/oj/mogeGeometry";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { historyTexts } from "@/lib/comfy/outputs";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { TOOL_NAMES } from "@/lib/tools/toolNames";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const FILE = "packs/image-tools/moge_geometry.json";
const RAW = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/workflows", FILE), "utf-8"),
);
const load = (): Workflow => {
  const { _meta, ...wf } = structuredClone(RAW);
  return wf as Workflow;
};

/** Live /object_info dump (opt-in, as in liveObjectInfoTools.test.ts). */
const LIVE_INFO_FILE = process.env.LIVE_OBJECT_INFO;
const LIVE: Record<string, unknown> | null =
  LIVE_INFO_FILE && fs.existsSync(LIVE_INFO_FILE)
  ? JSON.parse(fs.readFileSync(LIVE_INFO_FILE, "utf-8"))
  : null;

const IMG = "/api/comfy/view?filename=room.png&subfolder=&type=input";
const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 768,
    jobs: [{ seed: 3, index: 0, status: "done", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
  }) as unknown as ImagineRun;

const build = (params: Record<string, unknown> = {}) =>
  buildMogeGeometryWorkflow(load(), run([IMG]), 0, params).workflow;

const classes = (wf: Workflow) => Object.values(wf).map((n) => n.class_type);

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
    }
  }
}

const VARIANTS: Record<string, unknown>[] = [
  {},
  { source: "panorama" },
  { source: "panorama", mesh: "off" },
  { mesh: "light", depth: "colored", normals: "directx", detail: "fast" },
  { mesh: "off" },
  { model: "moge3" },
  { source: "panorama", model: "moge3", mesh: "off" },
];

describe("moge_geometry graph", () => {
  it("is LoadImage -> MoGe-2 -> depth / normals / GLB / FOV text", () => {
    const wf = load();
    expectLinksResolve(wf);
    expect(wf[MOGE_ID.model].inputs.model_name).toBe(
      "moge_2_vitl_normal_fp16.safetensors",
    );
    expect(wf[MOGE_ID.infer].class_type).toBe("MoGeInference");
    expect(wf[MOGE_ID.depth].inputs.output).toBe("depth");
    expect(wf[MOGE_ID.normal].inputs.output).toBe("normal_opengl");
    expect(wf[MOGE_ID.saveMesh]).toMatchObject({
      class_type: "SaveGLB",
      inputs: { mesh: [MOGE_ID.mesh, 0] },
    });
    expect(wf[MOGE_ID.fovText].inputs).toMatchObject({
      "values.a": [MOGE_ID.fovH, 0],
      "values.b": [MOGE_ID.fovV, 0],
      "values.c": [MOGE_ID.fovH, 1],
    });
    expect(wf[MOGE_ID.fovOut].class_type).toBe("PreviewAny");
  });

  it("ships MoGe-3 giant as an optional, unwired loader", () => {
    const wf = load();
    expect(wf[MOGE_ID.modelV3]).toMatchObject({
      class_type: "LoadMoGeModel",
      inputs: { model_name: "moge_3_vitg_fp16.safetensors" },
      _meta: { optional: true },
    });
    expect(wf[MOGE_ID.infer].inputs.moge_model).toEqual([MOGE_ID.model, 0]);
  });

  it.skipIf(!LIVE)(
    "uses only node classes and inputs present on the GPU box",
    () => {
      for (const params of VARIANTS) {
        const wf = build(params);
        for (const node of Object.values(wf)) {
          const spec = LIVE![node.class_type] as
            { input: { required?: object; optional?: object } } | undefined;
          expect(spec, node.class_type).toBeDefined();
          const known = new Set([
            ...Object.keys(spec!.input.required ?? {}),
            ...Object.keys(spec!.input.optional ?? {}),
          ]);
          for (const name of Object.keys(node.inputs))
            expect(
              known.has(name.split(".")[0]),
              `${node.class_type}.${name}`,
            ).toBe(true);
        }
      }
      const opts = (LIVE!.LoadMoGeModel as any).input.required.model_name;
      expect(JSON.stringify(opts)).toContain(
        "moge_2_vitl_normal_fp16.safetensors",
      );
      expect(JSON.stringify(opts)).toContain("moge_3_vitg_fp16.safetensors");
      const infer = LIVE!.MoGeInference as any;
      expect(
        infer.input.required.refine_steps ?? infer.input.optional?.refine_steps,
      ).toBeDefined();
    },
  );
});

describe("moge_geometry builder", () => {
  it("patches the source image and keeps the photo defaults", () => {
    const { workflow, slots, seed } = buildMogeGeometryWorkflow(
      load(),
      run([IMG]),
      0,
      {},
    );
    expect(workflow[MOGE_ID.loadImage].inputs.image).toBe("room.png [input]");
    expect(slots.imageInputId).toBe(MOGE_ID.loadImage);
    expect(seed).toBe(3);
    expect(workflow[MOGE_ID.infer].inputs.resolution_level).toBe(9);
    // Stride 2 by default: a full-res point map is ~830k verts / ~38 MB.
    expect(workflow[MOGE_ID.mesh].inputs.decimation).toBe(2);
    expect(classes(workflow)).toContain("MoGeGeometryToFOV");
    expect(workflow[MOGE_ID.modelV3]).toBeUndefined();
    expect(workflow[MOGE_ID.model].inputs.model_name).toBe(
      "moge_2_vitl_normal_fp16.safetensors",
    );
    expect(workflow[MOGE_ID.infer].inputs.refine_steps).toBe(0);
  });

  it("MoGe-3 rewires inference to the giant loader and refines", () => {
    for (const source of ["photo", "panorama"]) {
      const wf = build({ model: "moge3", source });
      expectLinksResolve(wf);
      expect(wf[MOGE_ID.model]).toBeUndefined();
      expect(wf[MOGE_ID.modelV3].inputs.model_name).toBe(
        "moge_3_vitg_fp16.safetensors",
      );
      expect(wf[MOGE_ID.modelV3]._meta?.optional).toBeUndefined();
      expect(wf[MOGE_ID.infer].inputs).toMatchObject({
        moge_model: [MOGE_ID.modelV3, 0],
        refine_steps: MOGE3_REFINE_STEPS,
      });
    }
  });

  it("panorama swaps inference and drops the FOV nodes", () => {
    const wf = build({ source: "panorama", detail: "balanced" });
    expectLinksResolve(wf);
    expect(wf[MOGE_ID.infer]).toMatchObject({
      class_type: "MoGePanoramaInference",
      inputs: {
        moge_model: [MOGE_ID.model, 0],
        image: [MOGE_ID.loadImage, 0],
        resolution_level: MOGE_DETAIL_LEVELS.balanced,
      },
    });
    expect(classes(wf)).not.toContain("MoGeGeometryToFOV");
    expect(classes(wf)).not.toContain("PreviewAny");
    expect(classes(wf)).toContain("SaveGLB");
  });

  it("mesh light / off, normal and depth conventions", () => {
    const light = build({
      mesh: "light",
      normals: "directx",
      depth: "colored",
      detail: "fast",
    });
    expect(light[MOGE_ID.mesh].inputs.decimation).toBe(2);
    expect(light[MOGE_ID.normal].inputs.output).toBe("normal_directx");
    expect(light[MOGE_ID.depth].inputs.output).toBe("depth_colored");
    expect(light[MOGE_ID.infer].inputs.resolution_level).toBe(3);
    expect(build({ mesh: "full" })[MOGE_ID.mesh].inputs.decimation).toBe(1);
    expect(build({ mesh: "preview" })[MOGE_ID.mesh].inputs.decimation).toBe(4);
    const off = build({ mesh: "off" });
    expectLinksResolve(off);
    expect(classes(off)).not.toContain("SaveGLB");
    expect(classes(off)).not.toContain("MoGePointMapToMesh");
    expect(classes(off).filter((c) => c === "SaveImage")).toHaveLength(2);
  });

  it("sanitizes params", () => {
    expect(mogeSource("PANORAMA")).toBe("panorama");
    expect(mogeSource(3)).toBe("photo");
    expect(mogeMesh("bogus")).toBe("light");
    expect(mogeMesh("FULL")).toBe("full");
    expect(mogeMesh("preview")).toBe("preview");
    expect(mogeDetail("bogus")).toBe(9);
    expect(mogeModel("MoGe3")).toBe("moge3");
    expect(mogeModel("vitg")).toBe("moge2");
  });

  it("refuses a run without an image", () => {
    expect(() => buildMogeGeometryWorkflow(load(), run([]), 0, {})).toThrow(
      /no image/,
    );
  });
});

describe("moge_geometry registration", () => {
  it("is registered, routed to the video host and on the Image hub", () => {
    const reg = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(reg.templates.moge_geometry.file).toBe(FILE);
    expect(reg.actions.moge_geometry).toMatchObject({
      template: "moge_geometry",
      requiresImage: true,
    });
    expect(actionBuilderFor(MOGE_GEOMETRY_ACTION)).toBe(
      buildMogeGeometryWorkflow,
    );
    expect(
      resolveWorkflow({ templateOrAction: MOGE_GEOMETRY_ACTION }).workflowPath,
    ).toBe(FILE);
    expect(DEFAULT_VIDEO_PACKS).toContain("image-tools");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({ action: MOGE_GEOMETRY_ACTION, workflowPath: FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
    expect(CARD_OVERRIDES["action:moge_geometry"]).toMatchObject({
      hub: "Image",
      model: "MoGe-2 / MoGe-3",
    });
    expect(TOOL_NAMES["action:moge_geometry"].aliases).toContain("depth map");
  });

  it("tool spec sends the picks", () => {
    const spec = getActionTool("moge_geometry")!;
    expect(spec.modelCheck).toEqual({
      pack: "image-tools",
      action: "moge_geometry",
    });
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null)).toMatchObject({
      action: "moge_geometry",
      params: {
        source: "photo",
        mesh: "light",
        depth: "gray",
        normals: "opengl",
        detail: "max",
        model: "moge2",
      },
    });
    s.picks.source = "panorama";
    s.picks.mesh = "off";
    s.picks.model = "moge3";
    expect(buildActionRequest(spec, s, null).params).toMatchObject({
      source: "panorama",
      mesh: "off",
      model: "moge3",
    });
  });
});

describe("history texts", () => {
  it("keeps non-empty text outputs", () => {
    expect(
      historyTexts({
        texts: [{ text: " Estimated FOV: 60.0° " }, { text: "" }, {}],
      }),
    ).toEqual(["Estimated FOV: 60.0°"]);
    expect(historyTexts({})).toBeUndefined();
  });
});
