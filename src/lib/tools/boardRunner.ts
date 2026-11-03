/**
 * Runs one Board lane step by step through the existing pipeline runner
 * plumbing: every step queues an ordinary Adrift run (POST /api/jobs/imagine
 * for a prompt, /api/jobs/action for a tool on the previous step's run) and
 * polls history with waitForOutputs. Pure async over an injected fetch, so
 * vitest drives it with a mock server.
 */
import { pickFinalOutput } from "./pickOutput";
import type { ImagineRun } from "@/types";
import {
  ToolApiError,
  submitActionTool,
  uploadDataUrl,
  uploadName,
  videoUploadName,
  type FetchLike,
  type ToolImage,
  type ToolVideo,
} from "./runTool";
import {
  defaultSettings,
  getActionTool,
  type EditLoraListResponse,
} from "./toolsPage";
import {
  plainPrompt,
  promptIdOf,
  waitForOutputs,
  type RunnerDeps,
} from "./pipelineRunner";
import {
  BOARD_CLIP,
  BOARD_PROMPT,
  BOARD_PROMPT_FLUX3,
  boardTool,
  isPickStep,
  nextStepIndex,
  stepIssue,
  type BoardLane,
  type BoardStep,
} from "./board";

/**
 * FLUX.3 key art for an LTX-2.5 handoff: the FLUX.3 pack at 16:9
 * (1344x768), which ltx25SourceDims keeps 1:1 as the clip size, so the
 * first frame is neither cropped nor resampled. User flags are stripped so
 * the pack and the size cannot be overridden by accident.
 */
export function flux3KeyArtPrompt(text: string): string {
  return `${plainPrompt(text)} --pack flux3 --ar 16:9`;
}

export interface BoardRunDeps extends RunnerDeps {
  editLoras?: EditLoraListResponse | null;
}

export type StepPatch = Partial<Omit<BoardStep, "id" | "tool">>;

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

/**
 * A lane's picked image as a server-side run. Gallery picks already have
 * one; uploads are stored in ComfyUI input and wrapped in a seed run, so the
 * board persists ids and a /view URL instead of the image bytes.
 */
export async function seedBoardSource(
  fetchImpl: FetchLike,
  image: ToolImage,
): Promise<{ runId: string; jobIndex: number; url: string; label: string }> {
  if (image.source === "gallery" && image.runId) {
    return {
      runId: image.runId,
      jobIndex: image.jobIndex ?? 0,
      url: image.previewUrl,
      label: image.label,
    };
  }
  if (!image.dataUrl) throw new ToolApiError("Image is not ready");
  const ref = await uploadDataUrl(
    fetchImpl,
    image.dataUrl,
    uploadName("cj_board"),
  );
  const data = await readJson(
    await fetchImpl("/api/jobs/seed-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref,
        width: image.width,
        height: image.height,
        prompt: "Board",
      }),
    }),
  );
  const run = data.run as ImagineRun | undefined;
  if (!run?.run_id) throw new ToolApiError("Could not prepare the image");
  const job = run.jobs?.[0];
  return {
    runId: run.run_id,
    jobIndex: job?.index ?? 0,
    url: job?.images?.[0] ?? "",
    label: image.label,
  };
}

/**
 * A lane's picked clip as a server-side run: the upload lands in ComfyUI
 * input and a seed run carries it in job.videos (what the video tools read).
 */
export async function seedBoardClip(
  fetchImpl: FetchLike,
  video: ToolVideo,
): Promise<{ runId: string; jobIndex: number; url: string; label: string }> {
  if (!video.dataUrl) throw new ToolApiError("Clip is not ready");
  const ref = await uploadDataUrl(
    fetchImpl,
    video.dataUrl,
    videoUploadName(video.label),
  );
  const data = await readJson(
    await fetchImpl("/api/jobs/seed-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref,
        width: video.width || 1280,
        height: video.height || 720,
        prompt: "Board",
        ...(typeof video.duration === "number"
          ? { duration: video.duration }
          : {}),
      }),
    }),
  );
  const run = data.run as ImagineRun | undefined;
  if (!run?.run_id) throw new ToolApiError("Could not prepare the clip");
  const job = run.jobs?.[0];
  return {
    runId: run.run_id,
    jobIndex: job?.index ?? 0,
    url: job?.videos?.[0] ?? "",
    label: video.label,
  };
}

/** Execute step `i` (all earlier steps done). Returns the step's new fields. */
export async function executeBoardStep(
  lane: BoardLane,
  i: number,
  deps: BoardRunDeps,
): Promise<StepPatch> {
  const step = lane.steps[i];
  const tool = boardTool(step.tool);
  if (!tool) throw new ToolApiError("Unknown tool");

  if (isPickStep(step.tool)) {
    if (!step.runId)
      throw new ToolApiError(
        step.tool === BOARD_CLIP ? "Pick a clip first." : "Pick an image first.",
      );
    return { status: "done" };
  }

  let run: ImagineRun;
  if (step.tool === BOARD_PROMPT || step.tool === BOARD_PROMPT_FLUX3) {
    const data = await readJson(
      await deps.fetchImpl("/api/jobs/imagine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt:
            step.tool === BOARD_PROMPT_FLUX3
              ? flux3KeyArtPrompt(step.text)
              : step.text.trim(),
          client_id: deps.clientId,
          batch_size: 1,
        }),
      }),
    );
    const runs = (data.runs ?? []) as ImagineRun[];
    if (!runs[0]) throw new ToolApiError("Server returned no run");
    run = runs[0];
  } else {
    const spec = getActionTool(step.tool);
    if (!spec) throw new ToolApiError("Unknown tool");
    const prev = lane.steps[i - 1];
    if (!prev?.runId) throw new ToolApiError("The step before has no output.");
    const image: ToolImage = {
      id: `board:${prev.id}`,
      source: "gallery",
      previewUrl: prev.outputUrl ?? "",
      label: "Board step",
      width: 0,
      height: 0,
      runId: prev.runId,
      jobIndex: prev.jobIndex ?? 0,
    };
    run = await submitActionTool({
      fetchImpl: deps.fetchImpl,
      spec,
      settings: { ...defaultSettings(spec), text: step.text },
      editLoras: deps.editLoras ?? null,
      image,
      secondImage: null,
      clientId: deps.clientId,
    });
  }
  deps.onRun?.(run);
  const out = await waitForOutputs(deps, promptIdOf(run));
  const file = pickFinalOutput(tool.out === "video" ? out.videos : out.images);
  if (!file)
    throw new ToolApiError(
      `The job produced no ${tool.out === "video" ? "clip" : "image"}`,
    );
  return {
    status: "done",
    error: undefined,
    runId: run.run_id,
    jobIndex: run.jobs?.[0]?.index ?? 0,
    outputUrl: file.url,
  };
}

/**
 * Run the lane's pending steps in order. Stops at the first failure (later
 * steps need its output), at a step with a placement issue, or on cancel.
 * Returns the final lane.
 */
export async function runBoardLane(
  initial: BoardLane,
  deps: BoardRunDeps,
  onPatch: (stepId: string, patch: StepPatch) => void,
): Promise<BoardLane> {
  let lane = initial;
  const commit = (stepId: string, patch: StepPatch) => {
    lane = {
      ...lane,
      steps: lane.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    };
    onPatch(stepId, patch);
  };
  for (;;) {
    if (deps.isCancelled?.()) return lane;
    const i = nextStepIndex(lane);
    if (i < 0) return lane;
    const id = lane.steps[i].id;
    commit(id, { status: "running", error: undefined });
    try {
      commit(id, await executeBoardStep(lane, i, deps));
    } catch (error) {
      if (deps.isCancelled?.()) {
        commit(id, { status: "idle" });
        return lane;
      }
      commit(id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return lane;
    }
  }
}

/** First blocking issue of a lane (for the Run button hint), or null. */
export function laneBlocker(lane: BoardLane): string | null {
  if (lane.steps.length === 0) return "Add a first step.";
  for (let i = 0; i < lane.steps.length; i++) {
    if (lane.steps[i].status === "done") continue;
    if (lane.steps[i].status === "running") return "A step is running.";
    const issue = stepIssue(lane, i);
    if (issue) return `Step ${i + 1}: ${issue}.`;
    return null;
  }
  return "Every step is done.";
}
