/**
 * POST /api/jobs/tool
 * Run one LoRA edit tool (see docs/tools-api.md). Same auth, rate limit and
 * response envelope as /api/jobs/action: { ok, run, request_id }.
 *
 * Body: { toolId, images: [ref, ...], mask?, prompt?, options?, client_id? }
 *   ref  = "name.png [input]" (from /api/comfy/upload) | ComfyUI /view URL |
 *          { run_id, job_index } (a finished run's first image, as in /api/jobs/action)
 *   mask = data:image/...;base64 URL or an annotated ref (white = fill)
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  apiCorsHeaders,
  apiError,
  apiErr,
  apiLog,
  apiOk,
  apiOptions,
} from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { env } from "@/lib/env";
import { getActiveRun, addActiveRun } from "@/lib/comfy/runs";
import {
  ComfyAPIError,
  comfyErrorDetails,
  fetchImage,
  uploadImageToComfy,
} from "@/lib/comfy/http";
import { comfyImageRefFromViewUrl } from "@/lib/oj/engine";
import { getPack } from "@/lib/oj/packs";
import { applyJobBackend, queuePromptRouted } from "@/lib/comfy/router";
import { UPSCALE_GRAPH_PARAM, graphUpscales } from "@/lib/upscale/upscaleAfter";
import { insertJob, insertPrompt, insertRun } from "@/lib/db";
import type { ImagineRun } from "@/types";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { buildExtraData } from "@/lib/comfy/pnginfo";
import {
  expandPromptWildcards,
  wildcardParams,
  type PromptWildcardInfo,
} from "@/lib/wildcardsFs";
import {
  ToolRequestError,
  buildToolWorkflow,
  cleanToolPrompt,
  computeAvailability,
  fitLatentDims,
  formatComfyRef,
  anyPaintExpandSpec,
  getEditTool,
  isLoraInstalled,
  installedLorasFor,
  loadPackWorkflow,
  parseComfyRef,
  renderToolPrompt,
  resolveToolLoras,
  resolveToolOptions,
  toolGraphFamily,
  toolFixedLatent,
  toolNeedsLatentFit,
  toolWorkflowPath,
  TOOL_PROMPT_MAX,
  type ComfyRef,
  type EditToolDef,
} from "@/lib/tools/editTools";
import {
  OutpaintError,
  applyMaskFill,
  applyOutpaintPlan,
  planAnyPaint,
  planKrea2Outpaint,
  planLetterbox,
  prepareAnyPaintMask,
  type AnyPaintPlacement,
  planOutpaint,
  type Krea2OutpaintPlacement,
  readImageSize,
} from "@/lib/tools/outpaint";
import { applyRedBox, applyScribble } from "@/lib/tools/maskPrep";
import { addMaskPasteBack, pasteBackFitFor } from "@/lib/oj/imagePasteBack";
import { masterChoiceFromRequest } from "@/lib/output/masterRequest";
import { withJudge } from "@/lib/judge/judgeServer";

/** Body cap: refs are tiny, but a mask may arrive as a base64 data URL. */
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_MASK_BYTES = 16 * 1024 * 1024;

const cors = () => apiCorsHeaders();

function bad(
  message: string,
  code: string,
  status = 400,
  requestId?: string,
): NextResponse {
  return apiError(message, {
    status,
    requestId,
    details: { code },
    headers: cors(),
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

interface ResolvedImage {
  ref: ComfyRef;
  sourceRun?: ImagineRun;
  sourceJobIndex?: number;
}

/** String ref / view URL / { run_id, job_index } -> annotated ComfyUI ref. */
function resolveImage(value: unknown, index: number): ResolvedImage {
  const where = `images[${index}]`;
  if (typeof value === "string") {
    const direct = parseComfyRef(value);
    if (direct) return { ref: direct };
    const fromUrl = parseComfyRef(comfyImageRefFromViewUrl(value) ?? "");
    if (fromUrl) return { ref: fromUrl };
    throw new ToolRequestError(
      `${where} must be an annotated ComfyUI ref ("name.png [input]"), a /view URL or { run_id, job_index }`,
      "invalid_image",
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (
      typeof v.run_id !== "string" ||
      !v.run_id ||
      typeof v.job_index !== "number" ||
      !Number.isInteger(v.job_index) ||
      v.job_index < 0
    ) {
      throw new ToolRequestError(
        `${where} must have a string run_id and a non-negative integer job_index`,
        "invalid_image",
      );
    }
    const run = getActiveRun(v.run_id);
    if (!run) {
      throw new ToolRequestError(
        `${where}: run not found: ${v.run_id}`,
        "run_not_found",
        404,
      );
    }
    const job = run.jobs[v.job_index];
    if (!job) {
      throw new ToolRequestError(
        `${where}: job not found: ${v.job_index}`,
        "job_not_found",
        404,
      );
    }
    const ref = parseComfyRef(comfyImageRefFromViewUrl(job.images?.[0]) ?? "");
    if (!ref) {
      throw new ToolRequestError(
        `${where}: source image not available yet — the job may still be generating.`,
        "image_not_ready",
        409,
      );
    }
    return { ref, sourceRun: run, sourceJobIndex: v.job_index };
  }
  throw new ToolRequestError(
    `${where} must be a string ref or { run_id, job_index }`,
    "invalid_image",
  );
}

async function fetchRef(ref: ComfyRef): Promise<Buffer> {
  return fetchImage(ref.filename, ref.subfolder, ref.type);
}

async function loadMask(mask: unknown): Promise<Buffer> {
  if (typeof mask !== "string" || !mask) {
    throw new ToolRequestError(
      "mask must be a data: URL or an annotated ComfyUI ref",
      "invalid_mask",
    );
  }
  if (mask.startsWith("data:")) {
    const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,([\s\S]+)$/.exec(mask);
    if (!m) {
      throw new ToolRequestError(
        "mask data URL must be data:image/png|jpeg|webp;base64,...",
        "invalid_mask",
      );
    }
    const bytes = Buffer.from(m[1], "base64");
    if (bytes.length === 0 || bytes.length > MAX_MASK_BYTES) {
      throw new ToolRequestError("mask is empty or too large", "invalid_mask");
    }
    return bytes;
  }
  const ref = parseComfyRef(mask);
  if (!ref) {
    throw new ToolRequestError(
      'mask must be a data: URL or an annotated ComfyUI ref ("mask.png [input]")',
      "invalid_mask",
    );
  }
  return fetchRef(ref);
}

async function handlePost(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();

  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const contentLength = parseInt(
    request.headers.get("content-length") || "0",
    10,
  );
  if (contentLength > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413 },
    );
  }

  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return bad("Invalid JSON body", "invalid_json", 400, requestId);
    }

    const tool: EditToolDef | undefined = getEditTool(body.toolId);
    if (!tool) {
      return bad(
        typeof body.toolId === "string"
          ? `Unknown toolId: ${body.toolId}`
          : "toolId is required",
        "unknown_tool",
        400,
        requestId,
      );
    }

    // images
    if (!Array.isArray(body.images)) {
      return bad("images must be an array", "invalid_image", 400, requestId);
    }
    if (body.images.length !== tool.refCount) {
      return bad(
        `${tool.id} needs exactly ${tool.refCount} image${tool.refCount > 1 ? "s" : ""} (${tool.refLabels.join(", ")}), got ${body.images.length}`,
        "wrong_image_count",
        400,
        requestId,
      );
    }
    const resolved = body.images.map((v, i) => resolveImage(v, i));

    // mask (AnyPaint: optional when the `expand` option grows the canvas;
    // checked after the options resolve)
    if (
      tool.needsMask &&
      body.mask === undefined &&
      tool.prep !== "anypaint"
    ) {
      return bad(
        `mask is required for ${tool.id}`,
        "mask_required",
        400,
        requestId,
      );
    }
    if (!tool.needsMask && body.mask !== undefined) {
      return bad(
        `${tool.id} does not take a mask`,
        "mask_unsupported",
        400,
        requestId,
      );
    }

    // prompt
    let userPrompt: string | undefined;
    if (body.prompt !== undefined && body.prompt !== null) {
      if (typeof body.prompt !== "string") {
        return bad("prompt must be a string", "invalid_prompt", 400, requestId);
      }
      if (body.prompt.length > TOOL_PROMPT_MAX) {
        return bad(
          `prompt is too long (max ${TOOL_PROMPT_MAX} characters)`,
          "invalid_prompt",
          400,
          requestId,
        );
      }
      userPrompt = cleanToolPrompt(body.prompt);
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return bad("dry_run must be a boolean", "invalid_dry_run", 400, requestId);
    }
    if (body.client_id !== undefined && typeof body.client_id !== "string") {
      return bad(
        "client_id must be a string",
        "invalid_client_id",
        400,
        requestId,
      );
    }
    const clientId =
      typeof body.client_id === "string" && body.client_id.trim()
        ? body.client_id.trim().slice(0, 200)
        : `tool-${requestId}`;

    const options = resolveToolOptions(tool, body.options);
    const anyPaintExpand = anyPaintExpandSpec(tool, options.choices);
    if (tool.prep === "anypaint" && body.mask === undefined && !anyPaintExpand) {
      return bad(
        `mask is required for ${tool.id} unless options.expand grows the canvas`,
        "mask_required",
        400,
        requestId,
      );
    }
    // Seed is fixed up front so __wildcard__ expansion in the user text is
    // reproducible from the recorded seed (same rule as /imagine).
    const seed = options.seed ?? Math.floor(Math.random() * 2147483647);
    let wildcardInfo: PromptWildcardInfo | undefined;
    if (userPrompt && tool.promptMode !== "none") {
      const expansion = expandPromptWildcards(userPrompt, { seed });
      if (expansion.info) {
        const expanded = cleanToolPrompt(expansion.text);
        if (expanded.length > TOOL_PROMPT_MAX) {
          return bad(
            `prompt is too long after wildcard expansion (max ${TOOL_PROMPT_MAX} characters)`,
            "invalid_prompt",
            400,
            requestId,
          );
        }
        userPrompt = expanded;
        wildcardInfo = expansion.info;
      }
    }
    const promptText = renderToolPrompt(tool, userPrompt, options.choices);
    const loras = resolveToolLoras(tool, options);

    // availability (LoRAs + base weights)
    const pack = getPack(tool.pack);
    const objectInfo = await getObjectInfoCached().catch(() => null);
    const installedSet = await installedLorasFor(env.COMFY_ROOT, objectInfo);
    const missing = loras
      .filter((l) => !isLoraInstalled(installedSet, l.file))
      .map((l) => l.file);
    if (missing.length) {
      return bad(
        `LoRA not installed: ${missing.join(", ")}`,
        "lora_missing",
        409,
        requestId,
      );
    }
    const avail = await computeAvailability(
      tool,
      env.COMFY_ROOT,
      installedSet,
      pack?.workflows,
      objectInfo,
    );
    if (avail.missingNodes?.length) {
      const needs = tool.requiresNodes ? ` (install ${tool.requiresNodes})` : "";
      return bad(
        `${tool.label} needs ComfyUI custom nodes that are not installed: ${avail.missingNodes.join(", ")}${needs}`,
        "nodes_missing",
        409,
        requestId,
      );
    }
    if (!avail.packAvailable) {
      return bad(
        avail.missingModels?.length
          ? `${tool.label} needs model weights the GPU backend does not have: ${avail.missingModels.join(", ")}`
          : `Base workflow or model weights for ${tool.pack}/${tool.packAction} are not available`,
        "pack_unavailable",
        409,
        requestId,
      );
    }

    // image prep
    let imageRefs = resolved.map((r) => formatComfyRef(r.ref));
    let latent: { width: number; height: number } | undefined;
    let canvas: { width: number; height: number } | undefined;
    let placement: Krea2OutpaintPlacement | undefined;
    let anypaint: AnyPaintPlacement | undefined;
    let maskRef: string | undefined;
    // Masked edits re-render the whole frame at ~1 MP; this pastes only the
    // masked region back onto the full-res source (pixels outside stay exact).
    let pasteMask:
      | { image: Uint8Array; mask: Uint8Array }
      | { ref: string }
      | undefined;
    try {
      if (tool.prep === "anypaint") {
        // AnyPaint: the ORIGINAL source goes in (the nodes build the canvas);
        // only the binary source-sized mask is uploaded.
        const [bytes, maskBytes] = await Promise.all([
          fetchRef(resolved[0].ref),
          body.mask === undefined ? undefined : loadMask(body.mask),
        ]);
        const m = await prepareAnyPaintMask(bytes, maskBytes, !!anyPaintExpand);
        anypaint = planAnyPaint(m.width, m.height, anyPaintExpand);
        maskRef = await uploadImageToComfy(
          m.png,
          `cj_tool_${requestId.slice(0, 8)}_anypaint_mask.png`,
        );
        canvas = { width: anypaint.canvasWidth, height: anypaint.canvasHeight };
        if (!anyPaintExpand) {
          // Same canvas: pasted back onto the source at its own resolution.
          pasteMask = { ref: maskRef };
          canvas = { width: m.width, height: m.height };
        }
      } else if (
        tool.prep === "outpaint" &&
        options.outpaint &&
        toolGraphFamily(tool) === "krea2outpaint"
      ) {
        // Krea 2 bbox outpaint: the ORIGINAL image goes in; the nodes place it
        // on the canvas, so there is no gray pad / upload.
        const size = await readImageSize(await fetchRef(resolved[0].ref));
        placement = planKrea2Outpaint(
          size.width,
          size.height,
          options.outpaint.spec,
        );
        const out = placement.passes[placement.passes.length - 1];
        canvas = { width: out.canvasWidth, height: out.canvasHeight };
      } else if (tool.prep === "outpaint" && options.outpaint) {
        const bytes = await fetchRef(resolved[0].ref);
        const size = await readImageSize(bytes);
        const plan = planOutpaint(
          size.width,
          size.height,
          options.outpaint.spec,
        );
        const png = await applyOutpaintPlan(bytes, plan);
        imageRefs = [
          await uploadImageToComfy(
            png,
            `cj_tool_${requestId.slice(0, 8)}_outpaint.png`,
          ),
        ];
        canvas = { width: plan.width, height: plan.height };
      } else if (toolNeedsLatentFit(tool)) {
        // Krea 2 / Qwen-Image-Edit 2511 graphs have a fixed 1024x1024
        // EmptySD3LatentImage; match the source aspect so non-square images
        // are not distorted.
        const size = await readImageSize(await fetchRef(resolved[0].ref));
        latent = fitLatentDims(size.width, size.height);
        canvas = size;
      } else if (tool.prep === "maskfill") {
        const [bytes, maskBytes] = await Promise.all([
          fetchRef(resolved[0].ref),
          loadMask(body.mask),
        ]);
        const filled = await applyMaskFill(bytes, maskBytes);
        pasteMask = { image: bytes, mask: maskBytes };
        imageRefs = [
          await uploadImageToComfy(
            filled.png,
            `cj_tool_${requestId.slice(0, 8)}_maskfill.png`,
          ),
        ];
        canvas = { width: filled.width, height: filled.height };
        latent = fitLatentDims(filled.width, filled.height);
      } else if (tool.prep === "letterbox") {
        if (!tool.letterbox) throw new Error(`${tool.id} has no letterbox size`);
        const bytes = await fetchRef(resolved[0].ref);
        const size = await readImageSize(bytes);
        const plan = planLetterbox(size.width, size.height, tool.letterbox);
        imageRefs = [
          await uploadImageToComfy(
            await applyOutpaintPlan(bytes, plan),
            `cj_tool_${requestId.slice(0, 8)}_letterbox.png`,
          ),
        ];
        canvas = { width: plan.width, height: plan.height };
      } else if (tool.fixedLatent) {
        canvas = toolFixedLatent(tool, options.choices);
      } else if (tool.prep === "redbox" || tool.prep === "scribble") {
        const [bytes, maskBytes] = await Promise.all([
          fetchRef(resolved[0].ref),
          loadMask(body.mask),
        ]);
        const prepped =
          tool.prep === "redbox"
            ? await applyRedBox(bytes, maskBytes)
            : await applyScribble(bytes, maskBytes);
        pasteMask = { image: bytes, mask: maskBytes };
        imageRefs = [
          await uploadImageToComfy(
            prepped.png,
            `cj_tool_${requestId.slice(0, 8)}_${tool.prep}.png`,
          ),
        ];
        canvas = { width: prepped.width, height: prepped.height };
      }
    } catch (e) {
      if (e instanceof OutpaintError) {
        return bad(e.message, "invalid_geometry", 400, requestId);
      }
      throw e;
    }

    const base = await loadPackWorkflow(
      toolWorkflowPath(tool, pack?.workflows),
    );
    const workflow = buildToolWorkflow({
      workflow: base,
      tool,
      prompt: promptText,
      loras,
      steps: options.steps,
      cfg: options.cfg,
      seed,
      imageRefs,
      latent,
      choices: options.choices,
      placement,
      anypaint,
      maskRef,
    });
    if (pasteMask) {
      // A source-sized binary mask; scribble strokes only mark the area, so
      // that diff-based paste-back is not clamped to the stroke pixels.
      const pasteMaskRef =
        "ref" in pasteMask
          ? pasteMask.ref
          : await uploadImageToComfy(
              (await prepareAnyPaintMask(pasteMask.image, pasteMask.mask, false))
                .png,
              `cj_tool_${requestId.slice(0, 8)}_pasteback_mask.png`,
            );
      addMaskPasteBack(workflow, {
        originalRef: formatComfyRef(resolved[0].ref),
        maskRef: pasteMaskRef,
        fit: pasteBackFitFor(tool.packAction),
        clamp: tool.prep !== "scribble",
      });
    }

    // Dry run: hand back the built API workflow without queueing it (the
    // ComfyUI overlay inserts it into the graph as nodes).
    if (body.dry_run === true) {
      apiLog("ToolAPI", "Built tool workflow (dry run)", {
        tool: tool.id,
        requestId,
      });
      return apiOk(
        { workflow, tool_id: tool.id, seed },
        { requestId, headers: cors() },
      );
    }

    const source = resolved[0];
    const nextParams: ImagineRun["params"] = {
      ...(source.sourceRun?.params ?? {}),
      tool_id: tool.id,
      // Feed provenance (src/lib/runProvenance.ts); overrides any stamp
      // inherited from the source run's params.
      action_provenance: { kind: "tool", id: tool.id, label: tool.label },
      tool_options: {
        fast: options.fast,
        keepFraming: options.keepFraming,
        steps: options.steps,
        cfg: options.cfg,
        ...options.choices,
      },
      ...(source.sourceRun
        ? {
            action_source_run_id: source.sourceRun.run_id,
            ...(typeof source.sourceJobIndex === "number"
              ? { action_source_job_index: source.sourceJobIndex }
              : {}),
          }
        : {}),
      seed,
      ...(wildcardInfo ? { wildcards: wildcardParams(wildcardInfo) } : {}),
      [UPSCALE_GRAPH_PARAM]: graphUpscales(workflow),
    };

    const result = await queuePromptRouted(workflow, clientId, undefined, {
      tool: tool.id,
      packId: tool.pack,
    }, {
      extraData: buildExtraData({
        params: {
          ...nextParams,
          action: `tool_${tool.id}`,
          fullPrompt: promptText,
        },
      }),
      master: {
        choice: masterChoiceFromRequest(request, body),
        tool: tool.id,
        seed,
      },
    });

    const width = canvas?.width ?? source.sourceRun?.width ?? 1024;
    const height = canvas?.height ?? source.sourceRun?.height ?? 1024;
    const nextRun: ImagineRun = {
      ...(source.sourceRun ?? {
        prompt: "",
        parsedPrompt: "",
        params: {},
      }),
      run_id: uuidv4(),
      prompt: promptText || tool.label,
      parsedPrompt: promptText,
      width,
      height,
      action: `tool_${tool.id}`,
      createdAt: new Date().toISOString(),
      status: "queued",
      jobs: [
        {
          seed,
          index: 0,
          status: "queued",
          progress: 0,
          images: [],
          prompt_id: result.prompt_id,
          ...(result.backend ? { backend: result.backend } : {}),
        },
      ],
      params: applyJobBackend(nextParams, result.backend),
    };

    try {
      insertPrompt(
        requestId,
        nextRun.prompt,
        JSON.stringify(nextRun.params),
        toolWorkflowPath(tool, pack?.workflows),
      );
      insertRun(nextRun.run_id, requestId, Object.keys(workflow).length, {
        parsedPrompt: nextRun.parsedPrompt,
        params: nextRun.params,
        width: nextRun.width,
        height: nextRun.height,
      });
      insertJob(
        `${nextRun.run_id}:0`,
        nextRun.run_id,
        seed,
        result.prompt_id,
        result.backend?.id,
      );
    } catch (dbErr) {
      console.warn(`[Tool ${requestId}] DB persistence failed:`, dbErr);
    }

    addActiveRun(nextRun);
    apiLog("ToolAPI", "Queued tool", { tool: tool.id, requestId });
    return apiOk(
      {
        run: nextRun,
        ...(wildcardInfo
          ? {
              wildcards: {
                original: wildcardInfo.original,
                expanded: userPrompt,
                seed: wildcardInfo.seed,
                used: wildcardInfo.used,
                missing: wildcardInfo.missing,
              },
            }
          : {}),
      },
      {
        requestId,
        headers: cors(),
        // Optional custom nodes bypassed at queue time (client toasts these).
        warnings: result.warnings?.length
          ? { nodes: result.warnings }
          : undefined,
      },
    );
  } catch (error) {
    if (error instanceof ToolRequestError) {
      return bad(error.message, error.code, error.status, requestId);
    }
    if (error instanceof PromptValidationError) {
      return apiError(error.message, {
        status: 422,
        requestId,
        details: { problems: error.problems },
        headers: cors(),
      });
    }
    const message =
      error instanceof ComfyAPIError || error instanceof Error
        ? error.message
        : "Unknown error";
    apiErr("ToolAPI", "Failed tool job", { requestId, error: message });
    return apiError(message, {
      status: error instanceof ComfyAPIError ? 502 : 500,
      requestId,
      details:
        error instanceof ComfyAPIError ? comfyErrorDetails(error) : undefined,
      headers: cors(),
    });
  }
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const POST = withJudge("tool", handlePost);
