"use client";

import { Clapperboard } from "lucide-react";
import {
  cinemaCount,
  cinemaKnob,
  cinemaKnobsFor,
  compileCinema,
  defaultScene,
  groupCinemaOptions,
  resizeScene,
  CINEMA_TOOL_OMIT,
  SCENE_MAX_SHOTS,
  SCENE_MIN_SHOTS,
  SCENE_SHOT_KEYS,
  type CinemaKey,
  type CinemaKnob,
  type CinemaScene,
  type CinemaSettings,
  type SceneShot,
} from "@/lib/tools/cinema";
import { field } from "./ToolRunner";
import type { CharacterProfile } from "@/lib/tools/characterProfiles";
import type { ToolImage } from "@/lib/tools/runTool";
import { SceneCharacterPicker, SceneLocationPicker } from "./SceneSavedPickers";

/** Runner hooks for saved characters / locations in a scene (all optional). */
export interface SceneAssetProps {
  /** A saved Character Profile was picked for the scene character. */
  onSceneProfile?: (p: CharacterProfile) => void;
  /** Source image the runner holds (can be saved with a location). */
  sceneImage?: ToolImage | null;
  /** Use a saved location's reference image as the source. */
  onUseSceneImage?: (img: ToolImage) => void;
}

function KnobOptions({ knob }: { knob: CinemaKnob }) {
  return (
    <>
      <option value="">Any</option>
      {groupCinemaOptions(knob.options).map((g) =>
        g.group ? (
          <optgroup key={g.group} label={g.group}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : (
          g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))
        ),
      )}
    </>
  );
}

const SCENE_COUNTS = Array.from(
  { length: SCENE_MAX_SHOTS - SCENE_MIN_SHOTS + 1 },
  (_, i) => SCENE_MIN_SHOTS + i,
);

/**
 * Multi-shot scene editor: shared character + location, then 2-4 shots,
 * each with its own framing / movement / lens / action.
 */
function SceneEditor({
  scene,
  omit,
  onChange,
  onSceneProfile,
  sceneImage,
  onUseSceneImage,
}: {
  scene: CinemaScene;
  omit: CinemaKey[];
  onChange: (s: CinemaScene) => void;
} & SceneAssetProps) {
  const keys = SCENE_SHOT_KEYS.filter((k) => !omit.includes(k));
  const setShot = (i: number, patch: Partial<SceneShot>) =>
    onChange({
      ...scene,
      shots: scene.shots.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    });

  return (
    <div className="mt-3 space-y-3" data-testid="cinema-scene">
      <div className="flex items-center gap-2">
        <span className="text-light-500 dark:text-dark-400">Shots</span>
        {SCENE_COUNTS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(resizeScene(scene, n))}
            aria-pressed={scene.shots.length === n}
            className={`rounded-md border px-2 py-0.5 ${
              scene.shots.length === n
                ? "border-splash text-splash"
                : "border-light-100 text-light-500 dark:border-dark-750 dark:text-dark-400"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block space-y-1">
            <span className="text-light-500 dark:text-dark-400">
              Character (every shot)
            </span>
            <input
              className={field}
              maxLength={300}
              value={scene.character}
              placeholder="a weathered sea captain in a yellow raincoat"
              onChange={(e) =>
                onChange({ ...scene, character: e.target.value })
              }
              data-testid="cinema-scene-character"
            />
          </label>
          <SceneCharacterPicker
            scene={scene}
            onChange={onChange}
            onProfile={onSceneProfile}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block space-y-1">
            <span className="text-light-500 dark:text-dark-400">
              Location (every shot)
            </span>
            <input
              className={field}
              maxLength={300}
              value={scene.location}
              placeholder="a storm-lashed harbor at dusk"
              onChange={(e) => onChange({ ...scene, location: e.target.value })}
              data-testid="cinema-scene-location"
            />
          </label>
          <SceneLocationPicker
            scene={scene}
            onChange={onChange}
            currentImage={sceneImage}
            onUseImage={onUseSceneImage}
          />
        </div>
      </div>
      <ol className="space-y-2">
        {scene.shots.map((s, i) => (
          <li
            key={i}
            className="space-y-2 rounded-lg border border-light-100 p-2 dark:border-dark-750"
            data-testid={`cinema-scene-shot-${i}`}
          >
            <span className="font-medium text-light-primary dark:text-dark-primary">
              Shot {i + 1}
            </span>
            <div className="grid gap-2 sm:grid-cols-3">
              {keys.map((k) => {
                const knob = cinemaKnob(k);
                return (
                  <label key={k} className="space-y-1">
                    <span className="text-light-500 dark:text-dark-400">
                      {knob.label}
                    </span>
                    <select
                      className={field}
                      value={s[k] ?? ""}
                      onChange={(e) =>
                        setShot(i, { [k]: e.target.value || undefined })
                      }
                      aria-label={`Shot ${i + 1} ${knob.label}`}
                    >
                      <KnobOptions knob={knob} />
                    </select>
                  </label>
                );
              })}
            </div>
            <input
              className={field}
              maxLength={300}
              value={s.action ?? ""}
              placeholder="What happens in this shot (optional)"
              onChange={(e) => setShot(i, { action: e.target.value })}
              aria-label={`Shot ${i + 1} action`}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Collapsible camera / lens / look / lighting picker. Controlled: the parent
 * keeps `value` and appends compileCinema(value, omit) to its prompt. With
 * `onSceneChange`, it also offers a multi-shot scene (parent compiles it with
 * compileSceneShots and queues one run per shot).
 */
export function CinemaStudio({
  toolId,
  value,
  onChange,
  scene,
  onSceneChange,
  ...assets
}: {
  /** Action id; hides knobs the tool already fixes (see CINEMA_TOOL_OMIT). */
  toolId?: string;
  value: CinemaSettings;
  onChange: (v: CinemaSettings) => void;
  /** Multi-shot scene; null = single shot. */
  scene?: CinemaScene | null;
  onSceneChange?: (s: CinemaScene | null) => void;
} & SceneAssetProps) {
  const knobs = cinemaKnobsFor(toolId);
  const omit = (toolId && CINEMA_TOOL_OMIT[toolId]) || [];
  const compiled = compileCinema(value, omit);
  const count = cinemaCount(value, omit);
  const set = (key: CinemaKey, id: string) =>
    onChange({ ...value, [key]: id || undefined });

  return (
    <details
      className="rounded-xl border border-light-100 p-3 text-xs dark:border-dark-750"
      data-testid="cinema-studio"
    >
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-light-primary dark:text-dark-primary">
        <Clapperboard className="h-3.5 w-3.5 text-splash" />
        Cinema Studio
        <span className="font-normal text-light-500 dark:text-dark-400">
          {count > 0 ? `· ${count} set` : "· camera, lens, look, lighting"}
          {scene ? ` · ${scene.shots.length}-shot scene` : ""}
        </span>
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {knobs.map((k) => (
          <label key={k.key} className="space-y-1">
            <span className="text-light-500 dark:text-dark-400">{k.label}</span>
            <select
              className={field}
              value={value[k.key] ?? ""}
              onChange={(e) => set(k.key, e.target.value)}
              data-testid={`cinema-${k.key}`}
            >
              <KnobOptions knob={k} />
            </select>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          {compiled ? (
            <>
              Adds: <span className="font-mono">{compiled}</span>
            </>
          ) : (
            "Nothing added. Pick any knob to steer the shot."
          )}
        </p>
        {count > 0 && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="flex-shrink-0 text-[11px] text-light-500 underline hover:text-splash dark:text-dark-400"
          >
            Reset
          </button>
        )}
      </div>
      {onSceneChange && (
        <section className="mt-3 border-t border-light-100 pt-3 dark:border-dark-750">
          <label className="flex items-center gap-2 font-medium text-light-primary dark:text-dark-primary">
            <input
              type="checkbox"
              checked={Boolean(scene)}
              onChange={(e) =>
                onSceneChange(e.target.checked ? defaultScene() : null)
              }
              data-testid="cinema-scene-toggle"
            />
            Multi-shot scene
            <span className="font-normal text-light-500 dark:text-dark-400">
              · 2-4 shots, same character and location, one clip each
            </span>
          </label>
          {scene && (
            <SceneEditor
              scene={scene}
              omit={omit}
              onChange={onSceneChange}
              {...assets}
            />
          )}
        </section>
      )}
    </details>
  );
}
