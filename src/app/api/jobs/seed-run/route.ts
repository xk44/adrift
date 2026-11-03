/**
 * POST /api/jobs/seed-run
 * Wrap an uploaded image (from POST /api/comfy/upload) in a finished,
 * in-memory ImagineRun so native clients can run any image action
 * (/api/jobs/action: edit, upscale, bg_remove, animate, …) on a camera-roll
 * photo. Queues nothing on the GPU and isn't persisted to the feed.
 *
 * Video tools (character swap) seed an uploaded clip the same way: a
 * "name.mp4 [input]" ref lands in job.videos (images stays empty) and an
 * optional `duration` (seconds) is kept as params.video_seconds.
 *
 * Text-only tools (music, sfx) send { text_only: true, prompt } and get a run
 * whose single job has no media; the action builder reads params only.
 *
 * Audio tools (lipsync) attach an uploaded speech file as `audio`
 * ("name.wav|mp3|m4a|flac [input]") → job.audios, with an optional
 * `audio_duration` (seconds) kept as params.audio_seconds.
 *
 * Body:  { ref: "name.png|name.mp4 [input]", width?, height?, prompt?, duration?,
 *          audio?: "name.wav [input]", audio_duration? }
 * Reply: { ok: true, run: ImagineRun }  → then POST /api/jobs/action
 *        with { run_id: run.run_id, job_index: 0, action, … }.
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { addActiveRun } from "@/lib/comfy/runs";
import { env } from "@/lib/env";
import { validateBoundedInteger, validateOptionalString } from "@/lib/validate";
import type { ImagineRun } from "@/types";
import {
  isAudioFilename,
  isVideoFilename,
  parseInputRef,
  parseSeedDuration,
  textOnlySeedRun,
} from "@/lib/seedRun";
import { withJudge } from "@/lib/judge/judgeServer";

const MAX_BYTES = 16_384;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

async function handlePost(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BYTES) {
    return apiError("Payload too large", {
      status: 413,
      headers: apiCorsHeaders(),
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON body", {
      status: 400,
      headers: apiCorsHeaders(),
    });
  }

  // Text-only tools (music, sfx): no media, just an empty finished job.
  if (body.text_only === true) {
    const prompt =
      validateOptionalString(
        typeof body.prompt === "string" ? body.prompt : undefined,
        2000,
      ) ?? "";
    const run = textOnlySeedRun(uuidv4(), prompt);
    addActiveRun(run);
    return apiOk({ run }, { headers: apiCorsHeaders() });
  }

  const ref = parseInputRef(body.ref, { allowVideo: true });
  if (!ref) {
    return apiError(
      'ref must be an uploaded input image or video ("name.png [input]")',
      { status: 400, headers: apiCorsHeaders() },
    );
  }

  let audioRef: { filename: string; subfolder: string } | null = null;
  if (body.audio !== undefined && body.audio !== null && body.audio !== "") {
    audioRef = parseInputRef(body.audio, { allowAudio: true });
    if (!audioRef || !isAudioFilename(audioRef.filename)) {
      return apiError(
        'audio must be an uploaded input audio file ("name.wav [input]")',
        { status: 400, headers: apiCorsHeaders() },
      );
    }
  }

  const width = validateBoundedInteger(body.width, 64, 8192, 1024);
  const height = validateBoundedInteger(body.height, 64, 8192, 1024);
  const prompt =
    validateOptionalString(
      typeof body.prompt === "string" ? body.prompt : undefined,
      2000,
    ) ?? "";
  const query = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: "input",
  });

  const viewUrl = `${env.COMFY_HTTP_URL}/view?${query}`;
  const isVideo = isVideoFilename(ref.filename);
  const duration = isVideo ? parseSeedDuration(body.duration) : null;
  const audioUrl = audioRef
    ? `${env.COMFY_HTTP_URL}/view?${new URLSearchParams({
        filename: audioRef.filename,
        subfolder: audioRef.subfolder,
        type: "input",
      })}`
    : null;
  const audioSeconds = audioRef ? parseSeedDuration(body.audio_duration) : null;

  const run: ImagineRun = {
    run_id: uuidv4(),
    prompt,
    parsedPrompt: prompt,
    width,
    height,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: isVideo ? [] : [viewUrl],
        ...(isVideo ? { videos: [viewUrl] } : {}),
        ...(audioUrl ? { audios: [audioUrl] } : {}),
      },
    ],
    params: {
      seed_upload: true,
      ...(duration !== null ? { video_seconds: duration } : {}),
      ...(audioSeconds !== null ? { audio_seconds: audioSeconds } : {}),
    },
  };
  addActiveRun(run);
  return apiOk({ run }, { headers: apiCorsHeaders() });
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const POST = withJudge("seed", handlePost);
