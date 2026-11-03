/**
 * Catch-all ComfyUI proxy route
 * Proxies GET/POST requests to the ComfyUI backend.
 * Specific routes (history, image, models, workflows) take precedence via
 * Next.js route resolution order (static > dynamic > catch-all).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  BackendBusyError,
  backendUrlForSubfolder,
  withExclusiveBackend,
} from "@/lib/comfy/backends";
import { ComfyAPIError, fetchImageResponse } from "@/lib/comfy/http";
import { capBytes, safeProxiedTypeHeaders } from "@/lib/net/safeContentType";

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PROXY_QUERY_LENGTH = 2048;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]{1,128}$/;

const ALLOWED_GET_PATHS = new Set([
  "extensions",
  "features",
  "history",
  "object_info",
  "prompt",
  "queue",
  "system_stats",
  "view",
]);

// Uploads go through /api/comfy/upload (safe names/subfolders), not here.
const ALLOWED_POST_PATHS = new Set(["prompt"]);

/** Response headers worth keeping on a proxied /view body. */
const VIEW_PASS_HEADERS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

// Headers that must not be forwarded upstream. The catch-all proxy is an admin
// convenience tunnel; never leak app auth/session headers into ComfyUI.
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const BLOCKED_FORWARD_HEADERS = new Set([
  "host",
  ...Array.from(HOP_BY_HOP_RESPONSE_HEADERS),
  "authorization",
  "cookie",
  "x-api-key",
  "x-admin-api-key",
  "x-csrf-token",
]);

function withCors(response: NextResponse, req: NextRequest): NextResponse {
  for (const [key, value] of Object.entries(apiCorsHeaders(req))) {
    response.headers.set(key, value as string);
  }
  return response;
}

function validateProxyPath(pathSegments: string[]): string | null {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
    return "Missing ComfyUI path";
  }

  for (const segment of pathSegments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      !SAFE_PATH_SEGMENT_RE.test(segment)
    ) {
      return "Invalid ComfyUI proxy path";
    }
  }

  return null;
}

function validateProxyBodySize(req: NextRequest): string | null {
  const rawLength = req.headers.get("content-length");
  if (!rawLength) return null;

  const bytes = Number(rawLength);
  if (!Number.isFinite(bytes) || bytes < 0) return "Invalid content-length";
  if (bytes > MAX_PROXY_BODY_BYTES) {
    return `ComfyUI proxy body exceeds ${MAX_PROXY_BODY_BYTES} bytes`;
  }
  return null;
}

function validateProxyRequest(
  req: NextRequest,
  pathSegments: string[],
): { error: string; status: number } | null {
  const pathError = validateProxyPath(pathSegments);
  if (pathError) return { error: pathError, status: 400 };

  const rawPath = pathSegments.join("/");
  const allowedPaths =
    req.method === "POST" ? ALLOWED_POST_PATHS : ALLOWED_GET_PATHS;
  if (!allowedPaths.has(rawPath)) {
    return { error: `ComfyUI proxy path not allowed: ${rawPath}`, status: 403 };
  }

  const search = new URL(req.url).search;
  if (search.length > MAX_PROXY_QUERY_LENGTH) {
    return { error: "ComfyUI proxy query string too large", status: 414 };
  }

  if (req.method === "POST") {
    const bodySizeError = validateProxyBodySize(req);
    if (bodySizeError) return { error: bodySizeError, status: 413 };
  }

  return null;
}

function log(method: string, path: string, status: number | string) {
  console.log(`[ComfyProxy] ${method} /${path} -> ${status}`);
}

async function proxy(
  req: NextRequest,
  pathSegments: string[],
): Promise<NextResponse> {
  const isPost = req.method === "POST";
  const timeoutMs = isPost ? 60_000 : 15_000;

  // Rebuild path + query string
  const rawPath = pathSegments.join("/");
  if (!isPost && rawPath === "view") return proxyView(req);
  const search = new URL(req.url).search;
  // /view of a video-backend file (marker subfolder) is served by that host;
  // everything else goes to the default backend.
  const base =
    !isPost && rawPath === "view"
      ? backendUrlForSubfolder(
          new URL(req.url).searchParams.get("subfolder") ?? undefined,
        )
      : env.COMFY_HTTP_URL;
  const upstreamUrl = `${base}/${rawPath}${search}`;

  // Forward headers, stripping hop-by-hop and Host
  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!BLOCKED_FORWARD_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  // The timeout only guards the upstream request: once headers arrive the
  // response body is streamed to the client, and an armed AbortSignal.timeout
  // would destroy large transfers (e.g. /view videos) mid-stream.
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // Content-Length is optional (chunked bodies omit it): cap streamed bytes.
  const cap = { exceeded: false };
  const body = isPost && req.body ? req.body.pipeThrough(capBytes(MAX_PROXY_BODY_BYTES, cap)) : undefined;
  try {
    // Armed per send so a GPU-mutex wait doesn't eat the request timeout.
    const send = () => {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      return comfyFetch(upstreamUrl, {
        baseUrl: base,
        method: req.method,
        headers: forwardHeaders,
        body,
        // duplex required when streaming a request body
        // @ts-expect-error — Node 18+ fetch accepts duplex
        duplex: isPost ? "half" : undefined,
        signal: controller.signal,
      });
    };
    // Raw POST /prompt goes through the cross-host GPU mutex too.
    const upstream =
      isPost && rawPath === "prompt"
        ? await withExclusiveBackend(env.COMFY_HTTP_URL, send)
        : await send();
    clearTimeout(timeout);

    log(req.method, rawPath, upstream.status);

    // Forward response headers, stripping hop-by-hop
    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    // Merge CORS headers into the upstream response headers
    for (const [key, value] of Object.entries(apiCorsHeaders(req))) {
      responseHeaders.set(key, value as string);
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (cap.exceeded) {
      log(req.method, rawPath, 413);
      return apiError(`ComfyUI proxy body exceeds ${MAX_PROXY_BODY_BYTES} bytes`, {
        status: 413,
        headers: apiCorsHeaders(req),
      });
    }
    if (error instanceof BackendBusyError) {
      log(req.method, rawPath, error.status);
      return apiError(error.message, {
        status: error.status,
        headers: apiCorsHeaders(req),
      });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    log(req.method, rawPath, "502");
    console.error(`[ComfyProxy] Connection error -> ${upstreamUrl}:`, message);
    return apiError(`Cannot reach ComfyUI: ${message}`, {
      status: 502,
      headers: apiCorsHeaders(req),
    });
  }
}

/**
 * GET /view goes through fetchImageResponse (validated filename/subfolder/
 * type, video-backend routing) and never echoes an unsafe Content-Type: an
 * SVG/HTML file in ComfyUI's output would otherwise run on the app origin.
 */
async function proxyView(req: NextRequest): Promise<NextResponse> {
  const q = new URL(req.url).searchParams;
  try {
    const upstream = await fetchImageResponse(
      q.get("filename") ?? "",
      q.get("subfolder") ?? "",
      q.get("type") || "output",
      req.headers.get("range"),
    );
    log("GET", "view", upstream.status);
    const headers = new Headers(safeProxiedTypeHeaders(upstream.headers.get("content-type"), "application/octet-stream"));
    for (const name of VIEW_PASS_HEADERS) {
      const v = upstream.headers.get(name);
      if (v) headers.set(name, v);
    }
    for (const [key, value] of Object.entries(apiCorsHeaders(req))) {
      headers.set(key, value as string);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    const status = error instanceof ComfyAPIError && error.statusCode ? error.statusCode : 502;
    log("GET", "view", status);
    return apiError(status === 400 ? "Invalid view parameters" : "Cannot fetch file from ComfyUI", {
      status,
      headers: apiCorsHeaders(req),
    });
  }
}

export function OPTIONS(): NextResponse {
  return apiOptions();
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return withCors(auth.response, req);

  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return withCors(rl.response, req);

  const { path } = await params;
  const invalid = validateProxyRequest(req, path);
  if (invalid) {
    return apiError(invalid.error, {
      status: invalid.status,
      headers: apiCorsHeaders(req),
    });
  }
  return proxy(req, path);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return withCors(auth.response, req);

  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return withCors(rl.response, req);

  const bodySizeError = validateProxyBodySize(req);
  if (bodySizeError) {
    return apiError(bodySizeError, {
      status: 413,
      headers: apiCorsHeaders(req),
    });
  }

  const { path } = await params;
  const invalid = validateProxyRequest(req, path);
  if (invalid) {
    return apiError(invalid.error, {
      status: invalid.status,
      headers: apiCorsHeaders(req),
    });
  }
  return proxy(req, path);
}
