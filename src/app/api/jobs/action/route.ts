import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import {
  apiCorsHeaders,
  apiError,
  apiErr,
  apiLog,
  apiOk,
  apiOptions,
} from "@/lib/api";
import { getActiveRun, addActiveRun } from "@/lib/comfy/runs";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { resolveContainedWorkflowPath } from "@/lib/comfy/workflowPathGuard";
import { VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import { buildWorkflowForAction } from "@/lib/oj/actionWorkflow";
import {
  actionTemplate,
  resolveActionWorkflowPath as resolveWorkflowPath,
  stringParam,
} from "@/lib/oj/actionWorkflowPath";
import { isH3Graph } from "@/lib/oj/h3Video";
import {
  missingH3ExtraLoras,
  missingH3FastUnet,
  resolveMossOptions,
} from "@/lib/oj/mossImageDefaults";
import { isMossImageWorkflow } from "@/lib/oj/mossImage";
import { applySa3QualityFallback } from "@/lib/oj/sa3QualityFallback";
import { applyFollowCamFallback } from "@/lib/oj/followCamFallback";
import { env } from "@/lib/env";
import registry from "@/lib/oj/registry.json";
import {
  fetchHistory,
  uploadImageToComfy,
  ComfyAPIError,
  comfyErrorDetails,
} from "@/lib/comfy/http";
import { fetchHistoryAnyBackend } from "@/lib/comfy/warmBackend";
import { pickBackend } from "@/lib/comfy/backends";
import { applyJobBackend, queuePromptRouted } from "@/lib/comfy/router";
import { UPSCALE_GRAPH_PARAM, graphUpscales } from "@/lib/upscale/upscaleAfter";
import {
  ActionMaskError,
  checkActionMask,
  resolveActionMaskRef,
} from "@/lib/comfy/actionMask";
import { jobMediaFromHistory } from "@/lib/comfy/outputs";
import { buildExtraData } from "@/lib/comfy/pnginfo";
import {
  expandPromptWildcards,
  wildcardParams,
  type PromptWildcardInfo,
} from "@/lib/wildcardsFs";
import type { ImagineRun } from "@/types";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import { needsMessage } from "@/lib/comfy/needsMessage";
import { withRateLimit } from "@/lib/rateLimit";
import { selectControlOverridesForGraph } from "@/lib/workflowControlScope";
import {
  getSlotById,
  getSlotIdForAction,
  normalizeWorkflowActionId,
} from "@/lib/workflowAssignments";
import { planAutoDetail } from "@/lib/oj/autoDetailProbe";
import {
  validateNonNegativeInteger,
  validatePlainObject,
  validatePrompt,
  validateRequiredString,
} from "@/lib/validate";
import { requireAdmin } from "@/lib/auth";
import { insertJob, insertPrompt, insertRun } from "@/lib/db";
import { isUserToolSelection } from "@/lib/userTools/types";
import { masterChoiceFromRequest } from "@/lib/output/masterRequest";
import { withJudge } from "@/lib/judge/judgeServer";

/** Body cap: params are tiny, but a mask may arrive as a base64 data URL. */
const MAX_BYTES = 24 * 1024 * 1024;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
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
  if (contentLength > MAX_BYTES)
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413 },
    );

  try {
    const body = await request.json();
    const {
      run_id: runId,
      job_index: jobIndex,
      action,
      client_id: clientId,
      workflow_path: workflowPath,
      params = {},
      workflow_control_overrides: workflowControlOverrides,
      mask: maskBody,
      mask_data: maskDataBody,
      pack_id: bodyPackId,
      dry_run: dryRunBody,
      tool_page_id: toolPageIdBody,
    } = body as {
      run_id?: string;
      job_index?: number;
      action?: string;
      client_id?: string;
      workflow_path?: string;
      params?: Record<string, unknown>;
      workflow_control_overrides?: Record<string, unknown>;
      /** Mask graphs: data:image/... URL or annotated ComfyUI ref (white = regenerate). */
      mask?: unknown;
      /** Pack to resolve the action's graph from (clients send it top-level). */
      pack_id?: unknown;
      /** Alias of `mask` (the /api/jobs/inpaint field name). */
      mask_data?: unknown;
      /** true: return the built API workflow instead of queueing it. */
      dry_run?: unknown;
      /** Tools-page card that sent this (feed provenance label only). */
      tool_page_id?: unknown;
    };
    // Kept out of params: a data URL must never be persisted with the run.
    const maskInput = maskBody ?? maskDataBody;

    if (dryRunBody !== undefined && typeof dryRunBody !== "boolean") {
      return apiError("dry_run must be a boolean", {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }
    const dryRun = dryRunBody === true;

    const runIdResult = validateRequiredString(runId, "run_id", 200);
    if (!runIdResult.ok) {
      return apiError(runIdResult.error, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    const jobIndexResult = validateNonNegativeInteger(jobIndex, "job_index");
    if (typeof jobIndexResult === "string") {
      return apiError(jobIndexResult, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    const actionResult = validateRequiredString(action, "action", 120);
    if (!actionResult.ok) {
      return apiError(actionResult.error, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    const clientIdResult = validateRequiredString(clientId, "client_id", 200);
    if (!clientIdResult.ok) {
      return apiError(clientIdResult.error, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    const paramsResult = validatePlainObject(params, "params");
    if (typeof paramsResult === "string") {
      return apiError(paramsResult, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    // Remix edit prompt: expand __wildcard__ tokens like /imagine does
    // (seed = the prompt's --seed, else random; recorded for reproduction).
    let wildcardInfo: PromptWildcardInfo | undefined;
    if (typeof paramsResult.prompt === "string") {
      const expansion = expandPromptWildcards(paramsResult.prompt);
      if (expansion.info) {
        const expanded = validatePrompt(expansion.text);
        if (!expanded.ok) {
          return apiError(expanded.error, {
            status: 400,
            headers: apiCorsHeaders(),
          });
        }
        paramsResult.prompt = expanded.text;
        wildcardInfo = expansion.info;
      }
    }

    const workflowControlOverridesResult = validatePlainObject(
      workflowControlOverrides,
      "workflow_control_overrides",
    );
    if (typeof workflowControlOverridesResult === "string") {
      return apiError(workflowControlOverridesResult, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    const sanitizedRunId = runIdResult.text;
    const sanitizedJobIndex = jobIndexResult;
    const sanitizedAction = actionResult.text;
    const sanitizedClientId = clientIdResult.text;
    if (workflowPath !== undefined && typeof workflowPath !== "string") {
      return apiError("workflow_path must be a string", {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    // Contain a client workflow_path to public/workflows after resolving
    // symlinks (saved:/user-tool selections are contained by their loaders).
    if (
      workflowPath &&
      !workflowPath.startsWith("saved:") &&
      !isUserToolSelection(workflowPath) &&
      !(await resolveContainedWorkflowPath(workflowPath))
    ) {
      return apiError("Invalid workflow_path", { status: 400, headers: apiCorsHeaders() });
    }

    // Normalize the action ID through the workflow assignment model.
    // UI actions like "zoom_out_1_5x" are canonicalized to registry keys like "zoom_1_5x",
    // and slot-based IDs like "single.vary_subtle" are mapped to their legacyActionId.
    let effectiveAction: string;
    if (sanitizedAction.includes(".")) {
      // Slot-based ID — resolve to the legacy action ID for registry/engine lookup
      const slot = getSlotById(sanitizedAction);
      effectiveAction = normalizeWorkflowActionId(
        slot?.legacyActionId ??
          sanitizedAction.split(".").pop() ??
          sanitizedAction,
      );
    } else {
      effectiveAction = normalizeWorkflowActionId(sanitizedAction);
    }

    const resolvedWorkflowPath = resolveWorkflowPath(
      effectiveAction,
      typeof workflowPath === "string" ? workflowPath : undefined,
      // Top-level pack_id (EnhanceOptions) must reach pack resolution, else
      // edit_instruct falls back to the registry's generic edit.json.
      stringParam(bodyPackId) && !stringParam(paramsResult.packId)
        ? { ...paramsResult, packId: stringParam(bodyPackId) }
        : paramsResult,
    );

    if (!resolvedWorkflowPath) {
      return apiError(`No workflow available for action: ${sanitizedAction}`, {
        status: 400,
        headers: apiCorsHeaders(),
      });
    }

    // Check if workflow file exists
    try {
      if (
        !resolvedWorkflowPath.startsWith("saved:") &&
        !isUserToolSelection(resolvedWorkflowPath)
      ) {
        await fs.access(resolvedWorkflowPath);
      }
    } catch {
      const template =
        actionTemplate(effectiveAction) || effectiveAction;
      return apiError(
        `Workflow template not found: ${template}.json\n` +
          `Please create a workflow file at: public/workflows/${template}.json\n` +
          `The workflow should match your ComfyUI setup for ${effectiveAction} operations.`,
        { status: 404, headers: apiCorsHeaders() },
      );
    }

    const sourceRun = getActiveRun(sanitizedRunId);
    if (!sourceRun) {
      return apiError(`Run not found: ${sanitizedRunId}`, {
        status: 404,
        headers: apiCorsHeaders(),
      });
    }

    if (!sourceRun.jobs[sanitizedJobIndex]) {
      return apiError(`Job not found: ${sanitizedJobIndex}`, {
        status: 404,
        headers: apiCorsHeaders(),
      });
    }

    // The in-memory run only learns its output images if a client synced them.
    // For ComfyUI-path runs nothing does that server-side, so hydrate from
    // ComfyUI history on demand — otherwise the source-image patch silently
    // no-ops and image-input actions run against the workflow's placeholder.
    const sourceJobRef = sourceRun.jobs[sanitizedJobIndex];
    if (
      !sourceJobRef.images?.length &&
      !sourceJobRef.videos?.length &&
      sourceJobRef.prompt_id
    ) {
      try {
        // Any backend: the source may have run on the video host.
        const entry = await fetchHistoryAnyBackend(
          fetchHistory,
          sourceJobRef.prompt_id,
        );
        if (entry) {
          // extractOutputs-based: keeps video/gif/audio/mesh/text outputs.
          const media = jobMediaFromHistory(
            entry,
            (q) => `${env.COMFY_HTTP_URL}/view?${q}`,
          );
          if (media.images.length) sourceJobRef.images = media.images;
          if (media.videos.length) sourceJobRef.videos = media.videos;
          if (media.audios.length) sourceJobRef.audios = media.audios;
          if (media.meshes.length) sourceJobRef.meshes = media.meshes;
          if (media.texts.length) sourceJobRef.texts = media.texts;
        }
      } catch (error) {
        apiLog("ActionAPI", `[${requestId}] History hydrate failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (
      (registry.actions as Record<string, { requiresImage?: boolean }>)[
        effectiveAction
      ]?.requiresImage &&
      !sourceJobRef.images?.length
    ) {
      return apiError(
        "Source image not available yet — the job may still be generating.",
        { status: 409, headers: apiCorsHeaders() },
      );
    }

    // Video-in actions (character / face swap, video bg removal) need the
    // seeded/source clip.
    if (
      VIDEO_INPUT_ACTIONS.has(effectiveAction) &&
      !sourceJobRef.videos?.length
    ) {
      return apiError("Source video not available for this video action.", {
        status: 409,
        headers: apiCorsHeaders(),
      });
    }

    // Auto refine: probe the source image with the StyleVault VL captioner
    // and derive per-stage FaceDetailer overrides (or reroute to the
    // whole-frame detail edit when there are no people to region-refine).
    let autoDetailSummary: string | undefined;
    let autoOverrides: Record<string, unknown> = {};
    let queueAction = effectiveAction;
    let queueWorkflowPath = resolvedWorkflowPath;
    if (effectiveAction === "adetailer_auto") {
      const plan = await planAutoDetail(
        sourceRun.jobs[sanitizedJobIndex].images[0],
      );
      autoDetailSummary = plan.summary;
      if (plan.preferDetailEdit) {
        const detailPath = resolveWorkflowPath(
          "detail",
          undefined,
          paramsResult,
        );
        if (detailPath) {
          queueAction = "detail";
          queueWorkflowPath = detailPath;
        }
      } else {
        autoOverrides = plan.overrides;
      }
      apiLog("ActionAPI", "Auto-detail plan", { summary: plan.summary });
    }

    // Multi-host routing: H3/minimax packs and video actions go to a video
    // backend (COMFY_VIDEO_HTTP_URL or a saved role-"video" machine) when one
    // is configured, other jobs to an image/all machine (least busy wins);
    // a "<name>.video.json" sibling, if present, is the video host's variant
    // of the graph (its own model files). Single host → unchanged.
    // `videoUrl` = the chosen non-main backend (any role), else undefined.
    const routed = await pickBackend({
      action: queueAction,
      workflowPath: queueWorkflowPath,
    });
    const videoUrl = routed.primary ? undefined : routed.url;
    const routedId = routed.primary ? undefined : routed.id;
    if (videoUrl && routed.role === "video" && queueWorkflowPath.endsWith(".json")) {
      const variant = queueWorkflowPath.replace(/\.json$/, ".video.json");
      if (
        !variant.startsWith("saved:") &&
        (await fs
          .access(variant)
          .then(() => true)
          .catch(() => false))
      ) {
        queueWorkflowPath = variant;
      }
    }

    let workflow: Awaited<ReturnType<typeof loadWorkflowFromSelection>>;
    try {
      workflow = await loadWorkflowFromSelection(queueWorkflowPath);
    } catch (error) {
      // Details (paths, parse snippets) stay in the server log.
      apiErr("ActionAPI", "Workflow load failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return apiError("Couldn't load the workflow. Check the server log for details.", {
        status: 500,
        requestId,
        headers: apiCorsHeaders(),
      });
    }

    // Optional LoRA toggles must exist where the job runs (disk for the
    // default host, /object_info for the video host), else ComfyUI fails at
    // queue time.
    let missingExtras: string[] = [];
    if (isH3Graph(workflow)) {
      // The main backend may be another machine (LAN / remote ComfyUI), so
      // ask it first; only a dedicated host is strict about being reachable.
      const host = videoUrl
        ? { backendUrl: videoUrl, strict: true }
        : { backendUrl: env.COMFY_HTTP_URL };
      missingExtras = await missingH3ExtraLoras(
        env.COMFY_ROOT,
        paramsResult,
        workflow,
        host,
      );
      // h3Speed fast8 swaps in a FastH3 DiT (same host rule as the LoRAs).
      missingExtras.push(
        ...(await missingH3FastUnet(env.COMFY_ROOT, paramsResult, workflow, host)),
      );
    }
    if (missingExtras.length > 0) {
      return apiError(
        `Optional model not installed: ${missingExtras.join(", ")}`,
        { status: 409, headers: apiCorsHeaders() },
      );
    }
    // MOSS-Image vary / remix: default the speed LoRA the same way imagine does.
    if (isMossImageWorkflow(workflow)) {
      const moss = await resolveMossOptions(env.COMFY_ROOT, {
        ...sourceRun.params,
        ...paramsResult,
      });
      if (moss.missing.length > 0) {
        return apiError(
          `MOSS-Image LoRA not installed: ${moss.missing.join(", ")}`,
          { status: 409, headers: apiCorsHeaders() },
        );
      }
      paramsResult.mossSpeed = moss.params.mossSpeed;
    }
    // SA3 Quality without its base checkpoint: run Fast, say so (warnings.nodes).
    const sa3Note = await applySa3QualityFallback(
      queueAction,
      paramsResult,
      videoUrl,
    );
    const followCam = await applyFollowCamFallback(paramsResult, videoUrl);
    if (followCam.kind === "refuse") {
      return apiError(followCam.error, {
        status: 409,
        headers: apiCorsHeaders(),
      });
    }
    const fallbackNotes = [
      ...(sa3Note ? [sa3Note] : []),
      ...(followCam.kind === "off" ? [followCam.note] : []),
    ];

    // Mask graphs (LoadImageMask / LoadImage titled "mask"): require a mask
    // and upload it, instead of queuing the graph's placeholder mask.png.
    let maskSlotIds: string[];
    let maskRef: string | undefined;
    try {
      maskSlotIds = checkActionMask(workflow, maskInput);
      if (maskSlotIds.length > 0) {
        maskRef = await resolveActionMaskRef(
          maskInput,
          uploadImageToComfy,
          `cj_action_${requestId.slice(0, 8)}_mask.png`,
        );
      }
    } catch (error) {
      if (error instanceof ActionMaskError) {
        return apiError(error.message, {
          status: 400,
          requestId,
          details: { code: error.code },
          headers: apiCorsHeaders(),
        });
      }
      throw error;
    }

    // Builder + mask + overrides (auto-detail plan first, explicit user
    // overrides win): the pure step shared with dry_run.
    const { workflow: finalWorkflow, seed: actionSeed } =
      buildWorkflowForAction(queueAction, paramsResult, {
        baseWorkflow: workflow,
        sourceRun,
        sourceJobIndex: sanitizedJobIndex,
        maskSlotIds,
        maskRef,
        overrides: {
          ...autoOverrides,
          ...selectControlOverridesForGraph(
            workflowControlOverridesResult,
            queueWorkflowPath,
          ),
        },
      });

    // Dry run: hand back the built API workflow without queueing it (the
    // ComfyUI overlay inserts it into the graph as nodes).
    if (dryRun) {
      apiLog("ActionAPI", "Built action workflow (dry run)", {
        action: sanitizedAction,
        requestId,
      });
      return apiOk(
        {
          workflow: finalWorkflow,
          action: queueAction,
          seed: actionSeed,
          ...(routedId ? { comfy_backend: routedId } : {}),
        },
        {
          requestId,
          headers: apiCorsHeaders(),
          warnings: fallbackNotes.length ? { nodes: fallbackNotes } : undefined,
        },
      );
    }

    // Feed provenance (src/lib/runProvenance.ts): rewritten on every step,
    // so it beats keys inherited from the source run's params.
    const toolPageId =
      typeof toolPageIdBody === "string" && /^[a-z0-9_]{1,64}$/.test(toolPageIdBody)
        ? toolPageIdBody
        : undefined;
    const nextParams: ImagineRun["params"] = {
      ...sourceRun.params,
      ...paramsResult,
      action_source_run_id: sanitizedRunId,
      action_source_job_index: sanitizedJobIndex,
      action_workflow_path: queueWorkflowPath,
      action_provenance: {
        kind: "action",
        id: effectiveAction,
        ...(toolPageId ? { via: toolPageId } : {}),
      },
      // Client polls history for these (its WebSocket only sees the default host).
      ...(routedId ? { comfy_backend: routedId } : {}),
      ...(autoDetailSummary ? { auto_detail_summary: autoDetailSummary } : {}),
      ...(wildcardInfo ? { wildcards: wildcardParams(wildcardInfo) } : {}),
      [UPSCALE_GRAPH_PARAM]: graphUpscales(finalWorkflow),
    };

    const result = await queuePromptRouted(finalWorkflow, sanitizedClientId, videoUrl, {
      action: queueAction,
      workflowPath: queueWorkflowPath,
    }, {
      extraData: buildExtraData({
        params: {
          ...nextParams,
          action: sanitizedAction,
          fullPrompt:
            typeof paramsResult.prompt === "string"
              ? paramsResult.prompt
              : sourceRun.prompt,
          seed: actionSeed,
        },
      }),
      master: {
        choice: masterChoiceFromRequest(request, body),
        tool: sanitizedAction,
        seed: actionSeed,
      },
    });

    const nextRun: ImagineRun = {
      ...sourceRun,
      run_id: uuidv4(),
      action: sanitizedAction,
      createdAt: new Date().toISOString(),
      status: "queued",
      jobs: [
        {
          // The actual seed the action workflow used (random for remix/upscale,
          // the source seed for vary) — not the source job's seed.
          seed: actionSeed,
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

    // Action runs are separate generations and must survive the in-memory feed.
    try {
      insertPrompt(
        requestId,
        nextRun.prompt,
        JSON.stringify(nextRun.params),
        queueWorkflowPath,
      );
      insertRun(nextRun.run_id, requestId, Object.keys(finalWorkflow).length, {
        parsedPrompt: nextRun.parsedPrompt,
        params: nextRun.params,
        width: nextRun.width,
        height: nextRun.height,
      });
      insertJob(
        `${nextRun.run_id}:0`,
        nextRun.run_id,
        actionSeed,
        result.prompt_id,
        result.backend?.id,
      );
    } catch (dbErr) {
      console.warn(`[Action ${requestId}] DB persistence failed:`, dbErr);
    }

    addActiveRun(nextRun);

    apiLog("ActionAPI", "Queued action", {
      action: sanitizedAction,
      runId: sanitizedRunId,
      jobIndex: sanitizedJobIndex,
      workflowPath: resolvedWorkflowPath,
    });
    return apiOk(
      {
        run: nextRun,
        ...(wildcardInfo
          ? {
              wildcards: {
                original: wildcardInfo.original,
                expanded: paramsResult.prompt,
                seed: wildcardInfo.seed,
                used: wildcardInfo.used,
                missing: wildcardInfo.missing,
              },
            }
          : {}),
      },
      {
        requestId: requestId,
        headers: apiCorsHeaders(),
        // Optional custom nodes bypassed at queue time (client toasts these).
        warnings:
          result.warnings?.length || fallbackNotes.length
            ? {
                nodes: [
                  ...fallbackNotes,
                  ...(result.warnings ?? []),
                ],
              }
            : undefined,
      },
    );
  } catch (error) {
    if (error instanceof PromptValidationError) {
      return apiError(needsMessage(error.problems) ?? error.message, {
        status: 422,
        requestId,
        details: { problems: error.problems },
        headers: apiCorsHeaders(),
      });
    }
    const message =
      error instanceof ComfyAPIError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    apiErr("ActionAPI", "Failed action job", { requestId, error: message });
    return apiError(message, {
      status: 500,
      requestId,
      details:
        error instanceof ComfyAPIError ? comfyErrorDetails(error) : undefined,
      headers: apiCorsHeaders(),
    });
  }
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const POST = withJudge("action", handlePost);
