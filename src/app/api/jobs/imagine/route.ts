/**
 * POST /api/jobs/imagine
 * Main endpoint for creating image generation jobs
 * Parses prompt, builds workflows, queues to ComfyUI
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiLog } from "@/lib/api";
import { parseImagineInput } from "@/lib/oj/parser";
import {
  buildImagineRuns,
  extractWorkflowsFromRuns,
  resolveSvEngine,
} from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import {
  ComfyAPIError,
  fetchAvailableCheckpoints,
  uploadImage,
} from "@/lib/comfy/http";
import { buildExtraData } from "@/lib/comfy/pnginfo";
import { addActiveRun } from "@/lib/comfy/runs";
import { comfyFailureFields } from "@/lib/create/createFailure";
import { backendForPack } from "@/lib/comfy/warmBackend";
import { applyJobBackend, queuePromptRouted } from "@/lib/comfy/router";
import {
  PromptValidationError,
  type PromptProblem,
} from "@/lib/comfy/validatePrompt";
import { insertPrompt, insertRun, insertJob } from "@/lib/db";
import { isIdeogramGraph } from "@/lib/imageQc/blank";
import type {
  ImageAttachment,
  ImagineRun,
  ImagineResponse,
  JobBackend,
  Workflow,
} from "@/types";
import fs from "fs/promises";
import path from "path";
import {
  loadWorkflowFromSelection,
  parseWorkflowJson,
} from "@/lib/comfy/workflows";
import { stripWorkflowMetaKeys } from "@/lib/comfy/workflowMeta";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { withRateLimit } from "@/lib/rateLimit";
import { requireAdmin } from "@/lib/auth";
import {
  validatePrompt,
  validateBatchSize,
  validateRequiredString,
  resolveAllowedStyleRefFetchUrl,
} from "@/lib/validate";
import { readBodyCapped } from "@/lib/util/fetchCap";
import { isConfiguredBackendUrl, safeFetchBytes } from "@/lib/net/safeFetch";
import { pickAudioWorkflow } from "@/lib/oj/sa3Audio";
import {
  firstStyleRefImage,
  isFetchableImageUrl,
  isMoodboardLocalUrl,
  readMoodboardLocalImage,
} from "@/lib/sref/styleRefImage";
import { detectModelFamilyStrict, resolveWorkflow } from "@/lib/oj/packs";
import { modelLoaderKind } from "@/lib/comfy/objectInfoCache";
import { isMossImageWorkflow } from "@/lib/oj/mossImage";
import {
  applyKrea2ControlStrength,
  isKrea2ControlGraph,
  looksLikeDepthMap,
  pickKrea2ControlImageUrl,
  wireKrea2ControlImage,
} from "@/lib/oj/krea2ControlDepth";
import { mossLayoutCanvas, sanitizeMossLayout } from "@/lib/oj/mossLayout";
import { isH3Graph } from "@/lib/oj/h3Video";
import { defaultVideoPack } from "@/lib/oj/videoDefault";
import {
  videoRefAttachments,
  wireVideoRefImages,
} from "@/lib/oj/videoRefImages";
import { needsMessage } from "@/lib/comfy/needsMessage";
import {
  missingH3ExtraLoras,
  missingH3FastUnet,
  resolveMossOptions,
  resolveSpeedTierParams,
} from "@/lib/oj/mossImageDefaults";
import { routeBackendUrl } from "@/lib/comfy/backends";
import { applyControlOverrides } from "@/lib/oj/workflowControlSchema";
import { selectControlOverridesForGraph } from "@/lib/workflowControlScope";
import { controlOverrideSeed } from "@/lib/oj/controlSeed";
import { graphLatentDims } from "@/lib/oj/graphDims";
import {
  expandPromptWildcards,
  wildcardParams,
  type PromptWildcardInfo,
} from "@/lib/wildcardsFs";
import { isUserToolSelection } from "@/lib/userTools/types";
import { resolveContainedWorkflowPath } from "@/lib/comfy/workflowPathGuard";
import { masterChoiceFromRequest } from "@/lib/output/masterRequest";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

const MAX_BYTES = 1_048_576;

const DEFAULT_WORKFLOW_PATH = path.join(
  process.cwd(),
  "public/workflows/t2i.json",
);

function resolveWorkflowFile(selection?: string): string | undefined {
  if (!selection) return undefined;
  if (
    selection.startsWith("saved:") ||
    isUserToolSelection(selection) ||
    path.isAbsolute(selection)
  ) {
    return selection;
  }
  return path.join(process.cwd(), "public/workflows", selection);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// --sv2 (Ostris image style-reference) workflow, relative to public/workflows.
const SREF_IMAGE_WORKFLOW = "packs/krea2-edit/sref_image.json";

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(b64, "base64");
}

// Pick the style-ref image for --sv2, in priority order: resolved style-vault
// representatives, then a direct `--sref <url>`, then a style_ref attachment.
function pickStyleRefUrl(
  params: Record<string, unknown>,
  sourceImages: ImageAttachment[] | undefined,
): string | undefined {
  const sp = params.srefParams as
    { items?: Array<{ value?: unknown }> } | undefined;
  const spUrl = sp?.items?.map((i) => i?.value).find(isFetchableImageUrl);
  if (spUrl) return spUrl;
  const srefImage = firstStyleRefImage(params.sref);
  if (srefImage) return srefImage;
  const att = sourceImages?.find(
    (a) => a.mode === "style_ref" && isFetchableImageUrl(a.url),
  );
  return att?.url;
}

// Fetch/decode the style-ref image, upload it to ComfyUI, and point the graph's
// LoadImage node at the uploaded file. Mutates `workflow` in place; returns the
// uploaded name. Throws on fetch/upload failure so the caller can surface it.
async function ingestStyleRefImage(
  workflow: Workflow,
  url: string,
  requestId: string,
): Promise<string> {
  const loadImageId = Object.keys(workflow).find(
    (id) => workflow[id]?.class_type === "LoadImage",
  );
  if (!loadImageId) {
    throw new Error("style-ref workflow has no LoadImage node");
  }
  const buffer = await attachmentBytes(url);
  const uploaded = await uploadImage(buffer, `sref_${requestId}.png`, "", true);
  (workflow[loadImageId].inputs as Record<string, unknown>).image =
    uploaded.name;
  return uploaded.name;
}

// Imagine --video with attached images: upload the frame / references the
// i2v or r2v graph consumes and point its LoadImage node(s) at them.
async function ingestVideoRefImages(
  workflow: Workflow,
  template: string,
  attachments: ImageAttachment[] | undefined,
  requestId: string,
): Promise<string[]> {
  const refs = videoRefAttachments(template, attachments);
  const names: string[] = [];
  for (const [i, att] of refs.entries()) {
    const buffer = await attachmentBytes(att.url);
    const uploaded = await uploadImage(
      buffer,
      `vref_${requestId}_${i}.png`,
      "",
      true,
    );
    names.push(
      uploaded.subfolder
        ? `${uploaded.subfolder}/${uploaded.name}`
        : uploaded.name,
    );
  }
  wireVideoRefImages(workflow, names);
  return names;
}

// Bytes of an attached / referenced image: data: URL, local moodboard file,
// configured backend or a DNS-checked public URL (64 MB cap).
async function attachmentBytes(url: string): Promise<Buffer> {
  const MAX_BYTES_IMG = 64 * 1024 * 1024; // 64MB
  let buffer: Buffer;
  if (url.startsWith("data:")) {
    buffer = dataUrlToBuffer(url);
  } else if (isMoodboardLocalUrl(url)) {
    const local = await readMoodboardLocalImage(url);
    if (!local) throw new Error("moodboard style-ref image not found on disk");
    if (local.length > MAX_BYTES_IMG)
      throw new Error("style-ref image too large");
    buffer = local;
  } else {
    const backends = [env.COMFY_HTTP_URL, env.STYLEVAULT_API_URL];
    const allowed = resolveAllowedStyleRefFetchUrl(url, backends);
    if (!allowed) throw new Error("style-ref URL not allowed");
    if (isConfiguredBackendUrl(allowed, backends)) {
      // Configured ComfyUI/StyleVault: comfyFetch adds the backend bearer.
      const resp = await comfyFetch(allowed, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!resp.ok)
        throw new Error(`fetch style-ref failed: HTTP ${resp.status}`);
      buffer = await readBodyCapped(resp, MAX_BYTES_IMG, "style-ref");
    } else {
      // Any other host: DNS-checked, redirects re-checked, size-capped.
      buffer = (
        await safeFetchBytes(allowed, { maxBytes: MAX_BYTES_IMG }).catch(
          (err) => {
            throw new Error(
              `fetch style-ref failed: ${err instanceof Error ? err.message : "network error"}`,
            );
          },
        )
      ).bytes;
    }
  }
  return buffer;
}

/**
 * An unrecognised --model name routes to the SD (sdxl) pack — it is almost
 * always a Civitai checkpoint merge. The one structural exception: ComfyUI
 * lists it only as a bare diffusion model (UNETLoader, not
 * CheckpointLoaderSimple), so the SD checkpoint graph can't load it; route
 * that like "no model chosen" (default pack).
 */
async function routingCheckpointName(
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const name = stringParam(params.model) ?? stringParam(params.checkpoint);
  if (!name || detectModelFamilyStrict(name) !== "unknown") return name;
  if (
    params.packId ||
    params.pack_id ||
    params.modelFamily ||
    params.model_family
  )
    return name;
  return (await modelLoaderKind(name)) === "unet" ? undefined : name;
}

function resolveImagineWorkflowPath(
  templateOrAction: string,
  userWorkflowPath: string | undefined,
  params: Record<string, unknown>,
  checkpointName: string | undefined,
): string | undefined {
  const resolved = resolveWorkflow({
    templateOrAction,
    userWorkflowPath,
    checkpointName,
    modelFamily:
      stringParam(params.modelFamily) ?? stringParam(params.model_family),
    packId: stringParam(params.packId) ?? stringParam(params.pack_id),
    turbo: params.turbo === true,
  });
  return resolveWorkflowFile(resolved.workflowPath);
}

async function loadWorkflow(workflowPath?: string): Promise<Workflow> {
  const filePath = workflowPath ?? DEFAULT_WORKFLOW_PATH;

  try {
    if (
      workflowPath?.startsWith("saved:") ||
      isUserToolSelection(workflowPath)
    ) {
      return await loadWorkflowFromSelection(workflowPath);
    }

    const content = await fs.readFile(filePath, "utf-8");
    return stripWorkflowMetaKeys(JSON.parse(content) as Workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to load workflow from ${filePath}: ${message}`);
  }
}

function getCheckpointLoaderNodeId(workflow: Workflow): string | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node?.class_type === "CheckpointLoaderSimple") return nodeId;
  }
  return null;
}

type StyleVaultSrefParams = {
  items: Array<{ type: "url"; value: string; weight: number }>;
};

type StyleVaultStyleSummary = {
  id?: unknown;
  codes?: unknown;
};

type ParsedSrefToken =
  | { kind: "random"; raw: string; weight: number }
  | { kind: "code"; raw: string; code: string; weight: number };

function styleVaultSrefParamsFromRepresentatives(
  reps: unknown,
): StyleVaultSrefParams | undefined {
  if (!Array.isArray(reps)) return undefined;

  const items = reps
    .map((rep) => {
      if (!rep || typeof rep !== "object") return null;
      const sourcePath = (rep as { source_path?: unknown }).source_path;
      if (typeof sourcePath !== "string" || !sourcePath.trim()) return null;
      return { type: "url" as const, value: sourcePath, weight: 1 };
    })
    .filter((item): item is { type: "url"; value: string; weight: number } =>
      Boolean(item),
    );

  return items.length > 0 ? { items } : undefined;
}

function scaleStyleVaultSrefParams(
  params: StyleVaultSrefParams,
  weight: number,
): StyleVaultSrefParams {
  return {
    items: params.items.map((item) => ({
      ...item,
      weight: item.weight * weight,
    })),
  };
}

function styleVaultFirstCode(
  style: StyleVaultStyleSummary,
): string | undefined {
  if (!Array.isArray(style.codes)) return undefined;
  const first = style.codes.find(
    (code): code is string =>
      typeof code === "string" && code.trim().length > 0,
  );
  return first?.trim();
}

function parseSrefToken(token: string): ParsedSrefToken | undefined {
  if (token === "random") return { kind: "random", raw: token, weight: 1 };

  const weighted = token.match(/^(\d{5,})::(\d+(?:\.\d+)?)$/);
  if (weighted) {
    const weight = Number.parseFloat(weighted[2]);
    if (Number.isFinite(weight) && weight > 0) {
      return {
        kind: "code",
        raw: token,
        code: weighted[1],
        weight,
      };
    }
  }

  if (/^\d{5,}$/.test(token)) {
    return { kind: "code", raw: token, code: token, weight: 1 };
  }

  return undefined;
}

async function resolveStyleVaultCodeSref(
  code: string,
): Promise<StyleVaultSrefParams | undefined> {
  const svRes = await fetch(
    `${env.STYLEVAULT_API_URL}/styles/by-code/${code}`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!svRes.ok) return undefined;

  const svData = await svRes.json();
  return styleVaultSrefParamsFromRepresentatives(svData.representatives);
}

async function resolveStyleVaultRandomSref(): Promise<
  | {
      code?: string;
      styleId: number;
      srefParams?: StyleVaultSrefParams;
    }
  | undefined
> {
  const stylesRes = await fetch(`${env.STYLEVAULT_API_URL}/styles?limit=1000`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!stylesRes.ok) return undefined;

  const stylesData = await stylesRes.json();
  const styles = Array.isArray(stylesData)
    ? (stylesData as StyleVaultStyleSummary[])
    : [];
  const candidates = styles.filter((style) => typeof style.id === "number");
  if (candidates.length === 0) return undefined;

  const style = candidates[Math.floor(Math.random() * candidates.length)];
  const styleId = style.id as number;
  const code = styleVaultFirstCode(style);

  const repsRes = await fetch(
    `${env.STYLEVAULT_API_URL}/styles/${styleId}/representatives?limit=8`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!repsRes.ok) return { code, styleId };

  const repsData = await repsRes.json();
  return {
    code,
    styleId,
    srefParams: styleVaultSrefParamsFromRepresentatives(
      repsData.representatives,
    ),
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  request?: NextRequest,
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(request ?? null, "POST, OPTIONS"),
  });
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(request, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const startTime = Date.now();

  apiLog("Imagine", `[${requestId}] Starting request`);

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
      prompt: rawPrompt,
      client_id: clientId,
      workflow_path: workflowPath,
      workflow_json: workflowJsonBody,
      batch_size: rawBatchSize,
      base_negative: baseNegative = "ugly, blurry, low quality, distorted",
      source_images: sourceImages,
      workflow_control_overrides: workflowControlOverrides,
      layout_boxes: layoutBoxes,
      run_next: runNext,
    } = body as {
      prompt?: string;
      client_id?: string;
      workflow_path?: string;
      workflow_json?: unknown;
      batch_size?: number;
      base_negative?: string;
      source_images?: ImageAttachment[];
      workflow_control_overrides?: Record<string, unknown>;
      layout_boxes?: unknown;
      run_next?: boolean;
    };

    // Contain a client workflow_path to public/workflows after resolving
    // symlinks (saved:/user-tool selections are contained by their loaders).
    if (workflowPath !== undefined && typeof workflowPath !== "string") {
      return jsonResponse({ ok: false, error: "Invalid workflow_path" }, 400);
    }
    if (
      workflowPath &&
      !workflowPath.startsWith("saved:") &&
      !isUserToolSelection(workflowPath) &&
      !(await resolveContainedWorkflowPath(workflowPath))
    ) {
      return jsonResponse({ ok: false, error: "Invalid workflow_path" }, 400);
    }

    // Validate and sanitize prompt
    if (typeof rawPrompt !== "string") {
      return jsonResponse(
        { ok: false, error: "Missing or invalid 'prompt' field" },
        400,
      );
    }
    const promptResult = validatePrompt(rawPrompt);
    if (!promptResult.ok) {
      return jsonResponse({ ok: false, error: promptResult.error }, 400);
    }
    let prompt = promptResult.text;

    // Expand __wildcard__ tokens (data/wildcards) with a seeded RNG. The seed
    // is the prompt's --seed when present, else a fresh random one, so the
    // expansion is reproducible from the recorded seed. The expanded prompt
    // replaces `prompt` for parsing + persistence; the original is kept in
    // the stored params and echoed back in the response.
    let wildcardInfo: PromptWildcardInfo | undefined;
    {
      const expansion = expandPromptWildcards(prompt);
      if (expansion.info) {
        const expandedResult = validatePrompt(expansion.text);
        if (!expandedResult.ok) {
          return jsonResponse({ ok: false, error: expandedResult.error }, 400);
        }
        wildcardInfo = expansion.info;
        prompt = expandedResult.text;
      }
    }

    const clientIdResult = validateRequiredString(clientId, "client_id", 200);
    if (!clientIdResult.ok) {
      return jsonResponse({ ok: false, error: clientIdResult.error }, 400);
    }
    const safeClientId = clientIdResult.text;

    // Validate and clamp batch size
    const batchSize = validateBatchSize(rawBatchSize ?? 1);

    apiLog("Imagine", `[${requestId}] Prompt: "${prompt.slice(0, 100)}..."`);
    apiLog(
      "Imagine",
      `[${requestId}] ClientId: ${safeClientId}, BatchSize: ${batchSize}`,
    );

    const parseResult = parseImagineInput(prompt);

    if (parseResult.errors.length > 0) {
      console.warn(`[Imagine ${requestId}] Parse errors:`, parseResult.errors);
      return jsonResponse(
        {
          ok: false,
          error: `Invalid prompt parameters: ${parseResult.errors.join("; ")}`,
        },
        400,
      );
    }

    apiLog("Imagine", `[${requestId}] Parsed params:`, parseResult.params);

    // An image --sref (e.g. moodboard "Apply to Prompt") only has meaning on
    // the Ostris image engine; without an explicit --sv it would otherwise be
    // silently dropped.
    const svEngine =
      parseResult.params.sv == null &&
      firstStyleRefImage(parseResult.params.sref)
        ? 2
        : resolveSvEngine(parseResult.params.sv);

    // Resolve --sref if present
    const srefValue = parseResult.params.sref as string | undefined;
    if (srefValue) {
      const tokens = srefValue.split(/\s+/).filter(Boolean);
      const resolvedItems: StyleVaultSrefParams["items"] = [];
      const resolvedCodes: string[] = [];

      for (const rawToken of tokens) {
        const token = parseSrefToken(rawToken);
        if (!token) {
          console.warn(
            `[Imagine ${requestId}] Skipping unrecognized --sref token: ${rawToken}`,
          );
          continue;
        }

        try {
          if (token.kind === "random") {
            const randomResult = await resolveStyleVaultRandomSref();
            if (randomResult?.code) resolvedCodes.push(randomResult.code);
            if (randomResult?.srefParams) {
              const weighted = scaleStyleVaultSrefParams(
                randomResult.srefParams,
                token.weight,
              );
              resolvedItems.push(...weighted.items);
              apiLog(
                "Imagine",
                `[${requestId}] SREF random → style ${randomResult.styleId} (${weighted.items.length} reps)`,
              );
            }
          } else {
            resolvedCodes.push(token.code);
            const srefParams = await resolveStyleVaultCodeSref(token.code);
            if (srefParams) {
              const weighted = scaleStyleVaultSrefParams(
                srefParams,
                token.weight,
              );
              resolvedItems.push(...weighted.items);
              apiLog(
                "Imagine",
                `[${requestId}] SREF resolved: ${token.code} → ${weighted.items.length} items`,
              );
            }
          }
        } catch (error) {
          console.warn(
            `[Imagine ${requestId}] SREF resolution failed for ${rawToken} (non-fatal):`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      if (
        resolvedCodes.length > 0 &&
        tokens.length === 1 &&
        tokens[0] === "random"
      ) {
        parseResult.params.sref = resolvedCodes[0];
      }

      if (resolvedItems.length > 0) {
        parseResult.params.srefParams = { items: resolvedItems };
      }
    }

    // Select model-aware workflow unless the user explicitly picked one.
    let effectiveWorkflowPath =
      typeof workflowPath === "string" ? workflowPath : undefined;
    let workflowTemplate = "t2i";

    if (!effectiveWorkflowPath && parseResult.params.controlnet) {
      workflowTemplate = "controlnet";
      apiLog(
        "Imagine",
        `[${requestId}] --controlnet flag → using controlnet workflow`,
      );
    }

    // Select video workflow when --video flag is set
    if (parseResult.params.video && !effectiveWorkflowPath) {
      // Video engine: --pack/--packId wins, then --vmodel (user flag or UI
      // default setting), then the server-wide default video pack env.
      if (!parseResult.params.packId && !parseResult.params.pack_id) {
        // Falls back to LTX-2.5, the engine a stock install can run.
        parseResult.params.packId = defaultVideoPack(
          stringParam(parseResult.params.vmodel),
        );
      }
      const videoPack =
        stringParam(parseResult.params.packId) ??
        stringParam(parseResult.params.pack_id);
      const modes = (sourceImages as Array<{ mode: string }> | undefined)?.map(
        (img) => img.mode,
      );
      const hasStartingFrame = modes?.includes("starting_frame");
      const hasImagePrompt = modes?.includes("image_prompt");
      // MiniMax H3 distinguishes keyframes from references: a starting frame
      // is fl2v (i2v graph), while a plain image prompt is a subject/style
      // reference — route it to the ref2va checkpoint (r2v graph). Other
      // packs keep the legacy behavior (any image → i2v).
      if (hasStartingFrame) {
        workflowTemplate = "i2v";
      } else if (hasImagePrompt) {
        workflowTemplate = videoPack === "minimax" ? "r2v" : "i2v";
      } else {
        workflowTemplate = "t2v";
      }
      apiLog(
        "Imagine",
        `[${requestId}] --video flag → using ${workflowTemplate} workflow` +
          (parseResult.params.packId
            ? ` (pack: ${String(parseResult.params.packId)})`
            : ""),
      );
    }

    // Select 3D workflow when --3d flag is set
    if (parseResult.params["3d"] && !effectiveWorkflowPath) {
      const hasSourceImage = sourceImages && sourceImages.length > 0;
      workflowTemplate = hasSourceImage ? "i23d" : "t23d";
      apiLog(
        "Imagine",
        `[${requestId}] --3d flag → using ${workflowTemplate} workflow`,
      );
    }

    // Select audio workflow when --audio flag is set: SA3 medium when its
    // checkpoint is installed, else the small SFX pack (sa3Audio.ts).
    if (parseResult.params.audio && !effectiveWorkflowPath) {
      workflowTemplate = "t2a";
      effectiveWorkflowPath = pickAudioWorkflow(
        await fetchAvailableCheckpoints().catch(() => null),
      );
      apiLog(
        "Imagine",
        `[${requestId}] --audio flag → using ${effectiveWorkflowPath}`,
      );
    }

    // --sv2: Ostris image style-reference engine. When engine 2 is selected and
    // we have a server-fetchable style-ref image, route to the sref_image graph
    // (turbo bf16 + krea2_style_reference LoRA + Ostris reference-latent nodes).
    const styleRefUrl =
      svEngine === 2
        ? pickStyleRefUrl(parseResult.params, sourceImages)
        : undefined;
    if (svEngine === 2 && styleRefUrl && !effectiveWorkflowPath) {
      effectiveWorkflowPath = SREF_IMAGE_WORKFLOW;
      apiLog(
        "Imagine",
        `[${requestId}] --sv2 + style-ref image → using sref_image workflow`,
      );
    } else if (svEngine === 2 && !styleRefUrl) {
      apiLog(
        "Imagine",
        `[${requestId}] --sv2 set but no fetchable style-ref image (need --sref <url> or a style_ref attachment) — falling back to default engine`,
      );
    }


    effectiveWorkflowPath = resolveImagineWorkflowPath(
      workflowTemplate,
      effectiveWorkflowPath,
      parseResult.params,
      effectiveWorkflowPath
        ? undefined
        : await routingCheckpointName(parseResult.params),
    );

    // Load base workflow — prefer inline workflow_json (overlay mode) over file path
    let workflow: Workflow;
    try {
      if (
        workflowJsonBody &&
        typeof workflowJsonBody === "object" &&
        workflowJsonBody !== null
      ) {
        // Overlay mode: workflow JSON sent inline in the request body
        workflow = parseWorkflowJson(workflowJsonBody, "__overlay__");
        apiLog(
          "Imagine",
          `[${requestId}] Overlay workflow loaded inline, ${Object.keys(workflow).length} nodes`,
        );
      } else {
        workflow = await loadWorkflow(effectiveWorkflowPath);
        apiLog(
          "Imagine",
          `[${requestId}] Workflow loaded, ${Object.keys(workflow).length} nodes`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Imagine ${requestId}] Workflow load failed:`, message);
      // Details (paths, parse snippets) stay in the server log.
      return jsonResponse(
        {
          ok: false,
          error:
            "Couldn't load the workflow. Check the server log for details.",
        },
        500,
      );
    }

    // Ensure workflow has a valid checkpoint selected if user didn't specify --model
    if (!parseResult.params.model) {
      const ckptNodeId = getCheckpointLoaderNodeId(workflow);
      const current = ckptNodeId
        ? (workflow[ckptNodeId]?.inputs as any)?.ckpt_name
        : undefined;

      if (ckptNodeId && (!current || String(current).trim() === "")) {
        const preferred = process.env.COMFY_DEFAULT_CHECKPOINT;
        let chosen: string | undefined;

        if (preferred && preferred.trim()) {
          chosen = preferred.trim();
        } else {
          const checkpoints = await fetchAvailableCheckpoints();
          chosen = checkpoints[0];
        }

        if (!chosen) {
          return jsonResponse(
            {
              ok: false,
              error:
                "No checkpoint is configured. Set COMFY_DEFAULT_CHECKPOINT or select a model in the UI, then try again.",
              code: "no_checkpoint",
            },
            500,
          );
        }

        (workflow[ckptNodeId].inputs as any).ckpt_name = chosen;
        apiLog("Imagine", `[${requestId}] Defaulted checkpoint: ${chosen}`);
      }
    }

    // Apply workflow control overrides if provided. Panel overrides are
    // scoped to the graph they were made for; never leak by node id.
    const scopedControlOverrides = selectControlOverridesForGraph(
      workflowControlOverrides,
      workflowJsonBody ? null : effectiveWorkflowPath,
    );
    if (Object.keys(scopedControlOverrides).length > 0) {
      workflow = applyControlOverrides(workflow, scopedControlOverrides);
      apiLog(
        "Imagine",
        `[${requestId}] Applied ${Object.keys(scopedControlOverrides).length} workflow control overrides`,
      );
    }

    // --sv2: fetch the style-ref image, upload it to ComfyUI, and point the
    // graph's LoadImage node at it. Done on the base workflow so every job clone
    // inherits the reference. Only when the sref_image graph was actually loaded
    // (has a LoadImage node) — otherwise sv2 fell back to the default engine.
    if (
      svEngine === 2 &&
      styleRefUrl &&
      Object.values(workflow).some((n) => n?.class_type === "LoadImage")
    ) {
      try {
        const name = await ingestStyleRefImage(
          workflow,
          styleRefUrl,
          requestId,
        );
        apiLog("Imagine", `[${requestId}] --sv2 style-ref uploaded as ${name}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[Imagine ${requestId}] style-ref ingest failed:`,
          message,
        );
        return jsonResponse(
          { ok: false, error: `Style reference (--sv2) failed: ${message}` },
          502,
        );
      }
    }

    // --video with an attached frame / references (i2v / r2v graphs).
    if (
      parseResult.params.video &&
      !workflowJsonBody &&
      (workflowTemplate === "i2v" || workflowTemplate === "r2v")
    ) {
      try {
        const names = await ingestVideoRefImages(
          workflow,
          workflowTemplate,
          sourceImages,
          requestId,
        );
        if (names.length > 0)
          apiLog(
            "Imagine",
            `[${requestId}] ${workflowTemplate} reference image(s) uploaded: ${names.join(", ")}`,
          );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[Imagine ${requestId}] video reference ingest failed:`,
          message,
        );
        return jsonResponse(
          { ok: false, error: `Reference image upload failed: ${message}` },
          502,
        );
      }
    }

    // Krea 2 --controlnet: upload the Control attachment (or --cn-image) and
    // estimate depth in-graph (DA3) unless it already is a depth map.
    if (
      !workflowJsonBody &&
      workflowTemplate === "controlnet" &&
      isKrea2ControlGraph(workflow)
    ) {
      const controlUrl = pickKrea2ControlImageUrl(
        parseResult.params,
        sourceImages,
      );
      if (!controlUrl) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Krea 2 ControlNet needs a control image: attach one as Control or pass --cn-image <url>.",
          },
          400,
        );
      }
      try {
        const buffer = await attachmentBytes(controlUrl);
        const looksDepth = await looksLikeDepthMap(buffer);
        const uploaded = await uploadImage(
          buffer,
          `cn_${requestId}.png`,
          "",
          true,
        );
        const name = uploaded.subfolder
          ? `${uploaded.subfolder}/${uploaded.name}`
          : uploaded.name;
        const { estimateDepth } = wireKrea2ControlImage(workflow, name, {
          markedDepth: parseResult.params["cn-depthmap"],
          looksDepth,
        });
        applyKrea2ControlStrength(workflow, parseResult.params["cn-strength"]);
        apiLog(
          "Imagine",
          `[${requestId}] control image uploaded as ${name} (${estimateDepth ? "auto depth" : "used as depth map"})`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[Imagine ${requestId}] control image ingest failed:`,
          message,
        );
        return jsonResponse(
          { ok: false, error: `Control image upload failed: ${message}` },
          502,
        );
      }
    }

    // MOSS-Image: default the speed preset (balanced when installed, else off) and
    // reject explicitly requested speed / deband LoRAs that are not on disk.
    if (isMossImageWorkflow(workflow)) {
      const moss = await resolveMossOptions(env.COMFY_ROOT, parseResult.params);
      if (moss.missing.length > 0) {
        return jsonResponse(
          {
            ok: false,
            error: `MOSS-Image LoRA not installed: ${moss.missing.join(", ")}`,
          },
          409,
        );
      }
      parseResult.params.mossSpeed = moss.params.mossSpeed;
    }
    // Speed tier (--tier): use a distilled Draft variant / H3 turbo LoRA only
    // when installed; otherwise the engine falls back to fewer steps.
    Object.assign(
      parseResult.params,
      await resolveSpeedTierParams(
        env.COMFY_ROOT,
        workflow,
        parseResult.params,
      ),
    );
    // MOSS-Image layout boxes (t2i only: the boxes are placed on the latent canvas).
    const layout = sanitizeMossLayout(layoutBoxes);
    if ("error" in layout) {
      return jsonResponse({ ok: false, error: layout.error }, 400);
    }
    if (layout.boxes.length > 0) {
      if (!mossLayoutCanvas(workflow)) {
        return jsonResponse(
          {
            ok: false,
            error: "layout_boxes need a MOSS-Image text-to-image workflow",
          },
          400,
        );
      }
      parseResult.params.mossLayout = layout.boxes;
    }
    // Optional H3 extras (--motion-repair / --handheld / --h3-flex /
    // --h3speed fast8's FastH3 DiT) must exist where the job runs: a routed
    // video host strictly, else the main ComfyUI (which may be remote), with
    // the local folder as the fallback when it can't be reached.
    const missingH3: string[] = [];
    if (isH3Graph(workflow)) {
      const packId =
        stringParam(parseResult.params.packId) ??
        stringParam(parseResult.params.pack_id);
      const routed = routeBackendUrl({ packId });
      const host = routed
        ? { backendUrl: routed, strict: true }
        : { backendUrl: env.COMFY_HTTP_URL };
      missingH3.push(
        ...(await missingH3ExtraLoras(env.COMFY_ROOT, parseResult.params, workflow, host)),
        ...(await missingH3FastUnet(env.COMFY_ROOT, parseResult.params, workflow, host)),
      );
    }
    if (missingH3.length > 0) {
      return jsonResponse(
        {
          ok: false,
          error: `Optional model not installed: ${missingH3.join(", ")}`,
        },
        409,
      );
    }

    // Seed precedence: --seed in the prompt > Workflow Control seed override
    // (incl. its increment/decrement/randomize step) > random. The run seed is
    // written into the sampler after overrides, so lift the override into the
    // base seed or it would be silently discarded.
    if (parseResult.params.seed == null) {
      const overrideSeed = controlOverrideSeed(
        workflow,
        discoverT2ISlots(workflow),
        scopedControlOverrides,
      );
      if (overrideSeed !== undefined) parseResult.params.seed = overrideSeed;
    }

    const runs = buildImagineRuns(parseResult, workflow, {
      batchSize,
      baseNegative,
      sourceImages: sourceImages,
    });

    apiLog(
      "Imagine",
      `[${requestId}] Built ${runs.length} runs with ${runs[0]?.jobs.length ?? 0} jobs each`,
    );

    const workflowJobs = extractWorkflowsFromRuns(
      runs,
      workflow,
      discoverT2ISlots,
    );

    apiLog(
      "Imagine",
      `[${requestId}] Extracted ${workflowJobs.length} workflow jobs`,
    );

    // Without --ar the run was sized at the 1:1 default; record what the
    // graph actually renders instead (e.g. LTXV video latents are 768x512).
    if (parseResult.params.ar == null) {
      for (const run of runs) {
        const job = workflowJobs.find((wj) => wj.runId === run.run_id);
        const dims = job
          ? graphLatentDims(job.workflow, discoverT2ISlots(job.workflow))
          : null;
        if (dims) {
          run.width = dims.width;
          run.height = dims.height;
        }
      }
    }

    // Public build: numeric style codes are not available.
    if (
      svEngine === 1 &&
      typeof parseResult.params.sref === "string" &&
      /^\d+$/.test(parseResult.params.sref) &&
      !parseResult.params.srefParams
    ) {
      return jsonResponse(
        {
          ok: false,
          error: "Style codes aren't available in this build. Use a style image instead: --sref <image URL> or a moodboard image (--sv 2).",
          code: "style_codes_unavailable",
        },
        400,
      );
    }

    // Persist prompt to DB (one record per request, keyed by requestId)
    try {
      insertPrompt(
        requestId,
        prompt,
        JSON.stringify(
          wildcardInfo
            ? {
                ...parseResult.params,
                wildcards: wildcardParams(wildcardInfo),
              }
            : parseResult.params,
        ),
        effectiveWorkflowPath ?? undefined,
      );
    } catch (dbErr) {
      console.warn(`[Imagine ${requestId}] DB insertPrompt failed:`, dbErr);
    }

    const queuedRuns: ImagineRun[] = [];
    const errors: string[] = [];
    // First ComfyUI failure, so the client can explain it (code + /prompt body).
    let comfyFailure: ReturnType<typeof comfyFailureFields>;
    const nodeWarnings = new Set<string>();
    const validationProblems: PromptProblem[] = [];

    // Lets the client watch Ideogram tiles for a safety-filter blank.
    const blankCheck = workflowJobs.some((j) => isIdeogramGraph(j.workflow));
    for (const run of runs) {
      if (blankCheck) run.params = { ...run.params, _blankCheck: "ideogram" };
      const updatedRun = { ...run };

      try {
        insertRun(run.run_id, requestId, Object.keys(workflow).length, {
          parsedPrompt: run.parsedPrompt,
          params: run.params,
          width: run.width,
          height: run.height,
        });
      } catch (dbErr) {
        console.warn(`[Imagine ${requestId}] DB insertRun failed:`, dbErr);
      }

      // MiniMax H3 jobs go to the dedicated warm backend when it's enabled
      // (weights stay resident there; see src/lib/comfy/warmBackend.ts).
      const submitPackId =
        stringParam(parseResult.params.packId) ??
        stringParam(parseResult.params.pack_id);
      const submitBaseUrl = await backendForPack(submitPackId);
      const acceptedBackends = new Map<string, JobBackend>();

      for (let i = 0; i < run.jobs.length; i++) {
        const jobData = workflowJobs.find(
          (wj) => wj.runId === run.run_id && wj.jobIndex === i,
        );

        if (!jobData) {
          errors.push(`Missing workflow for run ${run.run_id} job ${i}`);
          continue;
        }

        try {
          const result = await queuePromptRouted(
            jobData.workflow,
            safeClientId,
            submitBaseUrl,
            { action: "create", packId: submitPackId },
            {
              extraData: buildExtraData({
                params: {
                  ...parseResult.params,
                  fullPrompt: rawPrompt,
                  seed: jobData.seed,
                },
                uiWorkflow: workflowJsonBody,
              }),
              front: runNext === true,
              master: {
                choice: masterChoiceFromRequest(request, body),
                tool: "create",
                seed: jobData.seed,
              },
            },
          );

          result.warnings?.forEach((w) => nodeWarnings.add(w));
          updatedRun.jobs[i] = {
            ...updatedRun.jobs[i],
            prompt_id: result.prompt_id,
            status: "queued",
            ...(result.backend ? { backend: result.backend } : {}),
          };
          if (result.backend)
            acceptedBackends.set(result.backend.id, result.backend);

          try {
            insertJob(
              `${run.run_id}:${i}`,
              run.run_id,
              jobData.seed,
              result.prompt_id,
              result.backend?.id,
            );
          } catch (dbErr) {
            console.warn(`[Imagine ${requestId}] DB insertJob failed:`, dbErr);
          }

          apiLog(
            "Imagine",
            `[${requestId}] Queued job ${i}: prompt_id=${result.prompt_id}, seed=${jobData.seed}`,
          );
        } catch (error) {
          if (error instanceof PromptValidationError) {
            validationProblems.push(...error.problems);
          }
          if (error instanceof ComfyAPIError && !comfyFailure) {
            comfyFailure = comfyFailureFields(error);
          }
          const message =
            error instanceof ComfyAPIError ||
            error instanceof PromptValidationError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Unknown error";

          console.error(
            `[Imagine ${requestId}] Queue failed for job ${i}:`,
            message,
          );

          updatedRun.jobs[i] = {
            ...updatedRun.jobs[i],
            status: "error",
            error: message,
          };

          errors.push(`Job ${i}: ${message}`);
        }
      }

      // One machine took every job: the run-level marker the client polls by.
      if (acceptedBackends.size === 1)
        updatedRun.params = applyJobBackend(
          updatedRun.params,
          [...acceptedBackends.values()][0],
        );
      addActiveRun(updatedRun);
      queuedRuns.push(updatedRun);
    }

    const hasQueued = queuedRuns.some((r) =>
      r.jobs.some((j) => j.status === "queued"),
    );

    if (!hasQueued && errors.length > 0) {
      return jsonResponse(
        {
          ok: false,
          error: needsMessage(validationProblems) ?? "Failed to queue any jobs",
          details: errors,
          ...(comfyFailure ?? {}),
          ...(validationProblems.length > 0
            ? { problems: validationProblems }
            : {}),
        },
        validationProblems.length > 0 &&
          errors.every((e) => e.includes("failed validation"))
          ? 422
          : 500,
      );
    }

    const duration = Date.now() - startTime;
    apiLog("Imagine", `[${requestId}] Completed in ${duration}ms`);

    const response: ImagineResponse = {
      ok: true,
      request_id: requestId,
      runs: queuedRuns,
    };

    if (parseResult.unknownFlags.length > 0) {
      response.warnings = { unknownFlags: parseResult.unknownFlags };
    }
    // Optional custom nodes bypassed at queue time (client toasts these).
    if (nodeWarnings.size > 0) {
      response.warnings = { ...response.warnings, nodes: [...nodeWarnings] };
    }

    if (wildcardInfo) {
      (response as ImagineResponse & { wildcards?: unknown }).wildcards = {
        original: wildcardInfo.original,
        expanded: prompt,
        seed: wildcardInfo.seed,
        used: wildcardInfo.used,
        missing: wildcardInfo.missing,
      };
    }

    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Imagine ${requestId}] Unhandled error:`, error);

    return jsonResponse(
      {
        ok: false,
        error: `Server error: ${message}`,
        request_id: requestId,
        ...(error instanceof ComfyAPIError ? comfyFailureFields(error) : {}),
      },
      500,
    );
  }
}
