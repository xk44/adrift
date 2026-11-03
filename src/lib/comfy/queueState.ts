/**
 * Server-side: merged ComfyUI queue across every backend (main, H3 warm,
 * video host / saved machines) and the per-prompt status lookup behind
 * /api/comfy/prompt-status. Unreadable backends fail open (null) so a job we
 * cannot see is never declared lost.
 */
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { otherBackendUrls } from "@/lib/comfy/backends";
import {
  H3_WARM_URL,
  fetchHistoryAnyBackend,
  isWarmAlive,
} from "@/lib/comfy/warmBackend";
import { fetchHistory } from "@/lib/comfy/http";
import {
  classifyPrompt,
  type PromptStatus,
  type QueueSnapshot,
} from "@/lib/comfy/promptReconcile";

function idsOf(items: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(items)) return ids;
  for (const item of items)
    if (Array.isArray(item) && typeof item[1] === "string") ids.add(item[1]);
  return ids;
}

/** One backend's /queue; null when it can't be read. */
export async function fetchQueueSnapshotFrom(
  base: string,
): Promise<QueueSnapshot | null> {
  try {
    const response = await comfyFetch("/queue", {
      baseUrl: base,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      queue_running?: unknown;
      queue_pending?: unknown;
    };
    return {
      running: idsOf(data.queue_running),
      pending: idsOf(data.queue_pending),
    };
  } catch {
    return null;
  }
}

/** Every backend's queue merged; null if any of them is unreadable. */
export async function fetchMergedQueueSnapshot(): Promise<QueueSnapshot | null> {
  const parts: Array<QueueSnapshot | null> = [
    await fetchQueueSnapshotFrom(env.COMFY_HTTP_URL),
  ];
  if (await isWarmAlive()) parts.push(await fetchQueueSnapshotFrom(H3_WARM_URL));
  for (const url of otherBackendUrls())
    parts.push(await fetchQueueSnapshotFrom(url));
  if (parts.some((p) => p === null)) return null;
  const running = new Set<string>();
  const pending = new Set<string>();
  for (const p of parts as QueueSnapshot[]) {
    p.running.forEach((id) => running.add(id));
    p.pending.forEach((id) => pending.add(id));
  }
  return { running, pending };
}

/** All prompt ids queued or running on any backend; null = unreadable. */
export async function fetchQueuedPromptIds(): Promise<Set<string> | null> {
  const snap = await fetchMergedQueueSnapshot();
  return snap ? new Set([...snap.running, ...snap.pending]) : null;
}

/** Status of each prompt id: queue first, then history on any backend. */
export async function promptStatuses(
  ids: readonly string[],
): Promise<Record<string, PromptStatus>> {
  const queue = await fetchMergedQueueSnapshot();
  const out: Record<string, PromptStatus> = {};
  await Promise.all(
    ids.map(async (id) => {
      if (queue?.running.has(id) || queue?.pending.has(id)) {
        out[id] = classifyPrompt(id, queue, null);
        return;
      }
      let history: Parameters<typeof classifyPrompt>[2] = null;
      try {
        history = await fetchHistoryAnyBackend(fetchHistory, id);
      } catch {
        // Main backend unreachable: can't tell, never call it missing.
        out[id] = { state: "unknown" };
        return;
      }
      out[id] = classifyPrompt(id, queue, history);
    }),
  );
  return out;
}
