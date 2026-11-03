"use client";

import { useState } from "react";
import { MapPin, Trash2 } from "lucide-react";
import { useCharacterProfileStore } from "@/store/characterProfileStore";
import { useCinemaLocationStore } from "@/store/cinemaLocationStore";
import type { CharacterProfile } from "@/lib/tools/characterProfiles";
import { locationImage } from "@/lib/tools/cinemaLocations";
import { profileSceneCharacter } from "@/lib/tools/sceneStitch";
import type { CinemaScene } from "@/lib/tools/cinema";
import type { ToolImage } from "@/lib/tools/runTool";
import { field } from "./ToolRunner";

const small =
  "rounded-md border border-light-100 px-2 py-0.5 text-[11px] text-light-500 hover:border-splash/60 disabled:opacity-40 dark:border-dark-750 dark:text-dark-400";

/** Saved Character Profile -> scene character text (+ its reference). */
export function SceneCharacterPicker({
  scene,
  onChange,
  onProfile,
}: {
  scene: CinemaScene;
  onChange: (s: CinemaScene) => void;
  /** The runner places the profile's reference in its identity slot. */
  onProfile?: (p: CharacterProfile) => void;
}) {
  const profiles = useCharacterProfileStore((s) => s.profiles);
  const [picked, setPicked] = useState("");
  if (profiles.length === 0) return null;
  return (
    <select
      className={field}
      value={picked}
      aria-label="Saved character"
      data-testid="cinema-scene-profile"
      onChange={(e) => {
        const p = profiles.find((x) => x.id === e.target.value);
        setPicked(p ? p.id : "");
        if (!p) return;
        onChange({ ...scene, character: profileSceneCharacter(p) });
        onProfile?.(p);
      }}
    >
      <option value="">Saved character…</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Saved Locations: pick one (fills the shared location text, offers its
 * reference image as the source), save the current text (optionally with
 * the current source image), delete.
 */
export function SceneLocationPicker({
  scene,
  onChange,
  currentImage,
  onUseImage,
}: {
  scene: CinemaScene;
  onChange: (s: CinemaScene) => void;
  /** Source image the runner holds now (saved with the location on request). */
  currentImage?: ToolImage | null;
  /** Put a location's reference image in the runner's source slot. */
  onUseImage?: (img: ToolImage) => void;
}) {
  const locations = useCinemaLocationStore((s) => s.locations);
  const saveLocation = useCinemaLocationStore((s) => s.saveLocation);
  const removeLocation = useCinemaLocationStore((s) => s.removeLocation);
  const [picked, setPicked] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [withImage, setWithImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = locations.find((l) => l.id === picked) ?? null;
  const activeImage = active ? locationImage(active) : null;

  const save = () => {
    const res = saveLocation({
      name,
      description: scene.location,
      ref: withImage && currentImage ? currentImage : null,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setSaving(false);
    setName("");
    setWithImage(false);
    setPicked(res.location.id);
  };

  return (
    <div className="space-y-1.5" data-testid="cinema-scene-locations">
      <div className="flex items-center gap-1.5">
        {locations.length > 0 && (
          <select
            className={field}
            value={picked}
            aria-label="Saved location"
            data-testid="cinema-scene-location-pick"
            onChange={(e) => {
              const l = locations.find((x) => x.id === e.target.value);
              setPicked(l ? l.id : "");
              setError(null);
              if (l) onChange({ ...scene, location: l.description });
            }}
          >
            <option value="">Saved location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        {active && (
          <button
            type="button"
            className={small}
            aria-label={`Delete location ${active.name}`}
            onClick={() => {
              removeLocation(active.id);
              setPicked("");
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        {!saving && (
          <button
            type="button"
            className={`${small} flex-shrink-0`}
            disabled={!scene.location.trim()}
            onClick={() => {
              setSaving(true);
              setError(null);
              setName(active?.name ?? "");
            }}
            data-testid="cinema-scene-location-save"
          >
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" /> Save location
            </span>
          </button>
        )}
      </div>
      {activeImage && onUseImage && (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={activeImage.previewUrl}
            alt=""
            className="h-8 w-12 rounded object-cover"
          />
          <button
            type="button"
            className={small}
            onClick={() => onUseImage(activeImage)}
          >
            Use as source image
          </button>
        </div>
      )}
      {saving && (
        <div className="space-y-1.5 rounded-md border border-light-100 p-2 dark:border-dark-750">
          <input
            className={field}
            maxLength={60}
            value={name}
            placeholder="Location name, e.g. Harbor at dusk"
            onChange={(e) => setName(e.target.value)}
            aria-label="Location name"
          />
          {currentImage && (
            <label className="flex items-center gap-2 text-[11px] text-light-500 dark:text-dark-400">
              <input
                type="checkbox"
                checked={withImage}
                onChange={(e) => setWithImage(e.target.checked)}
              />
              Keep the current source image as its reference
            </label>
          )}
          <div className="flex gap-1.5">
            <button type="button" className={small} onClick={save}>
              Save
            </button>
            <button
              type="button"
              className={small}
              onClick={() => {
                setSaving(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
