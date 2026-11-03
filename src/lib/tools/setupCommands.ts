/**
 * Commands the "Set up this tool" drawer offers.
 *
 * - The first command is one call to scripts/fetch-models.mjs for the whole
 *   tool (`--tool <id> --comfy <root> --yes`): it reads the pinned download
 *   list, checks sizes and never overwrites anything.
 * - The per-file `hf download` lines (setupRequirements.ts) are the "Manual"
 *   fallback. They are pinned to the same revision the download list uses,
 *   so a manual download gets byte-for-byte the file the script would.
 *
 * Pure: the route reads the files and passes their text in.
 */

/** One pinned Hugging Face file (a download-list row). */
export interface PinnedRow {
  repo: string;
  /** Path inside the repo. */
  path: string;
  /** Commit sha. */
  revision: string;
  /** Destination relative to ComfyUI/models/. */
  dest: string;
}

const SHA = /^[0-9a-f]{7,64}$/i;
const HF_REPO = /^[\w.-]+\/[\w.-]+$/;

function validRow(r: Partial<PinnedRow>): r is PinnedRow {
  return (
    typeof r.repo === "string" &&
    HF_REPO.test(r.repo) &&
    typeof r.path === "string" &&
    typeof r.dest === "string" &&
    typeof r.revision === "string" &&
    SHA.test(r.revision)
  );
}

/** Rows of models/download-list.json (public export); [] when malformed. */
export function rowsFromDownloadListJson(doc: unknown): PinnedRow[] {
  const files = (doc as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  const out: PinnedRow[] = [];
  for (const f of files as Array<Record<string, unknown>>) {
    const base = {
      repo: f?.repo as string,
      path: f?.path as string,
      revision: f?.revision as string,
    };
    const dests = [f?.dest, ...(Array.isArray(f?.also) ? f.also : [])];
    for (const dest of dests) {
      const row = { ...base, dest: dest as string };
      if (validRow(row)) out.push(row);
    }
  }
  return out;
}

/**
 * Rows of the private download_list.tsv the JSON is generated from
 * (columns: host, set, hf_repo, repo_file_path, revision_sha, size, dest).
 */
export function rowsFromDownloadListTsv(text: string): PinnedRow[] {
  const out: PinnedRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const c = line.split("\t");
    const row = { repo: c[2], path: c[3], revision: c[4], dest: c[6]?.trim() };
    if (validRow(row)) out.push(row);
  }
  return out;
}

export type RevisionIndex = Map<string, PinnedRow>;

export function revisionIndex(rows: PinnedRow[]): RevisionIndex {
  const m: RevisionIndex = new Map();
  for (const r of rows) if (!m.has(r.dest)) m.set(r.dest, r);
  return m;
}

/**
 * The revision to pin one setup file's download to: the download-list row
 * for its destination, only when it comes from the same repo. A by-name
 * model (whole folder) is pinned when every listed file under that folder
 * from the same repo shares one revision.
 */
export function revisionFor(
  index: RevisionIndex,
  file: {
    file: string;
    folder: string | null;
    source: string | null;
    byName?: boolean;
  },
): string | null {
  if (!file.source || file.folder === null) return null;
  const dir = file.folder.replace(/\/+$/, "");
  if (file.byName) {
    const revs = new Set<string>();
    for (const r of index.values())
      if (r.repo === file.source && r.dest.startsWith(`${dir}/`))
        revs.add(r.revision);
    return revs.size === 1 ? [...revs][0] : null;
  }
  const row = index.get(dir ? `${dir}/${file.file}` : file.file);
  return row && row.repo === file.source ? row.revision : null;
}

/** Add `--revision <sha>` to an `hf download` command (other commands pass through). */
export function pinHfCommand(command: string, revision: string | null): string {
  if (!revision || !SHA.test(revision)) return command;
  if (!command.startsWith("hf download ") || command.includes("--revision"))
    return command;
  const at = command.indexOf(" --local-dir ");
  if (at < 0) return command;
  return `${command.slice(0, at)} --revision ${revision}${command.slice(at)}`;
}

/** POSIX single-quote when needed. */
export function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ToolMapEntry {
  id: string;
  kind: string;
}

/**
 * The `--tool` argument fetch-models.mjs accepts for a Tools-page card key
 * ("action:upscale" -> "upscale"; "kind:id" only when the bare id is shared),
 * or null when the tool map has no entry (nothing for the script to fetch).
 */
export function fetchToolArg(toolMap: unknown, cardKey: string): string | null {
  const tools = (toolMap as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return null;
  const list = tools as ToolMapEntry[];
  const hit = list.find((t) => `${t?.kind}:${t?.id}` === cardKey);
  if (!hit) return null;
  const shared = list.filter((t) => t?.id === hit.id).length > 1;
  return shared ? `${hit.kind}:${hit.id}` : hit.id;
}

/**
 * models/ path -> how many other Tools-page cards load the same file, from
 * docs/models-by-tool.json. A shared file downloads once for all of them.
 */
export function sharedToolCounts(
  toolMap: unknown,
  cardKey: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const tools = (toolMap as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return out;
  for (const t of tools as (ToolMapEntry & { files?: unknown })[]) {
    if (`${t?.kind}:${t?.id}` === cardKey || !Array.isArray(t?.files))
      continue;
    for (const f of new Set(t.files))
      if (typeof f === "string") out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}

/** `node scripts/fetch-models.mjs --tool <id> --comfy <root> --yes` */
export function fetchModelsCommand(toolArg: string, comfyRoot: string): string {
  return `node scripts/fetch-models.mjs --tool ${shQuote(toolArg)} --comfy ${shQuote(comfyRoot)} --yes`;
}

/** The env line the manual commands use (`$COMFYUI`). */
export function comfyEnvLine(comfyRoot: string | null | undefined): string {
  return `export COMFYUI=${comfyRoot ? shQuote(comfyRoot) : "/path/to/ComfyUI"}`;
}
