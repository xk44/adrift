"use client";

/**
 * Video editor side panels: Tools (run a hub video tool on the range),
 * Select (smart selection picks), Export (mp4 / frame to the gallery) and
 * Results (tool clips to compare, replace the range with, or discard).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clapperboard,
  Columns2,
  Crosshair,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Plus,
  Replace,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { OpenToolRow, loadToolCatalog } from "@/components/LightboxToolsPanel";
import { showToast } from "@/components/Toast";
import { useGenerationStore } from "@/store";
import {
  activeRange,
  playheadFps,
  useVideoEditStore,
  type TimeRange,
  type VideoResult,
} from "@/store/videoEditStore";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import {
  clipFromSource,
  clipLength,
  formatTimecode,
  replaceRange,
  timelineDuration,
  type EditList,
  type VideoSource,
} from "@/lib/videoEdit/editList";
import {
  buildVideoEditorTools,
  filterVideoEditorTools,
  groupVideoEditorTools,
  rangeWarning,
  videoToolNote,
  type VideoEditorTool,
} from "@/lib/videoEdit/videoTools";
import {
  ltxEffectLimit,
  ltxEffectTitle,
  ltxEffectTools,
} from "@/lib/videoEdit/ltxEffects";
import {
  conformResult,
  renderEdit,
  type RenderResultDto,
} from "@/lib/videoEdit/client";
import { conformPlan, type ConformPlan } from "@/lib/videoEdit/conform";
import { ExportSettingsBox } from "./VideoClipPanel";
import { MAX_RANGE_SECONDS } from "@/lib/videoEdit/requests";
import { FORMAT_NOTE, FORMAT_SHORT } from "@/lib/videoEdit/exportPresets";
import { RETAKE_TOOL_KEY, retakePlan } from "@/lib/videoEdit/retake";
import { sendRangeToRetake, sendRangeToTool } from "./sendToTool";
import {
  recentRunToImagineRun,
  runGalleryImages,
} from "@/lib/historyHydration";

const fmt = (t: number) => formatTimecode(t, 0);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function rangeLabel(r: TimeRange): string {
  const what =
    r.source === "marks"
      ? "In / out"
      : r.source === "clip"
        ? "Selected clip"
        : "Whole video";
  return `${what}: ${fmt(r.start)} - ${fmt(r.end)} (${(r.end - r.start).toFixed(1)} s)`;
}

function useRange(): TimeRange {
  const edit = useVideoEditStore((s) => s.edit) as EditList;
  const inPoint = useVideoEditStore((s) => s.inPoint);
  const outPoint = useVideoEditStore((s) => s.outPoint);
  const selectedClipId = useVideoEditStore((s) => s.selectedClipId);
  return useMemo(
    () => activeRange(edit, inPoint, outPoint, selectedClipId),
    [edit, inPoint, outPoint, selectedClipId],
  );
}

function RangeBox({ range }: { range: TimeRange }) {
  return (
    <p className="rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-secondary)]">
      <span className="font-medium text-[var(--text-primary)]">
        {rangeLabel(range)}
      </span>
      {range.source === "all" && (
        <span className="mt-0.5 block text-[var(--text-muted)]">
          Set in / out (I and O) or select a clip to work on part of it.
        </span>
      )}
    </p>
  );
}

// Tools

export function VideoToolsPanel() {
  const range = useRange();
  const picks = useVideoEditStore((s) => s.picks);
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadToolCatalog().then((c) => {
      if (live) setCatalog(c);
    });
    return () => {
      live = false;
    };
  }, []);

  const tools = useMemo(() => buildVideoEditorTools(catalog), [catalog]);
  const groups = useMemo(
    () => groupVideoEditorTools(filterVideoEditorTools(tools, query)),
    [tools, query],
  );
  const seconds = range.end - range.start;
  const fps = useVideoEditStore((s) =>
    s.edit ? playheadFps(s.edit, range.start) : 24,
  );
  const tooLong = seconds > MAX_RANGE_SECONDS;
  const duration = useVideoEditStore((s) =>
    s.edit ? timelineDuration(s.edit) : 0,
  );
  const retake = retakePlan(range, duration, fps);

  const openRetake = async () => {
    if (busy) return;
    if (!retake.ok) {
      showToast(retake.reason, "info", 6000);
      return;
    }
    setBusy(RETAKE_TOOL_KEY);
    try {
      await sendRangeToRetake(range);
    } finally {
      setBusy(null);
    }
  };

  const open = async (tool: VideoEditorTool) => {
    if (tool.key === RETAKE_TOOL_KEY) return openRetake();
    if (busy || tooLong) return;
    setBusy(tool.key);
    try {
      await sendRangeToTool(tool, range);
    } finally {
      setBusy(null);
    }
  };

  const maskCount = picks.filter((k) => k.positive.length > 0).length;
  const effects = useMemo(() => ltxEffectTools(tools), [tools]);
  const effectWarnings = effects
    .map((e) => ltxEffectLimit(e, seconds, fps).warning)
    .filter((w): w is string => Boolean(w));

  return (
    <div
      className="flex min-h-0 flex-col gap-2"
      data-testid="video-tools-panel"
    >
      <RangeBox range={range} />
      {tooLong && (
        <p role="alert" className="text-xs text-amber-500">
          Tools take at most {MAX_RANGE_SECONDS} s. Mark a shorter range with I
          and O.
        </p>
      )}
      <section
        aria-labelledby="video-retake-title"
        className="rounded-lg border border-[var(--border-secondary)] p-2"
        data-testid="video-retake"
      >
        <div className="flex items-center gap-2">
          <h3
            id="video-retake-title"
            className="flex flex-1 items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]"
          >
            <Clapperboard className="h-3.5 w-3.5 text-splash" aria-hidden />
            Retake (LTX)
          </h3>
          <button
            type="button"
            disabled={Boolean(busy) || !retake.ok}
            title={
              retake.ok
                ? `Regenerate ${rangeLabel(range)}; the rest stays as it is`
                : retake.reason
            }
            onClick={() => void openRetake()}
            className="h-8 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            data-testid="video-retake-open"
          >
            {busy === RETAKE_TOOL_KEY ? "Cutting..." : "Retake"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          {retake.ok
            ? "Regenerates only the marked range from a new prompt; frames outside it stay the source frames."
            : retake.reason}
        </p>
      </section>
      {effects.length > 0 && (
        <section
          id="video-ltx-effects"
          tabIndex={-1}
          aria-labelledby="video-ltx-effects-title"
          className="rounded-lg border border-[var(--border-secondary)] p-2 outline-none focus-visible:ring-2 focus-visible:ring-splash"
          data-testid="video-ltx-effects"
        >
          <h3
            id="video-ltx-effects-title"
            className="flex items-center gap-1.5 pb-1.5 text-xs font-semibold text-[var(--text-primary)]"
          >
            <Sparkles className="h-3.5 w-3.5 text-splash" aria-hidden />
            Effects (LTX)
          </h3>
          <div
            className={`flex flex-wrap gap-1.5 ${busy || tooLong ? "pointer-events-none opacity-50" : ""}`}
          >
            {effects.map((e) => {
              const lim = ltxEffectLimit(e, seconds, fps);
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={Boolean(busy) || tooLong}
                  title={ltxEffectTitle(e, rangeLabel(range), seconds, fps)}
                  onClick={() => void open(e.tool)}
                  className={`h-8 rounded-lg border px-2.5 text-xs hover:bg-[var(--bg-hover)] ${lim.over ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : "border-[var(--border-secondary)] text-[var(--text-primary)]"}`}
                  data-testid={`ltx-effect-${e.id}`}
                >
                  {e.label}
                  {lim.windowSeconds !== null && (
                    <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                      {Math.round(lim.windowSeconds * 10) / 10} s
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {effectWarnings.length > 0 && (
            <ul
              role="alert"
              className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-amber-600 dark:text-amber-400"
              data-testid="ltx-effect-warnings"
            >
              {effectWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Pick a tool: the range is cut and opened in it. The result comes back
        here to compare and drop into the timeline.
        {maskCount > 0 &&
          ` Tools tagged Mask use your selection (${maskCount} pick${maskCount === 1 ? "" : "s"}).`}
      </p>
      <label className="relative block">
        <span className="sr-only">Search video tools</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tools (relight, upscale, remove...)"
          className="h-9 w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] pl-7 pr-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </label>
      {busy && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Cutting
          the range...
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="py-4 text-center text-xs text-[var(--text-muted)]">
            {catalog === null ? "Loading tools..." : "No video tool matches."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.group} className="mb-2">
            <h3 className="px-2 pb-0.5 pt-1 text-[10px] font-medium text-[var(--text-muted)]">
              {g.group}
            </h3>
            <ul
              className={
                busy || tooLong ? "pointer-events-none opacity-50" : ""
              }
            >
              {(g.tools as VideoEditorTool[]).map((tool) => {
                const warn = rangeWarning(tool, seconds, fps);
                return (
                  <OpenToolRow
                    key={tool.key}
                    tool={tool}
                    note={videoToolNote(tool, fps) || undefined}
                    openTitle={[
                      `Run ${tool.title} on ${rangeLabel(range)}`,
                      tool.hint,
                      warn,
                      tool.smartSelect && maskCount === 0
                        ? "Uses a smart selection: add one in Select, or pick in the tool."
                        : null,
                    ]
                      .filter(Boolean)
                      .join(". ")}
                    onOpenTool={() => void open(tool)}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// Select

export function VideoSelectPanel() {
  const picks = useVideoEditStore((s) => s.picks);
  const selecting = useVideoEditStore((s) => s.selecting);
  const s = useVideoEditStore.getState;
  return (
    <div className="flex flex-col gap-2" data-testid="video-select-panel">
      <p className="text-xs text-[var(--text-muted)]">
        Click the subject on the picture to select it; mask tools (remove, swap,
        relight a person) follow it across frames and only change that area.
        Scrub to where it looks different and click again to help tracking. Alt
        or Shift click marks what to leave out.
      </p>
      <button
        type="button"
        aria-pressed={selecting}
        onClick={() => s().setSelecting(!selecting)}
        className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors ${
          selecting
            ? "bg-[var(--accent-primary)] text-white"
            : "border border-[var(--border-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        }`}
      >
        <Crosshair className="h-4 w-4" aria-hidden />
        {selecting ? "Done selecting" : "Select a subject"}
      </button>
      {picks.length > 0 ? (
        <>
          <ul className="flex flex-col gap-1" aria-label="Selection picks">
            {picks.map((k, i) => (
              <li
                key={`${k.t}-${i}`}
                className="flex items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2 py-1.5 text-xs"
              >
                <button
                  type="button"
                  className="flex-1 text-left font-mono text-[var(--text-primary)] hover:underline"
                  onClick={() => {
                    s().setRate(0);
                    s().seek(k.t);
                  }}
                  aria-label={`Go to pick ${i + 1} at ${fmt(k.t)}`}
                >
                  {fmt(k.t)}
                </button>
                <span className="text-[var(--text-muted)]">
                  {k.positive.length} in
                  {k.negative.length ? ` / ${k.negative.length} out` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove pick ${i + 1}`}
                  onClick={() => s().setPicks(picks.filter((_, j) => j !== i))}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => s().setPicks([])}
            className="self-start text-xs text-[var(--text-muted)] underline"
          >
            Clear selection
          </button>
        </>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          No subject picked yet.
        </p>
      )}
    </div>
  );
}

// Export

/** Put a saved export into the gallery (video entries need videoUrl). */
export function addExportToGallery(result: RenderResultDto): void {
  if (!result.run) return;
  const gen = useGenerationStore.getState();
  gen.addRun(recentRunToImagineRun(result.run));
  gen.addToGallery(
    runGalleryImages(result.run).map((g) =>
      result.kind === "video" ? { ...g, videoUrl: g.url } : g,
    ),
  );
}

export function VideoExportPanel() {
  const range = useRange();
  const label = useVideoEditStore((s) => s.label);
  const exportFormat = useVideoEditStore((s) => s.exportSettings.format);
  const [busy, setBusy] = useState<"mp4" | "range" | "frame" | null>(null);
  const [last, setLast] = useState<RenderResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: "mp4" | "range" | "frame") => {
    const s = useVideoEditStore.getState();
    if (!s.edit || busy) return;
    s.setRate(0);
    setBusy(what);
    setError(null);
    const output = s.exportSettings;
    try {
      const result = await renderEdit(
        what === "frame"
          ? { mode: "frame", edit: s.edit, t: s.playhead, save: true, label }
          : what === "range"
            ? {
                mode: "mp4",
                edit: s.edit,
                start: range.start,
                end: range.end,
                save: true,
                label,
                output,
              }
            : { mode: "mp4", edit: s.edit, save: true, label, output },
      );
      setLast(result);
      addExportToGallery(result);
      // A full export saves the project's work, unless it changed meanwhile.
      if (
        what === "mp4" &&
        !result.saveError &&
        useVideoEditStore.getState().edit === s.edit
      )
        useVideoEditStore.getState().markSaved();
      if (result.saveError)
        showToast(
          `Exported, but not added to the gallery: ${result.saveError}`,
          "error",
          8000,
        );
      else
        showToast(
          result.kind === "video"
            ? "Video exported to the gallery."
            : "Frame saved to the gallery.",
          "success",
        );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const partial = range.source !== "all";
  const btn =
    "flex h-10 w-full items-center gap-2 rounded-lg border border-[var(--border-secondary)] px-3 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2" data-testid="video-export-panel">
      <ExportSettingsBox />
      <button
        type="button"
        className={btn}
        disabled={!!busy}
        onClick={() => void run("mp4")}
      >
        {busy === "mp4" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Film className="h-4 w-4" aria-hidden />
        )}
        <span className="flex-1">
          Export video ({FORMAT_SHORT[exportFormat]})
        </span>
      </button>
      {partial && (
        <button
          type="button"
          className={btn}
          disabled={!!busy}
          onClick={() => void run("range")}
        >
          {busy === "range" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Film className="h-4 w-4" aria-hidden />
          )}
          <span className="flex-1">
            Export {range.source === "marks" ? "in / out" : "selected clip"}{" "}
            only
            <span className="block text-xs text-[var(--text-muted)]">
              {rangeLabel(range).split(": ")[1]}
            </span>
          </span>
        </button>
      )}
      <button
        type="button"
        className={btn}
        disabled={!!busy}
        onClick={() => void run("frame")}
      >
        {busy === "frame" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <ImageIcon className="h-4 w-4" aria-hidden />
        )}
        <span className="flex-1">Save frame at playhead (PNG)</span>
      </button>
      <p className="text-xs text-[var(--text-muted)]">
        {FORMAT_NOTE[exportFormat]} with each clip&apos;s speed, volume and
        fades. Exports land in the gallery like any other output.
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          Export failed: {error}
        </p>
      )}
      {last && (
        <a
          href={last.url}
          download
          className="flex items-center gap-1.5 text-xs text-[var(--accent-primary)] underline"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Download the last{" "}
          {last.kind === "video"
            ? `video (${last.duration.toFixed(1)} s)`
            : "frame"}
        </a>
      )}
    </div>
  );
}

// Results

/** Swap the range a result was made from for the result clip (undoable). */
export function acceptResult(
  r: VideoResult,
  source: VideoSource | null = r.source,
): boolean {
  const s = useVideoEditStore.getState();
  if (!s.edit || !source) return false;
  const total = timelineDuration(s.edit);
  if (r.start >= total) return false;
  const clip = { ...clipFromSource(source, r.title), madeBy: r.title };
  s.apply((e) => replaceRange(e, r.start, Math.min(r.end, total), clip));
  s.selectClip(clip.id);
  s.setRate(0);
  s.seek(r.start);
  s.setCompare(null);
  s.removeResult(r.id);
  return true;
}

export function appendResult(
  r: VideoResult,
  source: VideoSource | null = r.source,
): void {
  const s = useVideoEditStore.getState();
  if (!source) return;
  s.appendSource(source, r.title);
  s.setCompare(null);
  s.removeResult(r.id);
}

/** Conform choices for a result: the user's, else the plan's defaults. */
export function resultConform(
  edit: EditList | null,
  r: VideoResult,
): {
  plan: ConformPlan | null;
  keepAudio: boolean;
  matchFps: number | null;
} {
  const base =
    edit && r.source ? conformPlan(edit, r.start, r.end, r.source) : null;
  if (!base) return { plan: null, keepAudio: false, matchFps: null };
  // An insert (bridge) replaces nothing, so there is no cut to take sound from.
  const plan =
    !r.cutUrl || r.end - r.start < 0.01
      ? { ...base, rangeHasAudio: false, keepAudio: false }
      : base;
  const keepAudio = plan.rangeHasAudio && (r.keepAudio ?? plan.keepAudio);
  const match = plan.fpsDiffers && (r.matchFps ?? plan.matchFps);
  return { plan, keepAudio, matchFps: match ? plan.editFps : null };
}

/**
 * Put a result on the timeline (replacing its range, or at the end), first
 * giving it the range's original sound and / or the edit's frame rate when
 * that is asked for (a server conform). False when it could not be placed.
 */
export async function placeResult(
  r: VideoResult,
  how: "replace" | "append",
): Promise<boolean> {
  if (!r.source) return false;
  const { keepAudio, matchFps } = resultConform(
    useVideoEditStore.getState().edit,
    r,
  );
  let source: VideoSource = r.source;
  try {
    if (keepAudio || matchFps)
      source = await conformResult({
        video: r.source.url,
        ...(keepAudio ? { audio: r.cutUrl } : {}),
        ...(matchFps ? { fps: matchFps } : {}),
      });
  } catch (e) {
    showToast(`Could not prepare the result: ${errMsg(e)}`, "error", 8000);
    return false;
  }
  if (how === "append") {
    appendResult(r, source);
    return true;
  }
  if (acceptResult(r, source)) return true;
  showToast("That range is no longer in the timeline.", "error");
  return false;
}

export function VideoResultsPanel() {
  const results = useVideoEditStore((s) => s.results);
  const toolRuns = useVideoEditStore((s) => s.toolRuns);
  const compareId = useVideoEditStore((s) => s.compareId);
  const s = useVideoEditStore.getState;
  return (
    <div className="flex flex-col gap-2" data-testid="video-results-panel">
      {toolRuns.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Running tools">
          {toolRuns.map((r) => (
            <li
              key={r.runId}
              className="flex items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2 py-1.5 text-xs"
            >
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-muted)]"
                aria-hidden
              />
              <span className="flex-1 truncate text-[var(--text-primary)]">
                {r.title}{" "}
                <span className="text-[var(--text-muted)]">
                  {fmt(r.start)}-{fmt(r.end)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => s().untrackToolRun(r.runId)}
                className="text-[var(--text-muted)] underline"
                aria-label={`Stop waiting for ${r.title}`}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length === 0 && toolRuns.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          Tool results show up here. Run a tool from the Tools tab.
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Tool results">
        {results.map((r) => (
          <li
            key={r.id}
            className={`rounded-lg border p-2 ${r.id === compareId ? "border-[var(--accent-primary)]" : "border-[var(--border-secondary)]"}`}
          >
            <div className="flex items-start gap-2">
              {r.kind === "video" ? (
                <video
                  src={r.url}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-12 w-20 shrink-0 rounded bg-black object-contain"
                  aria-hidden
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.url}
                  alt=""
                  className="h-12 w-20 shrink-0 rounded bg-black object-contain"
                />
              )}
              <div className="min-w-0 flex-1 text-xs">
                <p className="truncate font-medium text-[var(--text-primary)]">
                  {r.title}
                </p>
                <p className="text-[var(--text-muted)]">
                  from {fmt(r.start)}-{fmt(r.end)}
                  {r.source
                    ? ` · ${clipLength({ in: 0, out: r.source.duration }).toFixed(1)} s`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Discard ${r.title} result`}
                onClick={() => s().removeResult(r.id)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {r.kind === "video" ? (
              <ResultActions result={r} comparing={r.id === compareId} />
            ) : (
              <p className="mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <Check className="h-3 w-3" aria-hidden /> Still image: saved in
                the gallery.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultActions({
  result: r,
  comparing,
}: {
  result: VideoResult;
  comparing: boolean;
}) {
  const edit = useVideoEditStore((s) => s.edit) as EditList | null;
  const { plan, keepAudio, matchFps } = useMemo(
    () => resultConform(edit, r),
    [edit, r],
  );
  const [busy, setBusy] = useState<"replace" | "append" | null>(null);
  const s = useVideoEditStore.getState;
  const insert = r.end - r.start < 0.01;

  const place = async (how: "replace" | "append") => {
    if (busy) return;
    setBusy(how);
    try {
      await placeResult(r, how);
    } finally {
      setBusy(null);
    }
  };

  const check =
    "flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]";
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {plan && (plan.rangeHasAudio || plan.fpsDiffers) && (
        <div className="flex flex-col gap-1" data-testid="video-result-conform">
          {plan.rangeHasAudio && (
            <label className={check}>
              <input
                type="checkbox"
                checked={keepAudio}
                onChange={(e) =>
                  s().setResultOptions(r.id, { keepAudio: e.target.checked })
                }
                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
              />
              Keep the original sound
              {r.source?.hasAudio && (
                <span className="text-[var(--text-muted)]">
                  (replaces the tool&apos;s)
                </span>
              )}
            </label>
          )}
          {plan.fpsDiffers && r.source && (
            <label className={check}>
              <input
                type="checkbox"
                checked={matchFps !== null}
                onChange={(e) =>
                  s().setResultOptions(r.id, { matchFps: e.target.checked })
                }
                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
              />
              Match the edit&apos;s {Math.round(plan.editFps * 100) / 100} fps
              <span className="text-[var(--text-muted)]">
                (result is {Math.round(r.source.fps * 100) / 100})
              </span>
            </label>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {!insert && (
          <button
            type="button"
            aria-pressed={comparing}
            onClick={() => s().setCompare(comparing ? null : r.id)}
            className="flex h-8 items-center gap-1 rounded-md border border-[var(--border-secondary)] px-2 text-xs hover:bg-[var(--bg-hover)]"
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden />{" "}
            {comparing ? "Hide compare" : "Compare"}
          </button>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void place("replace")}
          className="flex h-8 items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2 text-xs text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy === "replace" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Replace className="h-3.5 w-3.5" aria-hidden />
          )}{" "}
          {insert ? "Insert at cut" : "Replace range"}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void place("append")}
          className="flex h-8 items-center gap-1 rounded-md border border-[var(--border-secondary)] px-2 text-xs hover:bg-[var(--bg-hover)] disabled:opacity-60"
        >
          {busy === "append" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}{" "}
          Add to end
        </button>
      </div>
    </div>
  );
}
