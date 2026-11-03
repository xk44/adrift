"use client";

/**
 * NevoMenu — the drop-down for NEvo (Neural Evolution) mode.
 *
 * Opened by the NEvo button next to the prompt bar (NOT the settings panel).
 * Expands downward. Contains the mode toggle + all NEvo controls, each with a
 * plain-English one-liner so it's usable without reading the paper.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Loader2, Sparkles, StopCircle, X } from "lucide-react";
import {
  useNevoStore,
  type NevoDevice,
  type NevoMode,
  type NevoObjective,
} from "@/store/nevoStore";
import { MJSlider } from "@/components/settings/MJSlider";
import { PillToggle } from "@/components/settings/PillToggle";

// Plain-English meaning of each brain region, for the ROI picker.
const ROI_MEANING: Record<string, string> = {
  FFA: "Faces — evolves images full of faces",
  PPA: "Places & scenes — rooms, landscapes, buildings",
  MT: "Motion — strong movement (best with video)",
  EBA: "Bodies — human/animal bodies & limbs",
  LOC: "Objects — clear, whole objects",
  RSC: "Navigation & places — large-scale scenes",
  pSTS: "Social motion — people interacting, moving (video)",
  aSTS: "Social — faces & social cues",
  V1: "Basic vision — edges, textures, high detail",
  V2: "Early vision — textures & patterns",
  V3: "Mid vision — shapes & contours",
  V4: "Color & form — vivid color and curvature",
};

const OBJECTIVE_HELP: Partial<Record<NevoObjective, string>> = {
  brain:
    "Evolve images/videos that most strongly “light up” a chosen brain region (the published NEvo objective).",
};

/** Objectives the search loop runs today; others the backend lists stay hidden. */
const WIRED_OBJECTIVES: readonly NevoObjective[] = ["brain"];

const DEVICE_HELP: Record<NevoDevice, string> = {
  auto: "Pick the best available automatically.",
  cuda: "NVIDIA GPU. Fastest.",
  mps: "Apple Silicon GPU. Slower, lighter models.",
  cpu: "No GPU. Very slow — testing only.",
};

const MODE_HELP: Record<NevoMode, string> = {
  t2i: "Image only — evolve a single still image. Faster.",
  t2v: "Image → video — evolve a still, then add motion. Slower.",
};

/** One-line intro; the rest sits behind "Learn more". */
export const NEVO_INTRO_SHORT =
  "Searches many candidates and keeps the best fit for your goal.";
export const NEVO_INTRO_MORE =
  "Instead of making one image from your prompt, NEvo generates many candidates, scores each against the goal you pick below, and evolves the best ones. It takes longer than a normal run.";

function Help({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-xs leading-snug text-[var(--text-muted)]">
      {children}
    </p>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-[var(--text-primary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

export function NevoMenu() {
  const menuOpen = useNevoStore((s) => s.menuOpen);
  const setMenuOpen = useNevoStore((s) => s.setMenuOpen);
  const enabled = useNevoStore((s) => s.enabled);
  const setEnabled = useNevoStore((s) => s.setEnabled);
  const config = useNevoStore((s) => s.config);
  const setConfig = useNevoStore((s) => s.setConfig);
  const options = useNevoStore((s) => s.options);
  const fetchOptions = useNevoStore((s) => s.fetchOptions);
  const running = useNevoStore((s) => s.running);
  const status = useNevoStore((s) => s.status);
  const progress = useNevoStore((s) => s.progress);
  const result = useNevoStore((s) => s.result);
  const error = useNevoStore((s) => s.error);
  const startSearch = useNevoStore((s) => s.startSearch);
  const cancel = useNevoStore((s) => s.cancel);

  const panelRef = useRef<HTMLDivElement>(null);
  const [introOpen, setIntroOpen] = useState(false);

  useEffect(() => {
    if (menuOpen) fetchOptions();
  }, [menuOpen, fetchOptions]);

  // close on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node)) {
        const btn = (e.target as HTMLElement)?.closest?.("[data-nevo-button]");
        if (!btn) setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpen]);

  const rois = useMemo(() => {
    const backend = options?.rois ?? [];
    return backend.length ? backend : Object.keys(ROI_MEANING);
  }, [options]);

  const i2vFamilies = options?.i2vFamilies ?? [];
  const objectives = (
    (options?.objectives as NevoObjective[] | undefined) ?? ["brain"]
  ).filter((o) => WIRED_OBJECTIVES.includes(o));

  // A saved config from an older build may hold a hidden objective.
  useEffect(() => {
    if (!WIRED_OBJECTIVES.includes(config.objective))
      setConfig({ objective: "brain" });
  }, [config.objective, setConfig]);

  if (!menuOpen) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="NEvo mode"
      className="absolute top-full right-0 z-50 mt-2 w-[min(360px,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.35)]"
    >
      {/* header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--accent-primary)]" />
          <span className="text-sm font-bold text-[var(--text-primary)]">
            NEvo — Neural Evolution
          </span>
        </div>
        <button
          onClick={() => setMenuOpen(false)}
          className="rounded-md p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label="Close NEvo"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* the mode toggle */}
      <button
        onClick={() => setEnabled(!enabled)}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2.5 text-left"
        aria-pressed={enabled}
      >
        <span className="flex items-center gap-2">
          <Brain
            className={`h-4 w-4 ${enabled ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"}`}
          />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Use NEvo mode
          </span>
        </span>
        <span
          className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-[var(--accent-primary)]" : "bg-[var(--border-primary)]"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
          />
        </span>
      </button>
      <Help>
        {NEVO_INTRO_SHORT}{" "}
        <button
          type="button"
          onClick={() => setIntroOpen((v) => !v)}
          aria-expanded={introOpen}
          className="text-[var(--accent-primary)] hover:underline"
        >
          {introOpen ? "Less" : "Learn more"}
        </button>
      </Help>
      {introOpen && <Help>{NEVO_INTRO_MORE}</Help>}

      {enabled && (
        <div className="mt-4 flex flex-col gap-4">
          {/* Objective */}
          <Field label="Goal (what to optimize)">
            <PillToggle<NevoObjective>
              value={config.objective}
              onChange={(v) => setConfig({ objective: v })}
              options={objectives.map((o) => ({
                label:
                  o === "brain"
                    ? "Brain region"
                    : o === "aesthetic"
                      ? "Beauty"
                      : "Prompt match",
                value: o,
              }))}
            />
            <Help>{OBJECTIVE_HELP[config.objective] ?? ""}</Help>
          </Field>

          {/* ROI (brain only) */}
          {config.objective === "brain" && (
            <Field label="Brain region">
              <select
                value={config.roi}
                onChange={(e) => setConfig({ roi: e.target.value })}
                className="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
              >
                {rois.map((r) => (
                  <option key={r} value={r}>
                    {r}
                    {ROI_MEANING[r]
                      ? ` — ${ROI_MEANING[r].split(" — ")[0]}`
                      : ""}
                  </option>
                ))}
              </select>
              <Help>
                {ROI_MEANING[config.roi] ??
                  "A region of the visual brain to target."}
              </Help>
            </Field>
          )}

          {/* Mode */}
          <Field label="Output">
            <PillToggle<NevoMode>
              value={config.mode}
              onChange={(v) => setConfig({ mode: v })}
              options={[
                { label: "Image", value: "t2i" },
                { label: "Image + video", value: "t2v" },
              ]}
            />
            <Help>{MODE_HELP[config.mode]}</Help>
          </Field>

          {/* i2v family */}
          {config.mode === "t2v" && (
            <Field label="Video engine">
              {i2vFamilies.length > 0 ? (
                <PillToggle<string>
                  value={config.i2vFamily}
                  onChange={(v) => setConfig({ i2vFamily: v })}
                  options={i2vFamilies.map((f) => ({
                    label:
                      f === "ltx"
                        ? "LTX"
                        : f === "wan21"
                          ? "Wan 2.1"
                          : f === "wan22"
                            ? "Wan 2.2"
                            : f,
                    value: f,
                  }))}
                />
              ) : (
                <Help>Only LTX for now.</Help>
              )}
            </Field>
          )}

          {/* Device */}
          <Field label="Run on">
            <PillToggle<NevoDevice>
              value={config.device}
              onChange={(v) => setConfig({ device: v })}
              options={[
                { label: "Auto", value: "auto" },
                { label: "GPU", value: "cuda" },
                { label: "Mac", value: "mps" },
                { label: "CPU", value: "cpu" },
              ]}
            />
            <Help>{DEVICE_HELP[config.device]}</Help>
          </Field>

          {/* Budgets */}
          <Field label="How hard to search">
            <MJSlider
              label="Image tries"
              value={config.imageMaxEvals}
              min={10}
              max={400}
              step={10}
              onChange={(v) => setConfig({ imageMaxEvals: v })}
            />
            {config.mode === "t2v" && (
              <MJSlider
                label="Video tries"
                value={config.videoMaxEvals}
                min={10}
                max={200}
                step={10}
                onChange={(v) => setConfig({ videoMaxEvals: v })}
              />
            )}
            <MJSlider
              label="Batch (population)"
              value={config.populationSize}
              min={2}
              max={20}
              step={1}
              onChange={(v) => setConfig({ populationSize: v })}
            />
            <Help>
              More tries = better but slower. {config.imageMaxEvals}
              {config.mode === "t2v" ? `+${config.videoMaxEvals}` : ""}{" "}
              generations this run.
            </Help>
          </Field>

          {/* Size */}
          <Field label="Size">
            <MJSlider
              label="Width"
              value={config.width}
              min={256}
              max={1024}
              step={64}
              onChange={(v) => setConfig({ width: v })}
            />
            <MJSlider
              label="Height"
              value={config.height}
              min={256}
              max={1024}
              step={64}
              onChange={(v) => setConfig({ height: v })}
            />
            {config.mode === "t2v" && (
              <MJSlider
                label="Frames"
                value={config.numFrames}
                min={9}
                max={97}
                step={8}
                onChange={(v) => setConfig({ numFrames: v })}
              />
            )}
            <Help>Smaller = much faster. Frames snap to 8×n+1.</Help>
          </Field>

          {/* Run / progress */}
          <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3">
            {!running ? (
              <button
                onClick={startSearch}
                disabled={config.objective !== "brain"}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-primary)] px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-primary)]/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles className="h-4 w-4" />
                {config.objective === "brain"
                  ? "Start evolving"
                  : "Pick a working goal first"}
              </button>
            ) : (
              <button
                onClick={cancel}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                <StopCircle className="h-4 w-4" /> Stop
              </button>
            )}

            {(running || status) && (
              <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                {running && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{status}</span>
                {progress.bestScore != null && (
                  <span>· best {progress.bestScore.toFixed(3)}</span>
                )}
              </div>
            )}
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

            {(progress.thumb || result?.image) && (
              <div className="mt-3 flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/jpeg;base64,${result?.image ?? progress.thumb}`}
                  alt="best candidate"
                  className="h-20 w-20 rounded-lg border border-[var(--border-primary)] object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-[var(--text-primary)]">
                    {result?.bestPrompt || "searching…"}
                  </p>
                  {result?.bestScore != null && (
                    <p className="text-xs text-[var(--text-muted)]">
                      score {result.bestScore.toFixed(3)}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
