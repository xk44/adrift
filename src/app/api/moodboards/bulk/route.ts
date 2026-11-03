import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import {
  deleteMoodboardsBatch,
  mergeMoodboardsBatch,
  tagMoodboardsBatch,
} from "@/lib/moodboards";

const idSchema = z.string().min(1).max(200);
const tagSchema = z.string().trim().min(1).max(64);

const bulkSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    ids: z.array(idSchema).min(1).max(5000),
  }),
  z.object({
    action: z.literal("tag"),
    ids: z.array(idSchema).min(1).max(5000),
    tags: z.array(tagSchema).min(1).max(64),
    mode: z.enum(["add", "remove"]),
  }),
  z.object({
    action: z.literal("merge"),
    ids: z.array(idSchema).min(1).max(5000),
    targetId: idSchema,
  }),
]);

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 30 });
  if (!auth.ok) return auth.response;

  try {
    const parsed = bulkSchema.safeParse(await request.json());
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return jsonResponse(
        {
          ok: false,
          error: `Validation: ${firstError?.path.join(".")} - ${firstError?.message}`,
        },
        400,
      );
    }

    if (parsed.data.action === "delete") {
      const result = await deleteMoodboardsBatch(parsed.data.ids);
      return jsonResponse({ ok: true, ...result });
    }

    if (parsed.data.action === "tag") {
      const result = await tagMoodboardsBatch(
        parsed.data.ids,
        parsed.data.tags,
        parsed.data.mode,
      );
      return jsonResponse({ ok: true, ...result });
    }

    const result = await mergeMoodboardsBatch(parsed.data.ids, parsed.data.targetId);
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Target moodboard not found" ? 404 : 500;
    console.error("[Moodboards Bulk POST] Error:", message);
    return jsonResponse({ ok: false, error: message }, status);
  }
}
