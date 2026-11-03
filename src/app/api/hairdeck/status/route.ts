/**
 * GET /api/hairdeck/status: is the optional HairDeck sidecar configured
 * (HAIRDECK_BACKEND_URL) and answering? Never exposes the URL itself.
 */
import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api";
import { hairdeckConfig } from "@/lib/hairdeck/config";
import { hairdeckProbe } from "@/lib/hairdeck/gradio";
import { guardRoute, isLoopbackRequest } from "@/lib/routeGuard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = guardRoute(req, { max: 60 });
  if (!auth.ok) return auth.response;
  const local = isLoopbackRequest(req);
  const cfg = hairdeckConfig();
  if (!cfg.configured) return apiOk({ configured: false, reachable: false, local });
  if (cfg.url === null)
    return apiOk({ configured: true, reachable: false, local, error: cfg.error });
  const probe = await hairdeckProbe(cfg.url);
  return apiOk({
    configured: true,
    reachable: probe.reachable,
    local,
    ...(probe.reachable ? {} : { error: probe.error }),
  });
}
