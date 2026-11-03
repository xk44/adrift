/**
 * Motion Designer <-> ComfyUI calls (fetch injected, so it's unit-testable).
 *
 * - writeOutline: text-only seed run -> motion_script (Qwen3-VL TextGenerate)
 *   -> poll history -> parse the reply into an Outline.
 * - narrate: one Kokoro voiceover per scene with narration (existing
 *   `voiceover` action), returned with its cue time for the export mix.
 * - musicBed: one instrumental bed (existing `music` action).
 * - uploadExport: the rendered webm/mp4 into ComfyUI input, so it can be
 *   chained into other tools by its "name.webm [input]" ref.
 *
 * All GPU work goes through the app's existing /api/jobs routes; nothing here
 * talks to ComfyUI directly.
 */

import { pickFinalOutput } from "@/lib/tools/pickOutput";
import type { ImagineRun } from "@/types";
import {
  ToolApiError,
  uploadDataUrl,
  type FetchLike,
} from "@/lib/tools/runTool";
import { waitForOutputs, type RunnerDeps } from "@/lib/tools/pipelineRunner";
import { parseMotionReply, cleanBrief, clampMotionScenes } from "./prompt";
import type { Outline } from "./templates";
import type { MotionSpec } from "./spec";
import { narrationCues, totalDuration } from "./timeline";

export type MotionDeps = RunnerDeps;

async function readJson(
  res: Pick<Response, "ok" | "status" | "json">,
): Promise<Record<string, unknown>> {
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
  return data;
}

function post(fetchImpl: FetchLike, url: string, body: unknown) {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedText(deps: MotionDeps, prompt: string) {
  const data = await readJson(
    await post(deps.fetchImpl, "/api/jobs/seed-run", {
      text_only: true,
      prompt: prompt.slice(0, 400) || "motion",
    }),
  );
  const run = data.run as ImagineRun | undefined;
  if (!run?.run_id) throw new ToolApiError("Could not start the step");
  return { runId: run.run_id, jobIndex: run.jobs?.[0]?.index ?? 0 };
}

async function runAction(
  deps: MotionDeps,
  name: string,
  seedPrompt: string,
  params: Record<string, unknown>,
) {
  const src = await seedText(deps, seedPrompt);
  const data = await readJson(
    await post(deps.fetchImpl, "/api/jobs/action", {
      run_id: src.runId,
      job_index: src.jobIndex,
      action: name,
      client_id: deps.clientId,
      params,
    }),
  );
  const run = data.run as ImagineRun | undefined;
  const promptId = run?.jobs?.[0]?.prompt_id;
  if (!run || !promptId) throw new ToolApiError("Server returned no run");
  deps.onRun?.(run);
  return waitForOutputs(deps, promptId);
}

export interface OutlineRequest {
  brief: string;
  scenes?: number;
  tone?: string;
  whiteboard?: boolean;
  seed?: number;
}

export async function writeOutline(
  deps: MotionDeps,
  req: OutlineRequest,
): Promise<{ outline: Outline; raw: string }> {
  const brief = cleanBrief(req.brief);
  if (!brief) throw new ToolApiError("Describe the video first.");
  const out = await runAction(deps, "motion_script", brief, {
    brief,
    scenes: clampMotionScenes(req.scenes),
    ...(req.tone ? { tone: req.tone } : {}),
    ...(req.whiteboard ? { whiteboard: true } : {}),
    ...(typeof req.seed === "number" ? { seed: req.seed } : {}),
  });
  const raw = out.texts.map((t) => t.text).join("\n");
  const outline = parseMotionReply(raw, brief.split(/[.!?]/)[0].slice(0, 60));
  if (!outline.scenes.length)
    throw new ToolApiError("The model reply had no usable scenes. Try again.");
  return { outline, raw };
}

export interface AudioCue {
  /** Seconds from the start of the video. */
  at: number;
  url: string;
  scene: number;
}

/** Voice every scene that has narration (sequential: one GPU job at a time). */
export async function narrate(
  deps: MotionDeps,
  spec: MotionSpec,
  voice: string,
  onProgress?: (done: number, total: number) => void,
): Promise<AudioCue[]> {
  const cues = narrationCues(spec);
  const out: AudioCue[] = [];
  for (const [i, cue] of cues.entries()) {
    onProgress?.(i, cues.length);
    const res = await runAction(deps, "voiceover", cue.text, {
      script: cue.text,
      engine: "kokoro",
      voice,
    });
    const file = pickFinalOutput(res.audios);
    if (!file?.url) throw new ToolApiError("The voiceover produced no audio");
    out.push({ at: cue.at, url: file.url, scene: cue.scene });
  }
  onProgress?.(cues.length, cues.length);
  return out;
}

export const MUSIC_MOODS: Record<string, string> = {
  upbeat:
    "upbeat corporate pop, bright synths, light drums, positive, instrumental",
  calm: "calm ambient piano, soft pads, gentle, instrumental",
  tech: "minimal electronic, pulsing synth bass, clean beat, modern, instrumental",
  playful: "playful ukulele and glockenspiel, claps, cheerful, instrumental",
  cinematic: "cinematic strings, swelling, inspiring, instrumental",
};

export async function musicBed(
  deps: MotionDeps,
  spec: MotionSpec,
  mood: string,
): Promise<AudioCue> {
  const prompt = MUSIC_MOODS[mood] ?? MUSIC_MOODS.upbeat;
  const seconds = Math.min(
    240,
    Math.max(10, Math.ceil(totalDuration(spec)) + 1),
  );
  const res = await runAction(deps, "music", prompt, {
    prompt,
    duration: seconds,
  });
  const file = pickFinalOutput(res.audios);
  if (!file?.url) throw new ToolApiError("The music job produced no audio");
  return { at: 0, url: file.url, scene: -1 };
}

/** Upload filename for an export: cj_motion_<slug>_<stamp>.<ext>. */
export function exportFilename(
  title: string,
  mime: string,
  stamp = Date.now(),
): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "video";
  return `cj_motion_${slug}_${stamp.toString(36)}.${mime.includes("mp4") ? "mp4" : "webm"}`;
}

export async function uploadExport(
  fetchImpl: FetchLike,
  dataUrl: string,
  filename: string,
): Promise<string> {
  return uploadDataUrl(fetchImpl, dataUrl, filename);
}
