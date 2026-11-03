/**
 * SA3 Quality → Fast fallback: when the backend's checkpoint listing lacks
 * the Medium base file, /api/jobs/action queues Fast (medium, 8 steps, cfg 1,
 * lcm/simple) and returns the reason in warnings.nodes (toasted by clients).
 */
import fs from "fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";

vi.mock("@/lib/env", () => ({
  env: {
    COMFY_ROOT: "/nonexistent",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
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
vi.mock("@/lib/comfy/objectInfoCache", async (orig) => ({
  ...(await orig<typeof import("@/lib/comfy/objectInfoCache")>()),
  getObjectInfoCached: vi.fn(),
}));

import { queuePrompt } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  SA3_QUALITY_FALLBACK_NOTE,
  sa3QualityFallbackNote,
} from "@/lib/oj/sa3QualityFallback";
import { SA3_MEDIUM_BASE_CKPT, SA3_MEDIUM_CKPT } from "@/lib/oj/sa3Params";
import { BRAND_LEAK } from "./brandLeak";

const ckptListing = (files: string[]) => ({
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [files] } } },
});

const graph = (abs: string): Workflow => {
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<
    string,
    unknown
  >;
  delete raw._meta;
  return raw as unknown as Workflow;
};

const sourceRun = (): ImagineRun =>
  ({
    run_id: "src",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images: [] }],
    params: {},
  }) as ImagineRun;

const req = (params: Record<string, unknown>, extra = {}) =>
  new NextRequest("http://localhost/api/jobs/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "cid",
      run_id: "src",
      job_index: 0,
      action: "sa3_t2a",
      params: { prompt: "warm rhodes loop", ...params },
      ...extra,
    }),
  });

function nodeOf(wf: Workflow, cls: string) {
  const hit = Object.values(wf).find((n) => n.class_type === cls);
  expect(hit, cls).toBeDefined();
  return hit!.inputs as Record<string, unknown>;
}

describe("sa3QualityFallbackNote", () => {
  const q = { speed: "quality" };
  it("only for SA3 actions asking for Quality", () => {
    expect(sa3QualityFallbackNote("sa3_t2a", { speed: "fast" }, [])).toBeNull();
    expect(sa3QualityFallbackNote("upscale", q, [])).toBeNull();
    expect(sa3QualityFallbackNote("sa3_extend", q, [])).toBe(
      SA3_QUALITY_FALLBACK_NOTE,
    );
  });

  it("matches the base file in a subfolder, any case", () => {
    expect(
      sa3QualityFallbackNote("sa3_t2a", q, [
        `audio\\${SA3_MEDIUM_BASE_CKPT.toUpperCase()}`,
      ]),
    ).toBeNull();
  });

  it("unknown listing keeps what was asked", () => {
    expect(sa3QualityFallbackNote("sa3_t2a", q, null)).toBeNull();
  });

  it("note is plain and names the file", () => {
    expect(SA3_QUALITY_FALLBACK_NOTE).toContain(SA3_MEDIUM_BASE_CKPT);
    expect(SA3_QUALITY_FALLBACK_NOTE).toContain("Fast");
    expect(SA3_QUALITY_FALLBACK_NOTE).not.toMatch(BRAND_LEAK);
  });
});

describe("POST /api/jobs/action SA3 Quality fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
    vi.mocked(getActiveRun).mockReturnValue(sourceRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async (p?: string) => graph(p!) as never,
    );
  });

  it("base missing: queues Fast and says why", async () => {
    vi.mocked(getObjectInfoCached).mockResolvedValue(
      ckptListing([SA3_MEDIUM_CKPT, "sd_xl_base_1.0.safetensors"]),
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ speed: "quality" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.nodes).toEqual([SA3_QUALITY_FALLBACK_NOTE]);
    expect(body.run.params.speed).toBe("fast");
    const wf = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(nodeOf(wf, "CheckpointLoaderSimple").ckpt_name).toBe(
      SA3_MEDIUM_CKPT,
    );
    const ks = nodeOf(wf, "KSampler");
    expect(ks).toMatchObject({
      steps: 8,
      cfg: 1,
      sampler_name: "lcm",
      scheduler: "simple",
    });
  });

  it("base installed: queues Quality, no warning", async () => {
    vi.mocked(getObjectInfoCached).mockResolvedValue(
      ckptListing([SA3_MEDIUM_CKPT, SA3_MEDIUM_BASE_CKPT]),
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ speed: "quality" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toBeUndefined();
    const wf = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(nodeOf(wf, "CheckpointLoaderSimple").ckpt_name).toBe(
      SA3_MEDIUM_BASE_CKPT,
    );
    expect(nodeOf(wf, "KSampler")).toMatchObject({ steps: 50, cfg: 7 });
  });

  it("Fast requests never look at the listing", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ speed: "fast" }));
    expect(res.status).toBe(200);
    expect(getObjectInfoCached).not.toHaveBeenCalled();
    expect((await res.json()).warnings).toBeUndefined();
  });

  it("dry run carries the same note", async () => {
    vi.mocked(getObjectInfoCached).mockResolvedValue(
      ckptListing([SA3_MEDIUM_CKPT]),
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(req({ speed: "quality" }, { dry_run: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.nodes).toEqual([SA3_QUALITY_FALLBACK_NOTE]);
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(
      nodeOf(body.workflow as Workflow, "CheckpointLoaderSimple").ckpt_name,
    ).toBe(SA3_MEDIUM_CKPT);
  });
});
