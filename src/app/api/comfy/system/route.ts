/**
 * ComfyUI system route
 *
 * GET  /api/comfy/system — device/VRAM stats + version info from /system_stats
 *      (ComfyUI 0.24+: multi-GPU device list + comfy_package_versions)
 * POST /api/comfy/system — maintenance actions: {"action": "interrupt" | "free"}
 *      interrupt: stop the currently executing prompt
 *      free: unload models and free VRAM (ComfyUI /free endpoint)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiError, apiOptions } from "@/lib/api";
import { comfyFetch } from "@/lib/comfy/comfyFetch";

interface ComfyDevice {
  name?: string;
  type?: string;
  index?: number;
  vram_total?: number;
  vram_free?: number;
  torch_vram_total?: number;
  torch_vram_free?: number;
}

interface ComfySystemStats {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    ram_total?: number;
    ram_free?: number;
    comfy_package_versions?: Array<{
      name: string;
      installed: string;
      required: string;
    }>;
  };
  devices?: ComfyDevice[];
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 10_000, max: 20 });
  if (!rl.ok) return rl.response;

  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return apiError(`ComfyUI returned ${res.status}`, { status: 502 });
    }
    const stats = (await res.json()) as ComfySystemStats;

    return NextResponse.json({
      ok: true,
      system: {
        os: stats.system?.os,
        comfyuiVersion: stats.system?.comfyui_version,
        pythonVersion: stats.system?.python_version,
        pytorchVersion: stats.system?.pytorch_version,
        ramTotal: stats.system?.ram_total,
        ramFree: stats.system?.ram_free,
        packageVersions: stats.system?.comfy_package_versions ?? [],
      },
      devices: (stats.devices ?? []).map((d) => ({
        name: d.name,
        type: d.type,
        index: d.index,
        vramTotal: d.vram_total,
        vramFree: d.vram_free,
        torchVramTotal: d.torch_vram_total,
        torchVramFree: d.torch_vram_free,
      })),
    });
  } catch {
    return apiError("ComfyUI unreachable", { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let action: string;
  try {
    const body = (await req.json()) as { action?: unknown };
    action = typeof body.action === "string" ? body.action : "";
  } catch {
    return apiError("Invalid JSON body", { status: 400 });
  }

  try {
    if (action === "interrupt") {
      const res = await comfyFetch("/interrupt", {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return apiError(`ComfyUI returned ${res.status}`, { status: 502 });
      return NextResponse.json({ ok: true, action });
    }

    if (action === "free") {
      const res = await comfyFetch("/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return apiError(`ComfyUI returned ${res.status}`, { status: 502 });
      return NextResponse.json({ ok: true, action });
    }

    return apiError("Unknown action: expected 'interrupt' or 'free'", { status: 400 });
  } catch {
    return apiError("ComfyUI unreachable", { status: 503 });
  }
}

export function OPTIONS() {
  return apiOptions();
}
