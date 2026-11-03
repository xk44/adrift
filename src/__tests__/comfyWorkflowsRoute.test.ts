import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const comfyFetch = vi.fn();
const listSavedWorkflows = vi.fn();
const loadWorkflowFromSelection = vi.fn();
const readSavedWorkflowFile = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireAdmin: () => ({ ok: true }),
}));

vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

vi.mock("@/lib/comfy/comfyFetch", () => ({ comfyFetch }));

vi.mock("@/lib/comfy/workflows", () => ({
  getSavedWorkflowsDir: () => "/saved",
  listSavedWorkflows,
  loadWorkflowFromSelection,
  readSavedWorkflowFile,
}));

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function request(query = "?includeRuntime=1"): NextRequest {
  return new NextRequest(`http://localhost/api/comfy/workflows${query}`);
}

describe("GET /api/comfy/workflows?includeRuntime=1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/object_info")) return json({ KSampler: {} });
      if (url.includes("/customnode/getmappings"))
        return json({ "https://example.invalid/pack": [["FancyNode"], {}] });
      throw new Error(`unexpected ${url}`);
    });
  });

  it("checks every workflow with one /object_info and one getmappings call", async () => {
    listSavedWorkflows.mockResolvedValue([
      { name: "A", file: "a.json", kind: "t2i" },
      { name: "B", file: "b.json", kind: "i2v" },
      { name: "C", file: "c.json", kind: "upscale" },
    ]);
    loadWorkflowFromSelection.mockImplementation(async () => ({
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "FancyNode", inputs: {} },
    }));

    const { GET } = await import("@/app/api/comfy/workflows/route");
    const res = await GET(request());
    const body = await res.json();

    const urls = comfyFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/object_info"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/customnode/getmappings"))).toHaveLength(1);
    expect(body.workflows).toHaveLength(3);
    for (const wf of body.workflows) {
      expect(wf.runtime.checked).toBe(true);
      expect(wf.runtime.missingNodeTypes).toEqual(["FancyNode"]);
    }
    // The real kind survives enrichment.
    expect(body.workflows.map((w: { kind: string }) => w.kind)).toEqual([
      "t2i",
      "i2v",
      "upscale",
    ]);
  });

  it("keeps an unchecked runtime with the reason when a workflow can't be read", async () => {
    listSavedWorkflows.mockResolvedValue([
      { name: "Good", file: "good.json", kind: "t2i" },
      { name: "Broken", file: "broken.json", kind: "t2i" },
    ]);
    loadWorkflowFromSelection.mockImplementation(async (sel: string) => {
      if (sel === "saved:broken.json") throw new Error("bad JSON");
      return { "1": { class_type: "KSampler", inputs: {} } };
    });

    const { GET } = await import("@/app/api/comfy/workflows/route");
    const body = await (await GET(request())).json();
    const broken = body.workflows.find((w: { file: string }) => w.file === "broken.json");
    const good = body.workflows.find((w: { file: string }) => w.file === "good.json");

    expect(good.runtime.checked).toBe(true);
    expect(broken.runtime).toBeDefined();
    expect(broken.runtime.checked).toBe(false);
    expect(broken.runtime.error).toContain("bad JSON");
  });

  it("marks every row unchecked (not missing) when ComfyUI is unreachable", async () => {
    listSavedWorkflows.mockResolvedValue([
      { name: "A", file: "a.json", kind: "t2i" },
      { name: "B", file: "b.json", kind: "t2i" },
    ]);
    loadWorkflowFromSelection.mockResolvedValue({
      "1": { class_type: "KSampler", inputs: {} },
    });
    comfyFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const { GET } = await import("@/app/api/comfy/workflows/route");
    const body = await (await GET(request())).json();

    expect(comfyFetch).toHaveBeenCalledTimes(1);
    for (const wf of body.workflows) {
      expect(wf.runtime.checked).toBe(false);
      expect(wf.runtime.error).toBeTruthy();
    }
  });

  it("skips runtime checks entirely without includeRuntime", async () => {
    listSavedWorkflows.mockResolvedValue([{ name: "A", file: "a.json", kind: "t2i" }]);
    const { GET } = await import("@/app/api/comfy/workflows/route");
    const body = await (await GET(request(""))).json();
    expect(comfyFetch).not.toHaveBeenCalled();
    expect(body.workflows[0].runtime).toBeUndefined();
  });
});

describe("GET /api/comfy/workflows?path=…&format=ui", () => {
  it("returns the saved file as-is for ComfyUI's editor", async () => {
    vi.clearAllMocks();
    const ui = { nodes: [{ id: 1 }], links: [] };
    readSavedWorkflowFile.mockResolvedValue(ui);
    const { GET } = await import("@/app/api/comfy/workflows/route");
    const res = await GET(request("?path=saved%3Asub%2Fa.json&format=ui"));
    const body = await res.json();
    expect(readSavedWorkflowFile).toHaveBeenCalledWith("saved:sub/a.json");
    expect(loadWorkflowFromSelection).not.toHaveBeenCalled();
    expect(body.workflow).toEqual(ui);
  });
});
