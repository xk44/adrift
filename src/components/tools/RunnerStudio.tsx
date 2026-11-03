"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Clock, Loader2, Search, X, ZoomIn } from "lucide-react";
import { createWithEqualityFn } from "zustand/traditional";
import { useGenerationStore, useUIStore } from "@/store";
import { showToast, toastNodeWarnings } from "@/components/Toast";
import type { ImagineRun } from "@/types";
import type { ActionChoice } from "@/lib/tools/toolsPage";
import {
  CHOICE_SEARCH_MIN,
  chipLabel,
  choiceGroups,
  filterChoiceGroups,
} from "@/lib/tools/choiceGroups";
import {
  PRESET_GRID_SCROLL_MIN,
  mergeRecentIds,
  newRunIds,
  presetThumb,
  resolveRecentRuns,
  runHintLine,
  runPhase,
  runThumb,
  type RunOutput,
} from "@/lib/tools/runnerStudio";
import { toolRunMedia, type RunMediaItem } from "@/lib/tools/runMedia";
import { UPSCALE_ACTIONS } from "@/lib/upscale/upscaleModels";
import {
  upscaleResultAction,
  upscaleResultRequest,
} from "@/lib/upscale/upscaleResult";
import { fetchRunImages } from "@/lib/sourceRun";
import { classifyJobError } from "@/lib/comfy/runFailure";
import { meshDownloads } from "@/lib/galleryMedia";
import { BlenderExportActions } from "@/components/BlenderExportActions";
import { blenderSourceFor } from "@/lib/mesh/blenderLinks";
import { manifestPathFromTexts } from "@/lib/layers/seeThrough";
import { RunFailureNotice } from "./RunFailureNotice";
import { SeeThroughResult } from "./SeeThroughResult";
import type { SetupCardRef } from "./SetupDrawer";
import { ToolCover, useRunnerCard } from "./ToolCover";
import { resolveToolPreview } from "@/lib/tools/toolPreviews";
import { previewKey } from "@/lib/tools/ltxShowcase";

// Recent runs per tool (this browser session)

interface RecentRunsState {
  byCard: Record<string, string[]>;
  note: (cardKey: string, ids: readonly string[]) => void;
}

/**
 * Run ids each tool queued in this session, newest first. A tiny store so
 * the strip survives closing and reopening the runner.
 */
export const useRecentRunsStore = createWithEqualityFn<RecentRunsState>()(
  (set) => ({
    byCard: {},
    note: (cardKey, ids) =>
      set((s) => ({
        byCard: {
          ...s.byCard,
          [cardKey]: mergeRecentIds(s.byCard[cardKey] ?? [], ids),
        },
      })),
  }),
);

/**
 * This tool's recent runs. Runs that reach the store while the runner is
 * open count as its own (runners queue through addRun), except runs loaded
 * from the shared server history.
 */
export function useRecentToolRuns(cardKey: string): ImagineRun[] {
  const runs = useGenerationStore((s) => s.runs);
  const ids = useRecentRunsStore((s) => s.byCard[cardKey]);
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!seen.current || seen.current.key !== cardKey) {
      seen.current = { key: cardKey, ids: new Set(runs.map((r) => r.run_id)) };
      return;
    }
    const fresh = newRunIds(seen.current.ids, runs);
    if (!fresh.length) return;
    for (const id of fresh) seen.current.ids.add(id);
    useRecentRunsStore.getState().note(cardKey, fresh);
  }, [runs, cardKey]);
  return useMemo(() => resolveRecentRuns(ids ?? [], runs), [ids, runs]);
}

// Layout

/**
 * Studio frame: header on top, then a controls column (inputs, presets,
 * engine, advanced, Generate) beside a large sticky preview stage with the
 * recent-results strip. Below `lg` everything stacks: controls, Generate,
 * preview, strip.
 */
export function RunnerStudio({
  header,
  controls,
  stage,
  testId,
}: {
  header: React.ReactNode;
  controls: React.ReactNode;
  stage: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto" data-testid={testId}>
      <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 sm:px-6 sm:pb-10">
        <div className="space-y-5">{header}</div>
        <div
          className="mt-6 flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-10"
          data-testid="runner-studio"
        >
          <div className="min-w-0 space-y-6" data-testid="runner-controls">
            {controls}
          </div>
          <div
            className="min-w-0 space-y-3 lg:sticky lg:top-5"
            data-testid="runner-stage-column"
          >
            {stage}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Quiet section heading for the controls column. */
export function StudioLabel({
  children,
  htmlFor,
  id,
}: {
  children: React.ReactNode;
  htmlFor?: string;
  id?: string;
}) {
  const cls =
    "text-[13px] font-medium text-light-primary dark:text-dark-primary";
  return htmlFor ? (
    <label htmlFor={htmlFor} id={id} className={cls}>
      {children}
    </label>
  ) : (
    <span id={id} className={cls}>
      {children}
    </span>
  );
}

/** Free + time line next to Generate. */
export function RunHint({
  output,
  fast,
}: {
  output: RunOutput;
  fast?: boolean;
}) {
  return (
    <p
      className="flex items-center gap-1.5 text-[11px] tabular-nums text-light-500 dark:text-dark-400"
      data-testid="run-hint"
    >
      <Clock className="h-3 w-3 flex-shrink-0" aria-hidden />
      {runHintLine(output, fast)}
    </p>
  );
}

// Stage

/**
 * Preview stage: the selected recent run (newest by default) or, before the
 * first run, the tool's own cover / example preview. The strip below picks
 * which run the stage shows.
 */
export function RunnerStage({
  runs,
  failureCard,
  onRetry,
  extra,
  emptyText = "Your result will show here",
  renderResult,
}: {
  runs: ImagineRun[];
  /** Custom view of a run's result, given the default view to fall back on. */
  renderResult?: (
    run: ImagineRun,
    fallback: React.ReactNode,
  ) => React.ReactNode;
  /** Card for "Set up this tool" on a failed run. */
  failureCard?: SetupCardRef | null;
  onRetry?: () => void;
  /** Rendered above the strip (e.g. Describe suggestions). */
  extra?: React.ReactNode;
  emptyText?: string;
}) {
  const card = useRunnerCard();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const newest = runs[0]?.run_id ?? null;
  // A new run takes the stage.
  useEffect(() => setPickedId(null), [newest]);
  const shown = runs.find((r) => r.run_id === pickedId) ?? runs[0] ?? null;
  const result = shown ? (
    <ToolRunResult
      run={shown}
      card={failureCard ?? null}
      onRetry={onRetry}
      bare
    />
  ) : null;
  return (
    <>
      <div
        className="relative overflow-hidden rounded-2xl bg-light-input shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] dark:bg-dark-input dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
        data-testid="runner-stage"
      >
        {shown ? (
          <div className="flex min-h-[16rem] items-center justify-center p-3 sm:min-h-[22rem]">
            <div className="w-full">
              {renderResult ? renderResult(shown, result) : result}
            </div>
          </div>
        ) : (
          <div className="relative flex aspect-[4/3] max-h-[34rem] w-full items-end lg:aspect-[5/4]">
            {card && (
              <ToolCover
                card={card}
                size="lg"
                className="!absolute inset-0 h-full w-full opacity-60"
              />
            )}
            {/* The cover art is a sample, not the viewer's result: say so. */}
            {card &&
              resolveToolPreview(previewKey(card)).kind !== "none" && (
                <span
                  data-testid="runner-stage-example"
                  className="absolute left-3 top-3 rounded-full bg-black/55 px-2 py-[3px] text-[10px] font-medium uppercase leading-none tracking-wide text-white/85 backdrop-blur-md"
                >
                  Example
                </span>
              )}
            <div className="relative w-full bg-gradient-to-t from-black/55 to-transparent px-4 pb-4 pt-10">
              <p className="text-sm font-medium text-white">{emptyText}</p>
              <p className="text-[11px] text-white/75">
                Add your inputs, then Generate.
              </p>
            </div>
          </div>
        )}
      </div>
      {extra}
      {runs.length > 0 && (
        <RecentRunsStrip
          runs={runs}
          selectedId={shown?.run_id ?? null}
          onSelect={setPickedId}
        />
      )}
    </>
  );
}

/** Thumbnails of this tool's recent runs; click puts one on the stage. */
export function RecentRunsStrip({
  runs,
  selectedId,
  onSelect,
}: {
  runs: ImagineRun[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <section className="space-y-2" data-testid="recent-runs">
      <h3 className="text-[11px] font-medium text-light-500 dark:text-dark-400">
        Recent
      </h3>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {runs.map((r, i) => {
          const thumb = runThumb(r);
          const phase = runPhase(r);
          const on = r.run_id === selectedId;
          return (
            <button
              key={r.run_id}
              type="button"
              onClick={() => onSelect(r.run_id)}
              aria-pressed={on}
              aria-label={`Show result ${i + 1}${phase === "working" ? " (working)" : phase === "error" ? " (failed)" : ""}`}
              className={`relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-light-input transition-[box-shadow,transform] duration-150 active:scale-[0.96] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:bg-dark-input ${
                on
                  ? "shadow-[0_0_0_2px_rgb(var(--c-splash))]"
                  : "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
              }`}
            >
              {thumb?.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb.url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : thumb?.kind === "video" ? (
                <video
                  src={thumb.url}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-light-500 dark:text-dark-400">
                  {phase === "working" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : phase === "error" ? (
                    <X className="h-4 w-4" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Results

/** Outputs of these actions are already upscaled: no "Upscale result". */
const UPSCALED_ACTIONS = new Set([
  ...UPSCALE_ACTIONS,
  "seedvr2_upscale",
  "upscale_vosr2",
  "flashvsr_upscale",
  "rtx_upscale",
  "ltx_upscale_x2",
]);

/**
 * One click: upscale this output with the user's default upscaler (Faithful
 * for a still, per-frame for a clip). The new run lands in Create.
 */
function UpscaleResultButton({
  run,
  item,
}: {
  run: ImagineRun;
  item: RunMediaItem;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const [busy, setBusy] = useState(false);
  const label = item.kind === "video" ? "Upscale clip" : "Upscale result";
  const queue = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/jobs/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          upscaleResultRequest({
            runId: run.run_id,
            jobIndex: item.jobIndex,
            kind: item.kind,
            clientId,
          }),
        ),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Upscale failed");
      if (data.run) addRun(data.run);
      toastNodeWarnings(data);
      showToast("Upscaling: the result appears in Create.", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Upscale failed", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void queue()}
      disabled={busy}
      data-action={upscaleResultAction(item.kind)}
      title={
        item.kind === "video"
          ? "Upscale this clip 2x with your video upscaler (Settings → Upscaler)"
          : "Faithful upscale with your default upscaler (Settings → Upscaler)"
      }
      className="inline-flex items-center gap-1 text-xs text-splash underline disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ZoomIn className="h-3.5 w-3.5" />
      )}
      {label}
    </button>
  );
}

/**
 * Inline image/video result of a finished tool run. Click opens the lightbox
 * on that output (store gallery first, server history as fallback).
 */
function ToolRunMediaGrid({ run, bare }: { run: ImagineRun; bare?: boolean }) {
  const openLightbox = useUIStore((s) => s.openLightbox);
  const { items, more } = useMemo(() => toolRunMedia(run), [run]);
  const open = useCallback(
    async (jobIndex: number, imageIndex: number) => {
      let images = useGenerationStore
        .getState()
        .gallery.filter((g) => g.runId === run.run_id);
      if (!images.length) {
        try {
          images = await fetchRunImages(run.run_id);
        } catch {
          showToast("Couldn't open the result", "error");
          return;
        }
      }
      if (!images.length) return;
      const ofJob = images.filter((g) => g.jobIndex === jobIndex);
      const target = ofJob[imageIndex] ?? ofJob[0];
      const index = Math.max(0, target ? images.indexOf(target) : 0);
      openLightbox({ images, index, origin: "tools" });
    },
    [openLightbox, run.run_id],
  );
  if (!items.length) return null;
  const single = items.length === 1;
  return (
    <div
      className={
        bare
          ? "space-y-2"
          : "space-y-2 rounded-xl border border-light-100 p-3 dark:border-dark-750"
      }
      data-testid="tool-run-result"
    >
      <div className={single ? "" : "grid grid-cols-2 gap-2 sm:grid-cols-3"}>
        {items.map((m) =>
          m.kind === "video" ? (
            <video
              key={m.url}
              src={m.url}
              className="max-h-[32rem] w-full rounded-lg bg-black object-contain"
              controls
              autoPlay
              muted
              loop
              playsInline
            />
          ) : (
            <button
              key={m.url}
              type="button"
              onClick={() => void open(m.jobIndex, m.imageIndex)}
              className="block w-full overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
              title="Open in lightbox"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.url}
                alt="Tool result"
                className={
                  single
                    ? "max-h-[32rem] w-full object-contain"
                    : "aspect-square w-full object-cover"
                }
              />
            </button>
          ),
        )}
      </div>
      {more > 0 && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          +{more} more in Create
        </p>
      )}
      {single && !UPSCALED_ACTIONS.has(run.action ?? "") && (
        <UpscaleResultButton run={run} item={items[0]} />
      )}
    </div>
  );
}

/** Result of one run: progress, failure, media, audio player, 3D preview. */
export function ToolRunResult({
  run,
  card,
  onRetry,
  bare,
}: {
  run: ImagineRun;
  card: SetupCardRef | null;
  onRetry?: () => void;
  /** No frame (the stage draws its own). */
  bare?: boolean;
}) {
  const job = run.jobs[0];
  if (!job) return null;
  const audio = job.audios?.[0];
  const mesh = job.meshes?.[0];
  const image = job.images?.[0];
  const clip = job.videos?.[0];
  if (job.status === "error") {
    return (
      <RunFailureNotice
        failure={classifyJobError(job.error)}
        card={card}
        onRetry={onRetry}
      />
    );
  }
  if (job.status === "cancelled") {
    return (
      <p className="text-xs text-light-500 dark:text-dark-400">
        Cancelled.
        {onRetry && (
          <>
            {" "}
            <button
              type="button"
              className="text-splash underline"
              onClick={onRetry}
            >
              Run again
            </button>
          </>
        )}
      </p>
    );
  }
  if (job.status !== "done") {
    return (
      <p
        className="flex items-center justify-center gap-1.5 py-10 text-xs tabular-nums text-light-500 dark:text-dark-400"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {`Working... ${Math.round(job.progress ?? 0)}%`}
      </p>
    );
  }
  const texts = job.texts ?? [];
  if (manifestPathFromTexts(texts)) {
    // Layer Split: the only text is the layers.json path; show the layer viewer.
    return (
      <div
        className={
          bare
            ? ""
            : "rounded-xl border border-light-100 p-3 dark:border-dark-750"
        }
      >
        <SeeThroughResult
          run={run}
          fallback={<ToolRunMediaGrid run={run} bare />}
        />
      </div>
    );
  }
  if (!audio && !mesh && !texts.length)
    return <ToolRunMediaGrid run={run} bare={bare} />;
  return (
    <div
      className={
        bare
          ? "space-y-2"
          : "space-y-2 rounded-xl border border-light-100 p-3 dark:border-dark-750"
      }
      data-testid="tool-run-result"
    >
      {audio && (
        <audio controls src={audio} className="w-full" preload="metadata" />
      )}
      {mesh && clip ? (
        // Rendered preview clip (splat turntable / body overlay).
        <video
          src={clip}
          controls
          autoPlay
          loop
          muted
          playsInline
          className="mx-auto max-h-80 rounded-lg"
        />
      ) : (job.images?.length ?? 0) > 1 || (!mesh && !audio) ? (
        // Several maps (depth / normals) beside the mesh, or media + text.
        <ToolRunMediaGrid run={run} bare />
      ) : (
        mesh &&
        image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt="3D model preview"
            className="mx-auto max-h-80 rounded-lg object-contain"
          />
        )
      )}
      {texts.map((t, i) => (
        <p
          key={i}
          className="text-xs text-light-600 dark:text-dark-300"
          data-testid="tool-run-text"
        >
          {t}
        </p>
      ))}
      {mesh && (
        <div className="flex flex-wrap gap-3">
          {meshDownloads(job.meshes).map((d) => (
            <a
              key={d.href}
              href={d.href}
              download
              className="text-xs text-splash underline"
            >
              {d.label}
            </a>
          ))}
          <BlenderExportActions
            source={blenderSourceFor({
              meshUrls: job.meshes,
              texts,
              action: run.action ?? "",
              width: run.width,
              height: run.height,
            })}
            className="inline-flex items-center gap-1 text-xs text-splash underline disabled:opacity-60"
          />
        </div>
      )}
    </div>
  );
}

// Preset grid

/**
 * Named presets as a visual tile grid (looks, light setups, camera moves,
 * motion effects). Tiles carry a stable procedural thumbnail, or `thumb`'s
 * art (palette swatches) when given. Single pick = radio group; `multi`
 * = toggle buttons (aria-pressed).
 */
export function PresetGrid({
  label,
  pickerKey,
  options,
  value,
  onChange,
  selected,
  onToggle,
  disabled,
  thumb,
}: {
  label: string;
  pickerKey: string;
  options: readonly ActionChoice[];
  value?: string;
  onChange?: (id: string) => void;
  /** Multi-pick values (with onToggle). */
  selected?: readonly string[];
  onToggle?: (id: string) => void;
  disabled?: boolean;
  /** Custom tile art (e.g. palette swatches); null = procedural. */
  thumb?: (id: string) => React.ReactNode | null;
}) {
  const multi = Boolean(onToggle);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => choiceGroups([...options]), [options]);
  const shown = useMemo(
    () => filterChoiceGroups(groups, query),
    [groups, query],
  );
  const searchable =
    options.length >= Math.max(CHOICE_SEARCH_MIN, PRESET_GRID_SCROLL_MIN);
  const current = multi ? null : (options.find((o) => o.id === value) ?? null);
  const labelId = useId();
  const scroller = useRef<HTMLDivElement>(null);

  // Long lists: bring the current pick into view once.
  useEffect(() => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(
      '[aria-checked="true"],[aria-pressed="true"]',
    );
    if (el && box) {
      const top = el.offsetTop - box.offsetTop;
      if (top > box.clientHeight - 60) box.scrollTop = top - 60;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2" data-testid={`preset-grid-${pickerKey}`}>
      <div className="flex items-baseline justify-between gap-3">
        <StudioLabel id={labelId}>{label}</StudioLabel>
        {current && (
          <span className="truncate text-[11px] text-light-500 dark:text-dark-400">
            {current.label}
          </span>
        )}
        {multi && selected && (
          <span className="text-[11px] tabular-nums text-light-500 dark:text-dark-400">
            {selected.length} picked
          </span>
        )}
      </div>
      {searchable && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-500 dark:text-dark-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder={`Search ${options.length} presets`}
            aria-label={`Search ${label}`}
            className="h-9 w-full rounded-lg bg-light-input pl-8 pr-9 text-sm text-light-primary placeholder:text-light-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-2 focus:ring-splash dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-400 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        ref={scroller}
        role={multi ? "group" : "radiogroup"}
        aria-labelledby={labelId}
        className={`space-y-3 ${
          searchable
            ? "max-h-[22rem] overflow-y-auto overscroll-contain pr-0.5"
            : ""
        }`}
      >
        {shown.length === 0 && (
          <p className="py-4 text-center text-xs text-light-500 dark:text-dark-400">
            Nothing matches &ldquo;{query}&rdquo;
          </p>
        )}
        {shown.map((g, gi) => (
          <div key={`${g.group}-${gi}`} className="space-y-1.5">
            {g.group && (
              <p className="text-[10px] font-medium text-light-500 dark:text-dark-400">
                {g.group}
              </p>
            )}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
              {g.options.map((o) => {
                const on = multi
                  ? Boolean(selected?.includes(o.id))
                  : o.id === value;
                const art = thumb?.(o.id) ?? null;
                const pt = art ? null : presetThumb(pickerKey, o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    {...(multi
                      ? { "aria-pressed": on }
                      : { role: "radio", "aria-checked": on })}
                    title={o.hint ?? o.label}
                    disabled={disabled || o.disabled}
                    onClick={() =>
                      multi ? onToggle?.(o.id) : onChange?.(o.id)
                    }
                    className="group min-w-0 space-y-1 text-left focus:outline-none disabled:opacity-40"
                  >
                    <span
                      className={`relative block aspect-[4/3] overflow-hidden rounded-lg transition-[box-shadow,transform] duration-150 group-active:scale-[0.97] group-focus-visible:ring-2 group-focus-visible:ring-splash ${
                        on
                          ? "shadow-[0_0_0_2px_rgb(var(--c-splash))]"
                          : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] group-hover:brightness-110"
                      }`}
                      style={pt ? { background: pt.background } : undefined}
                      aria-hidden
                    >
                      {pt && (
                        <span
                          className="absolute inset-0 opacity-[0.18]"
                          style={pt.pattern}
                        />
                      )}
                      {art}
                      {on && (
                        <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-splash text-white">
                          <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span
                      className={`line-clamp-2 block text-[11px] leading-tight ${
                        on
                          ? "font-medium text-light-primary dark:text-dark-primary"
                          : "text-light-500 group-hover:text-light-primary dark:text-dark-400 dark:group-hover:text-dark-primary"
                      }`}
                    >
                      {chipLabel(o.label, g.group)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
