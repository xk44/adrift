"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  LayoutGrid,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { useIntegrations } from "@/hooks/useIntegrations";
import {
  buildToolCards,
  getActionTool,
  OUTPAINT_CARD_KEY,
  resolveOutpaintTool,
  type CatalogTool,
  type EditLoraListResponse,
  type ModelStatusResponse,
} from "@/lib/tools/toolsPage";
import {
  buildHubCards,
  COLOR_GRADE_KEY,
  filterHubCards,
  groupHubCards,
  HUB_CATEGORIES,
  HUB_CATEGORY_LABELS,
  HUB_CATEGORY_NOTES,
  SOUL_CAST_KEY,
  CHARACTER_PROFILES_KEY,
  STYLE_PRESETS_KEY,
  STORYBOARD_KEY,
  type HubCard,
  type HubCategory,
  type HubGroup,
} from "@/lib/tools/hub";
import {
  countByCategory,
  featuredCards,
  featuredLayout,
  isNewCard,
  searchWithTool,
  spreadHueSlots,
  toolFromSearch,
} from "@/lib/tools/hubVisuals";
import { getApp } from "@/lib/tools/apps";
import { setupHint } from "@/lib/tools/setupHint";
import { getTemplate, type EngineContext } from "@/lib/tools/templates";
import { ToolRunner } from "./ToolRunner";
import { SceneChip } from "./SceneChip";
import { TemplateRunner } from "./TemplateRunner";
import { AppRunner } from "./AppRunner";
import { ColorGrade } from "./ColorGrade";
import { MotionDesigner } from "./MotionDesigner";
import { MOTION_DESIGNER_KEY } from "@/lib/tools/motionCard";
import { TrainIdentity } from "./TrainIdentity";
import { TRAIN_IDENTITY_KEY } from "@/lib/tools/trainIdentityCard";
import { TrainAudioLora } from "./TrainAudioLora";
import { TRAIN_AUDIO_LORA_KEY } from "@/lib/tools/audioLoraCard";
import { SoulCast } from "./SoulCast";
import { CharacterProfiles } from "./CharacterProfiles";
import { StylePresets } from "./StylePresets";
import { StoryboardRunner } from "./StoryboardRunner";
import { PipelineRunner } from "./PipelineRunner";
import { ClipCutRunner } from "./ClipCutRunner";
import { DubRunner } from "./DubRunner";
import { VoiceChangerRunner } from "./VoiceChangerRunner";
import { OverlayRunner } from "./OverlayRunner";
import { HairDeckRunner } from "./HairDeckRunner";
import { HAIRDECK_KEY } from "@/lib/hairdeck/config";
import { StitchRunner } from "./StitchRunner";
import { STITCH_CLIPS_KEY } from "@/lib/tools/stitchClips";
import { GridVideoRunner } from "./GridVideoRunner";
import { GRID_VIDEO_KEY } from "@/lib/tools/gridVideo";
import { MusicVideoRunner } from "./MusicVideoRunner";
import { MUSIC_VIDEO_KEY } from "@/lib/tools/musicVideo";
import { BoardRunner } from "./BoardRunner";
import {
  BOARD_KEY,
  CLICK_TO_AD_KEY,
  CLIPCUT_KEY,
  DUB_VIDEO_KEY,
  OVERLAY_COMPOSITE_KEY,
  SHORTS_STUDIO_KEY,
  URBAN_CUTS_KEY,
  VOICE_CHANGER_KEY,
} from "@/lib/tools/pipelineCards";
import { ltxShotForKey } from "@/lib/tools/ltxShots";
import { PRODUCT_STUDIO_KEY } from "@/lib/tools/productStudio";
import { ProductStudioRunner } from "./ProductStudioRunner";
import { flux3ShotForKey } from "@/lib/tools/flux3Shots";
import { H3_ATTRIBUTION, isH3Model } from "@/lib/tools/h3License";
import { RunnerCardContext, ToolCover } from "./ToolCover";
import { repeatedPreviews } from "@/lib/tools/toolPreviews";
import { SetupToolButton } from "./SetupDrawer";
import { ReadinessInfo } from "./ReadinessInfo";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import {
  filterOpenWeights,
  openWeightsSummary,
  weightsClass,
  weightsSources,
  weightsTooltip,
} from "@/lib/tools/openWeights";
import { badgeLinks } from "@/lib/tools/licenseBadges";
import {
  OpenWeightsToggle,
  WeightsChip,
  useOpenWeightsOnly,
} from "./OpenWeightsFilter";
import { chipRowKeyDown, revealScrollLeft, useScrollFade } from "./useScrollFade";
import { isGridCard, mediaVariants } from "@/lib/tools/toolRegistry";
import { MediaVariantSwitch } from "./MediaVariantSwitch";
import {
  engineGroupOf,
  engineOptions,
  foldEngineGroups,
} from "@/lib/tools/engineGroups";
import { isLtxCard, withLtxListings } from "@/lib/tools/ltxShowcase";
import { EngineVariantSwitch } from "./EngineVariantSwitch";
import {
  NOT_CHECKED_HINT,
  readinessDetail,
  readinessLine,
  toolsReadiness,
} from "@/lib/tools/toolsReadiness";
import { StateView } from "@/components/ui/StateView";
import { showToast } from "@/components/Toast";
import {
  ImportWorkflowButton,
  MyToolsSection,
  UserToolRunner,
  useReturnToListOnImport,
  userToolDeepLinkKey,
} from "./userTools";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Sections shown as "Apps" collections (one-click recipes) after the tool
 * sections: a row each while browsing, a grid once picked or searched.
 */
const APP_SECTIONS: ReadonlySet<HubCategory> = new Set<HubCategory>([
  "Ads",
  "Portraits",
  "Characters",
  "Styles",
  "Scenes",
]);
const TOOL_RAIL = HUB_CATEGORIES.filter((c) => !APP_SECTIONS.has(c));
const APP_RAIL = HUB_CATEGORIES.filter((c) => APP_SECTIONS.has(c));

/** Tab look shared with Explore: quiet text, filled only when active. */
function railTabClass(on: boolean): string {
  return `flex h-8 flex-shrink-0 snap-start items-center gap-1 rounded-full px-3 text-[13px] transition-[background-color,color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-splash active:scale-[0.96] disabled:opacity-35 ${
    on
      ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
      : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
  }`;
}

export function ToolsPage({
  allowKeys,
}: {
  /** Judge mode: only these hub cards; no import/board/my-tools. */
  allowKeys?: ReadonlySet<string>;
} = {}) {
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [packIds, setPackIds] = useState<Set<string> | null>(null);
  const [editLoras, setEditLoras] = useState<EditLoraListResponse | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  // Every tools endpoint failed: the server is unreachable (not "no tools").
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [tools, packs, loras, models] = await Promise.all([
      getJson<{ ok: boolean; tools: CatalogTool[] }>("/api/tools"),
      getJson<{ packs: { id: string }[] }>("/api/oj/packs"),
      getJson<EditLoraListResponse>("/api/krea2-edit-loras"),
      getJson<{ ok: boolean } & ModelStatusResponse>("/api/tools/model-status"),
    ]);
    setCatalog(tools?.ok ? tools.tools : []);
    setPackIds(packs ? new Set(packs.packs.map((p) => p.id)) : null);
    setEditLoras(loras);
    setModelStatus(
      models?.ok ? { tools: models.tools } : { tools: {}, failed: true },
    );
    setLoadFailed(!tools && !packs && !loras && !models);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  const [query, setQuery] = useState("");
  // The card grid re-filters against a deferred copy so typing never lags.
  const deferredQuery = useDeferredValue(query);
  const [only, setOnly] = useState<HubCategory | null>(null);

  const describeAvailable = useIntegrations().styleVault;
  const toolCards = useMemo(
    () =>
      buildToolCards({
        catalog,
        packIds,
        editLoras,
        modelStatus,
        describeAvailable,
      }),
    [catalog, packIds, editLoras, modelStatus, describeAvailable],
  );
  const ctx = useMemo<EngineContext>(
    () => ({ catalog, packIds, editLoras }),
    [catalog, packIds, editLoras],
  );
  const cards = useMemo(() => {
    const all = buildHubCards({ toolCards, ctx, modelStatus });
    return allowKeys ? all.filter((c) => allowKeys.has(c.key)) : all;
  }, [toolCards, ctx, modelStatus, allowKeys]);
  // One card per capability on the grid (media variants and engine
  // variants fold into one).
  const gridCards = useMemo(
    () =>
      allowKeys
        ? cards
        : foldEngineGroups(cards).filter((c) => isGridCard(c.key)),
    [cards, allowKeys],
  );
  const [openOnly, setOpenOnly] = useOpenWeightsOnly();
  // LTX VFX also lists the LTX tools homed in other sections (grid copies
  // that open the real tool); readiness and open-weights stats stay on
  // gridCards so nothing counts twice.
  const pool = useMemo(
    () => filterOpenWeights(withLtxListings(gridCards, cards), openOnly),
    [gridCards, cards, openOnly],
  );
  const openSummary = useMemo(() => openWeightsSummary(gridCards), [gridCards]);
  const matched = useMemo(
    () => filterHubCards(pool, deferredQuery),
    [pool, deferredQuery],
  );
  const groups = useMemo(() => groupHubCards(matched, only), [matched, only]);
  // Empty result with "Commercial use OK" on: how many matches it hides, so
  // the empty state can say the filter (not the search) is the reason.
  const hiddenByLicense = useMemo(() => {
    if (!openOnly || groups.length > 0) return 0;
    const all = filterHubCards(withLtxListings(gridCards, cards), deferredQuery);
    return groupHubCards(all, only).reduce((n, g) => n + g.cards.length, 0);
  }, [openOnly, groups.length, gridCards, cards, deferredQuery, only]);
  const toolGroups = groups.filter((g) => !APP_SECTIONS.has(g.category));
  const appGroups = groups.filter((g) => APP_SECTIONS.has(g.category));
  const counts = useMemo(() => countByCategory(matched), [matched]);
  const featured = useMemo(() => featuredCards(pool), [pool]);
  const featuredShape = featuredLayout(featured.length);
  const featuredHues = useMemo(
    () => spreadHueSlots(featured.map((c) => c.key)),
    [featured],
  );
  const readiness = useMemo(
    () =>
      toolsReadiness(gridCards, loadFailed || Boolean(modelStatus?.failed)),
    [gridCards, loadFailed, modelStatus],
  );
  const retry = () => {
    setLoaded(false);
    void load();
  };
  const browsing = !deferredQuery.trim() && !only;
  const tabsFade = useScrollFade<HTMLDivElement>(48);
  // The category row is one scrolling line at every width: keep the active
  // chip in view (deep links, search narrowing, keyboard picks).
  const tabsEl = useRef<HTMLDivElement | null>(null);
  const setTabsEl = useCallback(
    (el: HTMLDivElement | null) => {
      tabsEl.current = el;
      tabsFade.ref(el);
    },
    [tabsFade.ref],
  );
  useEffect(() => {
    const row = tabsEl.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const left = revealScrollLeft(row, chip, 48);
    if (left === null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
  }, [only, loaded]);
  const featuredFade = useScrollFade<HTMLDivElement>();
  const selectedCard = cards.find((c) => c.key === selected) ?? null;

  // `?tool=<key>` deep link: open on load, kept in sync while a runner is
  // open. replaceState only, so the app's own nav history is untouched.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || cards.length === 0) return;
    const wanted = new URLSearchParams(window.location.search).get("tool");
    if (!wanted) {
      deepLinked.current = true;
      return;
    }
    const key = toolFromSearch(
      window.location.search,
      cards.map((c) => c.key),
    ) ?? userToolDeepLinkKey(wanted);
    // Catalog-backed cards arrive after the first render: keep waiting
    // until the requested card exists instead of latching on the first list.
    // Once the catalog has loaded (and the server answered) an unknown key
    // is not coming: say so and drop the param instead of silently ignoring.
    if (!key) {
      if (loaded && !loadFailed) {
        deepLinked.current = true;
        showToast("Tool not installed", "info");
        syncUrl(null);
      }
      return;
    }
    deepLinked.current = true;
    setSelected(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, loaded, loadFailed]);
  const syncUrl = (key: string | null) => {
    try {
      const next = searchWithTool(window.location.search, key);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${next}${window.location.hash}`,
      );
    } catch {
      /* sandboxed history */
    }
  };
  const open = (key: string) => {
    setSelected(key);
    syncUrl(key);
  };

  // Overlay Tools launcher hand-off: open the requested card once it exists.
  const pendingToolKey = useOverlayToolsStore((s) => s.pendingToolKey);
  useEffect(() => {
    if (!pendingToolKey) return;
    if (
      !pendingToolKey.startsWith("user:") &&
      !cards.some((c) => c.key === pendingToolKey)
    ) {
      // Catalog cards arrive after the first load; give up once loaded.
      if (loaded) useOverlayToolsStore.getState().consumePendingTool();
      return;
    }
    useOverlayToolsStore.getState().consumePendingTool();
    open(pendingToolKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingToolKey, cards, loaded]);
  const back = () => {
    setSelected(null);
    syncUrl(null);
  };
  useReturnToListOnImport(selected, back);

  if (selected?.startsWith("user:") && !allowKeys) {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <UserToolRunner id={selected.slice("user:".length)} onBack={back} />
      </div>
    );
  }

  if (selectedCard) {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <RunnerCardContext.Provider value={selectedCard}>
          <SelectedRunner
            card={selectedCard}
            toolCards={toolCards}
            hubCards={cards}
            catalog={catalog}
            editLoras={editLoras}
            ctx={ctx}
            modelStatus={modelStatus}
            onBack={back}
            onOpen={open}
          />
        </RunnerCardContext.Provider>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col min-w-0 overflow-hidden"
      data-testid="tools-hub"
    >
      <header className="flex-shrink-0 space-y-3 px-4 pb-2 pt-4 sm:px-6 sm:pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance text-light-primary dark:text-dark-primary">
              Tools
            </h1>
            <div className="mt-0.5 min-h-4 text-xs text-pretty text-light-500 dark:text-dark-400">
              {loaded && (
                <>
                  <span
                    className={`tabular-nums ${readiness.offline ? "text-amber-600 dark:text-amber-400" : ""}`}
                    data-testid="tools-readiness"
                    title={readinessDetail(readiness)}
                  >
                    {readinessLine(readiness)}
                  </span>
                </>
              )}
              {/* Stays mounted through Recheck (loaded flips false) so the
                  panel doesn't close under the user's finger. */}
              <ReadinessInfo
                readiness={readiness}
                cards={gridCards}
                onOpen={open}
                onRecheck={retry}
                rechecking={!loaded}
              />
            </div>
            {loaded && !allowKeys && (
              <div className="mt-1.5 -ml-1">
                <OpenWeightsToggle
                  on={openOnly}
                  onChange={setOpenOnly}
                  summary={openSummary}
                />
              </div>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:max-w-xl sm:flex-nowrap">
            {!allowKeys && (
            <button
              type="button"
              onClick={() => open(BOARD_KEY)}
              data-testid="tools-open-board"
              title="Chain tools on a board"
              className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-light-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-[background-color,transform] duration-150 hover:bg-light-input focus:outline-none focus-visible:ring-2 focus-visible:ring-splash active:scale-[0.96] dark:text-dark-primary dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input"
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Board
            </button>
            )}
            {!allowKeys && <ImportWorkflowButton onSaved={open} />}
            {!allowKeys && <SceneChip />}
            <div className="relative min-w-[11rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-500 dark:text-dark-400" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tools, apps, models"
                aria-label="Search tools"
                data-testid="tools-search"
                className="h-9 w-full rounded-full bg-light-input py-2 pl-8 pr-9 text-sm text-light-primary placeholder:text-light-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-2 focus:ring-splash dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-400 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-light-500 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:text-dark-primary"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div
          ref={setTabsEl}
          style={tabsFade.style}
          onKeyDown={chipRowKeyDown}
          className="relative -mx-4 flex snap-x snap-proximity scroll-px-4 gap-1 overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Category"
          data-testid="tools-categories"
          data-tour="tools-categories"
        >
          {[null, ...TOOL_RAIL].map((cat) => (
            <RailTab
              key={cat ?? "all"}
              cat={cat}
              on={only === cat}
              n={cat ? counts[cat] : counts.all}
              onPick={setOnly}
            />
          ))}
          <span
            aria-hidden
            className="mx-2 h-4 w-px flex-shrink-0 self-center bg-[var(--border-primary)]"
          />
          {APP_RAIL.map((cat) => (
            <RailTab
              key={cat}
              cat={cat}
              on={only === cat}
              n={counts[cat]}
              onPick={setOnly}
            />
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-28 pt-4 sm:px-6 sm:pb-12">
        <div className="mx-auto max-w-[1600px] space-y-12">
          {!loaded && <HubSkeleton />}
          {loaded && loadFailed && (
            <StateView
              status="error"
              compact
              title="Couldn't reach the Adrift server"
              message="Tools are listed, but nothing can be checked or run until the server answers. Check that it is running."
              onRetry={retry}
            />
          )}
          {loaded && groups.length === 0 && (
            <div
              role="status"
              className="flex flex-col items-center gap-2 py-16 text-center animate-fade-in"
            >
              <Search className="h-6 w-6 text-light-400 dark:text-dark-300" />
              <p className="text-sm text-light-primary dark:text-dark-primary">
                {deferredQuery.trim() ? (
                  <>No tools match &ldquo;{deferredQuery.trim()}&rdquo;</>
                ) : (
                  "Nothing in this category yet"
                )}
              </p>
              {hiddenByLicense > 0 ? (
                <p
                  className="text-xs text-light-500 dark:text-dark-400"
                  data-testid="tools-empty-license"
                >
                  &ldquo;Commercial use OK&rdquo; is on and hides{" "}
                  {hiddenByLicense === 1
                    ? "1 match"
                    : `${hiddenByLicense} matches`}{" "}
                  with license limits.
                </p>
              ) : (
                <p className="text-xs text-light-500 dark:text-dark-400">
                  Try a model name, or words like &ldquo;swap&rdquo;,
                  &ldquo;video&rdquo; or &ldquo;upscale&rdquo;.
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  if (hiddenByLicense > 0) {
                    setOpenOnly(false);
                    return;
                  }
                  setQuery("");
                  setOnly(null);
                  setOpenOnly(false);
                }}
                className="mt-1 h-8 rounded-full px-3.5 text-xs font-medium text-splash transition-[background-color,transform] duration-150 hover:bg-splash/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash active:scale-[0.96]"
              >
                {hiddenByLicense > 0 ? "Show them too" : "Show all tools"}
              </button>
            </div>
          )}
          {browsing && featured.length > 0 && (
            <section
              aria-label="Featured"
              data-tour="tools-featured"
              className="animate-fade-in [container-type:inline-size]"
            >
              <SectionHeading label="Featured" count={null} />
              {/* Phone: one swipe strip. Wider: auto-fill grid (minimum card
                  width holds when the dock narrows the page). Wide container:
                  bento, the lead card 2x2 beside four. */}
              <div
                ref={featuredFade.ref}
                style={featuredFade.style}
                className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden [@container(min-width:1000px)]:!grid-cols-4"
              >
                {featured.map((card, i) => (
                  <FeaturedCard
                    key={card.key}
                    card={card}
                    lead={i === 0 && featuredShape.lead}
                    bento={featuredShape.bento}
                    hueSlot={featuredHues.get(card.key)}
                    onOpen={() => open(card.openKey ?? card.key)}
                  />
                ))}
              </div>
            </section>
          )}
          {loaded && !allowKeys && (
            <MyToolsSection query={query} only={only} onOpen={open} />
          )}
          {toolGroups.map((group) => (
            <GridSection key={group.category} group={group} onOpen={open} />
          ))}
          {appGroups.length > 0 && browsing && (
            <div className="space-y-10" data-testid="tools-apps">
              <div className="pt-2">
                <h2 className="text-lg font-semibold tracking-[-0.01em] text-light-primary dark:text-dark-primary">
                  Apps
                </h2>
                <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
                  Pick a look, add a photo.
                </p>
              </div>
              {appGroups.map((group) => (
                <CollectionRow
                  key={group.category}
                  group={group}
                  onOpen={open}
                  onViewAll={() => setOnly(group.category)}
                />
              ))}
            </div>
          )}
          {!browsing &&
            appGroups.map((group) => (
              <GridSection key={group.category} group={group} onOpen={open} />
            ))}
        </div>
      </div>
    </div>
  );
}

function RailTab({
  cat,
  on,
  n,
  onPick,
}: {
  cat: HubCategory | null;
  on: boolean;
  n: number;
  onPick: (cat: HubCategory | null) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onPick(cat)}
      disabled={!on && n === 0}
      aria-label={`${cat ? HUB_CATEGORY_LABELS[cat] : "All"}, ${n} ${n === 1 ? "tool" : "tools"}`}
      className={railTabClass(on)}
    >
      <span className="whitespace-nowrap">
        {cat ? HUB_CATEGORY_LABELS[cat] : "All"}
      </span>
      <span className="text-[11px] tabular-nums opacity-70">{n}</span>
    </button>
  );
}

function SectionHeading({
  label,
  count,
  note,
  level = 2,
  action,
}: {
  label: string;
  count: number | null;
  note?: string;
  level?: 2 | 3;
  action?: React.ReactNode;
}) {
  const H = level === 3 ? "h3" : "h2";
  const heading = (
    <div
      className={`${note ? "mb-0.5" : "mb-3"} flex min-h-[1.5rem] items-baseline justify-between gap-3`}
    >
      <H className="flex items-baseline gap-2 text-[15px] font-medium text-light-primary dark:text-dark-primary">
        {label}
        {count !== null && (
          <span className="text-xs font-normal tabular-nums text-light-500 dark:text-dark-400">
            {count}
          </span>
        )}
      </H>
      {action}
    </div>
  );
  if (!note) return heading;
  return (
    <>
      {heading}
      <p
        data-testid="tools-section-note"
        className="mb-3 text-xs text-light-500 dark:text-dark-400"
      >
        {note}
      </p>
    </>
  );
}

/** One tool section: heading + image-first card grid. */
function GridSection({
  group,
  onOpen,
}: {
  group: HubGroup;
  onOpen: (key: string) => void;
}) {
  const keys = group.cards.map((c) => c.key);
  const repeats = repeatedPreviews(keys);
  const hues = spreadHueSlots(keys);
  return (
    <section aria-label={group.label} className="animate-fade-in">
      <SectionHeading
        label={group.label}
        count={group.cards.length}
        note={HUB_CATEGORY_NOTES[group.category]}
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-8 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {group.cards.map((card) => (
          <ToolCardButton
            key={card.key}
            card={card}
            noPreview={repeats.has(card.key)}
            hueSlot={hues.get(card.key)}
            onOpen={() => onOpen(card.openKey ?? card.key)}
          />
        ))}
      </div>
    </section>
  );
}

/** An Apps collection while browsing: one swipeable row + "View all". */
function CollectionRow({
  group,
  onOpen,
  onViewAll,
}: {
  group: HubGroup;
  onOpen: (key: string) => void;
  onViewAll: () => void;
}) {
  const fade = useScrollFade<HTMLDivElement>(48);
  const keys = group.cards.map((c) => c.key);
  const repeats = repeatedPreviews(keys);
  const hues = spreadHueSlots(keys);
  return (
    <section
      aria-label={group.label}
      className="animate-fade-in"
      data-testid={`tools-collection-${group.category}`}
    >
      <SectionHeading
        label={group.label}
        count={group.cards.length}
        note={HUB_CATEGORY_NOTES[group.category]}
        level={3}
        action={
          <button
            type="button"
            onClick={onViewAll}
            aria-label={`View all ${group.label}`}
            className="-mr-2 flex h-7 flex-shrink-0 items-center gap-0.5 rounded-full px-2 text-xs text-[var(--text-muted)] transition-[background-color,color] duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
          >
            View all
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        }
      />
      <div
        ref={fade.ref}
        style={fade.style}
        onKeyDown={chipRowKeyDown}
        className="-mx-4 flex snap-x snap-proximity scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:gap-4 sm:px-6 [&::-webkit-scrollbar]:hidden"
      >
        {group.cards.map((card) => (
          <div
            key={card.key}
            className="w-[44%] flex-shrink-0 snap-start sm:w-[220px] xl:w-[236px]"
          >
            <ToolCardButton
              card={card}
              noPreview={repeats.has(card.key)}
              hueSlot={hues.get(card.key)}
              onOpen={() => onOpen(card.openKey ?? card.key)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Small pill laid over a cover; dark glass so it reads on any image. */
function CoverPill({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "amber" | "new";
  title?: string;
}) {
  const cls =
    tone === "new"
      ? "bg-white/90 text-neutral-900"
      : tone === "amber"
        ? "bg-black/55 text-amber-300 backdrop-blur-md"
        : "bg-black/55 text-white/85 backdrop-blur-md";
  return (
    <span
      title={title}
      className={`rounded-full px-1.5 py-[3px] text-[10px] font-medium uppercase leading-none tracking-wide ${cls}`}
    >
      {children}
    </span>
  );
}

/** Available, but no model check backs it: a quiet "Beta" chip. */
function BetaChip() {
  return (
    <span
      title={`Beta: ${NOT_CHECKED_HINT}`}
      data-testid="tool-beta"
      className="inline-flex h-5 flex-shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium leading-none text-light-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:text-dark-400 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
    >
      Beta
    </span>
  );
}

/** Checked and installed: a quiet check, the word stays for screen readers. */
function ReadyMark() {
  return (
    <span
      title="Models installed and checked"
      data-testid="tool-ready"
      className="inline-flex h-5 flex-shrink-0 items-center text-emerald-700/80 dark:text-emerald-400/80"
    >
      <Check className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span className="sr-only">Ready</span>
    </span>
  );
}

/** Revealed on hover where the device can hover; always shown on touch. */
const HOVER_REVEAL =
  "transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100";

function CoverBadges({ card }: { card: HubCard }) {
  const placeholder = card.kind === "placeholder";
  const ltx = isLtxCard(card);
  // Only "what is it" badges sit on the cover. License (NC) and "not tested
  // yet" are status, shown as words in the card body; they used to share
  // this slot with NEW and read as the same kind of label.
  if (!isNewCard(card) && !placeholder && !ltx) return null;
  return (
    <span
      className={`pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1 ${
        placeholder ? "" : HOVER_REVEAL
      }`}
    >
      {ltx && <CoverPill title="Runs on LTX-2.5">LTX</CoverPill>}
      {isNewCard(card) && <CoverPill tone="new">New</CoverPill>}
      {placeholder && <CoverPill>Soon</CoverPill>}
    </span>
  );
}

function FeaturedCard({
  card,
  onOpen,
  hueSlot,
  lead = false,
  bento = false,
}: {
  card: HubCard;
  onOpen: () => void;
  hueSlot?: number;
  /** First card: spans two columns (and two rows in the bento layout). */
  lead?: boolean;
  bento?: boolean;
}) {
  const disabled = !card.available && !card.checking;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`tool-featured-${card.key}`}
      aria-disabled={disabled}
      title={disabled ? (card.unavailableReason ?? undefined) : undefined}
      className={`group relative aspect-[16/10] w-[82%] flex-shrink-0 snap-start overflow-hidden rounded-xl text-left transition-transform duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-splash focus-visible:ring-offset-2 focus-visible:ring-offset-light-bg active:scale-[0.99] dark:focus-visible:ring-offset-dark-bg sm:w-auto ${
        lead ? "sm:col-span-2" : ""
      } ${
        lead && bento
          ? "[@container(min-width:1000px)]:row-span-2 [@container(min-width:1000px)]:aspect-auto"
          : ""
      }`}
    >
      <ToolCover
        card={card}
        size="lg"
        muted={disabled}
        hueSlot={hueSlot}
        className="absolute inset-0 h-full w-full rounded-xl pb-12 transition-[filter] duration-200 group-hover:brightness-110"
      />
      <CoverBadges card={card} />
      <span
        className={`pointer-events-none absolute inset-x-0 bottom-0 block rounded-b-xl bg-gradient-to-t from-black/75 via-black/30 to-transparent ${
          lead ? "p-4 pt-14 sm:p-5 sm:pt-16" : "p-3 pt-10 sm:p-3.5 sm:pt-12"
        }`}
      >
        <span
          className={`flex min-w-0 items-center gap-1 font-medium text-white ${
            lead ? "text-[17px] sm:text-xl" : "text-[15px]"
          }`}
        >
          <span className="truncate">{card.title}</span>
          <ArrowUpRight className="h-4 w-4 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-70" />
          {/* Same row as the title so the overlay never grows into the icon. */}
          {card.nc && (
            <span className="ml-auto flex-shrink-0 whitespace-nowrap text-[10px] font-medium text-amber-200">
              Non-commercial
            </span>
          )}
        </span>
        {/* Lead card always says what it does; the others on hover. */}
        <span
          className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${
            lead
              ? "grid-rows-[1fr]"
              : "grid-rows-[1fr] [@media(hover:hover)]:grid-rows-[0fr] [@media(hover:hover)]:group-hover:grid-rows-[1fr] [@media(hover:hover)]:group-focus-visible:grid-rows-[1fr]"
          }`}
        >
          <span className="overflow-hidden">
            <span
              className={`mt-0.5 line-clamp-2 text-white/75 ${
                lead ? "max-w-md text-[13px]" : "text-xs"
              }`}
            >
              {card.subtitle}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}

/** Runner license line for an action card (catalog tools use their own). */
function hubLicenseNote(card: HubCard): string | null {
  const badge = weightsClass(card);
  if (badge === "open") return null;
  if (badge === "nc" && card.model)
    return `Non-commercial license (${card.model})`;
  return weightsTooltip(card).split("\n")[0];
}

/** Route a hub card to its runner. */
function SelectedRunner({
  card,
  toolCards,
  hubCards,
  catalog,
  editLoras,
  ctx,
  modelStatus,
  onBack,
  onOpen,
}: {
  card: HubCard;
  toolCards: ReturnType<typeof buildToolCards>;
  hubCards: HubCard[];
  catalog: CatalogTool[] | null;
  editLoras: EditLoraListResponse | null;
  ctx: EngineContext;
  modelStatus?: ModelStatusResponse | null;
  onBack: () => void;
  /** Open another hub card (Character Profiles "Use"). */
  onOpen?: (key: string) => void;
}) {
  if (card.kind === "catalog" || card.kind === "action") {
    const base = toolCards.find((c) => c.key === card.key);
    if (!base) return null;
    const variants = base.kind === "action" ? mediaVariants(base.id) : null;
    const engines = engineGroupOf(card.key);
    const runner = (
      <ToolRunner
        key={card.key}
        card={{ ...base, title: engines?.title ?? card.title }}
        catalogTool={
          base.kind === "catalog"
            ? base.key === OUTPAINT_CARD_KEY
              ? (resolveOutpaintTool(catalog) ?? undefined)
              : catalog?.find((t) => t.id === base.id)
            : undefined
        }
        actionSpec={base.kind === "action" ? getActionTool(base.id) : undefined}
        editLoras={editLoras}
        model={card.model}
        hubLicenseNote={hubLicenseNote(card)}
        hubLicenseLinks={badgeLinks(weightsSources(card))}
        onBack={onBack}
      />
    );
    const engineSwitch =
      engines && onOpen ? (
        <EngineVariantSwitch
          options={engineOptions(engines, hubCards)}
          active={card.key}
          onPick={onOpen}
        />
      ) : null;
    if (!variants || !onOpen)
      return engineSwitch ? (
        <>
          {engineSwitch}
          {runner}
        </>
      ) : (
        runner
      );
    return (
      <>
        {engineSwitch}
        <MediaVariantSwitch
          variants={variants}
          active={base.id}
          onPick={(id) => onOpen(`action:${id}`)}
        />
        {runner}
      </>
    );
  }
  if (card.kind === "template") {
    const t = getTemplate(card.id);
    return t ? (
      <TemplateRunner
        key={card.key}
        template={t}
        card={card}
        ctx={ctx}
        onBack={onBack}
      />
    ) : null;
  }
  if (card.kind === "app") {
    const app = getApp(card.id);
    return app ? (
      <AppRunner
        key={card.key}
        app={app}
        card={card}
        ctx={ctx}
        onBack={onBack}
      />
    ) : null;
  }
  if (card.key === COLOR_GRADE_KEY) return <ColorGrade onBack={onBack} />;
  if (card.key === MOTION_DESIGNER_KEY)
    return <MotionDesigner onBack={onBack} />;
  if (card.key === TRAIN_IDENTITY_KEY) return <TrainIdentity onBack={onBack} />;
  if (card.key === TRAIN_AUDIO_LORA_KEY) return <TrainAudioLora onBack={onBack} />;
  if (card.key === SOUL_CAST_KEY) return <SoulCast onBack={onBack} />;
  if (card.key === CHARACTER_PROFILES_KEY)
    return <CharacterProfiles onBack={onBack} onOpenTool={onOpen} />;
  if (card.key === STYLE_PRESETS_KEY) return <StylePresets onBack={onBack} />;
  if (card.key === STORYBOARD_KEY)
    return <StoryboardRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === PRODUCT_STUDIO_KEY)
    return <ProductStudioRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === SHORTS_STUDIO_KEY || card.key === CLICK_TO_AD_KEY)
    return (
      <PipelineRunner
        key={card.key}
        kind={card.key === CLICK_TO_AD_KEY ? "ad" : "shorts"}
        card={card}
        ctx={ctx}
        onBack={onBack}
      />
    );
  if (card.key === CLIPCUT_KEY || card.key === URBAN_CUTS_KEY)
    return (
      <ClipCutRunner
        key={card.key}
        variant={card.key === URBAN_CUTS_KEY ? "urban" : "studio"}
        card={card}
        ctx={ctx}
        onBack={onBack}
      />
    );
  if (card.key === DUB_VIDEO_KEY)
    return <DubRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === VOICE_CHANGER_KEY)
    return <VoiceChangerRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === OVERLAY_COMPOSITE_KEY)
    return <OverlayRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === HAIRDECK_KEY)
    return <HairDeckRunner card={card} onBack={onBack} />;
  if (card.key === STITCH_CLIPS_KEY)
    return <StitchRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === GRID_VIDEO_KEY)
    return <GridVideoRunner card={card} ctx={ctx} onBack={onBack} />;
  if (card.key === MUSIC_VIDEO_KEY)
    return (
      <MusicVideoRunner
        card={card}
        ctx={ctx}
        onBack={onBack}
        modelStatus={modelStatus}
      />
    );
  const ltxShot = ltxShotForKey(card.key) ?? flux3ShotForKey(card.key);
  if (card.key === BOARD_KEY || ltxShot)
    return (
      <BoardRunner
        key={card.key}
        card={card}
        hubCards={hubCards}
        editLoras={editLoras}
        onBack={onBack}
        recipe={ltxShot}
      />
    );
  return null;
}

function ToolCardButton({
  card,
  onOpen,
  noPreview = false,
  hueSlot,
}: {
  card: HubCard;
  onOpen: () => void;
  /** A sibling already shows this preview's subject: use the gradient. */
  noPreview?: boolean;
  hueSlot?: number;
}) {
  const placeholder = card.kind === "placeholder";
  const disabled = !card.available && !card.checking;
  const needsSetup = disabled && !placeholder;
  const unchecked = Boolean(card.unverified && card.available);
  const ready = card.available && !card.unverified && !card.checking;
  const hint = placeholder
    ? card.unavailableReason
    : setupHint(card.unavailableReason, card.model);
  // H3 attribution rides the model line, so the footer stays one row.
  const modelText = isH3Model(card.model) ? H3_ATTRIBUTION : card.model;
  return (
    <div className="group/card relative flex h-full min-w-0 flex-col">
      <button
        type="button"
        onClick={placeholder ? undefined : onOpen}
        disabled={placeholder}
        data-testid={`tool-card-${card.key}`}
        aria-disabled={disabled}
        title={disabled ? (card.unavailableReason ?? undefined) : undefined}
        className={`group flex h-full min-w-0 flex-1 flex-col gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-splash focus-visible:ring-offset-2 focus-visible:ring-offset-light-bg dark:focus-visible:ring-offset-dark-bg ${
          placeholder
            ? "cursor-not-allowed"
            : "transition-transform duration-150 ease-out active:scale-[0.98]"
        }`}
      >
        <span className="relative block w-full overflow-hidden rounded-lg">
          <ToolCover
            card={card}
            muted={disabled}
            noPreview={noPreview}
            hueSlot={hueSlot}
            className="aspect-[16/10] w-full rounded-lg transition-[filter] duration-200 group-hover:brightness-110"
          />
          <CoverBadges card={card} />
          {card.checking && (
            <Loader2 className="absolute right-2 top-2 h-3.5 w-3.5 animate-spin text-white/70" />
          )}
          {/* Pointer devices: what it does, revealed over the image. */}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 pb-2 pt-8 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:hover)]:block">
            <span className="line-clamp-2 text-[11px] leading-snug text-pretty text-white/90">
              {card.subtitle}
            </span>
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-0.5">
          <span
            className="truncate text-[13px] font-medium leading-snug text-light-primary dark:text-dark-primary"
            title={card.title}
          >
            {card.title}
          </span>
          {/* Touch: no hover, so one quiet line under the name instead. */}
          <span className="truncate text-[11px] leading-snug text-light-500 dark:text-dark-400 [@media(hover:hover)]:hidden">
            {card.subtitle}
          </span>
          <span
            className="mt-auto flex h-5 min-w-0 items-center gap-1.5 pt-0.5"
            data-testid="tool-card-footer"
          >
            {!placeholder && <WeightsChip card={card} />}
            {/* The model; what setup needs shows on hover/focus. */}
            <span className="relative hidden h-5 min-w-0 flex-1 text-[10px] leading-5 sm:block">
              <span
                className={`block truncate text-light-500 dark:text-dark-400 ${
                  needsSetup && hint
                    ? "transition-opacity duration-150 group-hover/card:opacity-0 group-focus-within/card:opacity-0"
                    : ""
                }`}
              >
                {modelText}
              </span>
              {needsSetup && hint && (
                <span className="absolute inset-x-0 top-0 block truncate text-amber-700 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100 dark:text-amber-300">
                  {hint}
                </span>
              )}
            </span>
            <span className="flex-1 sm:hidden" />
            {needsSetup ? (
              // Room for the Setup chip laid over this slot (a button can't
              // nest inside the card button).
              <span aria-hidden className="w-[52px] flex-shrink-0" />
            ) : unchecked ? (
              <BetaChip />
            ) : ready && !placeholder ? (
              <ReadyMark />
            ) : null}
          </span>
        </span>
      </button>
      {needsSetup && (
        <span className="absolute bottom-0 right-0.5 flex">
          <SetupToolButton card={card} compact hint={hint} />
        </span>
      )}
    </div>
  );
}

/** First-load placeholder: heading bar + a row of card shapes. */
function HubSkeleton() {
  return (
    <div
      role="status"
      aria-label="Checking installed tools"
      className="space-y-3 animate-pulse"
    >
      <div className="h-4 w-24 rounded-full bg-light-input dark:bg-dark-input" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-8 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="space-y-2">
            <div className="aspect-[16/10] w-full rounded-lg bg-light-input dark:bg-dark-input" />
            <div className="h-3 w-2/3 rounded-full bg-light-input dark:bg-dark-input" />
            <div className="h-2.5 w-1/2 rounded-full bg-light-input opacity-70 dark:bg-dark-input" />
          </div>
        ))}
      </div>
      <span className="sr-only">Checking installed tools...</span>
    </div>
  );
}
