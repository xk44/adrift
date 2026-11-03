/**
 * Browser-side submit guard: memory preflight + free-on-family-switch.
 *
 * Called by useImagine right before POST /api/jobs/imagine:
 *   1. resolve the pack the submit will hit (same routing inputs as the route)
 *   2. GET /api/comfy/system (read-only /system_stats) -> preflight
 *      exceeds -> confirm(); tight -> toast; low memory -> append --lowvram
 *      (auto tiled VAE) unless the user pinned tiled VAE on/off
 *   3. on an actual family switch, POST /api/comfy/system {action:"free"}
 *      BEFORE the new prompt is queued
 * Every network failure degrades to "proceed unchanged".
 */

import { parseImagineInput } from "@/lib/oj/parser";
import { getPackForCheckpoint } from "@/lib/oj/packs";
import {
  parseSystemStats,
  preflightMemory,
  packFamilyGroup,
  resolveSubmitPackId,
  shouldFreeOnSwitch,
  type PreflightResult,
} from "./memory";

export interface SubmitGuardSettings {
  memoryPreflight?: boolean;
  freeOnFamilySwitch?: boolean;
  tiledVae?: "auto" | "on" | "off";
  videoModel?: string;
}

export interface SubmitGuardDeps {
  fetchImpl?: typeof fetch;
  confirmImpl?: (message: string) => boolean;
  notify?: (message: string, type: "info" | "warning") => void;
  /** Previously submitted pack (defaults to the module-level tracker). */
  previousPackId?: string | null;
}

export interface SubmitGuardResult {
  proceed: boolean;
  prompt: string;
  packId?: string;
  preflight?: PreflightResult;
  freed: boolean;
}

let lastSubmittedPackId: string | null = null;

export function getLastSubmittedPackId(): string | null {
  return lastSubmittedPackId;
}

/** Record the pack of a submit that the server accepted. */
export function noteSubmittedPack(packId: string | undefined | null): void {
  if (packId) lastSubmittedPackId = packId;
}

export function resetSubmitGuardForTests(): void {
  lastSubmittedPackId = null;
}

const TILED_FLAG_RE =
  /(^|\s)--(tiledvae|tiled-vae|tiledvae-off|untiledvae|tilesize|tile-size|lowvram)(\s|$)/i;

export async function runSubmitMemoryGuard(
  prompt: string,
  workflowPath: string | null | undefined,
  settings: SubmitGuardSettings,
  deps: SubmitGuardDeps = {},
): Promise<SubmitGuardResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const previous =
    deps.previousPackId !== undefined
      ? deps.previousPackId
      : lastSubmittedPackId;
  const { params } = parseImagineInput(prompt);
  const packId = resolveSubmitPackId({
    params,
    workflowPath,
    checkpointFamilyToPack: (ckpt) => getPackForCheckpoint(ckpt).id,
    defaultVideoPack: settings.videoModel,
  });
  const out: SubmitGuardResult = {
    proceed: true,
    prompt,
    packId,
    freed: false,
  };
  if (!packId) return out;

  if (settings.memoryPreflight !== false) {
    try {
      const res = await fetchImpl("/api/comfy/system", {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const snapshot = parseSystemStats(await res.json());
        const megapixels = params.hd ? 1.6 : 1;
        const pf = preflightMemory(snapshot, packId, {
          megapixels,
          sameFamilyResident:
            !!previous && packFamilyGroup(previous) === packFamilyGroup(packId),
        });
        out.preflight = pf;
        if (pf.level === "exceeds" && pf.message) {
          const ok = (deps.confirmImpl ?? ((m) => window.confirm(m)))(
            `${pf.message}\n\nSubmit anyway?`,
          );
          if (!ok) return { ...out, proceed: false };
        } else if (pf.level === "tight" && pf.message) {
          deps.notify?.(pf.message, "warning");
        }
        if (
          pf.lowVram &&
          (settings.tiledVae ?? "auto") === "auto" &&
          !TILED_FLAG_RE.test(out.prompt)
        ) {
          out.prompt = `${out.prompt} --lowvram`;
        }
      }
    } catch {
      // preflight is advisory; never block a submit on it
    }
  }

  if (
    shouldFreeOnSwitch(previous, packId, settings.freeOnFamilySwitch !== false)
  ) {
    try {
      const res = await fetchImpl("/api/comfy/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "free" }),
        signal: AbortSignal.timeout(15000),
      });
      out.freed = res.ok;
      if (res.ok) {
        deps.notify?.(
          `Unloaded ${previous} models before switching to ${packId}`,
          "info",
        );
      }
    } catch {
      // ComfyUI's own eviction still works; just slower to reclaim
    }
  }
  return out;
}
