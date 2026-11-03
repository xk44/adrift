import { NextRequest, NextResponse } from "next/server";
import { readdir } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import {
  searchStyleLoras,
  getStyleLoraCount,
  styleLoraFilename,
  STYLE_LORA_REPO,
} from "@/lib/krea2/styleLoras";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Lowercased basenames of every LoRA already present in models/loras. */
async function installedLoraSet(): Promise<Set<string>> {
  try {
    const dir = comfyModelsPath(env.COMFY_ROOT, "loras");
    const names = await readdir(dir);
    return new Set(names.map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") ?? "60", 10) || 60, 1),
    200,
  );

  const matches = searchStyleLoras(q, limit);
  const installed = await installedLoraSet();

  const loras = matches.map((l) => ({
    id: l.id,
    name: l.name,
    trigger: l.trigger,
    file: l.file,
    installed: installed.has(styleLoraFilename(l.id).toLowerCase()),
  }));

  return NextResponse.json(
    {
      repo: STYLE_LORA_REPO,
      total: getStyleLoraCount(),
      count: loras.length,
      query: q,
      loras,
    },
    { headers: CORS_HEADERS },
  );
}
