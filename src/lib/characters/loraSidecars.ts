/**
 * Read the metadata files other LoRA tools leave next to a LoRA:
 * - `<stem>.metadata.json`  (ComfyUI LoRA Manager: tags, base_model, civitai.trainedWords)
 * - `<stem>.civitai.info`   (Civitai Helper: the Civitai model-version JSON)
 * - `<stem>.json`           (A1111 user metadata: "activation text", "preferred weight", "sd version")
 * and spot a preview image (`<stem>.preview.png`, `<stem>.png`, …).
 *
 * Server-side only, and only for a ComfyUI on this machine (the files live
 * under COMFY_ROOT/models/loras). Every value is untrusted text: capped,
 * trimmed, rendered as text by the client.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isSafeLoraFilename } from "@/lib/loraMetadata";
import type { ServerLoraInfo } from "@/lib/characters/characterLoras";

const SIDECAR_SUFFIXES = [".metadata.json", ".civitai.info", ".json"];
export const PREVIEW_SUFFIXES = [
  ".preview.png",
  ".preview.jpg",
  ".preview.jpeg",
  ".preview.webp",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];
const MAX_SIDECAR_BYTES = 512 * 1024;
const MAX_TEXT = 120;
const MAX_LIST = 12;

export interface SidecarInfo {
  modelName: string | null;
  tags: string[];
  baseModel: string | null;
  triggers: string[];
  preferredWeight: number | null;
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return s || null;
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  for (const item of raw) {
    // Tags may be plain strings or { name } objects (Civitai model API).
    const s = text(
      item && typeof item === "object"
        ? (item as { name?: unknown }).name
        : item,
    );
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function weight(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 2 ? n : null;
}

/** Parse any of the three sidecar shapes; unknown shapes give empty info. */
export function parseLoraSidecar(raw: unknown): SidecarInfo {
  const o = obj(raw);
  const civ = obj(o.civitai); // LoRA Manager nests the Civitai version here
  const model = obj(o.model ?? civ.model); // Civitai version JSON
  const tags = [...list(o.tags), ...list(model.tags), ...list(civ.tags)];
  const triggers = [
    ...list(o.trainedWords),
    ...list(civ.trainedWords),
    ...list(o["activation text"]),
  ];
  // Civitai's model.type ("Character", "LORA", …) doubles as a category.
  const type = text(model.type)?.toLowerCase();
  if (type === "character" || text(o.category)?.toLowerCase() === "character")
    tags.push("character");
  return {
    modelName: text(o.model_name) ?? text(model.name),
    tags: tags.filter((t, i) => tags.indexOf(t) === i).slice(0, MAX_LIST),
    baseModel:
      text(o.base_model) ??
      text(o.baseModel) ??
      text(civ.baseModel) ??
      text(o["sd version"]),
    triggers: triggers.filter((t, i) => triggers.indexOf(t) === i).slice(0, 6),
    preferredWeight: weight(o["preferred weight"]),
  };
}

function stemOf(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Directory listing cache for one scan (names only, lower-cased lookup). */
async function dirNames(
  dir: string,
  cache: Map<string, Map<string, string> | null>,
): Promise<Map<string, string> | null> {
  if (cache.has(dir)) return cache.get(dir) ?? null;
  let names: Map<string, string> | null = null;
  try {
    const entries = await fs.readdir(dir);
    names = new Map(entries.map((n) => [n.toLowerCase(), n]));
  } catch {
    names = null;
  }
  cache.set(dir, names);
  return names;
}

/**
 * Absolute path of `<stem><suffix>` for a LoRA, or null. Rejects names that
 * could leave `lorasDir` (and anything that resolves outside it).
 */
async function findCompanion(
  lorasDir: string,
  filename: string,
  suffixes: readonly string[],
  cache: Map<string, Map<string, string> | null>,
): Promise<string | null> {
  if (!isSafeLoraFilename(filename)) return null;
  const full = path.resolve(lorasDir, stemOf(filename));
  if (!isInside(lorasDir, full)) return null;
  const dir = path.dirname(full);
  const names = await dirNames(dir, cache);
  if (!names) return null;
  const stem = path.basename(full).toLowerCase();
  for (const suf of suffixes) {
    const hit = names.get(stem + suf);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

async function readSidecar(p: string): Promise<SidecarInfo | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) return null;
    return parseLoraSidecar(JSON.parse(await fs.readFile(p, "utf8")));
  } catch {
    return null;
  }
}

/** Enrich a LoRA list with local sidecars + preview flags. Never throws. */
export async function readLoraSidecars(
  lorasDir: string,
  filenames: readonly string[],
  opts: { max?: number } = {},
): Promise<ServerLoraInfo[]> {
  const max = opts.max ?? 2000;
  const cache = new Map<string, Map<string, string> | null>();
  let root: string;
  try {
    root = await fs.realpath(lorasDir);
  } catch {
    return filenames.map((filename) => ({ filename }));
  }
  const out: ServerLoraInfo[] = [];
  for (const [i, filename] of filenames.entries()) {
    if (i >= max) {
      out.push({ filename });
      continue;
    }
    const sidecarPath = await findCompanion(
      root,
      filename,
      SIDECAR_SUFFIXES,
      cache,
    );
    const info = sidecarPath ? await readSidecar(sidecarPath) : null;
    const preview = await findCompanion(
      root,
      filename,
      PREVIEW_SUFFIXES,
      cache,
    );
    out.push({
      filename,
      ...(info
        ? {
            modelName: info.modelName,
            tags: info.tags,
            baseModel: info.baseModel,
            triggers: info.triggers,
            preferredWeight: info.preferredWeight,
          }
        : {}),
      hasPreview: Boolean(preview),
    });
  }
  return out;
}

const PREVIEW_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Preview file for one LoRA: path + content type, or null. */
export async function findLoraPreview(
  lorasDir: string,
  filename: string,
): Promise<{ path: string; contentType: string } | null> {
  let root: string;
  try {
    root = await fs.realpath(lorasDir);
  } catch {
    return null;
  }
  const p = await findCompanion(root, filename, PREVIEW_SUFFIXES, new Map());
  if (!p) return null;
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    return null;
  }
  // A symlinked preview must still live under the LoRA folder.
  if (!isInside(root, real)) return null;
  const type = PREVIEW_TYPES[path.extname(real).toLowerCase()];
  return type ? { path: real, contentType: type } : null;
}
