/**
 * Download progress for the starter packs the user picked, read on the
 * server so it works wherever ComfyUI runs (this computer, the LAN, or over
 * the internet with a token): the browser only ever talks to Adrift.
 *
 * Source of truth is ComfyUI's own model listing (GET /models/<folder>), so a
 * file counts as done once ComfyUI can load it. When ComfyUI is on this
 * computer the half-written `<dest>.part` file from fetch-models.mjs adds live
 * byte counts; for a remote ComfyUI only whole files can be seen, and the
 * snapshot says so (`bytesKnown: false`) instead of faking a bar.
 *
 * Server-side only. Read-only: never starts a download.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";
import { modelListings } from "@/lib/tools/modelListing";
import { isLoopbackHost } from "@/lib/onboarding/comfyUrl";
import {
  STARTER_PACKS,
  folderOf,
  resolveAllPacks,
  selectionDownload,
  slotOptions,
  type Listings,
  type ResolvedPack,
} from "@/lib/onboarding/starterPacks";
import { comfyModelsDir } from "@/lib/paths/resolveDirs";

export interface PackFileProgress {
  dest: string;
  bytes: number;
  /** In ComfyUI's listing. Null = couldn't check. */
  installed: boolean | null;
  /** Bytes on disk so far (local ComfyUI only); null = can't see. */
  received: number | null;
}

export interface PackProgress {
  at: number;
  /** ComfyUI answered the listing request. */
  connected: boolean;
  /** Partial bytes are visible (ComfyUI is on this computer). */
  bytesKnown: boolean;
  files: PackFileProgress[];
  doneFiles: number;
  totalFiles: number;
  /** Installed bytes + partial bytes seen so far. */
  doneBytes: number;
  totalBytes: number;
  complete: boolean;
}

const MAX_IDS = 32;

/** "a,b" -> known pack ids (deduped, in pack order); null when none are known. */
export function parsePackIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const want = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_IDS),
  );
  const ids = STARTER_PACKS.packs.map((p) => p.id).filter((id) => want.has(id));
  return ids.length ? ids : null;
}

/** Pure: roll per-file state up into a snapshot. */
export function summarizeProgress(
  files: PackFileProgress[],
  connected: boolean,
  bytesKnown: boolean,
  at = Date.now(),
): PackProgress {
  let doneFiles = 0;
  let doneBytes = 0;
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += f.bytes;
    if (f.installed === true) {
      doneFiles++;
      doneBytes += f.bytes;
    } else if (f.received != null) {
      doneBytes += Math.min(f.received, f.bytes);
    }
  }
  return {
    at,
    connected,
    bytesKnown,
    files,
    doneFiles,
    totalFiles: files.length,
    doneBytes,
    totalBytes,
    complete: connected && files.length > 0 && doneFiles === files.length,
  };
}

/** Files the chosen packs' fetch command downloads (each once, in pack
 *  order; shared and optional files as `selectionDownload` picks them). */
export function chosenFiles(
  packs: ResolvedPack[],
  ids: string[],
): { dest: string; bytes: number; installed: boolean | null }[] {
  return selectionDownload(packs.filter((p) => ids.includes(p.id))).files.map(
    ({ dest, bytes, installed }) => ({ dest, bytes, installed }),
  );
}

export interface ProgressDeps {
  profile: () => Promise<BackendProfile | null>;
  listings: (folders: Set<string>) => Promise<Listings | null>;
  /** Size of the half-written file for a dest; null = not visible. */
  partialBytes: ((dest: string) => number | null) | null;
}

async function liveProfile(): Promise<BackendProfile | null> {
  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return profileFromSystemStats(await res.json());
  } catch {
    return null;
  }
}

async function liveListings(folders: Set<string>): Promise<Listings | null> {
  const raw = await modelListings(folders);
  return Object.values(raw).some(Boolean) ? raw : null;
}

/** `<COMFY_ROOT>/models/<dest>.part` sizes, only when ComfyUI is local. */
function localPartialBytes(): ((dest: string) => number | null) | null {
  try {
    if (!isLoopbackHost(new URL(env.COMFY_HTTP_URL).hostname)) return null;
  } catch {
    return null;
  }
  const models = path.resolve(comfyModelsDir(env.COMFY_ROOT));
  if (!fs.existsSync(models)) return null;
  return (dest) => {
    const p = path.resolve(models, `${dest}.part`);
    if (!p.startsWith(models + path.sep)) return null;
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
}

export function liveDeps(): ProgressDeps {
  return {
    profile: liveProfile,
    listings: liveListings,
    partialBytes: localPartialBytes(),
  };
}

/** One snapshot for the given pack ids. Never throws. */
export async function readPackProgress(
  ids: string[],
  deps: ProgressDeps = liveDeps(),
): Promise<PackProgress> {
  const folders = new Set<string>();
  for (const p of STARTER_PACKS.packs)
    if (ids.includes(p.id))
      for (const slot of p.files)
        for (const o of slotOptions(slot)) folders.add(folderOf(o.dest));
  let profile: BackendProfile | null = null;
  let listings: Listings | null = null;
  try {
    [profile, listings] = await Promise.all([
      deps.profile(),
      deps.listings(folders),
    ]);
  } catch {
    /* treated as not connected */
  }
  const files = chosenFiles(resolveAllPacks(profile, listings), ids).map(
    (f) => ({
      ...f,
      received:
        f.installed === true
          ? f.bytes
          : deps.partialBytes
            ? deps.partialBytes(f.dest)
            : null,
    }),
  );
  return summarizeProgress(files, !!listings, !!deps.partialBytes);
}

/** Whether two snapshots differ in anything the UI shows. */
export function progressChanged(
  a: PackProgress | null,
  b: PackProgress,
): boolean {
  if (!a) return true;
  return (
    a.connected !== b.connected ||
    a.doneFiles !== b.doneFiles ||
    a.doneBytes !== b.doneBytes ||
    a.totalFiles !== b.totalFiles ||
    a.complete !== b.complete
  );
}
