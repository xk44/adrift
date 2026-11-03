/**
 * POST /api/nevo/search
 * Proxies a NEvo evolutionary-search request to the Python backend and streams
 * its Server-Sent Events straight back to the browser (progress → result).
 */
import { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { guardRoute } from "@/lib/routeGuard";

// streaming — never cache, run on the node runtime
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = guardRoute(req, { max: 20 });
  if (!auth.ok) return auth.response;
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${env.NEVO_BACKEND_URL}/nevo/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      // Tie the upstream SSE to the browser connection: closing the tab
      // aborts the proxy fetch instead of leaving it streaming into nothing.
      signal: req.signal,
      // @ts-expect-error - Node fetch duplex needed for streaming request bodies
      duplex: "half",
    });
  } catch (e) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: `NEvo backend unreachable at ${env.NEVO_BACKEND_URL} — is it running? (${e instanceof Error ? e.message : e})` })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
      { status: 200, headers: sseHeaders() },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: `backend ${upstream.status}: ${detail.slice(0, 500)}` })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
      { status: 200, headers: sseHeaders() },
    );
  }

  return new Response(upstream.body, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}
