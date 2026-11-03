/**
 * Which model files the connected ComfyUI has, per folder type, for the
 * first-run wizard's "already installed" marks. Mirrors the listing logic of
 * /api/tools/setup (ComfyUI GET /models/<type>, disk fallback for folders
 * ComfyUI doesn't register).
 * TODO(merge): the setup route can switch to this helper.
 *
 * Server-side only.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { env } from "@/lib/env";
import { normalizeListing } from "@/lib/tools/setupRequirements";
import { listModelFiles } from "@/lib/tools/editTools";
import { isLoopbackHost } from "@/lib/onboarding/comfyUrl";
import { comfyModelsDir, comfyModelsPath } from "@/lib/paths/resolveDirs";

const TYPE_RE = /^[\w.-]+$/;

/**
 * Folder types ComfyUI treats as one (legacy name -> current name). Both
 * names list the same files, so they are fetched once and merged on disk.
 */
const FOLDER_ALIASES: Record<string, string> = {
  unet: "diffusion_models",
  clip: "text_encoders",
};

/** The current folder name for a type ("unet" -> "diffusion_models"). */
export function canonicalFolder(type: string): string {
  return FOLDER_ALIASES[type] ?? type;
}

/** The canonical folder first, then its legacy names. */
function folderNames(type: string): string[] {
  const canon = canonicalFolder(type);
  return [
    canon,
    ...Object.keys(FOLDER_ALIASES).filter((k) => FOLDER_ALIASES[k] === canon),
  ];
}

/**
 * Collapse a raw listing to one entry per file: "\\" -> "/", "./" and doubled
 * slashes dropped, lower-cased (the form normalizeListing uses), sorted so the
 * order never depends on which folder or extra_model_paths root answered
 * first. Pure.
 */
export function dedupeListing(names: Iterable<string>): Set<string> {
  const cleaned = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    const c = n
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, "");
    if (c) cleaned.add(c);
  }
  return new Set(
    [...normalizeListing(cleaned)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

async function remoteListing(type: string): Promise<Set<string> | null> {
  // Older ComfyUI only knows the legacy name: try the names in order, but
  // only past a 404 (an unreachable ComfyUI must not cost one timeout per name).
  for (const name of folderNames(type)) {
    const got = await remoteListingOne(name);
    if (got !== "missing") return got;
  }
  return null;
}

async function remoteListingOne(
  type: string,
): Promise<Set<string> | null | "missing"> {
  try {
    const res = await comfyFetch(`/models/${encodeURIComponent(type)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return "missing";
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body)
      ? dedupeListing(body.filter((n): n is string => typeof n === "string"))
      : null;
  } catch {
    return null;
  }
}

/** The disk only describes the ComfyUI we talk to when that one is local. */
function comfyIsLocal(): boolean {
  try {
    return isLoopbackHost(new URL(env.COMFY_HTTP_URL).hostname);
  } catch {
    return false;
  }
}

async function diskListing(type: string): Promise<Set<string> | null> {
  if (!comfyIsLocal()) return null;
  // models/unet and models/diffusion_models both hold diffusion models.
  const found: string[] = [];
  let anyDir = false;
  for (const name of folderNames(type)) {
    const dir = comfyModelsPath(env.COMFY_ROOT, name);
    try {
      if (!(await fsp.stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    anyDir = true;
    found.push(...(await listModelFiles(env.COMFY_ROOT, name)));
  }
  if (anyDir) return dedupeListing(found);
  return fs.existsSync(comfyModelsDir(env.COMFY_ROOT)) ? new Set() : null;
}

export async function modelListing(type: string): Promise<Set<string> | null> {
  if (!TYPE_RE.test(type)) return null;
  return (await remoteListing(type)) ?? diskListing(type);
}

/** Listings for several folder types at once (missing / failed = null). */
export async function modelListings(
  types: Iterable<string>,
): Promise<Record<string, Set<string> | null>> {
  const uniq = [...new Set(types)];
  // Aliases ("unet" + "diffusion_models") share one fetch and one Set.
  const canon = [...new Set(uniq.map(canonicalFolder))];
  const sets = await Promise.all(canon.map((t) => modelListing(t)));
  const byCanon = new Map(canon.map((t, i) => [t, sets[i]]));
  return Object.fromEntries(
    uniq.map((t) => [t, byCanon.get(canonicalFolder(t)) ?? null]),
  );
}
