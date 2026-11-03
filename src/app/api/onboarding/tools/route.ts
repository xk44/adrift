/**
 * GET /api/onboarding/tools -> every Tools-page card with its model files,
 * sizes, what's installed and what fits this GPU, for the wizard's per-tool
 * picker. Read-only: never downloads anything.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { profileFromSystemStats } from "@/lib/models/compat";
import { familyFor } from "@/lib/tools/toolsDoc";
import { modelListings } from "@/lib/tools/modelListing";
import { folderOf } from "@/lib/onboarding/starterPacks";
import { resolveToolRows, type ToolMapEntry } from "@/lib/onboarding/toolPicker";
import modelSizes from "@/lib/tools/modelSizes.json";

export const dynamic = "force-dynamic";

async function profile() {
  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? profileFromSystemStats(await res.json()) : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  let tools: ToolMapEntry[];
  try {
    const raw = await fsp.readFile(
      path.join(process.cwd(), "docs", "models-by-tool.json"),
      "utf8",
    );
    tools = (JSON.parse(raw) as { tools: ToolMapEntry[] }).tools;
  } catch {
    return NextResponse.json(
      { ok: false, error: "The tool list is missing." },
      { status: 500 },
    );
  }
  const prof = await profile();
  const folders = new Set(tools.flatMap((t) => t.files.map(folderOf)));
  const raw = prof ? await modelListings(folders) : null;
  const listings = raw && Object.values(raw).some(Boolean) ? raw : null;
  const rows = resolveToolRows(
    tools,
    modelSizes.files,
    prof,
    listings,
    (dest) => {
      const fam = familyFor(dest);
      return fam
        ? { license: fam.license, commercial: fam.commercial }
        : undefined;
    },
  );
  return NextResponse.json({ ok: true, tools: rows });
}
