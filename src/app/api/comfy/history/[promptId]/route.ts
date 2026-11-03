/**
 * GET /api/comfy/history/[promptId]
 * Fetches generation history and output images from ComfyUI
 */

import { NextRequest, NextResponse } from "next/server";
import {
  apiCorsHeaders,
  apiError,
  apiLog,
  apiOk,
  apiOptions,
  apiErr,
} from "@/lib/api";
import { fetchHistory } from "@/lib/comfy/http";
import { fetchHistoryAnyBackend } from "@/lib/comfy/warmBackend";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateIdentifier } from "@/lib/validate";
import {
  comfyProxyUrl,
  extractOutputs,
  groupOutputs,
  type ExtractedOutput,
} from "@/lib/comfy/outputs";
import { withJudge } from "@/lib/judge/judgeServer";

type MediaFile = {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  format?: string;
  nodeId: string;
  nodeTitle: string;
  /** Lets runners tell a Save* node from a preview (see tools/pickOutput). */
  classType?: string;
};

function toMediaFile(output: ExtractedOutput, withFormat: boolean): MediaFile {
  const view = output.view!;
  return {
    filename: view.filename,
    subfolder: view.subfolder,
    type: view.type,
    url: comfyProxyUrl(view),
    ...(withFormat && output.format ? { format: output.format } : {}),
    nodeId: output.nodeId,
    nodeTitle: output.nodeTitle,
    ...(output.classType ? { classType: output.classType } : {}),
  };
}

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ promptId: string }> },
): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  const { promptId: rawPromptId } = await params;

  const promptIdResult = validateIdentifier(rawPromptId, "promptId", 200);
  if (!promptIdResult.ok) {
    return apiError(promptIdResult.error, {
      status: 400,
      headers: apiCorsHeaders(),
    });
  }
  const promptId = promptIdResult.text;

  apiLog("History", `Fetching history for ${promptId}`);

  try {
    // Probes the H3 warm backend too — its jobs are invisible to the main one.
    const entry = await fetchHistoryAnyBackend(fetchHistory, promptId);

    if (!entry) {
      return apiError("History not found", {
        status: 404,
        details: { promptId },
        headers: apiCorsHeaders(),
      });
    }

    // One classifier for every output kind (see lib/comfy/outputs.ts).
    // Animated GIF/WebP stay in `images` (they animate in <img>, not <video>).
    const extracted = extractOutputs(entry);
    const groups = groupOutputs(extracted);
    const images = [...groups.image, ...groups.animated]
      .sort((a, b) => extracted.indexOf(a) - extracted.indexOf(b))
      .map((o) => toMediaFile(o, false));
    const videos = groups.video.map((o) => toMediaFile(o, true));
    const meshes = groups.mesh.filter((o) => o.view).map((o) => toMediaFile(o, true));
    const audios = groups.audio.map((o) => toMediaFile(o, false));
    const texts = groups.text.map((o) => ({
      nodeId: o.nodeId,
      nodeTitle: o.nodeTitle,
      text: o.text ?? "",
    }));
    // Full classified list for generic renderers; file outputs carry a proxy url.
    const outputs = extracted.map((o) =>
      o.view ? { ...o, url: comfyProxyUrl(o.view) } : o,
    );

    apiLog(
      "History",
      `Found ${images.length} images, ${videos.length} videos, ${meshes.length} meshes, ${audios.length} audios, ${texts.length} texts for ${promptId}`,
    );

    return apiOk(
      {
        promptId,
        images,
        videos,
        meshes,
        audios,
        texts,
        outputs,
        status: entry.status,
      },
      { headers: apiCorsHeaders() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    apiErr("History", `Error fetching ${promptId}`, message);

    return apiError(message, {
      status: 500,
      details: { promptId },
      headers: apiCorsHeaders(),
    });
  }
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
const judgedGet = withJudge("history", handleGet);

// Declared as a function so Next's route type check sees a required context.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ promptId: string }> },
): Promise<Response> {
  return judgedGet(request, context);
}
