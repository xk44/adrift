/**
 * Notices submitted prompts that have gone quiet on the WebSocket.
 *
 * If a prompt sees no WS event for `staleMs` (another socket took its events,
 * the socket silently dropped, ...), the caller polls history for it until it
 * finishes, so a job never hangs in "running" forever.
 */

export interface PromptWatchdog {
  /** A WS event mentioned this prompt. */
  noteEvent(promptId: string): void;
  /**
   * Given every prompt still pending (queued/running), return the ones that
   * have been silent for at least `staleMs`. Prompts no longer pending are
   * forgotten.
   */
  stale(pending: Iterable<string>): string[];
}

export function createPromptWatchdog(options: {
  staleMs: number;
  now?: () => number;
}): PromptWatchdog {
  const now = options.now ?? Date.now;
  const lastSeen = new Map<string, number>();
  return {
    noteEvent(promptId) {
      lastSeen.set(promptId, now());
    },
    stale(pending) {
      const t = now();
      const live = new Set<string>();
      const out: string[] = [];
      for (const id of pending) {
        if (live.has(id)) continue;
        live.add(id);
        const seen = lastSeen.get(id);
        if (seen === undefined) {
          // First time we see it pending: start its clock now.
          lastSeen.set(id, t);
        } else if (t - seen >= options.staleMs) {
          out.push(id);
        }
      }
      for (const id of [...lastSeen.keys()]) {
        if (!live.has(id)) lastSeen.delete(id);
      }
      return out;
    },
  };
}
