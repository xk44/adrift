/**
 * scripts/check-packs.mjs pure logic: per-graph verdicts (runs-now /
 * missing-nodes / missing-models / bad-options), the static packs.ts parse
 * and the default-route mirror of resolveActionWorkflow.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cp from "../../scripts/check-packs.mjs";
import registry from "@/lib/oj/registry.json";

const ROOT = process.cwd();

const OI = {
  CheckpointLoaderSimple: {
    input: {
      required: { ckpt_name: [["a.safetensors", "sub/b.safetensors"], {}] },
    },
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        sampler_name: ["COMBO", { options: ["euler", "dpmpp_2m"] }],
        seed: ["INT", {}],
      },
    },
  },
  LoadImage: {
    input: { required: { image: [["x.png"], { image_upload: true }] } },
  },
  WeirdLoader: { input: { required: { path: ["STRING", {}] } } },
};

const graph = (nodes: Record<string, unknown>) => nodes;

describe("check-packs: helpers", () => {
  it("recognises model files and combo specs", () => {
    expect(cp.looksLikeModelFile("m.safetensors")).toBe(true);
    expect(cp.looksLikeModelFile("q.gguf")).toBe(true);
    expect(cp.looksLikeModelFile("photo.png")).toBe(false);
    expect(cp.comboOptions([["a", "b"], {}])).toEqual(["a", "b"]);
    expect(cp.comboOptions(["COMBO", { options: ["x"] }])).toEqual(["x"]);
    expect(cp.comboOptions(["INT", {}])).toBeNull();
    expect(cp.isUploadInput([["x.png"], { image_upload: true }])).toBe(true);
    expect(cp.isUploadInput(["COMBO", { video_upload: true }])).toBe(true);
    expect(cp.isUploadInput([["a"], {}])).toBe(false);
  });

  it("apiNodes skips annotations and rejects UI-format graphs", () => {
    expect(
      Object.keys(
        cp.apiNodes({ _meta: {}, "1": { class_type: "A", inputs: {} } }) ?? {},
      ),
    ).toEqual(["1"]);
    expect(cp.apiNodes({ nodes: [], links: [] })).toBeNull();
    expect(cp.apiNodes({ id: "sdxl", workflows: {} })).toBeNull();
  });

  it("modelIndex keys by lower-cased basename across folders", () => {
    const idx = cp.modelIndex({
      loras: ["Sub/My.safetensors"],
      vae: ["v.safetensors"],
    });
    expect(idx.has("my.safetensors")).toBe(true);
    expect(idx.has("v.safetensors")).toBe(true);
  });
});

describe("check-packs: checkGraph", () => {
  it("runs-now when every class, file and option is present", () => {
    const r = cp.checkGraph(
      graph({
        "1": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "sub/b.safetensors" },
        },
        "2": {
          class_type: "KSampler",
          inputs: { model: ["1", 0], sampler_name: "euler", seed: 1 },
        },
        // Upload placeholder never judged; empty strings are filled at run time.
        "3": { class_type: "LoadImage", inputs: { image: "input.png" } },
      }),
      OI,
    );
    expect(r.status).toBe(cp.STATUS.RUNS);
  });

  it("missing-nodes wins over everything else", () => {
    const r = cp.checkGraph(
      graph({
        "1": { class_type: "TripoSRSampler", inputs: {} },
        "2": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "gone.safetensors" },
        },
      }),
      OI,
    );
    expect(r.status).toBe(cp.STATUS.NODES);
    expect(r.missingNodes).toEqual(["TripoSRSampler"]);
    expect(r.missingModels).toHaveLength(1);
  });

  it("missing-models for a model combo value; bad-options for other combos", () => {
    const models = cp.checkGraph(
      graph({
        "1": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "gone.safetensors" },
        },
      }),
      OI,
    );
    expect(models.status).toBe(cp.STATUS.MODELS);
    expect(models.missingModels[0]).toMatchObject({
      node: "1",
      input: "ckpt_name",
      value: "gone.safetensors",
    });
    const opts = cp.checkGraph(
      graph({
        "1": {
          class_type: "KSampler",
          inputs: { sampler_name: "nope", seed: 1 },
        },
      }),
      OI,
    );
    expect(opts.status).toBe(cp.STATUS.OPTIONS);
  });

  it("checks a free-text file input against the model lists", () => {
    const g = graph({
      "1": { class_type: "WeirdLoader", inputs: { path: "dir/w.safetensors" } },
    });
    // No model lists: cannot judge, so not flagged.
    expect(cp.checkGraph(g, OI).status).toBe(cp.STATUS.RUNS);
    expect(
      cp.checkGraph(g, OI, cp.modelIndex({ x: ["other.safetensors"] })).status,
    ).toBe(cp.STATUS.MODELS);
    expect(
      cp.checkGraph(g, OI, cp.modelIndex({ x: ["W.safetensors"] })).status,
    ).toBe(cp.STATUS.RUNS);
  });

  it("describeVerdict reads as a needs-X line", () => {
    expect(cp.describeVerdict({ status: cp.STATUS.RUNS })).toBe("runs now");
    expect(
      cp.describeVerdict({
        status: cp.STATUS.NODES,
        missingNodes: ["A", "B"],
        missingModels: [{ value: "m.safetensors" }, { value: "m.safetensors" }],
        badOptions: [],
      }),
    ).toBe("needs nodes: A, B; needs models: m.safetensors");
  });
});

describe("check-packs: routes", () => {
  const src = `
const A_PACK: WorkflowPack = {
  id: "base",
  isDefault: true,
  workflows: {
    t2i: "t2i.json",
    vary_subtle: "vary_subtle.json",
  },
  defaultOverrides: {},
};
const B_PACK: WorkflowPack = {
  id: "ltx25",
  workflows: {
    i2v: "packs/ltx25/i2v.json",
    "t2v": "packs/ltx25/t2v.json",
  },
};
`;

  it("parsePacksSource reads id, default flag and workflows", () => {
    const packs = cp.parsePacksSource(src);
    expect(packs).toEqual([
      {
        id: "base",
        isDefault: true,
        workflows: { t2i: "t2i.json", vary_subtle: "vary_subtle.json" },
      },
      {
        id: "ltx25",
        isDefault: false,
        workflows: {
          i2v: "packs/ltx25/i2v.json",
          t2v: "packs/ltx25/t2v.json",
        },
      },
    ]);
  });

  it("defaultRoutes: pack by id, then video fallback, then registry file", () => {
    const reg = {
      templates: {
        i2v: { file: "i2v.json" },
        i23d: { file: "i23d.json" },
        solo: { file: "packs/x/solo.json" },
      },
      actions: {
        vary_subtle: { template: "i2i" },
        animate_low: { template: "i2v" },
        make_3d: { template: "i23d" },
        solo: {},
      },
    };
    const rows = cp.defaultRoutes(reg, cp.parsePacksSource(src), "base");
    const by = (id: string) => rows.find((r: { id: string }) => r.id === id);
    expect(by("vary_subtle")).toMatchObject({
      file: "vary_subtle.json",
      via: "pack:base",
    });
    expect(by("animate_low")).toMatchObject({
      file: "packs/ltx25/i2v.json",
      via: "pack:ltx25",
    });
    expect(by("make_3d")).toMatchObject({ file: "i23d.json", via: "registry" });
    expect(by("solo")).toMatchObject({
      file: "packs/x/solo.json",
      via: "registry",
    });
  });

  it("checkRoutes caches per file and marks absent graphs", () => {
    let loads = 0;
    const rows = cp.checkRoutes(
      [
        { id: "a", file: "g.json" },
        { id: "b", file: "g.json" },
        { id: "c", file: null },
        { id: "d", file: "missing.json" },
      ],
      (f: string) => {
        loads++;
        return f === "g.json"
          ? { "1": { class_type: "LoadImage", inputs: { image: "x.png" } } }
          : null;
      },
      OI,
      new Set(),
    );
    expect(loads).toBe(2);
    expect(rows.map((r: { status: string }) => r.status)).toEqual([
      "runs-now",
      "runs-now",
      "no-graph",
      "no-graph",
    ]);
  });

  it("on this repo the defaults route video to LTX-2.5 and 3D to TRELLIS.2", () => {
    const packs = cp.parsePacksSource(
      fs.readFileSync(path.join(ROOT, "src/lib/oj/packs.ts"), "utf8"),
    );
    const sdxl = packs.find((p: { id: string }) => p.id === "sdxl");
    expect(sdxl?.isDefault).toBe(false);
    expect(packs.find((p: { id: string }) => p.id === "krea2")?.isDefault).toBe(true);
    const rows = cp.defaultRoutes(registry, packs, "sdxl");
    const file = (kind: string, id: string) =>
      rows.find((r: { kind: string; id: string }) => r.kind === kind && r.id === id)
        ?.file;
    expect(file("action", "animate_low")).toBe("packs/ltx25/i2v.json");
    expect(file("action", "animate_high")).toBe("packs/ltx25/i2v.json");
    expect(file("action", "make_3d")).toBe(
      "packs/trellis2/make_3d_trellis.json",
    );
    expect(file("template", "t2v")).toBe("packs/ltx25/t2v.json");
    expect(file("template", "i2v")).toBe("packs/ltx25/i2v.json");
  });
});
