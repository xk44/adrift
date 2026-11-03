/**
 * GET /api/comfy/lora-preview?filename=<lora file name>
 * Serves the preview image saved next to a LoRA (`<stem>.preview.png`,
 * `<stem>.png`, …) when ComfyUI runs on this machine. 404 otherwise.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { apiCorsHeaders, apiError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { isSafeLoraFilename } from "@/lib/loraMetadata";
import { findLoraPreview } from "@/lib/characters/loraSidecars";
import { localLorasDir } from "@/lib/characters/localLoras";

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 240 });
  if (!rl.ok) return rl.response;

  const filename = request.nextUrl.searchParams.get("filename") ?? "";
  if (!isSafeLoraFilename(filename)) {
    return apiError("Invalid filename", { status: 400 });
  }
  const dir = localLorasDir();
  const preview = dir ? await findLoraPreview(dir, filename) : null;
  if (!preview) return apiError("No preview", { status: 404 });
  try {
    const bytes = await readFile(preview.path);
    if (bytes.byteLength > MAX_PREVIEW_BYTES) {
      return apiError("Preview too large", { status: 404 });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": preview.contentType,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return apiError("No preview", { status: 404 });
  }
}
