/**
 * /api/tools/audio-lora: Train audio LoRA (Stable Audio 3).
 *
 * GET                    -> { ok, available }  (ComfyUI has CJSA3TrainAudioLoRA)
 * GET ?prompt_id=<id>    -> { ok, state: "queued"|"running"|"done"|"error"|"unknown",
 *                             lora?, summary?, error? }
 * POST { name, base, adapter, rank, lr, steps, captions: {file: caption} }
 *                        -> { ok, prompt_id, client_id }
 *
 * The clips are uploaded first through POST /api/comfy/upload with
 * subfolder "sa3_train/<name>". The graph is built here from validated
 * fields (never taken from the client). The prompt gets its own client_id so
 * the browser can follow it on /api/comfy/progress without stealing the
 * main gallery's WebSocket stream.
 */
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { apiError, apiOk } from "@/lib/api";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { ComfyAPIError, fetchHistory, queuePrompt } from "@/lib/comfy/http";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import {
  AUDIO_LORA_LIMITS,
  AUDIO_LORA_MAX_CAPTION,
  AUDIO_LORA_MAX_CLIPS,
  AUDIO_LORA_MIN_CLIPS,
  AUDIO_LORA_NODE,
  buildAudioLoraGraph,
  historyErrorMessage,
  parseAudioLoraOutputs,
} from "@/lib/training/audioLora";
import type { Workflow } from "@/types";

const PROMPT_ID = /^[A-Za-z0-9-]{8,64}$/;
/** clipUploadName() output: "NN_<stem>.<ext>". */
const CLIP_NAME = /^\d{2}_[A-Za-z0-9_-]{1,80}\.(wav|mp3|flac)$/;

const bodySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  base: z.enum(["medium-base", "small-music-base", "small-sfx-base"]),
  adapter: z.enum(["lora", "dora-rows"]),
  rank: z
    .number()
    .int()
    .min(AUDIO_LORA_LIMITS.rank.min)
    .max(AUDIO_LORA_LIMITS.rank.max),
  lr: z.number().min(AUDIO_LORA_LIMITS.lr.min).max(AUDIO_LORA_LIMITS.lr.max),
  steps: z
    .number()
    .int()
    .min(AUDIO_LORA_LIMITS.steps.min)
    .max(AUDIO_LORA_LIMITS.steps.max),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .optional(),
  captions: z
    .record(z.string().regex(CLIP_NAME), z.string().max(AUDIO_LORA_MAX_CAPTION))
    .refine(
      (c) => {
        const n = Object.keys(c).length;
        return n >= AUDIO_LORA_MIN_CLIPS && n <= AUDIO_LORA_MAX_CLIPS;
      },
      { message: `need ${AUDIO_LORA_MIN_CLIPS}-${AUDIO_LORA_MAX_CLIPS} clips` },
    ),
});

async function queueState(
  promptId: string,
): Promise<"running" | "queued" | null> {
  try {
    const res = await comfyFetch("/queue", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const q = (await res.json()) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };
    const has = (items?: unknown[]) =>
      (items ?? []).some((it) => Array.isArray(it) && it[1] === promptId);
    if (has(q.queue_running)) return "running";
    if (has(q.queue_pending)) return "queued";
  } catch {
    /* fall through to history */
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  // The runner polls every few seconds during a long run.
  const rl = withRateLimit(req, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  const promptId = req.nextUrl.searchParams.get("prompt_id");
  if (promptId === null) {
    const info = await getObjectInfoCached();
    if (!info)
      return apiOk({ available: false, reason: "ComfyUI is not reachable." });
    const available = AUDIO_LORA_NODE in info;
    return apiOk({
      available,
      reason: available
        ? null
        : "The audio LoRA trainer node is not installed in ComfyUI (cj_sa3_audio). Update the Adrift custom nodes and restart ComfyUI.",
    });
  }
  if (!PROMPT_ID.test(promptId))
    return apiError("bad prompt_id", { status: 400 });

  const live = await queueState(promptId);
  if (live) return apiOk({ state: live });
  try {
    const entry = (await fetchHistory(promptId)) as {
      outputs?: unknown;
      status?: unknown;
    } | null;
    if (!entry) return apiOk({ state: "unknown" });
    const err = historyErrorMessage(entry.status);
    if (err) return apiOk({ state: "error", error: err });
    const result = parseAudioLoraOutputs(entry.outputs);
    if (result) return apiOk({ state: "done", ...result });
    return apiOk({
      state: "error",
      error: "Training finished without a LoRA file.",
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "History lookup failed", {
      status: 502,
    });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 5 });
  if (!rl.ok) return rl.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError("Invalid JSON body", { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return apiError(
      `Invalid ${issue?.path.join(".") || "body"}: ${issue?.message ?? "bad value"}`,
      {
        status: 400,
      },
    );
  }
  const b = parsed.data;
  const graph = buildAudioLoraGraph({
    name: b.name,
    base: b.base,
    adapter: b.adapter,
    rank: b.rank,
    lr: b.lr,
    steps: b.steps,
    seed: b.seed,
    captions: b.captions,
  });
  const clientId = `cj_sa3train_${randomUUID()}`;
  try {
    const res = await queuePrompt(graph as unknown as Workflow, clientId);
    return apiOk({ prompt_id: res.prompt_id, client_id: clientId });
  } catch (e) {
    if (e instanceof PromptValidationError) {
      return apiError(e.message, { status: 422 });
    }
    if (e instanceof ComfyAPIError) {
      return apiError(e.message, {
        status: e.statusCode && e.statusCode >= 400 ? e.statusCode : 502,
      });
    }
    return apiError(e instanceof Error ? e.message : String(e), {
      status: 502,
    });
  }
}
