/**
 * Style Codes API
 * CRUD operations for style code library.
 *
 * Endpoints:
 * - GET /api/style/codes - List all style codes (with filtering)
 * - POST /api/style/codes - Create/save a style code
 * - DELETE /api/style/codes - Delete a style code
 *
 * Query params for GET:
 * - tag: Filter by tag
 * - favorite: Filter favorites only (true/false)
 * - search: Search in names/tags
 * - limit: Max results (default 100)
 * - offset: Pagination offset
 * - sort: Sort field (useCount, createdAt, name)
 * - order: Sort order (asc, desc)
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withLock } from "@/lib/locks";
import { isMissingDbError } from "@/lib/jsonDbLoad";
import { withRateLimit } from "@/lib/rateLimit";
import { validatePlainObject, validateRequiredString } from "@/lib/validate";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

interface StyleCodeEntry {
  code: string;
  name?: string;
  tags?: string[];
  thumbnailUrl?: string;
  createdAt: number;
  useCount: number;
  isFavorite: boolean;
  metadata?: Record<string, unknown>;
}

interface StyleCodeDB {
  version: number;
  codes: StyleCodeEntry[];
}

const DB_PATH = adriftDataPath("style_codes.json");

async function loadDB(): Promise<StyleCodeDB> {
  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const content = await fs.readFile(DB_PATH, "utf-8");
    return JSON.parse(content) as StyleCodeDB;
  } catch (err) {
    // Empty DB only if the file doesn't exist — never mask a corrupt file,
    // or the next save would overwrite it.
    if (!isMissingDbError(err)) throw err;
    return { version: 1, codes: [] };
  }
}

async function saveDB(db: StyleCodeDB): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, DB_PATH);
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "GET, POST, DELETE, OPTIONS"),
  });
}

function badRequest(error: string): NextResponse {
  return jsonResponse({ ok: false, error }, 400);
}

function parseBoundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
): string | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  const validated = validateRequiredString(value, field, maxChars);
  if (!validated.ok) return { error: validated.error };
  return validated.text;
}

function validateStyleCode(value: unknown): string | { error: string } {
  const validated = validateRequiredString(value, "code", 12);
  if (!validated.ok) return { error: validated.error };
  if (!/^\d{6,12}$/.test(validated.text)) {
    return { error: "Style code must be 6-12 digits" };
  }
  return validated.text;
}

function validateTags(
  value: unknown,
): string[] | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return { error: "tags must be an array" };
  if (value.length > 32)
    return { error: "tags exceeds maximum length of 32 items" };

  const tags: string[] = [];
  for (const tag of value) {
    const validated = validateRequiredString(tag, "tag", 64);
    if (!validated.ok) return { error: validated.error };
    if (!tags.includes(validated.text)) tags.push(validated.text);
  }
  return tags;
}

function validateThumbnailUrl(
  value: unknown,
): string | undefined | { error: string } {
  const text = parseOptionalText(value, "thumbnailUrl", 2048);
  if (text === undefined || typeof text !== "string") return text;
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { error: "thumbnailUrl must be an http(s) URL" };
    }
    return parsed.toString();
  } catch {
    return { error: "thumbnailUrl must be a valid URL" };
  }
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, DELETE, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  try {
    const { searchParams } = new URL(request.url);

    const tag = searchParams.get("tag");
    const favorite = searchParams.get("favorite");
    const search = searchParams.get("search")?.toLowerCase().slice(0, 128);
    const limit = parseBoundedInteger(searchParams.get("limit"), 100, 1, 250);
    const offset = parseBoundedInteger(
      searchParams.get("offset"),
      0,
      0,
      100_000,
    );
    const sortParam = searchParams.get("sort") ?? "createdAt";
    const orderParam = searchParams.get("order") ?? "desc";
    const sort = ["useCount", "createdAt", "name"].includes(sortParam)
      ? sortParam
      : "createdAt";
    const order = orderParam === "asc" ? "asc" : "desc";

    const db = await loadDB();
    let results = [...db.codes];

    if (tag) {
      results = results.filter((c) => c.tags?.includes(tag));
    }

    if (favorite === "true") {
      results = results.filter((c) => c.isFavorite);
    }

    if (search) {
      results = results.filter(
        (c) =>
          c.name?.toLowerCase().includes(search) ||
          c.code.includes(search) ||
          c.tags?.some((t) => t.toLowerCase().includes(search)),
      );
    }

    results.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sort) {
        case "useCount":
          aVal = a.useCount;
          bVal = b.useCount;
          break;
        case "name":
          aVal = a.name ?? a.code;
          bVal = b.name ?? b.code;
          break;
        case "createdAt":
        default:
          aVal = a.createdAt;
          bVal = b.createdAt;
      }

      if (order === "asc") {
        return aVal > bVal ? 1 : -1;
      }
      return aVal < bVal ? 1 : -1;
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return jsonResponse({
      ok: true,
      codes: results,
      total,
      limit,
      offset,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[StyleCodes GET] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const object = validatePlainObject(body, "body");
    if (typeof object === "string") return badRequest(object);

    const code = validateStyleCode(object.code);
    if (hasError(code)) return badRequest(code.error);

    const name = parseOptionalText(object.name, "name", 128);
    if (hasError(name)) return badRequest(name.error);

    const tags = validateTags(object.tags);
    if (hasError(tags)) return badRequest(tags.error);

    const thumbnailUrl = validateThumbnailUrl(object.thumbnailUrl);
    if (hasError(thumbnailUrl)) return badRequest(thumbnailUrl.error);

    const metadata = validatePlainObject(object.metadata, "metadata");
    if (typeof metadata === "string") return badRequest(metadata);

    const isFavorite =
      typeof object.isFavorite === "boolean" ? object.isFavorite : false;

    return await withLock("style-codes-db", async () => {
      const db = await loadDB();

      const existingIndex = db.codes.findIndex((c) => c.code === code);

      const entry: StyleCodeEntry = {
        code,
        name,
        tags,
        thumbnailUrl,
        createdAt:
          existingIndex >= 0 ? db.codes[existingIndex].createdAt : Date.now(),
        useCount: existingIndex >= 0 ? db.codes[existingIndex].useCount : 0,
        isFavorite:
          object.isFavorite === undefined && existingIndex >= 0
            ? db.codes[existingIndex].isFavorite
            : isFavorite,
        metadata,
      };

      if (existingIndex >= 0) {
        db.codes[existingIndex] = entry;
      } else {
        db.codes.unshift(entry);
      }

      await saveDB(db);

      return jsonResponse({
        ok: true,
        code: entry,
        created: existingIndex < 0,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[StyleCodes POST] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 15 });
  if (!rl.ok) return rl.response;

  try {
    const { searchParams } = new URL(request.url);
    const code = validateStyleCode(searchParams.get("code"));
    if (hasError(code)) return badRequest(code.error);

    return await withLock("style-codes-db", async () => {
      const db = await loadDB();

      const index = db.codes.findIndex((c) => c.code === code);

      if (index < 0) {
        return jsonResponse({ ok: false, error: "Style code not found" }, 404);
      }

      db.codes.splice(index, 1);

      await saveDB(db);

      return jsonResponse({ ok: true, deleted: code });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[StyleCodes DELETE] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
