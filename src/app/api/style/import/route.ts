/**
 * Style Import API
 * Import style codes and LoRA shortcodes from exported JSON.
 *
 * POST /api/style/import
 *
 * Body: ExportData JSON (from /api/style/export)
 *
 * Query params:
 * - mode: "merge" | "replace" (default: merge)
 * - skipDuplicates: "true" to skip existing items (default: true)
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders } from "@/lib/api";
import { withLock } from "@/lib/locks";
import {
  BodyTooLargeError,
  InvalidJsonBodyError,
  readJsonCapped,
} from "@/lib/net/readCapped";
import { isMissingDbError } from "@/lib/jsonDbLoad";
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

interface StyleCodeDB {
  version: number;
  codes: StyleCodeEntry[];
}

interface LoRADB {
  version: number;
  loras: LoRAShortcodeEntry[];
  curatedSets: string[];
}

interface ImportData {
  version: number;
  styleCodes?: StyleCodeEntry[];
  loraShortcodes?: LoRAShortcodeEntry[];
  curatedSets?: string[];
}

interface ImportResult {
  ok: boolean;
  imported: {
    styleCodes: number;
    loraShortcodes: number;
  };
  skipped: {
    styleCodes: number;
    loraShortcodes: number;
  };
  errors: string[];
}

const CODES_DB_PATH = adriftDataPath("style_codes.json");
const LORAS_DB_PATH = adriftDataPath("lora_shortcodes.json");

async function loadCodesDB(): Promise<StyleCodeDB> {
  try {
    await fs.mkdir(path.dirname(CODES_DB_PATH), { recursive: true });
    const content = await fs.readFile(CODES_DB_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if (!isMissingDbError(err)) throw err;
    return { version: 1, codes: [] };
  }
}

async function saveCodesDB(db: StyleCodeDB): Promise<void> {
  await fs.mkdir(path.dirname(CODES_DB_PATH), { recursive: true });
  const tmp = `${CODES_DB_PATH}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, CODES_DB_PATH);
}

async function loadLorasDB(): Promise<LoRADB> {
  try {
    await fs.mkdir(path.dirname(LORAS_DB_PATH), { recursive: true });
    const content = await fs.readFile(LORAS_DB_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if (!isMissingDbError(err)) throw err;
    return { version: 1, loras: [], curatedSets: [] };
  }
}

async function saveLorasDB(db: LoRADB): Promise<void> {
  await fs.mkdir(path.dirname(LORAS_DB_PATH), { recursive: true });
  const tmp = `${LORAS_DB_PATH}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, LORAS_DB_PATH);
}

/** Upper bound per array — a compact JSON body can otherwise push tens of
 * thousands of entries through validation and persist a huge DB in one call. */
const MAX_IMPORT_ENTRIES = 10000;

function validateImportData(data: unknown): data is ImportData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  if (typeof d.version !== "number") return false;

  // If present, each collection must be an array within the size cap.
  for (const key of ["styleCodes", "loraShortcodes"] as const) {
    if (d[key] === undefined) continue;
    if (!Array.isArray(d[key])) return false;
    if ((d[key] as unknown[]).length > MAX_IMPORT_ENTRIES) return false;
  }

  // Must have at least one of the arrays
  if (!d.styleCodes && !d.loraShortcodes) return false;

  return true;
}

function isValidStyleCode(entry: unknown): entry is StyleCodeEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return typeof e.code === "string" && /^\d{6,12}$/.test(e.code);
}

function isValidLoRA(entry: unknown): entry is LoRAShortcodeEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return typeof e.shortcode === "string" && typeof e.filename === "string";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  const result: ImportResult = {
    ok: true,
    imported: { styleCodes: 0, loraShortcodes: 0 },
    skipped: { styleCodes: 0, loraShortcodes: 0 },
    errors: [],
  };

  try {
    const { searchParams } = new URL(request.url);
    const modeParam = searchParams.get("mode") ?? "merge";
    const mode = modeParam === "replace" ? "replace" : "merge";
    const skipDuplicates = searchParams.get("skipDuplicates") !== "false";

    // Streamed cap: a Content-Length check alone is bypassed by chunked bodies.
    let importData: unknown;
    try {
      importData = await readJsonCapped(request, 5_242_880);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return NextResponse.json(
          { ok: false, error: "Payload too large (max 5MB)" },
          { status: 413 },
        );
      }
      if (e instanceof InvalidJsonBodyError) {
        return NextResponse.json(
          { ok: false, error: "Invalid JSON body" },
          { status: 400 },
        );
      }
      throw e;
    }

    if (!validateImportData(importData)) {
      return NextResponse.json(
        { ok: false, error: "Invalid import data format" },
        { status: 400 },
      );
    }

    // Import style codes
    // Same lock keys as /api/style/codes and /api/style/loras, so an import
    // can't interleave with (and drop) a concurrent single-entry write.
    if (importData.styleCodes && Array.isArray(importData.styleCodes)) {
      const styleCodes = importData.styleCodes;
      await withLock("style-codes-db", async () => {
        const codesDB =
          mode === "replace" ? { version: 1, codes: [] } : await loadCodesDB();

        const existingCodes = new Set(codesDB.codes.map((c) => c.code));

        for (const entry of styleCodes) {
          if (!isValidStyleCode(entry)) {
            result.errors.push(
              `Invalid style code entry: ${JSON.stringify(entry).slice(0, 50)}`,
            );
            continue;
          }

          if (skipDuplicates && existingCodes.has(entry.code)) {
            result.skipped.styleCodes++;
            continue;
          }

          const normalizedEntry: StyleCodeEntry = {
            code: entry.code,
            name: entry.name,
            tags: entry.tags,
            thumbnailUrl: entry.thumbnailUrl,
            createdAt: entry.createdAt ?? Date.now(),
            useCount: entry.useCount ?? 0,
            isFavorite: entry.isFavorite ?? false,
            metadata: entry.metadata,
          };

          // Remove existing if replacing
          const existingIdx = codesDB.codes.findIndex(
            (c) => c.code === entry.code,
          );
          if (existingIdx >= 0) {
            codesDB.codes.splice(existingIdx, 1);
          }

          codesDB.codes.unshift(normalizedEntry);
          existingCodes.add(entry.code);
          result.imported.styleCodes++;
        }

        await saveCodesDB(codesDB);
      });
    }

    // Import LoRA shortcodes
    if (importData.loraShortcodes && Array.isArray(importData.loraShortcodes)) {
      const loraShortcodes = importData.loraShortcodes;
      await withLock("style-loras-db", async () => {
        const lorasDB =
          mode === "replace"
            ? {
                version: 1,
                loras: [],
                curatedSets: importData.curatedSets ?? [],
              }
            : await loadLorasDB();

        const existingShortcodes = new Set(
          lorasDB.loras.map((l) => l.shortcode),
        );

        for (const entry of loraShortcodes) {
          if (!isValidLoRA(entry)) {
            result.errors.push(
              `Invalid LoRA entry: ${JSON.stringify(entry).slice(0, 50)}`,
            );
            continue;
          }

          if (skipDuplicates && existingShortcodes.has(entry.shortcode)) {
            result.skipped.loraShortcodes++;
            continue;
          }

          const normalizedEntry: LoRAShortcodeEntry = {
            shortcode: entry.shortcode,
            filename: entry.filename,
            displayName: entry.displayName,
            tags: entry.tags,
            triggers: entry.triggers,
            defaultStrength: entry.defaultStrength ?? 1.0,
            curatedSet: entry.curatedSet,
            useCount: entry.useCount ?? 0,
            isFavorite: entry.isFavorite ?? false,
            metadata: entry.metadata,
          };

          // Remove existing if replacing
          const existingIdx = lorasDB.loras.findIndex(
            (l) => l.shortcode === entry.shortcode,
          );
          if (existingIdx >= 0) {
            lorasDB.loras.splice(existingIdx, 1);
          }

          lorasDB.loras.unshift(normalizedEntry);
          existingShortcodes.add(entry.shortcode);
          result.imported.loraShortcodes++;

          // Add curated set if new
          if (
            entry.curatedSet &&
            !lorasDB.curatedSets.includes(entry.curatedSet)
          ) {
            lorasDB.curatedSets.push(entry.curatedSet);
          }
        }

        await saveLorasDB(lorasDB);
      });
    }

    return NextResponse.json(result, {
      status: 200,
      headers: apiCorsHeaders(null, "POST, OPTIONS"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Import] Error:", message);
    return NextResponse.json(
      { ...result, ok: false, error: message },
      { status: 500 },
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}
