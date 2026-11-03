/**
 * Browser side of the starter-pack download progress: listen to Adrift's
 * server-sent events (/api/onboarding/packs/progress?stream=1), and when the
 * stream can't be used (no EventSource, a proxy that buffers it, a dropped
 * connection, the stream's time limit) fall back to polling the same route's
 * JSON snapshot. Only Adrift is contacted, never the ComfyUI host.
 *
 * Client-safe (type-only imports); EventSource / fetch / timers injectable
 * for tests.
 */
import type { PackProgress } from "./packProgress";

export const PROGRESS_POLL_MS = 5_000;

export interface ProgressUpdate {
  progress: PackProgress | null;
  transport: "live" | "polling";
  /** The last check failed (Adrift unreachable / error answer). */
  lostContact: boolean;
}

interface MinimalEventSource {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
}

export interface WatchDeps {
  makeSource?: ((url: string) => MinimalEventSource) | null;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

export function progressUrl(ids: string[], stream: boolean): string {
  const q = `packs=${encodeURIComponent(ids.join(","))}`;
  return `/api/onboarding/packs/progress?${q}${stream ? "&stream=1" : ""}`;
}

function parse(data: unknown): PackProgress | null {
  try {
    const v = JSON.parse(String(data)) as PackProgress;
    return v && typeof v === "object" && Array.isArray(v.files) ? v : null;
  } catch {
    return null;
  }
}

/** Start watching; returns stop(). */
export function watchPackProgress(
  ids: string[],
  onUpdate: (u: ProgressUpdate) => void,
  deps: WatchDeps = {},
): () => void {
  const f = deps.fetchImpl ?? fetch;
  const pollMs = deps.pollMs ?? PROGRESS_POLL_MS;
  const makeSource =
    deps.makeSource !== undefined
      ? deps.makeSource
      : typeof EventSource !== "undefined"
        ? (url: string) => new EventSource(url) as unknown as MinimalEventSource
        : null;

  let stopped = false;
  let source: MinimalEventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: PackProgress | null = null;
  let polling = false;

  const stop = () => {
    stopped = true;
    source?.close();
    source = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const emit = (u: ProgressUpdate) => {
    if (stopped) return;
    if (u.progress) last = u.progress;
    onUpdate(u);
    if (u.progress?.complete) stop();
  };

  const pollOnce = async () => {
    if (stopped) return;
    try {
      const res = await f(progressUrl(ids, false), { cache: "no-store" });
      const body = (await res.json()) as {
        ok?: boolean;
        progress?: PackProgress;
      };
      if (!res.ok || !body.ok || !body.progress) throw new Error();
      emit({
        progress: body.progress,
        transport: "polling",
        lostContact: false,
      });
    } catch {
      emit({ progress: last, transport: "polling", lostContact: true });
    }
    if (!stopped) timer = setTimeout(() => void pollOnce(), pollMs);
  };

  const startPolling = () => {
    if (stopped || polling) return;
    polling = true;
    source?.close();
    source = null;
    void pollOnce();
  };

  if (!makeSource) {
    startPolling();
    return stop;
  }
  try {
    source = makeSource(progressUrl(ids, true));
  } catch {
    startPolling();
    return stop;
  }
  const onSnap = (e: MessageEvent) => {
    const p = parse(e.data);
    if (p) emit({ progress: p, transport: "live", lostContact: false });
  };
  source.addEventListener("progress", onSnap);
  source.addEventListener("complete", onSnap);
  // Stream ended (time limit) or broke: keep going by polling. Never let
  // EventSource's own silent retry loop leave a frozen bar.
  source.addEventListener("timeout", () => startPolling());
  source.onerror = () => startPolling();
  return stop;
}
