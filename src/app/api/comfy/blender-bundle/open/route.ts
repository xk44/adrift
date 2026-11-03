/**
 * "Open in Blender" for local installs.
 *
 * GET  → { available, reason?, path?, version?, source? }  whether the
 *        button works here, and which Blender it would start
 * POST { files: [{ filename, subfolder?, type? }], camera?, aspect? }
 *    | { layers: { manifest, resolution?, aspect? } }
 *      → writes the Blender bundle to <output>/blender/<name>/ (Adrift's data
 *        folder when ComfyUI runs on another machine) and starts
 *        `blender --python <that folder>/import_<name>.py`.
 *
 * Loopback-only (lib/routeGuard), admin-guarded, 3 opens a minute. Blender
 * is found by lib/blender/detect (BLENDER_PATH, the Settings path, then
 * standard install paths) and started with an argv array, never a shell string; the script
 * path is built from a sanitized name inside a resolved output folder.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { env } from "@/lib/env";
import { guardRoute, loopbackOnly } from "@/lib/routeGuard";
import { blenderBundleZip } from "@/lib/mesh/blenderBundle";
import {
  BundleFetchError,
  blenderSourceFromBody,
  loadBlenderSource,
} from "@/lib/mesh/blenderBundleServer";
import { detectBlender, findBlender } from "@/lib/blender/detect";
import { resolveOutputPath } from "@/lib/mesh/usdz";
import {
  adriftDataDir,
  comfyIsLocalMachine,
  comfyOutputDir,
} from "@/lib/paths/resolveDirs";

const MAX_BODY = 8192;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const headers = apiCorsHeaders(request);
  if (!loopbackOnly(request).ok)
    return NextResponse.json(
      { ok: true, available: false, reason: "remote" },
      { headers },
    );
  const guard = guardRoute(request, { max: 60 });
  if (!guard.ok) return guard.response;
  const blender = await detectBlender();
  const available = Boolean(blender.path);
  return NextResponse.json(
    {
      ok: true,
      available,
      ...(available ? {} : { reason: "no-blender" }),
      ...blender,
    },
    { headers },
  );
}

/** Where opened bundles are written: ComfyUI's output folder when it is on this disk. */
function bundleRoot(): string {
  return comfyIsLocalMachine()
    ? comfyOutputDir(env.COMFY_ROOT)
    : adriftDataDir();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const local = loopbackOnly(request);
  if (!local.ok) return local.response;
  const guard = guardRoute(request, { max: 3 });
  if (!guard.ok) return guard.response;
  const headers = apiCorsHeaders(request);

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY)
    return apiError("Payload too large", { status: 413, headers });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON body", { status: 400, headers });
  }
  const source = blenderSourceFromBody(body);
  if (!source)
    return apiError(
      "Pass files (1-8 3D output files) or layers (a Layer Split manifest)",
      { status: 400, headers },
    );

  const blender = findBlender();
  if (!blender)
    return apiError("Blender not found. Install it, or set its path in Settings or BLENDER_PATH.", {
      status: 409,
      headers,
    });

  let bundle;
  try {
    bundle = await loadBlenderSource(source);
  } catch (err) {
    if (err instanceof BundleFetchError)
      return apiError(err.message, { status: err.status, headers });
    return apiError("Blender export failed", { status: 500, headers });
  }

  // Write every file through resolveOutputPath: stays inside the root, no
  // symlinked parents or targets. Paths come from the sanitized bundle.
  const root = bundleRoot();
  const folder = `blender/${bundle.name}`;
  let scriptAbs: string | null = null;
  try {
    for (const f of bundle.files) {
      const parts = f.path.split("/");
      const name = parts.pop()!;
      const sub = [folder, ...parts].join("/");
      const abs = resolveOutputPath(root, name, sub);
      if (!abs) throw new Error(`unsafe path ${f.path}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.data);
      if (f.path === bundle.scriptName) scriptAbs = abs;
    }
    // Keep the zip too, for sharing the same bundle later.
    const zipAbs = resolveOutputPath(
      root,
      `${bundle.name}_blender.zip`,
      "blender",
    );
    if (zipAbs) fs.writeFileSync(zipAbs, blenderBundleZip(bundle));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError(`Could not write the bundle: ${message}`, {
      status: 500,
      headers,
    });
  }
  if (!scriptAbs)
    return apiError("Could not write the bundle", { status: 500, headers });

  const started = await new Promise<
    { ok: true } | { ok: false; error: string }
  >((resolve) => {
    try {
      const child = spawn(blender, ["--python", scriptAbs!], {
        cwd: path.dirname(scriptAbs!),
        detached: true,
        stdio: "ignore",
      });
      child.once("error", (err) => resolve({ ok: false, error: err.message }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  if (!started.ok)
    return apiError(`Could not start Blender: ${started.error}`, {
      status: 500,
      headers,
    });

  return apiOk(
    { folder: path.dirname(scriptAbs), script: bundle.scriptName },
    { headers },
  );
}
