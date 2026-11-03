/**
 * captureToolWorkflow / dryRunFetch: any tool's submit function, run against
 * a dry-run fetch, yields the API workflow its job POST would have queued —
 * and nothing is queued. Mock fetch only (no server, no ComfyUI).
 */
import { describe, expect, it, vi } from "vitest";
import {
  captureToolWorkflow,
  dryRunFetch,
  isApiWorkflowJson,
} from "@/lib/tools/exportWorkflow";
import {
  submitActionTool,
  submitEngineEdit,
  submitTextTool,
  ToolApiError,
  type FetchLike,
  type ToolImage,
} from "@/lib/tools/runTool";
import {
  defaultSettings,
  getActionTool,
  type ActionToolSpec,
} from "@/lib/tools/toolsPage";
import { EDIT_ENGINES } from "@/lib/tools/templates";

const WF = {
  "1": { class_type: "LoadImage", inputs: { image: "a.png [input]" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

type Call = { url: string; body: Record<string, unknown> };

function mockFetch(
  reply: (
    url: string,
    body: Record<string, unknown>,
  ) => {
    status?: number;
    data: Record<string, unknown>;
  },
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ url, body });
    const r = reply(url, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.data };
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

const dryRunServer = (url: string, body: Record<string, unknown>) => {
  if (url === "/api/jobs/seed-run")
    return {
      data: { ok: true, run: { run_id: "seed1", jobs: [{ index: 0 }] } },
    };
  if (url === "/api/comfy/upload")
    return { data: { ok: true, ref: "cj/up.png [input]" } };
  if (body.dry_run === true)
    return {
      data: {
        ok: true,
        workflow: WF,
        action: body.action,
        tool_id: body.toolId,
        seed: 42,
      },
    };
  return { data: { ok: true, run: { run_id: "QUEUED" } } };
};

const galleryImage: ToolImage = {
  id: "g",
  source: "gallery",
  previewUrl: "/x.png",
  label: "x",
  width: 1024,
  height: 1024,
  runId: "run-1",
  jobIndex: 0,
};

const spec = (id: string) => getActionTool(id) as ActionToolSpec;

describe("captureToolWorkflow", () => {
  it("action tool: sends dry_run, returns the workflow, never queues", async () => {
    const { fetchImpl, calls } = mockFetch(dryRunServer);
    const s = spec("edit_qwen21");
    const out = await captureToolWorkflow(fetchImpl, (f) =>
      submitActionTool({
        fetchImpl: f,
        spec: s,
        settings: { ...defaultSettings(s), text: "make it blue" },
        editLoras: null,
        image: galleryImage,
        secondImage: null,
        clientId: "cid",
      }),
    );
    expect(out.workflow).toEqual(WF);
    expect(out.endpoint).toBe("/api/jobs/action");
    expect(out.id).toBe("edit_qwen21");
    expect(out.seed).toBe(42);
    const job = calls.filter((c) => c.url === "/api/jobs/action");
    expect(job).toHaveLength(1);
    expect(job[0].body).toMatchObject({
      dry_run: true,
      run_id: "run-1",
      action: "edit_qwen21",
    });
    expect(out.body.dry_run).toBe(true);
  });

  it("text-only tool: seed run passes through, action is dry", async () => {
    const { fetchImpl, calls } = mockFetch(dryRunServer);
    const s = spec("music");
    const out = await captureToolWorkflow(fetchImpl, (f) =>
      submitTextTool({
        fetchImpl: f,
        spec: s,
        settings: { ...defaultSettings(s), text: "lofi piano" },
        clientId: "cid",
      }),
    );
    expect(out.id).toBe("music");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    expect(calls[0].body.dry_run).toBeUndefined();
    expect(calls[1].body).toMatchObject({ dry_run: true, run_id: "seed1" });
  });

  it("app engine edit: captured through the same action route", async () => {
    const { fetchImpl, calls } = mockFetch(dryRunServer);
    const out = await captureToolWorkflow(fetchImpl, (f) =>
      submitEngineEdit({
        fetchImpl: f,
        engine: EDIT_ENGINES.qwen2511,
        prompt: "turn it into a figurine",
        image: galleryImage,
        ctx: { catalog: null, packIds: null, editLoras: null },
        clientId: "cid",
        title: "Figurine",
      }),
    );
    expect(out.id).toBe("edit_qwen");
    const job = calls.find((c) => c.url === "/api/jobs/action");
    expect(job?.body).toMatchObject({
      dry_run: true,
      workflow_control_overrides: { "2.strength_model": 0 },
    });
  });

  it("server errors surface through the submit function unchanged", async () => {
    const { fetchImpl } = mockFetch((url) =>
      url === "/api/jobs/action"
        ? { status: 409, data: { ok: false, error: "Source missing" } }
        : dryRunServer(url, {}),
    );
    const s = spec("edit_qwen21");
    await expect(
      captureToolWorkflow(fetchImpl, (f) =>
        submitActionTool({
          fetchImpl: f,
          spec: s,
          settings: { ...defaultSettings(s), text: "x" },
          editLoras: null,
          image: galleryImage,
          secondImage: null,
          clientId: "cid",
        }),
      ),
    ).rejects.toThrow("Source missing");
  });

  it("a server without dry_run (queued a run) is reported, not returned", async () => {
    const { fetchImpl } = mockFetch(() => ({
      data: { ok: true, run: { run_id: "QUEUED" } },
    }));
    await expect(
      captureToolWorkflow(fetchImpl, (f) =>
        f("/api/jobs/action", {
          method: "POST",
          body: JSON.stringify({ action: "x" }),
        }),
      ),
    ).rejects.toThrow(/instead of a dry run/);
  });

  it("refuses job endpoints without a dry run before sending", async () => {
    const { fetchImpl, calls } = mockFetch(dryRunServer);
    await expect(
      captureToolWorkflow(fetchImpl, (f) =>
        f("http://localhost:3000/api/jobs/imagine", {
          method: "POST",
          body: "{}",
        }),
      ),
    ).rejects.toBeInstanceOf(ToolApiError);
    expect(calls).toHaveLength(0);
  });

  it("errors when the submit never reaches a job endpoint", async () => {
    const { fetchImpl } = mockFetch(dryRunServer);
    await expect(
      captureToolWorkflow(fetchImpl, async () => undefined),
    ).rejects.toThrow(/doesn't build/);
  });

  it("GETs and non-job POSTs pass straight through", async () => {
    const { fetchImpl, calls } = mockFetch(dryRunServer);
    const f = dryRunFetch(fetchImpl);
    await f("/api/jobs/recent");
    await f("/api/comfy/upload", { method: "POST", body: "{}" });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/jobs/recent",
      "/api/comfy/upload",
    ]);
  });
});

describe("isApiWorkflowJson", () => {
  it("accepts API graphs only", () => {
    expect(isApiWorkflowJson(WF)).toBe(true);
    expect(isApiWorkflowJson({})).toBe(false);
    expect(isApiWorkflowJson([])).toBe(false);
    expect(isApiWorkflowJson({ nodes: [], links: [] })).toBe(false);
  });
});
