/**
 * GET /api/comfy/models
 * Fetches available checkpoints, LoRAs, VAEs, samplers, and schedulers from ComfyUI
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiLog, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import type { ObjectInfoResponse } from "@/lib/oj/localInventory";
import { buildModelInventory } from "@/lib/comfy/modelInventory";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { listComfyModelFolder } from "@/lib/comfy/modelFolders";


export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;

  apiLog("ModelsAPI", "Fetching available models from ComfyUI");

  try {
    // Fetch object_info for multiple node types
    const attempts = 3;
    let lastError: unknown;
    let data: ObjectInfoResponse | null = null;

    for (let i = 0; i < attempts; i++) {
      try {
        const response = await comfyFetch("/object_info", {
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`ComfyUI returned ${response.status}`);
        }

        data = (await response.json()) as ObjectInfoResponse;
        break;
      } catch (error) {
        lastError = error;
        const delayMs = 500 * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (!data) {
      const message =
        lastError instanceof Error ? lastError.message : "Unknown error";
      throw new Error(message);
    }

    const {
      checkpoints,
      loras,
      vaes,
      samplers,
      schedulers,
      controlnet,
      upscale_models,
      clip,
      unet,
      ipadapter,
      embeddings: nodeEmbeddings,
      gligen,
      hypernetworks,
      animatediff_models,
      diffusers,
      style_models,
      video_models,
      latent_upscale_models,
      enumOptions,
      input_images,
      input_videos,
      input_audios,
    } = buildModelInventory(data);
    // No core node lists embeddings; read the folder ComfyUI loads them from.
    const embeddings =
      nodeEmbeddings.length > 0
        ? nodeEmbeddings
        : await listComfyModelFolder("embeddings");
    const fileInventory = { input_images, input_videos, input_audios };

    apiLog("ModelsAPI", "Found models", {
      checkpoints: checkpoints.length,
      loras: loras.length,
      vaes: vaes.length,
      controlnet: controlnet.length,
      upscale_models: upscale_models.length,
      clip: clip.length,
      unet: unet.length,
      ipadapter: ipadapter.length,
      embeddings: embeddings.length,
      gligen: gligen.length,
      hypernetworks: hypernetworks.length,
      animatediff_models: animatediff_models.length,
      diffusers: diffusers.length,
      style_models: style_models.length,
      video_models: video_models.length,
      samplers: samplers.length,
      schedulers: schedulers.length,
      input_images: (fileInventory.input_images ?? []).length,
      input_videos: (fileInventory.input_videos ?? []).length,
      input_audios: (fileInventory.input_audios ?? []).length,
      enumOptions: Object.values(enumOptions).reduce(
        (count, inputs) => count + Object.keys(inputs).length,
        0,
      ),
    });

    return apiOk({
      checkpoints,
      loras,
      vaes,
      controlnet,
      upscale_models,
      clip,
      unet,
      ipadapter,
      embeddings,
      gligen,
      hypernetworks,
      animatediff_models,
      diffusers,
      style_models,
      video_models,
      latent_upscale_models,
      samplers,
      schedulers,
      enumOptions,
      input_images: fileInventory.input_images ?? [],
      input_videos: fileInventory.input_videos ?? [],
      input_audios: fileInventory.input_audios ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    apiErr("ModelsAPI", "Error", message);

    return apiError(`Failed to fetch models: ${message}`, {
      status: 500,
      details: {
        checkpoints: [],
        loras: [],
        vaes: [],
        controlnet: [],
        upscale_models: [],
        clip: [],
        unet: [],
        ipadapter: [],
        embeddings: [],
        gligen: [],
        hypernetworks: [],
        animatediff_models: [],
        diffusers: [],
        style_models: [],
        video_models: [],
        samplers: [],
        schedulers: [],
        enumOptions: {},
        input_images: [],
        input_videos: [],
        input_audios: [],
      },
    });
  }
}
