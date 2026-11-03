"use client";

import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";
import {
  SPEED_SETTINGS,
  migratePresetSettings,
  normalizeSpeedSetting,
} from "@/lib/oj/speedTier";
import { useState, useCallback, useMemo } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { useStyleStore } from "@/store/styleStore";
import { usePreferenceStore } from "@/store/preferenceStore";
import type { StyleCodeEntry } from "@/store/styleStore";
import { navigateTo } from "@/hooks";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { MediaThumb } from "@/components/organize/MediaThumb";
import { isStillImage } from "@/lib/organize/organizeView";
import {
  CollectionToolbar,
  HeroHeader,
  StatRow,
  ToolbarPrimaryButton,
} from "@/components/PageHeader";
import {
  COLLECTION_SORT_OPTIONS,
  sortCollection,
  type CollectionSort,
} from "@/lib/collectionView";
import {
  User,
  Sliders,
  Sparkles,
  Star,
  Trash2,
  Copy,
  Check,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Zap,
  BarChart3,
  ImageIcon,
} from "lucide-react";

type PersonalizeTab = "teach" | "style-codes" | "defaults" | "presets";

const TABS = [
  {
    key: "teach" as const,
    icon: GraduationCap,
    label: "Teach",
  },
  {
    key: "style-codes" as const,
    icon: User,
    label: "Style Codes",
  },
  { key: "defaults" as const, icon: Sliders, label: "Defaults" },
  { key: "presets" as const, icon: Sparkles, label: "Presets" },
].filter((tab) => STYLE_CODES_ENABLED || tab.key !== "style-codes");

export function PersonalizePage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const gallery = useGenerationStore((s) => s.gallery);
  const [activeTab, setActiveTab] = useState<PersonalizeTab>("teach");

  // Hero art: the user's own recent stills when there are any.
  const heroUrls = useMemo(() => {
    const urls: string[] = [];
    for (const img of gallery) {
      if (img.hidden || !img.url || !isStillImage(img)) continue;
      urls.push(img.url);
      if (urls.length >= 3) break;
    }
    return urls;
  }, [gallery]);

  if (activeNav !== "personalize") return null;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="microScrollbar flex-1 overflow-y-auto px-4 pb-8 md:px-6">
        <div className="mx-auto max-w-5xl">
          <HeroHeader
            testId="personalize-hero"
            title="Show Adrift the images that move you."
            eyebrow="Personalize"
            lines={[
              "Every prompt leaves gaps (lighting, palette, framing) that the model has to guess. Pick between pairs to build a record of how you would fill them.",
              STYLE_CODES_ENABLED
                ? "Saved style codes and default settings shape each new image. Your votes are kept as a record of your taste."
                : "Presets and default settings shape each new image. Your votes are kept as a record of your taste.",
            ]}
            art={<PersonalizeHeroArt urls={heroUrls} />}
          />
        </div>

        <div className="sticky top-0 z-20 -mx-4 mb-6 bg-[var(--bg-primary)] px-4 md:-mx-6 md:px-6">
          <div
            role="tablist"
            aria-label="Personalize sections"
            className="mx-auto flex max-w-5xl gap-1 overflow-x-auto border-b border-light-100 dark:border-dark-700"
          >
            {TABS.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setActiveTab(key)}
                className={`flex flex-shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-[color,border-color] duration-150 ${
                  activeTab === key
                    ? "border-splash text-splash"
                    : "border-transparent text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-3xl">
          {activeTab === "teach" && <TeachTab />}
          {STYLE_CODES_ENABLED && activeTab === "style-codes" && (
            <StyleCodesTab />
          )}
          {activeTab === "defaults" && <DefaultsTab />}
          {activeTab === "presets" && <PresetsTab />}
        </div>
      </div>
    </div>
  );
}

/**
 * Fanned stack of three tilted cards. Uses the user's own stills when the
 * gallery has them, otherwise accent gradients so a fresh install still
 * gets a finished-looking hero.
 */
function PersonalizeHeroArt({ urls }: { urls: string[] }) {
  const slots = [
    {
      pos: "left-[4%] top-[14%] -rotate-[9deg]",
      fallback: "from-splash/80 via-rose-400/60 to-amber-300/70",
    },
    {
      pos: "left-[30%] top-[2%] rotate-[3deg] z-10",
      fallback: "from-indigo-500/70 via-fuchsia-500/60 to-splash/70",
    },
    {
      pos: "left-[56%] top-[18%] rotate-[11deg]",
      fallback: "from-teal-400/70 via-sky-500/60 to-indigo-500/70",
    },
  ];
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-[190px] w-full max-w-[360px] md:h-[250px] md:max-w-none"
    >
      {slots.map((slot, i) => {
        const url = urls[i];
        return (
          <div
            key={i}
            className={`absolute aspect-[3/4] w-[40%] overflow-hidden rounded-2xl border border-white/20 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)] ${slot.pos} ${
              url
                ? "bg-[var(--bg-tertiary)]"
                : `bg-gradient-to-br ${slot.fallback}`
            }`}
          >
            {url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
                className="h-full w-full object-cover"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Teach tab: image-pair voting to train aesthetic preferences

/** Label for how much taste signal the votes carry. */
function tasteStrength(votes: number): string {
  return votes < 10
    ? "Low"
    : votes < 50
      ? "Medium"
      : votes < 150
        ? "High"
        : "Expert";
}

function TeachTab() {
  const gallery = useGenerationStore((s) => s.gallery);
  const votes = usePreferenceStore((s) => s.votes);
  const sessionCount = usePreferenceStore((s) => s.sessionCount);
  const currentSessionVotes = usePreferenceStore((s) => s.currentSessionVotes);
  const addVote = usePreferenceStore((s) => s.addVote);
  const incrementSession = usePreferenceStore((s) => s.incrementSession);

  // Build pairs from gallery images, excluding already-voted pairs
  const votedPairKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const v of votes) {
      keys.add(`${v.imageA}|${v.imageB}`);
      keys.add(`${v.imageB}|${v.imageA}`);
    }
    return keys;
  }, [votes]);

  const availableImages = useMemo(
    // Pairwise taste votes only make sense on stills: skip video, audio
    // and 3D outputs that share the gallery.
    () => gallery.filter((img) => isStillImage(img)),
    [gallery],
  );

  // Current pair index — deterministic from vote count
  const pair = useMemo(() => {
    if (availableImages.length < 2) return null;
    // Generate pairs by stepping through combinations
    const totalPairs =
      (availableImages.length * (availableImages.length - 1)) / 2;
    if (totalPairs === 0) return null;

    for (let attempt = 0; attempt < totalPairs; attempt++) {
      const offset = (votes.length + attempt) % totalPairs;
      // Map linear index to pair (i, j) via triangular number inversion
      let i = 0;
      let remaining = offset;
      while (remaining >= availableImages.length - 1 - i) {
        remaining -= availableImages.length - 1 - i;
        i++;
      }
      const j = i + 1 + remaining;
      if (i < availableImages.length && j < availableImages.length) {
        const a = availableImages[i];
        const b = availableImages[j];
        const key = `${a.id}|${b.id}`;
        if (!votedPairKeys.has(key)) {
          return { a, b };
        }
      }
    }
    return null; // All pairs voted
  }, [availableImages, votes.length, votedPairKeys]);

  const handleVote = useCallback(
    (preferred: "a" | "b") => {
      if (!pair) return;
      addVote({
        imageA: pair.a.id,
        imageB: pair.b.id,
        preferred,
      });
    },
    [pair, addVote],
  );

  const handleNewSession = useCallback(() => {
    incrementSession();
  }, [incrementSession]);

  const notEnoughImages = availableImages.length < 2;
  const allPairsVoted = !notEnoughImages && !pair;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-splash/10 text-splash">
          <GraduationCap className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Teach Your Style
          </h2>
          <p className="text-xs text-light-500 dark:text-dark-400">
            Vote between image pairs to record your aesthetic preferences
          </p>
        </div>
      </div>

      <StatRow
        testId="teach-stats"
        stats={[
          {
            label: "votes",
            value: votes.length,
            icon: <Zap className="h-3.5 w-3.5" />,
          },
          {
            label: sessionCount === 1 ? "session" : "sessions",
            value: sessionCount,
            icon: <BarChart3 className="h-3.5 w-3.5" />,
          },
          {
            label: "strength",
            value: tasteStrength(votes.length),
            icon: <Star className="h-3.5 w-3.5" />,
            title:
              "Grows with every vote: Low < 10, Medium < 50, High < 150, then Expert",
          },
        ]}
      />

      {notEnoughImages ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <ImageIcon className="h-10 w-10 text-light-300 dark:text-dark-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            Generate more images to start teaching
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            You need at least 2 generated images to begin voting on pairs. Head
            to Create and generate some images first.
          </p>
          <button
            onClick={() => navigateTo("create")}
            className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Start Creating
          </button>
        </div>
      ) : allPairsVoted ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Check className="h-10 w-10 text-green-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            All pairs voted!
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            You&apos;ve compared every available pair. Generate more images to
            create new combinations, or start a new session.
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => navigateTo("create")}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Create More
            </button>
            <button
              onClick={handleNewSession}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary text-sm font-medium hover:bg-light-50 dark:hover:bg-dark-750 transition-colors"
            >
              New Session
            </button>
          </div>
        </div>
      ) : pair ? (
        <div className="space-y-4">
          <p className="text-xs text-center text-light-500 dark:text-dark-400">
            Click the image you prefer — vote {currentSessionVotes + 1} this
            session
          </p>
          <div className="grid grid-cols-2 gap-4">
            {(["a", "b"] as const).map((side) => {
              const img = side === "a" ? pair.a : pair.b;
              return (
                <button
                  key={img.id}
                  onClick={() => handleVote(side)}
                  className="group relative rounded-xl overflow-hidden border-2 border-transparent hover:border-splash transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-splash focus:ring-offset-2 dark:focus:ring-offset-dark-800"
                >
                  {/* Fixed square frame so a missing file keeps its slot
                      instead of collapsing to a zero-height button. */}
                  <div className="relative w-full aspect-square bg-[var(--bg-tertiary)] transition-transform duration-200 group-hover:scale-[1.02]">
                    <MediaThumb item={img} badge={false} />
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                  <div className="absolute bottom-0 left-0 right-0 p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <p className="text-white text-xs truncate drop-shadow-lg">
                      {img.prompt.slice(0, 60)}
                      {img.prompt.length > 60 ? "..." : ""}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-center text-light-400 dark:text-dark-500">
            {availableImages.length} images available
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Style Codes tab: manages saved --sref codes from styleStore

function StyleCodesTab() {
  const styleCodes = useStyleStore((s) => s.styleCodes);
  const recentStyleCodes = useStyleStore((s) => s.recentStyleCodes);
  const toggleStyleCodeFavorite = useStyleStore(
    (s) => s.toggleStyleCodeFavorite,
  );
  const removeStyleCode = useStyleStore((s) => s.removeStyleCode);
  const incrementStyleCodeUse = useStyleStore((s) => s.incrementStyleCodeUse);
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [codeQuery, setCodeQuery] = useState("");
  const [codeSort, setCodeSort] = useState<CollectionSort>("latest");
  const [codeScope, setCodeScope] = useState<"all" | "selected">("all");

  const starredCount = useMemo(
    () => styleCodes.filter((entry) => entry.isFavorite).length,
    [styleCodes],
  );
  const visibleCodes = useMemo(() => {
    const q = codeQuery.trim().toLowerCase();
    const matched = styleCodes.filter(
      (entry) =>
        (codeScope === "all" || entry.isFavorite) &&
        (!q ||
          entry.code.toLowerCase().includes(q) ||
          (entry.name?.toLowerCase().includes(q) ?? false) ||
          (entry.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)),
    );
    // Unnamed codes sort by their code; rows keep the original entry.
    return sortCollection(
      matched.map((entry) => ({
        entry,
        name: entry.name || entry.code,
        createdAt: entry.createdAt,
      })),
      codeSort,
    ).map((row) => row.entry);
  }, [styleCodes, codeQuery, codeScope, codeSort]);

  const openSrefPanel = () => {
    setSREFPanelOpen(true);
    setActiveNav("create");
  };

  const handleApply = (code: string) => {
    incrementStyleCodeUse(code);
    appendToPrompt(` --sref ${code}`);
    setActiveNav("create");
  };

  const handleCopy = (code: string) => {
    navigator.clipboard?.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  };

  return (
    <div className="space-y-6">
      {recentStyleCodes.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary mb-2">
            Recent
          </h3>
          <div className="flex flex-wrap gap-2">
            {recentStyleCodes.map((code) => (
              <button
                key={code}
                onClick={() => handleApply(code)}
                className="px-2.5 py-1 rounded-lg bg-light-100 dark:bg-dark-700 text-xs font-mono text-light-primary dark:text-dark-primary hover:bg-light-50 dark:hover:bg-dark-750 transition-[background-color] duration-150"
              >
                --sref {code.slice(0, 12)}
                {code.length > 12 ? "..." : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <User className="w-4 h-4 text-splash" />
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Saved Style Codes
          </h3>
          <span className="rounded-full bg-light-100 px-2 py-0.5 text-[10px] font-medium text-light-500 dark:bg-dark-700 dark:text-dark-400">
            {styleCodes.length}
          </span>
        </div>
        <CollectionToolbar
          testId="style-codes-toolbar"
          scope={codeScope}
          onScopeChange={setCodeScope}
          scopeLabels={["All", "Starred"]}
          selectedCount={starredCount}
          sort={codeSort}
          sortOptions={COLLECTION_SORT_OPTIONS}
          onSortChange={setCodeSort}
          query={codeQuery}
          onQueryChange={setCodeQuery}
          searchPlaceholder="Search codes, names, tags…"
          searchAriaLabel="Search style codes"
          primary={
            <ToolbarPrimaryButton
              onClick={openSrefPanel}
              ariaLabel="Add from Prompt"
              icon={<Plus className="h-4 w-4" />}
            >
              Add code
            </ToolbarPrimaryButton>
          }
        />

        {styleCodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <User className="h-10 w-10 text-light-300 dark:text-dark-500" />
            <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
              No saved style codes
            </p>
            <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
              Save style codes from the SREF panel while creating to manage them
              here.
            </p>
            <button
              onClick={openSrefPanel}
              className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Start Creating
            </button>
          </div>
        ) : visibleCodes.length === 0 ? (
          <p className="py-10 text-center text-sm text-light-500 dark:text-dark-400">
            {codeScope === "selected" && starredCount === 0
              ? "No starred codes yet. Tap the star on a code to keep it here."
              : "No style codes match your search."}
          </p>
        ) : (
          <div className="space-y-2">
            {visibleCodes.map((entry) => (
              <StyleCodeRow
                key={entry.code}
                entry={entry}
                isCopied={copiedCode === entry.code}
                onApply={() => handleApply(entry.code)}
                onCopy={() => handleCopy(entry.code)}
                onToggleFavorite={() => toggleStyleCodeFavorite(entry.code)}
                onRemove={() => removeStyleCode(entry.code)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function setSREFPanelOpen(open: boolean) {
  useStyleStore.getState().setSREFPanelOpen(open);
}

function StyleCodeRow({
  entry,
  isCopied,
  onApply,
  onCopy,
  onToggleFavorite,
  onRemove,
}: {
  entry: StyleCodeEntry;
  isCopied: boolean;
  onApply: () => void;
  onCopy: () => void;
  onToggleFavorite: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-input p-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
      <button
        onClick={onToggleFavorite}
        className="flex-shrink-0"
        aria-label={entry.isFavorite ? "Unfavorite" : "Favorite"}
      >
        <Star
          className={`w-4 h-4 transition-colors ${
            entry.isFavorite
              ? "text-yellow-500 fill-yellow-500"
              : "text-light-300 dark:text-dark-500 hover:text-yellow-500"
          }`}
        />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-light-primary dark:text-dark-primary truncate">
          {entry.name || entry.code.slice(0, 20)}
        </p>
        <p className="text-[10px] font-mono text-light-400 dark:text-dark-500 truncate">
          {entry.code}
        </p>
        {entry.tags && entry.tags.length > 0 && (
          <div className="flex gap-1 mt-1">
            {entry.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5 text-[10px] text-light-500 dark:text-dark-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="text-[10px] text-light-400 dark:text-dark-500 flex-shrink-0">
        {entry.useCount}×
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={onApply}
          className="px-2 py-1 rounded-md bg-splash/10 text-splash text-[10px] font-medium hover:bg-splash/20 transition-colors"
        >
          Apply
        </button>
        <button
          onClick={onCopy}
          className="p-1 rounded-md hover:bg-light-100 dark:hover:bg-dark-700 transition-colors"
          aria-label="Copy code"
        >
          {isCopied ? (
            <Check className="w-3.5 h-3.5 text-green-500" />
          ) : (
            <Copy className="w-3.5 h-3.5 text-light-400 dark:text-dark-500" />
          )}
        </button>
        <button
          onClick={onRemove}
          className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          aria-label="Remove code"
        >
          <Trash2 className="w-3.5 h-3.5 text-light-400 dark:text-dark-500 hover:text-red-500" />
        </button>
      </div>
    </div>
  );
}

// Defaults tab: edit generation defaults interactively

function DefaultsTab() {
  const settings = useUIStore((s) => s.settings);
  const updateSettings = useUIStore((s) => s.updateSettings);
  const resetSettings = useUIStore((s) => s.resetSettings);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-splash" />
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Default Generation Settings
          </h3>
        </div>
        <button
          onClick={resetSettings}
          className="px-2.5 py-1 rounded-lg border border-light-200 dark:border-dark-600 text-xs text-light-500 dark:text-dark-400 hover:bg-light-50 dark:hover:bg-dark-750 transition-[color,background-color] duration-150"
        >
          Reset to Defaults
        </button>
      </div>

      <div className="space-y-5">
        <SliderRow
          label="Stylize"
          hint="How strongly the AI applies artistic style"
          value={settings.stylize}
          min={0}
          max={1000}
          step={25}
          onChange={(v) => updateSettings({ stylize: v })}
        />

        <SliderRow
          label="Chaos"
          hint="Variety between the four grid images"
          value={settings.chaos}
          min={0}
          max={100}
          step={5}
          onChange={(v) => updateSettings({ chaos: v })}
        />

        <SliderRow
          label="Quality"
          hint="Generation quality — higher = slower but better detail"
          value={settings.quality}
          min={0.25}
          max={1}
          step={0.25}
          onChange={(v) => updateSettings({ quality: v })}
        />

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Model Mode
            </label>
            <span className="text-xs font-mono text-light-400 dark:text-dark-500">
              {settings.modelMode}
            </span>
          </div>
          <div className="flex gap-2">
            {(["Standard", "Raw"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => updateSettings({ modelMode: mode })}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-[color,background-color] duration-150 ${
                  settings.modelMode === mode
                    ? "bg-splash text-white"
                    : "bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary hover:bg-light-50 dark:hover:bg-dark-750"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-light-400 dark:text-dark-500">
            Standard applies default aesthetic; Raw reduces auto-beautification
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Speed
            </label>
            <span className="text-xs font-mono text-light-400 dark:text-dark-500">
              {settings.speed}
            </span>
          </div>
          <div className="flex gap-2">
            {SPEED_SETTINGS.map((speed) => (
              <button
                key={speed}
                onClick={() => updateSettings({ speed })}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-[color,background-color] duration-150 ${
                  settings.speed === speed
                    ? "bg-splash text-white"
                    : "bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary hover:bg-light-50 dark:hover:bg-dark-750"
                }`}
              >
                {speed}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-light-400 dark:text-dark-500">
            Draft is quicker, Quality takes longer. Standard keeps the model defaults.
          </p>
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-light-primary dark:text-dark-primary">
          {label}
        </label>
        <span className="text-xs font-mono text-light-400 dark:text-dark-500">
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-light-200 dark:bg-dark-600 accent-splash"
      />
      <p className="mt-1.5 text-[10px] text-light-400 dark:text-dark-500">
        {hint}
      </p>
    </div>
  );
}

// Presets tab: save/restore combinations of settings + style codes

interface Preset {
  id: string;
  name: string;
  createdAt: number;
  settings: {
    stylize: number;
    chaos: number;
    quality: number;
    modelMode: string;
    speed: string;
    privacy: string;
    personalize: boolean;
    aspect: string;
  };
  srefCodes?: string[];
}

const PRESETS_STORAGE_KEY = STORAGE_KEYS.presets;

function loadPresets(): Preset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalStorage(PRESETS_STORAGE_KEY);
    const list: Preset[] = raw ? JSON.parse(raw) : [];
    // Old presets: Relax/Fast/Turbo -> Quality/Standard/Draft, drop weird.
    return list.map((p) => ({
      ...p,
      settings: migratePresetSettings(p.settings ?? {}) as Preset["settings"],
    }));
  } catch {
    return [];
  }
}

function savePresets(presets: Preset[]) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // quota or private browsing — silently ignore
  }
}

function PresetsTab() {
  const settings = useUIStore((s) => s.settings);
  const sref = useStyleStore((s) => s.sref);
  const updateSettings = useUIStore((s) => s.updateSettings);
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [newPresetName, setNewPresetName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);

  const handleSave = useCallback(() => {
    if (!newPresetName.trim()) return;
    const preset: Preset = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: newPresetName.trim(),
      createdAt: Date.now(),
      settings: {
        stylize: settings.stylize,
        chaos: settings.chaos,
        quality: settings.quality,
        modelMode: settings.modelMode,
        speed: settings.speed,
        privacy: settings.privacy,
        personalize: settings.personalize,
        aspect: settings.aspect,
      },
      srefCodes: sref?.items
        .map((item) => item.resolved || item.value)
        .filter(Boolean),
    };
    const updated = [preset, ...presets];
    setPresets(updated);
    savePresets(updated);
    setNewPresetName("");
    setShowSaveForm(false);
  }, [newPresetName, settings, sref, presets]);

  const handleApply = useCallback(
    (preset: Preset) => {
      updateSettings({
        stylize: preset.settings.stylize,
        chaos: preset.settings.chaos,
        quality: preset.settings.quality,
        modelMode: preset.settings.modelMode as "Standard" | "Raw",
        speed: normalizeSpeedSetting(preset.settings.speed),
        privacy: preset.settings.privacy as "Public" | "Stealth",
        personalize: preset.settings.personalize,
        aspect: preset.settings.aspect,
      });
      if (preset.srefCodes && preset.srefCodes.length > 0) {
        appendToPrompt(` --sref ${preset.srefCodes.join(" ")}`);
      }
      setActiveNav("create");
    },
    [updateSettings, appendToPrompt, setActiveNav],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const updated = presets.filter((p) => p.id !== id);
      setPresets(updated);
      savePresets(updated);
    },
    [presets],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-splash" />
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Style Presets
          </h3>
          <span className="rounded-full bg-light-100 px-2 py-0.5 text-[10px] font-medium text-light-500 dark:bg-dark-700 dark:text-dark-400">
            {presets.length}
          </span>
        </div>
        <button
          onClick={() => setShowSaveForm(!showSaveForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3.5 h-3.5" />
          Save Current
        </button>
      </div>

      {showSaveForm && (
        <div className="rounded-xl border border-light-200 dark:border-dark-600 bg-light-input dark:bg-dark-input p-4 shadow-panel dark:shadow-panel-dark">
          <p className="text-xs text-light-500 dark:text-dark-400 mb-3">
            Save your current generation settings as a reusable preset.
          </p>
          <div className="flex items-center gap-2">
            <input
              aria-label="Preset name"
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Preset name..."
              className="flex-1 rounded-lg border border-light-200 dark:border-dark-600 bg-white dark:bg-dark-800 px-3 py-1.5 text-xs text-light-primary dark:text-dark-primary placeholder:text-light-400 dark:placeholder:text-dark-500 focus:outline-none focus:ring-1 focus:ring-splash"
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            <button
              onClick={handleSave}
              disabled={!newPresetName.trim()}
              className="px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Save
            </button>
            <button
              aria-label="Cancel saving preset"
              onClick={() => {
                setShowSaveForm(false);
                setNewPresetName("");
              }}
              className="p-1.5 rounded-lg hover:bg-light-100 dark:hover:bg-dark-700 transition-colors"
            >
              <X className="w-4 h-4 text-light-400 dark:text-dark-500" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-light-400 dark:text-dark-500">
            <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
              s={settings.stylize}
            </span>
            <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
              c={settings.chaos}
            </span>
            <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
              q={settings.quality}
            </span>
            <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
              {settings.modelMode}
            </span>
            <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
              {settings.speed}
            </span>
            {sref && sref.items.length > 0 && (
              <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                {STYLE_CODES_ENABLED ? "sref" : "style"} ×{sref.items.length}
              </span>
            )}
          </div>
        </div>
      )}

      {presets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Sparkles className="h-10 w-10 text-light-300 dark:text-dark-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            No presets saved yet
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            Save your current settings as a preset to quickly switch between
            different generation styles.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => (
            <div
              key={preset.id}
              className="rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-light-primary dark:text-dark-primary truncate">
                    {preset.name}
                  </h4>
                  <div className="flex flex-wrap gap-1.5 mt-1.5 text-[10px] text-light-400 dark:text-dark-500">
                    <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                      s={preset.settings.stylize}
                    </span>
                    <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                      c={preset.settings.chaos}
                    </span>
                    <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                      {preset.settings.modelMode}
                    </span>
                    <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                      {preset.settings.speed}
                    </span>
                    {preset.srefCodes && preset.srefCodes.length > 0 && (
                      <span className="rounded bg-light-100 dark:bg-dark-700 px-1.5 py-0.5">
                        {STYLE_CODES_ENABLED ? "sref" : "style"} ×{preset.srefCodes.length}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[10px] text-light-400 dark:text-dark-500">
                    {new Date(preset.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => handleApply(preset)}
                    className="px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:opacity-90 transition-opacity"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => handleRemove(preset.id)}
                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    aria-label="Delete preset"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-light-400 dark:text-dark-500 hover:text-red-500" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PersonalizePage;
