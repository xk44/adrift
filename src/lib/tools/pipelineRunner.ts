/**
 * Step executors for the Shorts Studio / Click to Ad pipelines. Each step
 * queues one ordinary Adrift run through the existing job routes, then polls
 * GET /api/comfy/history/<prompt_id> (which also probes a second video host)
 * for its outputs. Browser-only bits (media length, fetching an output back
 * as a data URL) are injected so the whole flow runs under vitest with a
 * mock fetch.
 */
import { pickFinalOutput } from "./pickOutput";
import type { ImagineRun } from "@/types";
import {
  ToolApiError,
  sourceRunFor,
  submitAnimate,
  submitEngineEdit,
  type FetchLike,
  type PreparedSource,
  type ToolImage,
} from "./runTool";
import type { EditEngine, EngineContext } from "./templates";
import { LTX25_ANIMATE_ACTION } from "@/lib/oj/ltx25";
import { adClipParams, adShotRole } from "./adLtx";
import {
  ASSEMBLE_FPS,
  assembleParamsFor,
  dependencies,
  estimateSpeechSeconds,
  fileRef,
  invalidate,
  isPresenterScene,
  nextRunnable,
  parseScript,
  parseStepId,
  presetFor,
  sceneSeconds,
  stepId,
  updateStep,
  withScript,
  type AssembleSize,
  type MediaFileRef,
  type PipelineKind,
  type PipelineScript,
  type PipelineState,
  type StepOutput,
} from "./pipelines";

export interface PipelineInputs {
  kind: PipelineKind;
  /** Shorts: topic. Ad: brief (product name, audience, offer). */
  topic: string;
  preset: string;
  scenes: number;
  /** Ad: first scene is an original presenter talking (talking_avatar). */
  presenter?: boolean;
  /** Kokoro voice id + speed. */
  voice: string;
  speed?: number;
  /** Shorts: style words appended to every scene prompt. */
  style?: string;
  motion: "animate_low" | "animate_high";
  size: AssembleSize;
  captions: boolean;
  musicDb?: number;
  /** Ad only: product photo + edit engine for the packshots. */
  product?: ToolImage | null;
  engine?: EditEngine | null;
  ctx?: EngineContext;
}

export interface RunnerDeps {
  fetchImpl: FetchLike;
  clientId: string;
  /** Called with every queued run (add it to the gallery store). */
  onRun?: (run: ImagineRun) => void;
  /** Length of a finished clip / audio file in seconds, null if unknown. */
  measure?: (url: string, kind: "audio" | "video") => Promise<number | null>;
  /** Fetch an output back as a data: URL (presenter audio re-upload). */
  toDataUrl?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Per step. */
  timeoutMs?: number;
  /** Shared product-photo source run (seeded once per pipeline). */
  prepared?: PreparedSource;
  isCancelled?: () => boolean;
}

export interface HistoryFile extends MediaFileRef {
  url: string;
  nodeId?: string;
  nodeTitle?: string;
  classType?: string;
}

export interface HistoryOutputs {
  images: HistoryFile[];
  videos: HistoryFile[];
  audios: HistoryFile[];
  texts: { text: string }[];
}

const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
    const msg =
      typeof data.error === "string" && data.error
        ? data.error
        : `Request failed (${res.status})`;
    throw new ToolApiError(msg, res.status);
  }
  return data;
}

function post(deps: RunnerDeps, url: string, body: unknown) {
  return deps.fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function files(value: unknown): HistoryFile[] {
  return Array.isArray(value)
    ? value.filter(
        (f): f is HistoryFile =>
          !!f &&
          typeof f === "object" &&
          typeof (f as HistoryFile).filename === "string",
      )
    : [];
}

/** Poll history until the prompt finishes; throws on a ComfyUI error. */
export async function waitForOutputs(
  deps: RunnerDeps,
  promptId: string,
): Promise<HistoryOutputs> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
    const res = await deps.fetchImpl(
      `/api/comfy/history/${encodeURIComponent(promptId)}`,
    );
    if (res.status !== 404) {
      const data = await readJson(res);
      const status = (data.status ?? {}) as {
        status_str?: string;
        messages?: unknown[];
      };
      if (status.status_str === "error") {
        const err = (status.messages ?? [])
          .map((m) =>
            Array.isArray(m) && m[0] === "execution_error" ? m[1] : null,
          )
          .find(Boolean) as
          { exception_message?: string; node_type?: string } | undefined;
        throw new ToolApiError(
          err?.exception_message
            ? `${err.node_type ?? "ComfyUI"}: ${err.exception_message}`.slice(
                0,
                400,
              )
            : "The ComfyUI job failed",
        );
      }
      const out: HistoryOutputs = {
        images: files(data.images),
        videos: files(data.videos),
        audios: files(data.audios),
        texts: Array.isArray(data.texts)
          ? (data.texts as { text?: unknown }[])
              .filter((t) => typeof t?.text === "string")
              .map((t) => ({ text: t.text as string }))
          : [],
      };
      if (
        out.images.length ||
        out.videos.length ||
        out.audios.length ||
        out.texts.length
      ) {
        return out;
      }
      if (status.status_str === "success")
        throw new ToolApiError("The job finished with no output");
    }
    if (now() > deadline)
      throw new ToolApiError("Timed out waiting for the job");
    await sleep(deps.pollMs ?? DEFAULT_POLL_MS);
  }
}

export function promptIdOf(run: ImagineRun): string {
  const id = run.jobs?.[0]?.prompt_id;
  if (!id) throw new ToolApiError("Server returned no prompt id");
  return id;
}

export function outputOf(file: HistoryFile | undefined, what: string): StepOutput {
  if (!file) throw new ToolApiError(`The job produced no ${what}`);
  const ref = fileRef(file);
  if (!ref) throw new ToolApiError(`Unexpected ${what} file name`);
  return { url: file.url, ref };
}

export async function seedText(
  deps: RunnerDeps,
  prompt: string,
): Promise<{ runId: string; jobIndex: number }> {
  const data = await readJson(
    await post(deps, "/api/jobs/seed-run", {
      text_only: true,
      prompt: prompt.slice(0, 400) || "pipeline",
    }),
  );
  const run = data.run as ImagineRun | undefined;
  if (!run?.run_id) throw new ToolApiError("Could not start the step");
  return { runId: run.run_id, jobIndex: run.jobs?.[0]?.index ?? 0 };
}

export async function action(
  deps: RunnerDeps,
  src: { runId: string; jobIndex: number },
  name: string,
  params: Record<string, unknown>,
): Promise<ImagineRun> {
  const data = await readJson(
    await post(deps, "/api/jobs/action", {
      run_id: src.runId,
      job_index: src.jobIndex,
      action: name,
      client_id: deps.clientId,
      params,
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  const run = data.run as ImagineRun;
  deps.onRun?.(run);
  return run;
}

/** Keep LLM text from tripping the prompt parser's --flags / :: weights. */
export function plainPrompt(text: string): string {
  return text
    .replace(/-{2,}/g, " ")
    .replace(/::/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

export function sceneImagePrompt(visual: string, style?: string): string {
  const body = [plainPrompt(visual), style ? plainPrompt(style) : ""]
    .filter(Boolean)
    .join(", ");
  return `${body} --ar 9:16`;
}

export function packshotPrompt(visual: string, presenter: boolean): string {
  const v = plainPrompt(visual);
  return presenter
    ? `Show an original, fictional presenter holding this exact product, talking to camera. ${v} Keep the product's shape, colours and label unchanged.`
    : `${v} Keep the product's shape, colours and label unchanged.`;
}

export async function measured(
  deps: RunnerDeps,
  out: StepOutput,
  kind: "audio" | "video",
): Promise<StepOutput> {
  let seconds: number | null = null;
  try {
    seconds = (await deps.measure?.(out.url, kind)) ?? null;
  } catch {
    seconds = null;
  }
  return {
    ...out,
    seconds: seconds && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null,
  };
}

export interface StepResult {
  output?: StepOutput;
  runId?: string;
  jobIndex?: number;
  script?: PipelineScript;
}

/** Execute one step against the current state (all its dependencies done). */
export async function executeStep(
  state: PipelineState,
  id: string,
  inputs: PipelineInputs,
  deps: RunnerDeps,
): Promise<StepResult> {
  const { kind, scene } = parseStepId(id);
  const preset = presetFor(inputs.kind, inputs.preset);
  const sc = scene !== undefined ? state.script?.scenes[scene] : undefined;
  if (scene !== undefined && !sc)
    throw new ToolApiError(`Scene ${scene + 1} is missing`);

  if (kind === "script") {
    const params = {
      kind: inputs.kind,
      topic: inputs.topic,
      scenes: inputs.scenes,
      preset: preset.id,
      ...(inputs.kind === "ad" && inputs.presenter ? { presenter: true } : {}),
    };
    let src: { runId: string; jobIndex: number };
    if (inputs.kind === "ad") {
      if (!inputs.product)
        throw new ToolApiError("Add the product photo first.");
      deps.prepared ??= {};
      deps.prepared.run ??= await sourceRunFor(
        deps.fetchImpl,
        inputs.product,
        "Click to Ad",
      );
      src = deps.prepared.run;
    } else {
      if (!inputs.topic.trim())
        throw new ToolApiError("Describe the topic first.");
      src = await seedText(deps, inputs.topic);
    }
    const run = await action(deps, src, "pipeline_script", params);
    const out = await waitForOutputs(deps, promptIdOf(run));
    const text = out.texts.map((t) => t.text).join("\n");
    const script = parseScript(text, {
      maxScenes: inputs.scenes,
      fallbackTitle: inputs.topic,
      fallbackMusic: preset.music,
    });
    return { script, runId: run.run_id, jobIndex: 0 };
  }

  if (kind === "image") {
    let run: ImagineRun;
    if (inputs.kind === "ad") {
      if (!inputs.product || !inputs.engine || !inputs.ctx) {
        throw new ToolApiError(
          "Pick the product photo and an edit engine first.",
        );
      }
      deps.prepared ??= {};
      run = await submitEngineEdit({
        fetchImpl: deps.fetchImpl,
        engine: inputs.engine,
        prompt: packshotPrompt(sc!.visual, isPresenterScene(state.opts, scene)),
        image: inputs.product,
        ctx: inputs.ctx,
        clientId: deps.clientId,
        title: "Click to Ad",
        prepared: deps.prepared,
      });
      deps.onRun?.(run);
    } else {
      const data = await readJson(
        await post(deps, "/api/jobs/imagine", {
          prompt: sceneImagePrompt(sc!.visual, inputs.style),
          client_id: deps.clientId,
          batch_size: 1,
        }),
      );
      const runs = (data.runs ?? []) as ImagineRun[];
      if (!runs[0]) throw new ToolApiError("Server returned no run");
      run = runs[0];
      deps.onRun?.(run);
    }
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: outputOf(pickFinalOutput(out.images), "image"),
      runId: run.run_id,
      jobIndex: run.jobs[0]?.index ?? 0,
    };
  }

  if (kind === "voice") {
    const src = await seedText(deps, sc!.narration);
    const run = await action(deps, src, "voiceover", {
      script: sc!.narration,
      engine: "kokoro",
      voice: inputs.voice,
      ...(typeof inputs.speed === "number" ? { speed: inputs.speed } : {}),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: await measured(
        deps,
        outputOf(pickFinalOutput(out.audios), "voiceover"),
        "audio",
      ),
      runId: run.run_id,
    };
  }

  if (kind === "clip") {
    const image = state.steps[stepId("image", scene)];
    if (!image?.runId)
      throw new ToolApiError(`Scene ${scene! + 1} has no image yet.`);
    const src = { runId: image.runId, jobIndex: image.jobIndex ?? 0 };
    let run: ImagineRun;
    if (inputs.kind === "ad") {
      // Every ad clip is LTX-2.5 i2v with synced sound, vertical, sized to
      // the narration on the 8n+1 frame grid (see adLtx.ts).
      const presenter = isPresenterScene(state.opts, scene);
      const count = state.script?.scenes.length ?? 1;
      const voice = state.steps[stepId("voice", scene)]?.output;
      const speech = presenter
        ? estimateSpeechSeconds(sc!.narration)
        : voice
          ? (voice.seconds ?? estimateSpeechSeconds(sc!.narration))
          : null;
      run = await action(
        deps,
        src,
        LTX25_ANIMATE_ACTION,
        adClipParams({
          role: adShotRole(scene!, count),
          motion: sc!.motion,
          sound: sc!.sound,
          narration: sc!.narration,
          presenter,
          level: inputs.motion,
          speechSeconds: speech,
        }),
      );
    } else {
      run = await submitAnimate({
        fetchImpl: deps.fetchImpl,
        runId: src.runId,
        jobIndex: src.jobIndex,
        motion: inputs.motion,
        prompt: plainPrompt([sc!.motion, sc!.visual].filter(Boolean).join(". ")),
        clientId: deps.clientId,
      });
      deps.onRun?.(run);
    }
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: await measured(
        deps,
        outputOf(pickFinalOutput(out.videos), "clip"),
        "video",
      ),
      runId: run.run_id,
    };
  }

  if (kind === "music") {
    const script = state.script!;
    const total = script.scenes.reduce((sum, s, i) => {
      const clip = state.steps[stepId("clip", i)]?.output?.seconds;
      const voice =
        state.steps[stepId("voice", i)]?.output?.seconds ??
        estimateSpeechSeconds(s.narration);
      return sum + sceneSeconds(clip, voice);
    }, 0);
    const src = await seedText(deps, script.music || preset.music);
    const run = await action(deps, src, "music", {
      prompt: `instrumental, ${plainPrompt(script.music || preset.music)}`,
      duration: Math.min(240, Math.max(10, Math.ceil(total) + 2)),
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: outputOf(pickFinalOutput(out.audios), "music"),
      runId: run.run_id,
    };
  }

  // assemble
  const params = assembleParamsFor(state, {
    size: inputs.size,
    captions: inputs.captions,
    ...(typeof inputs.musicDb === "number" ? { musicDb: inputs.musicDb } : {}),
  });
  const src = await seedText(deps, state.script?.title ?? "Short");
  const run = await action(deps, src, "pipeline_assemble", {
    ...params,
    fps: ASSEMBLE_FPS,
  });
  const out = await waitForOutputs(deps, promptIdOf(run));
  return {
    output: await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "video"),
      "video",
    ),
    runId: run.run_id,
  };
}

/**
 * Run every pending step in order until done, a step fails or the run is
 * cancelled. Failed steps stay failed (their dependents wait) until the user
 * re-runs them via rerunStep.
 */
export async function runPipeline(
  initial: PipelineState,
  inputs: PipelineInputs,
  deps: RunnerDeps,
  onState: (state: PipelineState) => void,
): Promise<PipelineState> {
  let state = initial;
  const commit = (s: PipelineState) => {
    state = s;
    onState(s);
  };
  for (;;) {
    if (deps.isCancelled?.()) return state;
    const id = nextRunnable(state);
    if (!id) return state;
    commit(updateStep(state, id, { status: "running", error: undefined }));
    try {
      const res = await executeStep(state, id, inputs, deps);
      if (res.script) {
        commit(
          updateStep(withScript(state, res.script), id, {
            status: "done",
            runId: res.runId,
            jobIndex: res.jobIndex,
          }),
        );
      } else {
        commit(
          updateStep(state, id, {
            status: "done",
            output: res.output,
            runId: res.runId,
            ...(res.jobIndex !== undefined ? { jobIndex: res.jobIndex } : {}),
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (deps.isCancelled?.()) {
        commit(updateStep(state, id, { status: "idle" }));
        return state;
      }
      commit(updateStep(state, id, { status: "error", error: message }));
      // Keep going with steps that don't depend on the failed one.
    }
  }
}

/** Reset one step (and its dependents) so the next runPipeline redoes it. */
export function rerunStep(state: PipelineState, id: string): PipelineState {
  return invalidate(state, id);
}

/** True when every dependency of `id` is done (the step can be re-run now). */
export function canRerun(state: PipelineState, id: string): boolean {
  return dependencies(id, state.order, state.opts).every(
    (d) => state.steps[d]?.status === "done",
  );
}
