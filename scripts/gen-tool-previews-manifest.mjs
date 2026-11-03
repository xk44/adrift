#!/usr/bin/env node
// Build src/lib/tools/toolPreviews.json from the files in public/tool-previews/
// so ToolCover knows which tools have a preview without probing for 404s.
//
// Naming: one file per tool per format, named after the hub card key with
// ":" spelled "--" (colons are not portable in file names):
//
//   action:relight      -> public/tool-previews/action--relight.webp   (still)
//   app:figurine        -> public/tool-previews/app--figurine.mp4      (video)
//   special:storyboard  -> public/tool-previews/special--storyboard.webm
//
// A tool may ship a still, a video, or both; the still doubles as the video
// poster and as the reduced-motion fallback. Anything else in the folder
// (README, dotfiles, other formats) is ignored with a warning.
//
// Usage:
//   node scripts/gen-tool-previews-manifest.mjs [--dir d] [--out f] [--check]
//
//   --dir    preview folder (default public/tool-previews)
//   --out    manifest path (default src/lib/tools/toolPreviews.json)
//   --check  do not write; exit 1 if the manifest is out of date
//
// Exit codes: 0 ok, 1 stale manifest (--check), 2 usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STILL_EXTS = ["webp"];
/** Order is source preference: webm first (smaller), mp4 as the fallback. */
export const VIDEO_EXTS = ["webm", "mp4"];
/** Previews ship in the public repo; flag anything heavier than this. */
export const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Hub card key -> preview file stem. Mirrors toolPreviewSlug in toolPreviews.ts. */
export function toolPreviewSlug(key) {
  return String(key)
    .replace(/:/g, "--")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Pure: file names (no directories) -> { manifest, warnings }.
 * manifest = { previews: { [slug]: { still?: file, video?: file[] } } },
 * slugs and video sources in a stable order.
 */
export function buildToolPreviewsManifest(fileNames, sizes = {}) {
  const warnings = [];
  const bySlug = new Map();
  for (const name of [...fileNames].sort()) {
    if (name.startsWith(".") || /^readme(\.|$)/i.test(name)) continue;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const isStill = STILL_EXTS.includes(ext);
    const isVideo = VIDEO_EXTS.includes(ext);
    if (!isStill && !isVideo) {
      warnings.push(`${name}: unsupported format (use .webp, .webm or .mp4)`);
      continue;
    }
    if (!SLUG_RE.test(stem)) {
      warnings.push(`${name}: file name must be a card key with ":" as "--"`);
      continue;
    }
    const size = sizes[name];
    if (typeof size === "number" && size > MAX_PREVIEW_BYTES) {
      warnings.push(
        `${name}: ${(size / 1048576).toFixed(1)} MB, keep previews under ${MAX_PREVIEW_BYTES / 1048576} MB`,
      );
    }
    const entry = bySlug.get(stem) ?? {};
    if (isStill) {
      if (entry.still) warnings.push(`${name}: duplicate still for ${stem}`);
      else entry.still = name;
    } else {
      entry.video = [...(entry.video ?? []), name];
    }
    bySlug.set(stem, entry);
  }
  /** @type {Record<string, { still?: string, video?: string[] }>} */
  const previews = {};
  for (const slug of [...bySlug.keys()].sort()) {
    const e = bySlug.get(slug);
    const out = {};
    if (e.still) out.still = e.still;
    if (e.video) {
      const rank = (f) =>
        VIDEO_EXTS.indexOf(f.slice(f.lastIndexOf(".") + 1).toLowerCase());
      out.video = [...e.video].sort((a, b) => rank(a) - rank(b));
      if (!e.still) {
        warnings.push(
          `${slug}: video without ${slug}.webp; the card shows the gradient until it plays`,
        );
      }
    }
    previews[slug] = out;
  }
  return { manifest: { previews }, warnings };
}

export function renderManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** Files directly in `dir` with their sizes; a missing dir means no previews. */
export function listPreviewFiles(dir) {
  if (!fs.existsSync(dir))
    return { names: [], sizes: /** @type {Record<string, number>} */ ({}) };
  const names = [];
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    names.push(ent.name);
    sizes[ent.name] = fs.statSync(path.join(dir, ent.name)).size;
  }
  return { names, sizes };
}

function parseArgs(argv) {
  const opts = {
    dir: "public/tool-previews",
    out: "src/lib/tools/toolPreviews.json",
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: node scripts/gen-tool-previews-manifest.mjs [--dir d] [--out f] [--check]",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.dir || !opts.out) {
    console.error("--dir and --out need a value");
    process.exit(2);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(ROOT, opts.dir);
  const out = path.resolve(ROOT, opts.out);
  const { names, sizes } = listPreviewFiles(dir);
  const { manifest, warnings } = buildToolPreviewsManifest(names, sizes);
  for (const w of warnings) console.warn(`warning: ${w}`);
  const text = renderManifest(manifest);
  const count = Object.keys(manifest.previews).length;
  if (opts.check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    if (current !== text) {
      console.error(
        `${path.relative(ROOT, out)} is stale; run node scripts/gen-tool-previews-manifest.mjs`,
      );
      process.exit(1);
    }
    console.log(`ok: ${count} tool previews`);
    return;
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${path.relative(ROOT, out)}: ${count} tool previews`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
