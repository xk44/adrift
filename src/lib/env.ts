/**
 * Centralized environment config. Import this instead of reading process.env directly.
 * Server-side only — do not import from client components.
 */
import path from "path";
import fs from "fs";
import { initBonjour } from "@/lib/bonjour";
import { adminKeyNotice, resolveBindHost } from "@/lib/bindHost";
import { runtimeComfyHttpUrl, wsBaseFromHttp } from "@/lib/runtimeSettings";
import { resolvedComfyRoot } from "@/lib/paths/resolveDirs";

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function opt(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

export const env = {
  /**
   * Read per access: explicit env COMFY_HTTP_URL wins, then the URL saved by
   * the first-run wizard (data/runtime_settings.json), then the default.
   */
  get COMFY_HTTP_URL(): string {
    return (
      process.env.COMFY_HTTP_URL?.trim() ||
      runtimeComfyHttpUrl() ||
      "http://127.0.0.1:8188"
    );
  },
  /** Explicit env COMFY_WS_BASE, else derived from the saved URL, else default. */
  get COMFY_WS_BASE(): string {
    const explicit = process.env.COMFY_WS_BASE?.trim();
    if (explicit) return explicit;
    const saved = runtimeComfyHttpUrl();
    return saved ? wsBaseFromHttp(saved) : "ws://127.0.0.1:8188";
  },
  /**
   * ComfyUI install folder, read per access: env COMFY_ROOT wins, then the
   * folder saved in the setup wizard / Settings, then ../ComfyUI. The models /
   * input / output / data folders resolve in lib/paths/resolveDirs.ts.
   */
  get COMFY_ROOT(): string {
    return resolvedComfyRoot();
  },
  KREA2_BACKEND_URL: opt("KREA2_BACKEND_URL", "http://127.0.0.1:8787"),
  NEVO_BACKEND_URL: opt("NEVO_BACKEND_URL", "http://127.0.0.1:8791"),
  COMFY_DEFAULT_CHECKPOINT: process.env.COMFY_DEFAULT_CHECKPOINT?.trim() || "",
  CIVITAI_API_URL: opt("CIVITAI_API_URL", "https://civitai.com/api/v1"),
  CIVITAI_API_KEY: process.env.CIVITAI_API_KEY?.trim() || "",
  CIVITAI_API_KEY_ENCRYPTED:
    process.env.CIVITAI_API_KEY_ENCRYPTED?.trim() || "",
  SECRETS_PASSPHRASE: process.env.SECRETS_PASSPHRASE?.trim() || "",
  STYLEVAULT_API_URL: opt("STYLEVAULT_API_URL", "http://127.0.0.1:8000"),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY?.trim() || "",
  // Read on every access (getters), so tests and long-lived modules see the
  // current value. Empty string = unset; callers apply their own default.
  /** Local Krea moodboard export (default ~/krea-moodboards). */
  get KREA_MOODBOARDS_DIR(): string {
    return process.env.KREA_MOODBOARDS_DIR?.trim() || "";
  },
  /** Folder moodboard auto-sort may import from (default: home directory). */
  get MOODBOARD_IMPORT_ROOT(): string {
    return process.env.MOODBOARD_IMPORT_ROOT?.trim() || "";
  },
  /**
   * Raw env ComfyUI output folder ("" = unset). Consumers use
   * comfyOutputDir() from lib/paths/resolveDirs.ts, which applies it.
   */
  get COMFYUI_OUTPUT_DIR(): string {
    return process.env.COMFYUI_OUTPUT_DIR?.trim() || "";
  },
} as const;

/**
 * Startup validation — logs warnings for missing config or unreachable deps.
 * Called once on first import. Non-throwing; production will degrade gracefully.
 */
let _startupChecked = false;
export function runStartupChecks(): void {
  if (_startupChecked) return;
  _startupChecked = true;

  const warn = (msg: string) => console.warn(`[adrift] ⚠ ${msg}`);

  if (!fs.existsSync(env.COMFY_ROOT)) {
    warn(
      `COMFY_ROOT directory not found: ${env.COMFY_ROOT} — generation will fail until ComfyUI is installed`,
    );
  }

  const workflowsDir = path.join(
    env.COMFY_ROOT,
    "user",
    "default",
    "workflows",
  );
  if (fs.existsSync(env.COMFY_ROOT) && !fs.existsSync(workflowsDir)) {
    // Normal on a fresh ComfyUI: the folder appears once a workflow is saved.
    console.info(
      `[adrift] No saved ComfyUI workflows yet (${workflowsDir}). The folder appears after you save a workflow in ComfyUI.`,
    );
  }

  // No ADMIN_API_KEY means every route is open. Fine on loopback; warn
  // only when the server may be reachable from other machines.
  const adminNotice = adminKeyNotice(
    resolveBindHost(),
    !!process.env.ADMIN_API_KEY?.trim(),
  );
  if (adminNotice) console.warn(adminNotice.text);

  // Async ComfyUI connectivity check (non-blocking)
  // Inline bearer (not comfyFetch): comfyFetch imports this module.
  const bearer = process.env.COMFY_BEARER?.trim();
  fetch(`${env.COMFY_HTTP_URL}/system_stats`, {
    signal: AbortSignal.timeout(3000),
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  })
    .then((r) => {
      if (!r.ok)
        warn(
          `ComfyUI responded with status ${r.status} at ${env.COMFY_HTTP_URL}`,
        );
    })
    .catch(() => {
      warn(
        `ComfyUI unreachable at ${env.COMFY_HTTP_URL} — start ComfyUI for generation support`,
      );
    });
}

// Run checks on module load (server-side only, skipped in tests)
if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "test" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  initBonjour();
  runStartupChecks();
}
