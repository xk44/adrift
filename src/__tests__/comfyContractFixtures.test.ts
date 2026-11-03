/**
 * ComfyUI HTTP API contract tests against fixtures recorded (GET-only) from a
 * real ComfyUI by scripts/record-comfy-fixtures.mjs. When ComfyUI changes a
 * response shape Adrift depends on, re-record and these fail loudly.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { extractOutputs, promptGraphOf } from "@/lib/comfy/outputs";
import { validatePrompt } from "@/lib/comfy/validatePrompt";

const FIXTURES = join(__dirname, "fixtures/comfy-contract");
const load = <T = any>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const meta = load<{
  comfyui_version: string;
  node_classes_kept: string[];
  node_classes_not_installed: string[];
}>("meta.json");
const objectInfo = load<Record<string, any>>("object_info.json");
const systemStats = load("system_stats.json");
const queue = load("queue.json");
const history = load<Record<string, any>>("history.json");
const features = load("features.json");
const embeddings = load("embeddings.json");

const fetchHistory = vi.fn();
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/http", () => ({ fetchHistory }));

describe("recorded ComfyUI fixtures", () => {
  it("were recorded from ComfyUI 0.42.x", () => {
    expect(meta.comfyui_version).toMatch(/^0\.42\./);
    expect(systemStats.system.comfyui_version).toBe(meta.comfyui_version);
  });

  it("contain no unredacted home paths", () => {
    for (const name of readdirSync(FIXTURES)) {
      const text = readFileSync(join(FIXTURES, name), "utf8");
      expect(text, name).not.toMatch(/\/Users\/[a-z]/i);
      expect(text, name).not.toMatch(/\/home\/[a-z]/i);
    }
  });
});

describe("/system_stats contract", () => {
  it("has the fields /api/health and the device panel read", () => {
    expect(systemStats.system).toMatchObject({
      os: expect.any(String),
      ram_total: expect.any(Number),
      ram_free: expect.any(Number),
      python_version: expect.any(String),
      pytorch_version: expect.any(String),
    });
    expect(Array.isArray(systemStats.devices)).toBe(true);
    for (const device of systemStats.devices) {
      expect(device).toMatchObject({
        name: expect.any(String),
        type: expect.any(String),
        vram_total: expect.any(Number),
        vram_free: expect.any(Number),
      });
    }
  });
});

describe("/queue, /api/features, /embeddings contract", () => {
  it("/queue returns running/pending arrays", () => {
    expect(Array.isArray(queue.queue_running)).toBe(true);
    expect(Array.isArray(queue.queue_pending)).toBe(true);
  });

  it("/api/features advertises preview metadata support", () => {
    expect(features).toMatchObject({
      supports_preview_metadata: expect.any(Boolean),
      max_upload_size: expect.any(Number),
    });
  });

  it("/embeddings is a string list", () => {
    expect(Array.isArray(embeddings)).toBe(true);
    for (const e of embeddings) expect(typeof e).toBe("string");
  });
});

describe("/object_info contract (trimmed to Adrift pack nodes)", () => {
  it("keeps every class listed in meta", () => {
    expect(Object.keys(objectInfo).sort()).toEqual(
      [...meta.node_classes_kept].sort(),
    );
    expect(meta.node_classes_kept.length).toBeGreaterThan(50);
  });

  it.each(Object.keys(objectInfo))("%s has the node-def shape", (cls) => {
    const def = objectInfo[cls];
    expect(def).toMatchObject({
      input: expect.any(Object),
      output: expect.any(Array),
      output_node: expect.any(Boolean),
      category: expect.any(String),
      name: cls,
    });
    expect(def.output_name ?? def.output).toHaveLength(def.output.length);
    for (const section of ["required", "optional"] as const) {
      for (const [name, spec] of Object.entries(def.input[section] ?? {})) {
        expect(Array.isArray(spec), `${cls}.${name}`).toBe(true);
        const type = (spec as unknown[])[0];
        // Legacy combo list or a type name ("INT", "COMBO", "MODEL", ...).
        expect(
          Array.isArray(type) || typeof type === "string",
          `${cls}.${name}`,
        ).toBe(true);
      }
    }
  });

  it("core samplers still expose the inputs Adrift's graph builder writes", () => {
    const ks = objectInfo.KSampler.input.required;
    for (const k of [
      "model",
      "seed",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "positive",
      "negative",
      "latent_image",
      "denoise",
    ]) {
      expect(ks, k).toHaveProperty(k);
    }
    expect(objectInfo.SaveImage.output_node).toBe(true);
    expect(objectInfo.SaveImage.input.required).toHaveProperty(
      "filename_prefix",
    );
    expect(objectInfo.CLIPTextEncode.input.required).toHaveProperty("text");
  });

  it("every input name in Adrift's API-format pack graphs exists on the node", () => {
    const root = join(__dirname, "../../public/workflows");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".json")) files.push(p);
      }
    };
    walk(root);

    const unknown: string[] = [];
    let checked = 0;
    for (const file of files) {
      let json: any;
      try {
        json = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const graph = json?.prompt ?? json;
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) continue;
      for (const node of Object.values<any>(graph)) {
        const def = objectInfo[node?.class_type];
        if (!def) continue;
        checked++;
        const names = new Set(
          ["required", "optional", "hidden"].flatMap((s) =>
            Object.keys(def.input[s] ?? {}),
          ),
        );
        for (const input of Object.keys(node.inputs ?? {})) {
          // "upload" is a UI-only widget LoadImage graphs carry along;
          // V3 dynamic inputs are addressed as "<root>.<child>".
          if (input === "upload") continue;
          if (names.has(input) || names.has(input.split(".")[0])) continue;
          unknown.push(
            `${file.slice(root.length + 1)} ${node.class_type}.${input}`,
          );
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(unknown).toEqual([]);
  });
});

describe("/history contract", () => {
  const entries = Object.entries(history);

  it("records at least one completed entry with the expected envelope", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, entry] of entries) {
      expect(Array.isArray(entry.prompt)).toBe(true);
      expect(entry.prompt[1]).toBe(id);
      expect(typeof entry.prompt[2]).toBe("object");
      expect(Array.isArray(entry.prompt[4])).toBe(true);
      expect(entry.status).toMatchObject({
        status_str: expect.any(String),
        completed: expect.any(Boolean),
        messages: expect.any(Array),
      });
      expect(typeof entry.outputs).toBe("object");
      // Every output node is one of the prompt's declared outputs.
      for (const nodeId of Object.keys(entry.outputs)) {
        expect(entry.prompt[4]).toContain(nodeId);
        expect(entry.meta?.[nodeId]).toMatchObject({ node_id: nodeId });
      }
    }
  });

  it.each(entries)("extractOutputs classifies %s", (_id, entry) => {
    const outputs = extractOutputs(entry);
    expect(outputs.length).toBeGreaterThan(0);
    const graph = promptGraphOf(entry);
    for (const o of outputs) {
      expect(Object.keys(entry.outputs)).toContain(o.nodeId);
      expect(o.classType).toBe(graph[o.nodeId]?.class_type);
      expect(o.nodeTitle).toBeTruthy();
      if (o.kind === "image") {
        expect(o.view).toMatchObject({
          filename: expect.stringMatching(/\.png$/),
          type: "output",
        });
        expect(o.metadata).toMatchObject({
          kind: "image",
          width: expect.any(Number),
        });
      }
    }
  });

  it.each(entries)("history route serves %s", async (id, entry) => {
    fetchHistory.mockResolvedValueOnce(entry);
    const { GET } = await import("@/app/api/comfy/history/[promptId]/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/comfy/history/${id}`),
      { params: Promise.resolve({ promptId: id }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.promptId).toBe(id);
    expect(data.status.status_str).toBe(entry.status.status_str);
    const files = Object.values<any>(entry.outputs).flatMap(
      (o) => o.images ?? [],
    );
    expect(data.images.map((i: any) => i.filename)).toEqual(
      files.map((f: any) => f.filename),
    );
    expect(data.images[0].url).toMatch(/^\/api\/comfy\/image\?filename=/);
    expect(data.outputs.length).toBe(files.length);
  });

  it.each(entries)(
    "validatePrompt accepts the recorded (executed) graph %s",
    (_id, entry) => {
      const graph = promptGraphOf(entry);
      // Classes outside Adrift's packs were trimmed from object_info.
      const problems = validatePrompt(graph, objectInfo).filter(
        (p) => p.kind !== "unknown_class_type",
      );
      expect(problems).toEqual([]);
    },
  );
});
