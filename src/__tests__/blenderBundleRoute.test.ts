/** /api/comfy/blender-bundle (zip download) and /open (loopback-only). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { listZipEntries } from "@/lib/userTools/zip";
import { writeGlb } from "@/lib/mesh/meshConvert";

const fetchImageResponse = vi.fn();
const spawn = vi.fn();

const ENV = {
  ADMIN_API_KEY: "",
  COMFY_ROOT: "/tmp/cj-comfy",
  COMFY_HTTP_URL: "http://127.0.0.1:8188",
  NODE_ENV: "test",
};

async function load() {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({ env: ENV }));
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  vi.doMock("@/lib/comfy/http", () => ({ fetchImageResponse }));
  vi.doMock("child_process", async (orig) => ({
    ...(await orig<typeof import("child_process")>()),
    spawn,
  }));
  const bundle = await import("@/app/api/comfy/blender-bundle/route");
  const open = await import("@/app/api/comfy/blender-bundle/open/route");
  return { GET: bundle.GET, openGET: open.GET, openPOST: open.POST };
}

const glb = writeGlb({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});

beforeEach(() => {
  fetchImageResponse.mockReset();
  spawn.mockReset();
});

describe("GET /api/comfy/blender-bundle", () => {
  it("returns a zip bundle for a GLB", async () => {
    fetchImageResponse.mockResolvedValue(new Response(Buffer.from(glb)));
    const { GET } = await load();
    const res = await GET(
      new NextRequest(
        "http://localhost/api/comfy/blender-bundle?filename=m_1_.glb&subfolder=3d&type=output",
        { headers: { host: "localhost" } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(
      'filename="m_1_blender.zip"',
    );
    expect(fetchImageResponse).toHaveBeenCalledWith("m_1_.glb", "3d", "output");
    const zip = new Uint8Array(await res.arrayBuffer());
    expect(listZipEntries(zip).map((e) => e.name)).toEqual([
      "m_1/import_m_1.py",
      "m_1/m_1.glb",
      "m_1/README.txt",
    ]);
  });

  it.each([
    "filename=../x.glb",
    "filename=a.png",
    "filename=a.glb&type=secret",
    "",
  ])("rejects %s", async (q) => {
    const { GET } = await load();
    const res = await GET(
      new NextRequest(`http://localhost/api/comfy/blender-bundle?${q}`, {
        headers: { host: "localhost" },
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchImageResponse).not.toHaveBeenCalled();
  });

  it("maps a missing file to 404", async () => {
    fetchImageResponse.mockRejectedValue(
      Object.assign(new Error("nope"), { statusCode: 404 }),
    );
    const { GET } = await load();
    const res = await GET(
      new NextRequest(
        "http://localhost/api/comfy/blender-bundle?filename=a.glb",
        {
          headers: { host: "localhost" },
        },
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe("/api/comfy/blender-bundle/open", () => {
  it("reports unavailable and refuses to open for non-local requests", async () => {
    const { openGET, openPOST } = await load();
    const remote = { host: "localhost", "x-forwarded-for": "10.0.0.2" };
    const g = await openGET(
      new NextRequest("http://localhost/api/comfy/blender-bundle/open", {
        headers: remote,
      }),
    );
    expect(await g.json()).toMatchObject({
      available: false,
      reason: "remote",
    });
    const p = await openPOST(
      new NextRequest("http://localhost/api/comfy/blender-bundle/open", {
        method: "POST",
        headers: { ...remote, "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "a.glb" }] }),
      }),
    );
    expect(p.status).toBe(403);
    expect(fetchImageResponse).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports the detected Blender to a local GET", async () => {
    vi.doMock("@/lib/blender/detect", async (orig) => ({
      ...(await orig<typeof import("@/lib/blender/detect")>()),
      detectBlender: async () => ({
        path: "/Applications/Blender.app/Contents/MacOS/Blender",
        version: "4.2.3",
        source: "auto",
      }),
    }));
    try {
      const { openGET } = await load();
      const g = await openGET(
        new NextRequest("http://localhost/api/comfy/blender-bundle/open", {
          headers: { host: "localhost" },
        }),
      );
      expect(await g.json()).toEqual({
        ok: true,
        available: true,
        path: "/Applications/Blender.app/Contents/MacOS/Blender",
        version: "4.2.3",
        source: "auto",
      });
    } finally {
      vi.doUnmock("@/lib/blender/detect");
    }
  });

  it("validates the file list before doing anything", async () => {
    const { openPOST } = await load();
    const res = await openPOST(
      new NextRequest("http://localhost/api/comfy/blender-bundle/open", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "../../etc/passwd.glb" }] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("Layer Split bundles", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const files: Record<string, Buffer> = {
    "ls_1_ab_layers.json": Buffer.from(
      JSON.stringify({
        prefix: "ls",
        layers: [
          {
            name: "body",
            filename: "ls_1_body.png",
            depth_filename: "ls_1_body_depth.png",
            left: 0,
            top: 0,
            right: 64,
            bottom: 64,
            depth_median: 0.5,
          },
        ],
      }),
    ),
    "ls_1_body.png": png(64, 64),
    "ls_1_body_depth.png": png(64, 64),
  };

  it("GET ?layers= zips planes, depth, script and GLB", async () => {
    fetchImageResponse.mockImplementation(async (name: string) => {
      const data = files[name];
      if (!data) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return new Response(new Uint8Array(data));
    });
    const { GET } = await load();
    const res = await GET(
      new NextRequest(
        "http://localhost/api/comfy/blender-bundle?layers=ls_1_ab_layers.json&res=1024&aspect=1.5",
        { headers: { host: "localhost" } },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetchImageResponse).toHaveBeenCalledWith(
      "ls_1_ab_layers.json",
      "",
      "output",
    );
    const zip = new Uint8Array(await res.arrayBuffer());
    const names = listZipEntries(zip).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "ls_1_ab_layers/import_layers.py",
        "ls_1_ab_layers/layers.glb",
        "ls_1_ab_layers/parts/body.png",
        "ls_1_ab_layers/depth/body_depth.png",
      ]),
    );
  });

  it("rejects a traversal manifest name", async () => {
    const { GET, openPOST } = await load();
    const res = await GET(
      new NextRequest(
        "http://localhost/api/comfy/blender-bundle?layers=..%2Fx_layers.json",
        { headers: { host: "localhost" } },
      ),
    );
    expect(res.status).toBe(400);
    const p = await openPOST(
      new NextRequest("http://localhost/api/comfy/blender-bundle/open", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ layers: { manifest: "/etc/x_layers.json" } }),
      }),
    );
    expect(p.status).toBe(400);
    expect(fetchImageResponse).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
