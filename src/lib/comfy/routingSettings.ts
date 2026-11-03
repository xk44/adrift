/**
 * Saved job-routing preferences (runtime_settings.json `comfyRouting`):
 *  - auto: pick the machine per job by capability (nodes, model files,
 *    device) + health + queue length + priority (src/lib/comfy/router.ts);
 *  - pins: tool key (action / pack / tool id) -> settings id of the machine
 *    that always runs it ("main", "video" or a saved instance id);
 *  - priorities: settings id -> -10..10; each point outweighs one queued job.
 *
 * Client-safe: no fs / node imports.
 */
export interface ComfyRoutingSetting {
  auto?: boolean;
  pins?: Record<string, string>;
  priorities?: Record<string, number>;
}

export const PIN_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const PRIORITY_MIN = -10;
export const PRIORITY_MAX = 10;
const MAX_PINS = 64;

export function isPinKey(v: unknown): v is string {
  return typeof v === "string" && PIN_KEY_RE.test(v);
}

export function isRoutingTarget(v: unknown): v is string {
  return typeof v === "string" && TARGET_RE.test(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validate a parsed `comfyRouting`; null when nothing usable is left. */
export function sanitizeComfyRouting(raw: unknown): ComfyRoutingSetting | null {
  if (!isRecord(raw)) return null;
  const out: ComfyRoutingSetting = {};
  if (typeof raw.auto === "boolean") out.auto = raw.auto;
  if (isRecord(raw.pins)) {
    const pins: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.pins)) {
      if (Object.keys(pins).length >= MAX_PINS) break;
      if (isPinKey(k) && isRoutingTarget(v)) pins[k] = v;
    }
    if (Object.keys(pins).length > 0) out.pins = pins;
  }
  if (isRecord(raw.priorities)) {
    const pr: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.priorities)) {
      if (!isRoutingTarget(k) || typeof v !== "number" || !Number.isInteger(v))
        continue;
      if (v < PRIORITY_MIN || v > PRIORITY_MAX || v === 0) continue;
      pr[k] = v;
    }
    if (Object.keys(pr).length > 0) out.priorities = pr;
  }
  return Object.keys(out).length > 0 ? out : null;
}
