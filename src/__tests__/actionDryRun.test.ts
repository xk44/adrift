/**
 * POST /api/jobs/action dry_run: returns the exact API workflow a real call
 * would queue, without queueing or recording a run.
 */
import fs from "fs";
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
import { addActiveRun, getActiveRun } from "@/lib/comfy/runs";
import { insertRun } from "@/lib/db";

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
        images: ["/api/comfy/view?filename=a.png&subfolder=cj&type=input"],
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

const TRANSITION = {
  action: "transition",
  params: {
    pack_id: "minimax",
    secondRefImage: "end.png [input]",
    prompt: "fade",
    seed: 5,
  },
};

describe("action route dry_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMFY_VIDEO_HTTP_URL;
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
    vi.mocked(getActiveRun).mockReturnValue(sourceRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async (p?: string) => graph(p!) as never,
    );
  });

  it("returns the built workflow and queues nothing", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ ...TRANSITION, dry_run: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      workflow: Workflow;
      action: string;
      seed: number;
      run?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("transition");
    expect(body.run).toBeUndefined();
    expect(body.workflow["17"].inputs.image).toBe("end.png [input]");
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(addActiveRun).not.toHaveBeenCalled();
    expect(insertRun).not.toHaveBeenCalled();
  });

  it("dry run graph equals the graph a real call queues", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const dry = (await (
      await POST(req({ ...TRANSITION, dry_run: true }))
    ).json()) as { workflow: Workflow };
    await POST(req(TRANSITION));
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(dry.workflow).toEqual(queued);
  });

  it("rejects a non-boolean dry_run", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ ...TRANSITION, dry_run: "yes" }));
    expect(res.status).toBe(400);
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
