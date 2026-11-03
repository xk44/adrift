import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { crc32 } from "zlib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { editGraph, objectInfo, t2iGraph } from "./fixtures/userToolsGraphs";
import { makeZip } from "./fixtures/userToolsZip";

const h = vi.hoisted(() => ({
  authed: true,
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

import { POST as CREATE } from "@/app/api/user-tools/route";
import { GET as GET_ONE, PATCH } from "@/app/api/user-tools/[id]/route";
import { GET as EXPORT } from "@/app/api/user-tools/[id]/export/route";
import { POST as IMPORT } from "@/app/api/user-tools/import/route";
import { listZipEntries, readZipEntry, writeZip } from "@/lib/userTools/zip";
import {
  buildToolPack,
  packCustomNodes,
  readToolPackManifest,
  TOOL_PACK_MANIFEST,
  TOOL_PACK_README,
  TOOL_PACK_WORKFLOW,
  toolPackFileName,
} from "@/lib/userTools/pack";
import { exportUserToolApi } from "@/lib/userTools/client";
import type { UserToolAnalysis, UserToolRecord } from "@/lib/userTools/types";

const dir = mkdtempSync(path.join(os.tmpdir(), "adrift-ut-pack-"));
let n = 0;

function req(url: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function filesOf(zip: Uint8Array): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const e of listZipEntries(zip)) out[e.name] = readZipEntry(zip, e);
  return out;
}

async function importBytes(
  bytes: Uint8Array,
  name: string,
): Promise<UserToolAnalysis> {
  const res = await IMPORT(
    req("/api/user-tools/import", "POST", {
      file: { name, data: Buffer.from(bytes).toString("base64") },
    }),
  );
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json.analysis as UserToolAnalysis;
}

/** What the review screen POSTs when the user keeps the defaults. */
async function saveAnalysis(a: UserToolAnalysis): Promise<UserToolRecord> {
  const res = await CREATE(
    req("/api/user-tools", "POST", {
      name: a.suggested.name,
      icon: a.suggested.icon,
      category: a.suggested.category,
      description: a.suggested.description,
      workflowType: a.workflowType,
      output: a.output,
      workflow: a.workflow,
      params: a.params,
      source: a.source,
    }),
  );
  expect(res.status).toBe(201);
  const { tool } = await res.json();
  return (
    await (
      await GET_ONE(req(`/api/user-tools/${tool.id}`), ctx(tool.id))
    ).json()
  ).tool as UserToolRecord;
}

function definition(t: UserToolRecord) {
  return {
    name: t.name,
    icon: t.icon,
    category: t.category,
    description: t.description,
    workflowType: t.workflowType,
    output: t.output,
    workflow: t.workflow,
    params: t.params,
  };
}

beforeEach(() => {
  h.authed = true;
  vi.stubEnv("ADRIFT_USER_TOOLS_FILE", path.join(dir, `t${n++}.json`));
  h.objectInfo.mockResolvedValue(objectInfo());
  h.mappings.mockResolvedValue({});
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("zip writer", () => {
  it("writes archives the reader round-trips, with real CRCs", () => {
    const big = "x".repeat(5000);
    const bin = Buffer.from([0, 1, 2, 3, 250, 251]);
    const zip = writeZip([
      { name: "a.json", data: big },
      { name: "dir/b.bin", data: bin, method: 0 },
      { name: "ü.txt", data: "unicode" },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "a.json",
      "dir/b.bin",
      "ü.txt",
    ]);
    expect(entries[0].method).toBe(8);
    expect(entries[1].method).toBe(0);
    expect(readZipEntry(zip, entries[0]).toString()).toBe(big);
    expect(readZipEntry(zip, entries[1])).toEqual(bin);
    // CRC-32 in the central directory (offset 16 of each record).
    const cd = zip.length - 22 - zip.readUInt32LE(zip.length - 22 + 12);
    expect(zip.readUInt32LE(cd + 16)).toBe(crc32(Buffer.from(big)) >>> 0);
  });

  it("refuses unsafe or duplicate member names", () => {
    expect(() => writeZip([{ name: "../x", data: "" }])).toThrow();
    expect(() => writeZip([{ name: "/abs", data: "" }])).toThrow();
    expect(() =>
      writeZip([
        { name: "a", data: "" },
        { name: "a", data: "" },
      ]),
    ).toThrow();
  });
});

describe("tool pack contents", () => {
  const tool = {
    name: "Ink wash",
    icon: "Brush",
    category: "Edit" as const,
    description: "Turns a photo into ink.",
    workflowType: "i2i",
    output: "image" as const,
    workflow: editGraph(),
    params: [],
  };

  it("lists models and custom node packs in the manifest and README", () => {
    const oi = {
      ...objectInfo(),
      FancyColorGrade: {
        input: { required: {} },
        python_module: "custom_nodes.comfyui-fancy",
      },
    };
    const files = filesOf(
      buildToolPack(tool, {
        objectInfo: oi,
        preview: { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ext: "png" },
      }),
    );
    expect(Object.keys(files).sort()).toEqual(
      [
        TOOL_PACK_MANIFEST,
        TOOL_PACK_README,
        TOOL_PACK_WORKFLOW,
        "preview.png",
      ].sort(),
    );
    const manifest = JSON.parse(files[TOOL_PACK_MANIFEST].toString());
    expect(manifest.preview).toBe("preview.png");
    expect(
      manifest.requires.models.map((m: { file: string }) => m.file),
    ).toEqual(["sdxl_base.safetensors", "styles/ink_wash.safetensors"]);
    expect(manifest.requires.customNodes.packs).toEqual([
      { module: "comfyui-fancy", classTypes: ["FancyColorGrade"] },
    ]);
    const readme = files[TOOL_PACK_README].toString();
    expect(readme).toContain("Ink wash");
    expect(readme).toContain("Turns a photo into ink.");
    expect(readme).toContain("styles/ink_wash.safetensors");
    expect(readme).toContain("comfyui-fancy: FancyColorGrade");
    expect(JSON.parse(files[TOOL_PACK_WORKFLOW].toString())).toEqual(
      editGraph(),
    );
  });

  it("says when custom nodes could not be checked", () => {
    expect(packCustomNodes(t2iGraph(), null).checked).toBe(false);
    const readme = filesOf(buildToolPack({ ...tool, workflow: t2iGraph() }))[
      TOOL_PACK_README
    ].toString();
    expect(readme).toContain("Not checked");
    expect(readme).toContain("KSampler");
    const core = packCustomNodes(t2iGraph(), {
      ...objectInfo(),
      EmptyLatentImage: { python_module: "nodes" },
      SaveImage: { python_module: "nodes" },
    });
    expect(core).toEqual({ checked: true, packs: [], unknown: [] });
  });

  it("makes safe download names", () => {
    expect(toolPackFileName("Ink wash / v2!")).toBe("ink-wash-v2.zip");
    expect(toolPackFileName("???")).toBe("adrift-tool.zip");
  });

  it("ignores zips without a valid manifest", () => {
    expect(readToolPackManifest(Buffer.from("{}"))).toBeNull();
    expect(
      readToolPackManifest(
        makeZip([{ name: TOOL_PACK_MANIFEST, data: Buffer.from("not json") }]),
      ),
    ).toBeNull();
    expect(
      readToolPackManifest(
        makeZip([
          {
            name: TOOL_PACK_MANIFEST,
            data: Buffer.from(JSON.stringify({ format: "other", tool: {} })),
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("export -> import round trip", () => {
  it("re-imports an exported tool with an equal definition", async () => {
    // Save a tool from a plain import, then customize it like a user would.
    const original = await saveAnalysis(
      await importBytes(Buffer.from(JSON.stringify(editGraph())), "ink.json"),
    );
    const params = original.params.map((p, i) =>
      i === 0 ? { ...p, exposed: !p.exposed, label: "Your photo here" } : p,
    );
    const patched = await PATCH(
      req(`/api/user-tools/${original.id}`, "PATCH", {
        name: "Ink wash deluxe",
        icon: "Palette",
        category: "Enhance",
        description: "Ink look for any photo.",
        params,
      }),
      ctx(original.id),
    );
    expect(patched.status).toBe(200);
    const before = (
      await (
        await GET_ONE(req(`/api/user-tools/${original.id}`), ctx(original.id))
      ).json()
    ).tool as UserToolRecord;
    expect(before.name).toBe("Ink wash deluxe");

    const res = await EXPORT(
      req(`/api/user-tools/${original.id}/export`),
      ctx(original.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(
      'filename="ink-wash-deluxe.zip"',
    );
    const zip = Buffer.from(await res.arrayBuffer());

    const analysis = await importBytes(zip, "ink-wash-deluxe.zip");
    expect(analysis.fromPack).toBe(true);
    expect(analysis.sourceFile).toBe(TOOL_PACK_WORKFLOW);
    // Missing nodes / models are still checked against this ComfyUI.
    expect(analysis.missingNodes.map((m) => m.classType)).toEqual([
      "FancyColorGrade",
    ]);
    const after = await saveAnalysis(analysis);
    expect(after.id).not.toBe(before.id);
    expect(definition(after)).toEqual(definition(before));
  });

  it("exports with ComfyUI offline and 404s unknown tools", async () => {
    const tool = await saveAnalysis(
      await importBytes(Buffer.from(JSON.stringify(t2iGraph())), "fox.json"),
    );
    h.objectInfo.mockRejectedValue(new Error("down"));
    const res = await EXPORT(
      req(`/api/user-tools/${tool.id}/export`),
      ctx(tool.id),
    );
    expect(res.status).toBe(200);
    expect(
      (await EXPORT(req("/api/user-tools/nope/export"), ctx("nope"))).status,
    ).toBe(404);
    h.authed = false;
    expect(
      (await EXPORT(req(`/api/user-tools/${tool.id}/export`), ctx(tool.id)))
        .status,
    ).toBe(401);
  });

  it("falls back to discovered params when the manifest's do not fit", async () => {
    const zip = writeZip([
      {
        name: TOOL_PACK_MANIFEST,
        data: JSON.stringify({
          format: "adrift-tool-pack",
          version: 1,
          tool: {
            name: "Fox",
            icon: "NotAnIcon",
            category: "Nope",
            params: [{ nodeId: "999", input: "x", kind: "seed", label: "x" }],
          },
          workflow: TOOL_PACK_WORKFLOW,
        }),
      },
      { name: TOOL_PACK_WORKFLOW, data: JSON.stringify(t2iGraph()) },
    ]);
    const plain = await importBytes(
      Buffer.from(JSON.stringify(t2iGraph())),
      "fox.json",
    );
    const a = await importBytes(zip, "fox.zip");
    expect(a.suggested.name).toBe("Fox");
    expect(a.suggested.icon).toBe(plain.suggested.icon);
    expect(a.suggested.category).toBe(plain.suggested.category);
    expect(a.params).toEqual(plain.params);
  });
});

describe("exportUserToolApi", () => {
  it("returns the zip and file name, and surfaces JSON errors", async () => {
    const ok = await exportUserToolApi(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="fox.zip"',
          },
        }),
      "abc",
    );
    expect(ok.filename).toBe("fox.zip");
    expect(ok.blob.size).toBe(2);
    await expect(
      exportUserToolApi(
        async () =>
          new Response(
            JSON.stringify({ ok: false, error: "That tool was not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          ),
        "abc",
      ),
    ).rejects.toThrow("That tool was not found");
  });
});
