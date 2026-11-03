/**
 * LoRA Shortcodes API
 * CRUD operations for LoRA shortcode library.
 *
 * Endpoints:
 * - GET /api/style/loras - List all LoRA shortcodes
 * - POST /api/style/loras - Create/save a shortcode
 * - DELETE /api/style/loras - Delete a shortcode
 * - PATCH /api/style/loras - Update use count or favorite
 *
 * Query params for GET:
 * - set: Filter by curated set
 * - favorite: Filter favorites only
 * - search: Search in names/tags
 * - random: Get random from set (with set param)
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

interface LoRAShortcodeEntry {
  shortcode: string;
  filename: string;
  displayName?: string;
  tags?: string[];
  triggers?: string[];
  defaultStrength: number;
  curatedSet?: string;
  useCount: number;
  isFavorite: boolean;
  metadata?: Record<string, unknown>;
}

interface LoRADB {
  version: number;
  loras: LoRAShortcodeEntry[];
  curatedSets: string[];
}

const DB_PATH = adriftDataPath("lora_shortcodes.json");

async function loadDB(): Promise<LoRADB> {
  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const content = await fs.readFile(DB_PATH, "utf-8");
    return JSON.parse(content) as LoRADB;
  } catch (err) {
    if (!isMissingDbError(err)) throw err;
    return { version: 1, loras: [], curatedSets: [] };
  }
}

async function saveDB(db: LoRADB): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, DB_PATH);
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "GET, POST, DELETE, PATCH, OPTIONS"),
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

function validateTextArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxChars: number,
): string[] | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  if (value.length > maxItems) {
    return { error: `${field} exceeds maximum length of ${maxItems} items` };
  }

  const values: string[] = [];
  for (const item of value) {
    const validated = validateRequiredString(item, `${field} item`, maxChars);
    if (!validated.ok) return { error: validated.error };
    if (!values.includes(validated.text)) values.push(validated.text);
  }
  return values;
}

function parseDefaultStrength(value: unknown): number {
  if (value === undefined || value === null) return 1.0;
  if (typeof value !== "number" || !Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(2, value));
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, DELETE, PATCH, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  try {
    const { searchParams } = new URL(request.url);

    const set = searchParams.get("set")?.slice(0, 64);
    const favorite = searchParams.get("favorite");
    const search = searchParams.get("search")?.toLowerCase().slice(0, 128);
    const random = searchParams.get("random");
    const limit = parseBoundedInteger(searchParams.get("limit"), 100, 1, 250);
    const offset = parseBoundedInteger(
      searchParams.get("offset"),
      0,
      0,
      100_000,
    );

    const db = await loadDB();
    let results = [...db.loras];

    if (set) {
      results = results.filter((l) => l.curatedSet === set);
    }

    if (favorite === "true") {
      results = results.filter((l) => l.isFavorite);
    }

    if (search) {
      results = results.filter(
        (l) =>
          l.shortcode.toLowerCase().includes(search) ||
          l.displayName?.toLowerCase().includes(search) ||
          l.filename.toLowerCase().includes(search) ||
          l.tags?.some((t) => t.toLowerCase().includes(search)),
      );
    }

    // Random selection
    if (random === "true" && results.length > 0) {
      const randomIndex = Math.floor(Math.random() * results.length);
      return jsonResponse({
        ok: true,
        lora: results[randomIndex],
        random: true,
      });
    }

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return jsonResponse({
      ok: true,
      loras: results,
      curatedSets: db.curatedSets,
      total,
      limit,
      offset,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[LoRAs GET] Error:", message);
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

    const shortcode = validateRequiredString(
      object.shortcode,
      "shortcode",
      128,
    );
    if (!shortcode.ok) return badRequest(shortcode.error);

    const filename = validateRequiredString(object.filename, "filename", 256);
    if (!filename.ok) return badRequest(filename.error);

    const displayName = parseOptionalText(
      object.displayName,
      "displayName",
      128,
    );
    if (hasError(displayName)) return badRequest(displayName.error);

    const tags = validateTextArray(object.tags, "tags", 32, 64);
    if (hasError(tags)) return badRequest(tags.error);

    const triggers = validateTextArray(object.triggers, "triggers", 32, 256);
    if (hasError(triggers)) return badRequest(triggers.error);

    const curatedSet = parseOptionalText(object.curatedSet, "curatedSet", 64);
    if (hasError(curatedSet)) return badRequest(curatedSet.error);

    const metadata = validatePlainObject(object.metadata, "metadata");
    if (typeof metadata === "string") return badRequest(metadata);

    const defaultStrength = parseDefaultStrength(object.defaultStrength);
    const isFavorite =
      typeof object.isFavorite === "boolean" ? object.isFavorite : false;

    return await withLock("style-loras-db", async () => {
      const db = await loadDB();

      const existingIndex = db.loras.findIndex(
        (l) => l.shortcode === shortcode.text,
      );

      const entry: LoRAShortcodeEntry = {
        shortcode: shortcode.text,
        filename: filename.text,
        displayName,
        tags,
        triggers,
        defaultStrength,
        curatedSet,
        useCount: existingIndex >= 0 ? db.loras[existingIndex].useCount : 0,
        isFavorite:
          object.isFavorite === undefined && existingIndex >= 0
            ? db.loras[existingIndex].isFavorite
            : isFavorite,
        metadata,
      };

      if (existingIndex >= 0) {
        db.loras[existingIndex] = entry;
      } else {
        db.loras.unshift(entry);
      }

      // Update curated sets list
      if (curatedSet && !db.curatedSets.includes(curatedSet)) {
        db.curatedSets.push(curatedSet);
      }

      await saveDB(db);

      return jsonResponse({
        ok: true,
        lora: entry,
        created: existingIndex < 0,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[LoRAs POST] Error:", message);
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
    const shortcode = validateRequiredString(
      searchParams.get("shortcode"),
      "shortcode",
      128,
    );
    if (!shortcode.ok) return badRequest(shortcode.error);

    return await withLock("style-loras-db", async () => {
      const db = await loadDB();
      const index = db.loras.findIndex((l) => l.shortcode === shortcode.text);

      if (index < 0) {
        return jsonResponse(
          { ok: false, error: "LoRA shortcode not found" },
          404,
        );
      }

      db.loras.splice(index, 1);
      await saveDB(db);

      return jsonResponse({ ok: true, deleted: shortcode.text });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[LoRAs DELETE] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
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

    const shortcode = validateRequiredString(
      object.shortcode,
      "shortcode",
      128,
    );
    if (!shortcode.ok) return badRequest(shortcode.error);

    if (
      object.incrementUse !== undefined &&
      typeof object.incrementUse !== "boolean"
    ) {
      return badRequest("incrementUse must be a boolean");
    }
    if (
      object.isFavorite !== undefined &&
      typeof object.isFavorite !== "boolean"
    ) {
      return badRequest("isFavorite must be a boolean");
    }

    const incrementUse = object.incrementUse === true;
    const isFavorite =
      typeof object.isFavorite === "boolean" ? object.isFavorite : undefined;

    return await withLock("style-loras-db", async () => {
      const db = await loadDB();
      const index = db.loras.findIndex((l) => l.shortcode === shortcode.text);

      if (index < 0) {
        return jsonResponse(
          { ok: false, error: "LoRA shortcode not found" },
          404,
        );
      }

      if (incrementUse) {
        db.loras[index].useCount += 1;
      }

      if (typeof isFavorite === "boolean") {
        db.loras[index].isFavorite = isFavorite;
      }

      await saveDB(db);

      return jsonResponse({ ok: true, lora: db.loras[index] });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[LoRAs PATCH] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
