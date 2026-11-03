import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { installedLorasFor } from "@/lib/tools/editTools";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  getBuiltinEditLoras,
  getEditFamilies,
  mergeEditLoras,
  preferEditLora,
  type EditLora,
} from "@/lib/krea2/editLoras";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");
const USER_DATA = "data/edit-loras.json";

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function loadUserLoras(): Promise<EditLora[]> {
  try {
    const raw = await readFile(path.resolve(USER_DATA), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.loras) ? parsed.loras : [];
  } catch {
    return [];
  }
}

async function installedLoraSet(): Promise<Set<string>> {
  // Recursive: edit LoRAs may live in subfolders (e.g. "edit_tools/foo.safetensors").
  // The GPU backend's LoRA list wins over the web host's disk when reachable.
  const objectInfo = await getObjectInfoCached().catch(() => null);
  return installedLorasFor(env.COMFY_ROOT, objectInfo);
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const [user, installed] = await Promise.all([
    loadUserLoras(),
    installedLoraSet(),
  ]);
  const loras = preferEditLora(
    mergeEditLoras(user),
    process.env.ADRIFT_DEFAULT_EDIT_LORA,
  ).map((l) => ({
    ...l,
    installed: installed.has(l.file.toLowerCase()),
  }));
  return NextResponse.json(
    {
      families: getEditFamilies(),
      loras,
      builtinCount: getBuiltinEditLoras().length,
    },
    { headers: CORS_HEADERS },
  );
}
