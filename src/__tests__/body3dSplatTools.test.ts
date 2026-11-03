/**
 * 3D Splat (TripoSplat, packs/triposplat/image_to_splat.json) and Body 3D
 * (SAM 3D Body, packs/sam3d-body/body_3d.json): builders, registry / pack /
 * routing wiring, tools-page requests, hub cards and the 3D-file download
 * helpers the gallery, lightbox and runner use.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { getPack } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { routeBackend } from "@/lib/comfy/backends";
import { isMeshFilename, jobMediaFromHistory } from "@/lib/comfy/outputs";
import {
  buildImageToSplatWorkflow,
  SPLAT_ID,
  splatFormat,
  splatMesh,
} from "@/lib/oj/imageToSplat";
import {
  BODY_3D_MAX_SECONDS,
  BODY_ID,
  body3dFile,
  body3dView,
  buildBody3dWorkflow,
} from "@/lib/oj/body3d";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { mediaVariants } from "@/lib/tools/toolRegistry";
import { galleryTileCount, meshDownloads, meshExt } from "@/lib/galleryMedia";
import { downloadTarget } from "@/lib/gallerySelection";
import { isMeshFile } from "@/lib/mesh/usdz";
import { outputBucket } from "@/lib/jobs/recentRuns";

const PACKS = path.join(process.cwd(), "public/workflows/packs");
const load = (rel: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(PACKS, rel), "utf8"),
  ) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;
};

const view = (name: string) =>
  `http://h/api/comfy/view?filename=${name}&subfolder=&type=input`;

function run(opts: { image?: boolean; video?: boolean; seed?: number }) {
  return {
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: "2026-10-28T00:00:00Z",
    status: "done",
    params: {},
    jobs: [
      {
        seed: opts.seed ?? 5,
        index: 0,
        status: "done",
        progress: 100,
        images: opts.image ? [view("pip.png")] : [],
        ...(opts.video ? { videos: [view("dance.mp4")] } : {}),
      },
    ],
  } as unknown as ImagineRun;
}

/** Every [id, slot] link points at a node that exists. */
function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && !wf[v[0]]) {
        out.push(`${id}.${key}->${v[0]}`);
      }
    }
  }
  return out;
}

const classes = (wf: Workflow) =>
  new Set(Object.values(wf).map((n) => n.class_type));

describe("image_to_splat builder", () => {
  const base = load("triposplat/image_to_splat.json");

  it("patches the image, writes a .ply splat + turntable, no mesh by default", () => {
    const { workflow, seed, slots } = buildImageToSplatWorkflow(
      base,
      run({ image: true }),
      0,
      { seed: 42 },
    );
    expect(workflow[SPLAT_ID.loadImage].inputs.image).toBe("pip.png [input]");
    expect(workflow[SPLAT_ID.toFile].inputs.format).toBe("ply");
    expect(seed).toBe(42);
    expect(workflow[SPLAT_ID.sampler].inputs.seed).toBe(42);
    expect(workflow[SPLAT_ID.decode].inputs.seed).toBe(42);
    expect(workflow[SPLAT_ID.toMesh]).toBeUndefined();
    expect(workflow[SPLAT_ID.saveMesh]).toBeUndefined();
    expect(workflow[SPLAT_ID.saveSplat].class_type).toBe("SaveGLB");
    expect(workflow[SPLAT_ID.render].class_type).toBe("RenderSplat");
    expect(workflow[SPLAT_ID.saveVideo].class_type).toBe("SaveVideo");
    expect(slots.imageInputId).toBe(SPLAT_ID.loadImage);
    expect(danglingLinks(workflow)).toEqual([]);
    // Base graph is not mutated.
    expect(base[SPLAT_ID.toMesh]).toBeDefined();
  });

  it("detailed mesh raises the grid and keeps the mesh nodes", () => {
    const build = (mesh: string) =>
      buildImageToSplatWorkflow(base, run({ image: true }), 0, { mesh }).workflow;
    expect(splatMesh("detailed")).toBe(true);
    expect(build("on")[SPLAT_ID.toMesh].inputs.resolution).toBe(384);
    expect(build("detailed")[SPLAT_ID.toMesh].inputs.resolution).toBe(576);
    expect(build("detailed")[SPLAT_ID.saveMesh]).toBeDefined();
  });

  it("spz + mesh keeps SplatToMesh and its SaveGLB", () => {
    const { workflow } = buildImageToSplatWorkflow(
      base,
      run({ image: true }),
      0,
      {
        format: "spz",
        mesh: "on",
      },
    );
    expect(workflow[SPLAT_ID.toFile].inputs.format).toBe("spz");
    expect(workflow[SPLAT_ID.toMesh].class_type).toBe("SplatToMesh");
    expect(workflow[SPLAT_ID.saveMesh].inputs.mesh).toEqual([
      SPLAT_ID.toMesh,
      0,
    ]);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("knob parsers, random seed and missing source", () => {
    expect(splatFormat("SPZ")).toBe("spz");
    expect(splatFormat("glb")).toBe("ply");
    expect(splatMesh("on")).toBe(true);
    expect(splatMesh(true)).toBe(true);
    expect(splatMesh(undefined)).toBe(false);
    expect(splatMesh("off")).toBe(false);
    const { seed } = buildImageToSplatWorkflow(base, run({ image: true }), 0);
    expect(Number.isInteger(seed) && seed >= 0).toBe(true);
    expect(() => buildImageToSplatWorkflow(base, run({}), 0)).toThrow(
      /no image/,
    );
  });
});

describe("body_3d builder", () => {
  const base = load("sam3d-body/body_3d.json");

  it("clip: first N s, smoothed, overlay render to mp4, .glb file", () => {
    const { workflow, slots, seed } = buildBody3dWorkflow(
      base,
      run({ video: true, image: true }),
      0,
      {},
    );
    expect(workflow[BODY_ID.loadVideo].inputs.file).toBe("dance.mp4 [input]");
    expect(workflow[BODY_ID.slice].inputs.duration).toBe(BODY_3D_MAX_SECONDS);
    expect(workflow[BODY_ID.loadImage]).toBeUndefined();
    expect(workflow[BODY_ID.saveImage]).toBeUndefined();
    expect(workflow[BODY_ID.render].inputs.pose_data).toEqual([BODY_ID.smooth, 0]);
    expect(workflow[BODY_ID.render].inputs.background).toEqual([
      BODY_ID.components,
      0,
    ]);
    expect(workflow[BODY_ID.poseFile].inputs.format).toBe("glb");
    expect(workflow[BODY_ID.saveVideo].class_type).toBe("SaveVideo");
    expect(workflow[BODY_ID.saveFile].class_type).toBe("SaveGLB");
    expect(slots.imageInputId).toBe(BODY_ID.loadVideo);
    expect(seed).toBe(5);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("photo: LoadImage feeds detect/predict/render, png + glb, no smoothing", () => {
    const { workflow, slots } = buildBody3dWorkflow(
      base,
      run({ video: true, image: true }),
      0,
      { media: "image" },
    );
    for (const id of [
      BODY_ID.loadVideo,
      BODY_ID.slice,
      BODY_ID.components,
      BODY_ID.createVideo,
      BODY_ID.saveVideo,
      BODY_ID.smooth,
    ])
      expect(workflow[id], id).toBeUndefined();
    expect(workflow[BODY_ID.loadImage].inputs.image).toBe("pip.png [input]");
    expect(workflow[BODY_ID.detect].inputs.image).toEqual([
      BODY_ID.loadImage,
      0,
    ]);
    expect(workflow[BODY_ID.render].inputs.pose_data).toEqual([BODY_ID.face, 0]);
    expect(workflow[BODY_ID.poseFile].inputs.fps).toBe(24);
    expect(workflow[BODY_ID.saveImage].inputs.images).toEqual([
      BODY_ID.render,
      0,
    ]);
    expect(slots.imageInputId).toBe(BODY_ID.loadImage);
    expect(danglingLinks(workflow)).toEqual([]);
    // No clip → photo path even without media=image.
    const still = buildBody3dWorkflow(base, run({ image: true }), 0, {});
    expect(still.workflow[BODY_ID.loadVideo]).toBeUndefined();
  });

  it("skeleton view, .bvh, raw motion, no face", () => {
    const { workflow } = buildBody3dWorkflow(base, run({ video: true }), 0, {
      view: "skeleton",
      file: "bvh",
      smooth: "off",
      face: "off",
    });
    const render = workflow[BODY_ID.render].inputs;
    expect(render.render_style).toBe("openpose_2d");
    expect(render["render_style.shader"]).toBeUndefined();
    expect(render["render_style.face_style"]).toBe("disabled");
    expect(render.pose_data).toEqual([BODY_ID.predict, 0]);
    const file = workflow[BODY_ID.poseFile].inputs;
    expect(file.format).toBe("bvh");
    expect(file["format.units"]).toBe("cm");
    expect(file["format.mesh_style"]).toBeUndefined();
    expect(file.pose_data).toEqual([BODY_ID.predict, 0]);
    expect(workflow[BODY_ID.smooth]).toBeUndefined();
    expect(workflow[BODY_ID.face]).toBeUndefined();
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("solo view drops the background; parsers; missing source", () => {
    const { workflow } = buildBody3dWorkflow(base, run({ image: true }), 0, {
      view: "solo",
    });
    expect(workflow[BODY_ID.render].inputs.background).toBeUndefined();
    expect(body3dView("SKELETON")).toBe("skeleton");
    expect(body3dView("x")).toBe("mesh");
    expect(body3dFile("bvh")).toBe("bvh");
    expect(body3dFile(undefined)).toBe("glb");
    expect(() => buildBody3dWorkflow(base, run({}), 0, {})).toThrow(
      /no image or video/,
    );
  });
});

describe("registry / packs / routing wiring", () => {
  it.each([
    [
      "image_to_splat",
      "triposplat",
      "packs/triposplat/image_to_splat.json",
      true,
    ],
    ["body_3d", "sam3d-body", "packs/sam3d-body/body_3d.json", false],
  ])("%s", (action, pack, rel, requiresImage) => {
    const actions = registry.actions as Record<
      string,
      { template: string; requiresImage?: boolean }
    >;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[action].requiresImage).toBe(requiresImage);
    expect(templates[actions[action].template].file).toBe(rel);
    expect(getPack(pack)?.workflows[action]).toBe(rel);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    const raw = fs.readFileSync(
      path.join(process.cwd(), "public/workflows", rel),
      "utf8",
    );
    expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
    vi.stubEnv("COMFY_VIDEO_HTTP_URL", "http://video:8188");
    try {
      expect(routeBackend({ action, workflowPath: rel })).toBe("video");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("graphs use core nodes for splat + body", () => {
    const splat = classes(load("triposplat/image_to_splat.json"));
    for (const c of [
      "TripoSplatPreprocessImage",
      "TripoSplatConditioning",
      "VAEDecodeTripoSplat",
      "SplatToFile3D",
      "RenderSplat",
      "SplatToMesh",
    ])
      expect(splat.has(c), c).toBe(true);
    const body = classes(load("sam3d-body/body_3d.json"));
    for (const c of [
      "SAM3DBody_Loader",
      "SAM3DBody_Predict",
      "SAM3DBody_FaceExpression",
      "SAM3DBody_Smooth",
      "SAM3DBody_Render",
      "BuildPoseFile",
      "RTDETR_detect",
    ])
      expect(body.has(c), c).toBe(true);
  });
});

describe("tools page + hub", () => {
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(),
    ...over,
  });

  it("image_to_splat request: .ply, no mesh by default", () => {
    const spec = getActionTool("image_to_splat")!;
    expect(spec.category).toBe("Animate & 3D");
    expect(spec.modelCheck).toEqual({
      pack: "triposplat",
      action: "image_to_splat",
    });
    expect(buildActionRequest(spec, settings(), null)).toEqual({
      action: "image_to_splat",
      params: { pack_id: "triposplat", format: "ply", mesh: "off" },
      overrides: {},
    });
    const spz = buildActionRequest(
      spec,
      settings({ picks: { format: "spz", mesh: "on" }, seed: 9 }),
      null,
    );
    expect(spz.params).toMatchObject({ format: "spz", mesh: "on", seed: 9 });
  });

  it("body_3d photo vs clip requests", () => {
    const photo = getActionTool("body_3d")!;
    const clip = getActionTool("body_3d_video")!;
    expect(photo.videoInput).toBeUndefined();
    expect(clip.videoInput).toContain(`${BODY_3D_MAX_SECONDS} s`);
    expect(clip.videoWindow).toEqual({ seconds: BODY_3D_MAX_SECONDS });
    expect(buildActionRequest(photo, settings(), null)).toEqual({
      action: "body_3d",
      params: {
        pack_id: "sam3d-body",
        media: "image",
        view: "mesh",
        file: "glb",
      },
      overrides: {},
    });
    expect(buildActionRequest(clip, settings(), null).params).toEqual({
      pack_id: "sam3d-body",
      media: "video",
      view: "mesh",
      file: "glb",
      smooth: "on",
    });
    expect(
      buildActionRequest(
        clip,
        settings({ picks: { smooth: "off", file: "bvh", view: "skeleton" } }),
        null,
      ).params,
    ).toMatchObject({ smooth: "off", file: "bvh", view: "skeleton" });
  });

  it("hub cards and the photo/video switch", () => {
    expect(CARD_OVERRIDES["action:image_to_splat"]).toMatchObject({
      hub: "Image",
      title: "3D Splat",
    });
    expect(CARD_OVERRIDES["action:body_3d"].hub).toBe("Image");
    expect(CARD_OVERRIDES["action:body_3d_video"].hub).toBe("Video");
    expect(mediaVariants("body_3d")?.map((v) => v.id)).toEqual([
      "body_3d",
      "body_3d_video",
    ]);
  });
});

describe("3D outputs: parsing + downloads", () => {
  it("SaveGLB splat / bvh outputs land in meshes", () => {
    for (const name of ["a.ply", "a.spz", "a.glb", "a.bvh"]) {
      expect(isMeshFilename(name), name).toBe(true);
      expect(isMeshFile(name), name).toBe(true);
      expect(outputBucket(`3d/${name}`, null)).toBe("meshes");
    }
    const media = jobMediaFromHistory({
      outputs: {
        "13": {
          "3d": [{ filename: "s_00001_.ply", subfolder: "3d", type: "output" }],
        },
        "17": {
          images: [
            { filename: "t_00001_.mp4", subfolder: "video", type: "output" },
          ],
          animated: [true],
        },
      },
    });
    expect(media.meshes).toHaveLength(1);
    expect(media.meshes[0]).toContain("s_00001_.ply");
    expect(media.videos).toHaveLength(1);
    expect(media.images).toEqual([]);
  });

  it("meshExt / meshDownloads / downloadTarget name the real file type", () => {
    const ply =
      "/api/comfy/image?filename=s_00001_.ply&subfolder=3d&type=output";
    const glb =
      "/api/comfy/image?filename=m_00001_.glb&subfolder=3d&type=output";
    const bvh =
      "/api/comfy/image?filename=b_00001_.bvh&subfolder=3d&type=output";
    expect(meshExt(ply)).toBe(".ply");
    expect(meshExt(bvh)).toBe(".bvh");
    expect(meshExt("/x/y.SPZ")).toBe(".spz");
    expect(meshExt(undefined)).toBe(".glb");
    expect(meshDownloads([ply, glb, undefined, ply])).toEqual([
      { href: ply, label: "Download PLY" },
      { href: glb, label: "Download GLB" },
    ]);
    expect(
      meshDownloads([glb, glb.replace("m_", "n_")]).map((d) => d.label),
    ).toEqual(["Download GLB 1", "Download GLB 2"]);
    const t = downloadTarget({ id: "g1", url: "", seed: 1, meshUrl: ply });
    expect(t?.href).toBe(ply);
    expect(t?.filename).toMatch(/\.ply$/);
    // Turntable + splat: the tile downloads the clip; the lightbox offers
    // the splat separately.
    const v = downloadTarget({
      id: "g2",
      url: "",
      seed: 1,
      videoUrl: "/v.mp4",
      meshUrl: ply,
    });
    expect(v?.filename).toMatch(/\.mp4$/);
    expect(
      galleryTileCount({
        status: "done",
        images: [],
        videos: ["/v.mp4"],
        meshes: [ply],
      } as never),
    ).toBe(1);
  });
});
