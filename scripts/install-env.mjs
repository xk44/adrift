#!/usr/bin/env node
/**
 * Write the installer's keys into .env.local (used by install.sh / install.ps1).
 *
 *   node scripts/install-env.mjs [--dry-run] [--file PATH] [--example PATH] KEY=VALUE ...
 *
 * - No .env.local yet: it is created from .env.example. The example's active
 *   COMFY_HTTP_URL / NEXT_PUBLIC_COMFY_WS_BASE lines are commented out (their
 *   values are the built-in defaults anyway) unless they are being set here,
 *   so the setup wizard can still save a ComfyUI connection: an env-pinned
 *   URL locks it.
 * - Only the KEYs given are touched: an active `KEY=` line is replaced in
 *   place (later duplicates are dropped), else a commented `# KEY=` sample is
 *   filled in, else the line is appended. Every other line stays as it is.
 * - An existing file that changes is first copied to .env.local.bak.
 * - Nothing is written when the result is identical (safe to re-run), or
 *   with --dry-run (the planned changes are printed instead).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNPIN_ON_CREATE = ["COMFY_HTTP_URL", "NEXT_PUBLIC_COMFY_WS_BASE"];

let dryRun = false;
let file = path.join(appDir, ".env.local");
let example = path.join(appDir, ".env.example");
const sets = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--file") file = path.resolve(argv[++i] ?? "");
  else if (a === "--example") example = path.resolve(argv[++i] ?? "");
  else {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
    if (!m) {
      console.error(`install-env: expected KEY=VALUE, got "${a}"`);
      process.exit(2);
    }
    if (/[\r\n]/.test(m[2])) {
      console.error(`install-env: ${m[1]} must be a single line`);
      process.exit(2);
    }
    sets.push([m[1], m[2]]);
  }
}

const name = path.basename(file);
const existed = existsSync(file);
const before = existed ? readFileSync(file, "utf8") : null;
const eol = before && before.includes("\r\n") ? "\r\n" : "\n";
let lines = (
  before ?? (existsSync(example) ? readFileSync(example, "utf8") : "")
).split(/\r?\n/);
if (lines.length && lines[lines.length - 1] === "") lines.pop();

const keyOf = (line) =>
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
const sampleKeyOf = (line) =>
  /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
const setKeys = new Set(sets.map(([k]) => k));

if (!existed) {
  lines = lines.map((line) => {
    const k = keyOf(line);
    return k && UNPIN_ON_CREATE.includes(k) && !setKeys.has(k)
      ? `# ${line.trim()}`
      : line;
  });
}

const notes = [];
for (const [key, value] of sets) {
  const wanted = `${key}=${value}`;
  const active = [];
  lines.forEach((line, i) => keyOf(line) === key && active.push(i));
  if (active.length) {
    if (lines[active[0]] !== wanted || active.length > 1)
      notes.push(`set ${wanted}`);
    lines[active[0]] = wanted;
    for (const i of active.slice(1).reverse()) lines.splice(i, 1);
    continue;
  }
  const sample = lines.findIndex((line) => sampleKeyOf(line) === key);
  if (sample >= 0) lines[sample] = wanted;
  else lines.push(wanted);
  notes.push(`set ${wanted}`);
}

const after = lines.join(eol) + eol;
if (existed && after === before) {
  console.log(`✓ ${name} already up to date`);
  process.exit(0);
}

const verb = dryRun ? "would " : "";
if (!existed)
  console.log(`  ${verb}create ${name} from ${path.basename(example)}`);
else console.log(`  ${verb}back up ${name} to ${name}.bak`);
for (const n of notes) console.log(`  ${verb}${n}`);
if (dryRun) process.exit(0);

if (existed) copyFileSync(file, `${file}.bak`);
writeFileSync(file, after);
console.log(`✓ ${name} ${existed ? "updated" : "created"}`);
