/**
 * Cross-file consistency of the tools system, no ComfyUI needed:
 * registry templates/actions, the action names tool modules send, edit-LoRA
 * family actions, and the node classes every bundled pack graph uses.
 */
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import registry from "@/lib/oj/registry.json";
import { getEditFamilies } from "@/lib/krea2/editLoras";
import { getEditTools } from "@/lib/tools/editTools";

const WORKFLOWS = path.join(process.cwd(), "public/workflows");
const TOOLS_DIR = path.join(process.cwd(), "src/lib/tools");
const NODES_DIR = path.join(process.cwd(), "comfy_nodes");
const FIXTURES = path.join(__dirname, "fixtures");

interface Template {
  file: string;
  kind: string;
  name: string;
  denoise?: number;
}
interface Action {
  id: string;
  name: string;
  template: string;
  group?: string;
}

const templates = registry.templates as unknown as Record<string, Template>;
const actions = registry.actions as unknown as Record<string, Action>;
const actionGroups = registry.actionGroups as Record<string, unknown>;

/**
 * Groups used by actions that are not shown in the gallery action bar
 * (tool-page-only actions); intentionally absent from `actionGroups`.
 */
const TOOL_ONLY_GROUPS = new Set(["refine", "audio"]);

function walk(dir: string, ext: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, ext);
    return e.name.endsWith(ext) ? [p] : [];
  });
}

const readJson = (file: string): unknown =>
  JSON.parse(fs.readFileSync(file, "utf-8"));

describe("registry.json templates and actions", () => {
  it("default template exists", () => {
    expect(templates[registry.defaults.template]).toBeDefined();
  });

  it.each(Object.entries(templates))(
    "template %s points at a parseable graph",
    (id, t) => {
      expect(typeof t.file, id).toBe("string");
      expect(t.kind, id).toBeTruthy();
      expect(t.name, id).toBeTruthy();
      const file = path.join(WORKFLOWS, t.file);
      expect(fs.existsSync(file), `${id} -> ${t.file}`).toBe(true);
      expect(() => readJson(file), t.file).not.toThrow();
      if (t.denoise !== undefined) {
        expect(t.denoise, id).toBeGreaterThan(0);
        expect(t.denoise, id).toBeLessThanOrEqual(1);
      }
    },
  );

  it("every action id matches its key and resolves to a known template", () => {
    for (const [key, a] of Object.entries(actions)) {
      expect(a.id, key).toBe(key);
      expect(a.name, key).toBeTruthy();
      expect(
        templates[a.template],
        `${key}.template = ${a.template}`,
      ).toBeDefined();
    }
  });

  it("every action group is declared or a documented tool-only group", () => {
    for (const [key, a] of Object.entries(actions)) {
      if (!a.group) continue;
      expect(
        a.group in actionGroups || TOOL_ONLY_GROUPS.has(a.group),
        `${key}.group = ${a.group}`,
      ).toBe(true);
    }
    // keep the documented list honest: each tool-only group is really used
    for (const g of TOOL_ONLY_GROUPS) {
      expect(g in actionGroups, g).toBe(false);
      expect(
        Object.values(actions).some((a) => a.group === g),
        g,
      ).toBe(true);
    }
  });
});

describe("action names sent by tool modules", () => {
  const sources = fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({
      f,
      src: fs.readFileSync(path.join(TOOLS_DIR, f), "utf-8"),
    }));

  const sent: { f: string; name: string }[] = [];
  for (const { f, src } of sources) {
    for (const m of src.matchAll(/\baction:\s*"([a-z0-9_]+)"/g))
      sent.push({ f, name: m[1] });
    for (const m of src.matchAll(/\baction\(\s*deps,\s*\w+,\s*"([a-z0-9_]+)"/g))
      sent.push({ f, name: m[1] });
  }

  it("finds the literal action names", () => {
    expect(sent.length).toBeGreaterThan(30);
    expect(sent.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "pipeline_assemble",
        "dub_mux",
        "edit_instruct_dual",
      ]),
    );
  });

  it("every literal action name is a registry action", () => {
    const unknown = sent.filter((s) => !actions[s.name]);
    expect(unknown.map((s) => `${s.f}: ${s.name}`)).toEqual([]);
  });

  it("every edit-LoRA family maps to registry actions", () => {
    for (const [fam, info] of Object.entries(getEditFamilies())) {
      expect(
        actions[info.action],
        `${fam}.action = ${info.action}`,
      ).toBeDefined();
      if (info.structuralAction)
        expect(
          actions[info.structuralAction],
          `${fam}.structuralAction = ${info.structuralAction}`,
        ).toBeDefined();
    }
  });
});

describe("pack workflow keys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("every pack workflow key is a registry template/kind/action, an edit-tool packAction, or a _fast variant", async () => {
    for (const k of ["CJ_MOSS_IMAGE", "CJ_QWEN_IMAGE_21", "CJ_FLUX3"])
      vi.stubEnv(k, "1");
    vi.resetModules();
    const { getAllPacks } = await import("@/lib/oj/packs");
    const kinds = new Set(Object.values(templates).map((t) => t.kind));
    const packActions = new Set(getEditTools().map((t) => t.packAction));
    const known = (k: string) =>
      k in templates || k in actions || kinds.has(k) || packActions.has(k);
    const bad: string[] = [];
    for (const p of getAllPacks())
      for (const key of Object.keys(p.workflows))
        if (!known(key) && !known(key.replace(/_fast$/, "")))
          bad.push(`${p.id}.${key}`);
    expect(bad).toEqual([]);
  });
});

describe("pack graphs use known node classes", () => {
  type Node = { class_type?: unknown };
  const objectInfo = readJson(
    path.join(FIXTURES, "comfy-contract/object_info.json"),
  ) as Record<string, unknown>;
  const meta = readJson(path.join(FIXTURES, "comfy-contract/meta.json")) as {
    node_classes_not_installed: string[];
  };
  const verified = readJson(path.join(FIXTURES, "packNodeClasses.json")) as {
    classes: string[];
  };

  /** Classes shipped by this repo's own custom nodes (comfy_nodes/*). */
  const repoNodes = new Set<string>();
  for (const f of walk(NODES_DIR, ".py")) {
    const src = fs.readFileSync(f, "utf-8");
    for (const m of src.matchAll(/NODE_CLASS_MAPPINGS\s*=\s*\{([^}]*)\}/g))
      for (const k of m[1].matchAll(/["']([^"']+)["']\s*:/g))
        repoNodes.add(k[1]);
  }

  const known = new Set([
    ...Object.keys(objectInfo),
    ...meta.node_classes_not_installed,
    ...repoNodes,
    ...verified.classes,
  ]);

  const graphs = walk(WORKFLOWS, ".json").flatMap((file) => {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch (e) {
      throw new Error(`${path.relative(WORKFLOWS, file)} does not parse: ${e}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    if ("nodes" in raw && "links" in raw) return [];
    const classes = Object.entries(raw as Record<string, Node>)
      .filter(([id, n]) => !id.startsWith("_") && n && typeof n === "object")
      .map(([, n]) => n.class_type)
      .filter((c): c is string => typeof c === "string");
    return classes.length
      ? [{ rel: path.relative(WORKFLOWS, file), classes }]
      : [];
  });

  it("discovers repo nodes and graphs", () => {
    expect(repoNodes.has("CJWhisperASR")).toBe(true);
    expect(repoNodes.has("CJVectorize")).toBe(true);
    expect(graphs.length).toBeGreaterThan(40);
  });

  it("every class_type is in object_info, a repo node, or the verified list", () => {
    const unknown = graphs.flatMap(({ rel, classes }) =>
      classes.filter((c) => !known.has(c)).map((c) => `${rel}: ${c}`),
    );
    expect(unknown).toEqual([]);
  });

  it("the verified list has no stale entries", () => {
    const used = new Set(graphs.flatMap((g) => g.classes));
    const stale = verified.classes.filter(
      (c) => !used.has(c) || c in objectInfo || repoNodes.has(c),
    );
    expect(stale).toEqual([]);
    expect([...verified.classes].sort()).toEqual(verified.classes);
  });
});
