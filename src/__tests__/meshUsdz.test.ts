/**
 * GLB → USDZ export helpers (src/lib/mesh/usdz.ts) and /api/jobs/recent
 * output bucketing (src/lib/jobs/recentRuns.ts).
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blenderCandidates,
  convertGlbToUsdz,
  ensureUsdz,
  findBlender,
  isAudioFile,
  isMeshFile,
  resolveOutputPath,
  usdzNameFor,
  validateOutputRef,
} from "@/lib/mesh/usdz";
import { groupRuns, outputBucket } from "@/lib/jobs/recentRuns";
import type { RecentRunRow } from "@/lib/db";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-usdz-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal vertex-coloured GLB (octahedron), shaped like ComfyUI save_glb(unlit). */
function vertexColorGlb(): Buffer {
  const V = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const C = [
    [1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
    [1, 1, 0, 1],
    [1, 0, 1, 1],
    [0, 1, 1, 1],
  ];
  const F = [
    [0, 2, 4],
    [2, 1, 4],
    [1, 3, 4],
    [3, 0, 4],
    [2, 0, 5],
    [1, 2, 5],
    [3, 1, 5],
    [0, 3, 5],
  ];
  const pos = Buffer.from(new Float32Array(V.flat()).buffer);
  const col = Buffer.from(new Float32Array(C.flat()).buffer);
  const idx = Buffer.from(new Uint32Array(F.flat()).buffer);
  const bin = Buffer.concat([pos, col, idx]);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    extensionsUsed: ["KHR_materials_unlit"],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      { buffer: 0, byteOffset: pos.length, byteLength: col.length },
      {
        buffer: 0,
        byteOffset: pos.length + col.length,
        byteLength: idx.length,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 6,
        type: "VEC3",
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: 6, type: "VEC4" },
      { bufferView: 2, componentType: 5125, count: 24, type: "SCALAR" },
    ],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (len: number, type: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([
    header,
    chunk(json.length, 0x4e4f534a),
    json,
    chunk(bin.length, 0x004e4942),
    bin,
  ]);
}

describe("file classification", () => {
  it("recognises mesh and audio outputs", () => {
    expect(isMeshFile("mesh_00001_.glb")).toBe(true);
    expect(isMeshFile("x.USDZ")).toBe(true);
    expect(isMeshFile("x.png")).toBe(false);
    expect(isAudioFile("song.flac")).toBe(true);
    expect(isAudioFile("clip.mp4")).toBe(false);
  });

  it("names the usdz after the glb, and only for glb", () => {
    expect(usdzNameFor("mesh_00001_.glb")).toBe("mesh_00001_.usdz");
    expect(usdzNameFor("Mesh.GLB")).toBe("Mesh.usdz");
    expect(usdzNameFor("mesh.obj")).toBeNull();
    expect(usdzNameFor("mesh.glb.png")).toBeNull();
  });
});

describe("validateOutputRef", () => {
  it("accepts plain names and nested subfolders", () => {
    expect(validateOutputRef("mesh_00001_.glb", "3d")).toEqual({
      filename: "mesh_00001_.glb",
      subfolder: "3d",
    });
    expect(validateOutputRef("a.glb", undefined)).toEqual({
      filename: "a.glb",
      subfolder: "",
    });
    expect(validateOutputRef("a.glb", "x/y")).toEqual({
      filename: "a.glb",
      subfolder: "x/y",
    });
  });

  it.each([
    ["../a.glb", ""],
    ["a/b.glb", ""],
    ["a\\b.glb", ""],
    ["a.glb", "../etc"],
    ["a.glb", "x//y"],
    ["a.glb", "/abs"],
    ["a.glb", "x/.."],
    ["a\u0000.glb", ""],
    [42, ""],
    ["a.glb", 7],
    ["x".repeat(300) + ".glb", ""],
  ])("rejects %j in %j", (filename, subfolder) => {
    expect(validateOutputRef(filename, subfolder)).toBeNull();
  });
});

describe("resolveOutputPath", () => {
  it("keeps paths inside the output root", () => {
    expect(resolveOutputPath("/c/output", "a.glb", "3d")).toBe(
      path.resolve("/c/output/3d/a.glb"),
    );
    expect(resolveOutputPath("/c/output", "a.glb", "")).toBe(
      path.resolve("/c/output/a.glb"),
    );
  });
  it("refuses escapes", () => {
    expect(resolveOutputPath("/c/output", "a.glb", "../../etc")).toBeNull();
    expect(resolveOutputPath("/c/output", "../output2/a.glb", "")).toBeNull();
  });
});

describe("blenderCandidates (per-platform, never replacing another platform)", () => {
  const noFs = { exists: () => false, readdir: () => [] as string[] };

  it("BLENDER_PATH always wins", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        blenderCandidates(platform, { BLENDER_PATH: "/x/blender" }, noFs)[0],
      ).toBe("/x/blender");
    }
  });

  it("mac: app bundle, then homebrew, then PATH", () => {
    const c = blenderCandidates(
      "darwin",
      { HOME: "/Users/u", PATH: "/usr/bin:/bin" },
      noFs,
    );
    expect(c[0]).toBe("/Applications/Blender.app/Contents/MacOS/Blender");
    expect(c).toContain(
      "/Users/u/Applications/Blender.app/Contents/MacOS/Blender",
    );
    expect(c).toContain("/opt/homebrew/bin/blender");
    expect(c.at(-1)).toBe("/bin/blender");
  });

  it("linux: system, snap, PATH", () => {
    const c = blenderCandidates("linux", { PATH: "/opt/b" }, noFs);
    expect(c).toEqual(
      expect.arrayContaining([
        "/usr/bin/blender",
        "/snap/bin/blender",
        "/opt/b/blender",
      ]),
    );
    expect(c.some((p) => p.includes("Applications"))).toBe(false);
  });

  it("windows: newest Blender Foundation install first, then PATH (blender.exe)", () => {
    const fake = {
      exists: () => false,
      readdir: (p: string) =>
        p === "C:\\Program Files\\Blender Foundation"
          ? ["Blender 4.2", "Blender 5.1", "Blender 4.10", "readme.txt"]
          : [],
    };
    const c = blenderCandidates(
      "win32",
      { ProgramFiles: "C:\\Program Files", PATH: "D:\\tools;" },
      fake,
    );
    expect(c.slice(0, 3)).toEqual([
      "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.10\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
    ]);
    expect(c).toContain("D:\\tools\\blender.exe");
  });

  it("findBlender picks the first existing candidate", () => {
    const hit = findBlender({
      exists: (p) => p.endsWith("blender"),
      readdir: () => [],
    });
    expect(hit === null || hit.toLowerCase().includes("blender")).toBe(true);
  });
});

describe("convertGlbToUsdz", () => {
  it("fails cleanly when no Blender is available", async () => {
    await expect(
      convertGlbToUsdz("/a.glb", "/a.usdz", { blender: null }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Blender not found"),
    });
  });

  it("reports spawn failures instead of throwing", async () => {
    const r = await convertGlbToUsdz("/a.glb", "/a.usdz", {
      blender: "/nonexistent/blender-xyz",
    });
    expect(r.ok).toBe(false);
  });
});

describe("resolveOutputPath symlink containment (B8)", () => {
  it("refuses a symlinked subfolder that points outside the root", () => {
    const root = tmpDir();
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(root, "evil"));
    expect(resolveOutputPath(root, "m.usdz", "evil")).toBeNull();
    expect(resolveOutputPath(root, "m.usdz", "evil/deeper")).toBeNull();
  });

  it("refuses a symlink at the target name", () => {
    const root = tmpDir();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "x"), "x");
    fs.symlinkSync(path.join(outside, "x"), path.join(root, "m.usdz"));
    expect(resolveOutputPath(root, "m.usdz", "")).toBeNull();
  });

  it("allows real subfolders, not-yet-created ones, and a symlinked root", () => {
    const real = tmpDir();
    fs.mkdirSync(path.join(real, "3d"));
    expect(resolveOutputPath(real, "m.glb", "3d")).toBe(path.join(real, "3d", "m.glb"));
    expect(resolveOutputPath(real, "m.glb", "new/sub")).toBe(path.join(real, "new", "sub", "m.glb"));
    const linkRoot = path.join(tmpDir(), "out");
    fs.symlinkSync(real, linkRoot);
    expect(resolveOutputPath(linkRoot, "m.glb", "3d")).toBe(path.join(linkRoot, "3d", "m.glb"));
  });
});

describe("ensureUsdz", () => {
  it("converts once, then reuses the existing file", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "3d"));
    fs.writeFileSync(path.join(root, "3d", "m.glb"), "glb");
    let calls = 0;
    const fake = async (_glb: string, usdz: string) => {
      calls += 1;
      fs.writeFileSync(usdz, "usdz");
      return { ok: true as const };
    };
    const ref = { filename: "m.glb", subfolder: "3d" };
    const [a, b] = await Promise.all([
      ensureUsdz(root, ref, fake),
      ensureUsdz(root, ref, fake),
    ]);
    expect(a).toEqual({
      ok: true,
      usdz: { filename: "m.usdz", subfolder: "3d" },
    });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });

  it("refuses non-glb, missing and escaping inputs", async () => {
    const root = tmpDir();
    const never = async () => {
      throw new Error("should not convert");
    };
    expect(
      await ensureUsdz(root, { filename: "m.obj", subfolder: "" }, never),
    ).toEqual({ ok: false, error: "not a .glb" });
    expect(
      await ensureUsdz(root, { filename: "m.glb", subfolder: "" }, never),
    ).toEqual({ ok: false, error: "GLB not found" });
    expect(
      await ensureUsdz(root, { filename: "m.glb", subfolder: "../x" }, never),
    ).toEqual({ ok: false, error: "invalid path" });
  });

  it("passes converter errors through", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "m.glb"), "glb");
    const r = await ensureUsdz(
      root,
      { filename: "m.glb", subfolder: "" },
      async () => ({ ok: false, error: "exit 1" }),
    );
    expect(r).toEqual({ ok: false, error: "exit 1" });
  });
});

// Real conversion (CPU-only Blender, ~1-3s). Skipped on hosts without Blender.
describe.skipIf(!findBlender())("real Blender export", () => {
  it("turns a vertex-coloured GLB into a USDZ zip with a primvar-driven material", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "m.glb"), vertexColorGlb());
    const r = await ensureUsdz(root, { filename: "m.glb", subfolder: "" });
    expect(r).toEqual({
      ok: true,
      usdz: { filename: "m.usdz", subfolder: "" },
    });
    const usdz = fs.readFileSync(path.join(root, "m.usdz"));
    expect(usdz.subarray(0, 4).toString("hex")).toBe("504b0304"); // zip local header
    expect(usdz.includes(Buffer.from("m.usdc"))).toBe(true); // layer named after the target, not a temp
    // Crate tokens are compressed, so inspect the stage with Blender's bundled pxr.
    const probe = execFileSync(
      findBlender()!,
      [
        "-b",
        "--factory-startup",
        "--python-expr",
        [
          "from pxr import Usd, UsdShade",
          `st = Usd.Stage.Open(${JSON.stringify(path.join(root, "m.usdz"))})`,
          "print('UP=' + str(st.GetMetadata('upAxis')))",
          "[print('ID=' + str(UsdShade.Shader(p).GetIdAttr().Get())) for p in st.Traverse() if p.GetTypeName() == 'Shader']",
        ].join("\n"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(probe).toContain("UP=Y");
    expect(probe).toContain("ID=UsdPreviewSurface");
    expect(probe).toContain("ID=UsdPrimvarReader_float3");
    // no temp dirs left behind
    expect(fs.readdirSync(root).sort()).toEqual(["m.glb", "m.usdz"]);
  }, 60_000);

  it("fails with a non-zero exit on a corrupt GLB and leaves no output", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "bad.glb"), "not a glb");
    const r = await ensureUsdz(root, { filename: "bad.glb", subfolder: "" });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(root)).toEqual(["bad.glb"]);
  }, 60_000);
});

describe("groupRuns output buckets", () => {
  const base: RecentRunRow = {
    run_id: "r1",
    prompt: "a duck",
    parsed_prompt: null,
    params: null,
    width: 512,
    height: 512,
    created_at: 1_700_000_000,
    job_id: "r1:0",
    seed: 1,
    job_status: "done",
    progress: 100,
    prompt_id_comfy: "p1",
    job_error: null,
    output_filename: null,
    output_subfolder: null,
    output_type: "output",
    output_media: null,
  };
  const row = (
    filename: string,
    media: string | null,
    subfolder = "",
  ): RecentRunRow => ({
    ...base,
    output_filename: filename,
    output_subfolder: subfolder,
    output_media: media,
  });

  it("splits images/videos, meshes and audio", () => {
    const [run] = groupRuns([
      row("in.png", "image"),
      row("clip.mp4", "video"),
      row("mesh.glb", "mesh", "3d"),
      row("mesh.usdz", "mesh", "3d"),
      row("song.flac", "audio"),
    ]);
    const job = run.jobs[0];
    expect(job.images).toHaveLength(2);
    expect(job.meshes).toEqual([
      "/api/comfy/image?filename=mesh.glb&subfolder=3d&type=output",
      "/api/comfy/image?filename=mesh.usdz&subfolder=3d&type=output",
    ]);
    expect(job.audios).toEqual([
      "/api/comfy/image?filename=song.flac&subfolder=&type=output",
    ]);
  });

  it("omits empty mesh/audio arrays and falls back to extension for legacy rows", () => {
    const [run] = groupRuns([row("a.png", null)]);
    expect(run.jobs[0]).not.toHaveProperty("meshes");
    expect(run.jobs[0]).not.toHaveProperty("audios");
    expect(outputBucket("legacy.glb", "image")).toBe("meshes");
    expect(outputBucket("x.wav", null)).toBe("audios");
    expect(outputBucket("x.webp", null)).toBe("images");
  });
});
