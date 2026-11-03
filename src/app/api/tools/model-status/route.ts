/**
 * GET /api/tools/model-status
 * For action tools that need specific weights (video swap, MOSS-Image),
 * reports which loader files are missing under COMFY_ROOT/models.
 *   → { ok, tools: { [toolId]: { missing: string[] } },
 *       packs: { [packId]: { missing: string[] } },
 *       options: { [optionKey]: { file, missing: string[] } },
 *       mossDefaultSpeed: MossSpeed }
 * `options` covers the optional LoRA toggles: H3 motionRepair / handheld,
 * H3 h3Flex / h3Turbo8 / h3Turbo4 (`file` = the fl2v LoRA, `missing` covers
 * both the fl2v and ref2v files), H3 h3Fast8 (FastH3 DiTs: `file` = the fl2v one,
 * `missing` covers both, checked on the video backend's /object_info when
 * the minimax pack routes there, else on disk) and
 * MOSS-Image mossSpeed8 / mossSpeed4 / deband / mossTurbo (MOSS keys only when that pack
 * is registered), seedvr2_7b / seedvr2_7b_sharp (the SeedVR2 model choice:
 * DiT files on the host the seedvr2 pack routes to), characterSwapMasked
 * (character_swap's mannequin mode: its own graph's missing files/nodes; the
 * card itself is checked on the default full-mode graph).
 * `mossDefaultSpeed` is what an unset --speed resolves to.
 * `packs` covers t2i packs that need weights (MOSS-Image); only registered
 * (env-enabled) packs appear.
 * A tool whose pack/workflow can't be resolved is left out; the UI then
 * relies on the pack check alone. A modelCheck action the pack lacks falls
 * back to the registry action's template file (make_3d → i23d.json).
 *
 * Multi-host: a tool that routes to the video backend (COMFY_VIDEO_HTTP_URL,
 * see src/lib/comfy/backends.ts) is checked against THAT host's /object_info
 * (its "<name>.video.json" variant when present); an unreachable host reports
 * "backend unreachable: <url>". Default-backend tools add missing node
 * classes from /object_info (e.g. "node:TripoSRModelLoader").
 */
import fs from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import registry from "@/lib/oj/registry.json";
import { routeBackendUrl, routeCandidates } from "@/lib/comfy/backends";
import {
  backendUnetFiles,
  missingOnBackend,
  missingOnDefaultBackend,
  modelCheckWorkflowRel,
  videoVariantRel,
} from "@/lib/comfy/backendModels";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import type { Workflow } from "@/types";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { getPack } from "@/lib/oj/packs";
import { loadPackWorkflow, stripNonNodes } from "@/lib/tools/editTools";
import { missingWorkflowModels } from "@/lib/tools/modelStatus";
import {
  ACTION_TOOLS,
  CHARACTER_SWAP_MASKED_OPTION,
} from "@/lib/tools/toolsPage";
import { H3_EXTRA_LORAS, H3_FLEX_LORAS } from "@/lib/oj/h3Video";
import { FASTH3_RECIPES, H3_TURBO_LORAS } from "@/lib/oj/h3Speed";
import {
  MOSS_BASE_DMD_LORA,
  MOSS_BASE_UNET,
  MOSS_DEBAND_LORA,
  MOSS_SPEED_4_LORA,
  MOSS_SPEED_8_LORA,
  defaultMossSpeed,
  installedLoras,
  installedUnets,
  missingLoraFiles,
} from "@/lib/oj/mossImageDefaults";
import type { MossSpeed } from "@/lib/oj/mossImage";
import { SEEDVR2_MODELS } from "@/lib/oj/seedvr2Upscale";

const MODEL_CHECK_PACKS = ["moss-image"];

/** Gated actions reported even when no tools-page spec names them. */
const EXTRA_MODEL_CHECKS: Array<{ id: string; pack: string; action: string }> =
  [
    { id: "transition", pack: "minimax", action: "transition" },
    { id: "character_swap", pack: "minimax", action: "character_swap" },
    // Music video card + its optional stems step (CJAudioStems, cj_stems).
    { id: "music_video", pack: "minimax", action: "music_video" },
    { id: "music_video_stems", pack: "minimax", action: "music_video_stems" },
    { id: "video_bg_remove", pack: "utility", action: "video_bg_remove" },
    { id: "subject_matte", pack: "matanyone", action: "subject_matte" },
    { id: "make_3d", pack: "utility", action: "make_3d" },
    { id: "wan_motion", pack: "wan22", action: "wan_motion" },
    { id: "wan_camera", pack: "wan22", action: "wan_camera" },
    // Character picker "From a reference image (Anima)" (no Tools card).
    { id: "anima_ref", pack: "anima", action: "anima_ref" },
  ];

/**
 * A pack graph as the job route would queue it: a graph with a `_fallback`
 * (e.g. anima_ref -> the pilot graph on an older node pack) resolves it
 * against /object_info first, so the report names the weights that would run.
 */
async function loadResolvedPackWorkflow(rel: string): Promise<Workflow> {
  const raw = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "public", "workflows", rel), "utf8"),
  ) as Record<string, unknown>;
  if (!raw._fallback) return loadPackWorkflow(rel);
  const { applyWorkflowFallback } = await import("@/lib/comfy/workflows");
  return stripNonNodes(
    (await applyWorkflowFallback(raw, rel)) as Record<string, unknown>,
  );
}

async function toolMissing(
  pack: string,
  action: string,
): Promise<string[] | undefined> {
  const rel = modelCheckWorkflowRel(
    getPack(pack)?.workflows[action],
    action,
    registry as unknown as Parameters<typeof modelCheckWorkflowRel>[2],
  );
  if (!rel) return undefined;
  try {
    const routed = routeCandidates({ action, packId: pack, workflowPath: rel })[0];
    if (!routed.primary) {
      // "<name>.video.json" = the video host's variant (same rule as jobs/action).
      let wf: Workflow;
      try {
        if (routed.role !== "video") throw new Error("no variant");
        wf = await loadPackWorkflow(videoVariantRel(rel));
      } catch {
        wf = await loadPackWorkflow(rel);
      }
      return await missingOnBackend(wf, routed.url);
    }
    const wf = await loadResolvedPackWorkflow(rel);
    return await missingOnDefaultBackend(wf, {
      diskMissing: (w) => missingWorkflowModels(w, env.COMFY_ROOT),
      objectInfo: () => getObjectInfoCached(),
      customNodeDirs: () =>
        fs.readdir(path.join(env.COMFY_ROOT, "custom_nodes")),
    });
  } catch {
    return undefined; /* unreadable graph: leave the tool out */
  }
}

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const tools: Record<string, { missing: string[] }> = {};
  const checks: Array<{ id: string; pack: string; action: string }> =
    ACTION_TOOLS.filter((s) => s.modelCheck).map((s) => ({
      id: s.id,
      pack: s.modelCheck!.pack,
      action: s.modelCheck!.action,
    }));
  for (const extra of EXTRA_MODEL_CHECKS) {
    if (!checks.some((c) => c.id === extra.id)) checks.push(extra);
  }
  for (const check of checks) {
    const missing = await toolMissing(check.pack, check.action);
    if (missing) tools[check.id] = { missing };
  }
  const packs: Record<string, { missing: string[] }> = {};
  for (const packId of MODEL_CHECK_PACKS) {
    const rel = getPack(packId)?.workflows.t2i;
    if (!rel) continue;
    try {
      const wf = await loadPackWorkflow(rel);
      packs[packId] = {
        missing: await missingWorkflowModels(wf, env.COMFY_ROOT),
      };
    } catch {
      /* unreadable graph: leave the pack out */
    }
  }

  const options: Record<string, { file: string; missing: string[] }> = {};
  // character_swap mode "mannequin" runs its own graph (int8 Ref2VA + SAM3);
  // the card itself is keyed to the default "full" graph.
  {
    const missing = await toolMissing("minimax", "character_swap_masked");
    if (missing)
      options[CHARACTER_SWAP_MASKED_OPTION] = {
        file: "packs/minimax/character_swap_masked.json",
        missing,
      };
  }
  let mossDefaultSpeed: MossSpeed = "off";
  try {
    const installed = await installedLoras(env.COMFY_ROOT);
    const optionFiles: Array<[string, string]> = H3_EXTRA_LORAS.map((l) => [
      l.key,
      l.file,
    ]);
    if (getPack("moss-image")) {
      optionFiles.push(
        ["mossSpeed8", MOSS_SPEED_8_LORA],
        ["mossSpeed4", MOSS_SPEED_4_LORA],
        ["deband", MOSS_DEBAND_LORA],
        ["mossTurbo", MOSS_BASE_DMD_LORA],
      );
      mossDefaultSpeed = defaultMossSpeed(installed);
    }
    for (const [key, file] of optionFiles) {
      options[key] = { file, missing: missingLoraFiles(installed, [file]) };
    }
    // h3Flex / h3Speed: the LoRA depends on the graph family (fl2v / ref2v).
    for (const [key, files] of [
      ["h3Flex", H3_FLEX_LORAS],
      ["h3Turbo8", H3_TURBO_LORAS.turbo8],
      ["h3Turbo4", H3_TURBO_LORAS.turbo4],
    ] as const) {
      options[key] = {
        file: files.fl2v,
        missing: missingLoraFiles(installed, [files.fl2v, files.ref2v]),
      };
    }
    // h3Speed fast8 swaps the DiT (FastH3, int8: runs on the CUDA video host).
    {
      const fast = [FASTH3_RECIPES.fl2v.unet, FASTH3_RECIPES.ref2v.unet];
      const videoUrl = routeBackendUrl({ packId: "minimax" });
      const have = videoUrl
        ? await backendUnetFiles(videoUrl)
        : await installedUnets(env.COMFY_ROOT);
      options.h3Fast8 = {
        file: fast[0],
        missing: fast
          .filter((f) => !have?.has(f.toLowerCase()))
          .map((f) => `diffusion_models/${f}`),
      };
    }
    // SeedVR2 7B / 7B sharp: model-choice DiTs (the pack routes to the video host).
    {
      const videoUrl = routeBackendUrl({ packId: "seedvr2" });
      const have = videoUrl
        ? await backendUnetFiles(videoUrl)
        : await installedUnets(env.COMFY_ROOT);
      for (const [key, file] of [
        ["seedvr2_7b", SEEDVR2_MODELS.quality],
        ["seedvr2_7b_sharp", SEEDVR2_MODELS.sharp],
      ] as const) {
        options[key] = {
          file,
          missing: have?.has(file.toLowerCase())
            ? []
            : [`diffusion_models/${file}`],
        };
      }
    }
    // Turbo also swaps the UNET to MOSS-Image Base.
    if (options.mossTurbo) {
      const unets = await installedUnets(env.COMFY_ROOT);
      if (!unets.has(MOSS_BASE_UNET.toLowerCase()))
        options.mossTurbo.missing.push(`diffusion_models/${MOSS_BASE_UNET}`);
    }
  } catch {
    /* unreadable models dir: omit option state */
  }
  return NextResponse.json(
    { ok: true, tools, packs, options, mossDefaultSpeed },
    { headers: CORS_HEADERS },
  );
}
