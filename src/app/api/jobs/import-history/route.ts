/**
 * POST /api/jobs/import-history  { max_items?: number }
 *
 * Imports finished jobs from ComfyUI's GET /history?max_items=N into the
 * Adrift job list (prompts/runs/jobs/outputs), deduped by ComfyUI prompt_id.
 * Read-only against ComfyUI: the only upstream call is the GET.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiErr, apiError, apiOk, apiOptions } from "@/lib/api";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  HISTORY_IMPORT_DEFAULT,
  HISTORY_IMPORT_MAX,
  importComfyHistory,
} from "@/lib/jobs/historyImport";

export async function OPTIONS() {
  return apiOptions();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let maxItems = HISTORY_IMPORT_DEFAULT;
  try {
    const text = await req.text();
    if (text.trim()) {
      const body = JSON.parse(text) as { max_items?: unknown };
      if (body.max_items !== undefined) {
        if (
          typeof body.max_items !== "number" ||
          !Number.isInteger(body.max_items) ||
          body.max_items < 1
        ) {
          return apiError("max_items must be a positive integer", {
            status: 400,
          });
        }
        maxItems = Math.min(body.max_items, HISTORY_IMPORT_MAX);
      }
    }
  } catch {
    return apiError("Invalid JSON body", { status: 400 });
  }

  let history: unknown;
  try {
    const res = await comfyFetch(`/history?max_items=${maxItems}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return apiError(`ComfyUI /history returned ${res.status}`, {
        status: 502,
      });
    }
    history = await res.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiErr("ImportHistory", "ComfyUI /history fetch failed", { message });
    return apiError(`ComfyUI unreachable: ${message}`, { status: 502 });
  }

  try {
    const result = importComfyHistory(history);
    return apiOk({ max_items: maxItems, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiErr("ImportHistory", "Import failed", { message });
    return apiError(`Import failed: ${message}`, { status: 500 });
  }
}
