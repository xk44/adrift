/**
 * GET /api/comfy/prompt-status?ids=a,b,c
 *
 * -> { ok, statuses: { [promptId]: { state, error? } } }
 *
 * state: queued | running | done | error | cancelled | missing | unknown.
 * Queue of every backend first, then history on any backend. "missing" =
 * every queue was readable and no backend has history for it (ComfyUI
 * restarted, or the prompt was deleted from the queue); "unknown" = some
 * backend could not be read. The client reconciles pending tiles with this
 * on socket (re)connect and on a slow interval (hooks/useComfyWS).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { promptStatuses } from "@/lib/comfy/queueState";

export const dynamic = "force-dynamic";

const MAX_IDS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  const raw = req.nextUrl.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => ID_RE.test(id)))
    return NextResponse.json(
      { ok: false, error: `ids must be 1-${MAX_IDS} prompt ids` },
      { status: 400 },
    );
  const statuses = await promptStatuses(ids);
  return NextResponse.json(
    { ok: true, statuses },
    { headers: { "Cache-Control": "no-store" } },
  );
}
