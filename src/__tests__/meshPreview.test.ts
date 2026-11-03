import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previewableMesh } from "@/lib/galleryMedia";

describe("previewableMesh", () => {
  it("picks the first GLB, also behind a view URL", () => {
    expect(previewableMesh(["/a.ply", "/b.glb", "/c.glb"])).toBe("/b.glb");
    const view = "/api/comfy/image?filename=m_00001_.GLB&subfolder=3d";
    expect(previewableMesh(["/a.bvh", view])).toBe(view);
  });

  it("does not guess: splats, motion, gltf and unknown names stay downloads", () => {
    expect(
      previewableMesh(["/a.ply", "/a.spz", "/a.bvh", "/a.gltf", "/noext"]),
    ).toBeUndefined();
    expect(previewableMesh(undefined)).toBeUndefined();
    expect(previewableMesh([undefined])).toBeUndefined();
  });
});

describe("MeshPreview", () => {
  const src = readFileSync("src/components/MeshPreview.tsx", "utf8");

  it("loads the viewer lazily, never at module scope", () => {
    expect(src).toContain('import("@google/model-viewer")');
    expect(src).not.toMatch(/^import .*model-viewer/m);
    expect(src).not.toMatch(/^import .*["']three/m);
  });

  it("keeps decoders off Google's CDN", () => {
    for (const k of ["dracoDecoderLocation", "ktx2TranscoderLocation"]) {
      expect(src).toContain(`ModelViewerElement.${k} = NO_CDN`);
    }
  });

  it("leaves meshopt unset, since a dead path there breaks every GLB", () => {
    expect(src).not.toContain("ModelViewerElement.meshoptDecoderLocation =");
  });
});
