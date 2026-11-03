#!/usr/bin/env node
/**
 * Refresh the ComfyUI API contract fixtures used by
 * src/__tests__/comfyContract*.test.ts.
 *
 * READ-ONLY: issues GET requests only (never /prompt, /interrupt, /free, ...).
 *
 *   node scripts/record-comfy-fixtures.mjs [--base http://127.0.0.1:8188]
 *
 * Writes src/__tests__/fixtures/comfy-contract/*.json:
 *   meta.json          ComfyUI version, record time, node classes kept
 *   object_info.json   /object_info trimmed to node classes Adrift's packs use
 *   system_stats.json  /system_stats (home dir redacted)
 *   queue.json         /queue
 *   history.json       /history?max_items=5 (extra_pnginfo stripped)
 *   features.json      /api/features (null when the endpoint is missing)
 *   embeddings.json    /embeddings
 *
 * The WebSocket replay fixture (ws_sequence.json) is hand-built from the
 * protocol in ComfyUI's server.py / execution.py / comfy_execution/progress.py
 * — recording it would require running a prompt, which this script never does.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(APP_DIR, "src/__tests__/fixtures/comfy-contract");
const UA = "OpenAI File Downloader, XaiImageApiFetch/1.0";

const baseArg = process.argv.indexOf("--base");
const BASE = (
  baseArg > 0
    ? process.argv[baseArg + 1]
    : process.env.COMFY_HTTP_URL || "http://127.0.0.1:8188"
).replace(/\/$/, "");

/** Output/preview nodes whose ui payload shapes the output contract tests cover. */
const ALWAYS_KEEP = [
  "SaveImage",
  "PreviewImage",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "SaveVideo",
  "SaveWEBM",
  "CreateVideo",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "PreviewAudio",
  "SaveGLB",
  "Preview3D",
  "PreviewAny",
  "SaveLatent",
  "VHS_VideoCombine",
  // Core nodes the engine injects at runtime (not present in any pack file):
  // --region regional prompting (src/lib/oj/regionalPrompt.ts).
  "ConditioningSetAreaPercentage",
  "ConditioningCombine",
  // --region on 5-D-latent families (Krea2): rect masks instead of areas.
  "SolidMask",
  "MaskComposite",
  "ConditioningSetMask",
  "MaskToImage",
  "ImageBlur",
  "ImageToMask",
  "ConditioningSetTimestepRange",
];

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** class_type from API-format graphs and `type` from UI-format graphs. */
function collectPackNodeClasses() {
  const classes = new Set(ALWAYS_KEEP);
  for (const file of walk(join(APP_DIR, "public/workflows"))) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (typeof value.class_type === "string") classes.add(value.class_type);
      if (
        typeof value.type === "string" &&
        "inputs" in value &&
        "id" in value
      ) {
        classes.add(value.type);
      }
      Object.values(value).forEach(visit);
    };
    visit(json);
  }
  return classes;
}

const HOME = homedir();
const USER = HOME.split("/").pop();
function redact(value) {
  if (typeof value === "string") {
    let s = value.split(HOME).join("~");
    if (USER && USER.length > 2) s = s.split(`/${USER}/`).join("/<user>/");
    return s;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

function write(name, data) {
  writeFileSync(
    join(OUT_DIR, name),
    JSON.stringify(redact(data), null, 2) + "\n",
  );
  console.log(`wrote ${name}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const stats = await getJson("/system_stats");
  if (!stats.body)
    throw new Error(
      `ComfyUI not reachable at ${BASE} (/system_stats ${stats.status})`,
    );
  const version = stats.body.system?.comfyui_version ?? "unknown";

  const wanted = collectPackNodeClasses();
  const objectInfo = await getJson("/object_info");
  const trimmed = {};
  const missing = [];
  for (const cls of [...wanted].sort()) {
    if (objectInfo.body?.[cls]) trimmed[cls] = objectInfo.body[cls];
    else missing.push(cls);
  }

  const history = await getJson("/history?max_items=5");
  const historyBody = Object.fromEntries(
    Object.entries(history.body ?? {}).map(([id, entry]) => {
      const prompt = Array.isArray(entry.prompt)
        ? [...entry.prompt]
        : entry.prompt;
      if (Array.isArray(prompt) && prompt[3] && typeof prompt[3] === "object") {
        const { extra_pnginfo: _drop, ...extra } = prompt[3];
        prompt[3] = extra;
      }
      return [id, { ...entry, prompt }];
    }),
  );

  const features = await getJson("/api/features");

  write("meta.json", {
    comfyui_version: version,
    recorded_at: new Date().toISOString(),
    base_url: BASE,
    endpoints: {
      "/api/features": features.status,
      "/object_info": objectInfo.status,
    },
    node_classes_kept: Object.keys(trimmed),
    node_classes_not_installed: missing,
  });
  write("object_info.json", trimmed);
  write("system_stats.json", stats.body);
  write("queue.json", (await getJson("/queue")).body);
  write("history.json", historyBody);
  write("features.json", features.body);
  write("embeddings.json", (await getJson("/embeddings")).body);
  console.log(
    `ComfyUI ${version}: kept ${Object.keys(trimmed).length} node classes, ${missing.length} not installed`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
