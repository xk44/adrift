/**
 * POST /api/settings/training/detect -> { ok, backends: BackendDetect[] }
 *
 * Checks the SAVED trainer paths (never paths from the request): repo folder
 * and entrypoints, python executable, repo commit (`git rev-parse`, no
 * shell) and which model families each backend can train right now.
 */
import { NextRequest, NextResponse } from "next/server";
import { guardRoute } from "@/lib/routeGuard";
import { detectBackend } from "@/lib/training/local/config";
import { TRAINER_BACKENDS } from "@/lib/training/local/schema";
import { readTrainingSettings } from "@/lib/runtimeSettings";
import { tildePath } from "@/lib/paths/resolveDirs";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(req, { max: 20 });
  if (!auth.ok) return auth.response;
  const settings = readTrainingSettings();
  const backends = await Promise.all(
    TRAINER_BACKENDS.map((id) => detectBackend(id, settings)),
  );
  return NextResponse.json({
    ok: true,
    backends: backends.map((b) => ({
      ...b,
      repoPath: b.repoPath ? tildePath(b.repoPath) : null,
      pythonBin: b.pythonBin ? tildePath(b.pythonBin) : null,
    })),
  });
}
