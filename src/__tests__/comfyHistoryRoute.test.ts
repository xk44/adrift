import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchHistory = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireAdmin: () => ({ ok: true }),
}));

vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

vi.mock("@/lib/comfy/http", () => ({
  fetchHistory,
}));

function request(promptId: string): NextRequest {
  return new NextRequest(`http://localhost/api/comfy/history/${promptId}`);
}

describe("GET /api/comfy/history/[promptId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps VHS and core SaveVideo history outputs into videos", async () => {
    fetchHistory.mockResolvedValue({
      prompt: [0, "prompt-video", {}, {}],
      outputs: {
        "9": {
          gifs: [
            {
              filename: "legacy_00001_.gif",
              subfolder: "",
              type: "output",
              format: "gif",
            },
          ],
          videos: [
            {
              filename: "legacy_00002_.mp4",
              subfolder: "video",
              type: "output",
              format: "mp4",
            },
          ],
        },
        "15": {
          images: [
            {
              filename: "Adrift_ltxv_00001_.mp4",
              subfolder: "video",
              type: "output",
            },
          ],
          animated: [true],
        },
        "20": {
          images: [
            {
              filename: "Adrift_00001_.png",
              subfolder: "",
              type: "output",
            },
          ],
        },
      },
      status: { completed: true, status_str: "success" },
    });

    const { GET } = await import("@/app/api/comfy/history/[promptId]/route");
    const res = await GET(request("prompt-video"), {
      params: Promise.resolve({ promptId: "prompt-video" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    // GIFs (even under VHS's "gifs" key) animate in <img>, not <video>,
    // so they land in images — see lib/comfy/outputs.ts classifyFile.
    expect(
      data.images.map((img: { filename: string }) => img.filename),
    ).toEqual(["legacy_00001_.gif", "Adrift_00001_.png"]);
    expect(
      data.videos.map((vid: { filename: string }) => vid.filename),
    ).toEqual(["legacy_00002_.mp4", "Adrift_ltxv_00001_.mp4"]);
    expect(data.videos[1]).toMatchObject({
      subfolder: "video",
      type: "output",
      format: "mp4",
    });
  });

  it('reads core SaveGLB\'s "3d" key and legacy "meshes" as meshes', async () => {
    fetchHistory.mockResolvedValue({
      prompt: [0, "prompt-3d", {}, {}],
      outputs: {
        "4": {
          "3d": [
            { filename: "mesh_00001_.glb", subfolder: "3d", type: "output" },
          ],
        },
        "5": {
          meshes: [{ filename: "old.glb", subfolder: "", type: "output" }],
        },
      },
      status: { completed: true, status_str: "success" },
    });
    const { GET } = await import("@/app/api/comfy/history/[promptId]/route");
    const res = await GET(request("prompt-3d"), {
      params: Promise.resolve({ promptId: "prompt-3d" }),
    });
    const data = await res.json();
    expect(data.meshes.map((m: { filename: string }) => m.filename)).toEqual([
      "mesh_00001_.glb",
      "old.glb",
    ]);
    expect(data.meshes[0].url).toBe(
      "/api/comfy/image?filename=mesh_00001_.glb&subfolder=3d&type=output",
    );
  });
});
