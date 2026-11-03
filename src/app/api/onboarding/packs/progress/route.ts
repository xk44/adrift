/**
 * GET /api/onboarding/packs/progress?packs=<id,id>[&stream=1]
 *
 * How far the starter-pack download has got, checked by the server against
 * the connected ComfyUI (src/lib/onboarding/packProgress.ts). The browser
 * never talks to the ComfyUI host, so this works for local, LAN and remote
 * (WAN, token) connections alike.
 *
 *   stream=1 -> Server-Sent Events (same framing as /api/comfy/progress):
 *     event: progress  -> PackProgress, sent when something changed
 *     event: complete  -> PackProgress, every file is in ComfyUI; stream ends
 *     event: timeout   -> stream hit its time limit; the client polls instead
 *     `:keepalive` comment every 30 s
 *   otherwise -> one JSON snapshot { ok, progress } (the polling fallback)
 *
 * Read-only: never downloads anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  parsePackIds,
  progressChanged,
  readPackProgress,
  type PackProgress,
} from "@/lib/onboarding/packProgress";

export const dynamic = "force-dynamic";

/** Poll interval inside the stream (ComfyUI listing reads, all read-only). */
const STREAM_POLL_MS = 4_000;
const HEARTBEAT_MS = 30_000;
/** Long downloads keep going via the client's polling fallback. */
const STREAM_MAX_MS = 30 * 60_000;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const stream = req.nextUrl.searchParams.get("stream") === "1";
  const rl = withRateLimit(req, {
    windowMs: 60_000,
    max: stream ? 20 : 60,
  });
  if (!rl.ok) return rl.response;
  const ids = parsePackIds(req.nextUrl.searchParams.get("packs"));
  if (!ids)
    return NextResponse.json(
      { ok: false, error: "packs must list starter pack ids" },
      { status: 400 },
    );

  if (!stream) {
    const progress = await readPackProgress(ids);
    return NextResponse.json({ ok: true, progress });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const { signal } = abort;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          abort.abort();
        }
      };
      const heartbeat = setInterval(() => send(":keepalive\n\n"), HEARTBEAT_MS);
      const started = Date.now();
      let last: PackProgress | null = null;
      try {
        while (!signal.aborted) {
          const snap = await readPackProgress(ids);
          if (signal.aborted) break;
          if (snap.complete) {
            send(sseEvent("complete", snap));
            break;
          }
          if (progressChanged(last, snap)) {
            send(sseEvent("progress", snap));
            last = snap;
          }
          if (Date.now() - started > STREAM_MAX_MS) {
            send(sseEvent("timeout", { ms: STREAM_MAX_MS }));
            break;
          }
          await sleep(STREAM_POLL_MS, signal);
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
