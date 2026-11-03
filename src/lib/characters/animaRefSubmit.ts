/**
 * Prompt-bar submission for "Character from reference (Anima)": the picker
 * holds one reference image (plus an optional second character, v2 adapter);
 * the prompt bar text is the scene. The first reference becomes a source run
 * (gallery run as-is, uploads via /api/jobs/seed-run); the second is always
 * uploaded and sent as params.secondRefImage (the same mechanism as the
 * two-image tools, see runTool.postActionTool). Then the `anima_ref` action is
 * queued (src/lib/oj/animaRef.ts builds the graph). Pure request shaping is
 * split out for tests.
 */
import type { ImagineRun } from "@/types";
import { parseImagineInput } from "@/lib/oj/parser";
import { ANIMA_REF_ACTION } from "@/lib/oj/animaRef";
import {
  ToolApiError,
  sourceRunFor,
  uploadDataUrl,
  uploadName,
  type FetchLike,
  type ToolImage,
} from "@/lib/tools/runTool";

export interface AnimaRefSettings {
  aspect?: string;
  seed?: number;
  negative?: string;
}

export interface AnimaRefRequest {
  /** Scene prompt (flags stripped). */
  prompt: string;
  params: Record<string, unknown>;
}

/**
 * Prompt bar text + UI settings → action params. Prompt flags win over
 * settings. Aspect: `--ar`, else a non-square settings aspect, else the
 * adapter default (picked server-side: 832x1216). Two characters: only
 * `--ar` sets the aspect; otherwise the server's landscape 1216x832 is used
 * (the two references sit side by side).
 */
export function animaRefRequest(
  input: string,
  settings: AnimaRefSettings = {},
  opts: { twoCharacters?: boolean } = {},
): AnimaRefRequest {
  const parsed = parseImagineInput(input);
  if (parsed.errors.length) throw new ToolApiError(parsed.errors[0]);
  const prompt = parsed.prompt.trim();
  if (!prompt)
    throw new ToolApiError(
      "Describe the scene (pose, place, action); the reference supplies the character.",
    );
  const params: Record<string, unknown> = { prompt };

  const ar =
    typeof parsed.params.ar === "string"
      ? parsed.params.ar
      : !opts.twoCharacters && settings.aspect && settings.aspect !== "1:1"
        ? settings.aspect
        : undefined;
  if (ar) params.aspect = ar;

  const seed =
    typeof parsed.params.seed === "number" ? parsed.params.seed : settings.seed;
  if (typeof seed === "number" && Number.isFinite(seed)) params.seed = seed;

  const no = parsed.params.no;
  const negative = Array.isArray(no)
    ? no.map(String)
    : typeof no === "string"
      ? [no]
      : settings.negative?.trim()
        ? [settings.negative.trim()]
        : [];
  if (negative.length) params.negative = negative;

  return { prompt, params };
}

/** The second reference as an input-dir ref (always uploaded). */
async function secondRefFor(
  fetchImpl: FetchLike,
  image: ToolImage,
): Promise<string> {
  if (image.dataUrl)
    return uploadDataUrl(fetchImpl, image.dataUrl, uploadName("cj_anima_ref2"));
  if (image.comfyRef?.endsWith(" [input]")) return image.comfyRef;
  throw new ToolApiError("The second character's picture is not ready.");
}

export async function submitAnimaRef(args: {
  fetchImpl: FetchLike;
  image: ToolImage;
  /** Second character (right side); v2 adapter only. */
  secondImage?: ToolImage | null;
  input: string;
  settings?: AnimaRefSettings;
  clientId: string;
}): Promise<ImagineRun> {
  const { fetchImpl, image, clientId } = args;
  const second = args.secondImage ?? null;
  // Validate the prompt before uploading anything.
  const req = animaRefRequest(args.input, args.settings, {
    twoCharacters: Boolean(second),
  });
  if (second) req.params.secondRefImage = await secondRefFor(fetchImpl, second);
  const src = await sourceRunFor(fetchImpl, image, req.prompt);
  const res = await fetchImpl("/api/jobs/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: src.runId,
      job_index: src.jobIndex,
      action: ANIMA_REF_ACTION,
      client_id: clientId,
      params: req.params,
    }),
  });
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false) {
    throw new ToolApiError(
      typeof data.error === "string" && data.error
        ? data.error
        : `Request failed (${res.status})`,
      res.status,
    );
  }
  if (!data.run) throw new ToolApiError("Server returned no run");
  return data.run as ImagineRun;
}
