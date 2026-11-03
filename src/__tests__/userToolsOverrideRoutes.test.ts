/**
 * Model overrides through the routes: the import analysis offers installed
 * stand-ins, and POST /api/user-tools validates picks against the live
 * object_info before writing them into the saved graph.
 */
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { editGraph, objectInfo } from "./fixtures/userToolsGraphs";
import { profileFromSystemStats } from "@/lib/models/compat";

const h = vi.hoisted(() => ({
  objectInfo: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: () => h.objectInfo(),
}));
vi.mock("@/lib/comfy/manager", async (orig) => ({
  ...(await orig<typeof import("@/lib/comfy/manager")>()),
  fetchCustomNodeMappings: async () => ({}),
}));
vi.mock("@/lib/civitaiConfig", () => ({ getCivitaiApiKey: async () => "" }));
vi.mock("@/lib/models/backendProfileServer", () => ({
  fetchBackendProfileServer: () => h.profile(),
}));

import { POST as CREATE } from "@/app/api/user-tools/route";
import { GET as GET_ONE } from "@/app/api/user-tools/[id]/route";
import { POST as IMPORT } from "@/app/api/user-tools/import/route";

const dir = mkdtempSync(path.join(os.tmpdir(), "adrift-ut-overrides-"));
let n = 0;

function req(url: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Fixture object_info with ink_wash installed under another folder. */
function liveInfo(): Record<string, unknown> {
  const oi = objectInfo();
  const lora = oi.LoraLoader as {
    input: { required: Record<string, unknown[]> };
  };
  lora.input.required.lora_name = [
    ["detail.safetensors", "loras/ink_wash.safetensors"],
  ];
  return oi;
}

async function analyze() {
  const res = await IMPORT(
    req("/api/user-tools/import", "POST", {
      file: {
        name: "ink.json",
        data: Buffer.from(JSON.stringify(editGraph())).toString("base64"),
      },
    }),
  );
  return (await res.json()).analysis;
}

function saveBody(a: Record<string, unknown>, modelOverrides?: unknown) {
  return {
    name: "Ink wash",
    icon: "Brush",
    category: "Edit",
    workflowType: a.workflowType,
    output: a.output,
    workflow: a.workflow,
    params: a.params,
    source: a.source,
    ...(modelOverrides === undefined ? {} : { modelOverrides }),
  };
}

beforeEach(() => {
  vi.stubEnv("ADRIFT_USER_TOOLS_FILE", path.join(dir, `t${n++}.json`));
  h.objectInfo.mockResolvedValue(liveInfo());
  h.profile.mockResolvedValue(
    profileFromSystemStats({
      system: { os: "darwin", ram_total: 32 * 1024 ** 3 },
      devices: [{ type: "mps", name: "mps", vram_total: 32 * 1024 ** 3 }],
    }),
  );
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("model overrides via the routes", () => {
  it("import offers ranked stand-ins with a confident suggestion", async () => {
    const a = await analyze();
    const m = a.missingModels[0];
    expect(m.file).toBe("styles/ink_wash.safetensors");
    expect(m.suggested).toBe("loras/ink_wash.safetensors");
    expect(m.candidates[0]).toMatchObject({
      value: "loras/ink_wash.safetensors",
      match: "same_file",
      verdict: "unknown",
    });
    expect(m.optionCount).toBe(2);
  });

  it("import still works when the GPU profile is unavailable", async () => {
    h.profile.mockRejectedValue(new Error("down"));
    const a = await analyze();
    expect(a.missingModels[0].candidates[0].verdict).toBeUndefined();
  });

  it("save writes a valid pick into the stored graph", async () => {
    const a = await analyze();
    const res = await CREATE(
      req(
        "/api/user-tools",
        "POST",
        saveBody(a, [
          { nodeId: "12", input: "lora_name", value: "loras/ink_wash.safetensors" },
        ]),
      ),
    );
    expect(res.status).toBe(201);
    const { tool } = await res.json();
    const full = await (
      await GET_ONE(req("/x"), { params: Promise.resolve({ id: tool.id }) })
    ).json();
    expect(full.tool.workflow["12"].inputs.lora_name).toBe(
      "loras/ink_wash.safetensors",
    );
  });

  it("save refreshes the auto LoRA label after a swap, keeps edited ones", async () => {
    const h2 = liveInfo();
    (h2.LoraLoader as { input: { required: Record<string, unknown[]> } }).input
      .required.lora_name = [["detail.safetensors", "loras/ink_wash_v2.safetensors"]];
    h.objectInfo.mockResolvedValue(h2);
    const a = await analyze();
    const lora = a.params.find(
      (p: { kind: string }) => p.kind === "lora_strength",
    );
    expect(lora.label).toBe("LoRA strength · ink_wash");
    const pick = [
      { nodeId: "12", input: "lora_name", value: "loras/ink_wash_v2.safetensors" },
    ];
    const save = async (params: unknown[]) => {
      const res = await CREATE(
        req("/api/user-tools", "POST", { ...saveBody(a, pick), params }),
      );
      expect(res.status).toBe(201);
      const { tool } = await res.json();
      const full = await (
        await GET_ONE(req("/x"), { params: Promise.resolve({ id: tool.id }) })
      ).json();
      return full.tool.params.find(
        (p: { key: string }) => p.key === lora.key,
      ).label;
    };
    expect(await save(a.params)).toBe("LoRA strength · ink_wash_v2");
    const edited = a.params.map((p: { key: string }) =>
      p.key === lora.key ? { ...p, label: "Ink amount" } : p,
    );
    expect(await save(edited)).toBe("Ink amount");
  });

  it("save rejects a pick that is not an installed option", async () => {
    const a = await analyze();
    for (const bad of [
      [{ nodeId: "12", input: "lora_name", value: "../../secret.safetensors" }],
      [{ nodeId: "16", input: "sampler_name", value: "dpmpp_2m" }],
      [{ nodeId: "12", input: "lora_name", value: 3 }],
      "loras/ink_wash.safetensors",
    ]) {
      const res = await CREATE(req("/api/user-tools", "POST", saveBody(a, bad)));
      expect(res.status).toBe(400);
    }
  });

  it("save refuses picks it cannot check while ComfyUI is offline", async () => {
    const a = await analyze();
    h.objectInfo.mockResolvedValue(null);
    const res = await CREATE(
      req(
        "/api/user-tools",
        "POST",
        saveBody(a, [
          { nodeId: "12", input: "lora_name", value: "loras/ink_wash.safetensors" },
        ]),
      ),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not reachable/);
  });

  it("an empty override list saves the graph as is", async () => {
    const a = await analyze();
    h.objectInfo.mockResolvedValue(null);
    const res = await CREATE(req("/api/user-tools", "POST", saveBody(a, [])));
    expect(res.status).toBe(201);
  });
});
