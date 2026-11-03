/**
 * GPU smoke runner body. Imported by run.ts only after it has pinned
 * NODE_ENV / COMFY_HTTP_URL (src/lib/env.ts reads them at import).
 *
 * dry-run  GET /object_info once; per entry: build the graph, bypass missing
 *          optional nodes, validatePrompt (the checks queuePrompt runs
 *          before its POST). No POST, no upload.
 * run      generate + upload the procedural assets, then per entry: wait for
 *          an empty queue, queuePrompt (POST /prompt), poll /history until
 *          done. Stops on Xid / CUDA-style errors, an unreachable server or
 *          a timeout. Never calls /interrupt or /free.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queuePrompt } from "@/lib/comfy/http";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { bypassMissingOptionalNodes } from "@/lib/comfy/optionalNodes";
import { jobMediaFromHistory } from "@/lib/comfy/outputs";
import {
  findMissingClassTypes,
  formatProblem,
  validatePrompt,
} from "@/lib/comfy/validatePrompt";
import {
  SMOKE_ASSETS,
  SMOKE_SUBFOLDER,
  writeSmokeAssets,
  type SmokeAssetId,
} from "./assets";
import { buildSmokeGraph } from "./build";
import { selectEntry, type SmokeArgs } from "./cli";
import {
  SMOKE_DEFERRED,
  SMOKE_MANIFEST,
  coveredIds,
  parityPendingIds,
  type SmokeEntry,
} from "./manifest";

/** Driver / device failures: stop the whole queue. */
export const FATAL_GPU_RE =
  /\bXid\b|CUDA error|out of memory|illegal memory access|device-side assert|\bGSP\b|cudaErrorLaunchFailure|NVML|CUBLAS_STATUS|unspecified launch failure/i;

export interface SmokeRecord {
  id: string;
  mode: "dry-run" | "run";
  kind: SmokeEntry["kind"];
  target: string;
  workflow?: string;
  status:
    | "ok"
    | "invalid"
    | "build_error"
    | "blocked"
    | "skipped"
    | "pass"
    | "fail"
    | "fatal";
  expect: SmokeEntry["expect"];
  heavy?: boolean;
  blockedBy?: string;
  nodes?: number;
  bypassed?: string[];
  missingClassTypes?: string[];
  problems?: string[];
  error?: string;
  promptId?: string;
  seconds?: number;
  outputs?: string[];
  at: string;
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function target(e: SmokeEntry): string {
  return e.kind === "action" ? e.action : e.toolId;
}

function selected(args: SmokeArgs): SmokeEntry[] {
  return SMOKE_MANIFEST.filter(
    (e) => selectEntry(e.id, args) && !(args.skipHeavy && e.heavy),
  );
}

function reportPath(args: SmokeArgs): string {
  const dir = args.outDir ?? path.join(os.tmpdir(), "adrift-gpu-smoke");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now().replace(/[:.]/g, "-");
  return path.join(dir, `${args.mode}-${stamp}.jsonl`);
}

function writer(file: string) {
  return (rec: object) => fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

/** Parity pending ids the manifest neither runs, defers nor marks context. */
export function uncoveredParityIds(): string[] {
  const doc = path.join(process.cwd(), "docs/HIGGSFIELD.md");
  let text = "";
  try {
    text = fs.readFileSync(doc, "utf8");
  } catch {
    return [];
  }
  const covered = coveredIds();
  return parityPendingIds(text).filter((id) => !covered.has(id));
}

// dry-run

/** Drop the "(available: ...)" combo listing: noisy, and it is the host's model inventory. */
export function stripAvailable(problem: string): string {
  return problem.replace(/\s*\(available: [^]*\)\s*$/, "");
}

export async function validateEntry(
  entry: SmokeEntry,
  comfyUrl: string,
  objectInfo: Record<string, unknown>,
): Promise<SmokeRecord> {
  const base = {
    id: entry.id,
    mode: "dry-run" as const,
    kind: entry.kind,
    target: target(entry),
    expect: entry.expect,
    ...(entry.heavy ? { heavy: true } : {}),
    ...(entry.blockedBy ? { blockedBy: entry.blockedBy } : {}),
  };
  let built;
  try {
    built = await buildSmokeGraph(entry, { comfyUrl });
  } catch (e) {
    return {
      ...base,
      status: "build_error",
      error: e instanceof Error ? e.message : String(e),
      at: now(),
    };
  }
  const { prompt, bypassed } = bypassMissingOptionalNodes(
    built.workflow,
    objectInfo,
  );
  const problems = validatePrompt(prompt, objectInfo);
  const missing = findMissingClassTypes(prompt, objectInfo);
  const valid = problems.length === 0;
  return {
    ...base,
    workflow: built.workflowPath,
    status: valid ? "ok" : entry.blockedBy ? "blocked" : "invalid",
    nodes: Object.keys(prompt).length,
    ...(bypassed.length
      ? { bypassed: bypassed.map((b) => `${b.title} (${b.classType})`) }
      : {}),
    ...(missing.length ? { missingClassTypes: missing } : {}),
    ...(problems.length
      ? { problems: problems.map((p) => stripAvailable(formatProblem(p))) }
      : {}),
    at: now(),
  };
}

async function dryRun(args: SmokeArgs): Promise<number> {
  const file = reportPath(args);
  const write = writer(file);
  const objectInfo = await getObjectInfoCached(args.comfyUrl, { fresh: true });
  if (!objectInfo) {
    console.error(`GET ${args.comfyUrl}/object_info failed: is ComfyUI up?`);
    return 2;
  }
  const entries = selected(args);
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const rec = await validateEntry(entry, args.comfyUrl, objectInfo);
    counts[rec.status] = (counts[rec.status] ?? 0) + 1;
    write(rec);
    const extra = rec.error ?? rec.problems?.slice(0, 2).join("; ") ?? "";
    console.log(
      `${rec.status.padEnd(11)} ${rec.id}${extra ? `  ${extra}` : ""}`,
    );
  }
  const uncovered = uncoveredParityIds();
  const summary = {
    summary: true,
    mode: "dry-run",
    entries: entries.length,
    counts,
    deferred: SMOKE_DEFERRED.map((d) => d.id),
    uncoveredParityIds: uncovered,
    at: now(),
  };
  write(summary);
  console.log(`\n${JSON.stringify(summary)}\nreport: ${file}`);
  return (counts.invalid ?? 0) + (counts.build_error ?? 0) > 0 ? 1 : 0;
}

// run

async function getJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function uploadAsset(comfyUrl: string, id: SmokeAssetId, file: string) {
  const form = new FormData();
  form.append(
    "image",
    new Blob([fs.readFileSync(file)]),
    SMOKE_ASSETS[id].file,
  );
  form.append("type", "input");
  form.append("subfolder", SMOKE_SUBFOLDER);
  form.append("overwrite", "true");
  const res = await fetch(`${comfyUrl}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok)
    throw new Error(`upload ${id} -> ${res.status} ${await res.text()}`);
}

async function waitQueueEmpty(comfyUrl: string, maxSec: number): Promise<void> {
  const until = Date.now() + maxSec * 1000;
  for (;;) {
    const q = (await getJson(`${comfyUrl}/queue`)) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };
    if (!q.queue_running?.length && !q.queue_pending?.length) return;
    if (Date.now() > until)
      throw new Error(
        `queue still busy after ${maxSec}s (someone else's jobs)`,
      );
    await sleep(5000);
  }
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, unknown>;
}

function historyError(entry: HistoryEntry): string | undefined {
  for (const m of entry.status?.messages ?? []) {
    if (!Array.isArray(m) || m[0] !== "execution_error") continue;
    const d = (m[1] ?? {}) as Record<string, unknown>;
    return `${d.node_type ?? "node"} #${d.node_id ?? "?"}: ${String(d.exception_message ?? "error").trim()}`;
  }
  return entry.status?.status_str === "error" ? "execution error" : undefined;
}

async function runEntry(
  entry: SmokeEntry,
  args: SmokeArgs,
): Promise<{ rec: SmokeRecord; stop?: string }> {
  const base = {
    id: entry.id,
    mode: "run" as const,
    kind: entry.kind,
    target: target(entry),
    expect: entry.expect,
    ...(entry.heavy ? { heavy: true } : {}),
    ...(entry.blockedBy ? { blockedBy: entry.blockedBy } : {}),
  };
  if (entry.blockedBy && !args.includeBlocked)
    return {
      rec: { ...base, status: "skipped", error: entry.blockedBy, at: now() },
    };
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const built = await buildSmokeGraph(entry, { comfyUrl: args.comfyUrl });
    await waitQueueEmpty(args.comfyUrl, args.queueWaitSec);
    const queued = await queuePrompt(
      built.workflow,
      `adrift-gpu-smoke-${entry.id}`,
      args.comfyUrl,
    );
    const promptId = queued.prompt_id;
    const deadline = started + (entry.timeoutSec ?? 900) * 1000;
    for (;;) {
      await sleep(3000);
      let entryHist: HistoryEntry | undefined;
      try {
        const h = (await getJson(
          `${args.comfyUrl}/history/${promptId}`,
        )) as Record<string, HistoryEntry>;
        entryHist = h[promptId];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          rec: {
            ...base,
            status: "fatal",
            promptId,
            error: msg,
            seconds: secs(),
            at: now(),
          },
          stop: `ComfyUI unreachable: ${msg}`,
        };
      }
      if (
        entryHist?.status?.completed ||
        entryHist?.status?.status_str === "error"
      ) {
        const err = historyError(entryHist);
        if (err) {
          const fatal = FATAL_GPU_RE.test(err);
          return {
            rec: {
              ...base,
              status: fatal ? "fatal" : "fail",
              promptId,
              error: err,
              seconds: secs(),
              at: now(),
            },
            ...(fatal ? { stop: `GPU error: ${err}` } : {}),
          };
        }
        const media = jobMediaFromHistory(
          entryHist as never,
          (q) => `view?${q}`,
        );
        const bucket = {
          image: media.images,
          video: media.videos,
          audio: media.audios,
          text: media.texts,
        }[entry.expect];
        const outputs = [
          ...media.images,
          ...media.videos,
          ...media.audios,
          ...media.texts.map((t) => `text:${t.slice(0, 120)}`),
        ];
        return {
          rec: {
            ...base,
            status: bucket.length ? "pass" : "fail",
            promptId,
            seconds: secs(),
            outputs,
            ...(bucket.length ? {} : { error: `no ${entry.expect} output` }),
            at: now(),
          },
        };
      }
      if (Date.now() > deadline) {
        return {
          rec: {
            ...base,
            status: "fatal",
            promptId,
            error: "timeout",
            seconds: secs(),
            at: now(),
          },
          stop: `timeout after ${entry.timeoutSec ?? 900}s on ${entry.id} (left queued; not interrupted)`,
        };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const fatal =
      FATAL_GPU_RE.test(msg) ||
      /queue still busy|fetch failed|ECONNREFUSED/i.test(msg);
    return {
      rec: {
        ...base,
        status: fatal ? "fatal" : "fail",
        error: msg,
        seconds: secs(),
        at: now(),
      },
      ...(fatal ? { stop: msg } : {}),
    };
  }
}

async function run(args: SmokeArgs): Promise<number> {
  const file = reportPath(args);
  const write = writer(file);
  const assetDir = path.join(path.dirname(file), "assets");
  const paths = writeSmokeAssets(assetDir);
  for (const id of Object.keys(paths) as SmokeAssetId[]) {
    await uploadAsset(args.comfyUrl, id, paths[id]);
  }
  const counts: Record<string, number> = {};
  let stopped: string | undefined;
  for (const entry of selected(args)) {
    console.log(`... ${entry.id}`);
    const { rec, stop } = await runEntry(entry, args);
    counts[rec.status] = (counts[rec.status] ?? 0) + 1;
    write(rec);
    console.log(
      `${rec.status.padEnd(8)} ${rec.id} ${rec.seconds ?? ""}s ${rec.error ?? rec.outputs?.join(" ") ?? ""}`,
    );
    if (stop) {
      stopped = stop;
      break;
    }
  }
  const summary = {
    summary: true,
    mode: "run",
    counts,
    stopped: stopped ?? null,
    at: now(),
  };
  write(summary);
  console.log(`\n${JSON.stringify(summary)}\nreport: ${file}`);
  return stopped || counts.fail ? 1 : 0;
}

export async function main(args: SmokeArgs): Promise<number> {
  return args.mode === "run" ? run(args) : dryRun(args);
}
