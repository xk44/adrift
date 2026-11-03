/**
 * GET /api/comfy/progress
 *
 * SSE endpoint that proxies ComfyUI WebSocket messages as Server-Sent Events.
 * Intended as a fallback for clients that cannot use WebSocket directly.
 *
 * Query params:
 *   client_id  — optional; when provided, only messages for this client are
 *                forwarded (ComfyUI scopes its WS messages by client_id)
 *
 * SSE events emitted:
 *   event: progress   — step progress within a node
 *   event: executing  — node execution update
 *   event: complete   — prompt finished successfully (execution_success, or
 *                       the trailing `executing {node:null}` on servers
 *                       without it); never after error / cancelled
 *   event: error      — execution error (message includes node title)
 *   event: cancelled  — execution_interrupted (not a failure)
 *
 * Heartbeat: `:keepalive` comment every 30 s to prevent proxy timeouts.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateIdentifier } from "@/lib/validate";
import { env } from "@/lib/env";
import {
  describeExecutionError,
  describeExecutionInterrupted,
} from "@/lib/comfy/errorMessages";
import {
  getPromptTitles,
  rememberPromptTitles,
} from "@/lib/comfy/promptTitles";
import { fetchHistory } from "@/lib/comfy/http";
import type { NodeTitles } from "@/lib/comfy/errorMessages";


const HEARTBEAT_INTERVAL_MS = 30_000;

// Helpers

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseComment(comment: string): string {
  return `:${comment}\n\n`;
}

/** Bounded insertion-ordered set (oldest evicted). */
function boundedAdd(set: Set<string>, id: string, max = 200): void {
  set.delete(id);
  set.add(id);
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * Best-effort lookup of a prompt's node titles for prompts not submitted
 * through queuePrompt (which registers them): the running/pending entry of
 * GET /queue, else the history entry. Registers what it finds.
 */
async function loadPromptTitles(promptId: string): Promise<void> {
  try {
    const res = await fetch(`${env.COMFY_HTTP_URL}/queue`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const queue = (await res.json()) as {
        queue_running?: unknown[];
        queue_pending?: unknown[];
      };
      for (const item of [
        ...(queue.queue_running ?? []),
        ...(queue.queue_pending ?? []),
      ]) {
        if (Array.isArray(item) && item[1] === promptId && item[2]) {
          rememberPromptTitles(promptId, item[2]);
          return;
        }
      }
    }
  } catch {
    // fall through to history
  }
  try {
    const entry = (await fetchHistory(promptId)) as {
      prompt?: unknown;
    } | null;
    const graph = Array.isArray(entry?.prompt) ? entry.prompt[2] : undefined;
    if (graph) rememberPromptTitles(promptId, graph);
  } catch {
    // labels fall back to "Node <id>"
  }
}

function nodeLabel(titles: NodeTitles | undefined, node: string): string {
  return titles?.[node] || `Node ${node}`;
}

// Route handler

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const { searchParams } = req.nextUrl;
  const rawClientId = searchParams.get("client_id");
  let clientId: string | undefined;
  if (rawClientId) {
    const clientIdResult = validateIdentifier(rawClientId, "client_id", 200);
    if (!clientIdResult.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: clientIdResult.error }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    clientId = clientIdResult.text;
  }

  const wsUrl = clientId
    ? `${env.COMFY_WS_BASE}/ws?clientId=${encodeURIComponent(clientId)}`
    : `${env.COMFY_WS_BASE}/ws`;

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const { signal } = abortController;

  const stream = new ReadableStream({
    start(controller) {
      // Open server-side WebSocket to ComfyUI
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(
            sseEvent("error", { message: `WS init failed: ${msg}` }),
          ),
        );
        controller.close();
        return;
      }

      // Heartbeat timer
      const heartbeat = setInterval(() => {
        if (signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(sseComment("keepalive")));
        } catch {
          // stream already closed
        }
      }, HEARTBEAT_INTERVAL_MS);

      function cleanup() {
        clearInterval(heartbeat);
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1000, "SSE client disconnected");
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      // Close WS when the SSE client disconnects
      signal.addEventListener("abort", cleanup, { once: true });

      // WebSocket event handlers
      ws.addEventListener("error", () => {
        if (signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(
              sseEvent("error", {
                message: "WebSocket connection to ComfyUI failed",
              }),
            ),
          );
        } catch {
          // ignore
        }
        cleanup();
      });

      ws.addEventListener("close", () => {
        if (!signal.aborted) {
          cleanup();
        }
      });

      // Per-stream prompt state. ComfyUI ends EVERY prompt with
      // `executing {node:null}` (main.py prompt_worker), including failed and
      // interrupted ones, so completion must be tracked, not inferred.
      const failedPrompts = new Set<string>();
      const finishedPrompts = new Set<string>();
      const titleLookups = new Set<string>();

      const titlesFor = (promptId: string): NodeTitles | undefined => {
        const titles = getPromptTitles(promptId);
        if (!titles && !titleLookups.has(promptId)) {
          boundedAdd(titleLookups, promptId);
          void loadPromptTitles(promptId);
        }
        return titles;
      };

      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      const complete = (promptId: string) => {
        if (failedPrompts.has(promptId) || finishedPrompts.has(promptId)) {
          return;
        }
        boundedAdd(finishedPrompts, promptId);
        emit("complete", { prompt_id: promptId });
      };

      ws.addEventListener("message", (event: MessageEvent) => {
        if (signal.aborted) return;
        // Binary frames (latent previews) are consumed by the browser hook.
        if (typeof event.data !== "string") return;

        let msg: { type: string; data: Record<string, unknown> };
        try {
          msg = JSON.parse(event.data) as typeof msg;
        } catch {
          return; // skip malformed frames
        }
        if (!msg || typeof msg !== "object" || !msg.data) return;

        const { type, data } = msg;

        try {
          switch (type) {
            case "execution_start": {
              const promptId = data.prompt_id as string | undefined;
              if (!promptId) break;
              failedPrompts.delete(promptId);
              finishedPrompts.delete(promptId);
              titlesFor(promptId);
              break;
            }

            case "progress": {
              // { prompt_id, value, max, node }
              const promptId = data.prompt_id as string | undefined;
              const value = data.value as number | undefined;
              const max = data.max as number | undefined;
              if (!promptId || value === undefined || max === undefined) break;
              const node = (data.node as string | undefined) ?? null;

              emit("progress", {
                prompt_id: promptId,
                node,
                step: value,
                max,
                label: node
                  ? nodeLabel(titlesFor(promptId), node)
                  : "Working",
              });
              break;
            }

            case "executing": {
              // { prompt_id, node, display_node } — node === null: prompt over
              const promptId = data.prompt_id as string | undefined;
              if (!promptId) break;

              const node = data.node as string | null | undefined;

              if (node === null || node === undefined) {
                complete(promptId);
              } else {
                const titles = titlesFor(promptId);
                const display = data.display_node as string | undefined;
                const label =
                  titles?.[node] ||
                  (display ? titles?.[display] : undefined) ||
                  `Node ${node}`;
                emit("executing", { prompt_id: promptId, node, label });
              }
              break;
            }

            case "execution_success": {
              const promptId = data.prompt_id as string | undefined;
              if (promptId) complete(promptId);
              break;
            }

            case "execution_error": {
              const promptId = data.prompt_id as string | undefined;
              if (promptId) boundedAdd(failedPrompts, promptId);
              const described = describeExecutionError(
                data,
                promptId ? getPromptTitles(promptId) : undefined,
              );

              emit("error", {
                prompt_id: promptId ?? null,
                message: described.message,
                raw_message: data.exception_message ?? null,
                exception_type: data.exception_type ?? null,
                node: data.node_id ?? null,
              });
              break;
            }

            case "execution_interrupted": {
              const promptId = data.prompt_id as string | undefined;
              if (promptId) boundedAdd(failedPrompts, promptId);
              const described = describeExecutionInterrupted(
                data,
                promptId ? getPromptTitles(promptId) : undefined,
              );
              emit("cancelled", {
                prompt_id: promptId ?? null,
                message: described.message,
                node: data.node_id ?? null,
              });
              break;
            }

            // All other message types (status, executed, execution_cached,
            // progress_state, feature_flags) are intentionally ignored at the
            // SSE layer — clients track higher-level state via the main WS
            // hook or polling.
            default:
              break;
          }
        } catch {
          // Never crash the stream on a bad message
        }
      });
    },

    cancel() {
      // ReadableStream cancelled by the runtime (client gone)
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent Next.js / proxies from buffering the stream
      "X-Accel-Buffering": "no",
    },
  });
}
