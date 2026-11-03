/**
 * GET /api/setup/first-run[?model=<picked model>]
 *
 * Read-only status for the first-run checklist in Create's empty state:
 *   { ok, comfy: { reachable, url }, comfyRoot,
 *     createModel: { state, packId, packName, using?, missing[], starter?,
 *                    starterPack? } }
 * One /system_stats probe (2 s) and, only when ComfyUI answers, the shared
 * cached /object_info. Never queues anything. Admin-gated because it reports
 * local paths (COMFY_ROOT) for the copyable fix commands.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { getDefaultPack } from "@/lib/oj/packs";
import { loadPackWorkflow } from "@/lib/tools/editTools";
import { assessCreateModel } from "@/lib/setup/firstRunCheck";
import { starterPackHint } from "@/lib/setup/starterPackHint";
import {
  SDXL_STARTER,
  type CreateModelCheck,
  type FirstRunStatus,
} from "@/lib/setup/firstRun";

/** COMFY_HTTP_URL without credentials, path or query. */
function publicComfyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

async function comfyReachable(): Promise<boolean> {
  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkCreateModel(
  reachable: boolean,
  pickedModel: string | undefined,
): Promise<CreateModelCheck> {
  let packId = "";
  let packName = "";
  try {
    const pack = getDefaultPack();
    packId = pack.id;
    packName = pack.name;
    if (!reachable) return { state: "unknown", packId, packName, missing: [] };
    const rel = pack.workflows.t2i;
    const info = await getObjectInfoCached();
    if (!rel || !info)
      return { state: "unknown", packId, packName, missing: [] };
    const workflow = await loadPackWorkflow(rel);
    const result = assessCreateModel(workflow, info, {
      preferredCheckpoint: env.COMFY_DEFAULT_CHECKPOINT,
      pickedModel,
    });
    const needsCheckpoint = result.missing.some((m) =>
      m.startsWith("checkpoints/"),
    );
    const sdxlStarter =
      needsCheckpoint && pack.modelFamily === "sdxl" && !pickedModel;
    // Any other default engine (Krea 2): point at its starter pack.
    const packHint =
      !sdxlStarter &&
      !pickedModel &&
      result.missing.some((m) => !m.startsWith("node:"))
        ? starterPackHint(pack.id, env.COMFY_ROOT)
        : undefined;
    return {
      ...result,
      packId,
      packName,
      ...(sdxlStarter ? { starter: SDXL_STARTER } : {}),
      ...(packHint ? { starterPack: packHint } : {}),
    };
  } catch {
    return { state: "unknown", packId, packName, missing: [] };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const picked =
    new URL(request.url).searchParams.get("model")?.trim().slice(0, 512) ||
    undefined;
  const reachable = await comfyReachable();
  const body: FirstRunStatus = {
    ok: true,
    comfy: { reachable, url: publicComfyUrl(env.COMFY_HTTP_URL) },
    comfyRoot: env.COMFY_ROOT,
    createModel: await checkCreateModel(reachable, picked),
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
