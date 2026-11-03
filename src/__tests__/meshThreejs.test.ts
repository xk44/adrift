/** "Export for Three.js": which files go in, what the page does, and the route. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { BlenderExportActions } from "@/components/BlenderExportActions";
import { writeGlb } from "@/lib/mesh/meshConvert";
import { SPARK_VERSION, THREE_VERSION, buildThreejsBundle, threejsPage } from "@/lib/mesh/threejsBundle";
import { listZipEntries } from "@/lib/userTools/zip";

const glb = writeGlb({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});
const obj = new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
const splat = new TextEncoder().encode(
  `ply\nformat binary_little_endian 1.0\nelement vertex 0\n${["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    .map((p) => `property float ${p}`)
    .join("\n")}\nend_header\n`,
);
const text = (data: string | Uint8Array) =>
  typeof data === "string" ? data : new TextDecoder().decode(data);

describe("buildThreejsBundle", () => {
  it("copies GLB and splats and writes a page and README", () => {
    const b = buildThreejsBundle([
      { name: "m_1_.glb", data: glb },
      { name: "s_1_.ply", data: splat },
    ]);
    expect(b.assets).toEqual([
      { path: "m_1.glb", kind: "gltf" },
      { path: "s_1.ply", kind: "splat" },
    ]);
    expect(b.files.map((f) => f.path)).toEqual(["index.html", "README.txt", "m_1.glb", "s_1.ply"]);
    const readme = text(b.files[1].data);
    expect(readme).toContain("GLTFLoader");
    expect(readme).toContain("SplatMesh");
    expect(readme).toContain("python3 -m http.server");
  });

  it("converts OBJ to GLB and notes what it can't keep", () => {
    const b = buildThreejsBundle([{ name: "a.obj", data: obj }]);
    expect(b.assets).toEqual([{ path: "a.glb", kind: "gltf" }]);
    expect(b.notes.join(" ")).toContain("without separate material");
    const data = b.files.find((f) => f.path === "a.glb")!.data as Uint8Array;
    expect(new DataView(data.buffer, data.byteOffset).getUint32(0, true)).toBe(0x46546c67);
  });

  it("leaves out what three.js can't load, and says so", () => {
    const b = buildThreejsBundle([{ name: "a.usdz", data: new Uint8Array(4) }]);
    expect(b.assets).toEqual([]);
    expect(b.files.map((f) => f.path)).toEqual(["index.html", "README.txt"]);
  });

  it("keeps two files with one stem apart", () => {
    const b = buildThreejsBundle([
      { name: "a.glb", data: glb },
      { name: "a.obj", data: obj },
    ]);
    expect(b.assets.map((a) => a.path)).toEqual(["a.glb", "a_2.glb"]);
  });
});

describe("threejsPage", () => {
  it("pins versions and only loads Spark when there is a splat", () => {
    const mesh = threejsPage("m", [{ path: "m.glb", kind: "gltf" }]);
    expect(mesh).toContain(`three@${THREE_VERSION}/`);
    expect(mesh).not.toContain(`@sparkjsdev/spark@`);
    const both = threejsPage("m", [{ path: "s.ply", kind: "splat" }]);
    expect(both).toContain(`@sparkjsdev/spark@${SPARK_VERSION}/`);
    // Splat files are Y-down; the flip lines them up with the GLB.
    expect(both).toContain("quaternion.set(1, 0, 0, 0)");
  });

  it("can't be broken out of by a file name", () => {
    const b = buildThreejsBundle([{ name: "</title><script>x.glb", data: glb }]);
    const page = text(b.files[0].data);
    expect(page).not.toContain("<script>x");
    const direct = threejsPage("m", [{ path: "</script><img src=x>.glb", kind: "gltf" }]);
    expect(direct).not.toContain("<img src=x>");
  });
});

describe("Export for Three.js button", () => {
  const render = (url: string) =>
    renderToStaticMarkup(createElement(BlenderExportActions, { urls: [url], className: "b" }));
  it("links the bundle for meshes and splats", () => {
    const html = render("/api/comfy/image?filename=s_1_.ply&subfolder=3d&type=output");
    expect(html).toContain("/api/comfy/threejs-bundle?filename=s_1_.ply");
    expect(html).toContain("Export for Three.js");
    expect(html).toContain("download");
  });
  it("isn't offered for layers", () => {
    const html = renderToStaticMarkup(
      createElement(BlenderExportActions, {
        source: { kind: "layers", manifest: "l_layers.json" },
        className: "b",
      }),
    );
    expect(html).not.toContain("Three.js");
  });
});

describe("GET /api/comfy/threejs-bundle", () => {
  const fetchImageResponse = vi.fn();
  beforeEach(() => fetchImageResponse.mockReset());
  async function get(query: string) {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: { ADMIN_API_KEY: "", COMFY_ROOT: "/tmp/cj-comfy", COMFY_HTTP_URL: "http://127.0.0.1:8188", NODE_ENV: "test" },
    }));
    vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
    vi.doMock("@/lib/comfy/http", () => ({ fetchImageResponse }));
    const { GET } = await import("@/app/api/comfy/threejs-bundle/route");
    return GET(
      new NextRequest(`http://localhost/api/comfy/threejs-bundle${query}`, {
        headers: { host: "localhost" },
      }),
    );
  }

  it("returns a zip with the page and the model", async () => {
    fetchImageResponse.mockResolvedValue(new Response(Buffer.from(glb)));
    const res = await get("?filename=m_1_.glb&subfolder=3d&type=output");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="m_1_threejs.zip"');
    expect(fetchImageResponse).toHaveBeenCalledWith("m_1_.glb", "3d", "output");
    const names = listZipEntries(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(["m_1/index.html", "m_1/README.txt", "m_1/m_1.glb"]),
    );
  });

  it("rejects a request with no files", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("rejects files it can't turn into anything", async () => {
    fetchImageResponse.mockResolvedValue(new Response(Buffer.from([1, 2, 3, 4])));
    expect((await get("?filename=a.usdz&subfolder=3d&type=output")).status).toBe(400);
  });
});
