"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { navigateTo, useNavParams } from "@/hooks";
import { useUIStore } from "@/store";
import type { StylesHubTab } from "@/types";
import { StylesBrowse } from "@/components/style/StylesBrowse";
import { StyleCreatorPanel } from "@/components/style/StyleCreatorPanel";
import { useStyleSessions } from "@/components/style/useStyleSessions";
import {
  creatorStateForNav,
  libraryViewForId,
  navForView,
  navParamsForView,
  seedFromCodes,
  seedFromLora,
  stylesHubTabForNav,
  viewForTab,
  type CreatorSeed,
  type StylesView,
} from "@/lib/stylesHub";

// Kept as a re-export: page.tsx and tests import it from here.
export { stylesHubTabForNav };

const views: { key: StylesView; label: string; tab: StylesHubTab }[] = [
  { key: "browse", label: "Browse", tab: "library" },
  { key: "datasets", label: "Datasets", tab: "boards" },
  { key: "map", label: "Map", tab: "map" },
  { key: "clusters", label: "Clusters", tab: "clusters" },
  { key: "images", label: "Images", tab: "images" },
  { key: "train", label: "Train", tab: "train" },
];

// Loaded on demand so Browse stays light.
const LibraryStatus = dynamic(
  () =>
    import("@/components/style/library/LibraryStatus").then((m) => ({
      default: m.LibraryStatus,
    })),
  { ssr: false },
);
const MapView = dynamic(
  () =>
    import("@/components/style/library/MapView").then((m) => ({
      default: m.MapView,
    })),
  { ssr: false },
);
const ClustersView = dynamic(
  () =>
    import("@/components/style/library/ClustersView").then((m) => ({
      default: m.ClustersView,
    })),
  { ssr: false },
);
const ImagesView = dynamic(
  () =>
    import("@/components/style/library/ImagesView").then((m) => ({
      default: m.ImagesView,
    })),
  { ssr: false },
);
const TrainView = dynamic(
  () =>
    import("@/components/style/library/TrainView").then((m) => ({
      default: m.TrainView,
    })),
  { ssr: false },
);

/**
 * The Styles page. Browse shows every style in one grid, with the creator
 * as a side panel that opens from "New style" or from any card. Datasets
 * (style boards) and the library views (Map, Clusters, Images, Train) are
 * full tools of their own.
 */
export function StylesHubPage({
  initialTab,
  datasets,
}: {
  initialTab?: StylesHubTab;
  datasets: React.ReactNode;
}) {
  const activeNav = useUIStore((s) => s.activeNav);
  const storedTab = useUIStore((s) => s.stylesHubTab);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);
  const { id } = useNavParams();
  const { sessions, createSession, updateSession, deleteSession } =
    useStyleSessions();
  const [seed, setSeed] = useState<CreatorSeed | null>(null);
  const nonceRef = useRef(0);

  useEffect(() => {
    if (initialTab) setStylesHubTab(initialTab);
  }, [initialTab, setStylesHubTab]);

  const view: StylesView =
    activeNav === "style-vault"
      ? libraryViewForId(id)
      : viewForTab(initialTab ?? storedTab);
  const creator = creatorStateForNav(activeNav, id);

  const openCreator = useCallback((next: CreatorSeed | null) => {
    setSeed(next);
    navigateTo("style-creator");
  }, []);

  const closeCreator = useCallback(() => {
    setSeed(null);
    navigateTo("library");
  }, []);

  const openSession = useCallback((sessionId: string | null) => {
    navigateTo("style-creator", sessionId ? { id: sessionId } : {});
  }, []);

  useEffect(() => {
    if (!creator.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Leave Escape to open dialogs (style detail, confirms).
      if (document.querySelector('[role="dialog"]')) return;
      closeCreator();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creator.open, closeCreator]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-primary)] px-4 py-2 sm:px-6"
        role="tablist"
        aria-label="Styles"
        data-tour="styles-views"
      >
        {views.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={view === item.key}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === item.key
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            onClick={() => {
              setStylesHubTab(item.tab);
              navigateTo(navForView(item.key), navParamsForView(item.key));
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {view === "browse" ? (
        <div className="flex min-h-0 flex-1">
          <StylesBrowse
            sessions={sessions}
            onCreate={(codes) =>
              openCreator(
                codes.length ? seedFromCodes(codes, ++nonceRef.current) : null,
              )
            }
            onCreateFromLora={(loraId) =>
              openCreator(seedFromLora(loraId, ++nonceRef.current))
            }
            onOpenSession={openSession}
          />
          {creator.open && (
            <StyleCreatorPanel
              sessionId={creator.sessionId}
              sessions={sessions}
              seed={seed}
              onClose={closeCreator}
              onStart={(prompt, imageIds) => {
                const newId = createSession(prompt || undefined, imageIds);
                setSeed(null);
                openSession(newId);
              }}
              onOpenSession={openSession}
              updateSession={updateSession}
              deleteSession={deleteSession}
            />
          )}
        </div>
      ) : view === "datasets" ? (
        datasets
      ) : (
        <div
          className="microScrollbar min-h-0 flex-1 overflow-y-auto p-6"
          data-testid={`styles-view-${view}`}
        >
          <div className="mx-auto max-w-5xl">
            {view === "train" ? (
              <TrainView />
            ) : (
              <LibraryStatus>
                {view === "map" ? (
                  <MapView />
                ) : view === "clusters" ? (
                  <ClustersView />
                ) : (
                  <ImagesView />
                )}
              </LibraryStatus>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
