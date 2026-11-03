/**
 * Local trainer job runner: one job at a time, each plan command spawned
 * without a shell in its own process group, output appended to a log file
 * that progress / loss are parsed from. Job records are JSON files under
 * <data>/training/jobs/<id>/job.json so history survives a restart; a job
 * that was running when Adrift stopped is marked failed on the next start
 * (its process group is stopped when it is still the trainer we launched).
 *
 * Statuses: queued | running | done | failed | cancelled. The UI (shared with
 * StyleVault) knows queued | running | done | error, so `publicStatus` maps
 * failed / cancelled to "error" and keeps the real one in `local_status`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { adriftDataPath } from "@/lib/paths/resolveDirs";
import { writeAtomic } from "@/lib/runtimeSettings";
import type { TrainPlan } from "./plan";

export type LocalJobStatus =
  "queued" | "running" | "done" | "failed" | "cancelled";

export interface LocalJobRecord {
  job_id: string;
  backend: string;
  model_family: string;
  run_name: string;
  status: LocalJobStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  cwd: string;
  commands: { name: string; argv: string[] }[];
  output_dir: string;
  dataset_dir: string;
  phase: number;
  pid?: number;
  progress: number;
  step?: number;
  total_steps?: number;
  last_loss: number | null;
  last_pred_std: number | null;
  loss_history: number[];
  max_loss: number | null;
  diverged: boolean;
  divergence_threshold: number;
  output_lora_path: string | null;
  deployed_path?: string | null;
  returncode?: number | null;
  error?: string;
}

export interface LocalJobDetail {
  job_id: string;
  backend: string;
  model_family: string;
  status: "queued" | "running" | "done" | "error";
  local_status: LocalJobStatus;
  created_at: string;
  progress: number;
  step?: number;
  total_steps?: number;
  phase?: string;
  log_tail: string;
  output_lora_path: string | null;
  deployed_path: string | null;
  last_loss: number | null;
  last_pred_std: number | null;
  loss_history: number[];
  max_loss: number | null;
  diverged: boolean;
  error?: string;
}

export class TrainerBusyError extends Error {
  constructor(readonly activeJobId: string) {
    super("Another training job is already running.");
  }
}

export const LOCAL_JOB_ID_RE = /^local-[0-9a-f]{12}$/;
export const isLocalJobId = (id: unknown): id is string =>
  typeof id === "string" && LOCAL_JOB_ID_RE.test(id);

const STEP_RE = /(?:step\D*)?(\d+)\s*\/\s*(\d+)/i;
const LOSS_RE = /\bavr_loss=([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/;
const PRED_STD_RE =
  /\bpred_std=([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/;
const PHASE_MARK = "[adrift] phase ";
const LOG_TAIL_LINES = 80;
const LOSS_HISTORY = 60;
const TAIL_BYTES = 256 * 1024;
const MONITOR_MS = 2000;
const KILL_GRACE_MS = 10_000;
export const DEFAULT_DIVERGENCE_THRESHOLD = 100;

/**
 * Environment handed to the trainer: what Python / CUDA / Hugging Face need,
 * never Adrift's own secrets (admin key, API keys).
 */
const ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|PROGRAMDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|LD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH|CUDA_\w+|NVIDIA_\w+|HF_\w+|HUGGINGFACE_\w+|TRANSFORMERS_\w+|TORCH_\w+|PYTORCH_\w+|XDG_\w+)$/;

export function trainerEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source))
    if (v !== undefined && ENV_ALLOW.test(k)) out[k] = v;
  out.PYTHONUNBUFFERED = "1";
  return out as NodeJS.ProcessEnv;
}

export function jobsRoot(): string {
  return adriftDataPath("training", "jobs");
}

export function jobDirFor(id: string): string {
  if (!isLocalJobId(id)) throw new Error("Invalid job id");
  return path.join(jobsRoot(), id);
}

const recordPath = (id: string) => path.join(jobDirFor(id), "job.json");
export const logPathFor = (id: string) => path.join(jobDirFor(id), "train.log");

export function newJobId(): string {
  return `local-${randomBytes(6).toString("hex")}`;
}

interface RunnerState {
  activeId: string | null;
  child: ChildProcess | null;
  cancelRequested: Set<string>;
  monitor: ReturnType<typeof setInterval> | null;
  recovered: boolean;
}

const g = globalThis as unknown as { __adriftLocalTrainer?: RunnerState };
function state(): RunnerState {
  return (g.__adriftLocalTrainer ??= {
    activeId: null,
    child: null,
    cancelRequested: new Set(),
    monitor: null,
    recovered: false,
  });
}

/** Test hook: forget the in-memory runner state. */
export function resetRunnerForTests(): void {
  const s = state();
  if (s.monitor) clearInterval(s.monitor);
  g.__adriftLocalTrainer = undefined;
}

export function readJob(id: string): LocalJobRecord | null {
  if (!isLocalJobId(id)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(recordPath(id), "utf8"),
    ) as LocalJobRecord;
  } catch {
    return null;
  }
}

function saveJob(rec: LocalJobRecord): void {
  writeAtomic(recordPath(rec.job_id), `${JSON.stringify(rec, null, 2)}\n`);
}

function appendLog(id: string, text: string): void {
  try {
    fs.appendFileSync(logPathFor(id), text);
  } catch {
    /* log is best-effort */
  }
}

function readTail(file: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface ParsedLog {
  tail: string[];
  step?: number;
  total?: number;
  losses: number[];
  predStd: number | null;
}

/** Progress + loss of the CURRENT phase (lines after the last phase marker). */
export function parseLog(text: string): ParsedLog {
  const lines = text.split(/[\r\n]+/).filter((l) => l.length > 0);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].startsWith(PHASE_MARK)) {
      start = i + 1;
      break;
    }
  const out: ParsedLog = {
    tail: lines.slice(-LOG_TAIL_LINES),
    losses: [],
    predStd: null,
  };
  for (const line of lines.slice(start)) {
    const m = STEP_RE.exec(line);
    if (m) {
      out.step = Number(m[1]);
      out.total = Math.max(Number(m[2]), 1);
    }
    const l = LOSS_RE.exec(line);
    if (l) out.losses.push(Number(l[1]));
    const p = PRED_STD_RE.exec(line);
    if (p) out.predStd = Number(p[1]);
  }
  return out;
}

function applyLog(rec: LocalJobRecord): ParsedLog {
  const parsed = parseLog(readTail(logPathFor(rec.job_id)));
  if (parsed.step !== undefined && parsed.total !== undefined) {
    rec.step = parsed.step;
    rec.total_steps = parsed.total;
    rec.progress = Math.min(Math.max(parsed.step / parsed.total, 0), 1);
  }
  if (parsed.losses.length) {
    rec.last_loss = parsed.losses[parsed.losses.length - 1];
    rec.loss_history = parsed.losses.slice(-LOSS_HISTORY);
    const max = Math.max(...parsed.losses);
    rec.max_loss = rec.max_loss == null ? max : Math.max(rec.max_loss, max);
  }
  if (parsed.predStd !== null) rec.last_pred_std = parsed.predStd;
  return parsed;
}

export function publicStatus(
  s: LocalJobStatus,
): "queued" | "running" | "done" | "error" {
  return s === "failed" || s === "cancelled" ? "error" : s;
}

export function jobDetail(rec: LocalJobRecord): LocalJobDetail {
  const parsed =
    rec.status === "running"
      ? applyLog(rec)
      : parseLog(readTail(logPathFor(rec.job_id), 64 * 1024));
  return {
    job_id: rec.job_id,
    backend: rec.backend,
    model_family: rec.model_family,
    status: publicStatus(rec.status),
    local_status: rec.status,
    created_at: rec.created_at,
    progress: rec.status === "done" ? 1 : rec.progress,
    step: rec.step,
    total_steps: rec.total_steps,
    phase: rec.commands[rec.phase]?.name,
    log_tail: parsed.tail.join("\n"),
    output_lora_path: rec.output_lora_path,
    deployed_path: rec.deployed_path ?? null,
    last_loss: rec.last_loss,
    last_pred_std: rec.last_pred_std,
    loss_history: rec.loss_history,
    max_loss: rec.max_loss,
    diverged: rec.diverged,
    ...(rec.error ? { error: rec.error } : {}),
  };
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Command line of a live pid, or null (no ps / not running). */
function commandOf(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

/** Newest .safetensors in the output folder or one level below it. */
export function findOutputLora(dir: string): string | null {
  const found: { p: string; t: number }[] = [];
  const scan = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.endsWith(".safetensors")) {
        try {
          found.push({ p, t: fs.statSync(p).mtimeMs });
        } catch {
          /* raced away */
        }
      } else if (e.isDirectory() && depth > 0 && e.name !== "cache") {
        scan(p, depth - 1);
      }
    }
  };
  scan(dir, 1);
  found.sort((a, b) => b.t - a.t);
  return found[0]?.p ?? null;
}

/**
 * Mark jobs left running / queued by a previous server process as failed,
 * stopping their process group when the pid still runs the trainer we
 * launched (pid reuse guard: its command line must match).
 */
export function recoverOrphans(): void {
  const s = state();
  if (s.recovered) return;
  s.recovered = true;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(jobsRoot()).filter(isLocalJobId);
  } catch {
    return;
  }
  for (const id of ids) {
    if (id === s.activeId) continue;
    const rec = readJob(id);
    if (!rec || (rec.status !== "running" && rec.status !== "queued")) continue;
    if (rec.pid && isAlive(rec.pid)) {
      const cmd = commandOf(rec.pid);
      const argv0 = rec.commands[rec.phase]?.argv[0];
      if (cmd && argv0 && cmd.includes(argv0)) killGroup(rec.pid, "SIGTERM");
    }
    rec.status = "failed";
    rec.error =
      "Adrift restarted while this job was running; the run was stopped.";
    rec.ended_at = new Date().toISOString();
    rec.pid = undefined;
    saveJob(rec);
  }
}

export function activeJobId(): string | null {
  return state().activeId;
}

export interface StartJobInput {
  plan: TrainPlan;
  runName: string;
  datasetDir: string;
  divergenceThreshold?: number;
  /** Called once the job reaches done (best-effort, e.g. link into ComfyUI). */
  onDone?: (rec: LocalJobRecord) => Promise<Partial<LocalJobRecord> | void>;
  jobId?: string;
}

/**
 * Write the plan's config files, persist a queued record and start running
 * it in the background. Throws TrainerBusyError while another job runs.
 */
export function startJob(input: StartJobInput): LocalJobRecord {
  recoverOrphans();
  const s = state();
  if (s.activeId) throw new TrainerBusyError(s.activeId);
  const id = input.jobId ?? newJobId();
  const dir = jobDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of input.plan.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, "utf8");
  }
  fs.mkdirSync(input.plan.outputDir, { recursive: true });
  const rec: LocalJobRecord = {
    job_id: id,
    backend: input.plan.backend,
    model_family: input.plan.family,
    run_name: input.runName,
    status: "queued",
    created_at: new Date().toISOString(),
    cwd: input.plan.cwd,
    commands: input.plan.commands,
    output_dir: input.plan.outputDir,
    dataset_dir: input.datasetDir,
    phase: 0,
    progress: 0,
    last_loss: null,
    last_pred_std: null,
    loss_history: [],
    max_loss: null,
    diverged: false,
    divergence_threshold:
      input.divergenceThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD,
    output_lora_path: null,
  };
  saveJob(rec);
  fs.writeFileSync(logPathFor(id), "");
  s.activeId = id;
  const queued = { ...rec };
  void runJob(rec, input.onDone);
  return queued;
}

function runCommand(
  rec: LocalJobRecord,
  argv: string[],
): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    const s = state();
    let fd: number;
    try {
      fd = fs.openSync(logPathFor(rec.job_id), "a");
    } catch (e) {
      resolve({
        code: null,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: rec.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", fd, fd],
        env: trainerEnv(),
        windowsHide: true,
      });
    } catch (e) {
      fs.closeSync(fd);
      resolve({
        code: null,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    fs.closeSync(fd);
    s.child = child;
    rec.pid = child.pid;
    saveJob(rec);
    let settled = false;
    const done = (r: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      s.child = null;
      resolve(r);
    };
    child.on("error", (e) => done({ code: null, error: e.message }));
    child.on("exit", (code, signal) =>
      done({ code, ...(signal ? { error: `stopped by ${signal}` } : {}) }),
    );
  });
}

function startMonitor(rec: LocalJobRecord): void {
  const s = state();
  if (s.monitor) clearInterval(s.monitor);
  s.monitor = setInterval(() => {
    if (state().activeId !== rec.job_id) return;
    applyLog(rec);
    const trainPhase = rec.phase === rec.commands.length - 1;
    if (
      trainPhase &&
      !rec.diverged &&
      rec.divergence_threshold > 0 &&
      rec.last_loss !== null &&
      rec.last_loss > rec.divergence_threshold
    ) {
      rec.diverged = true;
      rec.error = `training diverged (avr_loss=${rec.last_loss} exceeded threshold ${rec.divergence_threshold})`;
      stopActive(rec);
    }
    try {
      saveJob(rec);
    } catch {
      /* next tick retries */
    }
  }, MONITOR_MS);
  s.monitor.unref?.();
}

function stopActive(rec: LocalJobRecord): void {
  const s = state();
  const pid = s.child?.pid ?? rec.pid;
  if (!pid) return;
  killGroup(pid, "SIGTERM");
  const t = setTimeout(() => {
    if (isAlive(pid)) killGroup(pid, "SIGKILL");
  }, KILL_GRACE_MS);
  t.unref?.();
}

async function runJob(
  rec: LocalJobRecord,
  onDone?: StartJobInput["onDone"],
): Promise<void> {
  const s = state();
  try {
    rec.status = "running";
    rec.started_at = new Date().toISOString();
    saveJob(rec);
    startMonitor(rec);
    for (let i = 0; i < rec.commands.length; i++) {
      if (s.cancelRequested.has(rec.job_id)) break;
      rec.phase = i;
      rec.step = undefined;
      rec.total_steps = undefined;
      rec.progress = 0;
      const cmd = rec.commands[i];
      appendLog(
        rec.job_id,
        `\n${PHASE_MARK}${i + 1} of ${rec.commands.length}: ${cmd.name}\n`,
      );
      const r = await runCommand(rec, cmd.argv);
      applyLog(rec);
      rec.pid = undefined;
      if (s.cancelRequested.has(rec.job_id) || rec.diverged) break;
      if (r.code !== 0) {
        rec.status = "failed";
        rec.returncode = r.code;
        rec.error =
          r.error ??
          `${cmd.name} exited with code ${r.code} (see the log below).`;
        break;
      }
    }
    if (s.cancelRequested.has(rec.job_id)) {
      rec.status = "cancelled";
      rec.error ??= "Cancelled.";
    } else if (rec.diverged) {
      rec.status = "failed";
    } else if (rec.status === "running") {
      rec.output_lora_path = findOutputLora(rec.output_dir);
      rec.status = "done";
      rec.progress = 1;
      if (!rec.output_lora_path)
        rec.error = "Training finished but no .safetensors file was found.";
      else if (onDone) {
        try {
          Object.assign(rec, (await onDone(rec)) ?? {});
        } catch (e) {
          appendLog(
            rec.job_id,
            `[adrift] could not link the LoRA into ComfyUI: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    }
  } catch (e) {
    rec.status = "failed";
    rec.error = e instanceof Error ? e.message : String(e);
  } finally {
    rec.ended_at = new Date().toISOString();
    rec.pid = undefined;
    if (s.monitor) clearInterval(s.monitor);
    s.monitor = null;
    s.cancelRequested.delete(rec.job_id);
    s.activeId = null;
    s.child = null;
    try {
      saveJob(rec);
    } catch {
      /* disk gone; nothing more to do */
    }
  }
}

/** Cancel a job: stops the whole process group of the running command. */
export function cancelJob(id: string): LocalJobRecord | null {
  recoverOrphans();
  const rec = readJob(id);
  if (!rec) return null;
  const s = state();
  if (s.activeId === id) {
    s.cancelRequested.add(id);
    const pid = s.child?.pid;
    if (pid) {
      killGroup(pid, "SIGTERM");
      const t = setTimeout(() => {
        if (isAlive(pid)) killGroup(pid, "SIGKILL");
      }, KILL_GRACE_MS);
      t.unref?.();
    }
    return rec;
  }
  if (rec.status === "queued" || rec.status === "running") {
    rec.status = "cancelled";
    rec.ended_at = new Date().toISOString();
    saveJob(rec);
  }
  return rec;
}

export function updateJob(
  id: string,
  patch: Partial<LocalJobRecord>,
): LocalJobRecord | null {
  const rec = readJob(id);
  if (!rec) return null;
  Object.assign(rec, patch);
  saveJob(rec);
  return rec;
}

export function getJob(id: string): LocalJobRecord | null {
  recoverOrphans();
  return readJob(id);
}
