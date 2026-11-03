/**
 * "Add Adrift to ComfyUI" (the in-ComfyUI overlay pack).
 *
 * GET  -> { ok, status }  where status is
 *   { comfyLocal, comfyUrl, customNodesDir, customNodes, installed,
 *     configUrl, adriftUrl, loaded, loadedFrom, frameAllowed, remoteSteps }
 *   loaded: true/false from ComfyUI's GET /extensions (the bridge script is
 *   in the list), null when ComfyUI did not answer.
 * POST -> { ok, result, status }  links (copy on Windows / when linking
 *   fails) comfy_nodes/adrift_overlay into COMFY_ROOT/custom_nodes and writes
 *   the Adrift URL this browser used into its web/adrift_config.json. Never
 *   overwrites a real directory or a foreign link (409). Only for a ComfyUI
 *   on this machine (409 otherwise; the UI shows the remote steps).
 *   ComfyUI must be restarted afterwards; "Check again" re-polls GET.
 *
 * requireAdmin + rate limit; POST also passes the middleware's same-origin
 * check like every mutating route.
 */
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyFetch, comfyBaseUrl } from "@/lib/comfy/comfyFetch";
import {
  comfyIsLocalMachine,
  resolvedComfyRoot,
} from "@/lib/paths/resolveDirs";
import {
  OVERLAY_PACK,
  inspectOverlayPack,
  installOverlayPack,
  normalizeAdriftUrl,
  overlayScriptsLoaded,
  overlaySourceDir,
  readOverlayConfigUrl,
  remoteInstallSteps,
} from "@/lib/overlay/install";
import {
  frameAncestorsFromEnv,
  originAllowed,
  originOf,
} from "@/lib/overlay/frameAncestors";
import fs from "node:fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The Adrift origin this browser is using (Origin header, else the URL). */
function requestAdriftUrl(req: NextRequest): string | null {
  return (
    normalizeAdriftUrl(req.headers.get("origin")) ??
    normalizeAdriftUrl(req.nextUrl.origin)
  );
}

async function loadedScripts(): Promise<string[] | null> {
  try {
    const res = await comfyFetch("/extensions", {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return overlayScriptsLoaded(await res.json());
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function overlayStatus(req: NextRequest) {
  const comfyLocal = comfyIsLocalMachine();
  const comfyUrl = comfyBaseUrl();
  const adriftUrl = requestAdriftUrl(req);
  const customNodesDir = path.join(
    path.resolve(resolvedComfyRoot()),
    "custom_nodes",
  );
  const customNodes = comfyLocal && isDir(customNodesDir);
  const installed = customNodes
    ? inspectOverlayPack(customNodesDir, overlaySourceDir())
    : null;
  const configUrl =
    installed === "linked" || installed === "copy"
      ? readOverlayConfigUrl(path.join(customNodesDir, OVERLAY_PACK))
      : null;
  const scripts = await loadedScripts();
  const comfyOrigin = originOf(comfyUrl);
  return {
    comfyLocal,
    comfyUrl,
    customNodesDir: comfyLocal ? customNodesDir : null,
    customNodes,
    installed,
    configUrl,
    adriftUrl,
    loaded: scripts === null ? null : scripts.length > 0,
    loadedFrom: scripts ?? [],
    // Whether Adrift's CSP (built at startup) lets this ComfyUI frame it.
    frameAllowed: comfyOrigin
      ? originAllowed(frameAncestorsFromEnv(), comfyOrigin)
      : false,
    remoteSteps: remoteInstallSteps(adriftUrl),
  };
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  return NextResponse.json(
    { ok: true, status: await overlayStatus(req) },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  if (!comfyIsLocalMachine())
    return NextResponse.json(
      {
        ok: false,
        error:
          "ComfyUI runs on another machine. Copy the adrift_overlay folder there by hand.",
        status: await overlayStatus(req),
      },
      { status: 409, headers: NO_STORE },
    );

  const customNodesDir = path.join(
    path.resolve(resolvedComfyRoot()),
    "custom_nodes",
  );
  let result;
  try {
    result = installOverlayPack({
      customNodesDir,
      sourceDir: overlaySourceDir(),
      adriftUrl: requestAdriftUrl(req),
    });
  } catch (e) {
    result = {
      ok: false,
      state: "missing" as const,
      error: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const status = await overlayStatus(req);
  return NextResponse.json(
    result.ok
      ? { ok: true, result, status }
      : { ok: false, error: result.error, result, status },
    { status: result.ok ? 200 : 409, headers: NO_STORE },
  );
}
