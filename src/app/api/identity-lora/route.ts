/**
 * Identity LoRA dataset API
 * GET  /api/identity-lora  - is a trainer ready, and which model families can
 *                            it train? StyleVault when STYLEVAULT_API_URL is
 *                            set, else Adrift's local trainer (Settings →
 *                            Training). Never starts a job.
 * POST /api/identity-lora  - create a `character` dataset board from 10-30
 *                            already-uploaded photos (plus captions). The
 *                            client then starts training through the existing
 *                            POST /api/moodboards/[id]/train route.
 *
 * Plain board creation caps images at 20 (moodboard semantics); identity
 * datasets need up to 30, so they get this narrow route instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { createMoodboardEntry } from "@/lib/moodboards";
import {
  IDENTITY_MAX_PHOTOS,
  IDENTITY_MIN_PHOTOS,
  isUploadedPhotoUrl,
} from "@/lib/training/identityJob";
import {
  localTrainerStatus,
  styleVaultTrains,
} from "@/lib/training/local/service";

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  images: z
    .array(
      z.object({
        url: z.string().max(2000),
        caption: z.string().max(2000).optional(),
      }),
    )
    .min(IDENTITY_MIN_PHOTOS)
    .max(IDENTITY_MAX_PHOTOS),
});

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

type BackendInfo = {
  name?: unknown;
  installed?: unknown;
  model_families?: unknown;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  if (!styleVaultTrains()) {
    const local = localTrainerStatus();
    return jsonResponse({
      ok: true,
      trainer: "local",
      configured: local.configured,
      families: local.families,
      ...(local.error ? { error: local.error } : {}),
    });
  }

  const notConfigured = (detail: string) =>
    jsonResponse({
      ok: true,
      configured: false,
      families: [] as string[],
      error: `Trainer not configured: ${detail}`,
    });

  let res: Response;
  try {
    res = await fetch(`${env.STYLEVAULT_API_URL}/training/backends`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return notConfigured(
      "the StyleVault training server is unreachable (set STYLEVAULT_API_URL and start it).",
    );
  }
  if (!res.ok) return notConfigured(`StyleVault answered HTTP ${res.status}.`);
  const body = (await res.json().catch(() => null)) as {
    backends?: BackendInfo[];
  } | null;
  const backends = Array.isArray(body?.backends) ? body.backends : [];
  const families = new Set<string>();
  for (const b of backends) {
    if (b?.installed !== true || !Array.isArray(b.model_families)) continue;
    for (const f of b.model_families)
      if (typeof f === "string") families.add(f);
  }
  if (families.size === 0)
    return notConfigured(
      "no trainer backend (musubi-tuner / ai-toolkit) is installed in StyleVault.",
    );
  return jsonResponse({
    ok: true,
    configured: true,
    families: [...families].sort(),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    const parsed = createSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return jsonResponse(
        {
          ok: false,
          error: `Validation: ${first?.path.join(".")} - ${first?.message}`,
        },
        400,
      );
    }
    const { name, description, images } = parsed.data;
    if (!images.every((img) => isUploadedPhotoUrl(img.url))) {
      return jsonResponse(
        { ok: false, error: "Photos must be uploaded through Adrift first." },
        400,
      );
    }
    const moodboard = await createMoodboardEntry({
      name,
      description:
        description ?? "Identity LoRA dataset (Train Identity tool).",
      kind: "character",
      images: images.map((img) => {
        const caption = img.caption?.trim();
        return caption
          ? { url: img.url, weight: 1, caption, captionSource: "manual" }
          : { url: img.url, weight: 1 };
      }),
    });
    return jsonResponse({ ok: true, moodboard });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Identity LoRA] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
