/**
 * Style Export API
 * Export style codes and LoRA shortcodes to shareable JSON format.
 *
 * GET /api/style/export
 *
 * Query params:
 * - type: "all" | "codes" | "loras" (default: all)
 * - favorites: "true" to export only favorites
 * - tag: Export only items with specific tag
 * - set: Export only LoRAs from specific curated set
 * - format: "json" | "compact" (default: json)
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateEnum, validateOptionalString } from "@/lib/validate";
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

interface ExportData {
  version: number;
  exportedAt: string;
  exportType: "all" | "codes" | "loras";
  styleCodes?: StyleCodeEntry[];
  loraShortcodes?: LoRAShortcodeEntry[];
  curatedSets?: string[];
  stats: {
    totalCodes: number;
    totalLoras: number;
  };
}

const CODES_DB_PATH = adriftDataPath("style_codes.json");
const LORAS_DB_PATH = adriftDataPath("lora_shortcodes.json");

async function loadCodesDB(): Promise<{ codes: StyleCodeEntry[] }> {
  try {
    const content = await fs.readFile(CODES_DB_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return { codes: [] };
  }
}

async function loadLorasDB(): Promise<{
  loras: LoRAShortcodeEntry[];
  curatedSets: string[];
}> {
  try {
    const content = await fs.readFile(LORAS_DB_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return { loras: [], curatedSets: [] };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  try {
    const { searchParams } = new URL(request.url);

    const type = validateEnum(
      searchParams.get("type"),
      new Set(["all", "codes", "loras"] as const),
      "all" as const,
    );
    const favoritesOnly = searchParams.get("favorites") === "true";
    const tag = validateOptionalString(searchParams.get("tag"), 64);
    const set = validateOptionalString(searchParams.get("set"), 64);
    const format = validateEnum(
      searchParams.get("format"),
      new Set(["json", "compact"] as const),
      "json" as const,
    );

    const exportData: ExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      exportType: type,
      stats: { totalCodes: 0, totalLoras: 0 },
    };

    // Load and filter style codes
    if (type === "all" || type === "codes") {
      const codesDB = await loadCodesDB();
      let codes = [...codesDB.codes];

      if (favoritesOnly) {
        codes = codes.filter((c) => c.isFavorite);
      }
      if (tag) {
        codes = codes.filter((c) => c.tags?.includes(tag));
      }

      exportData.styleCodes = codes;
      exportData.stats.totalCodes = codes.length;
    }

    // Load and filter LoRAs
    if (type === "all" || type === "loras") {
      const lorasDB = await loadLorasDB();
      let loras = [...lorasDB.loras];

      if (favoritesOnly) {
        loras = loras.filter((l) => l.isFavorite);
      }
      if (tag) {
        loras = loras.filter((l) => l.tags?.includes(tag));
      }
      if (set) {
        loras = loras.filter((l) => l.curatedSet === set);
      }

      exportData.loraShortcodes = loras;
      exportData.curatedSets = lorasDB.curatedSets;
      exportData.stats.totalLoras = loras.length;
    }

    let output: string;
    let contentType: string;
    let filename: string;

    if (format === "compact") {
      // Compact format - minimal JSON
      output = JSON.stringify(exportData);
      contentType = "application/json";
      filename = `style-export-${Date.now()}.json`;
    } else {
      output = JSON.stringify(exportData, null, 2);
      contentType = "application/json";
      filename = `style-library-export-${new Date().toISOString().split("T")[0]}.json`;
    }

    return new NextResponse(output, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...apiCorsHeaders(null, "GET, OPTIONS"),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Export] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}
