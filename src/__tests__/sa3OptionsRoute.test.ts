import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { objectInfo, auth } = vi.hoisted(() => ({
  objectInfo: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: () => objectInfo(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => auth() }));

import { GET, OPTIONS } from "@/app/api/tools/sa3-options/route";

const req = () => new NextRequest("http://localhost/api/tools/sa3-options");

describe("GET /api/tools/sa3-options", () => {
  beforeEach(() => {
    objectInfo.mockReset();
    auth.mockReset().mockReturnValue({ ok: true });
  });

  it("lists audio LoRAs and whether Quality is installed", async () => {
    objectInfo.mockResolvedValue({
      LoraLoaderModelOnly: {
        input: {
          required: {
            lora_name: [["x.safetensors", "audio/keys.safetensors"]],
          },
        },
      },
      CheckpointLoaderSimple: {
        input: {
          required: {
            ckpt_name: [
              [
                "stable_audio_3_medium.safetensors",
                "stable_audio_3_medium_base.safetensors",
              ],
            ],
          },
        },
      },
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      reachable: true,
      loras: ["audio/keys.safetensors"],
      quality: true,
    });
  });

  it("degrades to no options when ComfyUI is unreachable", async () => {
    objectInfo.mockResolvedValue(null);
    expect(await (await GET(req())).json()).toEqual({
      ok: true,
      reachable: false,
      loras: [],
      quality: false,
    });
  });

  it("is admin-gated", async () => {
    const { NextResponse } = await import("next/server");
    auth.mockReturnValue({
      ok: false,
      response: NextResponse.json({ ok: false }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(objectInfo).not.toHaveBeenCalled();
  });

  it("answers CORS preflight", () => {
    expect(OPTIONS().status).toBe(204);
  });
});
