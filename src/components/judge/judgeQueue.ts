/**
 * Judge-mode client queue: the server answers a busy GPU with
 * 429 {details:{code:"judge_queued", position, retry_after_s}}. installJudgeFetch()
 * wraps window.fetch so tool runners transparently wait and retry, while the
 * store drives a friendly "queued" banner.
 */
import { createWithEqualityFn } from "zustand/traditional";

export interface JudgeQueueState {
  queued: boolean;
  position: number;
  lastError: string | null;
  set: (patch: Partial<Omit<JudgeQueueState, "set">>) => void;
}

export const useJudgeQueue = createWithEqualityFn<JudgeQueueState>()(
  (set) => ({
    queued: false,
    position: 0,
    lastError: null,
    set: (patch) => set(patch),
  }),
);

const RETRY_PATHS = new Set(["/api/jobs/action", "/api/jobs/tool"]);
const MAX_WAIT_MS = 30 * 60 * 1000;

function requestPath(input: RequestInfo | URL): string | null {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return null;
  }
}

/** {position, retryAfterS} for a 429 judge_queued response, else null. */
export async function queuedDetails(
  res: Response,
): Promise<{ position: number; retryAfterS: number } | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as {
      details?: { code?: string; position?: unknown; retry_after_s?: unknown };
    };
    if (body?.details?.code !== "judge_queued") return null;
    return {
      position: Math.max(1, Number(body.details.position) || 1),
      retryAfterS: Math.min(
        60,
        Math.max(1, Number(body.details.retry_after_s) || 5),
      ),
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let installed = false;

/** Idempotent; returns an uninstall function (no-op after the first). */
export function installJudgeFetch(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const path = requestPath(input);
    if (method !== "POST" || !path || !RETRY_PATHS.has(path)) {
      return original(input, init);
    }
    const started = Date.now();
    for (;;) {
      const res = await original(input, init);
      if (res.status !== 429) {
        useJudgeQueue.getState().set({ queued: false, position: 0 });
        return res;
      }
      const q = await queuedDetails(res);
      if (!q || Date.now() - started > MAX_WAIT_MS) {
        useJudgeQueue.getState().set({ queued: false, position: 0 });
        return res;
      }
      useJudgeQueue.getState().set({ queued: true, position: q.position });
      await sleep(q.retryAfterS * 1000);
    }
  };
  return () => {
    window.fetch = original;
    installed = false;
  };
}
