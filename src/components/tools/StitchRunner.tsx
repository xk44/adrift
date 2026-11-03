"use client";

import { useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Square,
  X,
} from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import type { EngineContext } from "@/lib/tools/templates";
import type { HubCard } from "@/lib/tools/hub";
import {
  STITCH_DEFAULT_FADE_SECONDS,
  STITCH_FADE_LENGTHS,
  STITCH_FIT_OPTIONS,
  STITCH_FPS_OPTIONS,
  STITCH_MAX_CLIPS,
  STITCH_TRANSITIONS,
  recentVideoClips,
  stitchValidation,
  type StitchClip,
  type StitchFit,
  type StitchOptions,
  type StitchTransition,
} from "@/lib/tools/stitchClips";
import { runStitch, type StitchResult } from "@/lib/tools/stitchRunner";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented } from "./ToolRunner";
import { measureMedia } from "./DubRunner";

const PICKER_LIMIT = 24;

/**
 * Stitch clips: pick 2-8 of your recent video outputs, in order, and join
 * them with hard cuts or crossfades (stock ComfyUI + VideoHelperSuite nodes,
 * no model).
 */
export function StitchRunner({
  card,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  const gallery = useGenerationStore((s) => s.gallery);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const recent = useMemo(
    () => recentVideoClips(gallery, PICKER_LIMIT),
    [gallery],
  );
  const [picked, setPicked] = useState<StitchClip[]>([]);
  const [transition, setTransition] = useState<StitchTransition>("cut");
  const [fade, setFade] = useState(String(STITCH_DEFAULT_FADE_SECONDS));
  const [fps, setFps] = useState("24");
  const [fit, setFit] = useState<StitchFit>("crop");
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StitchResult | null>(null);
  const cancelled = useRef(false);

  const opts: StitchOptions = {
    transition,
    fadeSeconds: Number(fade),
    fps: fps === "source" ? "source" : Number(fps),
    fit,
    audio,
  };
  const validation = stitchValidation(picked, { transition });

  const toggle = (clip: StitchClip) =>
    setPicked((list) =>
      list.some((c) => c.ref === clip.ref)
        ? list.filter((c) => c.ref !== clip.ref)
        : list.length >= STITCH_MAX_CLIPS
          ? list
          : [...list, clip],
    );
  const move = (i: number, by: number) =>
    setPicked((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const go = async () => {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await runStitch(picked, opts, {
        fetchImpl: fetch,
        clientId,
        onRun: addRun,
        measure: measureMedia,
        isCancelled: () => cancelled.current,
      });
      setResult(res);
      showToast(`${card.title}: done.`, "success");
    } catch (e) {
      if (cancelled.current) showToast("Stopped waiting.", "info");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="stitch-clips"
    >
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-light-600 dark:text-dark-300">
            Your recent clips (tap in the order they should play, up to{" "}
            {STITCH_MAX_CLIPS})
          </div>
          {recent.length === 0 ? (
            <p
              className="text-[11px] text-light-500 dark:text-dark-400"
              data-testid="stitch-empty"
            >
              No video outputs yet. Make a few clips first, then come back to
              join them.
            </p>
          ) : (
            <div
              className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6"
              data-testid="stitch-picker"
            >
              {recent.map((clip) => {
                const order = picked.findIndex((c) => c.ref === clip.ref);
                return (
                  <button
                    key={clip.ref}
                    type="button"
                    title={clip.label}
                    aria-pressed={order >= 0}
                    onClick={() => toggle(clip)}
                    className={`relative aspect-video overflow-hidden rounded-lg border-2 bg-black ${
                      order >= 0
                        ? "border-blue-500"
                        : "border-transparent hover:border-light-200 dark:hover:border-dark-600"
                    }`}
                  >
                    <video
                      src={clip.url}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-full w-full object-cover"
                    />
                    {order >= 0 && (
                      <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[11px] font-semibold text-white">
                        {order + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {picked.length > 0 && (
          <div className="space-y-2" data-testid="stitch-order">
            <div className="text-xs font-medium text-light-600 dark:text-dark-300">
              Order
            </div>
            <ol className="flex flex-wrap gap-2">
              {picked.map((clip, i) => (
                <li
                  key={clip.ref}
                  className="flex items-center gap-1 rounded-lg border border-light-100 px-2 py-1 text-[11px] dark:border-dark-750"
                >
                  <span className="font-semibold">{i + 1}</span>
                  <span className="max-w-[9rem] truncate">{clip.label}</span>
                  <button
                    type="button"
                    aria-label="Move earlier"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move later"
                    disabled={i === picked.length - 1}
                    onClick={() => move(i, 1)}
                    className="disabled:opacity-30"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => toggle(clip)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        <Segmented
          label="Between clips"
          value={transition}
          options={STITCH_TRANSITIONS.map((t) => ({
            id: t.id,
            label: t.label,
          }))}
          onChange={(v) => setTransition(v as StitchTransition)}
        />
        {transition === "fade" && (
          <Segmented
            label="Crossfade length"
            value={fade}
            options={STITCH_FADE_LENGTHS.map((f) => ({
              id: f.id,
              label: f.label,
            }))}
            onChange={setFade}
          />
        )}
        <Segmented
          label="Frame rate"
          value={fps}
          options={STITCH_FPS_OPTIONS.map((f) => ({
            id: f.id,
            label: f.label,
          }))}
          onChange={setFps}
        />
        <Segmented
          label="Different shapes"
          value={fit}
          options={STITCH_FIT_OPTIONS}
          onChange={(v) => setFit(v as StitchFit)}
        />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={audio}
            onChange={(e) => setAudio(e.target.checked)}
          />
          Keep sound (every clip must have a sound track)
        </label>
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Clips are resized to the first clip&apos;s frame: Fill trims the
          edges, Fit adds black bars. A crossfade overlaps
          the clips, so the result is a little shorter than the sum.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-start gap-2">
        <RunFooter
          label="Stitch clips"
          busy={busy}
          disabled={!card.available}
          validation={validation}
          error={error}
          queuedText={null}
          onRun={() => void go()}
          icon={<Clapperboard className="h-4 w-4" />}
        />
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
            className="flex items-center gap-1.5 rounded-xl border border-light-100 px-4 py-2.5 text-sm dark:border-dark-750"
          >
            <Square className="h-3.5 w-3.5" /> Stop waiting
          </button>
        )}
      </div>

      {result && (
        <section className="space-y-3" data-testid="stitch-result">
          <video
            src={result.video.url}
            controls
            playsInline
            className="mx-auto max-h-[70vh] rounded-xl"
            data-testid="stitch-video"
          />
        </section>
      )}
    </RunnerShell>
  );
}
