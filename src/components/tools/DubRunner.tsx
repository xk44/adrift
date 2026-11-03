"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Square, Wand2, X } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import type { EngineContext } from "@/lib/tools/templates";
import type { HubCard } from "@/lib/tools/hub";
import type { ToolVideo } from "@/lib/tools/runTool";
import {
  DUB_BACKGROUND_DEFAULT,
  DUB_BACKGROUND_KEEP_MIN,
  DUB_BACKGROUND_KEEP_DEFAULT,
  DUB_BACKGROUND_MAX,
  DUB_DEFAULT_ENGINE,
  DUB_DEFAULT_SPEAKERS,
  DUB_DEFAULT_TARGET,
  DUB_LANGUAGES,
  DUB_STRONG_VOICE_LANGS,
  DUB_VOICE_ENGINES,
  dubBackgroundDb,
  dubBackgroundFromPref,
  dubCanRerun,
  dubEngineSupports,
  dubInvalidate,
  dubMaxSeconds,
  dubOverrunSeconds,
  dubProgress,
  dubResolveEngine,
  dubSpanSeconds,
  initialDub,
  readDubBackground,
  withBackground,
  withTranscript,
  withTranslation,
  writeDubBackground,
  type DubBackgroundPref,
  type DubMode,
  type DubState,
  type DubStep,
  type DubStepKind,
  type DubSpeakers,
  type DubVoiceEngine,
} from "@/lib/tools/dubVideo";
import { runDub, type DubDeps, type DubInputs } from "@/lib/tools/dubRunner";
import { ToolVideoInput } from "./ToolVideoInput";
import { useToolHandoff } from "./useToolHandoff";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

export function measureMedia(
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

export const DUB_STEP_LABELS: Record<DubStepKind, string> = {
  transcribe: "Transcribe (Whisper)",
  translate: "Translate",
  voice: "Cloned voice (VibeVoice)",
  lipsync: "Lipsync the face (InfiniteTalk)",
  mux: "Swap the soundtrack",
  mix: "Mix in the original audio",
};

/** Step label; the voice step names the engine that voices `target`. */
export function dubStepLabel(
  id: DubStepKind,
  engine: DubVoiceEngine,
  target = "",
  clone = true,
): string {
  if (id !== "voice") return DUB_STEP_LABELS[id];
  if (!clone) return "Stock voice (Chatterbox)";
  return dubResolveEngine(engine, target) === "chatterbox"
    ? "Cloned voice (Chatterbox)"
    : DUB_STEP_LABELS.voice;
}

/** Slider readout: "Off (replaced)" or "25% (-12 dB)". */
export function dubBackgroundLabel(level: number): string {
  const db = dubBackgroundDb(level);
  if (db === null) return "Off (replaced)";
  return `${level}% (${db === 0 ? "0" : `\u2212${Math.abs(db)}`} dB)`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function StatusIcon({ step }: { step: DubStep }) {
  if (step.status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-splash" />;
  if (step.status === "done")
    return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  if (step.status === "error")
    return <X className="h-3.5 w-3.5 text-red-500" />;
  return (
    <span className="block h-3.5 w-3.5 rounded-full border border-light-100 dark:border-dark-750" />
  );
}

/**
 * Video Translator: clip in -> Whisper transcript (editable) -> LLM
 * translation (editable; the run pauses here for review) -> VibeVoice or
 * Chatterbox clone of the speaker -> InfiniteTalk face lipsync, or just the
 * new soundtrack over the original frames (audio-only mode). The original
 * audio can stay underneath at a chosen level instead of being replaced.
 */
export function DubRunner({
  card,
  ctx,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [video, setVideo] = useState<ToolVideo | null>(null);
  const [mode, setMode] = useState<DubMode>("lipsync");
  const [target, setTarget] = useState(DUB_DEFAULT_TARGET);
  const [source, setSource] = useState("auto");
  const [engine, setEngine] = useState<DubVoiceEngine>(DUB_DEFAULT_ENGINE);
  const [faceTarget, setFaceTarget] = useState("");
  const [bed, setBed] = useState<DubBackgroundPref>({
    keep: false,
    level: DUB_BACKGROUND_KEEP_DEFAULT,
  });
  const background = dubBackgroundFromPref(bed);
  const [review, setReview] = useState(true);
  const [clone, setClone] = useState(true);
  const [speakers, setSpeakers] = useState<DubSpeakers>(DUB_DEFAULT_SPEAKERS);
  const several = mode === "audio" && speakers === "several";
  const [state, setState] = useState<DubState>(() =>
    initialDub("lipsync", DUB_BACKGROUND_DEFAULT),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const clip = useRef<DubDeps["clip"]>(undefined);

  const started = state.order.some((id) => state.steps[id]?.status !== "idle");
  const progress = dubProgress(state);
  const finalStep = state.steps[state.order[state.order.length - 1]];
  const final = finalStep?.output?.url ?? null;
  const voiceUrl = state.steps.voice?.output?.url ?? null;
  const lipsyncReady = !ctx.packIds || ctx.packIds.has("wan-animate");
  const span = dubSpanSeconds(mode, video?.duration);
  const overrun = dubOverrunSeconds(state, video?.duration);
  const clipped =
    typeof video?.duration === "number" && video.duration > dubMaxSeconds(mode);

  const reset = (m: DubMode = mode) => setState(initialDub(m, background));

  const changeBed = (next: DubBackgroundPref) => {
    setBed(next);
    writeDubBackground(storage(), next);
    setState((s) => withBackground(s, dubBackgroundFromPref(next)));
  };

  // Saved "Keep original audio" setting (read after mount: SSR-safe).
  useEffect(() => {
    const saved = readDubBackground(storage());
    setBed(saved);
    setState((s) => withBackground(s, dubBackgroundFromPref(saved)));
  }, []);

  // Lightbox "Tools" panel: the open clip arrives as the input.
  useToolHandoff(card.key, {
    onVideo: (v) => {
      setVideo(v);
      clip.current = undefined;
      setState(initialDub(mode, background));
    },
    onError: setError,
  });

  let validation: string | null = null;
  if (!video) validation = "Add a clip of someone talking.";
  else if (mode === "lipsync" && !lipsyncReady)
    validation =
      "Lipsync needs the Wan Animate + InfiniteTalk pack. Use Audio only instead.";
  else if (several) validation = null;
  else if (!clone && !dubEngineSupports("chatterbox", target))
    validation = `No stock voice speaks ${
      DUB_LANGUAGES.find((l) => l.id === target)?.label ?? target
    }. Turn voice cloning on or pick another language.`;
  else if (clone && !dubEngineSupports(engine, target))
    validation = `Chatterbox cannot speak ${
      DUB_LANGUAGES.find((l) => l.id === target)?.label ?? target
    }. Pick VibeVoice or another language.`;

  const inputs = (): DubInputs => ({
    video: video!,
    mode,
    target,
    source,
    faceTarget: faceTarget.trim() || undefined,
    engine,
    clone,
    speakers: several ? "several" : "one",
  });

  const go = async (from: DubState) => {
    if (!video) return;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    const deps: DubDeps = {
      fetchImpl: fetch,
      clientId,
      onRun: addRun,
      measure: measureMedia,
      toDataUrl,
      isCancelled: () => cancelled.current,
      clip: clip.current,
      ...(review ? { pauseBefore: "voice" as const } : {}),
    };
    try {
      const end = await runDub(from, inputs(), deps, setState);
      clip.current = deps.clip;
      const failed = end.order.find((id) => end.steps[id]?.status === "error");
      if (cancelled.current) showToast("Stopped.", "info");
      else if (failed)
        setError(
          `${dubStepLabel(failed, several ? "vibevoice" : engine, target, several || clone)} failed. Fix it and re-run below.`,
        );
      else if (finalOf(end)?.status === "done")
        showToast(`${card.title}: translated clip ready.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runAll = () => {
    let s = state;
    for (const id of s.order)
      if (s.steps[id]?.status === "error") s = dubInvalidate(s, id);
    void go(s);
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="dub-video"
    >
      <fieldset disabled={busy} className="space-y-4">
        <ToolVideoInput
          label="Clip with speech"
          value={video}
          onChange={(v) => {
            setVideo(v);
            clip.current = undefined;
            reset();
          }}
          note={`Lipsync takes one speaker; Audio only can voice several. Lipsync dubs the first ${dubMaxSeconds("lipsync")} s, audio only the first ${dubMaxSeconds("audio")} s.`}
        />
        <Segmented
          label="Output"
          value={mode}
          options={[
            { id: "lipsync", label: "Lipsync" },
            { id: "audio", label: "Audio only" },
          ]}
          onChange={(v) => {
            setMode(v as DubMode);
            reset(v as DubMode);
          }}
        />
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Translate into
          </span>
          <select
            className={field}
            value={target}
            data-testid="dub-target"
            onChange={(e) => {
              setTarget(e.target.value);
              if (started) setState(dubInvalidate(state, "translate"));
            }}
          >
            {DUB_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {mode === "audio" && (
          <Segmented
            label="Speakers"
            value={speakers}
            options={[
              { id: "one", label: "One" },
              { id: "several", label: "Several" },
            ]}
            onChange={(v) => {
              setSpeakers(v as DubSpeakers);
              if (state.steps.transcribe?.status !== "idle")
                setState(dubInvalidate(state, "transcribe"));
            }}
          />
        )}
        {several && (
          <p
            className="-mt-2 text-[11px] text-light-500 dark:text-dark-400"
            data-testid="dub-several-note"
          >
            VibeVoice-ASR (about 16 GB, separate download, NVIDIA or AMD GPU)
            finds up to 4 people
            and each is cloned from their longest turn. Best on clear,
            turn-taking speech. Fast exchanges can still merge into one speaker,
            where it stops, or swap who said what, so check the script. People
            talking over each other can lose words. Non-English,
            non-Chinese lines can sound accented.
          </p>
        )}
        {!several && (
        <label className="flex items-center gap-2 text-xs text-light-primary dark:text-dark-primary">
          <input
            type="checkbox"
            checked={clone}
            data-testid="dub-clone"
            onChange={(e) => {
              setClone(e.target.checked);
              if (state.steps.voice?.status !== "idle")
                setState(dubInvalidate(state, "voice"));
            }}
          />
          Clone the speaker&apos;s voice
        </label>
        )}
        {!several && !clone && (
          <p className="-mt-2 text-[11px] text-light-500 dark:text-dark-400">
            A stock Chatterbox voice speaks the translation instead.
          </p>
        )}
        {!several && clone && (
          <Segmented
            label="Voice engine"
            value={engine}
            options={DUB_VOICE_ENGINES.map((e) => ({
              id: e.id,
              label: e.label,
            }))}
            onChange={(v) => {
              setEngine(v as DubVoiceEngine);
              if (state.steps.voice?.status !== "idle")
                setState(dubInvalidate(state, "voice"));
            }}
          />
        )}
        {!several &&
          clone &&
          dubResolveEngine(engine, target) === "vibevoice" &&
          !DUB_STRONG_VOICE_LANGS.has(target) && (
            <p className="-mt-2 text-[11px] text-light-500 dark:text-dark-400">
              The voice model is strongest in English and Chinese. Other
              languages work but can sound accented.
            </p>
          )}
        {!several && clone && engine === "auto" && (
          <p
            className="-mt-2 text-[11px] text-light-500 dark:text-dark-400"
            data-testid="dub-auto-engine"
          >
            Auto voices{" "}
            {DUB_LANGUAGES.find((l) => l.id === target)?.label ?? target} with{" "}
            {dubResolveEngine(engine, target) === "chatterbox"
              ? "Chatterbox"
              : "VibeVoice"}
            .
          </p>
        )}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Spoken language
          </span>
          <select
            className={field}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              if (started) setState(dubInvalidate(state, "transcribe"));
            }}
          >
            <option value="auto">Detect automatically</option>
            {DUB_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1.5">
          <label className="flex items-center justify-between gap-2 text-xs font-medium text-light-primary dark:text-dark-primary">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={bed.keep}
                data-testid="dub-background-keep"
                onChange={(e) => changeBed({ ...bed, keep: e.target.checked })}
              />
              <span>Keep original audio</span>
            </span>
            <span
              className="font-normal text-light-500 dark:text-dark-400"
              data-testid="dub-background-value"
            >
              {dubBackgroundLabel(background)}
            </span>
          </label>
          <input
            type="range"
            min={DUB_BACKGROUND_KEEP_MIN}
            max={DUB_BACKGROUND_MAX}
            step={1}
            value={bed.level}
            disabled={!bed.keep}
            data-testid="dub-background"
            aria-label="Original audio level"
            className="w-full accent-splash disabled:opacity-40"
            onChange={(e) =>
              changeBed({ ...bed, level: Number(e.target.value) })
            }
          />
          <span className="block text-[11px] text-light-500 dark:text-dark-400">
            Plays the clip&apos;s own sound under the new speech instead of
            replacing it. The original voice is in there too, so keep it low:
            the default {dubBackgroundLabel(DUB_BACKGROUND_KEEP_DEFAULT)} leaves
            room tone and music.
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs text-light-primary dark:text-dark-primary">
          <input
            type="checkbox"
            checked={review}
            data-testid="dub-review"
            onChange={(e) => setReview(e.target.checked)}
          />
          Pause to review the script before voicing
        </label>
        {mode === "lipsync" && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Whose face (optional)
            </span>
            <input
              className={field}
              value={faceTarget}
              maxLength={80}
              placeholder="face (e.g. woman on the left)"
              onChange={(e) => setFaceTarget(e.target.value)}
            />
          </label>
        )}
        {clipped && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Only the first {span} s of the clip will be dubbed.
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label={started ? "Continue" : "Dub video"}
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
            className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
          >
            <Square className="h-3.5 w-3.5" /> Stop after this step
          </button>
        )}
        {started && !busy && validation === null && (
          <button
            type="button"
            onClick={() => {
              clip.current = undefined;
              void go(initialDub(mode, background));
            }}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Start over
          </button>
        )}
      </div>

      {started && (
        <section className="space-y-3" data-testid="dub-steps">
          <div className="text-xs text-light-500 dark:text-dark-400">
            {progress.done} of {progress.total} steps done
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
            <div
              className="h-full bg-splash transition-all"
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
              data-testid="dub-final"
            />
          )}
          <ol className="space-y-1.5">
            {state.order.map((id) => {
              const step = state.steps[id];
              if (!step) return null;
              return (
                <li
                  key={id}
                  className="rounded-lg border border-light-100 px-3 py-2 dark:border-dark-750"
                  data-testid={`step-${id}`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <StatusIcon step={step} />
                    <span className="flex-1 text-light-primary dark:text-dark-primary">
                      {dubStepLabel(
                        id,
                        several ? "vibevoice" : engine,
                        target,
                        several || clone,
                      )}
                    </span>
                    {!busy &&
                      step.status !== "idle" &&
                      dubCanRerun(state, id) && (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-splash hover:underline"
                          onClick={() => void go(dubInvalidate(state, id))}
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
                  {id === "transcribe" && step.status === "done" && (
                    <textarea
                      className={`${field} mt-1.5 min-h-[4rem] text-xs`}
                      value={state.transcript}
                      aria-label="Transcript"
                      disabled={busy}
                      data-testid="dub-transcript"
                      onChange={(e) =>
                        setState(withTranscript(state, e.target.value))
                      }
                    />
                  )}
                  {id === "translate" && step.status === "done" && (
                    <textarea
                      className={`${field} mt-1.5 min-h-[4rem] text-xs`}
                      value={state.translation}
                      aria-label="Translated script"
                      disabled={busy}
                      data-testid="dub-translation"
                      onChange={(e) =>
                        setState(withTranslation(state, e.target.value))
                      }
                    />
                  )}
                  {id === "voice" && voiceUrl && (
                    <audio
                      src={voiceUrl}
                      controls
                      className="mt-1.5 h-8 w-full max-w-xs"
                    />
                  )}
                  {id === "voice" && overrun !== null && (
                    <p
                      className="mt-1 text-[11px] text-amber-600 dark:text-amber-400"
                      data-testid="dub-overrun"
                    >
                      The new speech runs {overrun} s longer than the {span} s
                      clip, so its end will be cut. Shorten the translation
                      above and Continue to re-voice it, or Continue as is.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {state.steps.translate?.status === "done" &&
            state.steps.voice?.status === "idle" &&
            !busy && (
              <p className="text-[11px] text-light-500 dark:text-dark-400">
                Fix the transcript or edit the translation above if needed, then
                Continue. A transcript edit re-translates first.
              </p>
            )}
        </section>
      )}
    </RunnerShell>
  );
}

function finalOf(state: DubState): DubStep | undefined {
  return state.steps[state.order[state.order.length - 1]];
}
