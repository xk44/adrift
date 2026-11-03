import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { withRateLimit } from "@/lib/rateLimit";
import { requireAdmin } from "@/lib/auth";
import { isAllowedCivitaiImageUrl } from "@/lib/validate";
import { apiCorsHeaders } from "@/lib/api";
import { DownloadError, downloadToFile } from "@/lib/net/downloadToFile";
import {
  SafeDestError,
  finalizeTemp,
  resolveContainedDir,
  tempPathFor,
  uniqueName,
  validateLeafName,
} from "@/lib/fs/safeDest";
import { comfyOutputDir } from "@/lib/paths/resolveDirs";

const MAX_BYTES = 524_288;
const MAX_SAVED_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"];

const CORS_HEADERS = apiCorsHeaders(null, "POST, OPTIONS");

interface SaveImageBody {
  url: string;
  filename?: string;
}

function allowImageHost(hostname: string): boolean {
  return isAllowedCivitaiImageUrl(`https://${hostname}/`);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;

  const contentLength = parseInt(
    request.headers.get("content-length") || "0",
    10,
  );
  if (contentLength > MAX_BYTES)
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413, headers: CORS_HEADERS },
    );

  let body: SaveImageBody;
  try {
    body = (await request.json()) as SaveImageBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const { url, filename } = body;

  if (!url || typeof url !== "string" || !isAllowedCivitaiImageUrl(url)) {
    return NextResponse.json(
      { ok: false, error: "url must be an https:// Civitai image URL" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const rawFilename =
    (typeof filename === "string" && filename) ||
    path.basename(new URL(url).pathname) ||
    `civitai-${Date.now()}.png`;

  let leaf: string;
  try {
    leaf = validateLeafName(path.basename(rawFilename), IMAGE_EXTS);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `Invalid filename: ${(error as Error).message}` },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  let tmpPath: string | null = null;
  try {
    // realpath containment: output/explore may not be a link out of output/.
    const destDir = await resolveContainedDir(
      path.resolve(comfyOutputDir(env.COMFY_ROOT)),
      ["explore"],
    );
    tmpPath = tempPathFor(destDir, leaf);
    await downloadToFile({
      url,
      dest: tmpPath,
      allowHost: allowImageHost,
      headersFor: () => ({ "User-Agent": "Adrift/1.0" }),
      maxBytes: MAX_SAVED_IMAGE_BYTES,
      maxRedirects: 3,
      idleMs: 30_000,
      signal: request.signal,
    });
    // Never replace an existing image: pick image-2.png etc. instead.
    let finalName = await uniqueName(destDir, leaf);
    try {
      await finalizeTemp(tmpPath, path.join(destDir, finalName));
    } catch (error) {
      if (!(error instanceof SafeDestError) || error.code !== "exists") throw error;
      finalName = await uniqueName(destDir, leaf);
      await finalizeTemp(tmpPath, path.join(destDir, finalName));
    }
    tmpPath = null;

    return NextResponse.json(
      { ok: true, path: path.join(destDir, finalName) },
      { headers: CORS_HEADERS },
    );
  } catch (error) {
    if (tmpPath) await unlink(tmpPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof SafeDestError
        ? 400
        : error instanceof DownloadError
          ? error.code === "too_large"
            ? 413
            : error.code === "host" || error.code === "redirects"
              ? 400
              : 502
          : 500;
    console.error("[CivitaiAPI] save-image failed:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status, headers: CORS_HEADERS },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
