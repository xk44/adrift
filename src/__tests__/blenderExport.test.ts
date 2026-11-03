/** Export for Blender: script template, format routing, conversions, bundle zip. */
import { execFileSync } from "child_process";
import { gzipSync } from "zlib";
import { describe, expect, it } from "vitest";
import { blenderImportScript, pyStr } from "@/lib/mesh/blenderScript";
import {
  blenderBundleZip,
  blenderRoute,
  buildBlenderBundle,
  safeStem,
} from "@/lib/mesh/blenderBundle";
import {
  parseObj,
  parsePlyHeader,
  parsePlyMesh,
  sniffPly,
  splatFileToPoints,
  splatPlyToPoints,
  spzToPoints,
  writeGlb,
  writePointsPly,
} from "@/lib/mesh/meshConvert";
import {
  blenderBundleHref,
  meshRefFromUrl,
  meshRefsFromUrls,
} from "@/lib/mesh/blenderLinks";
import {
  meshRefsFromQuery,
  validateMeshRefs,
} from "@/lib/mesh/blenderBundleServer";
import { listZipEntries, readZipEntry } from "@/lib/userTools/zip";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const PY = hasPython();

/** Evaluate a Python literal with the real interpreter. */
function pyEval(literal: string): unknown {
  const out = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      "import ast,json,sys; print(json.dumps(ast.literal_eval(sys.stdin.read())))",
    ],
    { input: literal },
  );
  return JSON.parse(out.toString());
}

const enc = (s: string) => new TextEncoder().encode(s);

function binaryPly(
  header: string[],
  rows: (dv: DataView, i: number) => void,
  n: number,
  row: number,
): Uint8Array {
  const head = enc(
    [
      "ply",
      "format binary_little_endian 1.0",
      ...header,
      "end_header",
      "",
    ].join("\n"),
  );
  const out = new Uint8Array(head.length + n * row);
  out.set(head);
  const dv = new DataView(out.buffer, head.length);
  for (let i = 0; i < n; i++) rows(dv, i);
  return out;
}

/** 3DGS-style PLY: x y z f_dc_0..2 opacity scale_0 (floats). */
function splatPly(points: Array<[number, number, number, number]>): Uint8Array {
  return binaryPly(
    [
      `element vertex ${points.length}`,
      ...[
        "x",
        "y",
        "z",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "opacity",
        "scale_0",
      ].map((p) => `property float ${p}`),
    ],
    (dv, i) => {
      const [x, y, z, op] = points[i];
      const vals = [x, y, z, 1, 0, -1, op, -3];
      vals.forEach((v, k) => dv.setFloat32(i * 32 + k * 4, v, true));
    },
    points.length,
    32,
  );
}

function parseGlb(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(8, true)).toBe(bytes.length);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)),
  );
  const binLen = dv.getUint32(20 + jsonLen, true);
  expect(binLen).toBe(json.buffers[0].byteLength);
  return json;
}

describe("pyStr", () => {
  it("escapes quotes, backslashes, control and non-ASCII characters", () => {
    expect(pyStr('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(pyStr("x\ny")).toBe('"x\\x0ay"');
    expect(pyStr("é")).toBe('"\\xe9"');
    expect(pyStr("模型")).toBe('"\\u6a21\\u578b"');
    expect(pyStr("🙂")).toBe('"\\U0001f642"');
    // Only printable ASCII ever reaches the source.
    expect(/^[\x20-\x7e]*$/.test(pyStr("\u2028\x00'\"\r"))).toBe(true);
  });

  it.skipIf(!PY)("round-trips through the Python parser", () => {
    for (const s of [
      'my "model" (1).glb',
      "it's a file.ply",
      "back\\slash\\",
      "new\nline\r\t",
      '"""; import os; os.system(\'x\') #',
      "ünïcödé 模型 🙂",
      "  spaces  .obj",
    ]) {
      expect(pyEval(pyStr(s))).toBe(s);
    }
  });
});

describe("blenderImportScript", () => {
  const script = blenderImportScript({
    scriptName: "import_my_model.py",
    title: "my_model",
    assets: [
      { kind: "gltf", path: "my_model.glb" },
      { kind: "points", path: "splat cloud_points.ply" },
    ],
  });

  it("imports with the Blender 4.2+ operators", () => {
    expect(script).toContain("bpy.ops.import_scene.gltf(filepath=path)");
    expect(script).toContain("bpy.ops.wm.ply_import(filepath=path)");
    expect(script).toContain("bpy.ops.wm.obj_import(filepath=path)");
    expect(script).toContain("import bpy");
    // bpy + stdlib only.
    const imports = script.match(/^(?:import|from) \S+/gm) ?? [];
    expect(imports.sort()).toEqual(
      [
        "from mathutils",
        "import bpy",
        "import math",
        "import os",
        "import sys",
      ].sort(),
    );
  });

  it("resolves files relative to the script's own folder", () => {
    expect(script).toContain('globals().get("__file__")');
    expect(script).toContain('os.path.join(base, *rel.split("/"))');
    expect(script).toContain('SCRIPT_NAME = "import_my_model.py"');
    expect(script).toContain('("gltf", "my_model.glb"),');
    expect(script).toContain('("points", "splat cloud_points.ply"),');
    expect(script).not.toMatch(/\/Users\/|C:\\\\/);
  });

  it("sets up camera, three lights and material preview", () => {
    expect(script).toContain('add_light("Adrift key"');
    expect(script).toContain('add_light("Adrift fill"');
    expect(script).toContain('add_light("Adrift rim"');
    expect(script).toContain("bpy.context.scene.camera = cam");
    expect(script).toContain('space.shading.type = "MATERIAL"');
  });

  it("keeps hostile file names inside their string literal", () => {
    const evil = blenderImportScript({
      scriptName: 'import_"x".py',
      title: 'a"\nimport os',
      assets: [{ kind: "gltf", path: 'we"ird\nos.system("rm").glb' }],
    });
    expect(evil).not.toContain('\nos.system("rm")');
    expect(evil.match(/^import os$/gm)).toHaveLength(1);
    expect(evil).toContain('TITLE = "a\\"\\x0aimport os"');
    expect(evil).toContain('("gltf", "we\\"ird\\x0aos.system(\\"rm\\").glb"),');
  });

  it.skipIf(!PY)("is valid Python", () => {
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys; compile(sys.stdin.read(), 'import_x.py', 'exec'); print('ok')",
      ],
      { input: script },
    );
    expect(out.toString().trim()).toBe("ok");
  });
});

describe("blenderRoute", () => {
  const meshPly = enc(
    "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n",
  );
  const pointsPly = enc(
    "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n",
  );

  it("routes meshes, splats and the rest", () => {
    expect(blenderRoute("a.glb")).toEqual({ action: "copy", kind: "gltf" });
    expect(blenderRoute("a.GLTF")).toEqual({ action: "copy", kind: "gltf" });
    expect(blenderRoute("a.obj")).toEqual({
      action: "toGlb",
      from: "obj",
      fallback: "obj",
    });
    expect(blenderRoute("a.ply", meshPly)).toEqual({
      action: "toGlb",
      from: "ply",
      fallback: "ply",
    });
    expect(blenderRoute("a.ply", splatPly([[0, 0, 0, 5]]))).toEqual({
      action: "splat",
      from: "ply",
    });
    expect(blenderRoute("a.ply", pointsPly)).toEqual({
      action: "copy",
      kind: "points",
    });
    expect(blenderRoute("a.ply", enc("garbage"))).toEqual({
      action: "copy",
      kind: "ply",
    });
    expect(blenderRoute("a.splat")).toEqual({ action: "splat", from: "splat" });
    expect(blenderRoute("a.spz")).toEqual({ action: "splat", from: "spz" });
    expect(blenderRoute("a.ksplat")).toEqual({ action: "splatOnly" });
    expect(blenderRoute("a.usdz")).toEqual({ action: "copy", kind: "usd" });
    expect(blenderRoute("a.bvh")).toEqual({ action: "copy", kind: "bvh" });
    expect(blenderRoute("a.stl")).toEqual({ action: "copy", kind: "stl" });
    expect(blenderRoute("a.png").action).toBe("skip");
  });

  it("sniffs PLY kinds", () => {
    expect(sniffPly(meshPly)).toBe("mesh");
    expect(sniffPly(pointsPly)).toBe("points");
    expect(sniffPly(splatPly([[0, 0, 0, 1]]))).toBe("splat");
    expect(sniffPly(enc("nope"))).toBeNull();
  });

  it("makes safe stems", () => {
    expect(safeStem("my model (1).glb")).toBe("my_model_1");
    expect(safeStem('"; rm -rf.obj')).toBe("rm_-rf");
    expect(safeStem("...glb")).toBe("model");
  });
});

describe("conversions", () => {
  it("writes a valid GLB", () => {
    const glb = writeGlb({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(glb.length % 4).toBe(0);
    const json = parseGlb(glb);
    const prim = json.meshes[0].primitives[0];
    expect(Object.keys(prim.attributes).sort()).toEqual([
      "COLOR_0",
      "POSITION",
    ]);
    expect(json.accessors[prim.attributes.POSITION]).toMatchObject({
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [1, 1, 0],
    });
    expect(json.accessors[prim.indices]).toMatchObject({
      count: 3,
      componentType: 5125,
    });
  });

  it("parses OBJ quads, negative indices, UVs and vertex colours", () => {
    const mesh = parseObj(
      [
        "# quad",
        "v 0 0 0 1 0 0",
        "v 1 0 0 1 0 0",
        "v 1 1 0 1 0 0",
        "v 0 1 0 1 0 0",
        "vt 0 0",
        "vt 1 0",
        "vt 1 1",
        "vt 0 1",
        "f -4/1 -3/2 -2/3 -1/4",
      ].join("\n"),
    );
    expect(mesh.indices).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(mesh.positions.length).toBe(12);
    expect(mesh.colors?.[0]).toBeCloseTo(1);
    expect(mesh.uvs?.[1]).toBeCloseTo(1); // v flipped for glTF
    expect(() => parseObj("v 0 0 0\n")).toThrow();
    expect(() => parseObj("v 0 0 0\nf 1 2 3\n")).toThrow();
  });

  it("parses ascii and binary mesh PLYs", () => {
    const ascii = parsePlyMesh(
      enc(
        "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 255 0 0\n1 1 0 255 0 0\n0 1 0 255 0 0\n4 0 1 2 3\n",
      ),
    );
    expect(ascii.indices).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(ascii.colors?.[0]).toBeCloseTo(1);

    const bin = binaryPly(
      [
        "element vertex 3",
        "property float x",
        "property float y",
        "property float z",
        "element face 1",
        "property list uchar uint vertex_indices",
      ],
      () => {},
      0,
      0,
    );
    // Hand-write the body: 3 vertices then one face.
    const body = new Uint8Array(3 * 12 + 1 + 12);
    const dv = new DataView(body.buffer);
    [0, 0, 0, 2, 0, 0, 0, 2, 0].forEach((v, i) =>
      dv.setFloat32(i * 4, v, true),
    );
    body[36] = 3;
    [0, 1, 2].forEach((v, i) => dv.setUint32(37 + i * 4, v, true));
    const full = new Uint8Array(bin.length + body.length);
    full.set(bin);
    full.set(body, bin.length);
    const mesh = parsePlyMesh(full);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(mesh.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(parsePlyHeader(full).format).toBe("binary_little_endian");
  });

  it("turns splat PLYs into coloured points and drops transparent splats", () => {
    const pts = splatPlyToPoints(
      splatPly([
        [1, 2, 3, 5],
        [4, 5, 6, -10],
      ]),
    );
    expect(Array.from(pts.positions)).toEqual([1, 2, 3]);
    // f_dc = (1, 0, -1) → 0.5 + 0.2821*dc
    expect(Array.from(pts.colors)).toEqual([199, 128, 56]);
    const ply = writePointsPly(pts);
    expect(sniffPly(ply)).toBe("points");
  });

  it("reads .splat and .spz files", () => {
    const splat = new Uint8Array(64);
    const dv = new DataView(splat.buffer);
    dv.setFloat32(0, 1, true);
    dv.setFloat32(4, 2, true);
    dv.setFloat32(8, 3, true);
    splat.set([10, 20, 30, 255], 24);
    splat.set([0, 0, 0, 0], 56); // transparent second splat
    const a = splatFileToPoints(splat);
    expect(Array.from(a.positions)).toEqual([1, 2, 3]);
    expect(Array.from(a.colors)).toEqual([10, 20, 30]);

    const n = 1;
    const raw = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3));
    const rv = new DataView(raw.buffer);
    rv.setUint32(0, 0x5053474e, true);
    rv.setUint32(4, 2, true);
    rv.setUint32(8, n, true);
    raw[12] = 0;
    raw[13] = 12; // fractional bits
    // x = 1.0 → 4096 = 0x001000; y = -1.0 → 0xfff000; z = 0
    raw.set([0x00, 0x10, 0x00, 0x00, 0xf0, 0xff, 0, 0, 0], 16);
    raw[25] = 255; // alpha
    raw.set([128, 128, 128], 26);
    const b = spzToPoints(gzipSync(raw));
    expect(Array.from(b.positions)).toEqual([1, -1, 0]);
    expect(b.colors[0]).toBeGreaterThan(125);
    expect(() => spzToPoints(enc("nope"))).toThrow();
  });
});

describe("buildBlenderBundle", () => {
  const glb = writeGlb({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  });

  it("ships a GLB with script and readme; skips a derived USDZ", () => {
    const b = buildBlenderBundle([
      { name: "mesh_00001_.glb", data: glb },
      { name: "mesh_00001_.usdz", data: enc("usdz") },
    ]);
    expect(b.name).toBe("mesh_00001");
    expect(b.files.map((f) => f.path)).toEqual([
      "import_mesh_00001.py",
      "mesh_00001.glb",
      "README.txt",
    ]);
    expect(b.assets).toEqual([{ path: "mesh_00001.glb", kind: "gltf" }]);
    const readme = b.files.at(-1)!.data as string;
    expect(readme).toContain("Run Script");
    expect(readme).toContain('blender --python "import_mesh_00001.py"');
  });

  it("converts OBJ to GLB and keeps the source", () => {
    const b = buildBlenderBundle([
      {
        name: "chair 1.obj",
        data: enc("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
      },
    ]);
    expect(b.assets).toEqual([{ path: "chair_1.glb", kind: "gltf" }]);
    expect(b.files.map((f) => f.path)).toContain("source/chair_1.obj");
    parseGlb(b.files.find((f) => f.path === "chair_1.glb")!.data as Uint8Array);
  });

  it("falls back to the native importer when conversion fails", () => {
    const b = buildBlenderBundle([
      { name: "bad.obj", data: enc("nothing here") },
    ]);
    expect(b.assets).toEqual([{ path: "bad.obj", kind: "obj" }]);
    expect(b.notes.join(" ")).toContain("could not be converted");
  });

  it("splats: point preview + original + add-on note", () => {
    const b = buildBlenderBundle([
      { name: "splat_00003_.ply", data: splatPly([[0, 0, 0, 5]]) },
    ]);
    expect(b.assets).toEqual([
      { path: "splat_00003_points.ply", kind: "points" },
    ]);
    expect(b.files.map((f) => f.path)).toContain("splat/splat_00003.ply");
    expect(b.notes.join(" ")).toContain("Gaussian splat add-on");
    const ks = buildBlenderBundle([{ name: "s.ksplat", data: enc("x") }]);
    expect(ks.assets).toEqual([]);
    expect(ks.files.at(-1)!.data).toContain(
      "Nothing in this bundle can be imported",
    );
  });

  it("zips into one folder that round-trips", () => {
    const b = buildBlenderBundle([{ name: "mesh.glb", data: glb }]);
    const zip = blenderBundleZip(b);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "mesh/import_mesh.py",
      "mesh/mesh.glb",
      "mesh/README.txt",
    ]);
    expect(Buffer.from(readZipEntry(zip, entries[1]))).toEqual(
      Buffer.from(glb),
    );
    expect(readZipEntry(zip, entries[0]).toString()).toContain(
      '("gltf", "mesh.glb")',
    );
  });
});

describe("links and ref validation", () => {
  const glbUrl =
    "/api/comfy/image?filename=m_00001_.glb&subfolder=3d&type=output";
  const plyUrl = "/api/comfy/image?filename=s.ply&subfolder=&type=output";

  it("reads refs from view URLs", () => {
    expect(meshRefFromUrl(glbUrl)).toEqual({
      filename: "m_00001_.glb",
      subfolder: "3d",
      type: "output",
    });
    expect(meshRefFromUrl("/api/comfy/image?filename=a.png")).toBeNull();
    expect(meshRefFromUrl("https://evil.example/x.glb")).toBeNull();
    expect(meshRefsFromUrls([glbUrl, glbUrl, plyUrl, undefined])).toHaveLength(
      2,
    );
    const href = blenderBundleHref([glbUrl, plyUrl])!;
    expect(href.startsWith("/api/comfy/blender-bundle?")).toBe(true);
    const refs = meshRefsFromQuery(new URL(href, "http://x").searchParams);
    expect(refs).toEqual([
      { filename: "m_00001_.glb", subfolder: "3d", type: "output" },
      { filename: "s.ply", subfolder: "", type: "output" },
    ]);
    expect(blenderBundleHref([])).toBeNull();
  });

  it("rejects traversal, odd types and non-3D files", () => {
    const ok = { filename: "a.glb", subfolder: "", type: "output" };
    expect(validateMeshRefs([ok])).not.toBeNull();
    expect(validateMeshRefs([])).toBeNull();
    expect(validateMeshRefs([{ ...ok, filename: "../a.glb" }])).toBeNull();
    expect(validateMeshRefs([{ ...ok, subfolder: "../x" }])).toBeNull();
    expect(validateMeshRefs([{ ...ok, filename: "a.png" }])).toBeNull();
    expect(validateMeshRefs([{ ...ok, type: "secret" }])).toBeNull();
    expect(validateMeshRefs(Array(9).fill(ok))).toBeNull();
  });
});
