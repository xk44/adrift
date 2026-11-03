/**
 * App follow-up chains (AppTemplate.followUp): what an app queues once its
 * step-1 edit has finished, in place of the generic LTXV Animate step.
 *
 *   match_cut    (Sticker Swap Cut) step 1 restyles the subject as a die-cut
 *                sticker in the same framing. Then:
 *                  /api/jobs/tool qwen21-remove-bg on the sticker (RGBA PNG)
 *                  /api/jobs/action transition: original photo = first
 *                  frame, sticker = last frame (LTX-2.5 by default, H3 opt-in)
 *   bullet_time  (Frozen Moment Orbit) step 1 is a clean background plate
 *                (subject removed). Then wan_motion `bullet_time` on the
 *                original photo.
 *
 * Every request is an ordinary Adrift run (gallery, re-run, download). The
 * request builders are pure so the chain is tested without a server.
 */
import type { ImagineRun } from "@/types";
import type { AppTemplate } from "./apps";
import { fileRef } from "./pipelines";
import {
  ToolApiError,
  sourceRunFor,
  type FetchLike,
  type ToolImage,
} from "./runTool";

/** Catalog image tool that cuts the sticker out to an RGBA PNG. */
export const APP_CUTOUT_TOOL = "qwen21-remove-bg";

export interface TransitionEngine {
  id: string;
  label: string;
  action: string;
  pack: string;
}

/** Match-cut video models; the first (open-weights LTX-2.5) is the default. */
export const MATCH_CUT_ENGINES: readonly TransitionEngine[] = [
  {
    id: "ltx25",
    label: "LTX-2.5",
    action: "ltx25_transition",
    pack: "ltx25",
  },
  { id: "h3", label: "H3", action: "transition", pack: "minimax" },
];

/** Wan 2.2 settings for the bullet-time orbit (the tool's fast defaults). */
export const BULLET_TIME_PARAMS = {
  pack_id: "wan22",
  preset: "bullet_time",
  mode: "fast",
  resolution: "720p",
  duration: "5s",
} as const;

export interface FollowUpRequest {
  /** What the run produces (UI label). */
  label: string;
  url: "/api/jobs/tool" | "/api/jobs/action";
  body: Record<string, unknown>;
}

/**
 * Annotated ComfyUI ref ("sub/name.png [output]") for a job image URL
 * (/api/comfy/view?filename=...&subfolder=...&type=...). Null if unsafe.
 */
export function viewUrlRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, "http://localhost");
    if (!u.pathname.endsWith("/view")) return null;
    const filename = u.searchParams.get("filename");
    if (!filename) return null;
    return fileRef({
      filename,
      subfolder: u.searchParams.get("subfolder") ?? "",
      type: u.searchParams.get("type") || "output",
    });
  } catch {
    return null;
  }
}

export function matchCutEngine(id?: string): TransitionEngine {
  return MATCH_CUT_ENGINES.find((e) => e.id === id) ?? MATCH_CUT_ENGINES[0];
}

/** The follow-up prompt (user text overrides the template's). */
export function compileFollowUpPrompt(app: AppTemplate, custom?: string) {
  return (custom ?? "").trim() || app.followUp?.prompt || "";
}

/**
 * Requests for an app's follow-up, in queue order. `source` is the original
 * photo's run; `step1Ref` the finished step-1 image (sticker / plate).
 */
export function followUpRequests(
  app: AppTemplate,
  opts: {
    source: { runId: string; jobIndex: number };
    step1Ref: string;
    clientId: string;
    engine?: string;
    prompt?: string;
  },
): FollowUpRequest[] {
  const f = app.followUp;
  if (!f) return [];
  const prompt = compileFollowUpPrompt(app, opts.prompt);
  const onSource = {
    run_id: opts.source.runId,
    job_index: opts.source.jobIndex,
    client_id: opts.clientId,
  };
  if (f.kind === "bullet_time") {
    return [
      {
        label: "Bullet-time orbit",
        url: "/api/jobs/action",
        body: {
          ...onSource,
          action: "wan_motion",
          params: { ...BULLET_TIME_PARAMS, ...(prompt ? { prompt } : {}) },
        },
      },
    ];
  }
  const engine = matchCutEngine(opts.engine);
  const out: FollowUpRequest[] = [];
  if (f.cutout) {
    out.push({
      label: "Sticker cut-out",
      url: "/api/jobs/tool",
      body: {
        toolId: APP_CUTOUT_TOOL,
        images: [opts.step1Ref],
        options: {},
        client_id: opts.clientId,
      },
    });
  }
  out.push({
    label: "Match-cut clip",
    url: "/api/jobs/action",
    body: {
      ...onSource,
      action: engine.action,
      params: {
        pack_id: engine.pack,
        secondRefImage: opts.step1Ref,
        ...(engine.id === "ltx25" ? { duration: "5" } : {}),
        ...(prompt ? { prompt } : {}),
      },
    },
  });
  return out;
}

async function post(
  fetchImpl: FetchLike,
  req: FollowUpRequest,
): Promise<ImagineRun> {
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false)
    throw new ToolApiError(
      typeof data.error === "string" && data.error
        ? `${req.label}: ${data.error}`
        : `${req.label} failed (${res.status})`,
      res.status,
    );
  if (!data.run) throw new ToolApiError(`${req.label}: server returned no run`);
  return data.run as ImagineRun;
}

/**
 * Queue an app's follow-up runs. The original photo becomes the video
 * source (gallery picks reuse their run; uploads are seeded once).
 */
export async function submitAppFollowUp(args: {
  fetchImpl: FetchLike;
  app: AppTemplate;
  image: ToolImage;
  /** Step-1 job image URL. */
  step1Url: string | undefined;
  clientId: string;
  engine?: string;
  prompt?: string;
  onRun?: (run: ImagineRun, label: string) => void;
}): Promise<ImagineRun[]> {
  const { fetchImpl, app } = args;
  if (!app.followUp) throw new ToolApiError(`${app.name} has no follow-up`);
  const step1Ref = viewUrlRef(args.step1Url);
  if (!step1Ref) throw new ToolApiError("Step 1 has no usable image yet.");
  const source = await sourceRunFor(fetchImpl, args.image, app.name);
  const runs: ImagineRun[] = [];
  for (const req of followUpRequests(app, {
    source,
    step1Ref,
    clientId: args.clientId,
    engine: args.engine,
    prompt: args.prompt,
  })) {
    const run = await post(fetchImpl, req);
    args.onRun?.(run, req.label);
    runs.push(run);
  }
  return runs;
}
