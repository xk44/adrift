/**
 * GET /api/integrations → { ok, integrations: { styleVault, nevo } }
 *
 * Which optional external services are configured (see lib/integrations.ts).
 * The UI hides their entry points when they are not.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiOk } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { integrationsFromEnv } from "@/lib/integrations";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(req, { max: 60 });
  if (!auth.ok) return auth.response;
  return apiOk({ integrations: integrationsFromEnv() });
}
