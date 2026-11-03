"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Square, Wand2, X } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import {
  SINGLE_ENGINES,
  availableEngines,
  type EditEngineId,
  type EngineContext,
  preferredEngine,
} from "@/lib/tools/templates";
import type { PreparedSource, ToolAudio, ToolImage } from "@/lib/tools/runTool";
import type { HubCard } from "@/lib/tools/hub";
import type { AssembleSize } from "@/lib/tools/pipelines";
import { analyzeAudioUrl } from "@/lib/tools/beats";
import {
  CLIPCUT_BEATS_PER_CUT,
  CLIPCUT_GARMENTS,
  CLIPCUT_LENGTHS,
  CLIPCUT_LOOKS,
  CLIPCUT_STYLES,
  ccCanRerun,
  ccInvalidate,
  ccProgress,
  clipCutStyle,
  defaultGarments,
  initialClipCut,
  parseCcStepId,
  planCuts,
  runClipCut,
  type ClipCutDeps,
  type ClipCutInputs,
  type ClipCutState,
  type ClipCutStep,
} from "@/lib/tools/clipCut";
import { ToolImageInput } from "./ToolImageInput";
import { ToolAudioInput } from "./ToolAudioInput";
import { EnginePicker } from "./EnginePicker";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

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

export function clipCutStepLabel(id: string): string {
  const { kind, scene } = parseCcStepId(id);
  if (kind === "look") return `Look ${scene! + 1}`;
  if (kind === "clip") return `Look ${scene! + 1} motion`;
  if (kind === "music") return "Music";
  if (kind === "beats") return "Beat detection";
  return "Beat-cut reel";
}

function StatusIcon({ step }: { step: ClipCutStep }) {
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

function Preview({ step }: { step: ClipCutStep }) {
  const url = step.output?.url;
  if (!url) return null;
  if (step.kind === "look")
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="mt-1.5 h-24 rounded-md object-cover" />
    );
  if (step.kind === "music")
    return <audio src={url} controls className="mt-1.5 h-8 w-full max-w-xs" />;
  if (step.kind === "clip")
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
 * ClipCut / Urban Cuts: one photo -> N outfit looks -> motion -> a reel cut
 * on the music's beats. `variant` picks the starting style.
 */
export function ClipCutRunner({
  variant,
  card,
  ctx,
  onBack,
}: {
  variant: "studio" | "urban";
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const engines = useMemo(() => availableEngines(SINGLE_ENGINES, ctx), [ctx]);
  const [engineId, setEngineId] = useState<EditEngineId | null>(null);
  const engine =
    engines.find((e) => e.id === engineId) ?? preferredEngine(engines);

  const [photo, setPhoto] = useState<ToolImage | null>(null);
  const [style, setStyle] = useState<string>(variant);
  const [garments, setGarments] = useState<string[]>(() => defaultGarments());
  const [notes, setNotes] = useState("");
  const [motion, setMotion] = useState<"animate_low" | "animate_high">(
    "animate_high",
  );
  const [musicSource, setMusicSource] = useState<"generate" | "upload">(
    "generate",
  );
  const [track, setTrack] = useState<ToolAudio | null>(null);
  const [musicTags, setMusicTags] = useState("");
  const [beatsPerCut, setBeatsPerCut] = useState(2);
  const [seconds, setSeconds] = useState(15);
  const [size, setSize] = useState<AssembleSize>("720x1280");
  const [state, setState] = useState<ClipCutState>(() =>
    initialClipCut(garments.length),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const prepared = useRef<PreparedSource>({});

  const started = state.order.some((id) => state.steps[id]?.status !== "idle");
  const progress = ccProgress(state);
  const final = state.steps.assemble?.output?.url ?? null;
  const cuts = useMemo(
    () =>
      state.beats
        ? planCuts(state.beats.beats, {
            looks: state.looks,
            beatsPerCut,
            maxSeconds: seconds,
            duration: state.beats.duration,
          })
        : [],
    [state.beats, state.looks, beatsPerCut, seconds],
  );

  const toggleGarment = (id: string) => {
    if (busy) return;
    const next = garments.includes(id)
      ? garments.filter((g) => g !== id)
      : garments.length >= CLIPCUT_LOOKS.max
        ? garments
        : [...garments, id];
    if (next === garments) return;
    setGarments(next);
    // A different look set means a fresh step list.
    setState(initialClipCut(Math.max(CLIPCUT_LOOKS.min, next.length)));
  };

  let validation: string | null = null;
  if (!photo) validation = "Add a full-body photo to start.";
  else if (!engine) validation = "No edit model is installed.";
  else if (garments.length < CLIPCUT_LOOKS.min)
    validation = `Pick at least ${CLIPCUT_LOOKS.min} looks.`;
  else if (musicSource === "upload" && !track)
    validation = "Add your music track.";

  const inputs = (): ClipCutInputs => ({
    style,
    garments,
    notes: notes.trim() || undefined,
    photo,
    engine,
    ctx,
    motion,
    musicSource,
    track,
    musicTags: musicTags.trim() || undefined,
    beatsPerCut,
    seconds,
    size,
  });

  const go = async (from: ClipCutState) => {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    const deps: ClipCutDeps = {
      fetchImpl: fetch,
      clientId,
      onRun: addRun,
      measure: measureMedia,
      prepared: prepared.current,
      isCancelled: () => cancelled.current,
      analyzeBeats: analyzeAudioUrl,
    };
    try {
      const end = await runClipCut(from, inputs(), deps, setState);
      const failed = end.order.filter(
        (id) => end.steps[id]?.status === "error",
      );
      if (cancelled.current) showToast("Stopped.", "info");
      else if (failed.length)
        setError(
          `${failed.length} step${failed.length > 1 ? "s" : ""} failed. Fix and re-run them below.`,
        );
      else if (end.steps.assemble?.status === "done")
        showToast(`${card.title}: reel ready.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runAll = () => {
    let s = state;
    for (const id of s.order)
      if (s.steps[id]?.status === "error") s = ccInvalidate(s, id);
    void go(s);
  };

  const restart = () => {
    prepared.current = {};
    void go(initialClipCut(garments.length));
  };

  /** Cut settings changed (beats per cut, length): re-assemble only. */
  const recut = () => void go(ccInvalidate(state, "assemble"));

  const s = clipCutStyle(style);

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId={`clipcut-${variant}`}
    >
      <fieldset disabled={busy} className="space-y-4">
        <ToolImageInput
          label="Full-body photo"
          value={photo}
          onChange={(img) => {
            setPhoto(img);
            prepared.current = {};
            setState(initialClipCut(garments.length));
          }}
        />
        <EnginePicker engines={engines} value={engine} onChange={setEngineId} />
        <Segmented
          label="Style"
          value={style}
          options={CLIPCUT_STYLES.map((x) => ({ id: x.id, label: x.label }))}
          onChange={setStyle}
        />
        <p className="-mt-2 text-[11px] text-light-500 dark:text-dark-400">
          {s.description}
        </p>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Looks ({garments.length} of {CLIPCUT_LOOKS.max}, in cut order)
          </span>
          <div className="flex flex-wrap gap-1.5" data-testid="clipcut-looks">
            {CLIPCUT_GARMENTS.map((g) => {
              const at = garments.indexOf(g.id);
              const on = at >= 0;
              return (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={on}
                  title={g.fragment}
                  onClick={() => toggleGarment(g.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    on
                      ? "border-splash bg-splash/10 text-light-primary dark:text-dark-primary"
                      : "border-light-100 text-light-500 hover:border-light-300 dark:border-dark-750 dark:text-dark-400"
                  }`}
                >
                  {on && (
                    <span className="mr-1 font-semibold text-splash">
                      {at + 1}
                    </span>
                  )}
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
            Extra direction (optional)
          </span>
          <input
            className={field}
            value={notes}
            maxLength={160}
            placeholder="e.g. golden hour, gold jewelry"
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <Segmented
          label="Music"
          value={musicSource}
          options={[
            { id: "generate", label: `Generate (${s.bpm} BPM)` },
            { id: "upload", label: "My track" },
          ]}
          onChange={(v) => setMusicSource(v as "generate" | "upload")}
        />
        {musicSource === "upload" ? (
          <ToolAudioInput
            label="Music track"
            value={track}
            onChange={setTrack}
            note="Use music you have the rights to. Beats are detected in your browser."
          />
        ) : (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Music style (optional)
            </span>
            <input
              className={field}
              value={musicTags}
              maxLength={160}
              placeholder={s.music}
              onChange={(e) => setMusicTags(e.target.value)}
            />
          </label>
        )}
        <Segmented
          label="Cut every"
          value={String(beatsPerCut)}
          options={CLIPCUT_BEATS_PER_CUT.map((n) => ({
            id: String(n),
            label: n === 1 ? "beat" : `${n} beats`,
          }))}
          onChange={(v) => setBeatsPerCut(Number(v))}
        />
        <Segmented
          label="Length"
          value={String(seconds)}
          options={CLIPCUT_LENGTHS.map((n) => ({
            id: String(n),
            label: `${n}s`,
          }))}
          onChange={(v) => setSeconds(Number(v))}
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
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label={started ? "Continue" : "Make reel"}
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
          <>
            {state.steps.assemble?.status === "done" && (
              <button
                type="button"
                onClick={recut}
                className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Re-cut
              </button>
            )}
            <button
              type="button"
              onClick={restart}
              className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Start over
            </button>
          </>
        )}
      </div>

      {started && (
        <section className="space-y-3" data-testid="clipcut-steps">
          <div className="flex items-center justify-between text-xs text-light-500 dark:text-dark-400">
            <span>
              {progress.done} of {progress.total} steps done
            </span>
            {state.beats && (
              <span>
                {Math.round(state.beats.bpm)} BPM, {cuts.length} cuts
                {state.beats.confidence === 0 ? " (even grid)" : ""}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-light-100 dark:bg-dark-750">
            <div
              className="h-full bg-splash transition-all"
              style={{
                width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
              }}
            />
          </div>
          {cuts.length > 0 && (
            <div
              className="flex h-5 w-full overflow-hidden rounded-md"
              aria-label="Cut timeline"
              data-testid="clipcut-timeline"
            >
              {cuts.map((c, i) => (
                <div
                  key={i}
                  title={`Look ${c.look + 1}: ${c.seconds.toFixed(2)}s`}
                  className="border-r border-white/60 text-center text-[10px] leading-5 text-white last:border-r-0 dark:border-black/40"
                  style={{
                    flexGrow: c.seconds,
                    background: `hsl(${(c.look * 360) / Math.max(1, state.looks)} 55% 50%)`,
                  }}
                >
                  {c.look + 1}
                </div>
              ))}
            </div>
          )}
          {final && (
            <video
              src={final}
              controls
              playsInline
              className="mx-auto max-h-[70vh] rounded-xl"
              data-testid="clipcut-final"
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
                      {clipCutStepLabel(id)}
                    </span>
                    {!busy &&
                      step.status !== "idle" &&
                      ccCanRerun(state, id) && (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-splash hover:underline"
                          onClick={() => void go(ccInvalidate(state, id))}
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
                  <Preview step={step} />
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </RunnerShell>
  );
}
