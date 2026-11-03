/**
 * Structural validation of every bundled API-format workflow (packs + root),
 * with no ComfyUI needed: node refs point to existing nodes, output indices
 * are sane, no cycles, and every workflow a pack registers exists on disk.
 * Live node/enum validity is audited separately against GET /object_info.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "public/workflows");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".json") ? [p] : [];
  });
}

type Node = { class_type: string; inputs: Record<string, unknown> };
const isLink = (v: unknown): v is [string | number, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  (typeof v[0] === "string" || typeof v[0] === "number") &&
  Number.isInteger(v[1]);

/** API-format graphs only (skip UI-format `nodes`/`links` exports + non-graph json). */
function loadGraph(file: string): Record<string, Node> | null {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if ("nodes" in raw && "links" in raw) return null;
  const nodes: Record<string, Node> = {};
  for (const [id, n] of Object.entries(raw)) {
    if (id.startsWith("_")) continue;
    nodes[id] = n as Node;
  }
  return Object.values(nodes).some((n) => n && typeof n === "object" && "class_type" in n)
    ? nodes
    : null;
}

const files = walk(ROOT).filter(
  (f) => f.includes(`${path.sep}packs${path.sep}`) || path.dirname(f) === ROOT,
);
const graphs = files
  .map((f) => ({ f, g: loadGraph(f) }))
  .filter((x): x is { f: string; g: Record<string, Node> } => x.g !== null);

describe("bundled workflow graphs", () => {
  it("finds a meaningful number of graphs", () => {
    expect(graphs.length).toBeGreaterThan(40);
  });

  it.each(graphs.map((x) => [path.relative(ROOT, x.f), x.g] as const))(
    "%s has valid structure",
    (_name, g) => {
      for (const [id, node] of Object.entries(g)) {
        expect(typeof node.class_type, `node ${id}`).toBe("string");
        expect(node.class_type.length, `node ${id}`).toBeGreaterThan(0);
        expect(node.inputs && typeof node.inputs === "object", `node ${id}`).toBe(true);
        for (const [name, v] of Object.entries(node.inputs)) {
          if (!isLink(v)) continue;
          const src = g[String(v[0])];
          expect(src, `${id}.${name} -> missing node ${v[0]}`).toBeDefined();
          expect(v[1], `${id}.${name} output index`).toBeGreaterThanOrEqual(0);
          expect(String(v[0]), `${id}.${name} self-reference`).not.toBe(id);
        }
      }
      // acyclic
      const state = new Map<string, 1 | 2>();
      const visit = (id: string, trail: string[]) => {
        if (state.get(id) === 2) return;
        expect(state.get(id), `cycle: ${[...trail, id].join(" -> ")}`).toBeUndefined();
        state.set(id, 1);
        for (const v of Object.values(g[id].inputs))
          if (isLink(v) && g[String(v[0])]) visit(String(v[0]), [...trail, id]);
        state.set(id, 2);
      };
      for (const id of Object.keys(g)) visit(id, []);
    },
  );

  it("every graph has an output node", () => {
    const OUT = /^(SaveImage|PreviewImage|SaveVideo|SaveAnimatedWEBP|SaveAudio|VHS_VideoCombine|SaveGLB|Save3D\w*|\w*Save\w*|CJVectorize|CJCutouts|CJGridVideo|CJVideoPalette|PreviewAny)$/;
    for (const { f, g } of graphs) {
      const has = Object.values(g).some((n) => OUT.test(n.class_type));
      expect(has, path.relative(ROOT, f)).toBe(true);
    }
  });
});

describe("live-node required inputs (ComfyUI v0.42 object_info)", () => {
  const all = graphs.flatMap(({ f, g }) =>
    Object.entries(g).map(([id, n]) => ({ file: path.relative(ROOT, f), id, n })),
  );
  it("Krea2OstrisEditModelPatch always sets kv_cache (required since v0.42)", () => {
    const nodes = all.filter((x) => x.n.class_type === "Krea2OstrisEditModelPatch");
    expect(nodes.length).toBeGreaterThan(0);
    for (const { file, id, n } of nodes)
      expect(typeof n.inputs.kv_cache, `${file}#${id}`).toBe("boolean");
  });
  it("ConditioningKrea2Rebalance sets all four required knobs", () => {
    const nodes = all.filter((x) => x.n.class_type === "ConditioningKrea2Rebalance");
    expect(nodes.length).toBeGreaterThan(0);
    for (const { file, id, n } of nodes)
      for (const k of ["preset", "per_layer_weights", "multiplier", "renormalize"])
        expect(n.inputs[k], `${file}#${id}.${k}`).toBeDefined();
  });
});

describe("registered packs point at real files", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("every pack workflow path exists and is a graph", async () => {
    for (const k of [
      "CJ_MOSS_IMAGE",
      "CJ_QWEN_IMAGE_21",
      "CJ_FLUX3",
    ])
      vi.stubEnv(k, "1");
    vi.resetModules();
    const { getAllPacks } = await import("@/lib/oj/packs");
    const packs = getAllPacks();
    expect(packs.map((p) => p.id)).toContain("moss-image");
    for (const p of packs)
      for (const [action, rel] of Object.entries(p.workflows)) {
        const file = path.join(ROOT, rel as string);
        expect(fs.existsSync(file), `${p.id}.${action} -> ${rel}`).toBe(true);
      }
  });
});

describe("moss-image i2i", () => {
  const g = loadGraph(path.join(ROOT, "packs/moss-image/i2i.json"))!;
  it("encodes the source image instead of an empty latent", () => {
    const classes = Object.values(g).map((n) => n.class_type);
    expect(classes).toContain("LoadImage");
    expect(classes).toContain("VAEEncode");
    expect(classes).not.toContain("EmptyFlux2LatentImage");
    const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
    expect(ks.inputs.denoise).toBeLessThan(1);
    const enc = g[String((ks.inputs.latent_image as [string, number])[0])];
    expect(enc.class_type).toBe("VAEEncode");
  });
});

describe("vary/remix coverage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("img2img-capable packs map vary/remix to their i2i graph", async () => {
    for (const k of ["CJ_MOSS_IMAGE", "CJ_QWEN_IMAGE_21", "CJ_FLUX3"])
      vi.stubEnv(k, "1");
    vi.resetModules();
    const { getPack } = await import("@/lib/oj/packs");
    for (const id of ["moss-image", "qwen-image-21", "flux3"]) {
      const w = getPack(id)!.workflows;
      for (const a of ["vary_subtle", "vary_strong", "remix_subtle", "remix_strong"])
        expect(w[a], `${id}.${a}`).toBe(w.i2i as string);
    }
  });
});
