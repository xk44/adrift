/**
 * Moodboard auto-caption API
 * POST /api/moodboards/[id]/caption — caption board images via StyleVault's
 * vision captioner (Qwen-VL omnitag) and persist results on the board record.
 *
 * Body: {
 *   only_missing?: boolean  // default true: skip images that already have a caption
 *   indices?: number[]      // caption only these image indices
 *   model?: string          // override the SV captioner model id
 *   prompt?: string         // optional captioner instruction
 * }
 *
 * Captions land in MoodboardImage.caption (captionSource = model name) where
 * the user can review/edit them before training writes sidecars.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { env } from "@/lib/env";
import {
  getMoodboard,
  loadMoodboardsDB,
  readImageBytes,
  resolveImageSource,
  saveMoodboardsDB,
} from "@/lib/moodboards";
import type { MoodboardImage } from "@/types";

const CAPTION_CONCURRENCY = 2; // vision model is heavy; don't hammer SV

const captionSchema = z.object({
  only_missing: z.boolean().optional(),
  indices: z.array(z.number().int().nonnegative()).max(20).optional(),
  model: z.string().min(1).max(200).optional(),
  prompt: z.string().max(2000).optional(),
});

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

async function captionViaSV(
  bytes: Buffer,
  filename: string,
  options: { model?: string; prompt?: string },
): Promise<{ caption: string; model: string } | null> {
  const params = new URLSearchParams({ filename });
  if (options.model) params.set("model", options.model);
  if (options.prompt) params.set("prompt", options.prompt);
  try {
    const res = await fetch(
      `${env.STYLEVAULT_API_URL}/caption/image?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.caption !== "string" || !body.caption.trim()) return null;
    return { caption: body.caption.trim(), model: String(body.model ?? "sv") };
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 10 });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = captionSchema.safeParse(raw);
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
    const onlyMissing = parsed.data.only_missing ?? true;
    const indexFilter = parsed.data.indices
      ? new Set(parsed.data.indices)
      : null;

    const moodboard = await getMoodboard(id);
    if (!moodboard)
      return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);

    const targets = moodboard.images
      .map((image, index) => ({ image, index }))
      .filter(({ image, index }) => {
        if (indexFilter && !indexFilter.has(index)) return false;
        if (onlyMissing && image.caption?.trim()) return false;
        return true;
      });
    if (!targets.length) {
      return jsonResponse({
        ok: true,
        captioned: 0,
        failed: 0,
        images: moodboard.images,
      });
    }

    // Key by image.url, not array index: images may be removed/reordered while
    // this long async pass runs, so a positional index would misattach captions
    // to the wrong image on write-back.
    const results = new Map<string, { caption: string; model: string }>();
    let failed = 0;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CAPTION_CONCURRENCY, targets.length) },
      async () => {
        while (cursor < targets.length) {
          const { image, index } = targets[cursor++]!;
          const source = await resolveImageSource(image.url);
          const bytes = source ? await readImageBytes(source) : null;
          if (!bytes) {
            failed += 1;
            continue;
          }
          const result = await captionViaSV(bytes, `image-${index}`, {
            model: parsed.data.model,
            prompt: parsed.data.prompt,
          });
          if (result) results.set(image.url, result);
          else failed += 1;
        }
      },
    );
    await Promise.all(workers);

    if (results.size) {
      // Re-load inside the write to merge with any concurrent board edits.
      const db = await loadMoodboardsDB();
      const board = db.moodboards.find((m) => m.id === id);
      if (!board)
        return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);
      board.images = board.images.map((image): MoodboardImage =>
        results.has(image.url)
          ? {
              ...image,
              caption: results.get(image.url)!.caption,
              captionSource: results.get(image.url)!.model,
            }
          : image,
      );
      board.updatedAt = Date.now();
      await saveMoodboardsDB(db);
      return jsonResponse({
        ok: true,
        captioned: results.size,
        failed,
        images: board.images,
      });
    }

    return jsonResponse(
      {
        ok: false,
        captioned: 0,
        failed,
        error:
          "No captions were generated — is StyleVault running with a captioner available?",
      },
      502,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboard Caption] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
