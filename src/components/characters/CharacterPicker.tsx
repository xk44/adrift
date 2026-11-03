"use client";

/**
 * Character picker for the prompt bar's Character pill: a popover from `sm`
 * up, a bottom sheet on phones. Lists installed LoRAs that look like
 * characters (sidecar tags, trainer character boards, file names); "All
 * LoRAs" shows the rest. Up to two picks, kept in characterLoraStore.
 * With the Anima Ref Adapter on the server, one reference image can stand in
 * for the character instead (animaRefStore; the prompt bar then queues the
 * `anima_ref` action); the v2 adapter also takes a second character, drawn
 * on the right.
 * Separate from the Images menu (image inputs) on purpose.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Search, UserRound, X } from "lucide-react";
import { useStyleStore } from "@/store";
import { useDownloadStore } from "@/store/downloadStore";
import { useCharacterLoraStore } from "@/store/characterLoraStore";
import { useCharacterFamily } from "@/lib/characters/activeFamily";
import {
  MAX_CHARACTERS,
  buildCharacterEntries,
  filterCharacterEntries,
  isFamilyMismatch,
  selectionFromEntry,
  type CharacterLoraEntry,
  type ServerLoraInfo,
} from "@/lib/characters/characterLoras";
import { familyLabel } from "@/components/characters/familyLabel";
import { ToolImageInput } from "@/components/tools/ToolImageInput";
import { AnimaNcBadge } from "@/components/characters/AnimaNcBadge";
import { useAnimaRefStore } from "@/store/animaRefStore";
import { ANIMA_DUO_PROMPT_HINT } from "@/lib/oj/animaRef";

interface CharacterListResponse {
  loras: ServerLoraInfo[];
  local: boolean;
  animaRefAdapter: boolean;
  /** v2 AnimaRefAdapter node: a second (two-character) reference. */
  animaRefAdapterV2: boolean;
}

// Last list seen this page view: shown at once on open, then revalidated in
// the background (and by the Refresh button), so new LoRAs show up.
let listCache: CharacterListResponse | null = null;

/** Phones get the sheet without the keyboard popping over the list. */
function wideEnoughToAutofocus(): boolean {
  try {
    return window.matchMedia("(min-width: 640px)").matches;
  } catch {
    return true;
  }
}

async function loadCharacterList(): Promise<CharacterListResponse> {
  const r = await fetch("/api/comfy/character-loras");
  const d = r.ok ? await r.json() : null;
  if (!d?.ok) throw new Error("list failed");
  return {
    loras: Array.isArray(d.loras) ? d.loras : [],
    local: Boolean(d.local),
    animaRefAdapter: Boolean(d.animaRefAdapter),
    animaRefAdapterV2: Boolean(d.animaRefAdapterV2),
  };
}

/** Fill trigger words / base family from the LoRA's own header. */
async function fetchHeaderDetails(
  filename: string,
): Promise<{ triggers: string[]; baseFamily: string | null } | null> {
  try {
    const r = await fetch(
      `/api/comfy/lora-metadata?filename=${encodeURIComponent(filename)}`,
    );
    const d = r.ok ? await r.json() : null;
    if (!d?.ok || !d.metadata) return null;
    const m = d.metadata as {
      baseFamily?: string | null;
      triggers?: { word: string }[];
    };
    // The most frequent training tag is usually the character's token.
    const top = m.triggers?.[0]?.word;
    return {
      triggers: top ? [top] : [],
      baseFamily: m.baseFamily ?? null,
    };
  } catch {
    return null;
  }
}

interface CharacterPickerProps {
  open: boolean;
  onClose: () => void;
  /** id of the pill that opens it (outside clicks on it don't close). */
  triggerId: string;
}

export function CharacterPicker({
  open,
  onClose,
  triggerId,
}: CharacterPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<CharacterListResponse | null>(listCache);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const selected = useCharacterLoraStore((s) => s.selected);
  const toggle = useCharacterLoraStore((s) => s.toggle);
  const enrich = useCharacterLoraStore((s) => s.enrich);
  const shortcodes = useStyleStore((s) => s.loraShortcodes);
  const downloads = useDownloadStore((s) => s.downloads);
  const activeFamily = useCharacterFamily();
  const animaRef = useAnimaRefStore((s) => s.reference);
  const setAnimaRef = useAnimaRefStore((s) => s.setReference);
  const animaRef2 = useAnimaRefStore((s) => s.second);
  const setAnimaRef2 = useAnimaRefStore((s) => s.setSecond);

  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (listCache) setData(listCache); // stale-while-revalidate
    setLoading(true);
    setFailed(false);
    try {
      listCache = await loadCharacterList();
      setData(listCache);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    if (wideEnoughToAutofocus())
      requestAnimationFrame(() => searchRef.current?.focus());
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (document.getElementById(triggerId)?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, load, onClose, triggerId]);

  const entries = useMemo(
    () => buildCharacterEntries(data?.loras ?? [], shortcodes, downloads),
    [data, shortcodes, downloads],
  );
  const characterCount = useMemo(
    () => entries.filter((e) => e.characterReason !== null).length,
    [entries],
  );
  const visible = useMemo(
    () => filterCharacterEntries(entries, { query, showAll }),
    [entries, query, showAll],
  );

  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) document.getElementById(triggerId)?.focus();
  };

  const pick = (e: CharacterLoraEntry) => {
    const wasSelected = selected.some((s) => s.filename === e.filename);
    toggle(selectionFromEntry(e));
    if (!wasSelected && (e.triggers.length === 0 || !e.baseFamily)) {
      void fetchHeaderDetails(e.filename).then((d) => {
        if (d) enrich(e.filename, d);
      });
    }
  };

  if (!open) return null;

  const full = selected.length >= MAX_CHARACTERS;

  return (
    <>
      {/* Phone sheet backdrop */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/40 sm:hidden"
        onClick={() => close(false)}
      />
      <div
        ref={rootRef}
        id="cj-character-picker"
        role="dialog"
        aria-label="Pick a character"
        data-character-picker=""
        onBlur={(e) => {
          // Tabbing out of the popover closes it (null = file picker, etc.).
          const next = e.relatedTarget as Node | null;
          if (!next || rootRef.current?.contains(next)) return;
          if (document.getElementById(triggerId)?.contains(next)) return;
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Keep the page-level Escape (closes the settings drawer) out.
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        }}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] shadow-xl animate-fade-in sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[min(32rem,70vh)] sm:w-80 sm:rounded-xl sm:pb-0"
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">
              Character
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Pick up to {MAX_CHARACTERS} character LoRAs.
            </p>
          </div>
          <button
            type="button"
            onClick={() => close(true)}
            aria-label="Close character picker"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-3 pt-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search LoRAs</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or trigger"
              className="h-9 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] pl-7 pr-2 text-base text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] sm:h-8 sm:text-xs"
            />
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={showAll}
            onClick={() => setShowAll((v) => !v)}
            title="Show every installed LoRA, not just characters"
            className={`h-9 shrink-0 rounded-lg border px-2 text-xs font-medium sm:h-8 ${
              showAll
                ? "border-[var(--accent-primary)]/50 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            All LoRAs
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh LoRA list"
            title="Refresh LoRA list"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60 sm:size-8"
          >
            <RefreshCw
              aria-hidden="true"
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>

        <div
          role="group"
          aria-label="LoRAs"
          className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        >
          {loading && !data ? (
            <p className="flex items-center gap-2 px-2 py-4 text-xs text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for
              LoRAs…
            </p>
          ) : failed && !data ? (
            <div className="px-2 py-4 text-xs text-[var(--text-muted)]">
              <p>Could not reach ComfyUI to list LoRAs.</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 rounded-md border border-[var(--border-primary)] px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Try again
              </button>
            </div>
          ) : entries.length === 0 ? (
            <p className="px-2 py-4 text-xs text-[var(--text-muted)]">
              No LoRAs in ComfyUI&apos;s loras folder yet. Train one from a
              character board, or add a file and press Refresh.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-4 text-xs text-[var(--text-muted)]">
              {!showAll && characterCount === 0
                ? "No LoRAs look like characters. Turn on All LoRAs to pick any of them."
                : "Nothing matches that search."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visible.map((e) => (
                <CharacterRow
                  key={e.filename}
                  entry={e}
                  checked={selected.some((s) => s.filename === e.filename)}
                  disabled={
                    full && !selected.some((s) => s.filename === e.filename)
                  }
                  mismatch={isFamilyMismatch(e, activeFamily)}
                  showPreview={Boolean(data?.local) && e.hasPreview}
                  onPick={() => pick(e)}
                />
              ))}
            </ul>
          )}
          {full && visible.length > 0 && (
            <p className="px-2 pt-2 text-[11px] text-[var(--text-muted)]">
              Two characters picked. Remove one to pick another.
            </p>
          )}
        </div>

        {data?.animaRefAdapter && (
          <div
            data-anima-ref=""
            className="border-t border-[var(--border-primary)] px-3 py-2"
          >
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                From a reference image (Anima)
              </p>
              <AnimaNcBadge />
            </div>
            <p className="pb-1.5 text-[11px] text-[var(--text-muted)]">
              One picture of the character. Your prompt then describes only
              the scene (pose, place, action), not how they look. Uses the
              Anima model instead of the selected one; character LoRAs are
              left out.
            </p>
            <ToolImageInput
              label={animaRef2 ? "Left character" : "Character reference"}
              value={animaRef}
              onChange={setAnimaRef}
            />
            {data.animaRefAdapterV2 && (animaRef || animaRef2) && (
              <div data-anima-ref-second="" className="pt-2">
                <p className="text-xs font-medium text-[var(--text-secondary)]">
                  Second character{" "}
                  <span className="font-normal text-[var(--text-muted)]">
                    (optional, drawn on the right)
                  </span>
                </p>
                <p className="pb-1.5 text-[11px] text-[var(--text-muted)]">
                  {ANIMA_DUO_PROMPT_HINT}
                </p>
                <ToolImageInput
                  label="Right character"
                  value={animaRef2}
                  onChange={setAnimaRef2}
                  needsPixels
                />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

interface CharacterRowProps {
  entry: CharacterLoraEntry;
  checked: boolean;
  disabled: boolean;
  mismatch: boolean;
  showPreview: boolean;
  onPick: () => void;
}

function CharacterRow({
  entry,
  checked,
  disabled,
  mismatch,
  showPreview,
  onPick,
}: CharacterRowProps) {
  const [imgOk, setImgOk] = useState(true);
  const family = familyLabel(entry.baseFamily);
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={onPick}
        title={entry.filename}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          checked
            ? "bg-[var(--accent-primary)]/10"
            : "hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
        }`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-tertiary)]">
          {showPreview && imgOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/comfy/lora-preview?filename=${encodeURIComponent(entry.filename)}`}
              alt=""
              loading="lazy"
              onError={() => setImgOk(false)}
              className="size-full object-cover"
            />
          ) : (
            <UserRound className="h-4 w-4 text-[var(--text-muted)]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[var(--text-primary)]">
            {entry.label}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            {family && (
              <span
                className={`shrink-0 rounded px-1 ${
                  mismatch
                    ? "bg-[var(--warning)]/15 text-[var(--warning)]"
                    : "bg-[var(--bg-tertiary)]"
                }`}
                title={
                  mismatch
                    ? "Made for a different model family than the one selected"
                    : undefined
                }
              >
                {family}
                {mismatch && " · other family"}
              </span>
            )}
            <span className="truncate">
              {entry.triggers.length > 0
                ? entry.triggers.join(", ")
                : entry.characterReason === null
                  ? "Not tagged as a character"
                  : entry.filename}
            </span>
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`flex size-5 shrink-0 items-center justify-center rounded border ${
            checked
              ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
              : "border-[var(--border-primary)]"
          }`}
        >
          {checked && <Check className="h-3 w-3" />}
        </span>
      </button>
    </li>
  );
}
