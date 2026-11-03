/**
 * GET /api/comfy/library            → list ComfyUI user-library workflows
 * GET /api/comfy/library?file=a.json → one workflow (raw JSON) after
 *   proving it converts; subgraph errors come back as 422 with a code.
 * Read-only: only GET /api/userdata on ComfyUI.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { env } from "@/lib/env";
import {
  fetchComfyLibraryWorkflow,
  isSafeLibraryPath,
  listComfyLibrary,
} from "@/lib/comfy/comfyLibrary";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const file = request.nextUrl.searchParams.get("file");
  try {
    if (file === null) {
      const entries = await listComfyLibrary(env.COMFY_HTTP_URL);
      return apiOk({ entries });
    }
    if (!isSafeLibraryPath(file)) {
      return apiError("Invalid library path", { status: 400 });
    }
    const wf = await fetchComfyLibraryWorkflow(env.COMFY_HTTP_URL, file);
    return apiOk(
      { workflow: wf.workflow, name: wf.name, path: wf.path, format: wf.format,
        nodeCount: wf.nodeCount, subgraphCount: wf.subgraphCount },
      { warnings: wf.warnings },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code;
    apiErr("ComfyLibraryAPI", "Error", message);
    const status = code
      ? 422
      : /not in the ComfyUI library/.test(message)
        ? 404
        : /not valid JSON|Can't import/.test(message)
          ? 422
          : 502;
    return apiError(message, { status, details: code ? { code } : undefined });
  }
}
