/**
 * Missing-node gating: per pack/mode, which class_types the graph uses that
 * the connected ComfyUI lacks. Uses the recorded 0.42.0 object_info fixture,
 * whose meta lists the classes not installed on the recording machine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowPack } from "@/lib/oj/packs";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://comfy.test" },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));

import {
  analyzeWorkflowGraph,
  clearPackNodeAvailabilityCache,
  computePackNodeAvailability,
  detectGraphFormat,
  getPackNodeAvailability,
} from "@/lib/comfy/packNodeAvailability";
import { clearObjectInfoCache } from "@/lib/comfy/objectInfoCache";
import { describeMissingNodes } from "@/hooks/usePackNodeAvailability";

const FIXTURES = join(__dirname, "fixtures/comfy-contract");
const objectInfo = JSON.parse(
  readFileSync(join(FIXTURES, "object_info.json"), "utf8"),
) as Record<string, unknown>;
const meta = JSON.parse(readFileSync(join(FIXTURES, "meta.json"), "utf8")) as {
  node_classes_not_installed: string[];
};

const api = (...classTypes: string[]) => ({
  _meta: { title: "x" },
  _comment: "annotation, not a node",
  ...Object.fromEntries(
    classTypes.map((ct, i) => [String(i + 1), { class_type: ct, inputs: {} }]),
  ),
});

const GRAPHS: Record<string, unknown> = {
  "t2i.json": api("KSampler", "CLIPTextEncode", "EmptyLatentImage"),
  "video.json": api("KSampler", "VHS_VideoCombine"),
  "t23d.json": api("TripoSRModelLoader", "TripoSRSampler", "KSampler"),
  "t2a.json": api("StableAudioSampler"),
  "ui.json": { nodes: [{ id: 1, type: "VHS_VideoCombine" }], links: [] },
};

function pack(id: string, workflows: Record<string, string>): WorkflowPack {
  return { id, workflows } as unknown as WorkflowPack;
}

const readGraph = vi.fn(async (_packId: string, file: string) => GRAPHS[file]);

describe("fixture sanity", () => {
  it("records VHS/TripoSR/StableAudio as not installed", () => {
    for (const ct of ["VHS_VideoCombine", "TripoSRSampler", "StableAudioSampler"]) {
      expect(meta.node_classes_not_installed).toContain(ct);
      expect(objectInfo[ct]).toBeUndefined();
    }
    expect(objectInfo.KSampler).toBeDefined();
  });
});

describe("detectGraphFormat", () => {
  it("treats underscore keys as annotations of an API graph", () => {
    expect(detectGraphFormat(api("KSampler"))).toBe("api");
  });
  it("flags litegraph/UI graphs (nodes array, may hold subgraphs)", () => {
    expect(detectGraphFormat(GRAPHS["ui.json"])).toBe("ui");
  });
  it("is unknown for junk", () => {
    expect(detectGraphFormat(null)).toBe("unknown");
    expect(detectGraphFormat({ _meta: {} })).toBe("unknown");
    expect(detectGraphFormat({ "1": { inputs: {} } })).toBe("unknown");
  });
  it("does not judge UI graphs (no false positives from frontend-only nodes)", () => {
    expect(analyzeWorkflowGraph(GRAPHS["ui.json"], objectInfo)).toEqual({
      format: "ui",
      missing: [],
    });
  });
});

describe("computePackNodeAvailability", () => {
  beforeEach(() => {
    readGraph.mockClear();
  });

  it("reports missing class_types per pack/mode", async () => {
    const r = await computePackNodeAvailability(objectInfo, {
      readGraph,
      packs: [
        pack("img", { t2i: "t2i.json", i2i: "t2i.json" }),
        pack("media", {
          t2v: "video.json",
          t23d: "t23d.json",
          t2a: "t2a.json",
          legacy: "ui.json",
          gone: "nope.json",
        }),
      ],
    });
    expect(r.checked).toBe(true);
    expect(r.packs.img.t2i).toEqual({ file: "t2i.json", format: "api", missing: [] });
    expect(r.packs.media.t2v.missing).toEqual(["VHS_VideoCombine"]);
    expect(r.packs.media.t23d.missing).toEqual(["TripoSRModelLoader", "TripoSRSampler"]);
    expect(r.packs.media.t2a.missing).toEqual(["StableAudioSampler"]);
    expect(r.packs.media.legacy.format).toBe("ui");
    expect(r.packs.media.gone.format).toBe("missing_file");
    expect(r.missingClassTypes).toEqual([
      "StableAudioSampler",
      "TripoSRModelLoader",
      "TripoSRSampler",
      "VHS_VideoCombine",
    ]);
    // t2i.json shared by two kinds of one pack is read once
    expect(readGraph.mock.calls.filter(([, f]) => f === "t2i.json")).toHaveLength(1);
  });

  it("checks every registered pack file without crashing", async () => {
    const r = await computePackNodeAvailability(objectInfo);
    expect(Object.keys(r.packs).length).toBeGreaterThan(5);
    const statuses = Object.values(r.packs).flatMap((k) => Object.values(k));
    expect(statuses.some((s) => s.format === "api")).toBe(true);
  });
});

describe("getPackNodeAvailability (cached)", () => {
  beforeEach(() => {
    clearObjectInfoCache();
    clearPackNodeAvailabilityCache();
  });

  function stubComfy(info: Record<string, unknown>, mappings?: unknown) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/object_info")) return new Response(JSON.stringify(info));
      if (u.includes("/customnode/getmappings")) {
        return mappings
          ? new Response(JSON.stringify(mappings))
          : new Response("nope", { status: 404 });
      }
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("follows the object_info cache and rebuilds on a fresh fetch", async () => {
    const fetchMock = stubComfy(objectInfo, {
      "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite": [
        ["VHS_VideoCombine"],
        { title_aux: "VHS" },
      ],
    });
    const a = await getPackNodeAvailability();
    const b = await getPackNodeAvailability();
    expect(a.checked).toBe(true);
    expect(b).toBe(a); // same snapshot → memoised
    const objectInfoCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/object_info")).length;
    expect(objectInfoCalls()).toBe(1);
    const c = await getPackNodeAvailability({ fresh: true });
    expect(objectInfoCalls()).toBe(2);
    expect(c).not.toBe(a);
  });

  it("attaches Manager mapping candidates for missing classes", async () => {
    // Make sure at least one real pack class is missing: drop KSampler.
    const { KSampler: _drop, ...info } = objectInfo;
    stubComfy(info, {
      "comfy-core-fake": [["KSampler"], { title: "Core" }],
    });
    const r = await getPackNodeAvailability();
    expect(r.missingClassTypes).toContain("KSampler");
    expect(r.candidates.KSampler).toEqual([
      { id: "comfy-core-fake", label: "Core", source: "cnr" },
    ]);
  });

  it("degrades to unchecked when ComfyUI is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const r = await getPackNodeAvailability();
    expect(r).toEqual({ checked: false, packs: {}, candidates: {}, missingClassTypes: [] });
  });

  it("serves the report from GET /api/comfy/workflows/missing-nodes", async () => {
    const fetchMock = stubComfy(objectInfo);
    const { GET } = await import("@/app/api/comfy/workflows/missing-nodes/route");
    const res = await GET(
      new NextRequest("http://localhost/api/comfy/workflows/missing-nodes?fresh=1"),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.checked).toBe(true);
    expect(data.packs).toBeTypeOf("object");
    expect(fetchMock).toHaveBeenCalledWith("http://comfy.test/object_info", expect.anything());
  });
});

describe("describeMissingNodes", () => {
  it("lists classes with likely repos, null when runnable", () => {
    expect(describeMissingNodes({ file: "a", format: "api", missing: [] }, {})).toBeNull();
    expect(
      describeMissingNodes(
        { file: "a", format: "api", missing: ["TripoSRSampler", "X"] },
        { TripoSRSampler: [{ id: "u", label: "ComfyUI-Flowty-TripoSR", source: "git" }] },
      ),
    ).toBe("Missing ComfyUI nodes:\n• TripoSRSampler — ComfyUI-Flowty-TripoSR\n• X");
  });
});

describe("missing model assets (krea2-draft on a box without its files)", () => {
  // Shape of public/workflows/krea2_draft.json's loaders, against an
  // object_info whose loaders list other files only.
  const info = {
    UnetLoaderGGUF: { input: { required: { unet_name: [[]] } }, output: ["MODEL"] },
    LoraLoaderModelOnly: {
      input: {
        required: {
          model: ["MODEL"],
          lora_name: [["other.safetensors"]],
          strength_model: ["FLOAT", { min: -100, max: 100 }],
        },
      },
      output: ["MODEL"],
    },
    CLIPLoader: {
      input: {
        required: {
          clip_name: [["qwen3vl_4b_bf16.safetensors"]],
          type: [["krea2", "sd3"]],
        },
      },
      output: ["CLIP"],
    },
    KSampler: {
      input: { required: { sampler_name: [["euler"]] } },
      output: ["LATENT"],
    },
  };
  const graph = {
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "Krea-2-Turbo-Q4_K_M.gguf" } },
    "2": {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: "style_lora.safetensors", strength_model: 0 },
    },
    "4": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" },
    },
    // Non-file combo values are the engine's to rewrite: not judged.
    "5": { class_type: "KSampler", inputs: { sampler_name: "res_multistep" } },
  };

  it("lists model files the installed loaders don't offer", () => {
    expect(analyzeWorkflowGraph(graph, info)).toEqual({
      format: "api",
      missing: [],
      missingAssets: [
        "clip_name: qwen3vl_4b_fp8_scaled.safetensors",
        "lora_name: style_lora.safetensors",
        "unet_name: Krea-2-Turbo-Q4_K_M.gguf",
      ],
    });
  });

  it("is absent once the files are installed", () => {
    const installed = structuredClone(info);
    installed.UnetLoaderGGUF.input.required.unet_name = [["Krea-2-Turbo-Q4_K_M.gguf"]] as never;
    installed.LoraLoaderModelOnly.input.required.lora_name = [["style_lora.safetensors"]];
    installed.CLIPLoader.input.required.clip_name = [["qwen3vl_4b_fp8_scaled.safetensors"]];
    expect(analyzeWorkflowGraph(graph, installed).missingAssets).toBeUndefined();
  });

  it("blocks the mode in the picker tooltip", () => {
    const tip = describeMissingNodes(
      {
        file: "krea2_draft.json",
        format: "api",
        missing: [],
        missingAssets: ["unet_name: Krea-2-Turbo-Q4_K_M.gguf"],
      },
      {},
    );
    expect(tip).toBe("Missing model files:\n• unet_name: Krea-2-Turbo-Q4_K_M.gguf");
    expect(
      describeMissingNodes(
        { file: "a", format: "api", missing: ["X"], missingAssets: ["lora_name: y.safetensors"] },
        {},
      ),
    ).toBe("Missing ComfyUI nodes:\n• X\nMissing model files:\n• lora_name: y.safetensors");
  });
});
