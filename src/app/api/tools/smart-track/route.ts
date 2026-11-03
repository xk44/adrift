/**
 * POST /api/tools/smart-track
 * Smart select for video tools (VideoMaskPicker) via core SAM3.
 * Body:
 *   { mode: "frame", video: "<uploaded video ref>", t, positive: [{x,y}], negative?: [{x,y}] }
 *     -> { ok, mask: "data:image/png;base64,..." (natural clip size), ms }
 *   { mode: "track", video, occurrences: [{t, positive, negative}], seconds? }
 *     -> { ok, video: "/api/comfy/view?...", frames, ms }
 *        overlay clip (subject tinted) on the same prepared frames the tools use
 *        (LabsH3PrepareVideo 480 / 24 fps, first `seconds`).
 * Coordinates are natural video pixels. The client uploads the clip once via
 * /api/comfy/upload and sends the returned ref.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { withRateLimit } from "@/lib/rateLimit";
import {
  ComfyAPIError,
  fetchHistory,
  fetchImageBase64,
  queuePrompt,
} from "@/lib/comfy/http";
import {
  defaultBackendUrl,
  preferredVideoBackendUrl,
} from "@/lib/comfy/backends";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import { parseInputRef } from "@/lib/seedRun";
import {
  PREVIEW_FRAME_OUTPUT,
  PREVIEW_TRACK_OUTPUT,
  SmartTrackError,
  buildFramePreviewWorkflow,
  buildTrackPreviewWorkflow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";
import type { ComfyHistoryEntry, Workflow } from "@/types";

const MAX_BODY_BYTES = 256 * 1024;
const FRAME_WAIT_MS = 60_000;
const TRACK_WAIT_MS = 300_000;
const POLL_MS = 300;
const MAX_TRACK_SECONDS = 10;

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(req, "POST, OPTIONS"),
  });
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function runAndWait(
  workflow: Workflow,
  outputNode: string,
  waitMs: number,
): Promise<{ entry: ComfyHistoryEntry; out: Record<string, unknown> }> {
  const base = preferredVideoBackendUrl() ?? defaultBackendUrl();
  const { prompt_id: promptId } = await queuePrompt(
    workflow,
    `smarttrack-${Date.now().toString(36)}`,
    base,
    { front: true },
  );
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const entry = await fetchHistory(promptId, base).catch(() => null);
    if (entry?.status?.status_str === "error")
      throw new ComfyAPIError("SAM3 failed on ComfyUI (see ComfyUI log)", 502);
    const out = entry?.outputs?.[outputNode];
    if (entry && out) return { entry, out: out as Record<string, unknown> };
    if (entry?.status?.completed)
      throw new ComfyAPIError("SAM3 returned no output", 502);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new ComfyAPIError("Timed out waiting for SAM3 (ComfyUI busy?)", 504);
}

export async function POST(req: NextRequest) {
  const headers = apiCorsHeaders(req, "POST, OPTIONS");
  const fail = (error: string, status: number) =>
    NextResponse.json({ ok: false, error }, { status, headers });

  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return fail("Payload too large", 413);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object") return fail("Invalid JSON body", 400);

  const video = typeof body.video === "string" ? body.video.trim() : "";
  if (!parseInputRef(video, { allowVideo: true }))
    return fail(
      'video must be an uploaded video ref ("name.mp4 [input]")',
      400,
    );

  const t0 = Date.now();
  try {
    if (body.mode === "track") {
      const occurrences = parseSmartTrack(body.occurrences);
      if (occurrences.length === 0)
        return fail("click the subject on at least one frame", 400);
      const seconds = Math.min(
        MAX_TRACK_SECONDS,
        Math.max(0.5, num(body.seconds, 3)),
      );
      const wf = buildTrackPreviewWorkflow(video, occurrences, seconds);
      const { out } = await runAndWait(wf, PREVIEW_TRACK_OUTPUT, TRACK_WAIT_MS);
      const file = (
        (out.images ?? out.videos ?? out.gifs) as
          { filename: string; subfolder?: string; type?: string }[] | undefined
      )?.[0];
      if (!file) return fail("SAM3 returned no preview video", 502);
      const q = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder ?? "",
        type: file.type ?? "output",
      });
      return NextResponse.json(
        {
          ok: true,
          video: `/api/comfy/view?${q.toString()}`,
          occurrences: occurrences.length,
          seconds,
          ms: Date.now() - t0,
        },
        { headers },
      );
    }

    const [occ] = parseSmartTrack([
      { t: body.t, positive: body.positive, negative: body.negative },
    ]);
    if (!occ) return fail("add an include point", 400);
    const wf = buildFramePreviewWorkflow(
      video,
      occ.t,
      occ.positive,
      occ.negative,
    );
    const { out } = await runAndWait(wf, PREVIEW_FRAME_OUTPUT, FRAME_WAIT_MS);
    const img = (
      out.images as
        { filename: string; subfolder?: string; type?: string }[] | undefined
    )?.[0];
    if (!img) return fail("SAM3 returned no mask", 502);
    const mask = await fetchImageBase64(
      img.filename,
      img.subfolder ?? "",
      img.type ?? "temp",
    );
    return NextResponse.json(
      { ok: true, mask, t: occ.t, ms: Date.now() - t0 },
      { headers },
    );
  } catch (e) {
    if (e instanceof SmartTrackError) return fail(e.message, 400);
    if (e instanceof ComfyAPIError) {
      const s = e.statusCode;
      return fail(e.message, s && s >= 400 && s < 600 ? s : 502);
    }
    if (e instanceof PromptValidationError) return fail(e.message, 422);
    return fail(e instanceof Error ? e.message : String(e), 502);
  }
}
