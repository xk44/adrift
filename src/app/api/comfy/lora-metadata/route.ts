/**
 * GET /api/comfy/lora-metadata?filename=<lora file name>
 * Proxies ComfyUI's /view_metadata/loras, parses the safetensors header
 * (trigger words, base model, network dim/alpha, title) and caches the result.
 * ComfyUI exposes no mtime/size for this endpoint, so the cache is keyed by
 * ComfyUI base URL + filename with a TTL (a new backend never sees old hits).
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyBaseUrl, comfyFetch } from "@/lib/comfy/comfyFetch";
import { isSafeLoraFilename, parseLoraMetadata, type LoraMetadata } from "@/lib/loraMetadata";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; meta: LoraMetadata }>();

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  const filename = request.nextUrl.searchParams.get("filename") ?? "";
  if (!isSafeLoraFilename(filename)) {
    return apiError("Invalid filename", { status: 400 });
  }

  const key = `${comfyBaseUrl()}\n${filename}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return apiOk({ filename, metadata: hit.meta, cached: true });
  }

  try {
    const res = await comfyFetch(
      `/view_metadata/loras?filename=${encodeURIComponent(filename)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.status === 404) return apiError("LoRA not found", { status: 404 });
    if (!res.ok) throw new Error(`ComfyUI returned ${res.status}`);
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null; // headerless / non-JSON -> empty metadata
    }
    const meta = parseLoraMetadata(raw);
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), meta });
    return apiOk({ filename, metadata: meta, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    apiErr("LoraMetadata", "Error", message);
    return apiError(`Failed to fetch LoRA metadata: ${message}`, { status: 502 });
  }
}
