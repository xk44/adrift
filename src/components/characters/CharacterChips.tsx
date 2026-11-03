"use client";

/**
 * Picked characters, shown inside the prompt card under the style chips.
 * Each chip: name, strength slider, trigger-word chips (removable), remove.
 * A LoRA made for another model family is held back until "Use anyway".
 * Deliberately not part of the image-input sections.
 */

import { AlertTriangle, UserRound, X } from "lucide-react";
import { useCharacterLoraStore } from "@/store/characterLoraStore";
import { useCharacterFamily } from "@/lib/characters/activeFamily";
import {
  MAX_CHARACTER_STRENGTH,
  MIN_CHARACTER_STRENGTH,
  isFamilyMismatch,
  isPromptSafeLoraName,
} from "@/lib/characters/characterLoras";
import { familyLabel } from "@/components/characters/familyLabel";
import { useAnimaRefStore } from "@/store/animaRefStore";
import { AnimaNcBadge } from "@/components/characters/AnimaNcBadge";
import type { ToolImage } from "@/lib/tools/runTool";

/** Small visual X with a 44 px touch target (the ::before overhangs it). */
const HIT44 =
  "relative before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

export function CharacterChips() {
  const selected = useCharacterLoraStore((s) => s.selected);
  const remove = useCharacterLoraStore((s) => s.remove);
  const setStrength = useCharacterLoraStore((s) => s.setStrength);
  const removeTrigger = useCharacterLoraStore((s) => s.removeTrigger);
  const setApplyAnyway = useCharacterLoraStore((s) => s.setApplyAnyway);
  const activeFamily = useCharacterFamily();
  const animaRef = useAnimaRefStore((s) => s.reference);
  const animaRef2 = useAnimaRefStore((s) => s.second);
  const clearAnimaRef = useAnimaRefStore((s) => s.clearReference);
  const clearAnimaRef2 = useAnimaRefStore((s) => s.clearSecond);

  if (selected.length === 0 && !animaRef) return null;

  return (
    <div
      data-character-chips=""
      role="group"
      aria-label="Characters"
      className="flex flex-wrap items-center gap-1.5 px-3 pb-2"
    >
      {animaRef && (
        <AnimaRefChip
          image={animaRef}
          side={animaRef2 ? "left" : null}
          lorasOff={selected.length > 0}
          onRemove={clearAnimaRef}
        />
      )}
      {animaRef && animaRef2 && (
        <AnimaRefChip
          image={animaRef2}
          side="right"
          lorasOff={false}
          onRemove={clearAnimaRef2}
        />
      )}
      {selected.map((s) => {
        const mismatch = isFamilyMismatch(s, activeFamily);
        const unusable = !isPromptSafeLoraName(s.filename);
        const held = unusable || (mismatch && !s.applyAnyway);
        // A reference image replaces every character LoRA (anima_ref action).
        const overridden = Boolean(animaRef);
        return (
          <div
            key={s.filename}
            data-character-chip=""
            data-overridden={overridden ? "" : undefined}
            className={`flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1 text-xs ${
              overridden ? "opacity-60 " : ""
            }${
              held
                ? "border-[var(--warning)]/50 bg-[var(--warning)]/10"
                : "border-[var(--accent-secondary)]/50 bg-[var(--accent-secondary)]/10"
            }`}
          >
            <UserRound
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent-secondary)]"
            />
            <span
              className="min-w-0 max-w-[10rem] truncate font-medium text-[var(--text-primary)]"
              title={s.filename}
            >
              {s.label}
            </span>
            {overridden && (
              <span
                className="rounded bg-[var(--bg-tertiary)] px-1 text-[var(--text-muted)]"
                title="Not used while a character reference image is set"
              >
                off
              </span>
            )}
            <label className="flex items-center gap-1 text-[var(--text-muted)]">
              <span className="sr-only">{s.label} strength</span>
              <input
                type="range"
                min={MIN_CHARACTER_STRENGTH}
                max={MAX_CHARACTER_STRENGTH}
                step={0.05}
                value={s.strength}
                onChange={(e) =>
                  setStrength(s.filename, Number(e.target.value))
                }
                className="h-4 w-16 accent-[var(--accent-secondary)]"
              />
              <span className="w-7 tabular-nums">{s.strength.toFixed(2)}</span>
            </label>
            {s.triggers.map((t) => (
              <span
                key={t}
                className="flex items-center gap-0.5 rounded-full bg-[var(--bg-tertiary)] py-0.5 pl-1.5 pr-0.5 text-[var(--text-secondary)]"
                title="Trigger word, added to the start of your prompt"
              >
                <span className="max-w-[8rem] truncate">{t}</span>
                <button
                  type="button"
                  onClick={() => removeTrigger(s.filename, t)}
                  aria-label={`Don't add trigger word ${t}`}
                  className={`${HIT44} flex size-4 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--error)]`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            {unusable && (
              <span className="flex items-center gap-1 text-[var(--warning)]">
                <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                Can&apos;t use: remove the spaces from its file name
              </span>
            )}
            {mismatch && !unusable && (
              <span className="flex items-center gap-1 text-[var(--warning)]">
                <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                <span
                  title={`Made for ${familyLabel(s.baseFamily) ?? "another model"}, ${
                    held
                      ? "so it's left out of your next image."
                      : "but it will be used anyway."
                  }`}
                >
                  Different model family
                </span>
                <button
                  type="button"
                  aria-pressed={Boolean(s.applyAnyway)}
                  onClick={() => setApplyAnyway(s.filename, !s.applyAnyway)}
                  className="rounded-full border border-[var(--warning)]/50 px-1.5 hover:bg-[var(--warning)]/15"
                >
                  {held ? "Use anyway" : "Leave out"}
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={() => remove(s.filename)}
              aria-label={`Remove character ${s.label}`}
              title="Remove character"
              className={`${HIT44} flex size-5 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--error)]`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One Anima reference chip. `side` is set in two-character mode ("left" =
 * the first reference, "right" = the second).
 */
function AnimaRefChip({
  image,
  side,
  lorasOff,
  onRemove,
}: {
  image: ToolImage;
  side: "left" | "right" | null;
  lorasOff: boolean;
  onRemove: () => void;
}) {
  const name = side
    ? `${side === "left" ? "Left" : "Right"} character reference`
    : "Character reference";
  return (
    <div
      data-anima-ref-chip={side ?? ""}
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-[var(--accent-secondary)]/50 bg-[var(--accent-secondary)]/10 px-2 py-1 text-xs"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.previewUrl}
        alt=""
        className="size-5 shrink-0 rounded object-cover"
      />
      <span
        className="min-w-0 max-w-[10rem] truncate font-medium text-[var(--text-primary)]"
        title={`${name}: ${image.label}. Your prompt describes the scene only${side ? " and says who is on the left and who is on the right" : ""}.`}
      >
        {side ? `${side === "left" ? "Left" : "Right"} (Anima)` : "Reference (Anima)"}
      </span>
      {side !== "right" && <AnimaNcBadge />}
      {lorasOff && (
        <span
          className="text-[var(--text-muted)]"
          title="Character LoRAs are not used while a reference image is set"
        >
          LoRAs off
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name.toLowerCase()}`}
        title={`Remove ${name.toLowerCase()}`}
        className={`${HIT44} flex size-5 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--error)]`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
