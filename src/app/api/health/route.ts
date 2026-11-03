import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  nodeHealth,
  nodeRequirements,
  type NodeHealth,
  type NodeRequirements,
} from "@/lib/health/nodeHealth";

const startedAt = Date.now();

/**
 * Node classes the packs depend on, derived once from the pack graphs
 * (lib/health/nodeHealth.ts): required = the default pack's t2i graph,
 * optional = per-pack extras. Reported by GET /api/health?nodes=1 so a
 * broken ComfyUI custom_nodes install is diagnosable from Adrift.
 */
let requirements: Promise<NodeRequirements> | null = null;
function packRequirements(): Promise<NodeRequirements> {
  requirements ??= (async () => {
    const [{ getAllPacks, getDefaultPack }, fs, path] = await Promise.all([
      import("@/lib/oj/packs"),
      import("fs/promises"),
      import("path"),
    ]);
    const dir = path.join(process.cwd(), "public", "workflows");
    return nodeRequirements(getAllPacks(), getDefaultPack().id, async (rel) =>
      JSON.parse(await fs.readFile(path.join(dir, rel), "utf8")),
    );
  })().catch((e) => {
    requirements = null;
    throw e;
  });
  return requirements;
}

/** ok = all required nodes present; offline = ComfyUI unreachable. */
type NodesStatus = "ok" | "missing" | "offline" | "unknown";

/** GET /api/health — lightweight health check for monitoring and overlay mode. */
export async function GET(request: NextRequest) {
  let comfyui: "connected" | "disconnected" = "disconnected";
  let nodes: NodeHealth | undefined;

  const wantNodes = new URL(request.url).searchParams.get("nodes") === "1";
  if (wantNodes) {
    const auth = requireAdmin(request);
    if (!auth.ok) return auth.response;
  }

  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) comfyui = "connected";
  } catch {
    // ComfyUI unreachable — leave as disconnected
  }

  if (wantNodes && comfyui === "connected") {
    try {
      const res = await comfyFetch("/object_info", {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const info = (await res.json()) as Record<string, unknown>;
        nodes = nodeHealth(await packRequirements(), info);
      }
    } catch {
      // node inventory is best-effort
    }
  }

  const nodesStatus: NodesStatus | undefined = !wantNodes
    ? undefined
    : comfyui === "disconnected"
      ? "offline"
      : !nodes
        ? "unknown"
        : nodes.ok
          ? "ok"
          : "missing";

  return NextResponse.json({
    ok: true,
    comfyui,
    ...(nodes ? { nodes } : {}),
    ...(nodesStatus ? { nodesStatus } : {}),
    version: process.env.npm_package_version ?? "0.3.0",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
}
