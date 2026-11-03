"use client";

import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { useCharacterProfileStore } from "@/store/characterProfileStore";
import {
  fromStoredRef,
  identityEngine,
  type CharacterProfile,
} from "@/lib/tools/characterProfiles";
import type { ToolImage } from "@/lib/tools/runTool";
import { urlToDataUrl } from "./ToolImageInput";

/** Ref → submittable image; gallery refs get pixels when the slot needs them. */
export async function resolveProfileRef(
  ref: ToolImage,
  needsPixels: boolean,
): Promise<ToolImage> {
  const img = fromStoredRef(ref);
  if (needsPixels && !img.dataUrl)
    img.dataUrl = await urlToDataUrl(img.previewUrl);
  return img;
}

interface CharacterProfilePickerProps {
  /** Hub card key of the runner (for the "works best with" hint). */
  toolKey?: string;
  needsPixels?: boolean;
  disabled?: boolean;
  /**
   * A profile (or none) was chosen. `image` is the reference to place, null
   * when cleared; `prev` is the previously applied profile.
   */
  onApply: (
    image: ToolImage | null,
    next: CharacterProfile | null,
    prev: CharacterProfile | null,
  ) => void;
}

/** Compact row of saved character profiles; hidden when there are none. */
export function CharacterProfilePicker({
  toolKey,
  needsPixels = false,
  disabled,
  onApply,
}: CharacterProfilePickerProps) {
  const profiles = useCharacterProfileStore((s) => s.profiles);
  const takeArmed = useCharacterProfileStore((s) => s.takeArmed);
  const [active, setActive] = useState<CharacterProfile | null>(null);
  const [refIndex, setRefIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const armedDone = useRef(false);

  const choose = async (p: CharacterProfile | null, index = 0) => {
    setError(null);
    if (!p) {
      onApply(null, null, active);
      setActive(null);
      return;
    }
    const ref = p.refs[index] ?? p.refs[0];
    try {
      const img = await resolveProfileRef(ref, needsPixels);
      onApply(img, p, active);
      setActive(p);
      setRefIndex(index);
    } catch {
      setError("Couldn't load that reference image.");
    }
  };

  // "Use" from the profiles page arms a profile for the next runner.
  useEffect(() => {
    if (armedDone.current) return;
    armedDone.current = true;
    const id = takeArmed();
    const p = id ? profiles.find((x) => x.id === id) : undefined;
    if (p) void choose(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (profiles.length === 0) return null;
  const engine = active ? identityEngine(active.engine) : null;

  return (
    <div className="space-y-1.5" data-testid="character-profile-picker">
      <span className="flex items-center gap-1.5 text-xs font-medium text-light-primary dark:text-dark-primary">
        <UserRound className="h-3.5 w-3.5" /> Character profile
      </span>
      <div
        role="radiogroup"
        aria-label="Character profile"
        className="flex flex-wrap gap-1.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!active}
          disabled={disabled}
          onClick={() => void choose(null)}
          className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${
            !active
              ? "border-splash bg-splash/10 text-splash"
              : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
          }`}
        >
          None
        </button>
        {profiles.map((p) => {
          const on = active?.id === p.id;
          const thumb = fromStoredRef(p.refs[0]).previewUrl;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => void choose(p)}
              className={`flex items-center gap-1.5 rounded-lg border py-1 pl-1 pr-2.5 text-xs transition-colors disabled:opacity-40 ${
                on
                  ? "border-splash bg-splash/10 text-splash"
                  : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumb}
                alt=""
                className="h-6 w-6 rounded-md object-cover"
              />
              <span className="max-w-[10rem] truncate">{p.name}</span>
            </button>
          );
        })}
      </div>
      {active && active.refs.length > 1 && (
        <div className="flex gap-1.5" aria-label="Reference to use">
          {active.refs.map((r, i) => (
            <button
              key={r.id}
              type="button"
              disabled={disabled}
              aria-pressed={i === refIndex}
              aria-label={`Use reference ${i + 1}`}
              onClick={() => void choose(active, i)}
              className={`h-10 w-10 overflow-hidden rounded-md border-2 ${
                i === refIndex ? "border-splash" : "border-transparent"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fromStoredRef(r).previewUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
      {engine && toolKey && engine.toolKey !== toolKey && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          This profile is set up for {engine.label}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
