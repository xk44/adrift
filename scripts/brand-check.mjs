#!/usr/bin/env node
// Brand gate for a public Adrift export.
//
//   node scripts/brand-check.mjs <dir> [--fix-paths]
//
// Scans every text file under <dir> (file contents and relative paths) for a
// disallowed product name in any spelling (see OLD) and exits 1 on a hit.
// Lines carrying the marker `legacy-name` are allowed: compat code that still
// reads an older storage key, directory or event name.
//
// --fix-paths first rewrites references to the source tree's app directory
// (see DIR) into repo-root-relative forms, since the export places the app at
// the repository root.
//
// The pattern is assembled from parts so this file passes its own scan.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OLD = "comfy[\\s_-]?journey";
export const LEGACY_NAME_RE = new RegExp(OLD, "gi");
export const ALLOW_MARKER = "legacy-name";
// The app directory in the source tree (assembled so this file passes its own scan).
const DIR = ["comfy", "journey"].join("-");

/** Ordered rewrites for references to the flattened app directory. */
export const PATH_REWRITES = [
  // clone-then-cd instructions: `cd adrift/<dir>` (POSIX or Windows)
  [new RegExp(`(\\badrift)[\\\\/]${DIR}\\b`, "g"), "$1"],
  [new RegExp(`/path/to/${DIR}\\b`, "g"), "/path/to/adrift"],
  [new RegExp(`\\bcd ${DIR}\\b`, "g"), "cd adrift"],
  // "(`<dir>/`, which contains ...)" and "the <dir>/ directory"
  [new RegExp("`" + DIR + "/`", "g"), "the repository root"],
  [new RegExp(`the ${DIR}/ directory`, "g"), "the repository root"],
  [new RegExp(`the ${DIR} (root|source)\\b`, "g"), "the repository $1"],
  // repo links into the app dir: `/blob/main/<dir>/README.md` -> `/blob/main/README.md`
  [new RegExp(`/(blob|tree)/main/${DIR}/`, "g"), "/$1/main/"],
  // `<dir>/some/path` -> `some/path`
  [new RegExp(`(^|[\\s\`'"(])${DIR}/(?=[\\w.])`, "gm"), "$1"],
];

/** Apply PATH_REWRITES; returns the rewritten text. */
export function rewritePathRefs(text) {
  let out = text;
  for (const [re, rep] of PATH_REWRITES) out = out.replace(re, rep);
  return out;
}

/** Find old-name hits in a text. Returns [{ line, column, match, text }]. */
export function findLegacyNames(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    LEGACY_NAME_RE.lastIndex = 0;
    let m;
    while ((m = LEGACY_NAME_RE.exec(line)) !== null) {
      hits.push({
        line: i + 1,
        column: m.index + 1,
        match: m[0],
        text: line.trim(),
      });
    }
  }
  return hits;
}

/** True when a relative path itself contains the disallowed name. */
export function pathHasLegacyName(relPath) {
  LEGACY_NAME_RE.lastIndex = 0;
  return LEGACY_NAME_RE.test(relPath);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".next-build"]);

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".next")) continue;
      yield* walk(join(dir, ent.name));
    } else if (ent.isFile()) {
      yield join(dir, ent.name);
    }
  }
}

/** Scan a tree. Returns { files, rewritten, hits: [{ file, line, ... }] }. */
export function scanTree(root, { fixPaths = false } = {}) {
  const hits = [];
  let files = 0;
  let rewritten = 0;
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join("/");
    files++;
    if (pathHasLegacyName(rel))
      hits.push({ file: rel, line: 0, column: 0, match: "(path)", text: rel });
    if (statSync(abs).size > 16 * 1024 * 1024) continue;
    const buf = readFileSync(abs);
    if (!isProbablyText(buf)) continue;
    let text = buf.toString("utf8");
    if (fixPaths) {
      const next = rewritePathRefs(text);
      if (next !== text) {
        writeFileSync(abs, next);
        text = next;
        rewritten++;
      }
    }
    for (const h of findLegacyNames(text)) hits.push({ file: rel, ...h });
  }
  return { files, rewritten, hits };
}

function main(argv) {
  const args = argv.slice(2);
  const fixPaths = args.includes("--fix-paths");
  const dirs = args.filter((a) => !a.startsWith("--"));
  if (dirs.length !== 1) {
    console.error("usage: brand-check.mjs <dir> [--fix-paths]");
    return 2;
  }
  const { files, rewritten, hits } = scanTree(dirs[0], { fixPaths });
  if (fixPaths)
    console.log(`brand: rewrote app-dir path refs in ${rewritten} file(s)`);
  if (hits.length === 0) {
    console.log(`brand: CLEAN (${files} files, no legacy product name)`);
    return 0;
  }
  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  console.error(
    `brand: ${hits.length} legacy-name hit(s) in ${byFile.size} file(s):`,
  );
  for (const h of hits.slice(0, 200)) {
    console.error(`  ${h.file}:${h.line}: ${h.text.slice(0, 160)}`);
  }
  if (hits.length > 200) console.error(`  ... ${hits.length - 200} more`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv);
}
