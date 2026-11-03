"use client";

import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";
import { useMemo, useState, useCallback } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { useLikesStore } from "@/store/likesStore";
import { usePreferenceStore } from "@/store/preferenceStore";
import { navigateTo } from "@/hooks";
import { MediaThumb } from "@/components/organize/MediaThumb";
import { isStillImage, type MediaLike } from "@/lib/organize/organizeView";
import { HeroHeader, StatRow } from "@/components/PageHeader";
import { challengesDoneToday, plural, remainingPairs } from "@/lib/taskCards";
import {
  Trophy,
  BarChart3,
  ListTodo,
  Star,
  Clock,
  Flame,
  ChevronRight,
  Trash2,
  CheckCircle,
  Swords,
  Zap,
  ImageIcon,
  TrendingUp,
} from "lucide-react";

/** Simple deterministic daily seed from the date string. */
function dailySeed(): string {
  const d = new Date();
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  // FNV-1a hash
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/** Daily prompt themes — rotates based on day-of-year. */
const DAILY_THEMES = [
  "A crystal cave illuminated by bioluminescent mushrooms",
  "An ancient library floating among the clouds",
  "A cyberpunk street market at midnight rain",
  "A serene zen garden with cherry blossoms and koi",
  "A steampunk airship docked at a mountain peak",
  "An underwater city with coral architecture",
  "A desert oasis at golden hour with mirages",
  "A futuristic botanical garden on a space station",
  "A medieval forge inside a volcanic crater",
  "A cozy treehouse village in an enchanted forest",
  "An Art Deco train station in a parallel dimension",
  "A frozen tundra with aurora borealis and ice castles",
  "A whimsical candy factory with chocolate rivers",
  "A noir detective office with rain on the window",
  "A tribal festival around a massive bonfire",
  "A holographic concert in a neon-lit arena",
  "A quiet lighthouse during a dramatic storm",
  "An abandoned amusement park overrun by nature",
  "A floating island with waterfalls falling into the void",
  "A samurai duel under cherry blossom rain",
  "A planetary colony with twin suns setting",
  "A misty mountain monastery at dawn",
  "A vintage sci-fi control room with analog gauges",
  "A fairy ring clearing in a magical twilight",
  "An opulent ballroom with masked dancers",
  "A barren alien landscape with ancient ruins",
  "A pirate cove with treasure and a ghost ship",
  "A neon-lit ramen shop in a rainy alley",
  "A volcanic forge where dragons are born",
  "An ethereal cathedral made of pure light",
  "A snowbound village with warm glowing windows",
];

/** Completed-challenges persisted in localStorage for daily tracking parity. */
const COMPLETED_KEY = STORAGE_KEYS.completedChallenges;
function loadCompleted(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = readLocalStorage(COMPLETED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveCompleted(set: Set<string>) {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private browsing */
  }
}

type TaskTab = "compare" | "rankings" | "history" | "challenges";

export function TasksPage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const gallery = useGenerationStore((s) => s.gallery);
  const promptHistory = useGenerationStore((s) => s.promptHistory);
  const favoritePrompts = useGenerationStore((s) => s.favoritePrompts);
  const likedImages = useLikesStore((s) => s.likes);
  const rankingVotes = usePreferenceStore((s) => s.rankingVotes);
  const rankingStreak = usePreferenceStore((s) => s.rankingStreak);

  const [activeTab, setActiveTab] = useState<TaskTab>("compare");

  // Completed challenges tracked locally
  const [completedChallenges, setCompletedChallenges] =
    useState<Set<string>>(loadCompleted);

  const markChallengeCompleted = useCallback((key: string) => {
    setCompletedChallenges((prev) => {
      const next = new Set(prev);
      next.add(key);
      saveCompleted(next);
      return next;
    });
  }, []);

  // Card badges + stat row
  const stillIds = useMemo(
    () => gallery.filter((img) => isStillImage(img)).map((img) => img.id),
    [gallery],
  );
  const pairsLeft = useMemo(
    () => remainingPairs(stillIds, rankingVotes),
    [stillIds, rankingVotes],
  );
  const totalLiked = useMemo(
    () => gallery.filter((img) => img.liked).length + likedImages.length,
    [gallery, likedImages],
  );
  const doneToday = challengesDoneToday(dailySeed(), completedChallenges);

  if (activeNav !== "tasks") return null;

  const cards: Array<{
    key: TaskTab;
    icon: typeof Swords;
    title: string;
    description: string;
    badge: string;
    tone: string;
  }> = [
    {
      key: "compare",
      icon: Swords,
      title: "Compare",
      description:
        "Pick the stronger image from a pair. Every vote sharpens what Adrift thinks you like.",
      badge:
        stillIds.length < 2
          ? "Needs 2 images"
          : pairsLeft > 0
            ? `${plural(pairsLeft, "pair")} left`
            : "All caught up",
      tone: "bg-splash/10 text-splash",
    },
    {
      key: "rankings",
      icon: Trophy,
      title: "Rankings",
      description:
        "Everything you've liked across your gallery and Explore, gathered in one list.",
      badge: `${totalLiked} liked`,
      tone: "bg-amber-500/10 text-amber-500",
    },
    {
      key: "challenges",
      icon: ListTodo,
      title: "Daily challenges",
      description:
        "Three fresh prompts every day. Start one in Create, then mark it done.",
      badge: doneToday > 0 ? `${doneToday}/3 done today` : "3 new today",
      tone: "bg-emerald-500/10 text-emerald-500",
    },
    {
      key: "history",
      icon: BarChart3,
      title: "History",
      description:
        "Your favorite and recent prompts, ready to reuse with a single tap.",
      badge: plural(promptHistory.length + favoritePrompts.length, "prompt"),
      tone: "bg-sky-500/10 text-sky-500",
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="microScrollbar flex-1 overflow-y-auto px-4 pb-8 md:px-6">
        <div className="mx-auto max-w-4xl">
          <HeroHeader
            testId="tasks-hero"
            align="center"
            title="Tasks"
            lines={[
              "Sharpen Adrift's eye and your own: rank image pairs, revisit what you loved, and take on a fresh prompt every day.",
            ]}
          />

          <StatRow
            testId="tasks-stats"
            className="mb-6 justify-center"
            stats={[
              {
                label: "comparisons",
                value: rankingVotes.length,
                icon: <Zap className="h-3.5 w-3.5" />,
              },
              {
                label: rankingStreak === 1 ? "day streak" : "days streak",
                value: rankingStreak,
                icon: <TrendingUp className="h-3.5 w-3.5" />,
              },
              {
                label: "liked",
                value: totalLiked,
                icon: <Star className="h-3.5 w-3.5" />,
              },
              {
                label: "challenges done",
                value: completedChallenges.size,
                icon: <CheckCircle className="h-3.5 w-3.5" />,
              },
            ]}
          />

          <div
            role="tablist"
            aria-label="Task type"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            {cards.map(
              ({ key, icon: Icon, title, description, badge, tone }) => {
                const active = activeTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="tasks-panel"
                    onClick={() => setActiveTab(key)}
                    className={`group flex items-start gap-3 rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-splash/60 ${
                      active
                        ? "border-splash/60 bg-splash/[0.06] shadow-panel dark:shadow-panel-dark"
                        : "border-[var(--border-primary)] bg-[var(--bg-secondary)] hover:border-[var(--border-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <span
                      className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${tone}`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[15px] font-semibold text-light-primary dark:text-dark-primary">
                          {title}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                            active
                              ? "bg-splash text-white"
                              : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          }`}
                        >
                          {badge}
                        </span>
                      </span>
                      <span className="mt-1 block text-[13px] leading-snug text-pretty text-[var(--text-tertiary)]">
                        {description}
                      </span>
                    </span>
                    <ChevronRight
                      className={`mt-2.5 h-4 w-4 flex-shrink-0 transition-transform ${
                        active
                          ? "text-splash"
                          : "text-[var(--text-muted)] group-hover:translate-x-0.5"
                      }`}
                    />
                  </button>
                );
              },
            )}
          </div>

          <div
            id="tasks-panel"
            role="tabpanel"
            className="mx-auto mt-8 max-w-3xl border-t border-[var(--border-primary)] pt-6"
          >
            {activeTab === "compare" && <CompareSection gallery={gallery} />}
            {activeTab === "rankings" && (
              <RankingsSection likedImages={likedImages} gallery={gallery} />
            )}
            {activeTab === "history" && (
              <HistorySection
                promptHistory={promptHistory}
                favoritePrompts={favoritePrompts}
              />
            )}
            {activeTab === "challenges" && (
              <ChallengesSection
                completedChallenges={completedChallenges}
                onMarkCompleted={markChallengeCompleted}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Compare Section — community-style image-pair ranking

function CompareSection({
  gallery,
}: {
  gallery: (MediaLike & {
    id: string;
    url: string;
    prompt: string;
    hidden?: boolean;
  })[];
}) {
  const rankingVotes = usePreferenceStore((s) => s.rankingVotes);
  const addRankingVote = usePreferenceStore((s) => s.addRankingVote);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  const availableImages = useMemo(
    // Pairwise taste votes only make sense on stills: skip video, audio
    // and 3D outputs that share the gallery.
    () => gallery.filter((img) => isStillImage(img)),
    [gallery],
  );

  // Today's challenge prompt
  const dayIndex = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    return Math.floor(
      (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );
  }, []);

  const todayChallenge = DAILY_THEMES[dayIndex % DAILY_THEMES.length];

  // Build voted pair keys for dedup
  const votedPairKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const v of rankingVotes) {
      keys.add(`${v.imageA}|${v.imageB}`);
      keys.add(`${v.imageB}|${v.imageA}`);
    }
    return keys;
  }, [rankingVotes]);

  // Find next unvoted pair
  const pair = useMemo(() => {
    if (availableImages.length < 2) return null;
    const totalPairs =
      (availableImages.length * (availableImages.length - 1)) / 2;
    for (let attempt = 0; attempt < totalPairs; attempt++) {
      const offset = (rankingVotes.length + attempt) % totalPairs;
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
        if (!votedPairKeys.has(`${a.id}|${b.id}`)) {
          return { a, b };
        }
      }
    }
    return null;
  }, [availableImages, rankingVotes.length, votedPairKeys]);

  const handleVote = useCallback(
    (preferred: "a" | "b") => {
      if (!pair) return;
      addRankingVote({
        imageA: pair.a.id,
        imageB: pair.b.id,
        preferred,
        challengePrompt: todayChallenge,
      });
    },
    [pair, addRankingVote, todayChallenge],
  );

  const handleStartChallenge = () => {
    setPromptValue(todayChallenge);
    setActiveNav("create");
  };

  const notEnoughImages = availableImages.length < 2;
  const allPairsVoted = !notEnoughImages && !pair;

  return (
    <div className="space-y-6">
      {/* Today's challenge banner */}
      <div className="rounded-xl border border-splash/20 bg-splash/5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Flame className="w-4 h-4 text-splash" />
          <span className="text-[10px] font-medium text-splash">
            Today&apos;s challenge
          </span>
        </div>
        <p className="text-sm text-light-primary dark:text-dark-primary mb-3">
          {todayChallenge}
        </p>
        <button
          onClick={handleStartChallenge}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:opacity-90 transition-opacity"
        >
          Generate &amp; Compare
        </button>
      </div>

      {/* Comparison area */}
      {notEnoughImages ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <ImageIcon className="h-10 w-10 text-light-300 dark:text-dark-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            Not enough images to compare
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            Generate at least 2 images to start ranking. Try today&apos;s
            challenge prompt above!
          </p>
        </div>
      ) : allPairsVoted ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <CheckCircle className="h-10 w-10 text-green-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            All pairs ranked!
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            Generate more images to unlock new comparisons.
          </p>
          <button
            onClick={handleStartChallenge}
            className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Generate More
          </button>
        </div>
      ) : pair ? (
        <div className="space-y-4">
          <p className="text-xs text-center text-light-500 dark:text-dark-400">
            Which image is better? Click to vote.
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
        </div>
      ) : null}
    </div>
  );
}

// Rankings Section — shows liked/saved images from local gallery

function RankingsSection({
  likedImages,
  gallery,
}: {
  likedImages: {
    civitaiId: number;
    url: string;
    thumbnailUrl?: string;
    prompt: string;
  }[];
  gallery: (MediaLike & {
    id: string;
    url: string;
    prompt: string;
    liked?: boolean;
  })[];
}) {
  const toggleLiked = useGenerationStore((s) => s.toggleLiked);
  const likedFromGallery = gallery.filter((img) => img.liked);
  const totalLiked = likedFromGallery.length + likedImages.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-splash/10 text-splash">
          <Trophy className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
            Image Rankings
          </h2>
          <p className="text-xs text-pretty text-light-500 dark:text-dark-400">
            Images you&apos;ve liked — {totalLiked} total
          </p>
        </div>
      </div>

      {totalLiked === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Star className="h-10 w-10 text-light-300 dark:text-dark-500" />
          <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
            No liked images yet
          </p>
          <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-xs">
            Like images in the gallery or explore page to see them ranked here.
          </p>
          <button
            onClick={() => navigateTo("explore")}
            className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Explore Images
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {likedFromGallery.slice(0, 20).map((img) => (
            <div
              key={img.id}
              className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-input p-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
            >
              <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg">
                <MediaThumb item={img} compact badge={false} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-light-primary dark:text-dark-primary truncate">
                  {img.prompt.slice(0, 80)}
                  {img.prompt.length > 80 ? "..." : ""}
                </p>
              </div>
              <button
                onClick={() => toggleLiked(img.id)}
                className="p-1 rounded-md hover:bg-light-200 dark:hover:bg-dark-700 transition-colors flex-shrink-0"
                title="Unlike"
              >
                <Star className="w-4 h-4 text-splash fill-splash" />
              </button>
            </div>
          ))}
          {likedImages.slice(0, 10).map((img) => (
            <div
              key={`civ-${img.civitaiId}`}
              className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-input p-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.thumbnailUrl || img.url}
                alt=""
                className="h-10 w-10 rounded-lg object-cover flex-shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-light-primary dark:text-dark-primary truncate">
                  {img.prompt.slice(0, 80)}
                  {img.prompt.length > 80 ? "..." : ""}
                </p>
              </div>
              <Star className="w-4 h-4 text-splash flex-shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// History Section — shows prompt history & favorites

function HistorySection({
  promptHistory,
  favoritePrompts,
}: {
  promptHistory: string[];
  favoritePrompts: Array<{
    id: string;
    prompt: string;
    createdAt: number;
    name?: string;
  }>;
}) {
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const removeFavoritePrompt = useGenerationStore(
    (s) => s.removeFavoritePrompt,
  );
  const clearPromptHistory = useGenerationStore((s) => s.clearPromptHistory);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleReuse = (prompt: string) => {
    useUIStore.getState().setPromptValue(prompt);
    setActiveNav("create");
  };

  return (
    <div className="space-y-6">
      {/* Favorites */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Star className="w-4 h-4 text-splash" />
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Favorite Prompts
          </h3>
          <span className="rounded-full bg-light-100 px-2 py-0.5 text-[10px] font-medium text-light-500 dark:bg-dark-700 dark:text-dark-400">
            {favoritePrompts.length}
          </span>
        </div>
        {favoritePrompts.length === 0 ? (
          <p className="text-xs text-light-400 dark:text-dark-500 py-4 text-center">
            No favorite prompts yet. Star a prompt from your history to save it
            here.
          </p>
        ) : (
          <div className="space-y-2">
            {favoritePrompts.map((fp) => (
              <div
                key={fp.id}
                className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-input p-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
              >
                <Star className="w-4 h-4 text-splash flex-shrink-0" />
                <button
                  onClick={() => handleReuse(fp.prompt)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="text-xs text-light-primary dark:text-dark-primary truncate">
                    {fp.name || fp.prompt.slice(0, 100)}
                  </p>
                </button>
                <button
                  onClick={() => removeFavoritePrompt(fp.id)}
                  className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title="Remove from favorites"
                >
                  <Trash2 className="w-3 h-3 text-light-400 dark:text-dark-500 hover:text-red-500" />
                </button>
                <ChevronRight className="w-4 h-4 text-light-400 dark:text-dark-500 flex-shrink-0" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent History */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-light-500 dark:text-dark-400" />
          <h3 className="text-sm font-semibold text-light-primary dark:text-dark-primary">
            Recent Prompts
          </h3>
          <span className="rounded-full bg-light-100 px-2 py-0.5 text-[10px] font-medium text-light-500 dark:bg-dark-700 dark:text-dark-400">
            {promptHistory.length}
          </span>
          {promptHistory.length > 0 && !showClearConfirm && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="ml-auto text-[10px] text-light-400 dark:text-dark-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          )}
          {showClearConfirm && (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={() => {
                  clearPromptHistory();
                  setShowClearConfirm(false);
                }}
                className="text-[10px] text-red-500 hover:underline"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowClearConfirm(false)}
                className="text-[10px] text-light-400 dark:text-dark-500"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {promptHistory.length === 0 ? (
          <p className="text-xs text-light-400 dark:text-dark-500 py-4 text-center">
            No prompt history yet. Start creating to build your history.
          </p>
        ) : (
          <div className="space-y-1">
            {promptHistory.slice(0, 20).map((prompt, i) => (
              <button
                key={`${i}-${prompt.slice(0, 20)}`}
                onClick={() => handleReuse(prompt)}
                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-light-50 dark:hover:bg-dark-750 transition-[background-color] duration-150 group"
              >
                <span className="text-[10px] font-mono text-light-400 dark:text-dark-500 w-5 text-right flex-shrink-0">
                  {i + 1}
                </span>
                <p className="text-xs text-light-primary dark:text-dark-primary truncate flex-1">
                  {prompt}
                </p>
                <ChevronRight className="w-3 h-3 text-light-300 dark:text-dark-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Challenges Section — daily prompt challenges

function ChallengesSection({
  completedChallenges,
  onMarkCompleted,
}: {
  completedChallenges: Set<string>;
  onMarkCompleted: (key: string) => void;
}) {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);

  const dayIndex = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now.getTime() - start.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }, []);

  const seed = dailySeed();

  // Pick 3 prompts rotating daily
  const dailyPrompts = useMemo(() => {
    const base = dayIndex % DAILY_THEMES.length;
    return [
      DAILY_THEMES[base],
      DAILY_THEMES[(base + 7) % DAILY_THEMES.length],
      DAILY_THEMES[(base + 14) % DAILY_THEMES.length],
    ];
  }, [dayIndex]);

  const handleStartChallenge = (prompt: string) => {
    setPromptValue(prompt);
    setActiveNav("create");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-splash/10 text-splash">
          <ListTodo className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
            Daily Challenges
          </h2>
          <p className="text-xs text-pretty text-light-500 dark:text-dark-400">
            Fresh creative prompts every day — seed {seed}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {dailyPrompts.map((prompt, i) => {
          const challengeKey = `${seed}-${i}`;
          const isCompleted = completedChallenges.has(challengeKey);
          return (
            <div
              key={`challenge-${i}`}
              className={`rounded-xl border p-4 shadow-panel dark:shadow-panel-dark ${
                isCompleted
                  ? "border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-900/10"
                  : "border-light-100 bg-light-input dark:border-dark-750 dark:bg-dark-input"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {isCompleted ? (
                  <CheckCircle className="w-4 h-4 text-green-500" />
                ) : (
                  <Flame
                    className={`w-4 h-4 ${
                      i === 0
                        ? "text-orange-500"
                        : i === 1
                          ? "text-amber-500"
                          : "text-yellow-500"
                    }`}
                  />
                )}
                <span className="text-[10px] font-medium text-light-500 dark:text-dark-400">
                  {isCompleted
                    ? "Completed"
                    : i === 0
                      ? "Today"
                      : i === 1
                        ? "Alt 1"
                        : "Alt 2"}
                </span>
              </div>
              <p className="text-sm text-light-primary dark:text-dark-primary mb-3">
                {prompt}
              </p>
              <div className="flex items-center gap-2">
                {!isCompleted && (
                  <>
                    <button
                      onClick={() => handleStartChallenge(prompt)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:opacity-90 transition-opacity"
                    >
                      Start Creating
                    </button>
                    <button
                      onClick={() =>
                        handleStartChallenge(prompt + " --ar 16:9")
                      }
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary text-xs font-medium hover:bg-light-50 dark:hover:bg-dark-750 transition-[color,background-color] duration-150"
                    >
                      Widescreen
                    </button>
                  </>
                )}
                <button
                  onClick={() => onMarkCompleted(challengeKey)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-[color,background-color] duration-150 ${
                    isCompleted
                      ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/40"
                      : "bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary hover:bg-light-50 dark:hover:bg-dark-750"
                  }`}
                >
                  <CheckCircle className="w-3 h-3" />
                  {isCompleted ? "Done" : "Mark done"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TasksPage;
