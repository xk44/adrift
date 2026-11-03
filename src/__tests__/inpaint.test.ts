/**
 * Inpaint Route Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mock fs/promises so workflow file loading doesn't hit disk.
// The route uses `import fs from "fs/promises"` (default import), so the
// default export's readFile is what gets called. Share one spy for both.
const readFileSpy = vi.fn();
vi.mock("fs/promises", () => ({
  default: {
    readFile: readFileSpy,
    access: vi.fn(),
    mkdir: vi.fn(),
  },
  readFile: readFileSpy,
  access: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock ComfyUI HTTP helpers
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  uploadImage: vi.fn(),
  ComfyAPIError: class ComfyAPIError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ComfyAPIError";
    }
  },
}));

// Mock workflow loading
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));

// Path containment is covered by inpaintWorkflowPath.test.ts; here fs is
// mocked, so resolve relative selections without touching disk.
vi.mock("@/lib/comfy/workflowPathGuard", () => ({
  resolveContainedWorkflowPath: vi.fn(async (sel: string) =>
    sel.startsWith("saved:")
      ? sel
      : sel.includes("..")
        ? null
        : join(process.cwd(), "public/workflows", sel),
  ),
}));

// Mock slot discovery
vi.mock("@/lib/oj/discovery", () => ({
  discoverInpaintSlots: vi.fn(),
}));

import { queuePrompt, uploadImage } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { discoverInpaintSlots } from "@/lib/oj/discovery";

const mockQueuePrompt = vi.mocked(queuePrompt);
const mockUploadImage = vi.mocked(uploadImage);
const mockLoadWorkflowFromSelection = vi.mocked(loadWorkflowFromSelection);
const mockDiscoverInpaintSlots = vi.mocked(discoverInpaintSlots);

// Minimal valid workflow with required node IDs
const MOCK_WORKFLOW = {
  "1": { class_type: "LoadImage", inputs: { image: "" } },
  "2": { class_type: "LoadImageMask", inputs: { image: "" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "" } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "" } },
  "5": {
    class_type: "KSampler",
    inputs: { seed: 0, denoise: 1.0, steps: 20, cfg: 7.0 },
  },
};

const MOCK_SLOTS = {
  imageInputId: "1",
  maskInputId: "2",
  posTextId: "3",
  negTextId: "4",
  ksamplerId: "5",
  latentDimsId: "6",
};

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/jobs/inpaint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  prompt: "a beautiful landscape",
  client_id: "test-client-123",
  source_image:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==",
  mask_data:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==",
};

describe("POST /api/jobs/inpaint", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path mocks
    readFileSpy.mockResolvedValue(JSON.stringify(MOCK_WORKFLOW));
    mockUploadImage.mockResolvedValue({
      name: "uploaded_file.png",
      subfolder: "",
      type: "input",
    });
    mockQueuePrompt.mockResolvedValue({ prompt_id: "prompt-abc-123" } as never);
    mockDiscoverInpaintSlots.mockReturnValue(MOCK_SLOTS as never);
    // loadWorkflowFromSelection not used on default path (uses loadWorkflow from fs)
    // but mock it anyway for safety
    mockLoadWorkflowFromSelection.mockResolvedValue(MOCK_WORKFLOW as never);
  });

  describe("valid requests", () => {
    it("returns promptId on valid prompt + sourceImage + mask", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const req = makeRequest(VALID_BODY);
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.prompt_id).toBe("prompt-abc-123");
      expect(typeof data.request_id).toBe("string");
    });

    it("returns the exact queued seed in the success body", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(makeRequest({ ...VALID_BODY, seed: 12345 }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.seed).toBe(12345);

      const queuedWorkflow = mockQueuePrompt.mock.calls[0][0] as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      expect(queuedWorkflow["5"].inputs.seed).toBe(12345);
    });

    it("uploads source image to ComfyUI", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      await POST(makeRequest(VALID_BODY));

      expect(mockUploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringContaining("inpaint_source_"),
        "",
        true,
      );
    });

    it("uploads mask image when provided", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      await POST(makeRequest(VALID_BODY));

      // Both source and mask uploaded
      expect(mockUploadImage).toHaveBeenCalledTimes(2);
      const calls = mockUploadImage.mock.calls;
      expect(calls[1][1]).toMatch(/inpaint_mask_/);
    });

    it("expands wildcards with the body seed and embeds the cj chunk", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(
        makeRequest({ ...VALID_BODY, prompt: "a __medium__ lake", seed: 77 }),
      );
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.seed).toBe(77);
      expect(data.wildcards).toMatchObject({
        original: "a __medium__ lake",
        seed: 77,
        used: ["medium"],
        missing: [],
      });
      expect(data.wildcards.expanded).not.toContain("__medium__");
      const wf = mockQueuePrompt.mock.calls[0][0] as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      const texts = Object.values(wf).map((n) => n.inputs.text);
      expect(texts).toContain(data.wildcards.expanded);
      const opts = mockQueuePrompt.mock.calls[0][3] as {
        extraData: { extra_pnginfo: { cj: { params: Record<string, unknown> } } };
      };
      expect(opts.extraData.extra_pnginfo.cj.params).toMatchObject({
        action: "inpaint",
        seed: 77,
        fullPrompt: data.wildcards.expanded,
        wildcards: { original: "a __medium__ lake", seed: 77, used: ["medium"] },
      });
    });

    it("queues prompt with clientId", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      await POST(makeRequest(VALID_BODY));

      expect(mockQueuePrompt).toHaveBeenCalledWith(
        expect.any(Object),
        "test-client-123",
        undefined,
        expect.objectContaining({
          extraData: expect.objectContaining({
            extra_pnginfo: expect.objectContaining({ cj: expect.anything() }),
          }),
        }),
      );
    });

    it("works without mask_data (optional)", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const body = { ...VALID_BODY, mask_data: undefined };
      const res = await POST(makeRequest(body));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      // Only one upload (source image, no mask)
      expect(mockUploadImage).toHaveBeenCalledTimes(1);
    });
  });

  describe("assigned workflows and scoped overrides", () => {
    beforeEach(async () => {
      // Each POST counts toward the route's per-minute limit.
      (await import("@/lib/rateLimit")).resetRateLimits();
    });

    it("loads a built-in pack graph from public/workflows", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(
        makeRequest({ ...VALID_BODY, workflow_path: "packs/x/inpaint.json" }),
      );
      expect(res.status).toBe(200);
      const arg = String(mockLoadWorkflowFromSelection.mock.calls[0][0]);
      expect(arg.replace(/\\/g, "/")).toMatch(
        /public\/workflows\/packs\/x\/inpaint\.json$/,
      );
    });

    it("passes saved: selections through unchanged", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      await POST(makeRequest({ ...VALID_BODY, workflow_path: "saved:mine.json" }));
      expect(mockLoadWorkflowFromSelection.mock.calls[0][0]).toBe(
        "saved:mine.json",
      );
    });

    it("applies only the overrides scoped to the graph it runs", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const scoped = {
        __byGraph: {
          "packs/x/inpaint.json": { "5.steps": 33 },
          "packs/x/t2i.json": { "5.cfg": 1.5 },
        },
      };
      await POST(
        makeRequest({
          ...VALID_BODY,
          workflow_path: "packs/x/inpaint.json",
          workflow_control_overrides: scoped,
        }),
      );
      const wf = mockQueuePrompt.mock.calls[0][0] as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      expect(wf["5"].inputs.steps).toBe(33);
      expect(wf["5"].inputs.cfg).toBe(7.0);
    });
  });

  describe("validation errors", () => {
    it("returns 400 when prompt is missing", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const body = { ...VALID_BODY, prompt: undefined };
      const res = await POST(makeRequest(body));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/prompt/i);
    });

    it("returns 400 when prompt is empty string", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const body = { ...VALID_BODY, prompt: "" };
      const res = await POST(makeRequest(body));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
    });

    it("returns 400 when source_image is missing", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const body = { ...VALID_BODY, source_image: undefined };
      const res = await POST(makeRequest(body));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/source_image/i);
    });

    it("returns 400 when client_id is missing", async () => {
      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const body = { ...VALID_BODY, client_id: undefined };
      const res = await POST(makeRequest(body));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/client_id/i);
    });
  });

  describe("ComfyUI errors", () => {
    it("returns 500 when uploadImage throws", async () => {
      mockUploadImage.mockRejectedValue(new Error("ComfyUI unreachable"));

      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(makeRequest(VALID_BODY));
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/upload/i);
    });

    it("returns 500 when queuePrompt throws", async () => {
      mockQueuePrompt.mockRejectedValue(new Error("Queue full"));

      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(makeRequest(VALID_BODY));
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.ok).toBe(false);
    });
  });

  describe("discovered slot injection (not hardcoded node IDs)", () => {
    it("uses discovered imageInputId instead of hardcoded node 1", async () => {
      // Simulate discoverInpaintSlots returning a non-default imageInputId
      const CUSTOM_SLOTS = {
        ...MOCK_SLOTS,
        imageInputId: "10",
        maskInputId: "20",
      };
      const CUSTOM_WORKFLOW = {
        ...MOCK_WORKFLOW,
        "10": { class_type: "LoadImage", inputs: { image: "" } },
        "20": { class_type: "LoadImageMask", inputs: { image: "" } },
      };
      readFileSpy.mockResolvedValue(JSON.stringify(CUSTOM_WORKFLOW));
      mockDiscoverInpaintSlots.mockReturnValue(CUSTOM_SLOTS as never);

      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(makeRequest(VALID_BODY));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify the queued workflow used the discovered slot IDs, not hardcoded "1"/"2"
      const queuedWorkflow = mockQueuePrompt.mock.calls[0][0] as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      expect(queuedWorkflow["10"].inputs.image).toBe("uploaded_file.png");
      expect(queuedWorkflow["20"].inputs.image).toBe("uploaded_file.png");
    });

    it("rejects discovered image/mask slots that are absent from the workflow", async () => {
      // discoverInpaintSlots returns an imageInputId that doesn't exist in the workflow
      const BAD_SLOTS = {
        ...MOCK_SLOTS,
        imageInputId: "99",
        maskInputId: "100",
      };
      // Workflow still has node "1" and "2" as the built-in template defaults
      mockDiscoverInpaintSlots.mockReturnValue(BAD_SLOTS as never);

      const { POST } = await import("@/app/api/jobs/inpaint/route");
      const res = await POST(makeRequest(VALID_BODY));
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/image input node "99"/i);
      expect(mockQueuePrompt).not.toHaveBeenCalled();
    });
  });
});

describe("useInpaint seed tracking contract", () => {
  const source = readFileSync(
    join(process.cwd(), "src/hooks/useInpaint.ts"),
    "utf8",
  );

  it("stores the server-returned final seed instead of a client-side guess", () => {
    expect(source).toContain("seed: data.seed");
    expect(source).not.toContain(
      "seed: seed ?? Math.floor(Math.random() * 2147483647)",
    );
  });
});

describe("default inpaint workflow mask polarity", () => {
  // The editor paints opaque red strokes on a transparent canvas. ComfyUI's
  // LoadImage/LoadImageMask "alpha" channel returns 1 - alpha, which would
  // keep the painted region and regenerate everything else. "red" reads the
  // strokes directly (transparent pixels export as rgb 0 → keep).
  it("reads the mask from the red channel, not inverted alpha", () => {
    const workflow = JSON.parse(
      readFileSync(join(process.cwd(), "public/workflows/inpaint.json"), "utf8"),
    ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const masks = Object.values(workflow).filter((n) => n.class_type === "LoadImageMask");
    expect(masks).toHaveLength(1);
    expect(masks[0].inputs.channel).toBe("red");
  });
});
