"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import { useImagine } from "@/hooks/useImagine";
import {
  FIRST_FRAME_ENGINES,
  STORY_STRUCTURES,
  STORYBOARD_FRAME_COUNTS,
  animatableFrames,
  firstFrameT2IPrompt,
  initialFrames,
  nextFrameEngineIds,
  nextFrameToSubmit,
  planShots,
  resetFrom,
  submitStoryFrame,
  type FrameState,
  type RefRole,
  type StoryShot,
} from "@/lib/tools/storyboard";
import {
  availableEngines,
  type EditEngineId,
  type EngineContext,
  preferredEngine,
} from "@/lib/tools/templates";
import {
  sourceRunFor,
  submitAnimate,
  type ToolImage,
} from "@/lib/tools/runTool";
import type { HubCard } from "@/lib/tools/hub";
import { ToolImageInput } from "./ToolImageInput";
import { CharacterProfilePicker } from "./CharacterProfilePicker";
import { EnginePicker } from "./EnginePicker";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

const MOTION_OPTIONS = [
  { id: "animate_low", label: "Gentle" },
  { id: "animate_high", label: "Lively" },
];

const ROLE_OPTIONS: { id: RefRole; label: string }[] = [
  { id: "character", label: "Character" },
  { id: "opening", label: "Opening frame" },
];

/**
 * Storyboard sequencer: frame 1 from text (or the character reference),
 * then each frame is a next-scene edit of the previous one, queued one at
 * a time. Per-frame re-roll re-chains the frames after it; "Animate all"
 * sends every finished frame to the animate (i2v) action.
 */
export function StoryboardRunner({
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
  const runs = useGenerationStore((s) => s.runs);
  const { imagine } = useImagine();

  const [premise, setPremise] = useState("");
  const [structureId, setStructureId] = useState(STORY_STRUCTURES[0].id);
  const [count, setCount] = useState(6);
  const [reference, setReference] = useState<ToolImage | null>(null);
  const [refRole, setRefRole] = useState<RefRole>("character");
  const hasCharacter = Boolean(reference) && refRole === "character";

  const engines = useMemo(
    () => availableEngines(nextFrameEngineIds(hasCharacter), ctx),
    [hasCharacter, ctx],
  );
  const [engineId, setEngineId] = useState<EditEngineId | null>(null);
  const engine =
    engines.find((e) => e.id === engineId) ?? preferredEngine(engines);
  const firstEngine = useMemo(
    () => preferredEngine(availableEngines(FIRST_FRAME_ENGINES, ctx)),
    [ctx],
  );

  // Shot list: auto from the structure until the user edits a line.
  const autoShots = useMemo(
    () => planShots(structureId, premise, count),
    [structureId, premise, count],
  );
  const [edited, setEdited] = useState<StoryShot[] | null>(null);
  const shots = edited && edited.length === count ? edited : autoShots;

  const [frames, setFrames] = useState<FrameState[]>(() => initialFrames(6));
  const [chainStarted, setChainStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const [motionKind, setMotionKind] = useState("animate_low");
  const [animBusy, setAnimBusy] = useState(false);
  const [animError, setAnimError] = useState<string | null>(null);
  const [animQueued, setAnimQueued] = useState(0);
  const [cascade, setCascade] = useState(true);

  const busy = frames.some((f) => f.status === "queued");

  // Sync queued frames with their runs in the store.
  useEffect(() => {
    setFrames((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        if (f.status !== "queued" || !f.runId) return f;
        const run = runs.find((r) => r.run_id === f.runId);
        const job = run?.jobs?.[0];
        if (!job) return f;
        if (job.status === "done" && job.images.length > 0) {
          changed = true;
          return {
            ...f,
            status: "done" as const,
            jobIndex: job.index ?? 0,
            imageUrl: job.images[0],
          };
        }
        if (job.status === "error" || job.status === "cancelled") {
          changed = true;
          return {
            ...f,
            status: "error" as const,
            error: job.error ?? "The job failed.",
          };
        }
        return f;
      });
      return changed ? next : prev;
    });
  }, [runs]);

  const submitFrame = async (index: number) => {
    submitting.current = true;
    setFrames((prev) =>
      prev.map((f, i) => (i === index ? { status: "queued" } : f)),
    );
    try {
      let run;
      if (index === 0 && !reference) {
        const r = await imagine(firstFrameT2IPrompt(shots[0], premise));
        if (!r.ok || !r.runs?.[0])
          throw new Error(r.error ?? "Generation failed.");
        run = r.runs[0];
      } else {
        if (!engine) throw new Error("No edit model is installed.");
        run = await submitStoryFrame({
          fetchImpl: fetch,
          index,
          frames,
          shots,
          premise,
          reference,
          refRole,
          engine,
          firstEngine,
          ctx,
          clientId,
          onWarnings: (w) => w.forEach((m) => showToast(m, "info", 8000)),
        });
        addRun(run);
      }
      setFrames((prev) =>
        prev.map((f, i) =>
          i === index
            ? {
                status: "queued",
                runId: run.run_id,
                jobIndex: run.jobs?.[0]?.index ?? 0,
              }
            : f,
        ),
      );
    } catch (e) {
      const msg = errorMessage(e);
      setFrames((prev) =>
        prev.map((f, i) => (i === index ? { status: "error", error: msg } : f)),
      );
      setError(`Frame ${index + 1}: ${msg}`);
    } finally {
      submitting.current = false;
    }
  };

  // Drive the chain: queue the next frame once the previous one is done.
  const submitRef = useRef(submitFrame);
  submitRef.current = submitFrame;
  useEffect(() => {
    if (submitting.current) return;
    const i = nextFrameToSubmit(frames, chainStarted);
    if (i !== null) void submitRef.current(i);
  }, [frames, chainStarted]);

  const start = () => {
    setError(null);
    setAnimQueued(0);
    const fresh = initialFrames(count);
    if (reference && refRole === "opening")
      fresh[0] = {
        status: "done",
        image: reference,
        runId: reference.runId,
        jobIndex: reference.jobIndex,
        imageUrl: reference.previewUrl,
      };
    setFrames(fresh);
    setChainStarted(true);
  };

  const reroll = (k: number) => {
    setError(null);
    setFrames((prev) => resetFrom(prev, k, cascade));
    setChainStarted(true);
  };

  const animateAll = async () => {
    setAnimBusy(true);
    setAnimError(null);
    let queued = 0;
    try {
      for (const i of animatableFrames(frames)) {
        const f = frames[i];
        let src = f.runId
          ? { runId: f.runId, jobIndex: f.jobIndex ?? 0 }
          : null;
        if (!src && f.image)
          src = await sourceRunFor(fetch, f.image, `Storyboard ${i + 1}`);
        if (!src) continue;
        const r = await submitAnimate({
          fetchImpl: fetch,
          runId: src.runId,
          jobIndex: src.jobIndex,
          motion: motionKind as "animate_low" | "animate_high",
          prompt: shots[i]?.motion ?? "",
          clientId,
        });
        addRun(r);
        queued += 1;
        setAnimQueued(queued);
      }
      showToast(
        `${queued} clip(s) queued. Progress shows in Create.`,
        "success",
      );
    } catch (e) {
      setAnimError(errorMessage(e));
    } finally {
      setAnimBusy(false);
    }
  };

  const editShot = (i: number, text: string) =>
    setEdited((prev) => {
      const base = prev && prev.length === count ? prev : autoShots;
      return base.map((s, j) => (j === i ? { ...s, text } : s));
    });

  let validation: string | null = null;
  if (!premise.trim() && !reference)
    validation = "Describe the premise to start.";
  else if (hasCharacter && !firstEngine)
    validation = "Starting from a character needs an edit model.";
  else if (busy) validation = "Storyboard in progress...";

  const doneCount = frames.filter((f) => f.status === "done").length;
  const animatable = animatableFrames(frames).length;

  return (
    <RunnerShell
      title={card.title}
      subtitle="Write a premise, pick a structure and get a strip of consistent frames. Each frame is the next shot of the one before it."
      model={engine ? `Frames 2+ on ${engine.model} · open weights` : null}
      blockedReason={
        engine
          ? null
          : (card.unavailableReason ??
            "No edit model is installed on this server.")
      }
      checking={!engine && card.checking}
      onBack={onBack}
      testId="storyboard-runner"
    >
      <section className="space-y-1.5">
        <label
          htmlFor="storyboard-premise"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          Premise
        </label>
        <textarea
          id="storyboard-premise"
          rows={2}
          maxLength={400}
          className={`${field} resize-y`}
          placeholder="a lone courier crosses a flooded neon city to deliver a glowing package"
          value={premise}
          onChange={(e) => setPremise(e.target.value)}
        />
      </section>

      <Segmented
        label="Structure"
        value={structureId}
        options={STORY_STRUCTURES.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => {
          setStructureId(id);
          setEdited(null);
        }}
      />
      <Segmented
        label="Frames"
        value={String(count)}
        options={STORYBOARD_FRAME_COUNTS.map((n) => ({
          id: String(n),
          label: String(n),
        }))}
        onChange={(id) => {
          setCount(Number(id));
          setEdited(null);
          // A new length starts a new board (frames and shots must align).
          setChainStarted(false);
          setFrames(initialFrames(Number(id)));
        }}
        disabled={busy}
      />

      <section className="space-y-2">
        <CharacterProfilePicker
          toolKey={card.key}
          disabled={busy}
          needsPixels
          onApply={(img, _next, prev) => {
            if (img) setReference(img);
            else if (prev?.refs.some((r) => r.id === reference?.id))
              setReference(null);
          }}
        />
        <ToolImageInput
          label="Reference (optional)"
          value={reference}
          onChange={setReference}
          needsPixels
        />
        {reference && (
          <Segmented
            label="Reference is"
            value={refRole}
            options={ROLE_OPTIONS}
            onChange={(id) => setRefRole(id as RefRole)}
          />
        )}
      </section>

      {engines.length > 0 && (
        <EnginePicker engines={engines} value={engine} onChange={setEngineId} />
      )}

      <details className="text-xs" open>
        <summary className="cursor-pointer text-light-500 dark:text-dark-400">
          Shot list {edited ? "(edited)" : "(auto)"}
        </summary>
        <ol className="mt-2 space-y-1.5">
          {shots.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-[11px] text-light-500 dark:text-dark-400">
                {i + 1}
              </span>
              <input
                className={field}
                maxLength={400}
                value={s.text}
                onChange={(e) => editShot(i, e.target.value)}
                aria-label={`Shot ${i + 1}`}
              />
            </li>
          ))}
        </ol>
        {edited && (
          <button
            type="button"
            onClick={() => setEdited(null)}
            className="mt-2 flex items-center gap-1 text-[11px] text-light-500 dark:text-dark-400 hover:text-splash"
          >
            <RotateCcw className="h-3 w-3" /> Reset to auto shots
          </button>
        )}
      </details>

      <RunFooter
        label="Generate storyboard"
        busy={busy}
        disabled={!engine || busy}
        validation={validation}
        error={error}
        queuedText={
          chainStarted ? `${doneCount}/${frames.length} frames done.` : null
        }
        onRun={start}
      />

      {chainStarted && (
        <section aria-label="Frames" className="space-y-2">
          <div
            className="flex gap-3 overflow-x-auto pb-2"
            data-testid="storyboard-strip"
          >
            {frames.map((f, i) => (
              <figure
                key={i}
                className="w-40 flex-shrink-0 space-y-1"
                data-testid={`storyboard-frame-${i}`}
              >
                <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input">
                  {f.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.imageUrl}
                      alt={`Frame ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : f.status === "queued" ? (
                    <Loader2 className="h-4 w-4 animate-spin text-light-500" />
                  ) : f.status === "error" ? (
                    <span className="px-2 text-center text-[10px] text-red-500">
                      {f.error ?? "Failed"}
                    </span>
                  ) : (
                    <span className="text-[10px] text-light-500 dark:text-dark-400">
                      waiting
                    </span>
                  )}
                </div>
                <figcaption className="flex items-center justify-between text-[10px] text-light-500 dark:text-dark-400">
                  <span>Frame {i + 1}</span>
                  <button
                    type="button"
                    onClick={() => reroll(i)}
                    disabled={
                      busy ||
                      (i === 0 && refRole === "opening" && Boolean(reference))
                    }
                    className="flex items-center gap-0.5 hover:text-splash disabled:opacity-40"
                    aria-label={`Re-roll frame ${i + 1}`}
                  >
                    <RefreshCw className="h-3 w-3" /> Re-roll
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] text-light-500 dark:text-dark-400">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
            />
            Re-roll also redoes the frames after it (keeps the chain consistent)
          </label>
        </section>
      )}

      <section
        className="space-y-3 rounded-xl border border-light-100 dark:border-dark-750 p-4"
        aria-label="Animate all"
      >
        <div>
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Animate all
          </h3>
          <p className="mt-0.5 text-[11px] text-light-500 dark:text-dark-400">
            Each finished frame becomes a short clip with its shot's motion ·
            LTX-Video · open weights
          </p>
        </div>
        <Segmented
          label="Motion"
          value={motionKind}
          options={MOTION_OPTIONS}
          onChange={setMotionKind}
        />
        <RunFooter
          label={`Animate ${animatable || ""} frame${animatable === 1 ? "" : "s"}`.replace(
            "  ",
            " ",
          )}
          icon={<Film className="w-4 h-4" />}
          busy={animBusy}
          disabled={animatable === 0 || busy}
          validation={
            animatable === 0
              ? "Generate the storyboard first."
              : busy
                ? "Waiting for the remaining frames..."
                : null
          }
          error={animError}
          queuedText={animQueued ? `${animQueued} clip(s) queued.` : null}
          onRun={animateAll}
        />
      </section>
    </RunnerShell>
  );
}
