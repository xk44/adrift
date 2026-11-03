"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Boxes, Download, FileJson, GitBranch } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, tabId, tabPanelId, type TabItem } from "@/components/ui/Tabs";
import {
  AliasManager,
  ImportExport,
  WorkflowManager,
} from "@/components/WorkflowsPage";
import { NAV_QUERY_EVENT } from "@/lib/navUrlSync";
import {
  SETUP_SECTIONS,
  SETUP_SECTION_LABELS,
  SETUP_TAB_LABELS,
  SETUP_TABS,
  parseSetupLocation,
  setupHref,
  type SetupLocation,
  type SetupTab,
} from "@/lib/setupUrl";

const PackBrowser = dynamic(
  () =>
    import("@/components/PackBrowser").then((m) => ({
      default: m.PackBrowser,
    })),
  { ssr: false },
);
const ParamReference = dynamic(
  () =>
    import("@/components/ParamReference").then((m) => ({
      default: m.ParamReference,
    })),
  { ssr: false },
);
const CivitaiModelBrowser = dynamic(
  () =>
    import("@/components/CivitaiModelBrowser").then((m) => ({
      default: m.CivitaiModelBrowser,
    })),
  { ssr: false },
);
const WorkflowPipelinePage = dynamic(
  () =>
    import("@/components/WorkflowPipelinePage").then((m) => ({
      default: m.WorkflowPipelinePage,
    })),
  { ssr: false },
);
const ManagerPage = dynamic(
  () =>
    import("@/components/ManagerPage").then((m) => ({
      default: m.ManagerPage,
    })),
  { ssr: false },
);

const TAB_ICONS: Record<SetupTab, TabItem["icon"]> = {
  workflows: FileJson,
  routing: GitBranch,
  nodes: Boxes,
  models: Download,
};

export const SETUP_TAB_ITEMS: readonly TabItem<SetupTab>[] = SETUP_TABS.map(
  (id) => ({ id, label: SETUP_TAB_LABELS[id], icon: TAB_ICONS[id] }),
);

/** One-line description under the tabs, per tab. */
export const SETUP_TAB_HINTS: Record<SetupTab, string> = {
  workflows: "Your saved ComfyUI workflows and the built-in workflow packs.",
  routing: "Pick which workflow runs when you press each button.",
  nodes: "Install the ComfyUI node packs that workflows need.",
  models: "Download models and give them short names for prompts.",
};

function readLocation(): SetupLocation {
  return parseSetupLocation(window.location.search);
}

/**
 * Setup: everything about how Adrift runs, in one place. Tabs are
 * Workflows / Button routing / Node packs / Models; `?tab=` and `?section=`
 * keep the view so links (and the old /workflows, /pipelines, /manager
 * URLs) land on the right spot.
 */
export function SetupPage() {
  // Client-only page (dynamic, ssr: false): the URL is readable at init.
  const [loc, setLoc] = useState<SetupLocation>(readLocation);
  // Bumped when an in-app link (e.g. "Get model" with a search) lands here
  // while Setup is open, so the view re-reads its query.
  const [linkNonce, setLinkNonce] = useState(0);

  useEffect(() => {
    const onPop = () => setLoc(readLocation());
    const onLink = () => {
      setLoc(readLocation());
      setLinkNonce((n) => n + 1);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener(NAV_QUERY_EVENT, onLink);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener(NAV_QUERY_EVENT, onLink);
    };
  }, []);

  // A tab or section change starts that view clean (drops the old view's
  // filters from the URL) and is Back-able.
  const go = useCallback((tab: SetupTab, section?: string) => {
    const href = setupHref(tab, section);
    if (window.location.pathname + window.location.search !== href) {
      window.history.pushState(null, "", href);
    }
    setLoc(parseSetupLocation(href.slice(href.indexOf("?") + 1)));
  }, []);

  const sections = SETUP_SECTIONS[loc.tab] as readonly string[];

  return (
    <div className="microScrollbar h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pb-10 md:px-6">
        <PageHeader
          align="left"
          title="Setup"
          subtitle="Workflows, button routing, node packs and models."
        />
        <div data-tour="setup-tabs">
          <Tabs
            items={SETUP_TAB_ITEMS}
            value={loc.tab}
            onChange={(tab) => go(tab)}
            ariaLabel="Setup sections"
            idPrefix="setup"
          />
        </div>
        <div
          role="tabpanel"
          id={tabPanelId("setup", loc.tab)}
          aria-labelledby={tabId("setup", loc.tab)}
          data-testid={`setup-panel-${loc.tab}`}
          className="pt-4"
        >
          <p className="mb-4 text-sm text-pretty text-[var(--text-tertiary)]">
            {SETUP_TAB_HINTS[loc.tab]}
          </p>
          {sections.length > 1 && (
            <div
              role="group"
              aria-label={`${SETUP_TAB_LABELS[loc.tab]} views`}
              className="noScrollbar mb-4 flex max-w-full gap-1 overflow-x-auto"
            >
              {sections.map((section) => {
                const active = section === loc.section;
                return (
                  <button
                    key={section}
                    type="button"
                    aria-pressed={active}
                    onClick={() => go(loc.tab, section)}
                    className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${
                      active
                        ? "bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]"
                        : "font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {SETUP_SECTION_LABELS[`${loc.tab}.${section}`] ?? section}
                  </button>
                );
              })}
            </div>
          )}
          <SetupView key={linkNonce} loc={loc} />
        </div>
      </div>
    </div>
  );
}

function SetupView({ loc }: { loc: SetupLocation }) {
  switch (`${loc.tab}.${loc.section}`) {
    case "workflows.packs":
      return <PackBrowser />;
    case "workflows.params":
      return <ParamReference />;
    case "workflows.import":
      return <ImportExport />;
    case "routing.slots":
      return <WorkflowPipelinePage />;
    case "nodes.templates":
      return <ManagerPage view="templates" />;
    case "nodes.packs":
      return <ManagerPage view="packs" />;
    case "models.download":
      return <CivitaiModelBrowser />;
    case "models.catalog":
      return <ManagerPage view="models" />;
    case "models.names":
      return <AliasManager />;
    case "workflows.saved":
    default:
      return <WorkflowManager />;
  }
}

export default SetupPage;
