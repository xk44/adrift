/**
 * Client side of POST /api/jobs/cancel, shared by the queue drawer.
 *
 * Mirrors the Create feed's per-tile cancel: a pending prompt is deleted from
 * the ComfyUI queue, a running one is interrupted (targeted). Old ComfyUI
 * (< 0.3.57) can only interrupt globally, so the route answers
 * "confirm-global-interrupt" and we ask before resending with confirm_global.
 */

export type CancelOutcome =
  /** Removed from the queue or interrupted: mark the job cancelled. */
  | "cancelled"
  /** ComfyUI no longer holds the prompt (it just finished or vanished). */
  | "not-found"
  /** The user declined a global interrupt; nothing was done. */
  | "declined";

interface CancelResponse {
  ok?: boolean;
  action?: string;
  error?: string;
  comfyui_version?: string | null;
}

export interface CancelJobDeps {
  fetchImpl?: typeof fetch;
  /** Asked before a global interrupt; resolve true to proceed. */
  confirmGlobalInterrupt: (comfyuiVersion: string | null) => Promise<boolean>;
}

export async function requestJobCancel(
  promptId: string,
  { fetchImpl = fetch, confirmGlobalInterrupt }: CancelJobDeps,
): Promise<CancelOutcome> {
  const post = async (confirmGlobal: boolean): Promise<CancelResponse> => {
    const res = await fetchImpl("/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt_id: promptId,
        ...(confirmGlobal ? { confirm_global: true } : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as CancelResponse | null;
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `Cancel failed (${res.status})`);
    }
    return data;
  };

  let data = await post(false);
  if (data.action === "confirm-global-interrupt") {
    const ok = await confirmGlobalInterrupt(data.comfyui_version ?? null);
    if (!ok) return "declined";
    data = await post(true);
  }
  return data.action === "queue-delete" || data.action === "interrupt"
    ? "cancelled"
    : "not-found";
}
