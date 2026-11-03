/**
 * Moodboards API
 * CRUD for saved style reference collections (moodboards).
 *
 * Endpoints:
 * - GET    /api/moodboards         - list all moodboards
 * - POST   /api/moodboards         - create new moodboard
 * - PUT    /api/moodboards         - update moodboard (id in body)
 * - DELETE /api/moodboards?id=...  - delete moodboard
 *
 * Storage: JSON file at data/moodboards.json (same pattern as style codes)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardRoute } from "@/lib/routeGuard";
import { apiCorsHeaders } from "@/lib/api";
import {
  createMoodboardEntry,
  loadMoodboardsDB,
  saveMoodboardsDB,
} from "@/lib/moodboards";
import {
  MAX_KEEP_TOKENS,
  normalizeCaptionSettings,
} from "@/lib/moodboards/captions";
import type { MoodboardImage, Moodboard } from "@/types";

// Validation schemas

const moodboardImageSchema = z.object({
  url: z.string().max(2000),
  weight: z.number().min(0).max(5).default(1),
  // Optional metadata — must be listed or zod strips it on create/update.
  prompt: z.string().max(2000).optional(),
  caption: z.string().max(2000).optional(),
  captionSource: z.string().max(200).optional(),
});

const kindSchema = z.enum(["moodboard", "character", "style"]);

const createMoodboardSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  images: z.array(moodboardImageSchema).max(20).default([]),
  isDefault: z.boolean().default(false),
  kind: kindSchema.optional(),
});

const updateMoodboardSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  images: z.array(moodboardImageSchema).max(20).optional(),
  isDefault: z.boolean().optional(),
  /** null clears the dataset caption knobs. */
  captionSettings: z
    .object({
      triggerWord: z.string().max(100).optional(),
      dropoutRate: z.number().min(0).max(1).optional(),
      shuffle: z.boolean().optional(),
      keepTokens: z.number().int().min(0).max(MAX_KEEP_TOKENS).optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Opt-in paging for thin clients (iOS): the full list is ~13 MB with the Krea
 * catalog imported. Absent all of limit/offset/q/summary, GET is unchanged.
 */
interface PageParams {
  limit: number;
  offset: number;
  q: string;
  summary: boolean;
}

const SUMMARY_IMAGE_COUNT = 4;

function parsePageParams(sp: URLSearchParams): PageParams | null {
  if (!["limit", "offset", "q", "summary"].some((k) => sp.has(k))) return null;
  const int = (key: string, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(sp.get(key) ?? "", 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  return {
    limit: int("limit", 48, 1, 200),
    offset: int("offset", 0, 0, Number.MAX_SAFE_INTEGER),
    q: (sp.get("q") ?? "").trim().toLowerCase().slice(0, 200),
    summary: sp.get("summary") === "1" || sp.get("summary") === "true",
  };
}

function pageMoodboards(all: Moodboard[], page: PageParams) {
  const matches = page.q
    ? all.filter((m) =>
        `${m.name}\n${m.description ?? ""}\n${(m.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(page.q),
      )
    : all;
  const slice = matches.slice(page.offset, page.offset + page.limit);
  const end = page.offset + slice.length;
  return {
    total: matches.length,
    nextOffset: end < matches.length ? end : null,
    moodboards: page.summary
      ? slice.map((m) => ({
          ...m,
          images: m.images.slice(0, SUMMARY_IMAGE_COUNT),
          imageCount: m.images.length,
        }))
      : slice,
  };
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "GET, POST, PUT, DELETE, OPTIONS"),
  });
}

// Route handlers

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, PUT, DELETE, OPTIONS"),
  });
}

/** GET /api/moodboards — list all moodboards (admin-only, not public data) */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 120 });
  if (!auth.ok) return auth.response;

  try {
    const db = await loadMoodboardsDB();
    const idParam = new URL(request.url).searchParams.get("id");
    if (idParam !== null) {
      const moodboard = db.moodboards.find((m) => m.id === idParam);
      return moodboard
        ? jsonResponse({ ok: true, moodboard })
        : jsonResponse({ ok: false, error: "Moodboard not found" }, 404);
    }
    const kindParam = new URL(request.url).searchParams.get("kind");
    const parsedKind = kindParam ? kindSchema.safeParse(kindParam) : null;
    if (parsedKind && !parsedKind.success) {
      return jsonResponse({ ok: false, error: "Invalid kind" }, 400);
    }
    const moodboards = parsedKind
      ? db.moodboards.filter(
          // Pre-kind boards count as plain moodboards.
          (m) => (m.kind ?? "moodboard") === parsedKind.data,
        )
      : db.moodboards;
    const page = parsePageParams(new URL(request.url).searchParams);
    if (!page) return jsonResponse({ ok: true, moodboards });
    return jsonResponse({ ok: true, ...pageMoodboards(moodboards, page) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboards GET] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

/** POST /api/moodboards — create new moodboard */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 60 });
  if (!auth.ok) return auth.response;

  try {
    const raw = await request.json();
    const parsed = createMoodboardSchema.safeParse(raw);

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

    const { name, description, images, isDefault, kind } = parsed.data;

    const moodboard = await createMoodboardEntry({
      name,
      description: description ?? undefined,
      images,
      isDefault,
      kind,
    });

    return jsonResponse({ ok: true, moodboard, created: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboards POST] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

/** PUT /api/moodboards — update moodboard (id in body) */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 60 });
  if (!auth.ok) return auth.response;

  try {
    const raw = await request.json();
    const parsed = updateMoodboardSchema.safeParse(raw);

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

    const { id, name, description, images, isDefault, captionSettings } =
      parsed.data;

    const db = await loadMoodboardsDB();
    const index = db.moodboards.findIndex((m) => m.id === id);

    if (index < 0) {
      return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);
    }

    // If setting as default, clear other defaults
    if (isDefault === true) {
      db.moodboards = db.moodboards.map((m) => ({ ...m, isDefault: false }));
    }

    const existing = db.moodboards[index]!;
    const updated: Moodboard = {
      ...existing,
      name: name ?? existing.name,
      description:
        description === null
          ? undefined
          : (description ?? existing.description),
      images: images ?? existing.images,
      isDefault: isDefault ?? existing.isDefault,
      updatedAt: Date.now(),
    };
    if (captionSettings !== undefined) {
      const normalized = normalizeCaptionSettings(captionSettings);
      if (captionSettings === null || Object.keys(normalized).length === 0) {
        delete updated.captionSettings;
      } else {
        updated.captionSettings = normalized;
      }
    }

    db.moodboards[index] = updated;
    await saveMoodboardsDB(db);

    return jsonResponse({ ok: true, moodboard: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboards PUT] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

/** DELETE /api/moodboards?id=... — delete moodboard */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 60 });
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return jsonResponse(
        { ok: false, error: "Missing 'id' query parameter" },
        400,
      );
    }

    // Validate UUID format
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return jsonResponse({ ok: false, error: "Invalid moodboard ID" }, 400);
    }

    const db = await loadMoodboardsDB();
    const index = db.moodboards.findIndex((m) => m.id === id);

    if (index < 0) {
      return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);
    }

    db.moodboards.splice(index, 1);
    await saveMoodboardsDB(db);

    return jsonResponse({ ok: true, deleted: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboards DELETE] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
