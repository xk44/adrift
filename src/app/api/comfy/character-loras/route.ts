/**
 * GET /api/comfy/character-loras
 *   → { ok, loras: ServerLoraInfo[], local: boolean, animaRefAdapter: boolean,
 *       animaRefAdapterV2: boolean }
 *
 * Installed LoRAs for the prompt bar's Character picker. The list comes from
 * ComfyUI (/models/loras); when ComfyUI runs on this machine, sidecar files
 * next to each LoRA add tags, base model, trigger words and a preview flag.
 * `animaRefAdapter` says whether ComfyUI-Anima-Ref-Adapter is installed
 * (reference-image characters); `animaRefAdapterV2` whether it has the v2
 * AnimaRefAdapter node (a second, two-character reference).
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { listComfyModelFolder } from "@/lib/comfy/modelFolders";
import { readLoraSidecars } from "@/lib/characters/loraSidecars";
import { localLorasDir } from "@/lib/characters/localLoras";
import {
  ANIMA_REF_ADAPTER_NODE,
  ANIMA_REF_ADAPTER_V2_NODE,
  hasAnimaRefAdapter,
  hasAnimaRefAdapterV2,
} from "@/lib/characters/characterLoras";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

async function nodeInfo(node: string): Promise<unknown> {
  try {
    const res = await comfyFetch(`/object_info/${node}`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Pilot loader and v2 node, checked separately (per-node object_info). */
async function detectAnima(): Promise<{ any: boolean; v2: boolean }> {
  const [pilot, v2] = await Promise.all([
    nodeInfo(ANIMA_REF_ADAPTER_NODE),
    nodeInfo(ANIMA_REF_ADAPTER_V2_NODE),
  ]);
  const hasV2 = hasAnimaRefAdapterV2(v2);
  return { any: hasV2 || hasAnimaRefAdapter(pilot), v2: hasV2 };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  try {
    const [files, anima] = await Promise.all([
      // Strict: unreachable ComfyUI is a 502 ("could not reach"), not "no LoRAs".
      listComfyModelFolder("loras", comfyFetch, { strict: true }),
      detectAnima(),
    ]);
    const dir = localLorasDir();
    const loras = dir
      ? await readLoraSidecars(dir, files)
      : files.map((filename) => ({ filename }));
    return apiOk({
      loras,
      local: Boolean(dir),
      animaRefAdapter: anima.any,
      animaRefAdapterV2: anima.v2,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    apiErr("CharacterLoras", "Error", message);
    return apiError("Could not list LoRAs", { status: 502 });
  }
}
