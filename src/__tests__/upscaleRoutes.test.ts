/**
 * Upscale routes: GET /api/comfy/upscale-models (picker options) and
 * POST /api/jobs/action dry_run for Faithful / Creative with a model choice.
 * Nothing is queued.
 */
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";

vi.mock("@/lib/env", () => ({
  env: {
    COMFY_ROOT: "/nonexistent",
    COMFY_HTTP_URL: "http://mac:8188",
    ADMIN_API_KEY: "",
  },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
const infoMock = vi.fn();
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: (...a: unknown[]) => infoMock(...a),
}));
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  uploadImageToComfy: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));
vi.mock("@/lib/comfy/runs", () => ({
  getActiveRun: vi.fn(),
  addActiveRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));

import { queuePrompt } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";

const WF_DIR = path.join(process.cwd(), "public/workflows");
const graph = (p: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.isAbsolute(p) ? p : path.join(WF_DIR, p), "utf8"),
  ) as Workflow;

function sourceRun(): ImagineRun {
  return {
    run_id: "src",
    prompt: "a fox",
    parsedPrompt: "a fox",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 9,
        index: 0,
        status: "done",
        progress: 100,
        images: ["/api/comfy/view?filename=a.png&subfolder=cj&type=output"],
      },
    ],
    params: {},
  } as ImagineRun;
}

const actionReq = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/jobs/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "cid",
      run_id: "src",
      job_index: 0,
      dry_run: true,
      ...body,
    }),
  });

const ofClass = (wf: Workflow, cls: string) =>
  Object.values(wf).filter((n) => n.class_type === cls);

describe("GET /api/comfy/upscale-models", () => {
  beforeEach(() => infoMock.mockReset());

  const get = async (qs = "") => {
    const { GET } = await import("@/app/api/comfy/upscale-models/route");
    return GET(new NextRequest(`http://localhost/api/comfy/upscale-models${qs}`));
  };

  it("lists upscalers from the COMBO spec, minus face-restore files", async () => {
    infoMock.mockResolvedValue({
      UpscaleModelLoader: {
        input: {
          required: {
            model_name: [
              "COMBO",
              { options: ["RealESRGAN_x2plus.pth", "GFPGANv1.4.pth", "4x-UltraSharp.pth"] },
            ],
          },
        },
      },
    });
    const res = await get("?fresh=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.models).toEqual([
      {
        file: "4x-UltraSharp.pth",
        scale: 4,
        label: "4x-UltraSharp · 4×",
        name: "UltraSharp",
        category: "photo",
        tags: ["sharp"],
      },
      {
        file: "RealESRGAN_x2plus.pth",
        scale: 2,
        label: "RealESRGAN_x2plus · 2×",
        name: "Real-ESRGAN",
        category: "2x",
        tags: ["smooth", "denoise"],
      },
    ]);
    expect(infoMock).toHaveBeenCalledWith(undefined, { fresh: true });
  });

  it("reports available=false when the node is missing", async () => {
    infoMock.mockResolvedValue({ KSampler: {} });
    const body = await (await get()).json();
    expect(body).toMatchObject({ ok: true, available: false, models: [] });
  });

  it("503s when ComfyUI is unreachable", async () => {
    infoMock.mockResolvedValue(null);
    expect((await get()).status).toBe(503);
  });
});

describe("POST /api/jobs/action upscale dry_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveRun).mockReturnValue(sourceRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async (p?: string) => graph(p!) as never,
    );
  });

  it("Faithful applies the chosen model and queues nothing", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      actionReq({
        action: "upscale_subtle",
        params: { pack_id: "sdxl", upscale_model: "4x-UltraSharp.pth" },
      }),
    );
    const body = (await res.json()) as { ok: boolean; workflow: Workflow };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(ofClass(body.workflow, "KSampler")).toHaveLength(0);
    expect(ofClass(body.workflow, "UpscaleModelLoader")[0].inputs.model_name).toBe(
      "4x-UltraSharp.pth",
    );
    expect(ofClass(body.workflow, "LoadImage")[0].inputs.image).toBe(
      "cj/a.png [output]",
    );
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("Creative applies creativity and model", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      actionReq({
        action: "upscale_creative",
        params: {
          pack_id: "sdxl",
          upscale_model: "RealESRGAN_x2plus.pth",
          creativity: 100,
        },
      }),
    );
    const body = (await res.json()) as { ok: boolean; workflow: Workflow };
    expect(res.status).toBe(200);
    expect(ofClass(body.workflow, "KSampler")[0].inputs.denoise).toBe(0.5);
    expect(ofClass(body.workflow, "ImageScaleBy")[0].inputs.scale_by).toBe(1);
    expect(ofClass(body.workflow, "SplitImageToTileList")).toHaveLength(1);
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
