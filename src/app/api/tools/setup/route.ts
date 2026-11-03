/**
 * GET /api/tools/setup?key=<card key>[&id=<card id>]
 * What one Tools-page card needs installed: every weight file (folder under
 * ComfyUI/models/, size, license, source, download command) and node class
 * its graphs use, resolved by src/lib/tools/setupRequirements.ts.
 *   -> { ok, setup: { key, anyOf, options: [{ ...SetupOption,
 *          backend, files: [{ ...SetupFile, status }],
 *          missingNodes: string[] | null, missingOptionalNodes: string[] | null,
 *          nodeSources: { [class]: dir } }] } }
 * Presence is read-only: GET /models/<type> on the backend the option's
 * graphs route to (falls back to listing COMFY_ROOT/models/<type> on the
 * default host), and the backend's cached /object_info for node classes
 * (null = unreachable, not judged). `nodeSources` maps a missing class to the
 * repo-shipped comfy_nodes/<dir> that provides it.
 * Also: `comfyRoot` (absolute COMFY_ROOT), `fetchCommand` (one
 * scripts/fetch-models.mjs call for the whole tool; null when the tool map
 * has no entry) and, per file, `revision` (the download-list pin; the hf
 * command carries `--revision`). See src/lib/tools/setupCommands.ts.
 * `canDownload` / `downloadNote`: whether POST /api/tools/setup/download can
 * fetch files here; per file, `dest` is set when that file is one-click
 * downloadable (see src/lib/tools/setupDownload.ts). `sharedWith`: how many
 * other cards load the same file (docs/models-by-tool.json).
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  DEFAULT_BACKEND,
  backendUrl,
  routeBackend,
  type BackendId,
} from "@/lib/comfy/backends";
import { listModelFiles } from "@/lib/tools/editTools";
import { loadSetupWorkflow as loadWorkflow } from "@/lib/tools/setupWorkflows";
import {
  downloadSupport,
  downloadableDests,
  setupFileDest,
} from "@/lib/tools/setupDownload";
import { comfyIsLocalMachine } from "@/lib/paths/resolveDirs";
import {
  fileStatus,
  normalizeListing,
  resolveToolSetup,
} from "@/lib/tools/setupRequirements";
import {
  fetchModelsCommand,
  fetchToolArg,
  pinHfCommand,
  revisionFor,
  revisionIndex,
  rowsFromDownloadListJson,
  rowsFromDownloadListTsv,
  sharedToolCounts,
  type RevisionIndex,
} from "@/lib/tools/setupCommands";
import { comfyModelsDir, comfyModelsPath } from "@/lib/paths/resolveDirs";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

const TYPE_RE = /^[\w.-]+$/;

/** Files ComfyUI lists for one models/<type>, or null when it can't say. */
async function remoteListing(
  baseUrl: string,
  type: string,
): Promise<Set<string> | null> {
  try {
    const res = await comfyFetch(`/models/${encodeURIComponent(type)}`, {
      baseUrl,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body)
      ? normalizeListing(body.filter((n): n is string => typeof n === "string"))
      : null;
  } catch {
    return null;
  }
}

async function diskListing(type: string): Promise<Set<string> | null> {
  const dir = comfyModelsPath(env.COMFY_ROOT, type);
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return null;
  } catch {
    // The models root exists but this folder doesn't: nothing installed.
    return fs.existsSync(comfyModelsDir(env.COMFY_ROOT))
      ? new Set()
      : null;
  }
  return normalizeListing(await listModelFiles(env.COMFY_ROOT, type));
}

async function listing(
  backend: BackendId,
  type: string,
): Promise<Set<string> | null> {
  if (!TYPE_RE.test(type)) return null;
  const remote = await remoteListing(backendUrl(backend), type);
  // Folders ComfyUI doesn't register (tts/, stt/) 404 there: read the disk.
  if (remote) return remote;
  return backend === "default" ? diskListing(type) : null;
}

let nodeDirCache: Map<string, string> | null = null;

/** Node class -> comfy_nodes/<dir> for the custom nodes shipped in this repo. */
async function repoNodeDirs(): Promise<Map<string, string>> {
  if (nodeDirCache) return nodeDirCache;
  const out = new Map<string, string>();
  const root = path.join(process.cwd(), "comfy_nodes");
  const scan = async (dir: string, owner: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith(".")) {
        await scan(p, owner, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".py")) {
        const text = await fsp.readFile(p, "utf8").catch(() => "");
        const re = /NODE_CLASS_MAPPINGS\s*=\s*\{([^}]*)\}/g;
        for (const m of text.matchAll(re)) {
          for (const k of m[1].matchAll(/["']([\w.-]+)["']\s*:/g))
            if (!out.has(k[1])) out.set(k[1], owner);
        }
      }
    }
  };
  try {
    for (const e of await fsp.readdir(root, { withFileTypes: true }))
      if (e.isDirectory()) await scan(path.join(root, e.name), e.name, 0);
  } catch {
    /* no comfy_nodes dir in this build */
  }
  nodeDirCache = out;
  return out;
}

let revisionCache: RevisionIndex | null = null;

/**
 * Pinned revisions by destination: models/download-list.json when present,
 * else the source download_list.tsv it is generated from.
 */
async function revisions(): Promise<RevisionIndex> {
  if (revisionCache) return revisionCache;
  const read = (p: string) => fsp.readFile(p, "utf8").catch(() => null);
  const json = await read(
    path.join(process.cwd(), "models", "download-list.json"),
  );
  let rows = [] as ReturnType<typeof rowsFromDownloadListTsv>;
  if (json) {
    try {
      rows = rowsFromDownloadListJson(JSON.parse(json));
    } catch {
      rows = [];
    }
  } else {
    const tsv = await read(
      path.join(process.cwd(), "..", "private", "contest", "download_list.tsv"),
    );
    if (tsv) rows = rowsFromDownloadListTsv(tsv);
  }
  revisionCache = revisionIndex(rows);
  return revisionCache;
}

let toolMapCache: unknown = undefined;

async function toolMap(): Promise<unknown> {
  if (toolMapCache !== undefined) return toolMapCache;
  try {
    toolMapCache = JSON.parse(
      await fsp.readFile(
        path.join(process.cwd(), "docs", "models-by-tool.json"),
        "utf8",
      ),
    );
  } catch {
    toolMapCache = null;
  }
  return toolMapCache;
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const key = req.nextUrl.searchParams.get("key") ?? "";
  const id = req.nextUrl.searchParams.get("id") ?? undefined;
  const setup = key ? resolveToolSetup(key, loadWorkflow, id) : null;
  if (!setup)
    return NextResponse.json(
      { ok: false, error: "no setup info for this tool" },
      { status: 404, headers: CORS_HEADERS },
    );

  const listings = new Map<string, Promise<Set<string> | null>>();
  const list = (backend: BackendId, type: string) => {
    const k = `${backend}:${type}`;
    if (!listings.has(k)) listings.set(k, listing(backend, type));
    return listings.get(k)!;
  };
  const nodeDirs = await repoNodeDirs();
  const revs = await revisions();
  const comfyRoot = path.resolve(env.COMFY_ROOT);
  const map = await toolMap();
  const toolArg = fetchToolArg(map, setup.key);
  const shared = sharedToolCounts(map, setup.key);
  const fetchCommand = toolArg ? fetchModelsCommand(toolArg, comfyRoot) : null;
  const support = downloadSupport({ comfyLocal: comfyIsLocalMachine(), comfyRoot });
  const listed = support.ok ? downloadableDests() : null;

  const options = await Promise.all(
    setup.options.map(async (opt) => {
      // The first workflow routed off the main backend decides the host.
      const backend: BackendId =
        opt.workflows
          .map((rel) => routeBackend({ workflowPath: rel }))
          .find((id) => id !== DEFAULT_BACKEND) ?? DEFAULT_BACKEND;
      const files = await Promise.all(
        opt.files.map(async (f) => {
          const revision = f.command ? revisionFor(revs, f) : null;
          const dest = setupFileDest(f);
          return {
            ...f,
            command: f.command ? pinHfCommand(f.command, revision) : null,
            revision,
            status: fileStatus(f, f.type ? await list(backend, f.type) : null),
            // One-click download: listed in the pinned download list, not gated.
            dest: dest && !f.gated && listed?.has(dest) ? dest : null,
            sharedWith: dest ? (shared.get(dest) ?? 0) : 0,
          };
        }),
      );
      const info = await getObjectInfoCached(backendUrl(backend)).catch(
        () => null,
      );
      const missingNodes = info
        ? opt.nodeClasses.filter((c) => !(c in info))
        : null;
      const missingOptionalNodes = info
        ? opt.optionalNodeClasses.filter((c) => !(c in info))
        : null;
      const nodeSources: Record<string, string> = {};
      for (const c of [...(missingNodes ?? []), ...(missingOptionalNodes ?? [])]) {
        const dir = nodeDirs.get(c);
        if (dir) nodeSources[c] = dir;
      }
      return {
        ...opt,
        backend,
        files,
        missingNodes,
        missingOptionalNodes,
        nodeSources,
      };
    }),
  );

  return NextResponse.json(
    {
      ok: true,
      setup: { ...setup, options },
      comfyRoot,
      fetchCommand,
      canDownload: support.ok,
      downloadNote: support.ok ? null : support.reason,
    },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
  );
}
