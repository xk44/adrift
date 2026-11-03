/**
 * POST /api/hairdeck/generate: one portrait -> HairDeck hair cards via the
 * optional sidecar, saved to Adrift outputs. Loopback-only: it drives a
 * long GPU job on another service. Body: see parseHairDeckRequest.
 */
import { NextRequest } from "next/server";
import { apiErr, apiError, apiOk } from "@/lib/api";
import {
  HAIRDECK_MAX_BODY_BYTES,
  hairdeckConfig,
  parseHairDeckRequest,
} from "@/lib/hairdeck/config";
import { isHairDeckError, runHairDeck } from "@/lib/hairdeck/gradio";
import { saveHairDeckResult } from "@/lib/hairdeck/save";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { guardRoute, loopbackOnly } from "@/lib/routeGuard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 1200;

// The demo runs one GPU job at a time; a second click gets a clear 409
// instead of waiting silently behind a long run.
let busy = false;

export async function POST(req: NextRequest) {
  const local = loopbackOnly(req);
  if (!local.ok) return local.response;
  const auth = guardRoute(req, { max: 6 });
  if (!auth.ok) return auth.response;

  const cfg = hairdeckConfig();
  if (!cfg.configured)
    return apiError("HairDeck is not connected. Set HAIRDECK_BACKEND_URL and restart Adrift.", { status: 503 });
  if (cfg.url === null) return apiError(cfg.error, { status: 503 });

  if (!(req.headers.get("content-type") ?? "").includes("application/json"))
    return apiError("Send JSON.", { status: 415 });
  let body: unknown;
  try {
    body = await readJsonCapped(req, HAIRDECK_MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      return apiError("Request is too large.", { status: 413 });
    return apiError("Invalid JSON.", { status: 400 });
  }
  const parsed = parseHairDeckRequest(body);
  if (!parsed.ok) return apiError(parsed.error, { status: 400 });

  if (busy) return apiError("HairDeck is already working on a portrait.", { status: 409 });
  busy = true;
  try {
    const files = await runHairDeck(cfg.url, parsed.value, { signal: req.signal });
    return apiOk({ ...(await saveHairDeckResult(files, parsed.value)) });
  } catch (e) {
    if (isHairDeckError(e)) return apiError(e.message, { status: e.status });
    apiErr("hairdeck", "save failed", { error: (e as Error).message });
    return apiError("Could not save the HairDeck result to Adrift outputs.", { status: 500 });
  } finally {
    busy = false;
  }
}
