#!/usr/bin/env node
/**
 * Record src/__tests__/fixtures/graphLint.objectInfo.json: the object_info
 * slice for every class_type the bundled packs and action builders use.
 *
 * READ-ONLY: GET /object_info/<class> only (never /prompt, /free, ...).
 *
 *   GRAPH_LINT_DUMP=/tmp/graph-lint-dump.json \
 *     vitest run src/__tests__/graphLintPacks.test.ts
 *   node scripts/record-graph-lint-fixture.mjs /tmp/graph-lint-dump.json \
 *     [--base http://127.0.0.1:8188]
 *
 * File-list combos (input/output files) are cut down to the values the
 * graphs actually use, so the fixture stays small. Model-file combos are
 * replaced by one neutral placeholder (non-file entries such as "None" are
 * kept) and model-file defaults are dropped: installs differ, the linter only
 * warns on model files, and the fixture must not carry the recording box's
 * model folders. Tooltips are dropped. Classes the box does not know are
 * listed in _meta.missing_on_reference (the linter skips them).
 *
 * Re-scrub an existing fixture (no ComfyUI box needed):
 *   node scripts/record-graph-lint-fixture.mjs --scrub
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP_DIR, "src/__tests__/fixtures/graphLint.objectInfo.json");

const FILE_RE = /\.[A-Za-z0-9]{2,12}$|[\\/]/;
// Same extensions as MODEL_FILE_RE in src/lib/tools/graphLint.ts.
const MODEL_FILE_RE =
  /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx|pkl|engine)$/i;
/** Stands in for every model file a combo lists on the recording box. */
const MODEL_PLACEHOLDER = "example_model.safetensors";

const isModelFile = (o) => typeof o === "string" && MODEL_FILE_RE.test(o);
const isFileList = (opts) =>
  opts.some((o) => typeof o === "string" && FILE_RE.test(o));

/** Model-file combo -> its non-file entries plus the placeholder. */
function scrubList(opts) {
  if (!opts.some(isModelFile)) return opts;
  return [...opts.filter((o) => !isModelFile(o)), MODEL_PLACEHOLDER];
}

/** Literal values the graphs use (file lists are cut down to these). */
let used = new Set();
const trimList = (opts) =>
  scrubList(isFileList(opts) ? opts.filter((o) => used.has(o)) : opts);

function trimCfg(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cfg;
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "tooltip") continue;
    // Absolute-path defaults name the recording box's directories.
    if (typeof v === "string" && /^(~|\/|[A-Za-z]:[\\/])/.test(v)) continue;
    // Model-file defaults name the recording box's model files.
    if (k === "default" && isModelFile(v)) continue;
    out[k] = k === "options" && Array.isArray(v) ? trimList(v) : v;
  }
  return out;
}

function trimSpec(spec) {
  if (!Array.isArray(spec)) return spec;
  const [type, cfg, ...rest] = spec;
  return [
    Array.isArray(type) ? trimList(type) : type,
    ...(spec.length > 1 ? [trimCfg(cfg)] : []),
    ...rest,
  ];
}

function trimDef(def) {
  const input = {};
  for (const section of ["required", "optional", "hidden"]) {
    const s = def.input?.[section];
    if (!s) continue;
    input[section] = Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, trimSpec(v)]),
    );
  }
  return {
    input,
    output: (def.output ?? []).map((o) => (Array.isArray(o) ? trimList(o) : o)),
    output_name: def.output_name,
    output_is_list: def.output_is_list,
    output_node: def.output_node,
  };
}

if (process.argv[2] === "--scrub") {
  // Model scrub only: every non-model value counts as used.
  used = { has: () => true };
  const { _meta, ...defs } = JSON.parse(readFileSync(OUT, "utf8"));
  const out = { _meta };
  for (const [cls, def] of Object.entries(defs)) out[cls] = trimDef(def);
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`scrubbed ${Object.keys(defs).length} classes`);
  process.exit(0);
}

const dumpPath = process.argv[2];
if (!dumpPath || dumpPath.startsWith("--")) {
  console.error(
    "usage: record-graph-lint-fixture.mjs <dump.json> [--base URL] | --scrub",
  );
  process.exit(2);
}
const baseArg = process.argv.indexOf("--base");
const BASE = (
  baseArg > 0
    ? process.argv[baseArg + 1]
    : process.env.COMFY_HTTP_URL || "http://127.0.0.1:8188"
).replace(/\/$/, "");

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
used = new Set(dump.values);

const out = {};
const missing = [];
for (const cls of dump.classes) {
  const res = await fetch(`${BASE}/object_info/${encodeURIComponent(cls)}`);
  if (!res.ok) throw new Error(`GET /object_info/${cls} -> ${res.status}`);
  const body = await res.json();
  if (body?.[cls]) out[cls] = trimDef(body[cls]);
  else missing.push(cls);
}
const stats = await fetch(`${BASE}/system_stats`)
  .then((r) => r.json())
  .catch(() => null);

const fixture = {
  _meta: {
    comfyui_version: stats?.system?.comfyui_version ?? null,
    recorded_at: new Date().toISOString(),
    source: "GET /object_info/<class> on the reference ComfyUI box",
    missing_on_reference: missing,
  },
  ...out,
};
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(
  `kept ${Object.keys(out).length} classes, ${missing.length} missing: ${missing.join(", ")}`,
);
