/**
 * Public build: numeric style codes are not available, so the route must
 * reject them with a clear pointer to --sv 2 before queueing anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as realFs from "fs";
import * as path from "path";
import type { Workflow } from "@/types";

vi.mock("@/lib/env", () => ({
  env: {
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    COMFY_ROOT: "/tmp/cj-fake-comfy",
    COMFY_DEFAULT_CHECKPOINT: "model.safetensors",
    STYLEVAULT_API_URL: "http://127.0.0.1:8000",
    CIVITAI_API_URL: "https://civitai.com/api/v1",
    CIVITAI_API_KEY: "",
    NODE_ENV: "test",
  },
}));
vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));
vi.mock("@/lib/comfy/runs", () => ({ addActiveRun: vi.fn() }));
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchAvailableCheckpoints: vi.fn().mockResolvedValue(["model.safetensors"]),
  uploadImage: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
  parseWorkflowJson: vi.fn(),
}));

const STYLE_DIR = "/tmp/cj-fake-comfy/models/style_files";
const compiled = new Set<string>();
let styleDirExists = true;
const accessSpy = vi.fn(async (p: string) => {
  if (p === STYLE_DIR && styleDirExists) return;
  if (
    p.startsWith(`${STYLE_DIR}/`) &&
    styleDirExists &&
    compiled.has(p.slice(STYLE_DIR.length + 1))
  )
    return;
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
});

// Native Krea 2 graph: the only family style nodes are injected into.
const WORKFLOW = JSON.parse(
  realFs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/krea2/t2i.json"),
    "utf-8",
  ),
);

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(WORKFLOW)),
    readdir: vi.fn(async () => []),
    access: (p: string) => accessSpy(p),
  },
}));

import { queuePrompt } from "@/lib/comfy/http";

function request(prompt: string) {
  return new NextRequest("http://localhost:3000/api/jobs/imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "test-client", batch_size: 1 }),
  });
}

function steerNodes(wf: Workflow) {
  return Object.values(wf).filter((n) => n.class_type === "StyleSteer");
}

describe("POST /api/jobs/imagine — style codes (public build)", () => {
  beforeEach(() => {
    compiled.clear();
    styleDirExists = true;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 404 }),
    );
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a numeric style code with a pointer to --sv 2, without queueing", async () => {
    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(request("a lighthouse --sref 987654321"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("style_codes_unavailable");
    expect(body.error).toMatch(/--sv 2/);
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("rejects even when a matching file happens to exist", async () => {
    compiled.add("123456789.safetensors");
    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(request("a lighthouse --sref 123456789"));
    expect(res.status).toBe(400);
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("prompts without a style code still queue", async () => {
    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(request("a lighthouse"));
    expect(res.status).toBe(200);
    expect(steerNodes(vi.mocked(queuePrompt).mock.calls[0][0] as Workflow)).toEqual([]);
  });
});
