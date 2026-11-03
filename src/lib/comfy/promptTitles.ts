/**
 * Server-side registry of node titles per submitted prompt_id, so WS /
 * SSE error events (which carry only node ids) can show node titles.
 * Bounded in-memory; stored on globalThis to survive per-route bundling.
 */

import { extractNodeTitles, type NodeTitles } from "@/lib/comfy/errorMessages";

const MAX_ENTRIES = 300;
const g = globalThis as unknown as {
  __adriftPromptTitles?: Map<string, NodeTitles>;
};
const store = (g.__adriftPromptTitles ??= new Map());

export function rememberPromptTitles(promptId: string, prompt: unknown): void {
  if (!promptId) return;
  store.delete(promptId);
  store.set(promptId, extractNodeTitles(prompt));
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function getPromptTitles(promptId: string): NodeTitles | undefined {
  return store.get(promptId);
}
