// Comfy Registry readiness for the Adrift packs: comfy_nodes/sref_system (the
// sref + LoRA shortcode nodes) and comfy_nodes/adrift_overlay (the overlay).
// Parses pyproject.toml with a tiny strict TOML-subset parser (no deps, no
// python) and checks the keys the Registry requires, plus that the pack's
// __init__.py / web dir / declared dependencies agree with the code.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const NODES_PACK = path.join(ROOT, "comfy_nodes/sref_system");
const OVERLAY_PACK = path.join(ROOT, "comfy_nodes/adrift_overlay");

type TomlValue =
  string | boolean | number | TomlValue[] | { [k: string]: TomlValue };
type TomlTable = { [k: string]: TomlValue };

// Subset: [table] / [a.b] headers, bare or "quoted" keys, values that are
// basic strings, booleans, integers, string arrays (may span lines) and
// one-line inline tables of strings. Anything else throws, which keeps the
// file in a shape every TOML reader agrees on.
function parseTomlSubset(src: string): TomlTable {
  const root: TomlTable = {};
  let cur = root;
  const lines = src.split("\n");
  const str = (s: string): string => {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
    if (!m) throw new Error(`not a basic string: ${s}`);
    return JSON.parse(`"${m[1]}"`);
  };
  const value = (raw: string): TomlValue => {
    const v = raw.trim();
    if (v.startsWith('"')) return str(v);
    if (v === "true" || v === "false") return v === "true";
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v.startsWith("[")) {
      const inner = v.slice(1, -1).trim();
      if (!v.endsWith("]")) throw new Error(`bad array: ${v}`);
      return inner
        ? inner
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map(str)
        : [];
    }
    if (v.startsWith("{")) {
      if (!v.endsWith("}")) throw new Error(`bad inline table: ${v}`);
      const t: TomlTable = {};
      for (const part of v
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        const eq = part.indexOf("=");
        t[part.slice(0, eq).trim()] = str(part.slice(eq + 1));
      }
      return t;
    }
    throw new Error(`unsupported value: ${v}`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const hdr = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (hdr) {
      cur = root;
      for (const k of hdr[1].split(".")) {
        if (!(k in cur)) cur[k] = {};
        cur = cur[k] as TomlTable;
      }
      continue;
    }
    const kv = /^("[^"]+"|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`line ${i + 1}: cannot parse: ${line}`);
    const key = kv[1].startsWith('"') ? str(kv[1]) : kv[1];
    let raw = kv[2];
    if (raw.startsWith("[") && !raw.includes("]")) {
      while (!raw.includes("]")) {
        i++;
        if (i >= lines.length) throw new Error(`unterminated array for ${key}`);
        const next = lines[i].trim();
        if (!next.startsWith("#")) raw += next;
      }
      raw = raw.replace(/,\s*]$/, "]");
    }
    if (key in cur) throw new Error(`duplicate key ${key}`);
    cur[key] = value(raw);
  }
  return root;
}

describe("parseTomlSubset", () => {
  it("parses headers, strings, arrays and inline tables; rejects the rest", () => {
    const t = parseTomlSubset(
      '[a.b]\nx = "1"\n"y z" = [\n  "p",\n  "q",\n]\nl = { text = "MIT" }\n',
    );
    expect(t).toEqual({
      a: { b: { x: "1", "y z": ["p", "q"], l: { text: "MIT" } } },
    });
    expect(() => parseTomlSubset("x = 1.5\n")).toThrow();
    expect(() => parseTomlSubset('x = "a"\nx = "b"\n')).toThrow(/duplicate/);
  });
});

function loadToml(pack: string) {
  const toml = parseTomlSubset(
    fs.readFileSync(path.join(pack, "pyproject.toml"), "utf8"),
  );
  return {
    project: toml.project as TomlTable,
    comfy: (toml.tool as TomlTable).comfy as TomlTable,
  };
}

describe.each([
  { pack: NODES_PACK, label: "sref_system", display: "Adrift Nodes" },
  { pack: OVERLAY_PACK, label: "adrift_overlay", display: "Adrift Overlay" },
])("$label pyproject.toml (Comfy Registry)", ({ pack, display }) => {
  const { project, comfy } = loadToml(pack);

  it("has the required [project] keys", () => {
    // Registry name: lowercase, starts with a letter, [a-z0-9._-], < 100 chars
    expect(project.name).toMatch(/^[a-z][a-z0-9._-]{0,98}$/);
    expect(String(project.description).length).toBeGreaterThan(20);
    expect(project.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(project.license).toEqual({ text: "MIT" });
    expect(project["requires-python"]).toMatch(/^>=3\.\d+$/);
    expect(Array.isArray(project.dependencies)).toBe(true);
  });

  it("points at the public repository", () => {
    const urls = project.urls as TomlTable;
    expect(urls.Repository).toBe("https://github.com/xk44/adrift");
    for (const u of Object.values(urls))
      expect(String(u)).toMatch(/^https:\/\/github\.com\/xk44\/adrift(\/|$)/);
  });

  it("has the [tool.comfy] publisher keys", () => {
    expect(comfy.PublisherId).toBe("xk44");
    expect(comfy.DisplayName).toBe(display);
    if (comfy.Icon !== undefined) {
      const m =
        /^https:\/\/raw\.githubusercontent\.com\/xk44\/adrift\/main\/(.+)$/.exec(
          String(comfy.Icon),
        );
      expect(m).not.toBeNull();
      // icon must be a file the public tree ships
      expect(fs.existsSync(path.join(ROOT, m![1]))).toBe(true);
    }
  });
});

describe("pack names", () => {
  it("the two packs register under different Registry names", () => {
    expect(loadToml(NODES_PACK).project.name).not.toBe(
      loadToml(OVERLAY_PACK).project.name,
    );
  });
});

describe("sref_system nodes pack", () => {
  const { project } = loadToml(NODES_PACK);
  const init = fs.readFileSync(path.join(NODES_PACK, "__init__.py"), "utf8");

  it("declares every third-party import the nodes make beyond ComfyUI", () => {
    // Shipped with ComfyUI itself (its requirements.txt / runtime modules).
    const comfyProvided = new Set([
      "torch",
      "safetensors",
      "numpy",
      "PIL",
      "folder_paths",
      "comfy",
      "nodes",
      "server",
    ]);
    const stdlib = new Set([
      "os",
      "json",
      "random",
      "typing",
      "pathlib",
      "logging",
      "sqlite3",
      "contextlib",
      "time",
      "hashlib",
      "re",
      "math",
      "functools",
      "itertools",
      "collections",
      "dataclasses",
    ]);
    const declared = new Set(
      (project.dependencies as string[]).map((d) =>
        d.split(/[<>=!~;\s[]/)[0].toLowerCase(),
      ),
    );
    const files = [
      "__init__.py",
      ...fs.readdirSync(path.join(NODES_PACK, "nodes")).map((f) => `nodes/${f}`),
    ].filter((f) => f.endsWith(".py"));
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(NODES_PACK, f), "utf8");
      for (const m of src.matchAll(
        /^\s*(?:from\s+([A-Za-z_][\w]*)[\w.]*\s+import|import\s+([A-Za-z_][\w]*))/gm,
      )) {
        const mod = m[1] ?? m[2];
        if (
          comfyProvided.has(mod) ||
          stdlib.has(mod) ||
          declared.has(mod.toLowerCase())
        )
          continue;
        missing.push(`${f}: ${mod}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("exports the node mappings and no web directory (the overlay is its own pack)", () => {
    expect(init).toMatch(/^NODE_CLASS_MAPPINGS = \{/m);
    expect(init).toMatch(/^NODE_DISPLAY_NAME_MAPPINGS = \{/m);
    expect(init).not.toMatch(/^WEB_DIRECTORY\s*=/m);
    expect(fs.existsSync(path.join(NODES_PACK, "web"))).toBe(false);
  });

  it("maps the classes docs/custom-nodes.json lists for the pack, each with a display name", () => {
    const block = (name: string) => {
      const m = new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, "m").exec(init);
      return [...(m?.[1] ?? "").matchAll(/^\s*"(\w+)":/gm)]
        .map((x) => x[1])
        .sort();
    };
    const meta = JSON.parse(
      fs.readFileSync(path.join(ROOT, "docs/custom-nodes.json"), "utf8"),
    );
    const entry = meta.inRepo.find(
      (r: { id: string }) => r.id === "sref_system",
    );
    expect(block("NODE_CLASS_MAPPINGS")).toEqual([...entry.classes].sort());
    expect(block("NODE_DISPLAY_NAME_MAPPINGS")).toEqual(
      [...entry.classes].sort(),
    );
  });
});

describe("adrift_overlay pack", () => {
  const { project } = loadToml(OVERLAY_PACK);
  const init = fs.readFileSync(path.join(OVERLAY_PACK, "__init__.py"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(OVERLAY_PACK, "web/manifest.json"), "utf8"),
  );

  it("exports empty node mappings and WEB_DIRECTORY", () => {
    expect(init).toMatch(/^NODE_CLASS_MAPPINGS = \{\}$/m);
    expect(init).toMatch(/^NODE_DISPLAY_NAME_MAPPINGS = \{\}$/m);
    const web = /^WEB_DIRECTORY = "([^"]+)"$/m.exec(init);
    expect(web).not.toBeNull();
    expect(fs.statSync(path.join(OVERLAY_PACK, web![1])).isDirectory()).toBe(true);
    for (const k of [
      "NODE_CLASS_MAPPINGS",
      "NODE_DISPLAY_NAME_MAPPINGS",
      "WEB_DIRECTORY",
    ]) {
      expect(init).toContain(`"${k}"`);
    }
    // Python imports: nothing at all (pure web extension).
    expect(init).not.toMatch(/^\s*(import|from)\s/m);
    expect(project.dependencies).toEqual([]);
  });

  it("matches the web manifest version and lists only the bridge", () => {
    expect(project.version).toBe(manifest.version);
    expect(manifest.files).toEqual(["adrift_overlay.js"]);
    for (const f of manifest.files)
      expect(fs.existsSync(path.join(OVERLAY_PACK, "web", f))).toBe(true);
  });

  it("ships exactly one extension script (no second registration)", () => {
    const js = fs
      .readdirSync(path.join(OVERLAY_PACK, "web"))
      .filter((f) => f.endsWith(".js"));
    expect(js).toEqual(["adrift_overlay.js"]);
  });
});

