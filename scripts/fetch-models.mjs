#!/usr/bin/env node
/**
 * fetch-models.mjs: download the model files Adrift's tools load into a
 * ComfyUI install. No dependencies; Node 20 or newer.
 *
 *   node scripts/fetch-models.mjs --comfy /path/to/ComfyUI            # plan only
 *   node scripts/fetch-models.mjs --comfy /path/to/ComfyUI --yes      # download
 *   node scripts/fetch-models.mjs --tool upscale --comfy ... --yes    # one tool
 *   node scripts/fetch-models.mjs --tool upscale,animate --skip loras/x.safetensors ...
 *   node scripts/fetch-models.mjs --list-tools
 *   node scripts/fetch-models.mjs --pack images-best,upscale --comfy ... --yes
 *
 * Reads models/download-list.json (pinned Hugging Face files, same rows as
 * models/download-list.md) and, for --tool, docs/models-by-tool.json (the
 * files each Tools-page card loads, generated from the tool graphs).
 *
 * Without --yes it only prints the plan and the total size. With --yes it
 * downloads every missing file to ComfyUI/models/<dest>: through the `hf` CLI
 * when it is installed (it uses your Hugging Face login for gated repos),
 * otherwise over plain https with resume (HTTP Range) into <dest>.part.
 * Every URL is pinned to a revision, every file is size-checked, and nothing
 * is ever deleted or overwritten: a file already on disk with the wrong size
 * is reported and left alone.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const UA = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const DEFAULT_LIST = path.join(REPO_ROOT, "models/download-list.json");
export const DEFAULT_TOOL_MAP = path.join(
  REPO_ROOT,
  "docs/models-by-tool.json",
);
/** Starter packs (the first-run wizard's list). */
export const DEFAULT_PACKS = path.join(
  REPO_ROOT,
  "src/lib/onboarding/starterPacks.json",
);
/** Staging area for hf CLI downloads; ComfyUI does not scan it. */
const STAGE_DIR = ".fetch-models";

const SETS = ["starter", "minimal", "full"];
/**
 * The Starter set: a small first download (~11 GB) that runs on core ComfyUI
 * nodes only: SDXL for Create, BiRefNet for background removal, and
 * Stable Audio 3 Small SFX + its text encoder for the sound-effects tool.
 */
export const STARTER_DESTS = [
  "checkpoints/sd_xl_base_1.0.safetensors",
  "background_removal/birefnet.safetensors",
  "checkpoints/stable_audio_3_small_sfx.safetensors",
  "text_encoders/t5gemma_b_b_ul2.safetensors",
];

const USAGE = `Usage: node scripts/fetch-models.mjs [options]

  --comfy <dir>        ComfyUI folder (files go to <dir>/models/...);
                       default: $COMFY_ROOT when it is set
  --tool <id[,id]>     only the files these Tools-page cards load
                       (see --list-tools; use kind:id if an id is ambiguous)
  --pack <id[,id]>     only the files of these starter packs (the setup
                       wizard's list; see --list-packs)
  --use <dest>         with --pack: fetch this alternative file for its slot
                       instead of the default, or add an optional file
                       (repeatable)
  --set starter|minimal|full
                       starter = ~11 GB to try Adrift (SDXL image, background
                       removal, sound effects); minimal = what the default
                       tools need (~272 GB); full = minimal plus everything
                       else (default: minimal, or full with --tool)
  --only <dest>        only this file, as its models/ path, e.g.
                       loras/x.safetensors (repeatable; without --tool or
                       --pack it picks from the full list)
  --skip <dest>        leave this file out, as its models/ path (repeatable);
                       a path the plan doesn't have is ignored
  --dry-run            print the plan and total size only (default)
  --yes                download the missing files
  --no-hf              use plain https even if the hf CLI is installed
  --list <file>        download list JSON (default: models/download-list.json)
  --tool-map <file>    tool map JSON (default: docs/models-by-tool.json)
  --list-tools         print the tool ids and exit
  --list-packs         print the starter pack ids and exit
  -h, --help           this help`;

// Arguments

/** Parse argv (without node + script). Throws an Error with a usage hint.
 *  `env` supplies COMFY_ROOT as the --comfy default (main passes process.env). */
export function parseArgs(argv, env = {}) {
  const opts = {
    comfy: null,
    tool: null,
    set: null,
    dryRun: false,
    yes: false,
    noHf: false,
    list: null,
    toolMap: null,
    listTools: false,
    pack: null,
    use: [],
    only: [],
    skip: [],
    listPacks: false,
    help: false,
  };
  const valued = {
    "--comfy": "comfy",
    "--tool": "tool",
    "--set": "set",
    "--list": "list",
    "--tool-map": "toolMap",
    "--pack": "pack",
    "--use": "use",
    "--only": "only",
    "--skip": "skip",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in valued) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined || value.startsWith("--"))
          throw new Error(`${arg} needs a value`);
      }
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--use") opts.use.push(value);
      else if (arg === "--only") opts.only.push(value);
      else if (arg === "--skip") opts.skip.push(value);
      else opts[valued[arg]] = value;
      continue;
    }
    if (value !== undefined) throw new Error(`${arg} takes no value`);
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--no-hf":
        opts.noHf = true;
        break;
      case "--list-tools":
        opts.listTools = true;
        break;
      case "--list-packs":
        opts.listPacks = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.set !== null && !SETS.includes(opts.set))
    throw new Error(`--set must be starter, minimal or full, got ${opts.set}`);
  if (!opts.comfy && env.COMFY_ROOT?.trim()) opts.comfy = env.COMFY_ROOT.trim();
  if (opts.pack && opts.tool) throw new Error("use --pack or --tool, not both");
  if (opts.use.length && !opts.pack) throw new Error("--use needs --pack");
  // --dry-run always wins: it never downloads, even next to --yes.
  if (opts.dryRun) opts.yes = false;
  if (opts.yes && !opts.comfy)
    throw new Error("--yes needs --comfy <ComfyUI dir> (or set COMFY_ROOT)");
  return opts;
}

// Data validation

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RPATH_RE = /^[A-Za-z0-9._/+()[\]-]+$/;
const DEST_RE = /^[A-Za-z0-9._/+()-]+$/;
const REV_RE = /^[0-9a-f]{40}$/;

export function safeRel(p) {
  return (
    typeof p === "string" &&
    DEST_RE.test(p) &&
    !p.startsWith("/") &&
    !p.split("/").some((s) => s === ".." || s === "." || s === "")
  );
}

/** Validate a download-list.json document; returns its rows. */
export function validateList(doc) {
  if (!doc || !Array.isArray(doc.files))
    throw new Error("download list: no files array");
  for (const r of doc.files) {
    const where = `download list row ${JSON.stringify(r.dest)}`;
    if (!REPO_RE.test(r.repo ?? "")) throw new Error(`${where}: bad repo`);
    if (!RPATH_RE.test(r.path ?? "") || r.path.split("/").includes(".."))
      throw new Error(`${where}: bad path`);
    if (!REV_RE.test(r.revision ?? ""))
      throw new Error(`${where}: bad revision`);
    if (!Number.isSafeInteger(r.size) || r.size <= 0)
      throw new Error(`${where}: bad size`);
    if (r.set !== "minimal" && r.set !== "full")
      throw new Error(`${where}: bad set`);
    for (const d of [r.dest, ...(r.also ?? [])])
      if (!safeRel(d))
        throw new Error(`${where}: unsafe destination ${JSON.stringify(d)}`);
  }
  // A hand download can be a whole folder ("SeeThrough/x/").
  for (const r of [...(doc.other ?? []), ...(doc.convert ?? [])])
    if (!safeRel(r.dest.replace(/\/$/, "")))
      throw new Error(
        `download list: unsafe destination ${JSON.stringify(r.dest)}`,
      );
  return doc;
}

/**
 * Rows that fetch the same pinned file (repo + path + revision) become one
 * row, the other destinations as `also` links, so the file downloads once.
 * Throws when two such rows disagree on the size.
 */
export function mergeSameSource(doc) {
  const byKey = new Map();
  const files = [];
  for (const r of doc.files) {
    const key = `${r.repo}\n${r.path}\n${r.revision}`;
    const first = byKey.get(key);
    if (!first) {
      const row = { ...r };
      byKey.set(key, row);
      files.push(row);
      continue;
    }
    if (first.size !== r.size)
      throw new Error(
        `download list: ${r.repo}/${r.path} is listed with two sizes`,
      );
    const also = [...(first.also ?? [])];
    for (const d of [r.dest, ...(r.also ?? [])])
      if (d !== first.dest && !also.includes(d)) also.push(d);
    first.also = also;
    if (r.set === "minimal") first.set = "minimal";
  }
  return { ...doc, files };
}

// Tools

/** Find one tool by "id" or "kind:id". Throws with suggestions otherwise. */
export function resolveTool(toolMap, query) {
  const tools = toolMap?.tools ?? [];
  const exact = tools.filter(
    (t) => `${t.kind}:${t.id}` === query || t.id === query,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1)
    throw new Error(
      `tool id ${query} is ambiguous; use one of: ${exact.map((t) => `${t.kind}:${t.id}`).join(", ")}`,
    );
  const q = query.toLowerCase();
  const near = tools
    .filter(
      (t) =>
        t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
    )
    .slice(0, 8)
    .map((t) => `${t.id} (${t.title})`);
  throw new Error(
    `unknown tool: ${query}` +
      (near.length
        ? `; did you mean: ${near.join(", ")}`
        : "; see --list-tools"),
  );
}

/**
 * One or more tools ("a,b") as one tool-shaped object for buildPlan, each file
 * once. A single id stays that tool. Throws like resolveTool on a bad id.
 */
export function resolveTools(toolMap, query) {
  const ids = String(query)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error("--tool needs at least one id");
  const tools = ids.map((id) => resolveTool(toolMap, id));
  if (tools.length === 1) return tools[0];
  return {
    kind: "tools",
    id: ids.join(","),
    files: [...new Set(tools.flatMap((t) => t.files ?? []))],
    dirs: [...new Set(tools.flatMap((t) => t.dirs ?? []))],
  };
}

// Starter packs

/**
 * Turn starter pack ids into a tool-shaped object for buildPlan: the files of
 * every pack, one per slot (the slot's first option, or the option named by
 * --use). Optional files (`optional: true`) only when --use names them.
 * Throws on an unknown pack or a --use that matches no slot.
 */
export function packTool(packsDoc, ids, use = []) {
  const packs = packsDoc?.packs ?? [];
  const wanted = String(ids)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) throw new Error("--pack needs at least one id");
  const files = [];
  const used = new Set();
  for (const id of wanted) {
    const pack = packs.find((p) => p.id === id);
    if (!pack)
      throw new Error(
        `unknown pack: ${id}; one of: ${packs.map((p) => p.id).join(", ")}`,
      );
    for (const slot of pack.files) {
      const options = Array.isArray(slot.options) ? slot.options : [slot];
      const named = options.find((o) => use.includes(o.dest));
      // Slot options are drop-in alternatives: one another chosen pack
      // already fetches (Images + Draft both take the Qwen3-VL encoder)
      // is reused instead of downloading a second precision of it.
      const pick =
        named ?? options.find((o) => files.includes(o.dest)) ?? options[0];
      if (slot.optional && !named) continue;
      if (named) used.add(named.dest);
      if (!files.includes(pick.dest)) files.push(pick.dest);
    }
  }
  const unused = use.filter((u) => !used.has(u));
  if (unused.length)
    throw new Error(
      `--use ${unused.join(", ")} is not an option of those packs`,
    );
  return { kind: "pack", id: wanted.join(","), files, dirs: [] };
}

// Plan

/** Keep only the plan rows whose dest (or an `also` path) is in `only`.
 *  Throws when an --only path is not part of the plan. */
export function filterPlan(plan, only) {
  if (!only?.length) return plan;
  const hit = new Set();
  const keep = (dests) => {
    const m = dests.filter((d) => only.includes(d));
    m.forEach((d) => hit.add(d));
    return m.length > 0;
  };
  const items = plan.items.filter((r) => keep([r.dest, ...(r.also ?? [])]));
  const other = plan.other.filter((o) => keep([o.dest]));
  const convert = plan.convert.filter((o) => keep([o.dest]));
  const miss = only.filter((d) => !hit.has(d));
  if (miss.length)
    throw new Error(`--only ${miss.join(", ")} is not a file of this plan`);
  return { ...plan, items, other, convert, unlisted: [], skipped: 0 };
}

/**
 * Drop the plan rows named by --skip. A file can sit at several paths (`also`):
 * it stays only if the tool still loads it at a path that isn't skipped.
 */
export function skipPlan(plan, skip, toolFiles = null) {
  if (!skip?.length) return plan;
  const stillWanted = (d) =>
    !skip.includes(d) && (toolFiles ? toolFiles.includes(d) : true);
  const out = (dests) =>
    dests.some((d) => skip.includes(d)) && !dests.some(stillWanted);
  return {
    ...plan,
    items: plan.items.filter((r) => !out([r.dest, ...(r.also ?? [])])),
    other: plan.other.filter((o) => !out([o.dest])),
    convert: plan.convert.filter((o) => !out([o.dest])),
    unlisted: plan.unlisted.filter((d) => !skip.includes(d)),
  };
}

export function hfUrl(row) {
  const p = row.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${row.repo}/resolve/${row.revision}/${p}`;
}

/**
 * Pick the rows to fetch.
 * No tool: every row in the set (full = minimal + full).
 * With a tool: the rows whose destination (or "also" destination) is one of
 * the tool's files, or lies under one of its by-name folders; the set filter
 * applies only when given.
 */
export function buildPlan(list, { tool = null, set = null } = {}) {
  const effSet = set ?? (tool ? "full" : "minimal");
  const inSet =
    effSet === "starter"
      ? (r) =>
          [r.dest, ...(r.also ?? [])].some((d) => STARTER_DESTS.includes(d))
      : (r) => effSet === "full" || r.set === "minimal";
  const plan = { set: effSet, tool: tool ? `${tool.kind}:${tool.id}` : null };
  if (!tool) {
    plan.items = list.files.filter(inSet);
    plan.skipped = list.files.length - plan.items.length;
    const starter = effSet === "starter";
    // Starter lists one optional hand download: the 67 MB x4 upscaler.
    plan.other = (list.other ?? []).filter(
      (o) => !starter || o.dest === "upscale_models/RealESRGAN_x4plus.pth",
    );
    plan.convert = starter ? [] : (list.convert ?? []);
    plan.unlisted = [];
    return plan;
  }
  const byDest = new Map();
  for (const r of list.files)
    for (const d of [r.dest, ...(r.also ?? [])]) byDest.set(d, r);
  const items = [];
  const skipped = new Set();
  const add = (r) => {
    if (!inSet(r)) skipped.add(r);
    else if (!items.includes(r)) items.push(r);
  };
  const unlisted = [];
  const otherDests = new Set((list.other ?? []).map((o) => o.dest));
  const convertDests = new Set((list.convert ?? []).map((o) => o.dest));
  for (const f of tool.files ?? []) {
    const r = byDest.get(f);
    if (r) add(r);
    else if (!otherDests.has(f) && !convertDests.has(f)) unlisted.push(f);
  }
  for (const dir of tool.dirs ?? []) {
    const rows = list.files.filter((r) => r.dest.startsWith(dir));
    if (!rows.length && !otherDests.has(dir)) unlisted.push(dir);
    rows.forEach(add);
  }
  plan.items = items;
  plan.other = (list.other ?? []).filter(
    (o) => tool.files?.includes(o.dest) || tool.dirs?.includes(o.dest),
  );
  plan.convert = (list.convert ?? []).filter((o) =>
    tool.files?.includes(o.dest),
  );
  plan.unlisted = unlisted;
  plan.skipped = skipped.size;
  return plan;
}

function fileSize(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : -2;
  } catch {
    return -1;
  }
}

/**
 * Disk state per item: "have" (right size), "link" (missing, but one of its
 * `also` paths holds the file: linked, not downloaded again), "part"
 * (resumable .part file), "get" (missing) or "mismatch" (something else is
 * there; never touched).
 */
export function checkDisk(plan, modelsDir, sizeOf = fileSize) {
  return plan.items.map((r) => {
    if (!modelsDir) return { row: r, state: "get", partial: 0 };
    const dest = path.join(modelsDir, r.dest);
    const cur = sizeOf(dest);
    if (cur === r.size) return { row: r, state: "have", partial: 0 };
    if (cur !== -1)
      return { row: r, state: "mismatch", partial: 0, onDisk: cur };
    const copy = (r.also ?? []).find(
      (a) => sizeOf(path.join(modelsDir, a)) === r.size,
    );
    if (copy) return { row: r, state: "link", partial: 0, from: copy };
    const part = sizeOf(`${dest}.part`);
    if (part > 0 && part <= r.size)
      return { row: r, state: "part", partial: part };
    if (part > r.size)
      return {
        row: r,
        state: "mismatch",
        partial: 0,
        onDisk: part,
        partFile: true,
      };
    return { row: r, state: "get", partial: 0 };
  });
}

export function totals(status) {
  const t = {
    files: status.length,
    bytes: 0,
    have: 0,
    need: 0,
    nHave: 0,
    nMismatch: 0,
  };
  for (const s of status) {
    t.bytes += s.row.size;
    if (s.state === "have" || s.state === "link") {
      t.have += s.row.size;
      t.nHave++;
    } else if (s.state === "mismatch") t.nMismatch++;
    else t.need += s.row.size - s.partial;
  }
  return t;
}

export function gb(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function formatPlan(
  plan,
  status,
  { modelsDir = null, free = null } = {},
) {
  const out = [];
  out.push(
    `Set: ${plan.set}${plan.tool ? `   Tool: ${plan.tool}` : ""}   Models dir: ${modelsDir ?? "(none, pass --comfy)"}`,
  );
  const tag = {
    have: "have",
    link: "link",
    part: "part",
    get: "get ",
    mismatch: "SKIP",
  };
  for (const s of status) {
    let line = `  [${tag[s.state]}] ${gb(s.row.size).padStart(9)}  ${s.row.dest}  (${s.row.repo})`;
    if (s.state === "part") line += `  resume from ${gb(s.partial)}`;
    if (s.state === "link")
      line += `  same file as ${s.from}; linked, not downloaded`;
    if (s.state === "mismatch")
      line += `  on disk ${s.onDisk} bytes${s.partFile ? " in .part" : ""}, expected ${s.row.size}; not touched`;
    out.push(line);
    for (const a of s.row.also ?? [])
      out.push(`               also linked to ${a}`);
  }
  if (plan.other.length) {
    out.push(
      "Download by hand (not on Hugging Face; check the license on the page):",
    );
    for (const o of plan.other)
      out.push(`  ${o.dest}  ${gb(o.size)}  ${o.license}  ${o.page}`);
  }
  if (plan.convert.length) {
    out.push(
      "Download by hand, then convert (published with diffusers key names):",
    );
    for (const c of plan.convert)
      out.push(`  ${c.dest}  from ${c.repo}/${c.path} via ${c.converter}`);
  }
  if (plan.skipped && plan.set === "minimal")
    out.push(
      `${plan.skipped} more file(s) are in the full set; add --set full to include them.`,
    );
  if (plan.skipped && plan.set === "starter")
    out.push(
      `${plan.skipped} more file(s) are in the larger sets; use --set minimal or --tool <id> for more.`,
    );
  if (plan.unlisted.length) {
    out.push("Not in the download list (see docs/models.md for the source):");
    for (const u of plan.unlisted) out.push(`  ${u}`);
  }
  const t = totals(status);
  out.push(
    `Total: ${t.files} files, ${gb(t.bytes)}; complete on disk ${t.nHave} (${gb(t.have)}); to download ${gb(t.need)}` +
      (t.nMismatch ? `; ${t.nMismatch} skipped (size mismatch)` : ""),
  );
  if (free !== null)
    out.push(
      `Free space: ${gb(free)} now, ${gb(free - t.need)} after download`,
    );
  return out.join("\n");
}

// Download

function hasHf() {
  const r = spawnSync("hf", ["version"], { stdio: "ignore" });
  return r.status === 0;
}

function within(root, p) {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function httpsDownload(row, dest) {
  const part = `${dest}.part`;
  const headers = { "User-Agent": UA };
  if (process.env.HF_TOKEN)
    headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const have = Math.max(0, fileSize(part));
    if (have === row.size) break;
    const h = { ...headers };
    if (have > 0) h.Range = `bytes=${have}-`;
    try {
      const res = await fetch(hfUrl(row), { headers: h, redirect: "follow" });
      if (res.status === 401 || res.status === 403)
        throw Object.assign(
          new Error(
            `HTTP ${res.status}: gated repo? Accept its terms on Hugging Face and set HF_TOKEN (or log in with the hf CLI)`,
          ),
          { fatal: true },
        );
      if (res.status !== 200 && res.status !== 206)
        throw new Error(`HTTP ${res.status}`);
      // 200 to a ranged request means the server ignored the range: start over.
      const flags = res.status === 206 ? "a" : "w";
      await pipeline(
        Readable.fromWeb(res.body),
        fs.createWriteStream(part, { flags }),
      );
    } catch (e) {
      if (e.fatal) throw e;
      console.error(`   attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const got = fileSize(part);
  if (got !== row.size)
    throw new Error(`have ${got} of ${row.size} bytes; re-run to resume`);
  fs.renameSync(part, dest);
}

function hfDownload(row, dest, modelsDir) {
  const stage = path.join(
    modelsDir,
    STAGE_DIR,
    row.repo.replace("/", "__"),
    row.revision,
  );
  const r = spawnSync(
    "hf",
    [
      "download",
      row.repo,
      row.path,
      "--revision",
      row.revision,
      "--local-dir",
      stage,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`hf download exited ${r.status}`);
  const got = path.join(stage, row.path);
  const size = fileSize(got);
  if (size !== row.size)
    throw new Error(`hf download gave ${size} bytes, expected ${row.size}`);
  try {
    fs.renameSync(got, dest);
  } catch {
    fs.copyFileSync(got, dest, fs.constants.COPYFILE_EXCL);
  }
}

function linkAlso(row, modelsDir) {
  const src = path.join(modelsDir, row.dest);
  for (const a of row.also ?? []) {
    const dst = path.join(modelsDir, a);
    if (!within(modelsDir, dst)) continue;
    const cur = fileSize(dst);
    if (cur === row.size) continue;
    if (cur !== -1) {
      console.log(`   ${a}: something else is there, not touched`);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    }
    console.log(`   linked ${a}`);
  }
}

async function download(status, modelsDir, useHf) {
  let ok = 0;
  let fail = 0;
  for (const s of status) {
    const r = s.row;
    const dest = path.join(modelsDir, r.dest);
    if (!within(modelsDir, dest))
      throw new Error(`refusing to write outside models/: ${r.dest}`);
    if (s.state === "mismatch") continue;
    if (s.state === "link") {
      const src = path.join(modelsDir, s.from);
      if (!within(modelsDir, src))
        throw new Error(`refusing to read outside models/: ${s.from}`);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.linkSync(src, dest);
        } catch {
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        }
      } catch (e) {
        console.error(`   FAILED ${r.dest}: ${e.message}`);
        fail++;
        continue;
      }
      console.log(`>> ${r.dest}: linked from ${s.from}`);
    } else if (s.state !== "have") {
      console.log(`>> ${r.dest} (${gb(r.size)})`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        if (useHf) hfDownload(r, dest, modelsDir);
        else await httpsDownload(r, dest);
        ok++;
      } catch (e) {
        console.error(`   FAILED ${r.dest}: ${e.message}`);
        fail++;
        continue;
      }
    }
    linkAlso(r, modelsDir);
  }
  return { ok, fail };
}

// Main

function readJson(p, what) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${what} ${p}: ${e.message}`);
  }
}

function freeBytes(dir) {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const s = fs.statfsSync(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export async function main(argv) {
  const opts = parseArgs(argv, process.env);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const toolMap =
    opts.listTools || opts.tool
      ? readJson(opts.toolMap ?? DEFAULT_TOOL_MAP, "tool map")
      : null;
  if (opts.listPacks || opts.pack) {
    const packsDoc = readJson(DEFAULT_PACKS, "starter packs");
    if (opts.listPacks) {
      for (const p of packsDoc.packs)
        console.log(`${p.id.padEnd(16)} ${p.title}`);
      return 0;
    }
    opts.packTool = packTool(packsDoc, opts.pack, opts.use);
  }
  if (opts.listTools) {
    for (const t of toolMap.tools)
      console.log(
        `${`${t.kind}:${t.id}`.padEnd(36)} ${t.title} (${t.category}, ${t.files.length} files)`,
      );
    return 0;
  }
  const list = mergeSameSource(
    validateList(readJson(opts.list ?? DEFAULT_LIST, "download list")),
  );
  const tool = opts.packTool
    ? opts.packTool
    : opts.tool
      ? resolveTools(toolMap, opts.tool)
      : null;
  const set = opts.set ?? (opts.only.length && !tool ? "full" : null);
  const plan = skipPlan(
    filterPlan(buildPlan(list, { tool, set }), opts.only),
    opts.skip,
    tool?.files ?? null,
  );

  let modelsDir = null;
  if (opts.comfy) {
    const comfy = path.resolve(opts.comfy);
    if (!fs.existsSync(comfy) || !fs.statSync(comfy).isDirectory())
      throw new Error(`--comfy ${comfy} is not a directory`);
    modelsDir = path.join(comfy, "models");
  }
  const status = checkDisk(plan, modelsDir);
  const free = modelsDir ? freeBytes(modelsDir) : null;
  console.log(formatPlan(plan, status, { modelsDir, free }));

  if (!opts.yes) {
    console.log(
      "Dry run: nothing downloaded. Add --comfy <ComfyUI dir> --yes to download.",
    );
    return 0;
  }
  const need = totals(status).need;
  if (free !== null && need > free) {
    console.error(`Not enough free space: need ${gb(need)}, have ${gb(free)}.`);
    return 1;
  }
  const useHf = !opts.noHf && hasHf();
  console.log(`Downloading with ${useHf ? "the hf CLI" : "https"}...`);
  const { ok, fail } = await download(status, modelsDir, useHf);
  console.log(
    `Done: ${ok} downloaded, ${fail} failed${fail ? " (re-run to resume)" : ""}.`,
  );
  if (plan.convert.length)
    console.log(
      "Remember the convert step listed above; those files are not downloaded by this script.",
    );
  return fail ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`fetch-models: ${e.message}`);
      console.error("Run with --help for usage.");
      process.exit(2);
    },
  );
}
