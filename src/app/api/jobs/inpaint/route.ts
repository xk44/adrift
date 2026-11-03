/**
 * POST /api/jobs/inpaint
 * Endpoint for inpainting/editing operations
 * Accepts source image, mask, and prompt
 */

import { readBodyCapped } from "@/lib/util/fetchCap";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseImagineInput } from "@/lib/oj/parser";
import { queuePrompt, uploadImage, ComfyAPIError } from "@/lib/comfy/http";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import { buildExtraData } from "@/lib/comfy/pnginfo";
import {
  expandPromptWildcards,
  wildcardParams,
  type PromptWildcardInfo,
} from "@/lib/wildcardsFs";
import { discoverInpaintSlots } from "@/lib/oj/discovery";
import type { Workflow } from "@/types";
import fs from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { withRateLimit } from "@/lib/rateLimit";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { resolveContainedWorkflowPath } from "@/lib/comfy/workflowPathGuard";
import { stripWorkflowMetaKeys } from "@/lib/comfy/workflowMeta";
import { applyControlOverrides } from "@/lib/oj/workflowControlSchema";
import { selectControlOverridesForGraph } from "@/lib/workflowControlScope";
import {
  resolveAllowedInpaintImageFetchUrl,
  validatePrompt,
  validateRequiredString,
  validatePlainObject,
} from "@/lib/validate";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

const MAX_BYTES = 1_048_576;

const INPAINT_WORKFLOW_PATH = path.join(
  process.cwd(),
  "public/workflows/inpaint.json",
);

async function loadWorkflow(workflowPath: string): Promise<Workflow> {
  try {
    const content = await fs.readFile(workflowPath, "utf-8");
    return stripWorkflowMetaKeys(JSON.parse(content) as Workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to load workflow from ${workflowPath}: ${message}`);
  }
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const matches = dataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid data URL format");
  }
  return Buffer.from(matches[2], "base64");
}

/**
 * Format response with CORS headers
 */
function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      ...apiCorsHeaders(null, "POST, OPTIONS"),
    },
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...apiCorsHeaders(null, "POST, OPTIONS"),
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const startTime = Date.now();

  console.log(`[Inpaint ${requestId}] Starting request`);

  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 15 });
  if (!rl.ok) return rl.response;

  const contentLength = parseInt(
    request.headers.get("content-length") || "0",
    10,
  );
  if (contentLength > MAX_BYTES)
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413 },
    );

  try {
    const body = await request.json();
    const {
      prompt,
      client_id: clientId,
      source_image: sourceImageUrl,
      mask_data: maskDataUrl,
      seed,
      denoise = 1.0,
      workflow_path: workflowPath,
      workflow_control_overrides: workflowControlOverrides,
    } = body as {
      prompt?: string;
      client_id?: string;
      source_image?: string;
      mask_data?: string;
      seed?: number;
      denoise?: number;
      workflow_path?: string;
      workflow_control_overrides?: Record<string, unknown>;
    };

    // Validate required fields
    const promptResult = validatePrompt(prompt ?? "");
    if (!promptResult.ok) {
      return jsonResponse({ ok: false, error: promptResult.error }, 400);
    }
    let sanitizedPrompt = promptResult.text;

    // Expand __wildcard__ tokens like /imagine (seed = body seed, else the
    // prompt's --seed, else random) so the edit is reproducible.
    let wildcardInfo: PromptWildcardInfo | undefined;
    {
      const expansion = expandPromptWildcards(sanitizedPrompt, {
        seed: typeof seed === "number" ? seed : undefined,
      });
      if (expansion.info) {
        const expanded = validatePrompt(expansion.text);
        if (!expanded.ok) {
          return jsonResponse({ ok: false, error: expanded.error }, 400);
        }
        sanitizedPrompt = expanded.text;
        wildcardInfo = expansion.info;
      }
    }

    const clientIdResult = validateRequiredString(clientId, "client_id", 200);
    if (!clientIdResult.ok) {
      return jsonResponse({ ok: false, error: clientIdResult.error }, 400);
    }
    const safeClientId = clientIdResult.text;

    const safeDenoise = Math.max(
      0,
      Math.min(1, typeof denoise === "number" ? denoise : 1.0),
    );

    const overridesResult = validatePlainObject(
      workflowControlOverrides,
      "workflow_control_overrides",
    );
    if (typeof overridesResult === "string") {
      return jsonResponse({ ok: false, error: overridesResult }, 400);
    }

    if (!sourceImageUrl || typeof sourceImageUrl !== "string") {
      return jsonResponse(
        { ok: false, error: "Missing or invalid 'source_image' field" },
        400,
      );
    }

    console.log(
      `[Inpaint ${requestId}] Prompt: "${sanitizedPrompt.slice(0, 100)}..."`,
    );
    console.log(`[Inpaint ${requestId}] Has mask: ${!!maskDataUrl}`);

    const sourceFetchUrl = resolveAllowedInpaintImageFetchUrl(
      sourceImageUrl,
      env.COMFY_HTTP_URL,
      request.nextUrl.origin,
    );
    if (!sourceFetchUrl) {
      return jsonResponse(
        {
          ok: false,
          error:
            "source_image must be a data:, app-local ComfyUI proxy, or ComfyUI URL",
        },
        400,
      );
    }

    const parseResult = parseImagineInput(sanitizedPrompt);
    console.log(`[Inpaint ${requestId}] Parsed params:`, parseResult.params);

    // Load inpaint workflow — use workflow_path if provided, otherwise default
    let workflow: Workflow;
    try {
      if (workflowPath && typeof workflowPath === "string") {
        // Contain workflow_path to public/workflows (or saved:), no traversal
        const containedPath = await resolveContainedWorkflowPath(workflowPath);
        if (!containedPath) {
          return jsonResponse(
            { ok: false, error: "Invalid workflow_path" },
            400,
          );
        }
        workflow = await loadWorkflowFromSelection(containedPath);
      } else {
        workflow = await loadWorkflow(INPAINT_WORKFLOW_PATH);
      }
      console.log(`[Inpaint ${requestId}] Workflow loaded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Inpaint ${requestId}] Workflow load failed:`, message);
      return jsonResponse(
        { ok: false, error: "Couldn't load the inpaint workflow" },
        500,
      );
    }

    // Upload source image to ComfyUI
    let sourceFilename: string;
    try {
      // Fetch source image if it's a URL
      let imageBuffer: Buffer;
      if (sourceFetchUrl.startsWith("data:")) {
        imageBuffer = dataUrlToBuffer(sourceFetchUrl);
      } else {
        const response = await comfyFetch(sourceFetchUrl, {
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          throw new Error(`Source image fetch failed: ${response.status}`);
        }
        imageBuffer = await readBodyCapped(
          response,
          64 * 1024 * 1024,
          "Source image",
        );
      }

      const uploadResult = await uploadImage(
        imageBuffer,
        `inpaint_source_${requestId}.png`,
        "",
        true,
      );
      sourceFilename = uploadResult.name;
      console.log(
        `[Inpaint ${requestId}] Source image uploaded: ${sourceFilename}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Inpaint ${requestId}] Source upload failed:`, message);
      return jsonResponse(
        { ok: false, error: `Failed to upload source image: ${message}` },
        500,
      );
    }

    // Upload mask image if provided
    let maskFilename = "mask.png"; // Default, workflow may have fallback
    if (maskDataUrl) {
      try {
        const maskBuffer = dataUrlToBuffer(maskDataUrl);
        const uploadResult = await uploadImage(
          maskBuffer,
          `inpaint_mask_${requestId}.png`,
          "",
          true,
        );
        maskFilename = uploadResult.name;
        console.log(`[Inpaint ${requestId}] Mask uploaded: ${maskFilename}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`[Inpaint ${requestId}] Mask upload failed:`, message);
        return jsonResponse(
          { ok: false, error: `Failed to upload mask: ${message}` },
          500,
        );
      }
    }

    let finalSeed!: number;

    // Discover slots and inject parameters
    try {
      const slots = discoverInpaintSlots(workflow);

      // Set source and mask images using discovered slots. Do not silently fall
      // back to built-in node IDs for custom workflows: that can queue a valid
      // graph with the wrong image/mask targets.
      const imageInputNode = workflow[slots.imageInputId];
      if (!imageInputNode?.inputs) {
        throw new Error(
          `Discovered image input node "${slots.imageInputId}" was not found in the workflow`,
        );
      }
      imageInputNode.inputs.image = sourceFilename;

      const maskInputNode = workflow[slots.maskInputId];
      if (!maskInputNode?.inputs) {
        throw new Error(
          `Discovered mask input node "${slots.maskInputId}" was not found in the workflow`,
        );
      }
      maskInputNode.inputs.image = maskFilename;

      workflow[slots.posTextId].inputs.text = parseResult.prompt;

      const negPrompt = parseResult.params.no
        ? `${parseResult.params.no}, ugly, blurry, low quality`
        : "ugly, blurry, low quality, distorted";
      workflow[slots.negTextId].inputs.text = negPrompt;

      finalSeed =
        seed ??
        (typeof parseResult.params.seed === "number"
          ? parseResult.params.seed
          : undefined) ??
        Math.floor(Math.random() * 2147483647);
      workflow[slots.ksamplerId].inputs.seed = finalSeed;

      workflow[slots.ksamplerId].inputs.denoise = safeDenoise;

      if (parseResult.params.steps) {
        workflow[slots.ksamplerId].inputs.steps = parseResult.params.steps;
      }
      if (parseResult.params.cfg) {
        workflow[slots.ksamplerId].inputs.cfg = parseResult.params.cfg;
      }

      console.log(`[Inpaint ${requestId}] Workflow configured`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Inpaint ${requestId}] Slot discovery failed:`, message);
      return jsonResponse(
        { ok: false, error: `Workflow configuration error: ${message}` },
        500,
      );
    }

    // Apply workflow control overrides if provided (scoped to this graph)
    const scopedOverrides = selectControlOverridesForGraph(
      overridesResult,
      workflowPath && typeof workflowPath === "string"
        ? workflowPath
        : INPAINT_WORKFLOW_PATH,
    );
    if (Object.keys(scopedOverrides).length > 0) {
      workflow = applyControlOverrides(workflow, scopedOverrides);
      console.log(
        `[Inpaint ${requestId}] Applied ${Object.keys(scopedOverrides).length} workflow control overrides`,
      );
    }

    try {
      const result = await queuePrompt(workflow, safeClientId, undefined, {
        extraData: buildExtraData({
          params: {
            ...parseResult.params,
            action: "inpaint",
            fullPrompt: sanitizedPrompt,
            seed: finalSeed,
            denoise: safeDenoise,
            ...(wildcardInfo ? { wildcards: wildcardParams(wildcardInfo) } : {}),
          },
        }),
      });

      const duration = Date.now() - startTime;
      console.log(
        `[Inpaint ${requestId}] Queued in ${duration}ms: ${result.prompt_id}`,
      );

      return jsonResponse({
        ok: true,
        request_id: requestId,
        prompt_id: result.prompt_id,
        seed: finalSeed,
        ...(wildcardInfo
          ? {
              wildcards: {
                original: wildcardInfo.original,
                expanded: sanitizedPrompt,
                seed: wildcardInfo.seed,
                used: wildcardInfo.used,
                missing: wildcardInfo.missing,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof PromptValidationError) {
        return jsonResponse(
          {
            ok: false,
            error: error.message,
            request_id: requestId,
            problems: error.problems,
          },
          422,
        );
      }
      const message =
        error instanceof ComfyAPIError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown error";

      console.error(`[Inpaint ${requestId}] Queue failed:`, message);
      return jsonResponse({ ok: false, error: `Queue error: ${message}` }, 500);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Inpaint ${requestId}] Unhandled error:`, error);

    return jsonResponse(
      {
        ok: false,
        error: `Server error: ${message}`,
        request_id: requestId,
      },
      500,
    );
  }
}
