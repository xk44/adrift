"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Square, Wand2, X } from "lucide-react";
import { useGenerationStore } from "@/store";
import { ChoicePicker } from "./ChoicePicker";
import { showToast } from "@/components/Toast";
import {
  SINGLE_ENGINES,
  availableEngines,
  type EditEngineId,
  type EngineContext,
  preferredEngine,
} from "@/lib/tools/templates";
import type { PreparedSource, ToolImage } from "@/lib/tools/runTool";
import type { HubCard } from "@/lib/tools/hub";
import {
  AD_STYLES,
  SCRIPT_SCENES,
  SHORTS_TONES,
  TOPIC_MAX_CHARS,
  editScene,
  initialState,
  parseStepId,
  progressOf,
  withOptions,
  type AssembleSize,
  type PipelineKind,
  type PipelineOptions,
  type PipelineState,
  type PipelineStep,
} from "@/lib/tools/pipelines";
import {
  canRerun,
  rerunStep,
  runPipeline,
  type PipelineInputs,
  type RunnerDeps,
} from "@/lib/tools/pipelineRunner";
import {
  VOICEOVER_KOKORO_DEFAULT_VOICE,
  VOICEOVER_KOKORO_VOICES,
} from "@/lib/oj/voiceoverVoices";
import { ToolImageInput } from "./ToolImageInput";
import { EnginePicker } from "./EnginePicker";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

const STEP_LABEL: Record<string, string> = {
  script: "Script",
  image: "Image",
  voice: "Voiceover",
  clip: "Motion",
  music: "Music bed",
  assemble: "Final cut",
};

export function stepLabel(id: string, opts: PipelineOptions): string {
  const { kind, scene } = parseStepId(id);
  if (scene === undefined) return STEP_LABEL[kind] ?? kind;
  const presenter = opts.kind === "ad" && opts.presenter && scene === 0;
  const base =
    kind === "clip" && presenter ? "Presenter" : (STEP_LABEL[kind] ?? kind);
  return `Scene ${scene + 1} ${base.toLowerCase()}`;
}

/** Media length from metadata (browser only). */
function measureMedia(
  url: string,
  kind: "audio" | "video",
): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const el = document.createElement(kind);
    const done = (v: number | null) => {
      el.removeAttribute("src");
      resolve(v);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 15000);
    el.src = url;
  });
}

async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${url} (${res.status})`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the audio"));
    reader.readAsDataURL(blob);
  });
}

/** Timeline dot fill per step status. */
const STEP_DOT: Record<PipelineStep["status"], string> = {
  idle: "bg-light-input shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:bg-dark-input dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]",
  running: "bg-splash/10",
  done: "bg-emerald-500/10",
  error: "bg-red-500/10",
};

const SECONDARY_BUTTON =
  "flex h-11 items-center gap-1.5 rounded-full px-5 text-sm font-medium text-light-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-[background-color,transform] duration-150 hover:bg-light-input active:scale-[0.96] dark:text-dark-primary dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input";

function StatusIcon({ step }: { step: PipelineStep }) {
  if (step.status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-splash" />;
  if (step.status === "done")
    return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  if (step.status === "error")
    return <X className="h-3.5 w-3.5 text-red-500" />;
  return (
    <span className="block h-1.5 w-1.5 rounded-full bg-light-500/50 dark:bg-dark-400/50" />
  );
}

function Preview({ id, step }: { id: string; step: PipelineStep }) {
  const url = step.output?.url;
  if (!url) return null;
  const kind = parseStepId(id).kind;
  if (kind === "image")
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="mt-1.5 h-24 rounded-md object-cover" />
    );
  if (kind === "voice" || kind === "music")
    return <audio src={url} controls className="mt-1.5 h-8 w-full max-w-xs" />;
  if (kind === "clip")
    return (
      <video
        src={url}
        muted
        loop
        playsInline
        controls
        className="mt-1.5 h-32 rounded-md"
      />
    );
  return null;
}

/**
 * Shorts Studio / Click to Ad: one form, then a step list that runs the
 * existing tools in order (script, images, voice, motion, music, final cut)
 * with per-step progress, re-run and editable scenes.
 */
export function PipelineRunner({
  kind,
  card,
  ctx,
  onBack,
}: {
  kind: PipelineKind;
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const isAd = kind === "ad";
  const presets = isAd ? AD_STYLES : SHORTS_TONES;

  const engines = useMemo(
    () => (isAd ? availableEngines(SINGLE_ENGINES, ctx) : []),
    [isAd, ctx],
  );
  const [engineId, setEngineId] = useState<EditEngineId | null>(null);
  const engine =
    engines.find((e) => e.id === engineId) ?? preferredEngine(engines);

  const [topic, setTopic] = useState("");
  const [preset, setPreset] = useState(presets[0].id);
  const [scenes, setScenes] = useState<number>(
    isAd ? 4 : SCRIPT_SCENES.default,
  );
  const [voice, setVoice] = useState(VOICEOVER_KOKORO_DEFAULT_VOICE);
  const [style, setStyle] = useState("");
  const [motion, setMotion] = useState<"animate_low" | "animate_high">(
    "animate_low",
  );
  const [size, setSize] = useState<AssembleSize>("720x1280");
  const [captions, setCaptions] = useState(true);
  const [product, setProduct] = useState<ToolImage | null>(null);
  const [state, setState] = useState<PipelineState>(() =>
    initialState({ kind, music: true, presenter: false }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const prepared = useRef<PreparedSource>({});

  const started =
    state.script !== null || state.steps.script?.status !== "idle";
  const progress = progressOf(state);
  const final = state.steps.assemble?.output?.url ?? null;

  const setOptions = (patch: Partial<PipelineOptions>) =>
    setState((s) => withOptions(s, { ...s.opts, ...patch }));

  let validation: string | null = null;
  if (isAd && !product) validation = "Add the product photo to start.";
  else if (isAd && !engine) validation = "No edit model is installed.";
  else if (!topic.trim())
    validation = isAd
      ? "Write a short brief first."
      : "Describe the topic first.";

  const inputs = (): PipelineInputs => ({
    kind,
    topic: topic.trim(),
    preset,
    scenes,
    presenter: isAd && !!state.opts.presenter,
    voice,
    style: style.trim() || undefined,
    motion,
    size,
    captions,
    product,
    engine,
    ctx,
  });

  const go = async (from: PipelineState) => {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    const deps: RunnerDeps = {
      fetchImpl: fetch,
      clientId,
      onRun: addRun,
      measure: measureMedia,
      toDataUrl,
      prepared: prepared.current,
      isCancelled: () => cancelled.current,
    };
    try {
      const end = await runPipeline(from, inputs(), deps, setState);
      const failed = end.order.filter(
        (id) => end.steps[id]?.status === "error",
      );
      if (cancelled.current) showToast("Pipeline stopped.", "info");
      else if (failed.length)
        setError(
          `${failed.length} step${failed.length > 1 ? "s" : ""} failed. Fix and re-run them below.`,
        );
      else if (end.steps.assemble?.status === "done")
        showToast(`${card.title}: video ready.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runAll = () => {
    // Failed steps get another try on "Run all".
    let s = state;
    for (const id of s.order)
      if (s.steps[id]?.status === "error") s = rerunStep(s, id);
    void go(s);
  };

  const restart = () => {
    prepared.current = {};
    void go(initialState(state.opts));
  };

  const rerun = (id: string) => {
    if (id === "script") prepared.current = {};
    void go(rerunStep(state, id));
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId={isAd ? "click-to-ad" : "shorts-studio"}
    >
      <fieldset disabled={busy} className="space-y-4">
        {isAd && (
          <>
            <ToolImageInput
              label="Product photo"
              value={product}
              onChange={(img) => {
                setProduct(img);
                prepared.current = {};
              }}
            />
            <EnginePicker
              engines={engines}
              value={engine}
              onChange={setEngineId}
            />
          </>
        )}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            {isAd ? "Brief" : "Topic"}
          </span>
          <textarea
            className={`${field} min-h-[72px]`}
            maxLength={TOPIC_MAX_CHARS}
            value={topic}
            placeholder={
              isAd
                ? "What it is, who it is for, the one thing to remember"
                : "What the short is about"
            }
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <Segmented
          label={isAd ? "Ad style" : "Tone"}
          value={preset}
          options={presets.map((p) => ({ id: p.id, label: p.label }))}
          onChange={setPreset}
        />
        <p className="-mt-2 text-[11px] text-light-500 dark:text-dark-400">
          {presets.find((p) => p.id === preset)?.hint}
        </p>
        <Segmented
          label="Scenes"
          value={String(scenes)}
          options={Array.from(
            { length: SCRIPT_SCENES.max - SCRIPT_SCENES.min + 1 },
            (_, i) => {
              const n = String(SCRIPT_SCENES.min + i);
              return { id: n, label: n };
            },
          )}
          onChange={(v) => setScenes(Number(v))}
        />
        {!isAd && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Look (optional)
            </span>
            <input
              className={field}
              value={style}
              maxLength={160}
              placeholder="e.g. soft watercolor, warm light"
              onChange={(e) => setStyle(e.target.value)}
            />
          </label>
        )}
        <ChoicePicker
          label="Voice"
          value={voice}
          options={VOICEOVER_KOKORO_VOICES}
          onChange={setVoice}
        />
        <Segmented
          label="Motion"
          value={motion}
          options={[
            { id: "animate_low", label: "Subtle" },
            { id: "animate_high", label: "Lively" },
          ]}
          onChange={(v) => setMotion(v as "animate_low" | "animate_high")}
        />
        <Segmented
          label="Output"
          value={size}
          options={[
            { id: "720x1280", label: "720p vertical" },
            { id: "1080x1920", label: "1080p vertical" },
          ]}
          onChange={(v) => setSize(v as AssembleSize)}
        />
        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={captions}
              onChange={(e) => setCaptions(e.target.checked)}
            />
            Burn in captions
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!state.opts.music}
              onChange={(e) => setOptions({ music: e.target.checked })}
            />
            Music bed
          </label>
          {isAd && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!state.opts.presenter}
                onChange={(e) => setOptions({ presenter: e.target.checked })}
              />
              Open with a talking presenter (an original, generated person
              who says the first line on camera)
            </label>
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label={started ? "Continue" : "Make video"}
          busy={busy}
          disabled={!card.available}
          validation={validation}
          error={error}
          queuedText={null}
          onRun={runAll}
          icon={<Wand2 className="h-4 w-4" />}
        />
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
            className={SECONDARY_BUTTON}
          >
            <Square className="h-3.5 w-3.5" /> Stop after this step
          </button>
        )}
        {started && !busy && validation === null && (
          <button type="button" onClick={restart} className={SECONDARY_BUTTON}>
            <RotateCcw className="h-3.5 w-3.5" /> New script
          </button>
        )}
      </div>

      {started && (
        <section className="space-y-3" data-testid="pipeline-steps">
          <div className="flex items-baseline justify-between gap-3 text-xs text-light-500 dark:text-dark-400">
            <span className="tabular-nums">
              <span className="font-medium text-light-primary dark:text-dark-primary">
                {progress.done} of {progress.total}
              </span>{" "}
              steps done
            </span>
            {state.script?.title && (
              <span className="truncate font-medium text-light-primary dark:text-dark-primary">
                {state.script.title}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
            <div
              className="h-full rounded-full bg-splash transition-[width] duration-500 ease-out"
              style={{
                width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
              }}
            />
          </div>
          {final && (
            <video
              src={final}
              controls
              playsInline
              className="mx-auto max-h-[70vh] rounded-xl"
              data-testid="pipeline-final"
            />
          )}
          {state.script?.scenes.map((sc, i) => (
            <div
              key={`${i}:${sc.narration}:${sc.visual}:${sc.motion}:${sc.sound ?? ""}`}
              className="space-y-2 rounded-2xl bg-light-input/60 p-3.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:bg-dark-input/60 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            >
              <p className="flex items-center gap-2 text-xs font-medium text-light-primary dark:text-dark-primary">
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-splash/10 px-1.5 text-[10px] font-semibold tabular-nums text-splash">
                  {i + 1}
                </span>
                Scene {i + 1}
              </p>
              <textarea
                aria-label={`Scene ${i + 1} narration`}
                className={`${field} min-h-[48px]`}
                defaultValue={sc.narration}
                disabled={busy}
                onBlur={(e) =>
                  setState((s) =>
                    editScene(s, i, { narration: e.target.value }),
                  )
                }
              />
              <textarea
                aria-label={`Scene ${i + 1} picture`}
                className={`${field} min-h-[48px] text-xs`}
                defaultValue={sc.visual}
                disabled={busy}
                onBlur={(e) =>
                  setState((s) => editScene(s, i, { visual: e.target.value }))
                }
              />
              <input
                aria-label={`Scene ${i + 1} motion`}
                className={`${field} text-xs`}
                defaultValue={sc.motion}
                disabled={busy}
                onBlur={(e) =>
                  setState((s) => editScene(s, i, { motion: e.target.value }))
                }
              />
              {isAd && (
                <input
                  aria-label={`Scene ${i + 1} sound`}
                  placeholder="Sound design (LTX-2.5 audio)"
                  className={`${field} text-xs`}
                  defaultValue={sc.sound ?? ""}
                  disabled={busy}
                  onBlur={(e) =>
                    setState((s) => editScene(s, i, { sound: e.target.value }))
                  }
                />
              )}
            </div>
          ))}
          <ol className="relative">
            {state.order.map((id, idx) => {
              const step = state.steps[id];
              if (!step) return null;
              const last = idx === state.order.length - 1;
              return (
                <li
                  key={id}
                  className="relative flex gap-3 pb-1"
                  data-testid={`step-${id}`}
                  data-status={step.status}
                >
                  {!last && (
                    <span
                      aria-hidden
                      className={`absolute left-[13px] top-8 bottom-0 w-px ${
                        step.status === "done"
                          ? "bg-emerald-500/40"
                          : "bg-light-100 dark:bg-dark-750"
                      }`}
                    />
                  )}
                  <span
                    className={`relative z-[1] mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${STEP_DOT[step.status]}`}
                  >
                    <StatusIcon step={step} />
                  </span>
                  <div
                    className={`min-w-0 flex-1 rounded-xl px-3 py-2 transition-colors duration-200 ${
                      step.status === "running"
                        ? "bg-splash/5 shadow-[inset_0_0_0_1px_rgb(var(--c-splash)/0.25)]"
                        : ""
                    }`}
                  >
                    <div className="flex min-h-[28px] items-center gap-2 text-xs">
                      <span
                        className={`flex-1 ${
                          step.status === "idle"
                            ? "text-light-500 dark:text-dark-400"
                            : "font-medium text-light-primary dark:text-dark-primary"
                        }`}
                      >
                        {stepLabel(id, state.opts)}
                      </span>
                      {step.status === "running" && (
                        <span className="text-[11px] text-splash">Running</span>
                      )}
                      {!busy &&
                        step.status !== "idle" &&
                        canRerun(state, id) && (
                          <button
                            type="button"
                            className="-mr-1.5 flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-light-500 transition-[background-color,color,transform] duration-150 hover:bg-light-input hover:text-splash active:scale-[0.96] dark:text-dark-400 dark:hover:bg-dark-input"
                            onClick={() => rerun(id)}
                          >
                            <RotateCcw className="h-3 w-3" /> Re-run
                          </button>
                        )}
                    </div>
                    {step.error && (
                      <p className="mt-1 text-[11px] text-red-500">
                        {step.error}
                      </p>
                    )}
                    <Preview id={id} step={step} />
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </RunnerShell>
  );
}
