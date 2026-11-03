/**
 * H3 warm backend — an optional second ComfyUI process dedicated to MiniMax H3.
 *
 * Why: H3's 49GB text encoder + 38GB DiT cost 140-160s of load/handoff every
 * time another model family (krea2 etc.) evicts them from the main process.
 * A dedicated process keeps them resident, turning H3 renders into ~52s warm
 * runs — at the cost of ~87GB unified memory held while enabled.
 *
 * Off by default. Toggled from the UI via /api/h3-warm. State is a pid file
 * so it survives Next.js dev-server module reloads.
 *
 * Both processes share the same ComfyUI install, so model/output/input dirs
 * are common: files rendered on the warm backend are served by the main
 * process's /view endpoint just fine. Only queue/history are per-process —
 * callers that poll history must probe both (see fetchHistoryAnyBackend).
 */

import { execFileSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  candidateBackendUrls,
  defaultBackendUrl,
  hasMultipleBackends,
  knownPromptBackend,
  pickBackend,
  type RouteInput,
} from "@/lib/comfy/backends";

export const H3_WARM_URL =
  process.env.CJ_H3_WARM_URL?.trim() || "http://127.0.0.1:8189";

const PID_FILE = "/tmp/cj-h3-warm.pid";
const LOG_FILE = "/tmp/cj-h3-warm.log";

export interface WarmStatus {
  enabled: boolean;
  url: string;
  pid?: number;
  starting?: boolean;
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fast health probe of the warm backend HTTP API. */
export async function isWarmAlive(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await comfyFetch("/system_stats", {
      baseUrl: H3_WARM_URL,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function warmStatus(): Promise<WarmStatus> {
  const pid = readPid();
  const processUp = pid !== null && pidAlive(pid);
  const httpUp = processUp && (await isWarmAlive());
  return {
    enabled: httpUp,
    url: H3_WARM_URL,
    pid: processUp ? pid! : undefined,
    // process spawned but HTTP not answering yet = still booting/loading
    starting: processUp && !httpUp,
  };
}

/** Spawn the dedicated H3 ComfyUI instance (no-op if already running). */
export async function startWarm(): Promise<WarmStatus> {
  const current = await warmStatus();
  if (current.enabled || current.starting) return current;

  const port = new URL(H3_WARM_URL).port || "8189";
  const script = join(process.cwd(), "scripts", "start-comfyui.sh");
  const logFd = openSync(LOG_FILE, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(script, [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        COMFY_PORT: port,
        // separate log so the main instance's log stays clean
        CJ_ORIGIN: process.env.CJ_ORIGIN ?? "http://localhost:3000",
      },
    });
  } finally {
    // The child holds its own dup of the fd; keeping ours open leaks one fd per toggle.
    closeSync(logFd);
  }
  // Without a listener, a spawn failure (missing/non-executable script)
  // emits an unhandled 'error' event and takes down the Next server.
  child.on("error", (err) => {
    console.error("[h3-warm] spawn failed:", err.message);
  });
  child.unref();
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));
  return warmStatus();
}

/**
 * The PID file may be stale and its PID reused by an unrelated process, so
 * only signal it when its command line is our warm ComfyUI: start-comfyui.sh
 * execs `python .../main.py ... --port <warm port>`. `ps` exists on macOS and
 * Linux; elsewhere (or on any failure) refuse rather than guess.
 */
export function isWarmProcess(
  pid: number,
  port = new URL(H3_WARM_URL).port || "8189",
  readCommand: (pid: number) => string = psCommand,
): boolean {
  let cmd: string;
  try {
    cmd = readCommand(pid);
  } catch {
    return false;
  }
  // Still in the launcher (before its exec): the script itself.
  if (/(?:^|[\/\s])start-comfyui\.sh(?:\s|$)/.test(cmd)) return true;
  if (!/(?:^|[\/\s])main\.py(?:\s|$)/.test(cmd)) return false;
  return new RegExp(`--port(?:=|\\s+)${port}(?:\\s|$)`).test(cmd);
}

function psCommand(pid: number): string {
  if (process.platform === "win32") throw new Error("ps unavailable");
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  }).trim();
}

/** Stop the dedicated instance and release its memory. */
export async function stopWarm(): Promise<WarmStatus> {
  const pid = readPid();
  if (pid !== null && pidAlive(pid) && !isWarmProcess(pid)) {
    console.warn(
      `[h3-warm] PID ${pid} from the PID file is not the warm ComfyUI; not signalling it`,
    );
  } else if (pid !== null && pidAlive(pid)) {
    try {
      // start-comfyui.sh execs python, so the pid is the server itself.
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
  }
  return warmStatus();
}

export const WARM_LOG_FILE = LOG_FILE;

/**
 * Pick the submission backend for a resolved pack: the routed backend when it
 * is not the main one (env video host / saved machines, least busy first);
 * on the main backend, MiniMax H3 jobs go to the warm instance when it's up.
 * Returns undefined for "use the default URL".
 */
export async function backendForPack(
  packId: string | undefined,
  route: Omit<RouteInput, "packId"> = {},
): Promise<string | undefined> {
  const picked = await pickBackend({ ...route, packId });
  if (!picked.primary) return picked.url;
  if (packId !== "minimax") return undefined;
  return (await isWarmAlive()) ? H3_WARM_URL : undefined;
}

/**
 * History lives per-process: a prompt run on the warm backend is unknown to
 * the main one. Probe main first (the common case), then the warm instance.
 */
export async function fetchHistoryAnyBackend<T>(
  fetchHistory: (promptId: string, baseUrl?: string) => Promise<T | null>,
  promptId: string,
): Promise<T | null> {
  if (!hasMultipleBackends() && !knownPromptBackend(promptId)) {
    const main = await fetchHistory(promptId);
    if (main !== null) return main;
    if (await isWarmAlive()) return fetchHistory(promptId, H3_WARM_URL);
    return null;
  }
  // Multi-host: the backend the prompt was queued on first, then the rest.
  // A down secondary host must not fail lookups for the others.
  const main = defaultBackendUrl();
  for (const url of candidateBackendUrls(promptId)) {
    if (url === H3_WARM_URL.replace(/\/+$/, "") && !(await isWarmAlive()))
      continue;
    try {
      const entry =
        url === main
          ? await fetchHistory(promptId)
          : await fetchHistory(promptId, url);
      if (entry !== null) return entry;
    } catch (error) {
      if (url === main) throw error;
    }
  }
  return null;
}
