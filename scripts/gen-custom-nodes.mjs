#!/usr/bin/env node
// Render docs/custom-nodes.md from docs/custom-nodes.json and validate that
// every node class Adrift's shipped graphs/builders use is either a ComfyUI
// core node or mapped to a pack in the JSON.
//
// Usage:
//   node scripts/gen-custom-nodes.mjs --object-info <file|url> [--check]
//
//   --object-info  ComfyUI /object_info as a JSON file or an http(s) URL.
//                  Classes whose python_module is `nodes`, `comfy_extras.*`
//                  or `comfy_api_nodes.*` count as core.
//   --meta         pack metadata (default docs/custom-nodes.json)
//   --out          rendered doc (default docs/custom-nodes.md)
//   --check        do not write; exit 1 if the doc is out of date
//
// Exit codes: 0 ok, 1 unmapped classes or stale doc, 2 usage/input error.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {
    meta: "docs/custom-nodes.json",
    out: "docs/custom-nodes.md",
    objectInfo: null,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--object-info") opts.objectInfo = argv[++i];
    else if (a === "--meta") opts.meta = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: node scripts/gen-custom-nodes.mjs --object-info <file|url> [--meta f] [--out f] [--check]",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.objectInfo) {
    console.error("--object-info <file|url> is required");
    process.exit(2);
  }
  return opts;
}

async function loadObjectInfo(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(src, "utf8"));
}

const isCoreModule = (m) =>
  m === "nodes" ||
  m.startsWith("comfy_extras.") ||
  m.startsWith("comfy_api_nodes.");

// Frontend-only node types that never reach the server.
const FRONTEND_ONLY = new Set([
  "Reroute",
  "Note",
  "MarkdownNote",
  "PrimitiveNode",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gitFiles(...specs) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...specs], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

// usage scan

function collectGraphClasses(file, data, add) {
  const subgraphIds = new Set(
    (data?.definitions?.subgraphs ?? []).map((s) => s?.id).filter(Boolean),
  );
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.nodes)) {
      for (const n of node.nodes) {
        const t = n?.type;
        if (typeof t !== "string") continue;
        if (FRONTEND_ONLY.has(t) || UUID_RE.test(t) || subgraphIds.has(t))
          continue;
        add(t, file);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.class_type === "string"
      ) {
        add(v.class_type, file);
      }
      if (k !== "nodes" && v && typeof v === "object") visit(v);
    }
  };
  visit(data);
}

function scanUsage() {
  const used = new Map(); // class -> Set(source)
  const add = (cls, src) => {
    if (!used.has(cls)) used.set(cls, new Set());
    used.get(cls).add(src);
  };

  const graphs = gitFiles("public/workflows").filter((f) =>
    f.endsWith(".json"),
  );
  for (const f of graphs) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
    } catch (e) {
      console.error(`warning: skipping unparsable ${f}: ${e.message}`);
      continue;
    }
    collectGraphClasses(f, data, add);
  }

  const tsFiles = gitFiles("src").filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      !/\.test\.tsx?$/.test(f) &&
      !f.includes("__tests__/"),
  );
  const sources = tsFiles.map((f) => [
    f,
    fs.readFileSync(path.join(ROOT, f), "utf8"),
  ]);
  // string constants that are used as class_type values elsewhere
  const consts = new Map();
  for (const [, s] of sources)
    for (const m of s.matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([^"]+)"/g,
    ))
      consts.set(m[1], m[2]);
  for (const [f, s] of sources) {
    for (const m of s.matchAll(/class_type:\s*"([^"]+)"/g)) add(m[1], f);
    for (const m of s.matchAll(
      /\b(?:loaderClass|applyClass|preprocessorClass):\s*"([^"]+)"/g,
    ))
      add(m[1], f);
    for (const m of s.matchAll(/class_type:\s*([A-Z][A-Z0-9_]*)\b/g))
      if (consts.has(m[1])) add(consts.get(m[1]), f);
  }
  return { used, graphCount: graphs.length };
}

// tool mapping

// graph file (relative to public/workflows) -> Set(action name)
function graphActions() {
  const map = new Map();
  const put = (file, action) => {
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(action);
  };
  const read = (rel) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  for (const rel of ["src/lib/oj/packs.ts", "src/lib/tools/editTools.ts"]) {
    for (const m of read(rel).matchAll(
      /^\s+([a-z0-9_]+):\s*"(packs\/[^"]+\.json)"/gm,
    ))
      put(m[2], m[1]);
  }
  const regText = read("src/lib/oj/registry.json");
  if (regText) {
    const reg = JSON.parse(regText);
    const templateFile = {};
    for (const [name, t] of Object.entries(reg.templates ?? {})) {
      if (t?.file) {
        templateFile[name] = t.file;
        put(t.file, name);
      }
    }
    for (const [name, a] of Object.entries(reg.actions ?? {}))
      if (a?.template && templateFile[a.template])
        put(templateFile[a.template], name);
  }
  return map;
}

// tool id -> Set(action names it can run)
function toolActions() {
  const src = (() => {
    const p = path.join(ROOT, "src/lib/tools/toolsPage.ts");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  })();
  const tools = new Map();
  const start = src.indexOf("export const ACTION_TOOLS");
  if (start < 0) return tools;
  const rest = src.slice(start);
  const stop = rest.indexOf("\n];");
  const body = stop >= 0 ? rest.slice(0, stop) : rest;
  const blocks = body.split(/\n  \{\n/).slice(1);
  for (const b of blocks) {
    const end = b.search(/\n  \},?\n/);
    const block = end >= 0 ? b.slice(0, end) : b;
    const id = block.match(/^\s+id:\s*"([^"]+)"/)?.[1];
    if (!id) continue;
    const acts = new Set([id]);
    const mc = block.match(
      /modelCheck:\s*\{\s*pack:\s*"[^"]+",\s*action:\s*"([^"]+)"/,
    );
    if (mc) acts.add(mc[1]);
    for (const m of block.matchAll(/\{\s*id:\s*"([^"]+)",\s*label:/g))
      acts.add(m[1]);
    tools.set(id, acts);
  }
  // exported action-name constants (e.g. VIDEO_UPSCALE_ACTION = "video_upscale")
  const consts = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name))
        for (const m of fs
          .readFileSync(f, "utf8")
          .matchAll(/export const ([A-Z0-9_]+_ACTION)\s*=\s*"([a-z0-9_]+)"/g))
          consts.set(m[1], m[2]);
    }
  };
  const libDir = path.join(ROOT, "src/lib");
  if (fs.existsSync(libDir)) walk(libDir);
  // action literals inside the tool's `case` block of the request builder
  const caseRe =
    /((?:\n\s+case "[a-z0-9_]+":)+)([\s\S]*?)(?=\n\s+case "|\n\s+default:)/g;
  // a block ending in "// falls through" also runs the next case's code
  let carry = [];
  for (const m of src.matchAll(caseRe)) {
    const own = [...m[1].matchAll(/case "([a-z0-9_]+)"/g)].map((x) => x[1]);
    const ids = [...carry, ...own];
    carry = /\/\/ falls through\s*$/.test(m[2]) ? ids : [];
    const lits = [
      ...[...m[2].matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((x) => x[1]),
      ...[...m[2].matchAll(/action:\s*([A-Z0-9_]+_ACTION)\b/g)]
        .map((x) => consts.get(x[1]))
        .filter(Boolean),
    ];
    for (const id of ids)
      if (tools.has(id)) lits.forEach((a) => tools.get(id).add(a));
  }
  return tools;
}

function toolsForGraphs(graphs, actionsByGraph, actionsByTool) {
  const out = new Set();
  for (const g of graphs) {
    const rel = g.replace(/^public\/workflows\//, "");
    const acts = actionsByGraph.get(rel);
    if (!acts) continue;
    for (const [tool, tacts] of actionsByTool)
      for (const a of tacts) if (acts.has(a)) out.add(tool);
  }
  return [...out].sort();
}

// rendering

const short = (sha) => sha.slice(0, 7);
const code = (s) => "`" + s + "`";
const licenseCell = (l) =>
  l ? l : "none found (all rights reserved by default)";

function cloneCmd(p) {
  const rec = p.recursive ? " --recursive" : "";
  if (p.subdir) {
    const tmp = `${p.dir}-src`;
    return [
      `git clone${rec} ${p.repo} ${tmp}`,
      `git -C ${tmp} checkout ${p.commit}`,
      `cp -R ${tmp}/${p.subdir} ${p.dir}`,
    ];
  }
  const lines = [
    `git clone${rec} ${p.repo} ${p.dir}`,
    `git -C ${p.dir} checkout ${p.commit}`,
  ];
  if (p.recursive)
    lines.push(`git -C ${p.dir} submodule update --init --recursive`);
  return lines;
}

function patchCmds(p) {
  return (p.patches ?? []).map(
    (pt) =>
      `git -C ${p.dir} apply "$ADRIFT/${pt.file}"${pt.required ? "" : "   # optional"}`,
  );
}

function render(meta, usage, ctx) {
  const L = [];
  const { usedBy, toolsFor } = ctx;
  L.push("# ComfyUI custom nodes");
  L.push("");
  L.push(
    "<!-- Generated by scripts/gen-custom-nodes.mjs from docs/custom-nodes.json. Do not edit by hand. -->",
  );
  L.push("");
  L.push(
    "Adrift drives a stock ComfyUI server. Most graphs use core nodes only; the packs below are the third-party custom nodes the shipped graphs (`public/workflows/**`) and the graph builders (`src/lib/oj/*`) need, each pinned to a commit Adrift was tested with (see the per-pack notes for the one exception). Packs that no shipped graph uses are not listed.",
  );
  L.push("");
  L.push(
    `Coverage: ${ctx.graphCount} shipped graph files scanned, ${ctx.usedCount} distinct node classes, ${ctx.coreCount} of them core.`,
  );
  L.push("");

  L.push("## ComfyUI core");
  L.push("");
  L.push(
    `Tested with [${meta.comfyui.repo.replace("https://github.com/", "")}](${meta.comfyui.repo}) at ${code(meta.comfyui.commit)}. ${meta.comfyui.note}`,
  );
  L.push("");

  const required = meta.packs.filter((p) => !p.optional);
  const optional = meta.packs.filter((p) => p.optional);

  L.push("## Quick install");
  L.push("");
  L.push(
    "Run from your ComfyUI `custom_nodes/` directory with `ADRIFT` pointing at the Adrift app directory (the repository root, which contains `comfy_nodes/` and `docs/`). Directory names matter for a few packs (see notes), so keep them as given.",
  );
  L.push("");
  L.push("```bash");
  L.push("ADRIFT=/path/to/adrift   # Adrift app dir: contains comfy_nodes/ and docs/");
  L.push("cd /path/to/ComfyUI/custom_nodes");
  L.push("");
  for (const p of required) {
    L.push(`# ${p.id}`);
    for (const c of [...cloneCmd(p), ...patchCmds(p)]) L.push(c);
    L.push("");
  }
  L.push("# Adrift's own nodes (symlink so repo updates apply)");
  for (const r of meta.inRepo)
    L.push(`ln -s "$ADRIFT/${r.dir}" ${path.basename(r.dir)}`);
  L.push("");
  const reqDirs = [
    ...required.filter((p) => p.requirements).map((p) => p.dir),
    ...meta.inRepo
      .filter((r) => r.requirements)
      .map((r) => path.basename(r.dir)),
  ];
  L.push("# Python requirements, inside ComfyUI's own venv");
  for (const d of reqDirs) L.push(`pip install -r ${d}/requirements.txt`);
  L.push("```");
  L.push("");
  if (optional.length) {
    L.push(
      `Optional packs (${optional.map((p) => p.id).join(", ")}) only back specific flags or legacy paths; install them the same way if you need those features. Restart ComfyUI afterwards. \`GET /api/health?nodes=1\` and the Tools page report any node class that is still missing.`,
    );
    L.push("");
  }

  L.push("## Third-party packs");
  L.push("");
  L.push("| Pack | Commit | License | Needed for | Patch |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const p of meta.packs) {
    const name = `[${p.dir}](#${p.id})`;
    const need = p.optional ? "optional" : "required";
    const patch = (p.patches ?? []).length
      ? (p.patches ?? [])
          .map((pt) =>
            pt.required
              ? "required"
              : `optional (${pt.platform ?? "see notes"})`,
          )
          .join(", ")
      : "";
    L.push(
      `| ${name} | ${code(short(p.commit))} | ${p.license ?? "none found"} | ${need} | ${patch} |`,
    );
  }
  L.push("");

  for (const p of meta.packs) {
    L.push(`<a id="${p.id}"></a>`);
    L.push(`### ${p.dir}`);
    L.push("");
    L.push(
      `- Repository: ${p.repo}${p.subdir ? ` (subdirectory ${code(p.subdir)})` : ""}`,
    );
    L.push(`- Commit: ${code(short(p.commit))} (${code(p.commit)})`);
    L.push(`- License: ${licenseCell(p.license)}`);
    if (p.classes.length)
      L.push(`- Nodes used: ${p.classes.map(code).join(", ")}`);
    if (p.dependsOn?.length)
      L.push(
        `- Depends on: ${p.dependsOn.map((d) => `[${d}](#${d})`).join(", ")}`,
      );
    const graphs = usedBy(p.classes);
    if (graphs.length) L.push(`- Used by: ${graphs.map(code).join(", ")}`);
    const tools = toolsFor(graphs);
    if (tools.length) L.push(`- Tools: ${tools.map(code).join(", ")}`);
    if (p.requirements)
      L.push(
        `- Python requirements: ${code(`pip install -r ${p.dir}/requirements.txt`)}`,
      );
    for (const n of p.notes ?? []) L.push(`- ${n}`);
    for (const pt of p.patches ?? []) {
      L.push(
        `- Patch ${pt.required ? "(required)" : `(optional, ${pt.platform ?? ""})`}: [${path.basename(pt.file)}](${path.relative("docs", pt.file)}). ${pt.why}`,
      );
    }
    L.push("");
    L.push("```bash");
    for (const c of [...cloneCmd(p), ...patchCmds(p)]) L.push(c);
    L.push("```");
    L.push("");
  }

  L.push("## Adrift nodes in this repository");
  L.push("");
  L.push(
    "These ship in `comfy_nodes/` under the repository license. The Docker image (`docker/Dockerfile.comfyui`) copies them in; for a bare-metal ComfyUI, symlink each directory into `custom_nodes/` as in the quick install.",
  );
  L.push("");
  L.push("| Directory | Nodes | Used by | Notes |");
  L.push("| --- | --- | --- | --- |");
  for (const r of meta.inRepo) {
    const graphs = usedBy(r.classes);
    L.push(
      `| ${code(r.dir)} | ${r.classes.map(code).join(", ")} | ${graphs.length ? graphs.map(code).join(", ") : "not used by a shipped graph"} | ${r.note ?? ""} |`,
    );
  }
  L.push("");

  // Install the overlay pack on its own (Registry metadata: comfy_nodes/adrift_overlay/pyproject.toml).
  L.push("## Install as a ComfyUI custom node");
  L.push("");
  L.push("`comfy_nodes/adrift_overlay` is the Adrift overlay: a ComfyUI frontend extension (a corner button, or Ctrl+Shift+J, swaps the ComfyUI graph for the Adrift UI) with no nodes. The LoRA shortcode nodes are a separate pack, `comfy_nodes/sref_system`. Both carry Comfy Registry metadata in their `pyproject.toml` (ids `adrift-overlay` and `adrift-nodes`, publisher `xk44`) but are not listed in the Registry or ComfyUI-Manager yet, so install them from this repository. For a ComfyUI on the same machine as Adrift, Settings → ComfyUI → \"Add Adrift to ComfyUI\" links the overlay for you; or:");
  L.push("");
  L.push("```bash");
  L.push("# links custom_nodes/adrift_overlay into a dev ComfyUI checkout, the ComfyUI desktop app and any path you pass");
  L.push("scripts/install-overlay.sh /path/to/ComfyUI");
  L.push("```");
  L.push("");
  L.push("Or copy `comfy_nodes/adrift_overlay` (and `comfy_nodes/sref_system` for the nodes) into `ComfyUI/custom_nodes/` by hand. Neither needs Python packages beyond ComfyUI's own (torch and safetensors). Restart ComfyUI afterwards. The other directories above are tool backends with their own setup notes; install them as in the quick install.");
  L.push("");

  if (meta.unpublished?.length) {
    L.push("## Adrift nodes not yet published");
    L.push("");
    L.push("| Directory | Nodes | Used by | Notes |");
    L.push("| --- | --- | --- | --- |");
    for (const u of meta.unpublished) {
      const graphs = usedBy(u.classes);
      L.push(
        `| ${code(u.dir)} | ${u.classes.map(code).join(", ")} | ${graphs.map(code).join(", ")} | ${u.note} |`,
      );
    }
    L.push("");
  }

  if (meta.knownUnresolved?.length) {
    L.push("## Node classes without a pinned pack");
    L.push("");
    L.push("| Node | Used by | Why |");
    L.push("| --- | --- | --- |");
    for (const k of meta.knownUnresolved) {
      L.push(
        `| ${code(k.class)} | ${usedBy([k.class]).map(code).join(", ")} | ${k.reason} |`,
      );
    }
    L.push("");
  }

  if (meta.gotchas?.length) {
    L.push("## Environment notes");
    L.push("");
    for (const g of meta.gotchas) L.push(`- ${g}`);
    L.push("");
  }

  if (meta.licensing?.length) {
    L.push("## Licensing");
    L.push("");
    for (const g of meta.licensing) L.push(`- ${g}`);
    L.push("");
  }

  L.push("## Regenerating this file");
  L.push("");
  L.push("```bash");
  L.push("curl -s http://127.0.0.1:8188/object_info > /tmp/object_info.json");
  L.push(
    "node scripts/gen-custom-nodes.mjs --object-info /tmp/object_info.json          # write",
  );
  L.push(
    "node scripts/gen-custom-nodes.mjs --object-info /tmp/object_info.json --check  # CI: fail if stale or unmapped",
  );
  L.push("```");
  L.push("");
  L.push(
    "The script exits non-zero and lists every node class that a shipped graph or builder uses but that is neither core (per `object_info`) nor mapped in `docs/custom-nodes.json`.",
  );
  L.push("");
  return L.join("\n");
}

// main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const meta = JSON.parse(
    fs.readFileSync(path.resolve(ROOT, opts.meta), "utf8"),
  );
  const objectInfo = await loadObjectInfo(opts.objectInfo);

  const { used, graphCount } = scanUsage();

  const owner = new Map(); // class -> owner id
  const errors = [];
  const own = (cls, id) => {
    if (owner.has(cls) && owner.get(cls) !== id)
      errors.push(`class ${cls} mapped twice (${owner.get(cls)}, ${id})`);
    owner.set(cls, id);
  };
  for (const p of meta.packs) {
    for (const k of ["id", "dir", "repo", "commit", "classes"])
      if (p[k] === undefined) errors.push(`pack ${p.id ?? "?"}: missing ${k}`);
    if (p.commit && !/^[0-9a-f]{40}$/.test(p.commit))
      errors.push(`pack ${p.id}: commit must be a full 40-char SHA`);
    for (const pt of p.patches ?? [])
      if (!fs.existsSync(path.join(ROOT, pt.file)))
        errors.push(`pack ${p.id}: missing ${pt.file}`);
    for (const c of p.classes ?? []) own(c, p.id);
  }
  for (const r of meta.inRepo ?? []) {
    if (!fs.existsSync(path.join(ROOT, r.dir)))
      errors.push(`inRepo ${r.id}: ${r.dir} not found`);
    for (const c of r.classes) own(c, `repo:${r.id}`);
  }
  for (const u of meta.unpublished ?? [])
    for (const c of u.classes) own(c, `unpublished:${u.id}`);
  for (const k of meta.knownUnresolved ?? []) own(k.class, "unresolved");

  let coreCount = 0;
  const unmapped = [];
  for (const [cls, srcs] of [...used].sort()) {
    const mod = objectInfo[cls]?.python_module;
    const core = typeof mod === "string" && isCoreModule(mod);
    if (core) {
      coreCount++;
      if (owner.has(cls))
        errors.push(
          `class ${cls} is core (${mod}) but mapped to ${owner.get(cls)}`,
        );
      continue;
    }
    if (!owner.has(cls))
      unmapped.push(
        `${cls} (${mod ?? "not in object_info"}) <- ${[...srcs].sort().join(", ")}`,
      );
  }
  const stale = [...owner.keys()].filter((c) => !used.has(c));
  for (const c of stale)
    console.error(
      `warning: ${c} (${owner.get(c)}) is mapped but not used by any shipped graph/builder`,
    );

  if (unmapped.length) {
    errors.push(
      `unmapped non-core classes (add them to ${opts.meta}):\n  ${unmapped.join("\n  ")}`,
    );
  }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }

  const actionsByGraph = graphActions();
  const actionsByTool = toolActions();
  const usedBy = (classes) =>
    [...new Set(classes.flatMap((c) => [...(used.get(c) ?? [])]))]
      .map((f) => f.replace(/^public\/workflows\//, ""))
      .sort();
  const toolsFor = (graphs) =>
    toolsForGraphs(
      graphs.filter((g) => g.endsWith(".json")),
      actionsByGraph,
      actionsByTool,
    );

  const doc = render(meta, used, {
    usedBy,
    toolsFor,
    graphCount,
    usedCount: used.size,
    coreCount,
  });

  const outPath = path.resolve(ROOT, opts.out);
  if (opts.check) {
    const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (cur !== doc) {
      console.error(`${opts.out} is out of date; rerun without --check`);
      process.exit(1);
    }
    console.log(
      `${opts.out} is up to date (${used.size} classes, ${meta.packs.length} packs)`,
    );
    return;
  }
  fs.writeFileSync(outPath, doc);
  console.log(
    `wrote ${opts.out}: ${meta.packs.length} third-party packs, ${used.size} classes (${coreCount} core)`,
  );
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(2);
});
