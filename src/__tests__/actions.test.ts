/**
 * Action Route + buildActionWorkflow Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildActionWorkflow, getActionDenoise } from "@/lib/oj/engine";
import type { ImagineRun, Workflow } from "@/types";

// ---------------------------------------------------------------------------
// buildActionWorkflow unit tests (pure, no route needed)
// ---------------------------------------------------------------------------

// Properly linked i2i workflow — node references use ComfyUI array format [nodeId, outputIndex]
// so discoverI2ISlots / discoverT2ISlots can trace the graph.
//
// Graph:  LoadImage(1) -> VAEEncode(2) -> KSampler(5) latent_image
//         CLIP(3) positive text -> KSampler(5) positive
//         CLIP(4) negative text -> KSampler(5) negative
//         EmptyLatentImage(6)   -> KSampler(5) latent_image  (used for t2i slot; i2i uses VAEEncode)
function makeI2IWorkflow(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "source.png" } },
    "2": { class_type: "VAEEncode", inputs: { pixels: ["1", 0] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "positive" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "negative" } },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        denoise: 1.0,
        steps: 20,
        cfg: 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["6", 0],
        model: ["2", 0],
      },
    },
  } as unknown as Workflow;
}

// Inpaint variant — adds LoadImageMask node
function makeInpaintWorkflow(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "source.png" } },
    "2": { class_type: "LoadImageMask", inputs: { image: "mask.png" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "positive" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "negative" } },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        denoise: 1.0,
        steps: 20,
        cfg: 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["6", 0],
      },
    },
  } as unknown as Workflow;
}

function makeOutpaintWorkflow(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "source.png" } },
    "2": {
      class_type: "ImagePadForOutpaint",
      inputs: {
        image: ["1", 0],
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        feathering: 40,
      },
    },
    "3": {
      class_type: "VAEEncodeForInpaint",
      inputs: {
        pixels: ["2", 0],
        mask: ["2", 1],
        vae: ["8", 2],
        grow_mask_by: 8,
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: "positive", clip: ["8", 1] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: "negative", clip: ["8", 1] },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        denoise: 1.0,
        steps: 20,
        cfg: 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["3", 0],
        model: ["8", 0],
      },
    },
    "8": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" },
    },
  } as unknown as Workflow;
}

function makeSourceRun(overrides: Partial<ImagineRun> = {}): ImagineRun {
  return {
    run_id: "run-001",
    prompt: "a forest scene",
    parsedPrompt: "a forest scene",
    width: 1024,
    height: 1024,
    jobs: [
      {
        seed: 42,
        index: 0,
        status: "done",
        progress: 100,
        images: ["img.png"],
        prompt_id: "p-001",
      },
    ],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
    ...overrides,
  };
}

describe("buildActionWorkflow", () => {
  describe("vary actions use i2i slot discovery", () => {
    it("vary_subtle sets denoise from registry (0.25)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.25);
    });

    it("vary_strong sets denoise from registry (0.65)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_strong",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.65);
    });
  });

  describe("upscale actions resolve workflow", () => {
    it("upscale_subtle returns a workflow with ksampler slot", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "upscale_subtle",
        sourceRun,
        0,
      );

      expect(workflow).toBeDefined();
      expect(slots.ksamplerId).toBeTruthy();
      expect(typeof workflow[slots.ksamplerId].inputs.seed).toBe("number");
    });

    it("upscale_creative returns a workflow with ksampler slot", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "upscale_creative",
        sourceRun,
        0,
      );

      expect(workflow).toBeDefined();
      expect(slots.ksamplerId).toBeTruthy();
    });
  });

  describe("remix uses the edited prompt (not the source prompt)", () => {
    it("injects the edited prompt text into the positive CLIP node", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow } = buildActionWorkflow(
        wf,
        "remix_subtle",
        sourceRun,
        0,
        {
          prompt: "a neon cyberpunk city",
        },
      );

      // Node "3" is the positive CLIPTextEncode.
      expect(workflow["3"].inputs.text).toContain("neon cyberpunk city");
      expect(workflow["3"].inputs.text).not.toContain("forest");
    });

    it("strips trailing prompt flags from an edited prompt into params, not text", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow } = buildActionWorkflow(
        wf,
        "remix_subtle",
        sourceRun,
        0,
        {
          prompt: "a neon city --ar 16:9",
        },
      );

      expect(workflow["3"].inputs.text).not.toContain("--ar");
      expect(workflow["3"].inputs.text).toContain("neon city");
    });

    it("falls back to the source prompt when no edit is given", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow } = buildActionWorkflow(wf, "vary_subtle", sourceRun, 0);

      expect(workflow["3"].inputs.text).toContain("forest");
    });
  });

  describe("buildActionWorkflow returns the actual seed used", () => {
    it("vary reuses the source seed", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { seed } = buildActionWorkflow(wf, "vary_subtle", sourceRun, 0);
      expect(seed).toBe(42);
    });

    it("remix returns a fresh numeric seed, not the source seed", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { seed, workflow, slots } = buildActionWorkflow(
        wf,
        "remix_subtle",
        sourceRun,
        0,
      );
      expect(typeof seed).toBe("number");
      // the returned seed matches what was injected into the workflow
      expect(workflow[slots.ksamplerId].inputs.seed).toBe(seed);
    });

    it("honours an explicit seed override", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { seed } = buildActionWorkflow(wf, "remix_subtle", sourceRun, 0, {
        seed: 777,
      });
      expect(seed).toBe(777);
    });
  });

  describe("zoom/pan action slot selection", () => {
    it("zoom_out_2x (normalised to zoom_2x) uses image-to-image slots", () => {
      // normalizeWorkflowActionId maps zoom_out_2x -> zoom_2x; engine must
      // still treat zoom/pan/outpaint-style actions as source-image workflows.
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "zoom_2x",
        sourceRun,
        0,
      );

      expect(workflow).toBeDefined();
      expect(slots.ksamplerId).toBeTruthy();
      expect((slots as { imageInputId?: string }).imageInputId).toBe("1");
    });

    it("pan actions use image-to-image slots instead of generic t2i slots", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { slots } = buildActionWorkflow(wf, "pan_left", sourceRun, 0);

      expect((slots as { imageInputId?: string }).imageInputId).toBe("1");
    });

    it("pan_up uses registry params with no client params and sets only top padding", () => {
      const wf = makeOutpaintWorkflow();
      const sourceRun = makeSourceRun({ width: 1024, height: 768 });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "pan_up",
        sourceRun,
        0,
      );
      const pad = workflow[(slots as { padNodeId?: string }).padNodeId ?? ""]
        .inputs as Record<string, number>;

      expect(pad.top).toBeGreaterThan(0);
      expect(pad.top % 16).toBe(0);
      expect(pad.left).toBe(0);
      expect(pad.right).toBe(0);
      expect(pad.bottom).toBe(0);
    });

    it("pan_left sets only left padding", () => {
      const wf = makeOutpaintWorkflow();
      const sourceRun = makeSourceRun({ width: 1024, height: 768 });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "pan_left",
        sourceRun,
        0,
      );
      const pad = workflow[(slots as { padNodeId?: string }).padNodeId ?? ""]
        .inputs as Record<string, number>;

      expect(pad.left).toBeGreaterThan(0);
      expect(pad.left % 16).toBe(0);
      expect(pad.top).toBe(0);
      expect(pad.right).toBe(0);
      expect(pad.bottom).toBe(0);
    });

    it("zoom_2x sets all padding sides from source dimensions", () => {
      const wf = makeOutpaintWorkflow();
      const sourceRun = makeSourceRun({ width: 1024, height: 1024 });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "zoom_2x",
        sourceRun,
        0,
      );
      const pad = workflow[(slots as { padNodeId?: string }).padNodeId ?? ""]
        .inputs as Record<string, number>;

      expect(pad.left).toBe(512);
      expect(pad.top).toBe(512);
      expect(pad.right).toBe(512);
      expect(pad.bottom).toBe(512);
      expect(pad.left % 16).toBe(0);
    });

    it("vary actions leave outpaint padding at zero", () => {
      const wf = makeOutpaintWorkflow();
      const sourceRun = makeSourceRun({ width: 1024, height: 768 });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
      );
      const pad = workflow[(slots as { padNodeId?: string }).padNodeId ?? ""]
        .inputs as Record<string, number>;

      expect(pad.left).toBe(0);
      expect(pad.top).toBe(0);
      expect(pad.right).toBe(0);
      expect(pad.bottom).toBe(0);
    });
  });

  describe("source image passthrough", () => {
    it("preserves source run prompt in the workflow", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun({ parsedPrompt: "a mountain lake" });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
      );

      expect(workflow[slots.posTextId].inputs.text).toBe("a mountain lake");
    });

    it("preserves source job seed for vary actions", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      // vary actions reuse seed from source job
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
        {},
      );

      expect(workflow[slots.ksamplerId].inputs.seed).toBe(42);
    });

    it("re-rolls a fresh seed for rerun actions", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "rerun",
        sourceRun,
        0,
        {},
      );

      const seed = workflow[slots.ksamplerId].inputs.seed as number;
      expect(typeof seed).toBe("number");
      expect(seed).not.toBe(42);
    });

    it("allows seed override via params", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
        { seed: 9999 },
      );

      expect(workflow[slots.ksamplerId].inputs.seed).toBe(9999);
    });
  });

  describe("inpaint action slot selection", () => {
    it("inpaint action uses inpaint slots", () => {
      const wf = makeInpaintWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "inpaint",
        sourceRun,
        0,
      );

      expect(workflow).toBeDefined();
      expect(slots.ksamplerId).toBeTruthy();
    });

    it("edit action uses inpaint slots", () => {
      const wf = makeInpaintWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(wf, "edit", sourceRun, 0);

      expect(workflow).toBeDefined();
      expect(slots.ksamplerId).toBeTruthy();
    });
  });

  describe("params merging", () => {
    it("newParams override sourceRun params", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun({ params: { steps: 10 } });
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
        { steps: 30 },
      );

      expect(workflow[slots.ksamplerId].inputs.steps).toBe(30);
    });

    it("does not mutate the original workflow", () => {
      const wf = makeI2IWorkflow();
      const originalSeed = wf["5"].inputs.seed;
      const sourceRun = makeSourceRun();

      buildActionWorkflow(wf, "vary_subtle", sourceRun, 0);

      // Original workflow node should be unchanged
      expect(wf["5"].inputs.seed).toBe(originalSeed);
    });
  });

  describe("registry-driven denoise values", () => {
    it("vary_subtle uses registry denoise (0.25)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_subtle",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.25);
    });

    it("vary_strong uses registry denoise (0.65)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "vary_strong",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.65);
    });

    it("remix_subtle uses registry denoise (0.35)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "remix_subtle",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.35);
    });

    it("remix_strong uses registry denoise (0.75)", () => {
      const wf = makeI2IWorkflow();
      const sourceRun = makeSourceRun();
      const { workflow, slots } = buildActionWorkflow(
        wf,
        "remix_strong",
        sourceRun,
        0,
      );

      expect(workflow[slots.ksamplerId].inputs.denoise).toBe(0.75);
    });

    it("getActionDenoise resolves via action -> template mapping", () => {
      // vary_subtle action maps to vary_subtle template with denoise 0.25
      expect(getActionDenoise("vary_subtle")).toBe(0.25);
      // remix_strong action maps to remix_strong template with denoise 0.75
      expect(getActionDenoise("remix_strong")).toBe(0.75);
    });

    it("getActionDenoise returns undefined for actions without registry denoise", () => {
      // t2i has no denoise in registry (it's the default 1.0 but only set if present)
      expect(getActionDenoise("t2i")).toBeUndefined();
      // unknown action returns undefined
      expect(getActionDenoise("nonexistent_action_xyz")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Action route tests (HTTP layer)
// ---------------------------------------------------------------------------

// Share one spy for default + named export so the route's `import fs from "fs/promises"`
// and any named imports both hit the same mock.
const fsAccessSpy = vi.fn();
vi.mock("fs/promises", () => ({
  default: { access: fsAccessSpy, readFile: vi.fn(), mkdir: vi.fn() },
  access: fsAccessSpy,
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ComfyAPIError";
    }
  },
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

import { queuePrompt, fetchHistory } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun, addActiveRun } from "@/lib/comfy/runs";
import { insertJob, insertPrompt, insertRun } from "@/lib/db";
import { NextRequest } from "next/server";

const mockQueuePrompt = vi.mocked(queuePrompt);
const mockLoadWorkflow = vi.mocked(loadWorkflowFromSelection);
const mockGetActiveRun = vi.mocked(getActiveRun);
const mockAddActiveRun = vi.mocked(addActiveRun);
const mockInsertPrompt = vi.mocked(insertPrompt);
const mockInsertRun = vi.mocked(insertRun);
const mockInsertJob = vi.mocked(insertJob);

const QUEUED_PROMPT_ID = "queued-prompt-xyz";

function makeActionRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/jobs/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_ACTION_BODY = {
  run_id: "run-001",
  job_index: 0,
  action: "vary_subtle",
  client_id: "client-abc",
};

describe("POST /api/jobs/action", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    fsAccessSpy.mockResolvedValue(undefined);
    mockLoadWorkflow.mockResolvedValue(makeI2IWorkflow() as never);
    mockQueuePrompt.mockResolvedValue({ prompt_id: QUEUED_PROMPT_ID } as never);
    mockGetActiveRun.mockReturnValue(makeSourceRun());
    mockAddActiveRun.mockImplementation(() => {});
  });

  it("queues action and returns run with prompt_id", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(makeActionRequest(VALID_ACTION_BODY));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.run.jobs[0].prompt_id).toBe(QUEUED_PROMPT_ID);
    expect(mockInsertPrompt).toHaveBeenCalledTimes(1);
    expect(mockInsertRun).toHaveBeenCalledTimes(1);
    expect(mockInsertJob).toHaveBeenCalledWith(
      `${data.run.run_id}:0`, data.run.run_id, data.run.jobs[0].seed,
      QUEUED_PROMPT_ID,
      undefined, // machine id: single host
    );
  });

  it("returns optional-node bypass warnings like imagine does", async () => {
    mockQueuePrompt.mockResolvedValueOnce({
      prompt_id: QUEUED_PROMPT_ID,
      warnings: ["NegPiP not installed — node bypassed"],
    } as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(makeActionRequest(VALID_ACTION_BODY));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.warnings).toEqual({
      nodes: ["NegPiP not installed — node bypassed"],
    });
  });

  it("omits warnings when nothing was bypassed", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(makeActionRequest(VALID_ACTION_BODY));
    const data = await res.json();
    expect(data.warnings).toBeUndefined();
  });

  it("returns 400 for missing run_id", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, run_id: undefined }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/run_id/i);
  });

  it("returns 400 for missing action", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, action: undefined }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/action/i);
  });

  it("returns 400 for missing client_id", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, client_id: undefined }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/client_id/i);
  });

  it("returns 400 for negative or non-integer job_index", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const negative = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, job_index: -1 }),
    );
    const fractional = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, job_index: 0.5 }),
    );

    expect(negative.status).toBe(400);
    await expect(negative.json()).resolves.toMatchObject({
      error: expect.stringMatching(/job_index/i),
    });
    expect(fractional.status).toBe(400);
  });

  it("returns 400 for non-object params and workflow overrides", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const badParams = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, params: [] }),
    );
    const badOverrides = await POST(
      makeActionRequest({
        ...VALID_ACTION_BODY,
        workflow_control_overrides: "bad",
      }),
    );

    expect(badParams.status).toBe(400);
    await expect(badParams.json()).resolves.toMatchObject({
      error: expect.stringMatching(/params/i),
    });
    expect(badOverrides.status).toBe(400);
    await expect(badOverrides.json()).resolves.toMatchObject({
      error: expect.stringMatching(/workflow_control_overrides/i),
    });
  });

  it("returns 400 for non-string workflow_path", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({ ...VALID_ACTION_BODY, workflow_path: { bad: true } }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/workflow_path/i);
  });

  it("trims action request string fields before queueing", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({
        ...VALID_ACTION_BODY,
        run_id: " run-001 ",
        action: " vary_subtle ",
        client_id: " client-trimmed ",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.run.action).toBe("vary_subtle");
    expect(mockQueuePrompt).toHaveBeenCalledWith(
      expect.anything(),
      "client-trimmed",
      undefined,
      expect.objectContaining({
        extraData: expect.objectContaining({
          extra_pnginfo: expect.objectContaining({ cj: expect.anything() }),
        }),
      }),
    );
    expect(mockAddActiveRun.mock.calls[0][0].params.action_source_run_id).toBe(
      "run-001",
    );
  });

  it("returns 400 for unknown action with no workflow template", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({
        ...VALID_ACTION_BODY,
        action: "do_something_unknown",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/workflow/i);
  });

  it("returns 404 when run not found", async () => {
    mockGetActiveRun.mockReturnValue(undefined);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(makeActionRequest(VALID_ACTION_BODY));
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toMatch(/run not found/i);
  });

  it("passes source image context via addActiveRun", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    await POST(makeActionRequest(VALID_ACTION_BODY));

    expect(mockAddActiveRun).toHaveBeenCalledOnce();
    const savedRun = mockAddActiveRun.mock.calls[0][0];
    expect(savedRun.action).toBe("vary_subtle");
    expect(savedRun.params.action_source_run_id).toBe("run-001");
  });

  it("expands wildcards in a remix prompt and records them (imagine parity)", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      makeActionRequest({
        ...VALID_ACTION_BODY,
        params: { prompt: "a __medium__ fox --seed 5" },
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.run.params.prompt).not.toContain("__medium__");
    expect(data.run.params.wildcards).toEqual({
      original: "a __medium__ fox --seed 5",
      seed: 5,
      used: ["medium"],
    });
    expect(data.wildcards).toMatchObject({ seed: 5, missing: [] });
    const opts = mockQueuePrompt.mock.calls[0][3] as {
      extraData: { extra_pnginfo: { cj: { params: Record<string, unknown> } } };
    };
    const cj = opts.extraData.extra_pnginfo.cj.params;
    expect(cj).toMatchObject({
      action: "vary_subtle",
      fullPrompt: data.run.params.prompt,
      seed: data.run.jobs[0].seed,
    });
  });

  it("strips secret-looking params from the embedded cj chunk", async () => {
    const { POST } = await import("@/app/api/jobs/action/route");
    await POST(
      makeActionRequest({
        ...VALID_ACTION_BODY,
        params: { civitai_api_key: "sk-123", stylize: 100 },
      }),
    );
    const opts = mockQueuePrompt.mock.calls[0][3] as {
      extraData: { extra_pnginfo: { cj: { params: Record<string, unknown> } } };
    };
    expect(opts.extraData.extra_pnginfo.cj.params).not.toHaveProperty(
      "civitai_api_key",
    );
    expect(opts.extraData.extra_pnginfo.cj.params.stylize).toBe(100);
  });

  it("hydrates source media from history via extractOutputs (gifs/videos kept)", async () => {
    const source = makeSourceRun({
      jobs: [
        {
          seed: 42,
          index: 0,
          status: "done",
          progress: 100,
          images: [],
          prompt_id: "p-001",
        },
      ],
    });
    mockGetActiveRun.mockReturnValue(source);
    vi.mocked(fetchHistory).mockResolvedValue({
      outputs: {
        "10": {
          gifs: [
            { filename: "loop.gif", subfolder: "", type: "output", format: "image/gif" },
            { filename: "clip.mp4", subfolder: "v", type: "output", format: "video/h264-mp4" },
          ],
        },
        "11": { text: ["caption"] },
      },
    } as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(makeActionRequest(VALID_ACTION_BODY));
    expect(res.status).toBe(200);
    const job = source.jobs[0];
    expect(job.images).toEqual([
      expect.stringMatching(/\/view\?filename=loop\.gif&subfolder=&type=output$/),
    ]);
    expect(job.videos).toEqual([
      expect.stringMatching(/\/view\?filename=clip\.mp4&subfolder=v&type=output$/),
    ]);
    expect(job.texts).toEqual(["caption"]);
  });
});
