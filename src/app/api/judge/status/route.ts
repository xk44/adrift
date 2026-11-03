/**
 * GET /api/judge/status (judge mode only; 404 otherwise)
 * The calling judge's quota, queue state, allowed tool cards and their own
 * outputs (nothing from other judges or the local gallery).
 */
import { NextRequest, NextResponse } from "next/server";
import { JUDGE_CARD_KEYS, isJudgeMode } from "@/lib/judge/judgePolicy";
import {
  judgeFromRequest,
  judgeOutputs,
  judgePaused,
  judgeUsage,
  queueSnapshot,
  withJudge,
} from "@/lib/judge/judgeServer";

async function handleGet(req: NextRequest): Promise<NextResponse> {
  const judgeId = isJudgeMode() ? judgeFromRequest(req) : null;
  if (!judgeId)
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const { used, quota } = judgeUsage(judgeId);
  return NextResponse.json(
    {
      ok: true,
      judge: true,
      used,
      quota,
      remaining: Math.max(0, quota - used),
      paused: judgePaused(),
      queue: queueSnapshot(judgeId),
      cards: JUDGE_CARD_KEYS,
      outputs: judgeOutputs(judgeId).slice(0, 100),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withJudge("status", handleGet);
