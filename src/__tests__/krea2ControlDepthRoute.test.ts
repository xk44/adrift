/**
 * POST /api/jobs/imagine --controlnet on the Krea 2 control graph: the
 * Control attachment is uploaded, wired into the LoadImage, and depth is
 * estimated in-graph (DA3) unless the image is grayscale / --cn-depthmap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import realFs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Workflow } from "@/types";

const PACK_JSON = realFs.readFileSync(
  path.join(process.cwd(), "public/workflows/packs/krea2/controlnet.json"),
  "utf8",
);

async function importRoute() {
  vi.doMock("fs/promises", () => ({
    default: { readFile: vi.fn().mockResolvedValue(PACK_JSON) },
  }));
  const queuePrompt = vi.fn().mockResolvedValue({ prompt_id: "p1" });
  const uploadImage = vi
    .fn()
    .mockResolvedValue({ name: "cn_up.png", subfolder: "", type: "input" });
  vi.doMock("@/lib/comfy/http", () => ({
    queuePrompt,
    uploadImage,
    ComfyAPIError: class ComfyAPIError extends Error {},
    fetchAvailableCheckpoints: vi.fn().mockResolvedValue(["model.safetensors"]),
  }));
  vi.doMock("@/lib/comfy/runs", () => ({ addActiveRun: vi.fn() }));
  vi.doMock("@/lib/db", () => ({
    insertPrompt: vi.fn(),
    insertRun: vi.fn(),
    insertJob: vi.fn(),
  }));
  vi.doMock("@/lib/comfy/workflows", () => ({
    loadWorkflowFromSelection: vi.fn(),
  }));
  vi.doMock("@/lib/comfy/workflowPathGuard", () => ({
    resolveContainedWorkflowPath: vi.fn(async (sel: string) => `/wf/${sel}`),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false }) }),
  );
  const { POST } = await import("@/app/api/jobs/imagine/route");
  return { POST, queuePrompt, uploadImage };
}

async function dataUrl(rgb: {
  r: number;
  g: number;
  b: number;
}): Promise<string> {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function post(
  POST: (r: import("next/server").NextRequest) => Promise<Response>,
  body: Record<string, unknown>,
) {
  return POST(
    new Request("http://localhost:3000/api/jobs/imagine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "c1", batch_size: 1, ...body }),
    }) as unknown as import("next/server").NextRequest,
  );
}

function queued(queuePrompt: ReturnType<typeof vi.fn>): Workflow {
  return queuePrompt.mock.calls[0][0] as Workflow;
}

function classes(wf: Workflow): string[] {
  return Object.values(wf).map((n) => n.class_type);
}

describe("imagine --controlnet (Krea 2 auto depth)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CJ_DEFAULT_PACK", "krea2");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("color control image: uploaded and run through DA3", async () => {
    const { POST, queuePrompt, uploadImage } = await importRoute();
    const res = await post(POST, {
      prompt: "a house --controlnet depth --cn-strength 0.7",
      source_images: [
        {
          id: "a",
          url: await dataUrl({ r: 200, g: 30, b: 90 }),
          mode: "control",
          weight: 1,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(uploadImage).toHaveBeenCalledTimes(1);
    const wf = queued(queuePrompt);
    expect(classes(wf)).toEqual(
      expect.arrayContaining(["LoadDA3Model", "DA3Inference", "DA3Render"]),
    );
    const load = Object.values(wf).find((n) => n.class_type === "LoadImage")!;
    expect(load.inputs.image).toBe("cn_up.png");
    const lora = Object.values(wf).find(
      (n) => n.class_type === "Krea2ControlLoRALoader",
    )!;
    expect(lora.inputs.strength).toBe(0.7);
  });

  it("grayscale control image skips DA3", async () => {
    const { POST, queuePrompt } = await importRoute();
    const res = await post(POST, {
      prompt: "a house --controlnet depth",
      source_images: [
        {
          id: "a",
          url: await dataUrl({ r: 120, g: 120, b: 120 }),
          mode: "control",
          weight: 1,
        },
      ],
    });
    expect(res.status).toBe(200);
    const wf = queued(queuePrompt);
    expect(
      classes(wf).some((c) => c.startsWith("DA3") || c === "LoadDA3Model"),
    ).toBe(false);
    const enc = Object.values(wf).find(
      (n) => n.class_type === "Krea2ControlImageEncode",
    )!;
    const src = String((enc.inputs.control_image as [string, number])[0]);
    expect(wf[src].class_type).toBe("LoadImage");
  });

  it("--cn-depthmap skips DA3 on a color image", async () => {
    const { POST, queuePrompt } = await importRoute();
    await post(POST, {
      prompt: "a house --controlnet depth --cn-depthmap",
      source_images: [
        {
          id: "a",
          url: await dataUrl({ r: 200, g: 30, b: 90 }),
          mode: "control",
          weight: 1,
        },
      ],
    });
    expect(classes(queued(queuePrompt)).includes("DA3Render")).toBe(false);
  });

  it("no control image: 400, nothing queued", async () => {
    const { POST, queuePrompt } = await importRoute();
    const res = await post(POST, { prompt: "a house --controlnet depth" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/control image/i);
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
