/**
 * GET /api/onboarding/packs -> starter packs for the connected ComfyUI:
 * GPU profile + tier, per-pack fit verdict, the file chosen per slot (best
 * quant for this GPU), what is already installed, licenses, and the copyable
 * fetch commands. Read-only: never downloads anything.
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";
import { familyFor } from "@/lib/tools/toolsDoc";
import { modelListings } from "@/lib/tools/modelListing";
import { isLoopbackHost } from "@/lib/onboarding/comfyUrl";
import {
  COMFY_DIR_PLACEHOLDER,
  STARTER_PACKS,
  TIER_LABEL,
  fetchCommand,
  folderOf,
  hfCommand,
  preselectPacks,
  resolveAllPacks,
  slotOptions,
  vramTier,
  type LicenseInfo,
} from "@/lib/onboarding/starterPacks";
import { comfyModelsDir } from "@/lib/paths/resolveDirs";

export const dynamic = "force-dynamic";

async function backendProfile(): Promise<BackendProfile | null> {
  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return profileFromSystemStats(await res.json());
  } catch {
    return null;
  }
}

function licenseFor(dest: string): LicenseInfo | undefined {
  const fam = familyFor(dest);
  return fam ? { license: fam.license, commercial: fam.commercial } : undefined;
}

/** The ComfyUI folder for the command, when Adrift can see it on this disk. */
function localComfyDir(): string | null {
  try {
    if (!isLoopbackHost(new URL(env.COMFY_HTTP_URL).hostname)) return null;
  } catch {
    return null;
  }
  const root = path.resolve(env.COMFY_ROOT);
  return fs.existsSync(comfyModelsDir(root)) ? root : null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const profile = await backendProfile();
  const folders = new Set<string>();
  for (const p of STARTER_PACKS.packs)
    for (const slot of p.files)
      for (const o of slotOptions(slot)) folders.add(folderOf(o.dest));
  const raw = profile ? await modelListings(folders) : null;
  const listings = raw && Object.values(raw).some(Boolean) ? raw : null;
  const packs = resolveAllPacks(profile, listings, licenseFor);
  const tier = vramTier(profile);
  const comfyDir = localComfyDir();
  return NextResponse.json({
    ok: true,
    connected: !!profile,
    profile,
    tier,
    tierLabel: tier ? TIER_LABEL[tier] : null,
    installedKnown: !!listings,
    comfyDir: comfyDir ?? COMFY_DIR_PLACEHOLDER,
    comfyDirKnown: !!comfyDir,
    preselected: preselectPacks(tier, packs),
    packs: packs.map((p) => ({
      ...p,
      command: fetchCommand([p], comfyDir ?? COMFY_DIR_PLACEHOLDER),
      files: p.files.map((f) => ({ ...f, hfCommand: hfCommand(f) })),
    })),
  });
}
