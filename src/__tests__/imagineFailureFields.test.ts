/**
 * POST /api/jobs/imagine failure envelopes carry what Create's notice needs:
 * code "no_checkpoint" when no model is available, and the ComfyUI code +
 * /prompt body when ComfyUI rejects the graph. queuePrompt is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as realFs from "fs";
import * as path from "path";
import fixtures from "./fixtures/comfy-errors/prompt-errors.json";

const h = vi.hoisted(() => ({
  checkpoints: [] as string[],
}));

vi.mock("@/lib/env", () => ({
  env: {
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    COMFY_ROOT: "/tmp/cj-fake-comfy",
    COMFY_DEFAULT_CHECKPOINT: "",
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
  fetchAvailableCheckpoints: vi.fn(async () => h.checkpoints),
  uploadImage: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {
    constructor(
      message: string,
      public statusCode?: number,
      public nodeErrors?: unknown,
      public extra?: { code?: string; body?: unknown },
    ) {
      super(message);
      this.name = "ComfyAPIError";
    }
  },
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
  parseWorkflowJson: vi.fn(),
}));

const WORKFLOW = JSON.parse(
  realFs.readFileSync(
    path.join(process.cwd(), "public/workflows/t2i.json"),
    "utf-8",
  ),
);
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(WORKFLOW)),
    readdir: vi.fn(async () => []),
    access: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  },
}));

import { queuePrompt, ComfyAPIError } from "@/lib/comfy/http";
import {
  classifyCreateResponse,
  comfyFailureFields,
} from "@/lib/create/createFailure";

function request(prompt: string) {
  return new NextRequest("http://localhost:3000/api/jobs/imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "test-client", batch_size: 1 }),
  });
}

describe("POST /api/jobs/imagine failure fields", () => {
  beforeEach(() => {
    vi.stubEnv("CJ_DEFAULT_PACK", "sdxl");
    h.checkpoints = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 404 }),
    );
    vi.mocked(queuePrompt).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("no checkpoint installed -> code no_checkpoint, nothing queued", async () => {
    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(request("a red fox in snow"));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_checkpoint");
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(classifyCreateResponse(body, res.status).action).toBe("setup");
  });

  it("ComfyUI rejection -> code + /prompt body for the client", async () => {
    h.checkpoints = ["model.safetensors"];
    vi.mocked(queuePrompt).mockRejectedValue(
      new ComfyAPIError("ComfyUI rejected the prompt", 400, undefined, {
        code: "comfy_rejected",
        body: fixtures.missing_checkpoint,
      } as never),
    );
    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(request("a red fox in snow"));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("comfy_rejected");
    expect(body.comfy).toEqual(fixtures.missing_checkpoint);
    const failure = classifyCreateResponse(body, res.status);
    expect(failure.kind).toBe("missing_model");
    expect(failure.message).not.toMatch(/#\d/);
  });
});

describe("comfyFailureFields", () => {
  it("reads code/body from the error, defaults the code", () => {
    const e = Object.assign(new Error("x"), {
      extra: { code: "comfy_timeout" },
    });
    expect(comfyFailureFields(e)).toEqual({ code: "comfy_timeout" });
    expect(comfyFailureFields(new Error("x"))).toEqual({ code: "comfy_error" });
    expect(comfyFailureFields("nope")).toBeUndefined();
  });
});
