#!/usr/bin/env node
/**
 * Render the golden graph fixtures (src/__tests__/golden/*.json) on a real
 * ComfyUI and record a perceptual-hash table of the outputs, so two renders
 * (before / after a change, or two machines) can be compared.
 *
 *   node scripts/golden-render.mjs --url http://127.0.0.1:8188 \
 *     --inputs ./golden-inputs [--out ./golden-out] [--only transition,music] \
 *     [--timeout 1800] [--compare ./golden-out-old/hashes.json] [--dry-run]
 *
 * --url is required: nothing is ever sent to a default address. --dry-run
 * lists what would be uploaded and queued and sends nothing.
 *
 * Inputs: the fixtures reference fixed upload names (golden_src.png,
 * golden_ref2.png ..., golden_clip.mp4, golden_audio.wav). Files with those
 * names in --inputs are uploaded to ComfyUI's input folder; missing PNGs are
 * generated (plain gradients), and a case whose clip or audio is missing is
 * skipped. Queues one graph at a time (POST /prompt, poll /history). Never
 * calls /interrupt or /free.
 *
 * Output: <out>/<case>/<files> and <out>/hashes.json:
 *   { "<case>": { status, prompt_id, seconds, outputs: [{ file, sha256, bytes, dhash? }] } }
 * dhash is a 64-bit difference hash (hex) for images; --compare prints the
 * Hamming distance per output against an older hashes.json.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = join(APP_DIR, "src/__tests__/golden");
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const INPUT_RE = /^(golden_[A-Za-z0-9_.-]+) \[input\]$/;

function parseArgs(argv) {
  const args = { out: "golden-out", timeout: 1800, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--url") args.url = next().replace(/\/+$/, "");
    else if (a === "--inputs") args.inputs = next();
    else if (a === "--out") args.out = next();
    else if (a === "--only")
      args.only = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--timeout") {
      args.timeout = Number(next());
      if (!(args.timeout > 0)) throw new Error("--timeout needs a positive number");
    }
    else if (a === "--compare") args.compare = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const USAGE =
  "Usage: node scripts/golden-render.mjs --url <comfyui-url> [--inputs dir] [--out dir]\n" +
  "       [--only case,case] [--timeout seconds] [--compare old/hashes.json] [--dry-run]";

function loadFixtures(only) {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      slug: basename(f, ".json"),
      ...JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")),
    }))
    .filter(
      (fx) =>
        fx.graph && (!only || only.includes(fx.slug) || only.includes(fx.name)),
    );
}

/** Golden graph -> API-format prompt. */
function toPrompt(graph) {
  const out = {};
  for (const [id, n] of Object.entries(graph))
    out[id] = {
      class_type: n.class_type,
      inputs: n.inputs,
      ...(n.title ? { _meta: { title: n.title } } : {}),
    };
  return out;
}

function inputNames(graph) {
  const names = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      const m = INPUT_RE.exec(v);
      if (m) names.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const n of Object.values(graph)) walk(n.inputs);
  return [...names];
}

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    return null;
  }
}

/** 1280x720 gradient PNG, a different hue per name. */
async function gradientPng(sharp, name) {
  const w = 1280;
  const h = 720;
  const hue =
    [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = Math.round((255 * x) / w);
      buf[i + 1] = Math.round((255 * y) / h);
      buf[i + 2] = hue % 256;
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

async function dhash(sharp, bytes) {
  const px = await sharp(bytes)
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

function hamming(a, b) {
  let v = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (v) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

async function http(url, init) {
  const res = await fetch(url, init);
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${url} -> ${res.status} ${await res.text().catch(() => "")}`,
    );
  return res;
}

async function upload(url, name, bytes) {
  const form = new FormData();
  form.append("image", new Blob([bytes]), name);
  form.append("type", "input");
  form.append("overwrite", "true");
  await http(`${url}/upload/image`, { method: "POST", body: form });
}

/** Every file a history entry lists (images, gifs/videos, audio, ...). */
function historyFiles(entry) {
  const files = [];
  for (const out of Object.values(entry.outputs ?? {}))
    for (const list of Object.values(out))
      if (Array.isArray(list))
        for (const f of list)
          if (f && typeof f === "object" && typeof f.filename === "string")
            files.push({
              filename: f.filename,
              subfolder: f.subfolder ?? "",
              type: f.type ?? "output",
            });
  return files;
}

async function waitFor(url, promptId, timeoutS) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const hist = await (await http(`${url}/history/${promptId}`)).json();
    const entry = hist[promptId];
    if (entry?.status?.completed || entry?.status?.status_str === "error")
      return entry;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out after ${timeoutS} s`);
}

function compare(table, oldFile) {
  const old = JSON.parse(readFileSync(oldFile, "utf8"));
  for (const [name, rec] of Object.entries(table)) {
    const prev = old[name];
    if (!prev) {
      console.log(`${name}: new`);
      continue;
    }
    if (rec.status !== prev.status)
      console.log(`${name}: status ${prev.status} -> ${rec.status}`);
    rec.outputs?.forEach((o, i) => {
      const p = prev.outputs?.[i];
      if (!p) console.log(`${name}: extra output ${o.file}`);
      else if (o.dhash && p.dhash)
        console.log(
          `${name}: ${o.file} distance ${hamming(o.dhash, p.dhash)}/64`,
        );
      else if (o.sha256 !== p.sha256)
        console.log(`${name}: ${o.file} bytes differ`);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const fixtures = loadFixtures(args.only);
  if (!fixtures.length) {
    console.error("No fixtures with a graph match --only.");
    process.exit(2);
  }
  const sharp = await loadSharp();
  const out = resolve(args.out);
  const files = {};
  for (const name of new Set(fixtures.flatMap((fx) => inputNames(fx.graph)))) {
    const given = args.inputs ? join(resolve(args.inputs), name) : null;
    if (given && existsSync(given)) files[name] = readFileSync(given);
    else if (IMAGE_RE.test(name) && sharp)
      files[name] = await gradientPng(sharp, name);
  }

  if (args.dryRun) {
    console.log(
      `Would upload: ${Object.keys(files).sort().join(", ") || "(nothing)"}`,
    );
    for (const fx of fixtures) {
      const missing = inputNames(fx.graph).filter((n) => !files[n]);
      console.log(
        `${fx.slug}: ${missing.length ? `skip (missing ${missing.join(", ")})` : "queue"}`,
      );
    }
    return;
  }

  for (const [name, bytes] of Object.entries(files))
    await upload(args.url, name, bytes);
  mkdirSync(out, { recursive: true });
  const table = {};
  const clientId = randomUUID();
  for (const fx of fixtures) {
    const missing = inputNames(fx.graph).filter((n) => !files[n]);
    if (missing.length) {
      table[fx.slug] = {
        status: "skipped",
        reason: `missing ${missing.join(", ")}`,
      };
      console.log(`${fx.slug}: skipped (missing ${missing.join(", ")})`);
      continue;
    }
    const started = Date.now();
    try {
      const queued = await (
        await http(`${args.url}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: toPrompt(fx.graph),
            client_id: clientId,
          }),
        })
      ).json();
      const entry = await waitFor(args.url, queued.prompt_id, args.timeout);
      const rec = {
        status: entry.status?.status_str === "error" ? "error" : "done",
        prompt_id: queued.prompt_id,
        seconds: Math.round((Date.now() - started) / 1000),
        outputs: [],
      };
      const dir = join(out, fx.slug);
      mkdirSync(dir, { recursive: true });
      const used = new Set();
      for (const f of historyFiles(entry)) {
        const q = new URLSearchParams(f).toString();
        const bytes = Buffer.from(
          await (await http(`${args.url}/view?${q}`)).arrayBuffer(),
        );
        // Server-supplied name: keep it inside <out>/<case>, never overwrite
        // an earlier output that shares the name (different subfolder).
        let file = basename(f.filename) || "output";
        for (let n = 2; used.has(file); n++)
          file = `${n}_${basename(f.filename) || "output"}`;
        used.add(file);
        writeFileSync(join(dir, file), bytes);
        rec.outputs.push({
          file,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...(sharp && IMAGE_RE.test(file)
            ? { dhash: await dhash(sharp, bytes) }
            : {}),
        });
      }
      table[fx.slug] = rec;
      console.log(
        `${fx.slug}: ${rec.status} in ${rec.seconds} s, ${rec.outputs.length} output(s)`,
      );
    } catch (e) {
      table[fx.slug] = {
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
      console.log(`${fx.slug}: failed (${table[fx.slug].error})`);
    }
    writeFileSync(
      join(out, "hashes.json"),
      `${JSON.stringify(table, null, 2)}\n`,
    );
  }
  // Again here: a run whose last (or every) case was skipped still lists it.
  writeFileSync(join(out, "hashes.json"), `${JSON.stringify(table, null, 2)}\n`);
  if (args.compare) compare(table, args.compare);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
