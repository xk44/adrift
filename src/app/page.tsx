"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  useGenerationStore,
  useUIStore,
  useEditorStore,
  useOverlayStore,
} from "@/store";
import { useExploreStore } from "@/store/exploreStore";
import { useStyleStore } from "@/store/styleStore";
import {
  useComfyWS,
  useImagine,
  useInpaint,
  useNavSync,
  useOverlayMode,
} from "@/hooks";
import { Sidebar } from "@/components/Sidebar";
import { PromptBar } from "@/components/PromptBar";
import { Gallery } from "@/components/Gallery";
import { ExploreControls } from "@/components/ExploreControls";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OverlayTopBar } from "@/components/OverlayTopBar";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { LightboxUrlSync } from "@/hooks/useLightboxUrl";
import { isChromePage, isPromptBarDesktopOnly } from "@/lib/ui/shellChrome";
import { navShortcutMap, navigateToDestination } from "@/lib/ui/navRegistry";
import { isTypingTarget } from "@/lib/ui/typingTarget";
import { documentTitleFor, focusPageHeading } from "@/lib/ui/navAnnounce";
import {
  CONNECTION_BANNER_DISMISSED_KEY,
  errorBannerMode,
} from "@/lib/ui/connectionState";
import { useConnectionDownFor } from "@/hooks/useConnectionDownFor";
import { useUpscaleAfter } from "@/hooks/useUpscaleAfter";
import { isStylesNav, stylesHubTabForNav } from "@/lib/stylesHub";
import type { NavKey } from "@/types";
import { runReadyForGallery } from "@/lib/galleryMedia";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { OfflineCard } from "@/components/setup/OfflineCard";
import { CreateFailureNotice } from "@/components/setup/CreateFailureNotice";
import { SetupDialogHost } from "@/components/setup/SetupDialog";
import { RecipePanel } from "@/components/recipe/RecipePanel";
import { useFirstRunStatus } from "@/hooks/useFirstRunStatus";
import { showToast } from "@/components/Toast";
import { editFailureMessage } from "@/lib/ui/editErrors";
import { useThemeSync } from "@/lib/theme/useThemeSync";

const PULL_REFRESH_THRESHOLD = 72;
const PULL_REFRESH_MAX = 96;

const pageLabels: Partial<Record<NavKey, string>> = {
  create: "Create",
  edit: "Edit",
  explore: "Explore",
  organize: "Organize",
  library: "Styles",
  moodboards: "Moodboards",
  characters: "Characters",
  styles: "Styles",
  personalize: "Personalize",
  "style-creator": "Styles",
  tasks: "Tasks",
  tools: "Tools",
  profile: "Profile",
  "account-settings": "Settings",
  help: "Help",
  updates: "Updates",
  "style-vault": "Styles",
  setup: "Setup",
};

function PageErrorFallback({
  label,
  onReset,
}: {
  label: string;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-[var(--error)]" />
          <h2 className="text-base font-medium text-[var(--text-primary)]">
            {label} could not load
          </h2>
        </div>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          This view hit an unexpected error. Other views are still available.
        </p>
        <button
          onClick={onReset}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <RefreshCw className="h-4 w-4" />
          Try Again
        </button>
      </div>
    </div>
  );
}

/**
 * Boundary for one piece of app chrome (sidebar, prompt bar, tab bar,
 * banners). A crash there shows a one-line notice in place instead of
 * blanking the whole app; "Retry" remounts just that piece.
 */
function ShellBoundary({
  label,
  hidden = false,
  children,
}: {
  label: string;
  /** Render nothing on error (decorative chrome with no useful fallback). */
  hidden?: boolean;
  children: React.ReactNode;
}) {
  const [nonce, setNonce] = useState(0);
  return (
    <ErrorBoundary
      key={nonce}
      fallback={
        hidden ? (
          <></>
        ) : (
          <div
            role="alert"
            className="m-2 flex items-center gap-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]"
          >
            <AlertCircle className="h-4 w-4 flex-shrink-0 text-[var(--error)]" />
            <span className="flex-1">{label} hit an error.</span>
            <button
              type="button"
              onClick={() => setNonce((v) => v + 1)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              Retry
            </button>
          </div>
        )
      }
    >
      {children}
    </ErrorBoundary>
  );
}

// Lazy-loaded page components — only loaded when navigated to
const SettingsPanel = dynamic(
  () =>
    import("@/components/SettingsPanel").then((m) => ({
      default: m.SettingsPanel,
    })),
  { ssr: false },
);
const Lightbox = dynamic(
  () => import("@/components/Lightbox").then((m) => ({ default: m.Lightbox })),
  { ssr: false },
);
const ImageSelector = dynamic(
  () =>
    import("@/components/ImageSelector").then((m) => ({
      default: m.ImageSelector,
    })),
  { ssr: false },
);
const KeyboardHelp = dynamic(
  () =>
    import("@/components/KeyboardHelp").then((m) => ({
      default: m.KeyboardHelp,
    })),
  { ssr: false },
);
const CommandPalette = dynamic(
  () =>
    import("@/components/CommandPalette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false },
);
const DescribeDialog = dynamic(
  () =>
    import("@/components/DescribeDialog").then((m) => ({
      default: m.DescribeDialog,
    })),
  { ssr: false },
);
const OnboardingHost = dynamic(
  () =>
    import("@/components/onboarding/OnboardingHost").then((m) => ({
      default: m.OnboardingHost,
    })),
  { ssr: false },
);
const TourHost = dynamic(
  () =>
    import("@/components/tour/TourHost").then((m) => ({
      default: m.TourHost,
    })),
  { ssr: false },
);
const SetupPage = dynamic(
  () =>
    import("@/components/SetupPage").then((m) => ({
      default: m.SetupPage,
    })),
  { ssr: false },
);
const EditorPage = dynamic(
  () => import("@/components/editor").then((m) => ({ default: m.EditorPage })),
  { ssr: false },
);
const ExplorePage = dynamic(
  () =>
    import("@/components/ExplorePage").then((m) => ({
      default: m.ExplorePage,
    })),
  { ssr: false },
);
const OrganizePage = dynamic(
  () =>
    import("@/components/OrganizePage").then((m) => ({
      default: m.OrganizePage,
    })),
  { ssr: false },
);
const MoodboardsPage = dynamic(
  () =>
    import("@/components/MoodboardsPage").then((m) => ({
      default: m.MoodboardsPage,
    })),
  { ssr: false },
);
const DatasetBoardsPage = dynamic(
  () =>
    import("@/components/DatasetBoardsPage").then((m) => ({
      default: m.DatasetBoardsPage,
    })),
  { ssr: false },
);
const StylesHubPage = dynamic(
  () =>
    import("@/components/StylesHubPage").then((m) => ({
      default: m.StylesHubPage,
    })),
  { ssr: false },
);
const PersonalizePage = dynamic(
  () =>
    import("@/components/PersonalizePage").then((m) => ({
      default: m.PersonalizePage,
    })),
  { ssr: false },
);
const ProfilePage = dynamic(
  () =>
    import("@/components/ProfilePage").then((m) => ({
      default: m.ProfilePage,
    })),
  { ssr: false },
);
const AccountSettingsPage = dynamic(
  () =>
    import("@/components/AccountSettingsPage").then((m) => ({
      default: m.AccountSettingsPage,
    })),
  { ssr: false },
);
const HelpPage = dynamic(
  () => import("@/components/HelpPage").then((m) => ({ default: m.HelpPage })),
  { ssr: false },
);
const UpdatesPage = dynamic(
  () =>
    import("@/components/UpdatesPage").then((m) => ({
      default: m.UpdatesPage,
    })),
  { ssr: false },
);
const TasksPage = dynamic(
  () =>
    import("@/components/TasksPage").then((m) => ({ default: m.TasksPage })),
  { ssr: false },
);
const ToolsPage = dynamic(
  () =>
    import("@/components/tools/ToolsPage").then((m) => ({
      default: m.ToolsPage,
    })),
  { ssr: false },
);

export default function HomePage() {
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Hoisted out of the palette: it unmounts on close, which killed the dialog.
  const [describeOpen, setDescribeOpen] = useState(false);
  const [pageResetNonce, setPageResetNonce] = useState(0);
  const [settingsResetNonce, setSettingsResetNonce] = useState(0);
  const [modalResetNonce, setModalResetNonce] = useState(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const pullStartRef = useRef<{ x: number; y: number } | null>(null);
  const pullTrackingRef = useRef(false);

  // Overlay mode detection — when embedded in ComfyUI iframe
  const {
    isOverlay,
    requestHideOverlay,
    sendWorkflowToComfyUI,
    sendImageToComfyUI,
  } = useOverlayMode();

  // Overlay store state (most overlay UI state lives in OverlayTopBar)
  const acceptWorkflow = useOverlayStore((s) => s.acceptWorkflow);
  const bridgePhase = useOverlayStore((s) => s.bridgePhase);

  // Sync URL (pathname/hash) → activeNav store
  useNavSync();

  const { isConnected, reconnect } = useComfyWS({
    enabled: true,
    onConnect: () => console.log("[Page] WebSocket connected"),
    onDisconnect: () => console.log("[Page] WebSocket disconnected"),
  });
  useUpscaleAfter();

  // Sidebar status row requests reconnects via a window event (it has no
  // access to this hook instance)
  useEffect(() => {
    const handler = () => reconnect();
    window.addEventListener("cj:ws-reconnect", handler);
    return () => window.removeEventListener("cj:ws-reconnect", handler);
  }, [reconnect]);

  // Connection banner: only after a sustained outage (the sidebar dot covers
  // short blips), and a dismissal holds for the rest of the browser session.
  const connectionDownLong = useConnectionDownFor(isConnected);
  const { offline: comfyKnownOffline } = useFirstRunStatus();
  const [connBannerDismissed, setConnBannerDismissed] = useState(() => {
    try {
      return (
        typeof window !== "undefined" &&
        window.sessionStorage.getItem(CONNECTION_BANNER_DISMISSED_KEY) === "1"
      );
    } catch {
      return false;
    }
  });
  const dismissConnectionBanner = useCallback(() => {
    setConnBannerDismissed(true);
    try {
      window.sessionStorage.setItem(CONNECTION_BANNER_DISMISSED_KEY, "1");
    } catch {
      /* storage blocked — dismissal lasts until reload */
    }
  }, []);

  const {
    imagine,
    isLoading,
    lastError,
    lastFailure,
    clearError,
    addRunToGallery,
  } = useImagine({
      onSuccess: (runs) => {
        console.log("[Page] Generation queued:", runs.length, "runs");
      },
      onError: (error) => {
        console.error("[Page] Generation error:", error);
      },
    });

  const glassUI = useUIStore((s) => s.glassUI);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const lightbox = useUIStore((s) => s.lightbox);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const activeNav = useUIStore((s) => s.activeNav);
  const imageAttachmentsLocked = useUIStore((s) => s.imageAttachmentsLocked);
  const clearImageAttachments = useUIStore((s) => s.clearImageAttachments);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const storeError = useGenerationStore((s) => s.lastError);
  const errors = useGenerationStore((s) => s.errors);
  const bannerMode = errorBannerMode({
    message: lastError || storeError,
    isConnected,
    downLong: connectionDownLong,
    // The offline card already says it (immediately, with the fix).
    dismissed: connBannerDismissed || comfyKnownOffline,
  });

  const editorIsOpen = useEditorStore((s) => s.isOpen);

  // Apply theme (mode, palette, accent, browser chrome color) to document
  useThemeSync();

  // Apply Liquid Glass chrome flag to document
  useEffect(() => {
    document.documentElement.setAttribute("data-glass", glassUI ? "on" : "off");
  }, [glassUI]);

  useEffect(() => {
    if (!selectedWorkflowPath && defaultWorkflowPath) {
      setSelectedWorkflow(defaultWorkflowPath, defaultWorkflowName);
    }
  }, [
    selectedWorkflowPath,
    defaultWorkflowPath,
    defaultWorkflowName,
    setSelectedWorkflow,
  ]);

  // Lightbox "Use Image" dispatches this so the source image lands back in Create.
  useEffect(() => {
    const handleUseStartFrame = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          url?: string;
          filename?: string;
          runId?: string;
          jobIndex?: number;
          mode?: "starting_frame" | "image_prompt" | "style_ref";
        }>
      ).detail;
      if (!detail?.url) return;

      const mode = detail.mode ?? "starting_frame";
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${mode}-${Date.now()}`;

      useUIStore.getState().addImageAttachment({
        id,
        url: detail.url,
        filename:
          detail.filename ??
          (detail.runId != null
            ? `${detail.runId}-${detail.jobIndex ?? 0}.png`
            : `${mode}.png`),
        mode,
        weight: 1,
      });
      useUIStore.getState().setActiveNav("create");
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLTextAreaElement>("#desktop_input_bar")
          ?.focus();
      });
    };

    window.addEventListener("use-start-frame", handleUseStartFrame);
    return () =>
      window.removeEventListener("use-start-frame", handleUseStartFrame);
  }, []);

  // Image drag-to-ComfyUI: when in overlay mode, intercept drag events
  // on gallery images and send them to ComfyUI via the bridge
  useEffect(() => {
    if (!isOverlay || bridgePhase !== "ready") return;

    const handler = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      // Look for an img element or an element with data-filename
      const img = target.closest("[data-filename]") as HTMLElement | null;
      if (!img) return;

      const filename = img.getAttribute("data-filename");
      if (!filename) return;

      const subfolder = img.getAttribute("data-subfolder") ?? undefined;
      const type =
        (img.getAttribute("data-image-type") as
          "output" | "input" | "temp" | null) ?? "output";

      // Set drag data for visual feedback
      e.dataTransfer?.setData("text/plain", filename);

      sendImageToComfyUI(filename, subfolder, type);
    };

    document.addEventListener("dragstart", handler);
    return () => document.removeEventListener("dragstart", handler);
  }, [isOverlay, bridgePhase, sendImageToComfyUI]);

  // Watch for completed runs and add to gallery. Imperative subscription
  // guarded on the runs reference so WS progress ticks don't re-render the
  // whole shell (Sidebar, PromptBar, header) many times per second.
  useEffect(() => {
    const collectDoneRuns = () => {
      for (const run of useGenerationStore.getState().runs) {
        if (!runReadyForGallery(run)) continue;
        addRunToGallery(run);
      }
    };
    collectDoneRuns();
    return useGenerationStore.subscribe((state, prevState) => {
      if (state.runs !== prevState.runs) collectDoneRuns();
    });
  }, [addRunToGallery]);

  const handleSubmit = useCallback(
    async (prompt: string) => {
      await imagine(prompt);
      // Clear image attachments after generation unless locked
      if (!imageAttachmentsLocked) {
        clearImageAttachments();
      }
    },
    [imagine, imageAttachmentsLocked, clearImageAttachments],
  );

  const { inpaint: submitInpaint, isLoading: isInpaintLoading } = useInpaint({
    onSuccess: (promptId: string) => {
      console.log("[Page] Inpaint queued:", promptId);
    },
    onError: (error: string) => {
      console.error("[Page] Inpaint error:", error);
    },
  });

  const handleEditSubmit = useCallback(
    async (prompt: string, maskDataUrl: string | null) => {
      const editorState = useEditorStore.getState();
      const sourceImage = editorState.sourceImage;
      if (!sourceImage) {
        console.error("[Page] No source image for inpaint");
        showToast("Open an image in the editor first.", "error");
        return false;
      }

      // Submit inpaint job with prompt + source + mask
      const mask = maskDataUrl ?? null;
      const result = await submitInpaint(prompt, sourceImage, mask);

      if (!result.ok) {
        console.error("[Page] Inpaint failed:", result.error);
        showToast(editFailureMessage(result.error), "error");
      }
      return result.ok;
    },
    [submitInpaint],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping = isTypingTarget(e.target);

      // Show keyboard help with ?
      if (e.key === "?" && !isTyping) {
        e.preventDefault();
        setShowKeyboardHelp(true);
        return;
      }

      // Escape closes ONE layer, topmost first. A dialog that already
      // handled it (useDialogFocus onEscape marks it defaultPrevented)
      // owns it; otherwise keyboard help (drawn over everything), then the
      // palette, lightbox, settings.
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
          return;
        }
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (lightbox) {
          useUIStore.getState().closeLightbox();
          return;
        }
        if (settingsOpen) {
          useUIStore.getState().setSettingsOpen(false);
          return;
        }
        return;
      }

      // Command palette owns Ctrl/Cmd + K (toggle; also closes while its
      // input is focused); "/" focuses the prompt instead.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "k" &&
        (!isTyping || paletteOpen)
      ) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // Focus prompt bar with /
      if (e.key === "/" && !isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const textarea = document.querySelector(
          "#desktop_input_bar",
        ) as HTMLTextAreaElement | null;
        // Pages without a prompt bar (account, updates, help) keep the key.
        if (textarea) {
          e.preventDefault();
          textarea.focus();
          return;
        }
      }

      // Toggle settings with Ctrl/Cmd + S. Not gated on isTyping: otherwise
      // the browser's Save Page dialog opens while typing in the prompt bar.
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        useUIStore.getState().toggleSettings();
        return;
      }

      // Nav number shortcuts — from the nav registry (KeyboardHelp lists the
      // same map). Modifier combos stay with the browser (Cmd+1 = tab 1).
      if (
        !isTyping &&
        !lightbox &&
        !settingsOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const navKeys = navShortcutMap();
        if (navKeys[e.key]) {
          e.preventDefault();
          // Through the registry: Styles (6) opens the hub's Browse tab
          const ui = useUIStore.getState();
          navigateToDestination(navKeys[e.key], {
            setActiveNav: ui.setActiveNav,
            setStylesHubTab: ui.setStylesHubTab,
          });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightbox, settingsOpen, showKeyboardHelp, paletteOpen]);

  const showEditor = activeNav === "edit" || editorIsOpen;

  // Route-change a11y: title per view; after a nav change (not first load)
  // move focus to the new page's heading so AT users hear where they are.
  const currentPageLabel = pageLabels[showEditor ? "edit" : activeNav];
  // Compare against the last view (not a "first run" flag) so StrictMode's
  // dev double-effect doesn't count as a navigation.
  const lastViewRef = useRef<string | null>(null);
  useEffect(() => {
    document.title = documentTitleFor(currentPageLabel);
  }, [currentPageLabel]);
  useEffect(() => {
    const view = `${activeNav}|${showEditor}`;
    const last = lastViewRef.current;
    lastViewRef.current = view;
    if (last === null || last === view) return;
    return focusPageHeading(document.getElementById("pageScroll"));
  }, [activeNav, showEditor]);

  // The prompt bar is visible on every creative page. It is hidden in
  // edit/inpaint mode (EditorPromptBar replaces it), on the quiet
  // account/info pages and on the setup/admin pages. Tools/Styles/Profile
  // keep it on desktop only: on a phone the dock would eat ~140 px of a page
  // whose own controls are the point.
  const showPromptBar = !showEditor && !isChromePage(activeNav);
  const promptBarDesktopOnly = isPromptBarDesktopOnly(activeNav);

  const refreshCurrentView = useCallback(async () => {
    if (activeNav === "explore") {
      useExploreStore.getState().requestRefresh();
      return;
    }
    if (activeNav === "moodboards") {
      await useStyleStore.getState().fetchMoodboards();
      return;
    }
    reconnect();
  }, [activeNav, reconnect]);

  const runPullRefresh = useCallback(async () => {
    if (isPullRefreshing) return;
    setIsPullRefreshing(true);
    setPullDistance(PULL_REFRESH_THRESHOLD);
    try {
      await refreshCurrentView();
    } finally {
      setPullDistance(0);
      setIsPullRefreshing(false);
    }
  }, [isPullRefreshing, refreshCurrentView]);

  const handlePullStart = useCallback(
    (e: React.TouchEvent<HTMLElement>) => {
      if (isOverlay || isPullRefreshing || e.touches.length !== 1) return;
      if (window.innerWidth >= 768) return;
      if (e.currentTarget.scrollTop > 0) return;
      const touch = e.touches[0];
      pullStartRef.current = { x: touch.clientX, y: touch.clientY };
      pullTrackingRef.current = true;
    },
    [isOverlay, isPullRefreshing],
  );

  const handlePullMove = useCallback((e: React.TouchEvent<HTMLElement>) => {
    if (!pullTrackingRef.current || !pullStartRef.current) return;
    if (e.currentTarget.scrollTop > 0) {
      pullTrackingRef.current = false;
      setPullDistance(0);
      return;
    }
    const touch = e.touches[0];
    const deltaY = touch.clientY - pullStartRef.current.y;
    const deltaX = Math.abs(touch.clientX - pullStartRef.current.x);
    if (deltaX > Math.abs(deltaY)) {
      pullTrackingRef.current = false;
      setPullDistance(0);
      return;
    }
    if (deltaY <= 0) {
      setPullDistance(0);
      return;
    }
    // No preventDefault: React attaches root touchmove listeners as passive,
    // so it was a no-op. Native overscroll is contained via CSS instead.
    setPullDistance(Math.min(PULL_REFRESH_MAX, deltaY * 0.5));
  }, []);

  const handlePullEnd = useCallback(() => {
    const shouldRefresh = pullDistance >= PULL_REFRESH_THRESHOLD;
    pullStartRef.current = null;
    pullTrackingRef.current = false;
    if (shouldRefresh) {
      void runPullRefresh();
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, runPullRefresh]);

  const renderPageContent = () => {
    let content: React.ReactNode;
    switch (activeNav) {
      case "setup":
        content = <SetupPage />;
        break;
      case "explore":
        content = <ExplorePage />;
        break;
      case "organize":
        content = <OrganizePage />;
        break;
      case "library":
      case "styles":
      case "style-creator":
      case "style-vault": {
        content = (
          <StylesHubPage
            initialTab={stylesHubTabForNav(activeNav)}
            datasets={<DatasetBoardsPage kind="style" />}
          />
        );
        break;
      }
      case "moodboards":
        content = <MoodboardsPage />;
        break;
      case "characters":
        content = <DatasetBoardsPage kind="character" />;
        break;
      case "personalize":
        content = <PersonalizePage />;
        break;
      case "tasks":
        content = <TasksPage />;
        break;
      case "tools":
        content = <ToolsPage />;
        break;
      case "profile":
        content = <ProfilePage />;
        break;
      case "account-settings":
        content = <AccountSettingsPage />;
        break;
      case "help":
        content = <HelpPage />;
        break;
      case "updates":
        content = <UpdatesPage />;
        break;
      default:
        if (showEditor) {
          content = <EditorPage onSubmitEdit={handleEditSubmit} />;
          break;
        }
        // Create's heading: one quiet word in the feed's column names the
        // page (and gives nav focus an h1 to land on). No tagline: nothing
        // wordy sits under the prompt bar.
        content = (
          <>
            {activeNav === "create" && (
              <div
                className={`px-6 pt-2 max-w-[1648px] ${settingsOpen ? "mr-auto" : "mx-auto"}`}
              >
                <h1
                  data-testid="create-heading"
                  className="text-sm text-[var(--text-tertiary)]"
                >
                  <span className="font-semibold text-[var(--text-primary)]">
                    Create
                  </span>
                </h1>
              </div>
            )}
            <div data-tour="create-feed">
              <Gallery />
            </div>
          </>
        );
    }
    const pageKey = showEditor ? "edit" : activeNav;
    const label = pageLabels[pageKey] ?? "Page";
    // All style nav keys share one boundary so opening the creator panel or
    // switching Styles views doesn't remount the page.
    const boundaryKey = !showEditor && isStylesNav(activeNav) ? "styles-hub" : pageKey;
    return (
      <ErrorBoundary
        key={`${boundaryKey}-${pageResetNonce}`}
        fallback={
          <PageErrorFallback
            label={label}
            onReset={() => setPageResetNonce((v) => v + 1)}
          />
        }
      >
        {content}
      </ErrorBoundary>
    );
  };

  const offlineNotice = (underPromptBar: boolean) => (
    <ShellBoundary label="Connection notice" hidden>
      <OfflineCard
        dismissed={connBannerDismissed}
        onDismiss={dismissConnectionBanner}
        underPromptBar={underPromptBar}
      />
    </ShellBoundary>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)]">
      {/* Sidebar — shown in overlay mode too: the overlay iframe is
          full-viewport, so the app keeps its normal navigation */}
      <ShellBoundary label="Sidebar">
        <Sidebar />
      </ShellBoundary>

      <div className="flex-1 flex flex-col min-w-0 pt-[env(safe-area-inset-top)]">
        {/* Pages without a prompt bar show the notice at the top */}
        {!showPromptBar && offlineNotice(false)}
        <SetupDialogHost />
        {/* Overlay mode: top bar (status, back, workflow pill, progress, settings) */}
        {isOverlay && (
          <ShellBoundary label="Overlay bar">
            <OverlayTopBar
              onBack={requestHideOverlay}
              onSendWorkflow={(wf) => {
                // Prefer the freshest copy from sessionStorage if present
                let toSend: unknown = wf;
                try {
                  const stored = sessionStorage.getItem(
                    "cj_overlay_workflow_json",
                  );
                  if (stored) toSend = JSON.parse(stored);
                } catch {
                  /* ignore */
                }
                if (toSend) sendWorkflowToComfyUI(toSend);
              }}
              onUseWorkflow={(wf, name) => {
                // Save overlay workflow as custom and set as active
                const customPath = `__overlay__/${name}`;
                try {
                  sessionStorage.setItem(
                    "cj_overlay_workflow_json",
                    JSON.stringify(wf),
                  );
                } catch {
                  /* quota exceeded — will still work via overlayStore */
                }
                setSelectedWorkflow(customPath, name);
                acceptWorkflow();
              }}
            />
          </ShellBoundary>
        )}

        {/* Persistent prompt bar header — floating, full-width, no divider.
              The bar lives in a centered 1600px column (same as the feed); the
              explore controls sit in the right gutter. With the settings panel
              open the column left-aligns so everything shifts left together. */}
        {showPromptBar && (
          <header
            className={`flex-shrink-0 px-4 sm:px-6 pt-4 pb-2 ${
              promptBarDesktopOnly ? "max-md:pb-0" : ""
            }`}
          >
            <div
              className={`grid items-start gap-x-0 min-[1900px]:gap-x-4 ${
                settingsOpen
                  ? "grid-cols-[minmax(0,1600px)_minmax(0,1fr)]"
                  : "grid-cols-[minmax(0,1fr)_minmax(0,1600px)_minmax(0,1fr)]"
              }`}
            >
              {!settingsOpen && <div />}
              <div className="min-w-0">
                {/* Connection banner — sustained outage only, desktop only
                    (mobile shows the compact pill under the prompt bar) */}
                {bannerMode === "connection" && (
                  <div className="hidden md:flex w-full mb-2 justify-center">
                    <div
                      className="inline-flex items-center gap-2 h-8 pl-3 pr-1 rounded-full bg-[var(--bg-secondary)] text-xs text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-primary)] animate-fade-in"
                      role="status"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />
                      <span>
                        ComfyUI has been offline for a while. Start it, then
                        retry.
                      </span>
                      <button
                        onClick={() => reconnect()}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded-full hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden />
                        Retry
                      </button>
                      <button
                        onClick={dismissConnectionBanner}
                        className="p-1 rounded-full hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        title="Hide for this session"
                        aria-label="Dismiss connection notice"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                {/* Create failure, explained (setup / node manager next step) */}
                {bannerMode === "error" && lastError && lastFailure && (
                  <div className="w-full mb-3">
                    <CreateFailureNotice
                      failure={lastFailure}
                      onDismiss={clearError}
                    />
                  </div>
                )}
                {bannerMode === "error" && !(lastError && lastFailure) && (
                  <div className="w-full mb-3">
                    <div
                      className="flex items-center gap-3 px-4 py-3 bg-[var(--error)]/10 border border-[var(--error)]/30 rounded-lg"
                      role="alert"
                    >
                      <AlertCircle className="w-5 h-5 text-[var(--error)] flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-[var(--error)]">
                          {lastError || storeError}
                        </p>
                        {errors.length > 1 && (
                          <p className="text-xs text-[var(--error)]/70 mt-1">
                            {errors.length} errors.
                            <span className="hidden md:inline">
                              {" "}
                              Click the status dot in the sidebar for details.
                            </span>
                          </p>
                        )}
                      </div>
                      <button
                        onClick={clearError}
                        className="p-1 hover:bg-[var(--error)]/20 rounded flex-shrink-0"
                        title="Dismiss"
                        aria-label="Dismiss error"
                      >
                        <X className="w-4 h-4 text-[var(--error)]" />
                      </button>
                    </div>
                  </div>
                )}
                <div
                  className={promptBarDesktopOnly ? "hidden md:block" : undefined}
                >
                  <ShellBoundary label="Prompt bar">
                    <PromptBar
                      onSubmit={handleSubmit}
                      isLoading={isLoading}
                      isConnected={isConnected}
                    />
                  </ShellBoundary>
                </div>
                {/* Under the prompt bar, above the image controls */}
                {offlineNotice(true)}
              </div>
              {/* Explore sort/search lives in the right gutter */}
              {activeNav === "explore" ? <ExploreControls /> : <div />}
            </div>
          </header>
        )}

        {/* Page content — scroll contract: single #pageScroll container.
              The lightbox overlays this area only (sidebar + bar stay visible). */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          {(pullDistance > 0 || isPullRefreshing) && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2 md:hidden"
              style={{
                opacity: Math.min(1, pullDistance / PULL_REFRESH_THRESHOLD),
                transform: `translateY(${Math.min(24, pullDistance * 0.25)}px)`,
              }}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-lg">
                <RefreshCw
                  className={`h-4 w-4 text-[var(--text-secondary)] ${
                    isPullRefreshing ? "animate-spin" : ""
                  }`}
                />
              </div>
            </div>
          )}
          <main
            id="pageScroll"
            tabIndex={-1}
            className="flex-1 overflow-y-auto overflow-x-hidden noScrollbar pb-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)] md:pb-0"
            onTouchStart={handlePullStart}
            onTouchMove={handlePullMove}
            onTouchEnd={handlePullEnd}
            onTouchCancel={handlePullEnd}
          >
            {renderPageContent()}
          </main>

          {/* Outlives the lightbox so closing it clears ?image= */}
          <LightboxUrlSync />
          <RecipePanel />
          {lightbox && (
            <ErrorBoundary
              key={`lightbox-${modalResetNonce}`}
              fallback={
                <PageErrorFallback
                  label="Lightbox"
                  onReset={() => setModalResetNonce((v) => v + 1)}
                />
              }
            >
              <Lightbox />
            </ErrorBoundary>
          )}
        </div>
      </div>

      {/* Mobile bottom navigation — replaces sidebar below md */}
      <ShellBoundary label="Navigation" hidden>
        <MobileBottomNav />
      </ShellBoundary>

      {settingsOpen && (
        <ErrorBoundary
          key={`settings-${settingsResetNonce}`}
          fallback={
            <PageErrorFallback
              label="Settings"
              onReset={() => setSettingsResetNonce((v) => v + 1)}
            />
          }
        >
          <SettingsPanel />
        </ErrorBoundary>
      )}

      <ErrorBoundary
        key={`image-selector-${modalResetNonce}`}
        fallback={
          <PageErrorFallback
            label="Image Selector"
            onReset={() => setModalResetNonce((v) => v + 1)}
          />
        }
      >
        <ImageSelector />
      </ErrorBoundary>

      <ErrorBoundary
        key={`keyboard-help-${modalResetNonce}`}
        fallback={
          <PageErrorFallback
            label="Keyboard Help"
            onReset={() => setModalResetNonce((v) => v + 1)}
          />
        }
      >
        <KeyboardHelp
          isOpen={showKeyboardHelp}
          onClose={() => setShowKeyboardHelp(false)}
        />
      </ErrorBoundary>

      {/* First-run setup wizard (openOnboarding()) */}
      <ErrorBoundary fallback={<></>}>
        <OnboardingHost />
      </ErrorBoundary>

      {/* Guided intro tour (after first-run setup, Help, palette, ?tour=1) */}
      <ErrorBoundary fallback={<></>}>
        <TourHost />
      </ErrorBoundary>

      {/* Command palette (Ctrl/Cmd+K) */}
      {paletteOpen && (
        <ErrorBoundary
          key={`command-palette-${modalResetNonce}`}
          fallback={
            <PageErrorFallback
              label="Command Palette"
              onReset={() => setModalResetNonce((v) => v + 1)}
            />
          }
        >
          <CommandPalette
            isOpen={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            onShowKeyboardHelp={() => setShowKeyboardHelp(true)}
            onDescribe={() => setDescribeOpen(true)}
          />
        </ErrorBoundary>
      )}

      {/* Describe Image (opened from the palette; outlives it) */}
      {describeOpen && (
        <ErrorBoundary
          key={`describe-${modalResetNonce}`}
          fallback={
            <PageErrorFallback
              label="Describe Image"
              onReset={() => setModalResetNonce((v) => v + 1)}
            />
          }
        >
          <DescribeDialog
            isOpen={describeOpen}
            onClose={() => setDescribeOpen(false)}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
