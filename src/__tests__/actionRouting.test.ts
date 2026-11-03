/**
 * /api/jobs/action multi-host routing: video actions queue on
 * COMFY_VIDEO_HTTP_URL (with the host's ".video.json" variant), everything
 * else on the default host; single-host behaviour unchanged.
 */
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const PC = "http://pc:8288";
const graph = (abs: string): Workflow => {
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<
    string,
    unknown
  >;
  delete raw._meta;
  return raw as unknown as Workflow;
};

function sourceRun(): ImagineRun {
  return {
    run_id: "src",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: ["/api/comfy/view?filename=a.png&subfolder=&type=output"],
        videos: ["/api/comfy/view?filename=c.mp4&subfolder=cj&type=input"],
      },
    ],
    params: {},
  } as ImagineRun;
}

const req = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/jobs/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "cid",
      run_id: "src",
      job_index: 0,
      ...body,
    }),
  });

describe("action route backend routing", () => {
  const saved = process.env.COMFY_VIDEO_HTTP_URL;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
    vi.mocked(getActiveRun).mockReturnValue(sourceRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async (p?: string) => graph(p!) as never,
    );
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
    else process.env.COMFY_VIDEO_HTTP_URL = saved;
  });

  it("single host: transition queues on the default host", async () => {
    delete process.env.COMFY_VIDEO_HTTP_URL;
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "transition",
        params: { pack_id: "minimax", secondRefImage: "end.png [input]" },
      }),
    );
    expect(res.status).toBe(200);
    const [wf, , baseUrl] = vi.mocked(queuePrompt).mock.calls[0];
    expect(baseUrl).toBeUndefined();
    expect((wf as Workflow)["17"].inputs.image).toBe("end.png [input]");
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("comfy_backend");
  });

  it("two hosts: transition goes to the video host", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "transition",
        params: { pack_id: "minimax", secondRefImage: "end.png [input]" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(queuePrompt).mock.calls[0][2]).toBe(PC);
    const opts = vi.mocked(queuePrompt).mock.calls[0][3] as {
      extraData?: unknown;
    };
    expect(JSON.stringify(opts.extraData)).toContain('"comfy_backend":"video"');
  });

  it("two hosts: character_swap loads the pc variant", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "character_swap",
        params: { pack_id: "minimax", secondRefImage: "who.png [input]" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/minimax\/character_swap\.video\.json$/,
    );
    expect(vi.mocked(queuePrompt).mock.calls[0][2]).toBe(PC);
  });

  it("two hosts: video_bg_remove stays on the default host", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ action: "video_bg_remove", params: {} }));
    expect(res.status).toBe(200);
    const [wf, , baseUrl] = vi.mocked(queuePrompt).mock.calls[0];
    expect(baseUrl).toBeUndefined();
    const load = Object.values(wf as Workflow).find(
      (n) => n.class_type === "LoadVideo",
    )!;
    expect(load.inputs.file).toBe("cj/c.mp4 [input]");
  });
});

// Keep the variant file honest: same graph as the mac one minus the LoRAs.
it("character_swap.video.json mirrors character_swap.json", () => {
  const dir = path.join(process.cwd(), "public/workflows/packs/minimax");
  const mac = graph(path.join(dir, "character_swap.json"));
  const pc = graph(path.join(dir, "character_swap.video.json"));
  for (const id of Object.keys(mac).filter(
    (k) => !["1", "16", "17", "20"].includes(k),
  ))
    expect(pc[id]).toEqual(mac[id]);
  // Same sigma shift; pc feeds it the merged UNET, mac the LoRA chain.
  expect({ ...pc["20"], inputs: { ...pc["20"].inputs, model: null } }).toEqual({
    ...mac["20"],
    inputs: { ...mac["20"].inputs, model: null },
  });
});

// The video host has no ref2va bf16 DiT: face swap runs the int8 Ref2VA there.
it("face_swap.video.json = face_swap.json on the int8 Ref2VA", () => {
  const dir = path.join(process.cwd(), "public/workflows/packs/minimax");
  const mac = graph(path.join(dir, "face_swap.json"));
  const pc = graph(path.join(dir, "face_swap.video.json"));
  for (const id of Object.keys(mac).filter((k) => k !== "1"))
    expect(pc[id]).toEqual(mac[id]);
  expect(Object.keys(pc).sort()).toEqual(Object.keys(mac).sort());
  expect(pc["1"].inputs).toEqual({
    ...mac["1"].inputs,
    unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  });
});
