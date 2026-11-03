/**
 * GET /api/comfy/image
 * Proxies images from ComfyUI to avoid CORS issues
 * Query params: filename, subfolder, type
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchImageResponse } from "@/lib/comfy/http";
import { apiCorsHeaders, apiLog } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { withJudge } from "@/lib/judge/judgeServer";

// Cache control for generated images
const CACHE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const MAX_IMAGE_PARAM_LENGTH = 255;
const ALLOWED_TYPES = new Set(["output", "input", "temp"]);
const CORS_METHODS = "GET, OPTIONS";
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function corsHeaders(request: NextRequest): HeadersInit {
  return apiCorsHeaders(request, CORS_METHODS);
}

function jsonError(
  request: NextRequest,
  error: string,
  status: number,
): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: corsHeaders(request) },
  );
}

function validateFilename(value: string | null): string | { error: string } {
  if (!value || value.trim().length === 0)
    return { error: "Missing filename parameter" };
  if (value.length > MAX_IMAGE_PARAM_LENGTH)
    return { error: "Invalid filename" };
  if (
    CONTROL_CHAR_RE.test(value) ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    return { error: "Invalid filename" };
  }
  return value;
}

function validateSubfolder(value: string): string | { error: string } {
  if (!value) return "";
  if (
    value.length > MAX_IMAGE_PARAM_LENGTH ||
    CONTROL_CHAR_RE.test(value) ||
    value.includes("\\")
  ) {
    return { error: "Invalid subfolder" };
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(".."),
    )
  ) {
    return { error: "Invalid subfolder" };
  }
  return value;
}

function validateType(value: string): string | { error: string } {
  if (!ALLOWED_TYPES.has(value)) return { error: "Invalid type parameter" };
  return value;
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function contentDispositionFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, "_");
}

/**
 * Detect MIME type from filename. The history route points videos, meshes,
 * and audio at this proxy too (Gallery/Lightbox feed them to <video>/<audio>),
 * so map every media type ComfyUI emits — not just stills.
 */
function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    // OpenEXR masters (SaveImageAdvanced): downloads, not browser images.
    exr: "application/octet-stream",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/mp4",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    glb: "model/gltf-binary",
    usdz: "model/vnd.usdz+zip",
    obj: "text/plain",
    // Gaussian splats (TripoSplat) and BVH motion (SAM 3D Body): downloads.
    ply: "application/octet-stream",
    spz: "application/octet-stream",
    ksplat: "application/octet-stream",
    splat: "application/octet-stream",
    bvh: "text/plain",
    json: "application/json",
    svg: "image/svg+xml",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
  };
  return mimeTypes[ext ?? "png"] ?? "image/png";
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

async function handleGet(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many requests" },
      {
        status: 429,
        headers: { ...corsHeaders(request), "Retry-After": "60" },
      },
    );
  }

  const { searchParams } = new URL(request.url);

  const filename = validateFilename(searchParams.get("filename"));
  if (hasError(filename)) return jsonError(request, filename.error, 400);

  const subfolder = validateSubfolder(searchParams.get("subfolder") ?? "");
  if (hasError(subfolder)) return jsonError(request, subfolder.error, 400);

  const type = validateType(searchParams.get("type") ?? "output");
  if (hasError(type)) return jsonError(request, type.error, 400);

  apiLog("ImageProxy", `Fetching: ${filename} (${subfolder}/${type})`);

  try {
    // Forward Range requests so <video> seeking works; pass 206 through.
    const range = request.headers.get("range");
    const imageResponse = await fetchImageResponse(
      filename,
      subfolder,
      type,
      range,
    );
    const mimeType = getMimeType(filename);
    const contentLength = imageResponse.headers.get("content-length");

    apiLog(
      "ImageProxy",
      `Serving ${filename}: ${contentLength ?? "unknown"} bytes, ${mimeType}`,
    );

    const headers = new Headers(corsHeaders(request));
    headers.set("Content-Type", mimeType);
    // SVG is a document that can carry script: render it inert when opened directly.
    if (mimeType === "image/svg+xml") {
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      headers.set("X-Content-Type-Options", "nosniff");
    }
    // Only `output` files are write-once (ComfyUI auto-increments names).
    // `temp` is wiped on ComfyUI restart and its counters restart, and
    // `input` uploads overwrite same-named files — caching those as
    // immutable serves stale previews/masks for a week.
    headers.set(
      "Cache-Control",
      type === "output"
        ? `private, max-age=${CACHE_MAX_AGE}, immutable`
        : "private, no-cache",
    );
    headers.set(
      "Content-Disposition",
      `inline; filename="${contentDispositionFilename(filename)}"`,
    );
    if (contentLength) headers.set("Content-Length", contentLength);
    const contentRange = imageResponse.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
    const acceptRanges = imageResponse.headers.get("accept-ranges");
    if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);

    return new NextResponse(imageResponse.body, {
      status: imageResponse.status,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ImageProxy] Error fetching ${filename}:`, message);

    return jsonError(request, message, 500);
  }
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const GET = withJudge("image", handleGet);
