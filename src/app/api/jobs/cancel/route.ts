import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiError, apiOptions } from "@/lib/api";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { deleteFromQueue } from "@/lib/comfy/http";
import { getComfyCapabilities } from "@/lib/comfy/capabilities";
import {
  defaultBackendUrl,
  knownPromptBackend,
  otherBackendUrls,
} from "@/lib/comfy/backends";
import { withJudge } from "@/lib/judge/judgeServer";

/**
 * "confirm-global-interrupt": the prompt is running but the server predates
 * targeted interrupt (ComfyUI < 0.3.57), so /interrupt would stop whatever is
 * running. Nothing was done; resend with {confirm_global: true} to proceed.
 */
type CancelAction =
  | "queue-delete"
  | "interrupt"
  | "not-found"
  | "confirm-global-interrupt";

interface ComfyQueue {
  queue_running?: unknown[];
  queue_pending?: unknown[];
}

function queueItemHasPromptId(item: unknown, promptId: string): boolean {
  if (item === promptId) return true;
  if (Array.isArray(item)) return item.some((part) => queueItemHasPromptId(part, promptId));
  if (item && typeof item === "object") {
    return Object.values(item).some((value) => queueItemHasPromptId(value, promptId));
  }
  return false;
}

function queueHasPrompt(items: unknown[] | undefined, promptId: string): boolean {
  return (items ?? []).some((item) => queueItemHasPromptId(item, promptId));
}

async function handlePost(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  let promptId: string;
  let confirmGlobal = false;
  try {
    const body = (await req.json()) as {
      prompt_id?: unknown;
      confirm_global?: unknown;
    };
    promptId = typeof body.prompt_id === "string" ? body.prompt_id.trim() : "";
    confirmGlobal = body.confirm_global === true;
  } catch {
    return apiError("Invalid JSON body", { status: 400 });
  }

  if (!promptId) {
    return apiError("Missing prompt_id", { status: 400 });
  }

  try {
    // Multi-host: the backend the prompt was queued on first, then the rest.
    const main = defaultBackendUrl();
    const bases = [
      ...new Set(
        [knownPromptBackend(promptId), main, ...otherBackendUrls()].filter(
          (u): u is string => !!u,
        ),
      ),
    ];
    let action: CancelAction = "not-found";

    for (const base of bases) {
      let queueRes: Response;
      try {
        queueRes = await comfyFetch("/queue", {
          baseUrl: base,
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        if (base === main) throw error;
        continue; // a down secondary host can't hold the prompt
      }
      if (!queueRes.ok) {
        if (base !== main) continue;
        return apiError(`ComfyUI returned ${queueRes.status}`, { status: 502 });
      }

      const queue = (await queueRes.json()) as ComfyQueue;

      if (queueHasPrompt(queue.queue_pending, promptId)) {
        if (base === main) await deleteFromQueue(promptId);
        else await deleteFromQueue(promptId, base);
        action = "queue-delete";
        break;
      }
      if (queueHasPrompt(queue.queue_running, promptId)) {
        // Capabilities are probed on the default host; a separate video
        // host is assumed current (targeted interrupt, ComfyUI >= 0.3.57).
        const targeted =
          base === main ? (await getComfyCapabilities()).interruptPromptId : true;
        if (!targeted && !confirmGlobal) {
          const caps = await getComfyCapabilities();
          return NextResponse.json({
            ok: true,
            action: "confirm-global-interrupt" satisfies CancelAction,
            prompt_id: promptId,
            comfyui_version: caps.comfyuiVersion,
          });
        }
        const interruptRes = await comfyFetch("/interrupt", {
          baseUrl: base,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Targeted interrupt: ComfyUI only stops this prompt if it is the
          // one running, so another client's job is never killed. Older
          // servers ignore the body (global interrupt, confirmed above).
          body: JSON.stringify(targeted ? { prompt_id: promptId } : {}),
          signal: AbortSignal.timeout(5000),
        });
        if (!interruptRes.ok) {
          return apiError(`ComfyUI returned ${interruptRes.status}`, {
            status: 502,
          });
        }
        action = "interrupt";
        break;
      }
    }

    return NextResponse.json({ ok: true, action, prompt_id: promptId });
  } catch {
    return apiError("ComfyUI unreachable", { status: 503 });
  }
}

export function OPTIONS() {
  return apiOptions();
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const POST = withJudge("cancel", handlePost);
