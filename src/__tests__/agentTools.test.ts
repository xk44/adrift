/**
 * Agent (MCP) tool catalog: schemas generated from the registries, the
 * compile step (agent inputs -> /api/jobs/action fields) and both routes.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Workflow } from "@/types";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-agent-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: () => Promise.reject(new Error("offline")),
}));
vi.mock("@/app/api/tools/model-status/route", () => ({
  GET: async () => Response.json({ tools: {}, packs: {}, options: {} }),
}));
vi.mock("@/app/api/krea2-edit-loras/route", () => ({
  GET: async () => Response.json({ families: [], loras: [], builtinCount: 0 }),
}));

import { ACTION_TOOLS, getActionTool } from "@/lib/tools/toolsPage";
import { getEditTools } from "@/lib/tools/editTools";
import { buildToolDocRows } from "@/lib/tools/toolsDoc";
import {
  AgentInputError,
  actionInputSchema,
  agentActionSpecs,
  buildAgentTools,
  compileAgentAction,
  resolveAgentToolId,
} from "@/lib/mcp/agentTools";
import { GET as agentGET } from "@/app/api/tools/agent/route";
import { POST as compilePOST } from "@/app/api/tools/agent/compile/route";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

const WF_DIR = path.resolve(__dirname, "../../public/workflows");
function loadWorkflow(rel: string): Workflow | null {
  const p = path.join(WF_DIR, rel);
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, "utf8")) as Workflow)
    : null;
}

const tools = buildAgentTools(buildToolDocRows(loadWorkflow).rows);
const byId = new Map(tools.map((t) => [t.id, t]));

describe("buildAgentTools", () => {
  it("covers every visible action card and every catalog tool once", () => {
    const want = [
      ...ACTION_TOOLS.filter((s) => !s.hidden && s.special !== "describe").map(
        (s) => `action:${s.id}`,
      ),
      ...getEditTools().map((t) => `catalog:${t.id}`),
    ];
    expect(tools.map((t) => t.id).sort()).toEqual([...want].sort());
    expect(byId.size).toBe(tools.length);
  });

  it("emits a well-formed object schema for every tool", () => {
    for (const t of tools) {
      const s = t.inputSchema as Schema;
      expect(s.type, t.id).toBe("object");
      for (const key of s.required ?? [])
        expect(s.properties, `${t.id} requires ${key}`).toHaveProperty(key);
      const opts = s.properties?.options?.properties ?? {};
      for (const [key, o] of Object.entries(opts)) {
        if (o.enum && o.default !== undefined)
          expect(o.enum, `${t.id} options.${key}`).toContain(o.default);
        if (typeof o.minimum === "number" && typeof o.maximum === "number")
          expect(o.minimum, `${t.id} options.${key}`).toBeLessThanOrEqual(
            o.maximum,
          );
      }
    }
  });

  it("derives action option keys from the spec's pickers and sliders", () => {
    for (const spec of agentActionSpecs()) {
      const s = byId.get(`action:${spec.id}`)!.inputSchema as Schema;
      const keys = Object.keys(s.properties?.options?.properties ?? {}).sort();
      const want = [
        ...(spec.pickers ?? [])
          .filter((p) => p.options.length)
          .map((p) => p.key),
        ...(spec.sliders ?? []).map((x) => x.key),
      ].sort();
      expect(keys, spec.id).toEqual(want);
      const source = spec.videoInput
        ? "video"
        : spec.noSourceInput
          ? null
          : "image";
      if (source) expect(s.required, spec.id).toContain(source);
      else {
        expect(s.properties).not.toHaveProperty("image");
        expect(s.properties).not.toHaveProperty("video");
      }
    }
  });

  it("sizes catalog image lists and prompts from the registry", () => {
    for (const tool of getEditTools()) {
      const s = byId.get(`catalog:${tool.id}`)!.inputSchema as Schema;
      expect(s.properties?.images?.minItems, tool.id).toBe(tool.refCount);
      expect(s.properties?.images?.maxItems, tool.id).toBe(tool.refCount);
      expect(!!s.required?.includes("prompt"), tool.id).toBe(
        tool.promptMode === "required",
      );
      expect(!!s.properties?.mask, tool.id).toBe(!!tool.needsMask);
      const opts = s.properties?.options?.properties ?? {};
      for (const o of tool.options)
        expect(opts[o.id]?.enum, tool.id).toEqual(o.values.map((v) => v.id));
      expect(!!opts.outpaint, tool.id).toBe(!!tool.outpaint);
    }
  });

  it("carries the docs badges", () => {
    const withVram = tools.filter((t) => t.vram);
    expect(withVram.length).toBeGreaterThan(tools.length / 2);
    for (const t of tools)
      if (t.commercial !== null)
        expect(["yes", "restricted", "no", "unverified"], t.id).toContain(
          t.commercial,
        );
    expect(tools.find((t) => t.kind === "catalog")?.license?.name).toBeTruthy();
  });
});

describe("resolveAgentToolId", () => {
  it("accepts prefixed and bare ids", () => {
    expect(resolveAgentToolId("action:upscale")).toMatchObject({
      kind: "action",
    });
    expect(resolveAgentToolId("upscale")).toMatchObject({ kind: "action" });
    const cat = getEditTools()[0];
    expect(resolveAgentToolId(`catalog:${cat.id}`)).toMatchObject({
      kind: "catalog",
    });
    expect(resolveAgentToolId(cat.id)).toMatchObject({ kind: "catalog" });
  });

  it("rejects unknown, hidden and Describe cards", () => {
    expect(resolveAgentToolId("action:nope")).toBeNull();
    expect(resolveAgentToolId(42)).toBeNull();
    const hidden = ACTION_TOOLS.find((s) => s.hidden);
    if (hidden) expect(resolveAgentToolId(`action:${hidden.id}`)).toBeNull();
    const describe = ACTION_TOOLS.find((s) => s.special === "describe");
    if (describe)
      expect(resolveAgentToolId(`action:${describe.id}`)).toBeNull();
  });
});

describe("compileAgentAction", () => {
  const upscale = getActionTool("upscale")!;

  it("maps picker options to the action the Tools page sends", () => {
    expect(compileAgentAction(upscale, {}, null)).toMatchObject({
      action: "upscale_subtle",
      tool_page_id: "upscale",
      source: "image",
    });
    expect(
      compileAgentAction(
        upscale,
        { options: { mode: "upscale_creative" } },
        null,
      ).action,
    ).toBe("upscale_creative");
  });

  it("rejects unknown options and out-of-range values", () => {
    expect(() =>
      compileAgentAction(upscale, { options: { mode: "x" } }, null),
    ).toThrow(AgentInputError);
    expect(() =>
      compileAgentAction(upscale, { options: { bogus: 1 } }, null),
    ).toThrow(/Unknown option/);
    expect(() =>
      compileAgentAction(upscale, { options: { creativity: 1000 } }, null),
    ).toThrow(/from 0 to 100/);
    expect(() =>
      compileAgentAction(upscale, { options: [] as unknown }, null),
    ).toThrow(/object/);
  });

  it("adds region masks only for tools that take them", () => {
    const edit = getActionTool("edit_qwen21")!;
    const out = compileAgentAction(
      edit,
      { text: "make the sky pink", mask_refs: ["m1.png [input]"] },
      null,
    );
    expect(out.params.pasteBack).toBe(true);
    expect(
      compileAgentAction(upscale, { mask_refs: ["m1.png [input]"] }, null)
        .params,
    ).not.toHaveProperty("pasteBack");
  });
});

describe("routes", () => {
  it("GET /api/tools/agent lists tools with availability", async () => {
    const res = await agentGET(
      new NextRequest("http://127.0.0.1:3000/api/tools/agent"),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tools.length).toBe(tools.length);
    const up = body.tools.find(
      (t: { id: string }) => t.id === "action:upscale",
    );
    expect(up.inputSchema.required).toEqual(["image"]);
    expect(typeof up.available).toBe("boolean");
    const cat = body.tools.find((t: { kind: string }) => t.kind === "catalog");
    expect(cat.available).toBe(false);
    expect(cat.unavailableReason).toBeTruthy();
  });

  const post = (body: unknown) =>
    compilePOST(
      new NextRequest("http://127.0.0.1:3000/api/tools/agent/compile", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("POST /api/tools/agent/compile builds the action request", async () => {
    const res = await post({
      toolId: "action:upscale",
      options: { mode: "upscale_creative" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      action: "upscale_creative",
    });
  });

  it("POST /api/tools/agent/compile error paths", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post({ toolId: "action:nope" })).status).toBe(404);
    const cat = await post({ toolId: `catalog:${getEditTools()[0].id}` });
    expect((await cat.json()).details.code).toBe("NOT_AN_ACTION_TOOL");
    const bad = await post({ toolId: "upscale", options: { mode: "x" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).details.code).toBe("BAD_INPUT");
  });
});

describe("agent focus points (refocus / rack_focus)", () => {
  const refocus = getActionTool("refocus")!;
  const rack = getActionTool("rack_focus")!;

  it("advertises focus inputs in the schema", () => {
    const rs = actionInputSchema(refocus) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(rs.properties.focus).toBeTruthy();
    expect(rs.required).not.toContain("focus");
    const ks = actionInputSchema(rack) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(ks.required).toEqual(expect.arrayContaining(["focus_a", "focus_b"]));
  });

  it("refocus defaults to centre and honours a given point", () => {
    expect(compileAgentAction(refocus, {}, null).params.focus).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(
      compileAgentAction(refocus, { focus: { x: 0.2, y: 1.4 } }, null).params
        .focus,
    ).toEqual({ x: 0.2, y: 1 });
    expect(() =>
      compileAgentAction(refocus, { focus: { x: "a" } }, null),
    ).toThrow(/focus must be/);
  });

  it("rack_focus maps A/B with times and rejects missing points", () => {
    const out = compileAgentAction(
      rack,
      { focus_a: { x: 0.3, y: 0.4, t: 0.5 }, focus_b: { x: 0.7, y: 0.6, t: 3 } },
      null,
    );
    expect(out.action).toBe("rack_focus");
    expect(out.params.focusA).toEqual({ x: 0.3, y: 0.4, t: 0.5 });
    expect(out.params.focusB).toEqual({ x: 0.7, y: 0.6, t: 3 });
    expect(() =>
      compileAgentAction(rack, { focus_a: { x: 0.3, y: 0.4 } }, null),
    ).toThrow(/focus_a and focus_b/);
  });
});
