/**
 * Import a StyleVault library tag group (e.g. an sref) as a style dataset.
 *
 * POST /api/moodboards/import-sv  { tag: "sref:1234567890", name?, kind? }
 *
 * Server-side flow: SV /library/export-by-tag materializes the group
 * (copy mode so files survive library moves), then up to 20 images are
 * copied into moodboard uploads and a kind:"style" board is created with
 * each image's clean prompt stored as its caption (training-ready).
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { env } from "@/lib/env";
import {
  IMAGE_EXTENSIONS,
  copyImageToMoodboardUploads,
  createMoodboardEntry,
} from "@/lib/moodboards";
import type { MoodboardImage } from "@/types";

const MAX_BOARD_IMAGES = 20;

const importSchema = z.object({
  tag: z
    .string()
    .min(1)
    .max(140)
    .regex(/^[A-Za-z0-9:@._-]+$/, "invalid tag"),
  name: z.string().min(1).max(100).optional(),
  kind: z.enum(["moodboard", "character", "style"]).optional(),
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 10 });
  if (!auth.ok) return auth.response;

  try {
    const parsed = importSchema.safeParse(await request.json());
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
    const { tag } = parsed.data;

    const svResponse = await fetch(
      `${env.STYLEVAULT_API_URL}/library/export-by-tag`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, mode: "copy", limit: MAX_BOARD_IMAGES }),
        signal: AbortSignal.timeout(60000),
      },
    );
    const body = await svResponse.json().catch(() => ({}));
    if (!svResponse.ok || !body?.images_dir) {
      return jsonResponse(
        {
          ok: false,
          error: body?.detail || body?.error || "StyleVault export failed",
        },
        502,
      );
    }

    const exportDir = String(body.images_dir);
    const entries = (await fs.readdir(exportDir)).sort();
    const images: MoodboardImage[] = [];
    for (const entry of entries) {
      if (images.length >= MAX_BOARD_IMAGES) break;
      const ext = path.extname(entry).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      const source = path.join(exportDir, entry);
      try {
        const copied = await copyImageToMoodboardUploads(source);
        // clean prompt sidecar (written by export-by-tag) → caption
        let caption: string | undefined;
        try {
          const sidecar = await fs.readFile(
            source.replace(/\.[^.]+$/, ".txt"),
            "utf-8",
          );
          caption = sidecar.trim() || undefined;
        } catch {
          // no sidecar — auto-caption can fill it later
        }
        images.push({
          url: copied.url,
          weight: 1,
          caption,
          captionSource: caption ? "mj-prompt" : undefined,
        });
      } catch {
        continue;
      }
    }

    if (!images.length) {
      return jsonResponse(
        { ok: false, error: "Export contained no importable images" },
        502,
      );
    }

    const defaultName = tag.startsWith("sref:")
      ? `sref ${tag.slice(5)}`
      : tag.replace(/[:@]/g, " ");
    const moodboard = await createMoodboardEntry({
      name: parsed.data.name ?? defaultName.slice(0, 100),
      description: `Imported from StyleVault (${tag}, ${body.exported} in library)`,
      images,
      kind: parsed.data.kind ?? "style",
    });

    return jsonResponse({
      ok: true,
      moodboard,
      imported: images.length,
      libraryCount: Number(body.exported) || images.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboards Import-SV] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
