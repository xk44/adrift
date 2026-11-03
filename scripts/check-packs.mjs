#!/usr/bin/env node
/**
 * check-packs: does each tool / pack graph run on a given ComfyUI backend?
 *
 * Reads the bundled API-format graphs (public/workflows), the registry
 * (src/lib/oj/registry.json) and the built-in pack routes (src/lib/oj/packs.ts),
 * then checks every node class and every model / option value against a
 * backend's /object_info plus its /models/<folder> lists.
 *
 * Per graph the verdict is one of:
 *   runs-now        every class is installed and every file / option value exists
 *   missing-nodes   at least one class_type is not in object_info
 *   missing-models  classes present, but a model file the graph names is absent
 *   bad-options     classes + models present, but a non-file combo value is not offered
 *
 * Static check only: graphs whose action builder rewrites model names at run
 * time are judged by the file as shipped. Empty model fields are not flagged
 * (the engine fills them from the backend's list).
 *
 * Usage (no deps, Node 18+):
 *   node scripts/check-packs.mjs --url http://127.0.0.1:8188
 *   node scripts/check-packs.mjs --object-info oi.json [--models-dir dir]
 *     (dir holds <folder>.json files, each the JSON array /models/<folder> returns)
 *   flags: --json (machine output)  --defaults (only the default-routed tools)
 *          --failing (hide runs-now rows)  --root <app dir> (default: cwd)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const STATUS = Object.freeze({
  RUNS: "runs-now",
  NODES: "missing-nodes",
  MODELS: "missing-models",
  OPTIONS: "bad-options",
});

const MODEL_EXT =
  /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl|th|tar|npz)$/i;

/** True when a string names a weight file. */
export function looksLikeModelFile(v) {
  return typeof v === "string" && MODEL_EXT.test(v.trim());
}

/** Combo options of an object_info input spec (legacy [[...]] or ["COMBO",{options}]); null when not a combo. */
export function comboOptions(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === "COMBO" && spec[1] && Array.isArray(spec[1].options))
    return spec[1].options.map(String);
  return null;
}

/** Upload slots (LoadImage.image, LoadVideo.file ...): the app fills them per run, so the shipped placeholder is not checked. */
export function isUploadInput(spec) {
  const extra = Array.isArray(spec) ? spec[1] : null;
  return (
    !!extra &&
    typeof extra === "object" &&
    Object.keys(extra).some((k) => k.endsWith("_upload") && extra[k])
  );
}

function normPath(v) {
  return String(v).replace(/\\/g, "/").trim();
}

function baseName(v) {
  const p = normPath(v);
  return p.slice(p.lastIndexOf("/") + 1).toLowerCase();
}

/** API-format graph -> {id: node}; null for UI-format or non-graph JSON. */
export function apiNodes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Array.isArray(raw.nodes)) return null;
  const out = {};
  for (const [k, n] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (n && typeof n === "object" && typeof n.class_type === "string")
      out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

function isLink(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

/** Set of lower-cased basenames across every /models/<folder> list. */
export function modelIndex(modelLists) {
  const set = new Set();
  if (!modelLists) return set;
  for (const files of Object.values(modelLists)) {
    if (!Array.isArray(files)) continue;
    for (const f of files) set.add(baseName(f));
  }
  return set;
}

/**
 * Check one API graph against object_info (+ optional model index).
 * @returns {{status: string, missingNodes: string[], missingModels: object[], badOptions: object[]}}
 */
export function checkGraph(graph, objectInfo, models = new Set()) {
  const nodes = apiNodes(graph) ?? {};
  const missingNodes = new Set();
  const missingModels = [];
  const badOptions = [];
  for (const [id, node] of Object.entries(nodes)) {
    const info = objectInfo[node.class_type];
    if (!info) {
      missingNodes.add(node.class_type);
      continue;
    }
    const specs = {
      ...(info.input?.optional ?? {}),
      ...(info.input?.required ?? {}),
    };
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value) || typeof value !== "string" || value.trim() === "")
        continue;
      if (isUploadInput(specs[name])) continue;
      const opts = comboOptions(specs[name]);
      const file = looksLikeModelFile(value);
      if (opts) {
        const v = normPath(value);
        if (opts.some((o) => normPath(o) === v)) continue;
        // Same file in a different subfolder still loads after a re-pick; flag it anyway (the graph as shipped fails).
        const entry = {
          node: id,
          class_type: node.class_type,
          input: name,
          value,
        };
        if (file) missingModels.push(entry);
        else badOptions.push(entry);
      } else if (file && models.size > 0 && !models.has(baseName(value))) {
        missingModels.push({
          node: id,
          class_type: node.class_type,
          input: name,
          value,
        });
      }
    }
  }
  const status = missingNodes.size
    ? STATUS.NODES
    : missingModels.length
      ? STATUS.MODELS
      : badOptions.length
        ? STATUS.OPTIONS
        : STATUS.RUNS;
  return {
    status,
    missingNodes: [...missingNodes].sort(),
    missingModels,
    badOptions,
  };
}

/**
 * Built-in pack routes from src/lib/oj/packs.ts (static parse; no TS runtime):
 * every `const X_PACK: WorkflowPack = { id: "...", ... workflows: { k: "v" } }`.
 */
export function parsePacksSource(src) {
  const packs = [];
  const re = /const\s+\w+\s*:\s*WorkflowPack\s*=\s*\{([\s\S]*?)\n\};/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    const id = /\n\s*id:\s*"([^"]+)"/.exec(body)?.[1];
    const wf = /\n\s*workflows:\s*\{([\s\S]*?)\n\s*\},/.exec(body)?.[1];
    if (!id) continue;
    const workflows = {};
    if (wf) {
      const pr = /["']?([\w.-]+)["']?\s*:\s*"([^"]+)"/g;
      let p;
      while ((p = pr.exec(wf))) workflows[p[1]] = p[2];
    }
    const isDefault = /\n\s*isDefault:\s*true/.test(body);
    packs.push({ id, isDefault, workflows });
  }
  return packs;
}

/**
 * What each registry action runs on a stock install, mirroring
 * resolveActionWorkflow (src/lib/oj/packs.ts): default pack by action id,
 * then by template, then the registry template file; i2v/t2v fall back to
 * the video packs (ltx25 first) when the default pack has no route.
 */
export function defaultRoutes(registry, packs, defaultPackId = "krea2") {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const def = byId.get(defaultPackId) ?? { workflows: {} };
  const templates = registry.templates ?? {};
  const routes = [];
  for (const [actionId, action] of Object.entries(registry.actions ?? {})) {
    const template = action.template;
    let file = def.workflows[actionId];
    let via = file ? `pack:${defaultPackId}` : "";
    if (!file && templates[actionId]?.file && !template) {
      file = templates[actionId].file;
      via = "registry";
    }
    if (!file && template) {
      file = def.workflows[template];
      via = file ? `pack:${defaultPackId}` : "";
      if (!file && (template === "i2v" || template === "t2v")) {
        for (const id of ["ltx25", "ltxv", "wan"]) {
          if (byId.get(id)?.workflows[template]) {
            file = byId.get(id).workflows[template];
            via = `pack:${id}`;
            break;
          }
        }
      }
      if (!file && templates[actionId]?.file) {
        file = templates[actionId].file;
        via = "registry";
      }
      if (!file && templates[template]?.file) {
        file = templates[template].file;
        via = "registry";
      }
    }
    routes.push({
      kind: "action",
      id: actionId,
      template: template ?? null,
      file: file ?? null,
      via,
    });
  }
  for (const t of ["t2v", "i2v", "t23d", "i23d", "t2a"]) {
    const file = def.workflows[t] ?? templates[t]?.file ?? null;
    routes.push({
      kind: "template",
      id: t,
      template: t,
      file,
      via: def.workflows[t] ? `pack:${defaultPackId}` : "registry",
    });
  }
  return routes;
}

/** Every graph a pack routes to, one row per (pack, key). */
export function packRoutes(packs) {
  const rows = [];
  for (const p of packs)
    for (const [key, file] of Object.entries(p.workflows))
      rows.push({
        kind: "pack",
        id: `${p.id}:${key}`,
        template: key,
        file,
        via: `pack:${p.id}`,
      });
  return rows;
}

/** Attach a checkGraph verdict to each route (graph files loaded via `loadGraph(file)`). */
export function checkRoutes(routes, loadGraph, objectInfo, models) {
  const cache = new Map();
  return routes.map((r) => {
    if (!r.file)
      return {
        ...r,
        status: "no-graph",
        missingNodes: [],
        missingModels: [],
        badOptions: [],
      };
    if (!cache.has(r.file)) {
      const g = loadGraph(r.file);
      cache.set(r.file, g ? checkGraph(g, objectInfo, models) : null);
    }
    const res = cache.get(r.file);
    if (!res)
      return {
        ...r,
        status: "no-graph",
        missingNodes: [],
        missingModels: [],
        badOptions: [],
      };
    return { ...r, ...res };
  });
}

/** One-line "needs X" summary of a verdict (same wording the app shows). */
export function describeVerdict(row) {
  if (row.status === STATUS.RUNS) return "runs now";
  if (row.status === "no-graph")
    return "no bundled graph (builder-only or browser-side)";
  const parts = [];
  if (row.missingNodes?.length)
    parts.push(`needs nodes: ${row.missingNodes.join(", ")}`);
  if (row.missingModels?.length)
    parts.push(
      `needs models: ${[...new Set(row.missingModels.map((m) => m.value))].join(", ")}`,
    );
  if (row.badOptions?.length)
    parts.push(
      `bad options: ${row.badOptions.map((o) => `${o.class_type}.${o.input}=${o.value}`).join(", ")}`,
    );
  return parts.join("; ");
}

// CLI

function parseArgs(argv) {
  const a = { json: false, defaults: false, failing: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--defaults") a.defaults = true;
    else if (k === "--failing") a.failing = true;
    else if (k === "--url") a.url = argv[++i];
    else if (k === "--object-info") a.objectInfo = argv[++i];
    else if (k === "--models-dir") a.modelsDir = argv[++i];
    else if (k === "--root") a.root = argv[++i];
    else if (k === "--default-pack") a.defaultPack = argv[++i];
    else if (k === "-h" || k === "--help") a.help = true;
  }
  return a;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function loadBackend(a) {
  if (a.url) {
    const base = a.url.replace(/\/+$/, "");
    const objectInfo = await getJson(`${base}/object_info`);
    const folders = await getJson(`${base}/models`).catch(() => []);
    const lists = {};
    for (const f of folders)
      lists[f] = await getJson(`${base}/models/${encodeURIComponent(f)}`).catch(
        () => [],
      );
    return { objectInfo, lists };
  }
  const objectInfo = JSON.parse(fs.readFileSync(a.objectInfo, "utf-8"));
  const lists = {};
  if (a.modelsDir)
    for (const f of fs.readdirSync(a.modelsDir))
      if (f.endsWith(".json"))
        lists[f.slice(0, -5)] = JSON.parse(
          fs.readFileSync(path.join(a.modelsDir, f), "utf-8"),
        );
  return { objectInfo, lists };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.url && !a.objectInfo)) {
    console.log(
      "usage: node scripts/check-packs.mjs (--url <comfy> | --object-info <file> [--models-dir <dir>]) [--json] [--defaults] [--failing]",
    );
    process.exit(a.help ? 0 : 2);
  }
  const root = path.resolve(a.root ?? process.cwd());
  const wfRoot = path.join(root, "public/workflows");
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, "src/lib/oj/registry.json"), "utf-8"),
  );
  const packs = parsePacksSource(
    fs.readFileSync(path.join(root, "src/lib/oj/packs.ts"), "utf-8"),
  );
  const defaultPack =
    a.defaultPack ??
    process.env.CJ_DEFAULT_PACK?.trim() ??
    packs.find((p) => p.isDefault)?.id ??
    "krea2";
  const { objectInfo, lists } = await loadBackend(a);
  const models = modelIndex(lists);
  const loadGraph = (file) => {
    const p = path.join(wfRoot, file);
    if (!p.startsWith(wfRoot) || !fs.existsSync(p)) return null;
    return apiNodes(JSON.parse(fs.readFileSync(p, "utf-8")));
  };
  let rows = checkRoutes(
    defaultRoutes(registry, packs, defaultPack),
    loadGraph,
    objectInfo,
    models,
  );
  if (!a.defaults)
    rows = rows.concat(
      checkRoutes(packRoutes(packs), loadGraph, objectInfo, models),
    );
  if (a.failing)
    rows = rows.filter(
      (r) => r.status !== STATUS.RUNS && r.status !== "no-graph",
    );
  if (a.json) {
    console.log(JSON.stringify({ defaultPack, rows }, null, 2));
    return;
  }
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const r of rows)
    console.log(
      `${r.status.padEnd(14)} ${r.kind.padEnd(8)} ${r.id.padEnd(34)} ${String(r.file ?? "-").padEnd(42)} ${r.status === STATUS.RUNS || r.status === "no-graph" ? "" : describeVerdict(r)}`,
    );
  console.log(
    `\ndefault pack: ${defaultPack}; ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
