/**
 * One-click weight downloads for the "Set up this tool" drawer.
 *
 * Runs scripts/fetch-models.mjs (pinned Hugging Face revisions, size check,
 * resume, never overwrites) as a child process for the missing files of one
 * card, one job at a time. The drawer polls the job for its last log lines.
 * Only offered when ComfyUI runs on this machine: the files land in
 * COMFY_ROOT/models, which a remote ComfyUI would never see.
 */
import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import type { SetupFile } from "@/lib/tools/setupRequirements";

export const DOWNLOAD_LIST = () =>
  path.join(process.cwd(), "models", "download-list.json");
export const FETCH_SCRIPT = () =>
  path.join(process.cwd(), "scripts", "fetch-models.mjs");

const DEST_RE = /^[A-Za-z0-9._/+()-]+$/;
const MAX_LINES = 40;

/** models/ path the download list uses for one setup file, or null. */
export function setupFileDest(
  f: Pick<SetupFile, "file" | "folder" | "byName">,
): string | null {
  if (f.byName || f.folder === null) return null;
  const dir = f.folder.replace(/\/+$/, "");
  const dest = dir ? `${dir}/${f.file}` : f.file;
  return safeDest(dest) ? dest : null;
}

export function safeDest(d: unknown): d is string {
  return (
    typeof d === "string" &&
    d.length <= 300 &&
    DEST_RE.test(d) &&
    !d.startsWith("/") &&
    !d.split("/").some((s) => s === ".." || s === "." || s === "")
  );
}

/** Every destination (dest + `also` paths) the download list can fetch. */
export function listedDests(doc: unknown): Set<string> {
  const out = new Set<string>();
  const files = (doc as { files?: unknown })?.files;
  if (!Array.isArray(files)) return out;
  for (const f of files as Array<Record<string, unknown>>) {
    for (const d of [f?.dest, ...(Array.isArray(f?.also) ? f.also : [])])
      if (safeDest(d)) out.add(d);
  }
  return out;
}

let listCache: { mtimeMs: number; dests: Set<string> } | null = null;

/** Destinations in models/download-list.json; null when the file is absent. */
export function downloadableDests(): Set<string> | null {
  try {
    const st = fs.statSync(DOWNLOAD_LIST());
    if (listCache && listCache.mtimeMs === st.mtimeMs) return listCache.dests;
    const dests = listedDests(
      JSON.parse(fs.readFileSync(DOWNLOAD_LIST(), "utf8")),
    );
    listCache = { mtimeMs: st.mtimeMs, dests };
    return dests;
  } catch {
    return null;
  }
}

/**
 * Can this server download weights into ComfyUI? `reason` says why not, in
 * words the drawer shows next to the manual commands.
 */
export function downloadSupport(opts: {
  comfyLocal: boolean;
  comfyRoot: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!opts.comfyLocal)
    return {
      ok: false,
      reason:
        "ComfyUI runs on another machine, so Adrift can't save files there. Run the commands below on that machine.",
    };
  if (!fs.existsSync(path.join(opts.comfyRoot, "models")))
    return {
      ok: false,
      reason: `No models folder at ${path.join(opts.comfyRoot, "models")}. Set the ComfyUI folder in Settings first.`,
    };
  if (!downloadableDests() || !fs.existsSync(FETCH_SCRIPT()))
    return {
      ok: false,
      reason: "This build has no download list (models/download-list.json).",
    };
  return { ok: true };
}

export type DownloadState = "running" | "done" | "failed" | "cancelled";

export interface DownloadJob {
  id: string;
  key: string;
  dests: string[];
  state: DownloadState;
  lines: string[];
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

interface JobSlot {
  job: DownloadJob;
  child: ChildProcess | null;
}

// Survives Next dev hot reloads, so a running download keeps its handle.
const g = globalThis as unknown as {
  __adriftSetupDownloads?: Map<string, JobSlot>;
};
const jobs = (g.__adriftSetupDownloads ??= new Map<string, JobSlot>());

export function getJob(id: string): DownloadJob | null {
  return jobs.get(id)?.job ?? null;
}

export function runningJob(): DownloadJob | null {
  for (const s of jobs.values()) if (s.job.state === "running") return s.job;
  return null;
}

/** Append child output, splitting progress-bar carriage returns into lines. */
export function pushLines(
  lines: string[],
  chunk: string,
  max = MAX_LINES,
): void {
  for (const raw of chunk.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
    if (!line) continue;
    // A progress bar redraws one line: replace the previous redraw.
    const prev = lines[lines.length - 1];
    if (
      prev &&
      /\d+%\|/.test(line) &&
      /\d+%\|/.test(prev) &&
      prev.split(":")[0] === line.split(":")[0]
    )
      lines[lines.length - 1] = line;
    else lines.push(line);
  }
  if (lines.length > max) lines.splice(0, lines.length - max);
}

/** Argument list for fetch-models.mjs (no shell involved). */
export function fetchArgs(comfyRoot: string, dests: string[]): string[] {
  return [
    FETCH_SCRIPT(),
    "--comfy",
    comfyRoot,
    "--yes",
    "--set",
    "full",
    ...dests.flatMap((d) => ["--only", d]),
  ];
}

export function startDownload(
  key: string,
  dests: string[],
  comfyRoot: string,
  spawnFn: typeof spawn = spawn,
): DownloadJob {
  // Keep the finished-job map small.
  for (const [id, s] of jobs)
    if (s.job.state !== "running" && jobs.size > 20) jobs.delete(id);
  const job: DownloadJob = {
    id: randomUUID(),
    key,
    dests,
    state: "running",
    lines: [],
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  const child = spawnFn(process.execPath, fetchArgs(comfyRoot, dests), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so cancel also stops the hf CLI it starts.
    detached: process.platform !== "win32",
    env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "0" },
  });
  const slot: JobSlot = { job, child };
  jobs.set(job.id, slot);
  const onData = (b: Buffer) => pushLines(job.lines, b.toString("utf8"));
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const finish = (code: number | null) => {
    if (job.state !== "running") return;
    job.exitCode = code;
    job.state = code === 0 ? "done" : "failed";
    job.endedAt = Date.now();
    slot.child = null;
  };
  child.on("error", (e) => {
    pushLines(job.lines, `could not start the download: ${e.message}`);
    finish(-1);
  });
  child.on("close", (code) => finish(code));
  return job;
}

export function cancelDownload(id: string): boolean {
  const s = jobs.get(id);
  if (!s || s.job.state !== "running" || !s.child) return false;
  const pid = s.child.pid;
  try {
    if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else s.child.kill("SIGTERM");
  } catch {
    s.child.kill("SIGTERM");
  }
  s.job.state = "cancelled";
  s.job.endedAt = Date.now();
  pushLines(
    s.job.lines,
    "Cancelled. Partial files resume on the next download.",
  );
  return true;
}
