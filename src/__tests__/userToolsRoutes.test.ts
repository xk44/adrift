import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { editGraph, objectInfo, t2iGraph } from "./fixtures/userToolsGraphs";

const h = vi.hoisted(() => ({
  authed: true,
  queuePrompt: vi.fn(),
  objectInfo: vi.fn(),
  mappings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: () =>
    h.authed
      ? { ok: true }
      : {
          ok: false,
          response: NextResponse.json({ ok: false }, { status: 401 }),
        },
}));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/db", () => ({
  insertJob: vi.fn(),
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
}));
vi.mock("@/lib/comfy/http", () => ({
  ComfyAPIError: class ComfyAPIError extends Error {},
  comfyErrorDetails: () => ({}),
  queuePrompt: (...a: unknown[]) => h.queuePrompt(...a),
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: () => h.objectInfo(),
}));
vi.mock("@/lib/comfy/manager", async (orig) => ({
  ...(await orig<typeof import("@/lib/comfy/manager")>()),
  fetchCustomNodeMappings: () => h.mappings(),
}));
vi.mock("@/lib/civitaiConfig", () => ({ getCivitaiApiKey: async () => "" }));
vi.mock("@/lib/models/backendProfileServer", () => ({
  fetchBackendProfileServer: async () => null,
}));

import { GET as LIST, POST as CREATE } from "@/app/api/user-tools/route";
import {
  DELETE,
  GET as GET_ONE,
  PATCH,
} from "@/app/api/user-tools/[id]/route";
import { POST as IMPORT } from "@/app/api/user-tools/import/route";
import { POST as RUN } from "@/app/api/user-tools/[id]/run/route";
import { addActiveRun } from "@/lib/comfy/runs";
import type { ImagineRun } from "@/types";

const dir = mkdtempSync(path.join(os.tmpdir(), "adrift-ut-routes-"));
let n = 0;

function req(url: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function importFile(graph: unknown, name = "ink_edit.json") {
  const res = await IMPORT(
    req("/api/user-tools/import", "POST", {
      file: {
        name,
        data: Buffer.from(JSON.stringify(graph)).toString("base64"),
      },
    }),
  );
  return { res, json: await res.json() };
}

beforeEach(() => {
  h.authed = true;
  vi.stubEnv("ADRIFT_USER_TOOLS_FILE", path.join(dir, `t${n++}.json`));
  h.objectInfo.mockResolvedValue(objectInfo());
  h.mappings.mockResolvedValue({
    "https://github.com/x/comfyui-fancy": [["FancyColorGrade"], { title_aux: "Fancy Nodes" }],
  });
  h.queuePrompt.mockReset();
  h.queuePrompt.mockResolvedValue({ prompt_id: "p1" });
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("/api/user-tools routes", () => {
  it("rejects callers without admin access", async () => {
    h.authed = false;
    expect((await LIST(req("/api/user-tools"))).status).toBe(401);
    expect(
      (await IMPORT(req("/api/user-tools/import", "POST", {}))).status,
    ).toBe(401);
    expect(
      (await RUN(req("/api/user-tools/x/run", "POST", {}), ctx("x"))).status,
    ).toBe(401);
    expect((await DELETE(req("/api/user-tools/x", "DELETE"), ctx("x"))).status).toBe(401);
  });

  it("analyzes an uploaded file without saving it", async () => {
    const { res, json } = await importFile(editGraph());
    expect(res.status).toBe(200);
    expect(json.analysis.workflowType).toBe("i2i");
    expect(json.analysis.missingNodes).toEqual([
      {
        classType: "FancyColorGrade",
        packs: [
          { id: "https://github.com/x/comfyui-fancy", label: "x/comfyui-fancy" },
        ],
      },
    ]);
    expect(json.analysis.missingModels[0].file).toBe(
      "styles/ink_wash.safetensors",
    );
    const list = await (await LIST(req("/api/user-tools"))).json();
    expect(list.tools).toEqual([]);
  });

  it("still analyzes when ComfyUI and the Manager are offline", async () => {
    h.objectInfo.mockResolvedValue(null);
    h.mappings.mockRejectedValue(new Error("down"));
    const { json } = await importFile(t2iGraph(), "fox.json");
    expect(json.analysis.checked).toBe(false);
  });

  it("gives plain errors for bad import bodies", async () => {
    const noInput = await IMPORT(req("/api/user-tools/import", "POST", {}));
    expect(noInput.status).toBe(400);
    const badUrl = await IMPORT(
      req("/api/user-tools/import", "POST", { url: "https://evil.io/models/1" }),
    );
    expect((await badUrl.json()).error).toMatch(/civitai.com model link/);
    const { res, json } = await importFile({ a: 1 });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/does not look like/);
  });

  it("saves, lists, gets, patches and deletes a tool", async () => {
    const { json: a } = await importFile(editGraph());
    const created = await CREATE(
      req("/api/user-tools", "POST", {
        name: "Ink wash",
        icon: "Brush",
        category: "Edit",
        workflowType: a.analysis.workflowType,
        output: a.analysis.output,
        workflow: a.analysis.workflow,
        params: a.analysis.params,
        source: a.analysis.source,
      }),
    );
    expect(created.status).toBe(201);
    const { tool } = await created.json();
    expect(tool.workflow).toBeUndefined();

    const list = await (await LIST(req("/api/user-tools"))).json();
    expect(list.tools.map((t: { id: string }) => t.id)).toEqual([tool.id]);

    const full = await (await GET_ONE(req("/x"), ctx(tool.id))).json();
    expect(full.tool.workflow["16"].class_type).toBe("KSampler");

    const patched = await PATCH(
      req("/x", "PATCH", { name: "Ink wash 2" }),
      ctx(tool.id),
    );
    expect((await patched.json()).tool.name).toBe("Ink wash 2");

    const badPatch = await PATCH(
      req("/x", "PATCH", { category: "Nope" }),
      ctx(tool.id),
    );
    expect(badPatch.status).toBe(400);

    expect((await DELETE(req("/x", "DELETE"), ctx(tool.id))).status).toBe(200);
    expect((await DELETE(req("/x", "DELETE"), ctx(tool.id))).status).toBe(404);
    expect((await GET_ONE(req("/x"), ctx("../etc"))).status).toBe(404);
  });

  it("rejects an invalid create body", async () => {
    const res = await CREATE(
      req("/api/user-tools", "POST", { name: "x", category: "Edit" }),
    );
    expect(res.status).toBe(400);
  });

  it("runs a saved tool with its exposed params and a run image", async () => {
    const { json: a } = await importFile(editGraph());
    const { tool } = await (
      await CREATE(
        req("/api/user-tools", "POST", {
          name: "Ink wash",
          icon: "Brush",
          category: "Edit",
          workflowType: "i2i",
          output: "image",
          workflow: a.analysis.workflow,
          params: a.analysis.params,
          source: { type: "file" },
        }),
      )
    ).json();

    // missing image -> plain 400, nothing queued
    const missing = await RUN(req("/x", "POST", {}), ctx(tool.id));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/Choose a file/);
    expect(h.queuePrompt).not.toHaveBeenCalled();

    addActiveRun({
      run_id: "src-run",
      prompt: "x",
      parsedPrompt: "x",
      params: {},
      width: 512,
      height: 512,
      createdAt: new Date().toISOString(),
      status: "done",
      jobs: [
        {
          seed: 1,
          index: 0,
          status: "done",
          progress: 1,
          images: ["/api/comfy/view?filename=a.png&type=output"],
        },
      ],
    } as unknown as ImagineRun);

    const res = await RUN(
      req("/x", "POST", {
        values: { "13.text": "sumi-e cat", "16.denoise": 0.4 },
        media: { "10.image": { run_id: "src-run", job_index: 0 } },
      }),
      ctx(tool.id),
    );
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.prompt).toBe("sumi-e cat");
    expect(run.params.action_provenance).toEqual({
      kind: "tool",
      id: `user:${tool.id}`,
      label: "Ink wash",
    });
    const wf = h.queuePrompt.mock.calls[0][0];
    expect(wf["10"].inputs.image).toBe("a.png [output]");
    expect(wf["13"].inputs.text).toBe("sumi-e cat");
    expect(wf["16"].inputs.denoise).toBe(0.4);

    const notReady = await RUN(
      req("/x", "POST", {
        media: { "10.image": { run_id: "nope", job_index: 0 } },
      }),
      ctx(tool.id),
    );
    expect(notReady.status).toBe(409);
    expect((await RUN(req("/x", "POST", {}), ctx("missing"))).status).toBe(404);
  });
});
