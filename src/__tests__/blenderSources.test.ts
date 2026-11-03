/** Export for Blender beyond plain meshes: MoGe source camera, Layer Split planes. */
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
  blenderOpenBody,
  blenderSourceFor,
  blenderSourceHref,
  mogeFovFromTexts,
  validAspect,
  validFov,
  validLayerManifest,
} from "@/lib/mesh/blenderLinks";
import {
  blenderImportScript,
  fovAspect,
  renderSize,
} from "@/lib/mesh/blenderScript";
import { buildBlenderBundle } from "@/lib/mesh/blenderBundle";
import {
  BundleFetchError,
  blenderSourceFromBody,
  blenderSourceFromQuery,
  loadBlenderSource,
} from "@/lib/mesh/blenderBundleServer";
import {
  canvasDepthUv,
  layerBlenderScript,
  sourceFrame,
} from "@/lib/layers/layerBlender";
import { layerPlanesGlb } from "@/lib/layers/layerGlb";
import { partDepthUv, pngSize, runAspect } from "@/lib/layers/bundle";

const PY = (() => {
  try {
    execFileSync("python3", ["-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Byte-compile generated Python with the real interpreter (syntax check). */
function pyCompiles(src: string): void {
  execFileSync(
    "python3",
    ["-I", "-c", "import sys; compile(sys.stdin.read(), 'gen.py', 'exec')"],
    { input: src },
  );
}

/** Minimal PNG header: enough for pngSize. */
function fakePng(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

function glbJson(glb: Uint8Array): Record<string, any> {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(8, true)).toBe(glb.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

const MOGE_TEXT =
  "Estimated FOV: 63.4° horizontal, 39.6° vertical (focal length 1201 px)";
const text = (d: Uint8Array | string) =>
  typeof d === "string" ? d : new TextDecoder().decode(d);
const glbUrl =
  "/api/comfy/image?filename=adrift_moge_00001_.glb&subfolder=3d&type=output";

describe("blender sources", () => {
  it("reads the MoGe FOV line and ignores the rest", () => {
    expect(mogeFovFromTexts(["noise", MOGE_TEXT])).toEqual({
      fovX: 63.4,
      fovY: 39.6,
    });
    expect(mogeFovFromTexts(["Panorama: no FOV"])).toBeNull();
    expect(mogeFovFromTexts(undefined)).toBeNull();
    expect(validFov(0, 40)).toBeNull();
    expect(validFov(180, 40)).toBeNull();
    expect(validAspect(17)).toBeNull();
    expect(validAspect("1.5")).toBe(1.5);
  });

  it("validates manifest names", () => {
    expect(validLayerManifest("adrift_layers_17_ab_layers.json")).toBe(
      "adrift_layers_17_ab_layers.json",
    );
    for (const bad of [
      "../x_layers.json",
      "sub/x_layers.json",
      "x_layers.json.png",
      "x..y_layers.json",
      "",
      42,
    ])
      expect(validLayerManifest(bad)).toBeNull();
  });

  it("mesh jobs win and carry camera + aspect through href and open body", () => {
    const src = blenderSourceFor({
      meshUrls: [glbUrl],
      texts: [MOGE_TEXT],
      action: "moge",
      width: 1600,
      height: 900,
    })!;
    expect(src).toMatchObject({
      kind: "mesh",
      camera: { fovX: 63.4, fovY: 39.6 },
    });
    expect(src.aspect).toBeCloseTo(16 / 9);
    const href = blenderSourceHref(src);
    const back = blenderSourceFromQuery(new URL(href, "http://x").searchParams);
    expect(back).toMatchObject({
      kind: "mesh",
      refs: [
        { filename: "adrift_moge_00001_.glb", subfolder: "3d", type: "output" },
      ],
      camera: { fovX: 63.4, fovY: 39.6 },
    });
    expect(back?.aspect).toBeCloseTo(16 / 9);
    const body = blenderSourceFromBody(
      JSON.parse(JSON.stringify(blenderOpenBody(src))),
    );
    expect(body).toMatchObject({ kind: "mesh", camera: { fovX: 63.4 } });
  });

  it("Layer Split jobs export their manifest", () => {
    const texts = ["/out/adrift_layers_1_ab_layers.json"];
    const src = blenderSourceFor({
      texts,
      action: "see_through",
      params: { detail: "fast" },
      width: 800,
      height: 1200,
    })!;
    expect(src).toMatchObject({
      kind: "layers",
      manifest: "adrift_layers_1_ab_layers.json",
      resolution: 1024,
    });
    const href = blenderSourceHref(src);
    expect(href).toContain("layers=adrift_layers_1_ab_layers.json");
    expect(href).toContain("res=1024");
    expect(
      blenderSourceFromQuery(new URL(href, "http://x").searchParams),
    ).toMatchObject({ kind: "layers", resolution: 1024 });
    expect(
      blenderSourceFromBody(JSON.parse(JSON.stringify(blenderOpenBody(src)))),
    ).toMatchObject({
      kind: "layers",
      manifest: "adrift_layers_1_ab_layers.json",
    });
    // Other actions never turn a text output into a layer export.
    expect(blenderSourceFor({ texts, action: "caption" })).toBeNull();
    expect(blenderSourceFor({ texts: ["hello"] })).toBeNull();
  });

  it("rejects bad query and body sources", () => {
    const q = (s: string) => blenderSourceFromQuery(new URLSearchParams(s));
    expect(q("layers=../etc_layers.json")).toBeNull();
    expect(q("layers=a_layers.json&res=99999")).toMatchObject({
      resolution: null,
    });
    expect(
      blenderSourceFromBody({ layers: { manifest: "a.json" } }),
    ).toBeNull();
    expect(blenderSourceFromBody({ files: "x" })).toBeNull();
    expect(blenderSourceFromBody(null)).toBeNull();
  });
});

describe("mesh script source camera", () => {
  it("sizes the render from the FOV or the aspect", () => {
    expect(renderSize(16 / 9)).toEqual([1920, 1080]);
    expect(renderSize(0.5)).toEqual([960, 1920]);
    expect(renderSize(null)).toBeNull();
    expect(fovAspect({ fovX: 90, fovY: 90 })).toBeCloseTo(1);
  });

  it("adds a camera looking down +Y at the reconstruction origin", () => {
    const py = blenderImportScript({
      scriptName: "import_m.py",
      title: "m",
      assets: [{ kind: "gltf", path: "m.glb" }],
      sourceCamera: { fovX: 63.4, fovY: 39.6 },
    } as Parameters<typeof blenderImportScript>[0]);
    expect(py).toContain("SOURCE_CAMERA = (63.4, 39.6)");
    expect(py).toMatch(/RENDER_SIZE = \(1920, \d+\)/);
    expect(py).toContain('data.sensor_fit = "HORIZONTAL"');
    expect(py).toContain("cam.rotation_euler = (math.pi / 2, 0.0, 0.0)");
    expect(py).toContain("if SOURCE_CAMERA:");
    if (PY) pyCompiles(py);

    const plain = blenderImportScript({
      scriptName: "import_m.py",
      title: "m",
      assets: [{ kind: "gltf", path: "m.glb" }],
    } as Parameters<typeof blenderImportScript>[0]);
    expect(plain).toContain("SOURCE_CAMERA = None");
    expect(plain).toContain("RENDER_SIZE = None");
  });

  it("notes the source camera in the bundle readme", () => {
    const b = buildBlenderBundle(
      [{ name: "m.glb", data: new Uint8Array([0x67, 0x6c, 0x54, 0x46]) }],
      { sourceCamera: { fovX: 60, fovY: 40 } },
    );
    const readme = b.files.find((f) => /readme/i.test(f.path));
    expect(
      text(readme!.data),
    ).toMatch(/source camera/i);
  });
});

describe("layer planes", () => {
  it("frames the source image inside the square canvas", () => {
    expect(sourceFrame(1280, 1280, 16 / 9)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(sourceFrame(1280, 1280, 0.5)).toEqual({ width: 640, height: 1280 });
    expect(sourceFrame(1280, 1280, null)).toEqual({
      width: 1280,
      height: 1280,
    });
    expect(runAspect({ width: 800, height: 400 })).toBe(2);
    expect(runAspect({ width: 0, height: 400 })).toBeNull();
  });

  it("maps a part into a full-canvas depth map, but not a cropped one", () => {
    expect(
      canvasDepthUv({ left: 0, top: 0, width: 50, height: 100 }, 100, 100),
    ).toEqual([0, 0, 0.5, 1]);
    const part = { left: 10, top: 20, width: 30, height: 40 };
    expect(pngSize(fakePng(30, 40))).toEqual({ width: 30, height: 40 });
    expect(pngSize(new Uint8Array(40))).toBeNull();
    expect(
      partDepthUv(
        { ...part, depthPng: fakePng(30, 40) },
        { width: 100, height: 100 },
      ),
    ).toEqual([0, 0, 1, 1]);
    const uv = partDepthUv(
      { ...part, depthPng: fakePng(100, 100) },
      { width: 100, height: 100 },
    );
    expect(uv.map((n) => Number(n.toFixed(4)))).toEqual([0.1, 0.4, 0.4, 0.8]);
  });

  const layers = [
    {
      name: "back",
      path: "parts/back.png",
      depthPath: "depth/back_depth.png",
      depthUv: [0, 0, 1, 1] as [number, number, number, number],
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      depthMedian: 0.8,
    },
    {
      name: "face",
      path: "parts/face.png",
      left: 50,
      top: 50,
      width: 50,
      height: 50,
      depthMedian: 0.8,
    },
  ];

  it("writes a script with alpha materials, relief and a framed camera", () => {
    const py = layerBlenderScript({
      canvasWidth: 200,
      canvasHeight: 200,
      layers,
      frame: sourceFrame(200, 200, 2),
    });
    expect(py).toContain("FRAME_PX = (200, 100)");
    expect(py).toContain("FRAME_M = (2, 1)");
    expect(py).toContain('0: ("depth/back_depth.png", 0, 0, 1, 1, 0.8),');
    expect(py).not.toMatch(/^ {4}1: /m);
    expect(py).toContain("Z_STEP = 0.0005");
    expect(py).toContain("RELIEF = False");
    expect(py).toContain('"Adrift relief"');
    expect(py).toContain("film_transparent");
    expect(py).toMatch(/blend_method|alpha/i);
    if (PY) pyCompiles(py);
  });

  it("builds a GLB of unlit alpha planes with an ortho camera", () => {
    const glb = layerPlanesGlb({
      canvasWidth: 200,
      canvasHeight: 200,
      frame: { width: 200, height: 100 },
      layers: layers.map((l) => ({ ...l, png: fakePng(l.width, l.height) })),
    });
    const j = glbJson(glb);
    expect(j.extensionsUsed).toContain("KHR_materials_unlit");
    expect(j.images).toHaveLength(2);
    expect(j.materials.every((m: any) => m.alphaMode === "BLEND")).toBe(true);
    expect(j.cameras[0]).toMatchObject({
      type: "orthographic",
      orthographic: { xmag: 1, ymag: 0.5 },
    });
    const [back, face] = j.nodes;
    expect(back.translation[2]).toBeCloseTo(-0.8);
    // Equal depths: the later (nearer) part is nudged toward the camera.
    expect(face.translation[2]).toBeGreaterThan(back.translation[2]);
    expect(face.translation[0]).toBeCloseTo(-0.25);
    expect(face.translation[1]).toBeCloseTo(0.25);
    expect(j.scenes[0].nodes).toHaveLength(1);
  });
});

describe("loadBlenderSource (layers)", () => {
  const manifest = {
    prefix: "adrift_layers",
    timestamp: "1",
    layers: [
      {
        name: "face",
        filename: "adrift_layers_1_face.png",
        depth_filename: "adrift_layers_1_face_depth.png",
        left: 10,
        top: 10,
        right: 60,
        bottom: 60,
        depth_median: 0.2,
      },
      {
        name: "back hair",
        filename: "adrift_layers_1_back hair.png",
        depth_filename: "adrift_layers_1_missing_depth.png",
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        depth_median: 0.9,
      },
    ],
  };
  const files: Record<string, Uint8Array> = {
    "adrift_layers_1_ab_layers.json": new TextEncoder().encode(
      JSON.stringify(manifest),
    ),
    "adrift_layers_1_face.png": fakePng(50, 50),
    "adrift_layers_1_face_depth.png": fakePng(50, 50),
    "adrift_layers_1_back hair.png": fakePng(100, 100),
  };
  const calls: Array<[string, string, string]> = [];
  const fetcher = async (f: string, sub: string, type: string) => {
    calls.push([f, sub, type]);
    const data = files[f];
    if (!data) throw Object.assign(new Error("nope"), { statusCode: 404 });
    return new Response(Buffer.from(data));
  };

  it("bundles parts back to front with depth, script and GLB", async () => {
    const b = await loadBlenderSource(
      {
        kind: "layers",
        manifest: "adrift_layers_1_ab_layers.json",
        resolution: 256,
        aspect: 1,
      },
      fetcher as never,
    );
    expect(b.name).toBe("adrift_layers_1_ab_layers");
    expect(b.scriptName).toBe("import_layers.py");
    const paths = b.files.map((f) => f.path);
    expect(paths).toContain("import_layers.py");
    expect(paths).toContain("layers.glb");
    expect(paths).toContain("parts/back hair.png");
    expect(paths).toContain("parts/face.png");
    expect(paths).toContain("depth/face_depth.png");
    expect(paths.some((p) => p.includes("back hair_depth"))).toBe(false);
    expect(
      calls.every(([, sub, type]) => sub === "" && type === "output"),
    ).toBe(true);
    const py = text(b.files.find((f) => f.path === "import_layers.py")!.data);
    expect(py.indexOf('"parts/back hair.png"')).toBeLessThan(
      py.indexOf('"parts/face.png"'),
    );
    expect(py).toContain("CANVAS_PX = (256, 256)");
  });

  it("maps bad names, missing and broken manifests to HTTP errors", async () => {
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e) => (e instanceof BundleFetchError ? e.status : -1),
      );
    expect(
      await status(
        loadBlenderSource(
          { kind: "layers", manifest: "../x_layers.json" },
          fetcher as never,
        ),
      ),
    ).toBe(400);
    expect(
      await status(
        loadBlenderSource(
          { kind: "layers", manifest: "gone_layers.json" },
          fetcher as never,
        ),
      ),
    ).toBe(404);
    files["bad_layers.json"] = new TextEncoder().encode('{"layers": []}');
    expect(
      await status(
        loadBlenderSource(
          { kind: "layers", manifest: "bad_layers.json" },
          fetcher as never,
        ),
      ),
    ).toBe(422);
  });
});
