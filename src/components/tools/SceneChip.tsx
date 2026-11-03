"use client";

/**
 * Tools header "Scene" chip: aspect, size, length, seed and style shared by
 * every tool card (lib/tools/scene.ts). Cards fill matching fields unless
 * changed there, and mark them "from scene".
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import {
  SCENE_ASPECTS,
  SCENE_DURATIONS,
  SCENE_LONG_EDGES,
  SCENE_SEED_MAX,
  sceneIsSet,
  sceneSummary,
  type Scene,
} from "@/lib/tools/scene";
import { radioKeyTarget } from "@/lib/tools/radioNav";
import { useSceneStore } from "@/store/sceneStore";

const INPUT =
  "h-8 w-full rounded-lg border border-light-100 bg-light-input px-2 text-xs text-light-primary placeholder:text-light-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-50 dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-400";
const LABEL = "text-[11px] font-medium text-light-500 dark:text-dark-400";
const ASPECT_CHOICES: (string | null)[] = [null, ...SCENE_ASPECTS];
const GUTTER = 16;
// Server renders (tests, SSR) skip layout effects; this avoids React's warning.
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Small marker next to a card field whose value came from the Scene. */
export function FromScene() {
  return (
    <span
      className="ml-1.5 text-[10px] font-normal text-splash"
      title="Set by the Scene in the Tools header. Change it here to override for this tool."
      data-testid="from-scene"
    >
      from scene
    </span>
  );
}

export function SceneChip() {
  const scene = useSceneStore((s) => s.scene);
  const update = useSceneStore((s) => s.update);
  const clear = useSceneStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // The chip can sit anywhere in the wrapped header row, so on narrow
  // screens neither edge alignment keeps the panel on screen: nudge it in.
  useClientLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const el = panelRef.current;
      if (!el) return;
      el.style.transform = "";
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const dx =
        r.left < GUTTER
          ? GUTTER - r.left
          : r.right > vw - GUTTER
            ? vw - GUTTER - r.right
            : 0;
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative flex-shrink-0"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <SceneButton
        scene={scene}
        open={open}
        panelId={panelId}
        buttonRef={triggerRef}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <ScenePanel
          id={panelId}
          panelRef={panelRef}
          scene={scene}
          onChange={update}
          onClear={clear}
        />
      )}
    </div>
  );
}

export function SceneButton({
  scene,
  open,
  panelId,
  buttonRef,
  onClick,
}: {
  scene: Scene;
  open: boolean;
  panelId: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  const summary = sceneSummary(scene);
  const active = scene.apply && sceneIsSet(scene);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      data-testid="tools-scene"
      title="Settings shared by every tool: aspect, size, length, seed, style"
      className={`flex h-9 max-w-[13rem] items-center gap-1.5 rounded-full px-3.5 text-xs font-medium shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-[background-color,transform] duration-150 hover:bg-light-input focus:outline-none focus-visible:ring-2 focus-visible:ring-splash active:scale-[0.96] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input ${
        active ? "text-splash" : "text-light-primary dark:text-dark-primary"
      }`}
    >
      <Clapperboard className="h-3.5 w-3.5 flex-shrink-0" />
      Scene
      {!scene.apply ? (
        <span className="font-normal text-light-500 dark:text-dark-400">
          off
        </span>
      ) : summary ? (
        <span className="truncate font-normal tabular-nums">{summary}</span>
      ) : null}
    </button>
  );
}

const numOrNull = (v: string): number | null => (v === "" ? null : Number(v));

export function ScenePanel({
  id,
  panelRef,
  scene,
  onChange,
  onClear,
}: {
  id: string;
  panelRef?: React.Ref<HTMLDivElement>;
  scene: Scene;
  onChange: (patch: Partial<Scene>) => void;
  onClear: () => void;
}) {
  const off = !scene.apply;
  return (
    <div
      ref={panelRef}
      id={id}
      role="group"
      aria-label="Scene"
      data-testid="tools-scene-panel"
      className="absolute right-0 z-50 mt-1.5 w-[min(20rem,calc(100vw-2rem))] space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs shadow-lg"
    >
      <label className="flex items-center gap-2 font-medium text-light-primary dark:text-dark-primary">
        <input
          type="checkbox"
          className="accent-[var(--accent-primary)]"
          checked={scene.apply}
          onChange={(e) => onChange({ apply: e.target.checked })}
        />
        Apply scene to tools
      </label>

      <fieldset disabled={off} className="space-y-3 disabled:opacity-50">
        <div className="space-y-1">
          <span className={LABEL}>Aspect</span>
          <div
            className="flex flex-wrap gap-1"
            role="radiogroup"
            aria-label="Aspect"
            onKeyDown={(e) => {
              const from = Math.max(0, ASPECT_CHOICES.indexOf(scene.aspect));
              const to = radioKeyTarget(
                ASPECT_CHOICES.map(() => false),
                from,
                e.key,
              );
              if (to === null) return;
              e.preventDefault();
              onChange({ aspect: ASPECT_CHOICES[to] ?? null });
              e.currentTarget
                .querySelectorAll<HTMLElement>('[role="radio"]')
                [to]?.focus();
            }}
          >
            {ASPECT_CHOICES.map((a) => (
              <button
                key={a ?? "any"}
                type="button"
                role="radio"
                aria-checked={scene.aspect === a}
                // One tab stop per group; arrows move between options.
                tabIndex={scene.aspect === a ? 0 : -1}
                onClick={() => onChange({ aspect: a })}
                className={`min-h-7 rounded-full border px-2.5 text-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${
                  scene.aspect === a
                    ? "border-splash bg-splash/10 text-splash"
                    : "border-light-100 text-light-500 hover:border-splash/60 dark:border-dark-750 dark:text-dark-400"
                }`}
              >
                {a ?? "Any"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className={LABEL}>Size (long edge)</span>
            <select
              className={INPUT}
              value={scene.longEdge ?? ""}
              onChange={(e) =>
                onChange({ longEdge: numOrNull(e.target.value) })
              }
            >
              <option value="">Any</option>
              {SCENE_LONG_EDGES.map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Video length</span>
            <select
              className={INPUT}
              value={scene.duration ?? ""}
              onChange={(e) =>
                onChange({ duration: numOrNull(e.target.value) })
              }
            >
              <option value="">Any</option>
              {SCENE_DURATIONS.map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-1">
          <span className={LABEL}>Seed</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="Seed"
              className={INPUT}
              min={0}
              max={SCENE_SEED_MAX}
              placeholder="random"
              value={scene.seed ?? ""}
              onChange={(e) =>
                onChange({
                  seed:
                    e.target.value === ""
                      ? null
                      : Math.trunc(Number(e.target.value)),
                })
              }
            />
            <label className="flex flex-shrink-0 items-center gap-1.5 text-light-primary dark:text-dark-primary">
              <input
                type="checkbox"
                className="accent-[var(--accent-primary)]"
                checked={scene.seedLocked}
                onChange={(e) => onChange({ seedLocked: e.target.checked })}
              />
              Lock
            </label>
          </div>
        </div>

        <label className="block space-y-1">
          <span className={LABEL}>Style</span>
          <input
            type="text"
            className={INPUT}
            maxLength={500}
            placeholder="warm film look, soft light"
            value={scene.style}
            onChange={(e) => onChange({ style: e.target.value })}
          />
        </label>
      </fieldset>

      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Fills matching settings in each tool. Changing one in a tool keeps
          your value there.
        </p>
        <button
          type="button"
          onClick={onClear}
          disabled={!sceneIsSet(scene) && scene.seed === null}
          className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-light-500 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-40 dark:text-dark-400 dark:hover:text-dark-primary"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
