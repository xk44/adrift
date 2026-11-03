"use client";

import { downloadTarget } from "@/lib/gallerySelection";
import { meshDownloads, previewableMesh } from "@/lib/galleryMedia";
import MeshPreview from "@/components/MeshPreview";
import { BlenderExportActions } from "@/components/BlenderExportActions";
import { blenderSourceFor } from "@/lib/mesh/blenderLinks";
import { sidecarDownloadName } from "@/lib/output/downloadName";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TouchEvent,
  useMemo,
} from "react";
import { useEditorStore, useGenerationStore, useUIStore } from "@/store";
import { useLikesStore } from "@/store/likesStore";
import { lightboxShareUrl } from "@/hooks/useLightboxUrl";
import { showToast, toastNodeWarnings } from "@/components/Toast";
import type { GalleryImage, ImageMode, ImagineRun } from "@/types";
import {
  resolveWorkflowForAction,
  imagineWorkflowPathForPrompt,
  promptHasDedicatedRoute,
  mergeActionAndSlotAssignments,
} from "@/lib/workflowAssignments";
import { buildRerunPrompts, type RerunOverrides } from "@/lib/oj/rerun";
import { buildRemixComposition } from "@/lib/remixCompose";
import { buildParamChips, stripChipFlagsFromPrompt } from "@/lib/paramChips";
import { runProvenance } from "@/lib/runProvenance";
import { ProvenanceChip } from "@/components/gallery/ProvenanceChip";
import {
  provenancePrefill,
  provenanceToolKey,
  toolPageHref,
} from "@/lib/tools/provenanceTool";
import { fetchRunImages } from "@/lib/sourceRun";
import { fetchRunRecipe } from "@/lib/recipe/client";
import { useRecipeStore } from "@/store/recipeStore";
import { RerunSheet } from "@/components/RerunSheet";
import { CompareSlider } from "@/components/CompareSlider";
import { StyleInsights } from "@/components/StyleInsights";
import { ExtraOutputs } from "@/components/ExtraOutputs";
import { QuickEditOverlay } from "@/components/QuickEditOverlay";
import dynamic from "next/dynamic";
import { navigateTo } from "@/hooks/useNavSync";
import { editableVideoUrl } from "@/components/editor/editorStartScreen";
import { openVideoUrl } from "@/components/editor/video/openVideo";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { isLightboxFullScreen } from "@/lib/ui/dialogFocus";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { handoffFromGalleryItem } from "@/lib/tools/toolHandoff";
import { lightboxMediaKind, type InlineRun } from "@/lib/ui/lightboxTools";
import { keyOwner, lightboxKeyIntent } from "@/lib/ui/lightboxKeys";
import { LightboxActions } from "@/components/LightboxActions";
import type { CreatorGroupId } from "@/lib/ui/creatorActions";
import { imageUpscaleContent } from "@/lib/upscale/upscalerPref";
import { upscaleActionParams } from "@/lib/upscale/upscalePrefs";
import { QcBadge } from "@/components/videoQc/QcBadge";
import {
  isComparableImage,
  pickDefaultCompareTarget,
  pickSourceImage,
} from "@/lib/compareSlider";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Heart,
  Download,
  Workflow as WorkflowIcon,
  Share2,
  MoreHorizontal,
  ZoomIn,
  ZoomOut,
  FileText,
  Copy,
  Music,
  Box,
  Loader2,
  Columns2,
  ArrowLeftRight,
} from "lucide-react";

// Tools panel (search + full catalog) loads on first open only.
const LightboxToolsPanel = dynamic(
  () => import("@/components/LightboxToolsPanel"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-16 items-center justify-center text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    ),
  },
);

const TOUCH_SWIPE_THRESHOLD_PX = 48;
const TOUCH_CLOSE_THRESHOLD_PX = 64;

/** "4h" / "3d" style relative age (reference user row) */
function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function Lightbox() {
  const lightbox = useUIStore((s) => s.lightbox);
  const closeLightbox = useUIStore((s) => s.closeLightbox);
  const setLightboxIndex = useUIStore((s) => s.setLightboxIndex);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const addImageAttachment = useUIStore((s) => s.addImageAttachment);
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const replacePromptParam = useUIStore((s) => s.replacePromptParam);
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const workflowControlOverrides = useUIStore(
    (s) => s.workflowControlOverrides,
  );
  const setIsGenerating = useUIStore((s) => s.setIsGenerating);
  const openEditor = useEditorStore((s) => s.openEditor);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const setError = useGenerationStore((s) => s.setError);
  const addError = useGenerationStore((s) => s.addError);
  const addToPromptHistory = useGenerationStore((s) => s.addToPromptHistory);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showCopyOptions, setShowCopyOptions] = useState(false);
  const [showRerunSheet, setShowRerunSheet] = useState(false);
  const [openCreatorGroup, setOpenCreatorGroup] =
    useState<CreatorGroupId | null>(null);
  const [creatorGroupEditing, setCreatorGroupEditing] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  // "Tools" accordion: every action beyond the core rows (T toggles).
  const [showTools, setShowTools] = useState(false);
  // Quick edit overlay (mask paint / expand / upscale on the open image).
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  // Zoom: 1:1 view of a still that is shown smaller than its pixels.
  // `zoomInfo` is set from the loaded <img>, keyed by item id so a stale
  // measurement never applies to the next image.
  const [zoomed, setZoomed] = useState(false);
  const [zoomInfo, setZoomInfo] = useState<{
    id: string;
    w: number;
    h: number;
  } | null>(null);
  // Where the user clicked (0..1 of the fitted image), centered after zoom.
  const zoomFocusRef = useRef({ x: 0.5, y: 0.5 });
  const zoomScrollRef = useRef<HTMLDivElement>(null);
  const zoomDragRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const zoomDraggedRef = useRef(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchInScrollPanelRef = useRef(false);
  // Touch began in a horizontal strip (thumb rail / compare picker): its own
  // scroll gesture, never a prev/next swipe.
  const touchInHScrollRef = useRef(false);
  // Phone layout scrolls the whole lightbox; a pull-down only closes when
  // it starts at the very top.
  const touchStartScrolledRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Resolve the effective workflow path for a given action using assignment slots */
  const resolveActionWorkflow = useCallback(
    (action: string): string | undefined => {
      const assignments = mergeActionAndSlotAssignments(actionWorkflowMap);
      const resolved = resolveWorkflowForAction(action, {
        assignments,
        selectedWorkflowPath,
        selectedWorkflowName,
        defaultWorkflowPath,
        defaultWorkflowName,
      });
      return resolved?.workflowPath;
    },
    [
      actionWorkflowMap,
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    ],
  );

  const currentImage = lightbox?.images[lightbox.index];

  // Same humanized chips + "made with" label as the Create feed's list view.
  const lightboxChips = useMemo(
    () =>
      currentImage
        ? buildParamChips(
            currentImage.params ?? [],
            typeof currentImage.seed === "number" ? [currentImage.seed] : [],
          )
        : [],
    [currentImage],
  );
  const lightboxDisplayPrompt = useMemo(
    () =>
      currentImage?.prompt
        ? stripChipFlagsFromPrompt(
            currentImage.prompt,
            lightboxChips.map((chip) => chip.key),
          )
        : "",
    [currentImage, lightboxChips],
  );
  const lightboxProvenance = useMemo(
    () => runProvenance(currentImage?.paramsMap),
    [currentImage],
  );
  // "Made with" chip → the Tools card that made this item (null = no card).
  const madeWithToolKey = useMemo(
    () => provenanceToolKey(lightboxProvenance, currentImage?.paramsMap),
    [lightboxProvenance, currentImage],
  );

  // Before/after: the image an action or tool result was made from (upscale,
  // vary, edit…). Feed first, then the run lookup; a one-image result can
  // still wipe-compare against its source.
  const [sourceImage, setSourceImage] = useState<GalleryImage | null>(null);
  const sourceRunId = lightboxProvenance?.sourceRunId;
  const sourceJobIndex = currentImage?.paramsMap?.action_source_job_index;
  const currentComparable = Boolean(
    currentImage && isComparableImage(currentImage),
  );
  useEffect(() => {
    setSourceImage(null);
    if (!sourceRunId || !currentComparable) return;
    const currentId = currentImage?.id;
    const inFeed = useGenerationStore
      .getState()
      .gallery.filter((img) => img.runId === sourceRunId);
    const local = pickSourceImage(inFeed, sourceJobIndex, currentId);
    if (local) {
      setSourceImage(local);
      return;
    }
    let cancelled = false;
    fetchRunImages(sourceRunId)
      .then((imgs) => {
        if (!cancelled)
          setSourceImage(pickSourceImage(imgs, sourceJobIndex, currentId));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceRunId, sourceJobIndex, currentComparable, currentImage?.id]);

  // Compare mode: wipe-slider against another image from the same set, or
  // against the source image.
  const compareImage =
    compareId && lightbox
      ? (lightbox.images.find((img) => img.id === compareId) ??
        (sourceImage?.id === compareId ? sourceImage : null))
      : null;
  const compareActive = Boolean(compareImage);
  const comparingSource = Boolean(
    compareImage && sourceImage && compareImage.id === sourceImage.id,
  );
  const canCompare = Boolean(
    lightbox &&
    currentComparable &&
    (lightbox.images.length > 1 || sourceImage),
  );

  const toggleCompare = useCallback(() => {
    if (!lightbox || !currentImage) return;
    setCompareId((prev) => {
      if (prev) return null; // exit compare
      if (sourceImage) return sourceImage.id; // before/after first
      const target = pickDefaultCompareTarget(lightbox.images, lightbox.index);
      return target?.id ?? null;
    });
  }, [lightbox, currentImage, sourceImage]);

  // External images (e.g. Civitai explore) have no local run — generation
  // actions (vary/upscale/pan/…) don't apply; use/like/download still do.
  const isExternal = !currentImage?.runId;
  // Quick edit works on local still images only.
  const canQuickEdit = Boolean(
    currentImage &&
    !isExternal &&
    currentImage.url &&
    !currentImage.videoUrl &&
    !currentImage.audioUrl &&
    !currentImage.meshUrl,
  );
  const openQuickEdit = useCallback(() => {
    if (!canQuickEdit) return;
    setCompareId(null);
    setZoomed(false);
    setQuickEditOpen(true);
  }, [canQuickEdit]);
  const isStill = Boolean(
    currentImage?.url &&
    !currentImage.videoUrl &&
    !currentImage.audioUrl &&
    !currentImage.meshUrl,
  );
  const canZoom = Boolean(
    isStill &&
    zoomInfo &&
    zoomInfo.id === currentImage?.id &&
    !compareActive &&
    !quickEditOpen,
  );
  const zoomActive = zoomed && canZoom;
  const toggleZoom = useCallback(
    (focus?: { x: number; y: number }) => {
      if (!canZoom) return;
      zoomFocusRef.current = focus ?? { x: 0.5, y: 0.5 };
      setZoomed((z) => !z);
    },
    [canZoom],
  );
  // Center the zoomed view on the spot that was clicked.
  useLayoutEffect(() => {
    const el = zoomScrollRef.current;
    if (!zoomActive || !el || !zoomInfo) return;
    const { x, y } = zoomFocusRef.current;
    el.scrollLeft = Math.max(0, x * zoomInfo.w - el.clientWidth / 2);
    el.scrollTop = Math.max(0, y * zoomInfo.h - el.clientHeight / 2);
  }, [zoomActive, zoomInfo]);
  // prompt_id of the job behind this image, for its non-media outputs.
  const currentPromptId = useGenerationStore((s) =>
    currentImage?.runId
      ? s.runs
          .find((r) => r.run_id === currentImage.runId)
          ?.jobs.find((j) => j.index === currentImage.jobIndex)?.prompt_id
      : undefined,
  );

  const currentRun = useGenerationStore((s) =>
    currentImage?.runId
      ? s.runs.find((r) => r.run_id === currentImage.runId)
      : undefined,
  );
  const blenderSource = useMemo(() => {
    if (!currentImage) return null;
    const job = currentRun?.jobs.find((j) => j.index === currentImage.jobIndex);
    const meshUrls = currentImage.meshUrl
      ? (currentImage.meshUrls ?? [currentImage.meshUrl])
      : job?.meshes;
    return blenderSourceFor({
      meshUrls,
      texts: job?.texts,
      // Only tool runs carry a Layer Split manifest.
      action: currentRun?.action ?? "",
      params: currentRun?.params,
      width: currentRun?.width,
      height: currentRun?.height,
    });
  }, [currentImage, currentRun]);

  const isActionLoading = useCallback(
    (action: string) => {
      const key = `${currentImage?.runId ?? ""}:${currentImage?.jobIndex ?? 0}:${action}`;
      return actionLoading.has(key);
    },
    [actionLoading, currentImage?.runId, currentImage?.jobIndex],
  );

  const [shareCopied, setShareCopied] = useState(false);
  const shareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
    };
  }, []);

  const toggleLiked = useGenerationStore((s) => s.toggleLiked);
  // External (Civitai) images like into the likes store instead
  const likedExternal = useLikesStore((s) =>
    currentImage?.external ? s.isLiked(currentImage.external.id) : false,
  );
  const isLiked = currentImage?.external ? likedExternal : currentImage?.liked;
  const handleToggleLiked = useCallback(() => {
    if (!currentImage) return;
    if (currentImage.external?.source === "civitai") {
      useLikesStore.getState().toggleLike({
        civitaiId: currentImage.external.id,
        url: currentImage.url,
        thumbnailUrl: currentImage.external.thumbnailUrl ?? currentImage.url,
        prompt: currentImage.prompt,
        width: currentImage.width,
        height: currentImage.height,
        models: currentImage.external.models ?? [],
        likedAt: new Date().toISOString(),
      });
    } else {
      toggleLiked(currentImage.id);
    }
  }, [currentImage, toggleLiked]);

  const handleShare = useCallback(async () => {
    if (!currentImage) return;
    const shareUrl = lightboxShareUrl(currentImage.id);
    const shareText = shareUrl || currentImage.url || currentImage.prompt;
    try {
      await navigator.clipboard?.writeText(shareText);
    } catch {
      showToast("Couldn't copy share link to clipboard.", "error");
      return;
    }
    setShareCopied(true);
    if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
    shareTimerRef.current = setTimeout(() => setShareCopied(false), 1500);
  }, [currentImage]);

  const handlePrev = useCallback(() => {
    if (!lightbox) return;
    const newIndex =
      lightbox.index > 0 ? lightbox.index - 1 : lightbox.images.length - 1;
    setLightboxIndex(newIndex);
  }, [lightbox, setLightboxIndex]);

  const handleNext = useCallback(() => {
    if (!lightbox) return;
    const newIndex =
      lightbox.index < lightbox.images.length - 1 ? lightbox.index + 1 : 0;
    setLightboxIndex(newIndex);
  }, [lightbox, setLightboxIndex]);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    const touch = event.changedTouches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchInScrollPanelRef.current =
      event.target instanceof HTMLElement &&
      event.target.closest("[data-lightbox-scroll]") !== null;
    // Quick edit paints with touch: never swipe/close from inside it.
    touchInHScrollRef.current =
      event.target instanceof Element &&
      (event.target.closest("[data-lightbox-hscroll]") !== null ||
        event.target.closest("[data-quick-edit]") !== null);
    touchStartScrolledRef.current = (rootRef.current?.scrollTop ?? 0) > 0;
  }, []);

  const handleTouchEnd = useCallback(
    (event: TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start) return;
      if (touchInHScrollRef.current) return;

      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      // Pull-down closes only when it didn't start inside the scrollable
      // detail panel — there it's a normal scroll-back-to-top gesture.
      if (
        dy > TOUCH_CLOSE_THRESHOLD_PX &&
        absY > absX &&
        !touchInScrollPanelRef.current &&
        !touchStartScrolledRef.current
      ) {
        closeLightbox();
        return;
      }

      if (absX < TOUCH_SWIPE_THRESHOLD_PX || absX <= absY) return;
      if (dx < 0) {
        handleNext();
      } else {
        handlePrev();
      }
    },
    [closeLightbox, handleNext, handlePrev],
  );

  // Keyboard navigation
  useEffect(() => {
    if (!lightbox) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Keys aimed at another modal layered over the lightbox (e.g. the
      // command palette) belong to that modal — don't flip images or close.
      const origin = e.target instanceof Element ? e.target : null;
      const otherModal = origin?.closest('[aria-modal="true"]');
      if (otherModal && otherModal !== rootRef.current) return;
      // Quick edit owns the keyboard while open ([ ] and Cmd/Ctrl+Z are its
      // own listener); Escape closes it before the lightbox.
      if (quickEditOpen) {
        if (e.key === "Escape") {
          e.stopPropagation();
          setQuickEditOpen(false);
        }
        return;
      }
      // An open sub-panel (rerun sheet / more+copy menus)
      // captures Escape to close itself instead of the whole lightbox, and
      // suppresses image nav.
      if (showRerunSheet || showMoreMenu || showCopyOptions) {
        if (e.key === "Escape") {
          e.stopPropagation();
          // Copy submenu closes before its parent More menu.
          if (showCopyOptions) setShowCopyOptions(false);
          else setShowMoreMenu(false);
          setShowRerunSheet(false);
        }
        return;
      }
      if ((showCustomize || openCreatorGroup) && e.key === "Escape") {
        e.stopPropagation();
        if (showCustomize) setShowCustomize(false);
        else if (creatorGroupEditing) setCreatorGroupEditing(false);
        else setOpenCreatorGroup(null);
        return;
      }
      // The Tools panel closes on Escape before the lightbox does — also
      // from its own search field.
      if (showTools && e.key === "Escape") {
        e.stopPropagation();
        setShowTools(false);
        return;
      }
      // Fields, videos, selects and the compare handle keep the keys they
      // need (lib/ui/lightboxKeys).
      const intent = lightboxKeyIntent(e, {
        owner: keyOwner(
          e.target instanceof HTMLElement
            ? {
                tagName: e.target.tagName,
                isContentEditable: e.target.isContentEditable,
                type: e.target.getAttribute("type") ?? undefined,
                role: e.target.getAttribute("role"),
              }
            : null,
        ),
        compareActive,
        zoomed: zoomActive,
        canCompare,
        canQuickEdit,
        canZoom,
      });
      if (!intent) return;
      // Escape: stop here so app/page's global Escape handler doesn't also
      // close the lightbox when it only meant to leave zoom or compare.
      if (intent === "close" || intent.startsWith("exit-")) e.stopPropagation();
      else if (intent !== "prev" && intent !== "next") e.preventDefault();
      switch (intent) {
        case "close":
          closeLightbox();
          break;
        case "exit-zoom":
          setZoomed(false);
          break;
        case "exit-compare":
          setCompareId(null);
          break;
        case "prev":
          handlePrev();
          break;
        case "next":
          handleNext();
          break;
        case "compare":
          setZoomed(false);
          toggleCompare();
          break;
        case "quick-edit":
          openQuickEdit();
          break;
        case "tools":
          setShowTools((v) => !v);
          break;
        case "zoom":
          toggleZoom();
          break;
      }
    };

    // Capture phase: this effect re-registers whenever a sub-panel/compare
    // toggles, which would put it after app/page's bubble-phase window
    // listener (which closes the whole lightbox on Escape). Capturing runs
    // first regardless of order, and stopPropagation above keeps the page
    // handler from seeing an Escape meant for a menu or for leaving compare.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    lightbox,
    closeLightbox,
    handlePrev,
    handleNext,
    showRerunSheet,
    showMoreMenu,
    showCopyOptions,
    compareActive,
    canCompare,
    toggleCompare,
    quickEditOpen,
    canQuickEdit,
    openQuickEdit,
    showTools,
    showCustomize,
    openCreatorGroup,
    creatorGroupEditing,
    zoomActive,
    canZoom,
    toggleZoom,
  ]);

  // The More menu closes on a press anywhere outside it (its own trigger
  // included in the menu wrapper, so toggling still works).
  useEffect(() => {
    if (!showMoreMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const menu = moreMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target))
        return;
      setShowMoreMenu(false);
      setShowCopyOptions(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [showMoreMenu]);

  useEffect(() => {
    setShowMoreMenu(false);
    setShowCopyOptions(false);
    setShowRerunSheet(false);
    setOpenCreatorGroup(null);
    setCreatorGroupEditing(false);
    setShowCustomize(false);
    setShowTools(false);
    setCompareId(null);
    setQuickEditOpen(false);
    setZoomed(false);
    // Phone layout scrolls the whole dialog — bring the next image into view
    // instead of leaving the user parked in the previous image's details.
    if (rootRef.current && rootRef.current.scrollTop > 0) {
      rootRef.current.scrollTop = 0;
    }
  }, [currentImage?.id]);

  // Move focus into the dialog when it opens (not on prev/next navigation).
  const lightboxOpen = Boolean(lightbox);
  // Restores focus to the opener on close. Tab is trapped only on phones,
  // where the lightbox covers everything; on desktop the prompt bar stays
  // visible and reachable. Escape is handled by the key handler above.
  useDialogFocus(rootRef, lightboxOpen, {
    initialFocus: "none",
    trap: isLightboxFullScreen,
  });
  useEffect(() => {
    if (lightboxOpen) closeButtonRef.current?.focus();
  }, [lightboxOpen]);

  const [recipeLoading, setRecipeLoading] = useState(false);
  if (!lightbox || !currentImage) return null;

  const handlePromptClick = () => {
    if (!currentImage.prompt) return; // nothing to copy but " --seed N"
    setPromptValue(getFullPrompt());
    closeLightbox();
  };

  const handleUseWithSeed = () => {
    const promptWithSeed = `${currentImage.prompt} --seed ${currentImage.seed}`;
    setPromptValue(promptWithSeed);
    closeLightbox();
  };

  const handleRemix = (variant: "subtle" | "strong") => {
    const composition = buildRemixComposition(currentImage, variant);
    setPromptValue(composition.prompt);
    for (const attachment of composition.attachments) {
      addImageAttachment(attachment);
    }
    closeLightbox();
  };

  // Tools panel: inline tools run the lightbox's own action handlers.
  const runInlineTool = (run: InlineRun) => {
    switch (run.kind) {
      case "action":
        void handleAction(run.action, run.params);
        break;
      case "remix":
        handleRemix(run.variant);
        break;
      case "prompt_seed":
        handleUseWithSeed();
        break;
      case "use_start_frame":
        useImageAsAttachment("starting_frame");
        break;
      case "rerun":
        void handleRerun();
        break;
      case "rerun_tweak":
        setShowRerunSheet((v) => !v);
        break;
      case "use":
        useImageAsAttachment(run.mode);
        break;
      case "use_prompt":
        handlePromptClick();
        break;
      case "quick_edit":
        openQuickEdit();
        break;
      case "edit":
        handleEdit();
        break;
      case "retake":
        handleRetake();
        break;
      case "reproduce":
        void openRecipe();
        break;
    }
  };
  const isInlineToolRunning = (run: InlineRun) =>
    run.kind === "action"
      ? isActionLoading(run.action)
      : run.kind === "remix"
        ? isActionLoading(`remix_${run.variant}`)
        : run.kind === "rerun"
          ? isActionLoading("rerun")
          : run.kind === "reproduce" && recipeLoading;
  // Other tools open on the Tools page with this item as their input.
  const openInTools = (toolKey: string) => {
    const handoff = handoffFromGalleryItem(currentImage, toolKey, Date.now());
    if (handoff) useToolHandoffStore.getState().offer(handoff);
    useOverlayToolsStore.getState().openToolFromLauncher(toolKey, false);
    closeLightbox();
    navigateTo("tools");
  };

  // "Made with" chip: reopen that card with the run's settings and, when it
  // resolves to one image, the source it was made from.
  const openMadeWithTool = async () => {
    const key = madeWithToolKey;
    if (!key || !currentImage) return;
    const params = currentImage.paramsMap;
    const settings = provenancePrefill(
      lightboxProvenance,
      params,
      currentImage.prompt,
    );
    const store = useToolHandoffStore.getState();
    store.offerPrefill(
      Object.keys(settings).length
        ? { toolKey: key, settings, at: Date.now() }
        : null,
    );
    const sourceId = lightboxProvenance?.sourceRunId;
    if (sourceId) {
      const source = await Promise.race([
        fetchRunImages(sourceId).catch(() => [] as GalleryImage[]),
        new Promise<GalleryImage[]>((r) => setTimeout(() => r([]), 2000)),
      ]);
      const handoff =
        source.length === 1
          ? handoffFromGalleryItem(source[0], key, Date.now())
          : null;
      if (handoff) store.offer(handoff);
    }
    useOverlayToolsStore.getState().openToolFromLauncher(key, false);
    closeLightbox();
    navigateTo("tools");
  };

  // Reproduce: the output's recipe, reopened in its tool / Create (filled, not run).
  const openRecipe = async () => {
    if (!currentImage?.runId || recipeLoading) return;
    setRecipeLoading(true);
    try {
      const offer = await fetchRunRecipe(
        currentImage.runId,
        currentImage.jobIndex ?? 0,
      );
      useRecipeStore.getState().show({ ...offer, origin: "lightbox" });
    } catch (e) {
      showToast(
        `No recipe: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setRecipeLoading(false);
    }
  };

  const getRerunPrompt = () =>
    getFullPrompt()
      .replace(/(^|\s)--seed\s+\d+\b/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

  /** Fire one or more imagine jobs from ready-made prompt strings. */
  const fireImagineBatch = async (prompts: string[]) => {
    const cleaned = prompts.map((p) => p.trim()).filter(Boolean);
    if (cleaned.length === 0) return;

    const loadingKey = `${currentImage.runId ?? ""}:${currentImage.jobIndex ?? 0}:rerun`;
    const workflowPath = resolveActionWorkflow("promptbar.imagine");
    const controlOverrides =
      Object.keys(workflowControlOverrides).length > 0
        ? { workflow_control_overrides: workflowControlOverrides }
        : {};

    try {
      setActionLoading((prev) => new Set(prev).add(loadingKey));
      setIsGenerating(true);
      setError(null);

      for (const prompt of cleaned) {
        const response = await fetch("/api/jobs/imagine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            client_id: clientId,
            batch_size: 1,
            workflow_path: imagineWorkflowPathForPrompt(workflowPath, prompt),
            ...controlOverrides,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error ?? "Generation failed");
        for (const run of data.runs ?? []) addRun(run);
        addToPromptHistory(prompt);
      }
      closeLightbox();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      setError(message);
      showToast(message, "error");
      addError({ message, category: "network" });
    } finally {
      setIsGenerating(false);
      setActionLoading((prev) => {
        const next = new Set(prev);
        next.delete(loadingKey);
        return next;
      });
    }
  };

  /** Rerun posts to imagine, so a result from a tool would come back as a still. */
  const canRerunPrompt = (prompt: string) => {
    if (!prompt) {
      showToast("This item has no prompt to rerun.", "info");
      return false;
    }
    if (lightboxMediaKind(currentImage) !== "image" && !promptHasDedicatedRoute(prompt)) {
      showToast("This came from a tool. Open the tool to run it again.", "info");
      return false;
    }
    return true;
  };

  const handleRerun = async () => {
    const prompt = getRerunPrompt();
    if (!canRerunPrompt(prompt)) return;
    await fireImagineBatch([prompt]);
  };

  const handleRerunWithOverrides = async (overrides: RerunOverrides) => {
    const base = getRerunPrompt();
    if (!canRerunPrompt(base)) return;
    setShowRerunSheet(false);
    await fireImagineBatch(buildRerunPrompts(base, overrides));
  };

  const handleEdit = () => {
    // Videos open the Edit tab's video mode (probed first, so a clip the
    // editor cannot read stays in the lightbox with an error toast).
    const videoUrl = editableVideoUrl(currentImage);
    if (videoUrl) {
      void openVideoUrl(videoUrl, currentImage.prompt).then((ok) => {
        if (!ok) return;
        closeLightbox();
        navigateTo("edit");
      });
      return;
    }
    openEditor(currentImage.url, currentImage.id);
    closeLightbox();
  };

  // Retake: the video editor opens on its Tools panel, where in / out marks
  // the range and Retake regenerates only that part.
  const handleRetake = () => {
    const videoUrl = editableVideoUrl(currentImage);
    if (!videoUrl) return;
    void openVideoUrl(videoUrl, currentImage.prompt).then((ok) => {
      if (!ok) return;
      closeLightbox();
      navigateTo("edit");
      showToast(
        "Mark the moment with in / out (I and O), then press Retake.",
        "info",
        8000,
      );
    });
  };

  const handleQuickEditQueued = (run: ImagineRun | null, label: string) => {
    if (run) addRun(run);
    setQuickEditOpen(false);
    showToast(`${label} queued. Progress shows in Create.`, "success");
  };

  const handleParamClick = (param: string) => {
    // Chips may render dashless ("steps 16"); normalize to --flag so clicks
    // replace in place instead of appending unparseable raw text.
    const match = param.trim().match(/^(?:--?)?([A-Za-z][\w-]*)\s*(.*)$/);
    if (!match) return;
    const flag = `--${match[1]}`;
    const value = match[2].trim();
    if (flag === "--lora") {
      const current = useUIStore.getState().promptValue;
      if (!current.includes(`--lora ${value}`)) {
        appendToPrompt(`--lora ${value}`);
      }
    } else {
      replacePromptParam(flag, value);
    }
  };

  const copyText = (text: string, successMessage: string) => {
    if (!navigator.clipboard) {
      showToast("Clipboard unavailable", "error");
      return;
    }

    void navigator.clipboard
      .writeText(text)
      .then(() => showToast(successMessage, "info"))
      .catch(() => showToast("Copy failed", "error"));
  };

  const getFullPrompt = () =>
    currentImage.fullPrompt ||
    `${currentImage.prompt} --seed ${currentImage.seed}`;

  const getImageMetadata = () => ({
    prompt: currentImage.prompt,
    fullPrompt: currentImage.fullPrompt || getFullPrompt(),
    seed: currentImage.seed,
    dimensions: { width: currentImage.width, height: currentImage.height },
    model: currentImage.model,
    vae: currentImage.vae,
    loras: currentImage.loras,
    params: currentImage.paramsMap,
    createdAt: currentImage.createdAt,
    runId: currentImage.runId,
    jobIndex: currentImage.jobIndex,
  });

  // More-menu items act, then close the menu.
  const runMenuItem = (action: () => void) => {
    action();
    setShowMoreMenu(false);
    setShowCopyOptions(false);
  };

  const handleCopyPrompt = () => {
    copyText(getFullPrompt(), "Prompt copied");
  };

  const handleCopyImageUrl = () => {
    if (!currentImage.url) return;
    copyText(currentImage.url, "Image URL copied");
  };

  const handleCopySeed = () => {
    copyText(`--seed ${currentImage.seed}`, "Seed copied");
  };

  const handleCopyMetadata = () => {
    copyText(JSON.stringify(getImageMetadata(), null, 2), "Metadata copied");
  };

  const useImageAsAttachment = (
    mode: Extract<ImageMode, "starting_frame" | "image_prompt" | "style_ref">,
  ) => {
    if (!currentImage.url) return;

    window.dispatchEvent(
      new CustomEvent("use-start-frame", {
        detail: {
          url: currentImage.url,
          filename: `${currentImage.runId || "image"}-${currentImage.jobIndex ?? 0}.png`,
          runId: currentImage.runId,
          jobIndex: currentImage.jobIndex,
          mode,
        },
      }),
    );
    closeLightbox();
  };

  const handleDownload = () => {
    const target = downloadTarget(currentImage);
    if (!target) return;
    const link = document.createElement("a");
    link.href = target.href;
    link.download = target.filename;
    link.click();
  };

  const handleDownloadMetadata = () => {
    const metadata = getImageMetadata();
    const blob = new Blob([JSON.stringify(metadata, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sidecarDownloadName(currentImage, "metadata.json");
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadWorkflow = async () => {
    if (!currentImage?.runId) return;
    try {
      const qs = new URLSearchParams({
        run_id: currentImage.runId,
        job_index: String(currentImage.jobIndex ?? 0),
      });
      const res = await fetch(`/api/jobs/workflow?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = sidecarDownloadName(currentImage, "workflow.json");
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast("No workflow available for this job", "error");
    }
  };

  const handleAction = async (
    action: string,
    params?: Record<string, unknown>,
  ) => {
    if (!currentImage) return;

    const workflowPath = resolveActionWorkflow(action);
    const loadingKey = `${currentImage.runId ?? ""}:${currentImage.jobIndex ?? 0}:${action}`;

    try {
      setActionLoading((prev) => new Set(prev).add(loadingKey));
      const response = await fetch("/api/jobs/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: currentImage.runId,
          job_index: currentImage.jobIndex,
          action,
          client_id: clientId,
          workflow_path: workflowPath,
          params: params ?? upscaleActionParams(action),
          ...(Object.keys(workflowControlOverrides).length > 0
            ? { workflow_control_overrides: workflowControlOverrides }
            : {}),
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? `Failed: ${action}`);
      if (data.run) addRun(data.run);
      toastNodeWarnings(data);
      closeLightbox();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed: ${action}`;
      setError(message);
      showToast(message, "error");
    } finally {
      setActionLoading((prev) => {
        const next = new Set(prev);
        next.delete(loadingKey);
        return next;
      });
    }
  };

  const handleRelatedClick = (image: GalleryImage) => {
    const idx = lightbox.images.findIndex((img) => img.id === image.id);
    if (idx >= 0) setLightboxIndex(idx);
  };

  const previewMesh = currentImage?.meshUrl
    ? previewableMesh(currentImage.meshUrls ?? [currentImage.meshUrl])
    : undefined;
  const meshPlaceholder = (
    <>
      <Box className="w-24 h-24 text-[var(--text-muted)]" />
      <span className="text-lg text-[var(--text-secondary)]">3D Model</span>
    </>
  );

  return (
    // Reference site: the lightbox fills the content area below the prompt bar —
    // sidebar and imagine bar stay visible. Flat page bg, no backdrop blur.
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain noScrollbar bg-[var(--bg-primary)] md:absolute md:z-40 md:flex-row md:overflow-hidden pt-[env(safe-area-inset-top)] md:pt-0"
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Main columns: image | meta panel | thumb rail */}
      <div className="flex flex-col min-w-0 md:flex-row md:flex-1 md:min-h-0">
        {/* Left: Image area (phone: fixed-height stage above the details) */}
        <div className="relative flex h-[68dvh] shrink-0 items-center justify-center min-w-0 md:h-auto md:flex-1 md:shrink">
          {/* Close — top-left of the image area (reference site) */}
          <button
            ref={closeButtonRef}
            onClick={closeLightbox}
            className="absolute top-1.5 left-1.5 z-20 p-2.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-[color,background-color,transform] active:scale-[0.96] md:top-3 md:left-3 md:p-1.5 md:text-[var(--text-muted)]"
            aria-label="Close lightbox"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
          {currentImage.videoUrl && currentImage.runId && (
            <div className="absolute top-3 right-3 z-20">
              <QcBadge
                key={`${currentImage.runId}:${currentImage.jobIndex ?? 0}:${currentImage.videoUrl}`}
                jobId={`${currentImage.runId}:${currentImage.jobIndex ?? 0}`}
                videoUrl={currentImage.videoUrl}
              />
            </div>
          )}
          {/* Compare toggle (still images with a set > 1) */}
          {canCompare && (
            <button
              onClick={toggleCompare}
              className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                compareActive
                  ? "bg-[var(--accent-primary)] text-white"
                  : "bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
              }`}
              aria-pressed={compareActive}
              aria-label={compareActive ? "Exit compare" : "Compare"}
              aria-keyshortcuts="C"
              title={
                compareActive
                  ? "Exit compare (C)"
                  : "Compare with another image (C)"
              }
            >
              <Columns2 className="w-4 h-4" />
              {compareActive ? "Exit compare" : "Compare"}
            </button>
          )}

          {/* Navigation arrows — hidden while comparing */}
          {lightbox.images.length > 1 && !compareActive && !zoomActive && (
            <>
              <button
                onClick={handlePrev}
                className="absolute left-3 top-1/2 -translate-y-1/2 z-10 hidden p-2 rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors md:block"
                aria-label="Previous image"
                aria-keyshortcuts="ArrowLeft"
                title="Previous (←)"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
              <button
                onClick={handleNext}
                className="absolute right-3 top-1/2 -translate-y-1/2 z-10 hidden p-2 rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors md:block"
                aria-label="Next image"
                aria-keyshortcuts="ArrowRight"
                title="Next (→)"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            </>
          )}

          <div className="flex items-center justify-center w-full h-full px-3 pt-14 pb-3 md:px-16 md:py-8">
            {compareActive && compareImage && currentImage.url ? (
              <div className="relative h-full w-full max-w-full">
                <CompareSlider
                  leftUrl={currentImage.url}
                  rightUrl={compareImage.url}
                  leftAlt={currentImage.prompt}
                  rightAlt={compareImage.prompt}
                  leftLabel={comparingSource ? "Result" : "A"}
                  rightLabel={comparingSource ? "Source" : "B"}
                />
                {/* B-side picker — choose which image to compare against */}
                <div
                  className="absolute bottom-2 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full bg-black/60 px-2 py-1.5"
                  data-lightbox-scroll
                  data-lightbox-hscroll
                >
                  <ArrowLeftRight className="w-3.5 h-3.5 shrink-0 text-white/60" />
                  {[
                    ...(sourceImage &&
                    !lightbox.images.some((img) => img.id === sourceImage.id)
                      ? [sourceImage]
                      : []),
                    ...lightbox.images,
                  ]
                    .filter(
                      (img) =>
                        img.id !== currentImage.id && isComparableImage(img),
                    )
                    .map((img) => (
                      <button
                        key={img.id}
                        onClick={() => setCompareId(img.id)}
                        className={`h-8 w-8 shrink-0 overflow-hidden rounded ring-2 transition ${
                          img.id === compareImage.id
                            ? "ring-[var(--accent-primary)]"
                            : "ring-transparent hover:ring-white/50"
                        }`}
                        title={
                          img.id === sourceImage?.id
                            ? "Compare against the source image"
                            : "Compare against this image"
                        }
                        aria-label={
                          img.id === sourceImage?.id
                            ? "Compare against the source image"
                            : `Compare against image ${lightbox.images.findIndex((x) => x.id === img.id) + 1}`
                        }
                        aria-pressed={img.id === compareImage.id}
                      >
                        <img
                          src={img.url}
                          alt={img.prompt}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                </div>
              </div>
            ) : currentImage.videoUrl && currentImage.meshUrl ? (
              // 3D runs with a rendered preview clip (splat turntable, body
              // overlay): play the clip, offer the 3D files as downloads.
              <div className="flex max-h-full max-w-full flex-col items-center gap-3">
                <LightboxVideo
                  src={currentImage.videoUrl}
                  label={currentImage.prompt}
                  className="min-h-0 max-w-full flex-1 rounded-lg"
                />
                <div className="flex flex-wrap justify-center gap-2">
                  {meshDownloads(
                    currentImage.meshUrls ?? [currentImage.meshUrl],
                  ).map((d) => (
                    <a
                      key={d.href}
                      href={d.href}
                      download
                      className="px-4 py-2 rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" /> {d.label}
                    </a>
                  ))}
                  <BlenderExportActions
                    source={blenderSource}
                    className="px-4 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2 disabled:opacity-60"
                  />
                </div>
              </div>
            ) : currentImage.videoUrl ? (
              <LightboxVideo
                src={currentImage.videoUrl}
                label={currentImage.prompt}
                className="max-h-full max-w-full rounded-lg"
              />
            ) : currentImage.audioUrl ? (
              <div className="flex flex-col items-center gap-6">
                <Music className="w-24 h-24 text-[var(--text-muted)]" />
                <audio
                  src={currentImage.audioUrl}
                  controls
                  autoPlay
                  aria-label="Audio player"
                  className="w-full max-w-96"
                />
                {currentImage.url && (
                  <img
                    src={currentImage.url}
                    alt={currentImage.prompt}
                    className="max-h-64 rounded-lg opacity-60"
                  />
                )}
              </div>
            ) : currentImage.meshUrl ? (
              <div className="flex flex-col items-center gap-6">
                {previewMesh ? (
                  <MeshPreview
                    src={previewMesh}
                    label={currentImage.prompt}
                    poster={currentImage.url || undefined}
                    fallback={meshPlaceholder}
                  />
                ) : (
                  meshPlaceholder
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  {meshDownloads(
                    currentImage.meshUrls ?? [currentImage.meshUrl],
                  ).map((d) => (
                    <a
                      key={d.href}
                      href={d.href}
                      download
                      className="px-4 py-2 rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" /> {d.label}
                    </a>
                  ))}
                  <BlenderExportActions
                    source={blenderSource}
                    className="px-4 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2 disabled:opacity-60"
                  />
                </div>
                {!previewMesh && currentImage.url && (
                  <img
                    src={currentImage.url}
                    alt={currentImage.prompt}
                    className="max-h-64 rounded-lg opacity-60"
                  />
                )}
              </div>
            ) : (
              <img
                src={currentImage.url}
                alt={currentImage.prompt}
                onLoad={(event) => {
                  const img = event.currentTarget;
                  // Only offer zoom when the image is shown smaller than
                  // its own pixels.
                  const shrunk =
                    img.naturalWidth > img.clientWidth + 1 ||
                    img.naturalHeight > img.clientHeight + 1;
                  setZoomInfo(
                    shrunk
                      ? {
                          id: currentImage.id,
                          w: img.naturalWidth,
                          h: img.naturalHeight,
                        }
                      : null,
                  );
                }}
                onClick={(event) => {
                  if (!canZoom) return;
                  const r = event.currentTarget.getBoundingClientRect();
                  toggleZoom({
                    x: (event.clientX - r.left) / Math.max(1, r.width),
                    y: (event.clientY - r.top) / Math.max(1, r.height),
                  });
                }}
                className={`max-h-full max-w-full object-contain rounded-xl md:rounded-lg outline outline-1 -outline-offset-1 outline-white/[0.08] ${canZoom ? "cursor-zoom-in" : ""} ${zoomActive ? "invisible" : ""}`}
              />
            )}
          </div>

          {/* Zoomed 1:1 view: scroll, drag or swipe to pan; click to fit. */}
          {zoomActive && zoomInfo && (
            <div
              ref={zoomScrollRef}
              className="absolute inset-0 z-[5] flex overflow-auto overscroll-contain noScrollbar bg-[var(--bg-primary)] cursor-grab active:cursor-grabbing"
              data-lightbox-hscroll
              data-lightbox-zoom
              onPointerDown={(event) => {
                if (event.pointerType !== "mouse" || event.button !== 0) return;
                const el = event.currentTarget;
                zoomDragRef.current = {
                  x: event.clientX,
                  y: event.clientY,
                  left: el.scrollLeft,
                  top: el.scrollTop,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const drag = zoomDragRef.current;
                if (!drag) return;
                const dx = event.clientX - drag.x;
                const dy = event.clientY - drag.y;
                if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
                event.currentTarget.scrollLeft = drag.left - dx;
                event.currentTarget.scrollTop = drag.top - dy;
              }}
              onPointerUp={() => {
                // A pan must not also count as the "click to fit" after it.
                zoomDraggedRef.current = Boolean(zoomDragRef.current?.moved);
                zoomDragRef.current = null;
              }}
              onPointerLeave={() => {
                zoomDragRef.current = null;
              }}
              onClick={() => {
                const dragged = zoomDraggedRef.current;
                zoomDraggedRef.current = false;
                if (!dragged) setZoomed(false);
              }}
            >
              <img
                src={currentImage.url}
                alt={currentImage.prompt}
                draggable={false}
                className="m-auto max-w-none shrink-0 select-none"
                style={{ width: zoomInfo.w, height: zoomInfo.h }}
              />
            </div>
          )}

          {/* Zoom toggle (stills shown smaller than their pixels) */}
          {canZoom && (
            <button
              type="button"
              onClick={() => toggleZoom()}
              className="absolute bottom-3 right-3 z-20 p-2 rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors"
              aria-label={zoomActive ? "Fit to screen" : "Zoom to actual size"}
              aria-pressed={zoomActive}
              aria-keyshortcuts="Z"
              title={
                zoomActive ? "Fit to screen (Z)" : "Zoom to actual size (Z)"
              }
            >
              {zoomActive ? (
                <ZoomOut className="w-4 h-4" />
              ) : (
                <ZoomIn className="w-4 h-4" />
              )}
            </button>
          )}

          {quickEditOpen && canQuickEdit && (
            <QuickEditOverlay
              key={currentImage.id}
              image={currentImage}
              clientId={clientId}
              onClose={() => setQuickEditOpen(false)}
              onQueued={handleQuickEditQueued}
            />
          )}

          {lightbox.images.length > 1 && !compareActive && !zoomActive && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-white/80 text-xs tabular-nums">
              {lightbox.index + 1} / {lightbox.images.length}
            </div>
          )}
        </div>

        {/* Right: Detail panel (reference: ~420px, user row → prompt → gray tokens) */}
        <div className="glass-surface w-full shrink-0 flex flex-col bg-[var(--bg-primary)] pt-4 pb-[env(safe-area-inset-bottom)] md:w-[420px] md:pb-0">
          {/* User row — avatar, name, age (reference site) */}
          <div className="px-4 flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs font-medium shrink-0"
            >
              {isExternal ? "C" : "U"}
            </span>
            <span className="text-sm text-[var(--text-primary)]">
              {isExternal ? "Community" : "You"}
            </span>
            <time
              dateTime={currentImage.createdAt}
              title={new Date(currentImage.createdAt).toLocaleString()}
              className="text-xs text-[var(--text-muted)]"
            >
              {formatRelativeAge(currentImage.createdAt)}
            </time>
          </div>
          {/* Prompt + "+ use text" (reference site) */}
          <div className="px-4 mt-4 flex items-start gap-3">
            <button
              id="lightboxPrompt"
              onClick={handlePromptClick}
              disabled={!currentImage.prompt}
              className="flex-1 min-w-0 break-words text-sm text-[var(--text-primary)] text-left enabled:hover:text-[var(--accent-primary)] transition-colors leading-relaxed"
              title={currentImage.prompt ? "Click to use this prompt" : undefined}
              aria-label="Use this prompt"
            >
              {lightboxDisplayPrompt || "(no prompt)"}
            </button>
            {currentImage.prompt && (
              <button
                onClick={handlePromptClick}
                className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
                title="Put this prompt in the prompt bar"
                aria-label="Use prompt text"
              >
                + use text
              </button>
            )}
          </div>
          {/* Auto Refine decision trail — why the VLM policy chose its params */}
          {typeof currentImage.paramsMap?.auto_detail_summary === "string" && (
            <div className="px-4 mt-2.5">
              <p
                className="text-[12px] leading-4 text-[var(--text-muted)]"
                title="Auto Refine probe verdict and chosen parameters"
              >
                <span className="font-medium text-[var(--accent-primary)]">
                  auto refine:
                </span>{" "}
                {currentImage.paramsMap.auto_detail_summary}
              </p>
            </div>
          )}
          {/* Param tokens — gray 13px text, dashless display (reference site) */}
          {(lightboxProvenance || lightboxChips.length > 0) && (
            <div className="px-4 mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {lightboxProvenance && (
                <ProvenanceChip
                  provenance={lightboxProvenance}
                  tone="meta"
                  toolHref={
                    madeWithToolKey ? toolPageHref(madeWithToolKey) : undefined
                  }
                  onOpenTool={() => void openMadeWithTool()}
                />
              )}
              {lightboxChips.map((chip) => (
                <button
                  key={`${chip.key}:${chip.value}`}
                  onClick={() => handleParamClick(`${chip.flag} ${chip.value}`)}
                  className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  title={`Click to add ${chip.flag}${chip.value ? ` ${chip.value}` : ""}`}
                  aria-label={`Add ${chip.flag}${chip.value ? ` ${chip.value}` : ""} to the prompt`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}
          {/* Toolbar: like/download/share/more */}
          <div className="px-4 py-3 mt-1 border-b border-[var(--border-primary)] flex items-center gap-1.5">
            <button
              onClick={handleToggleLiked}
              className={`p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors ${isLiked ? "text-red-400" : "text-[var(--text-muted)]"}`}
              title={isLiked ? "Unlike" : "Like"}
              aria-label={isLiked ? "Unlike" : "Like"}
            >
              <Heart className={`w-4 h-4 ${isLiked ? "fill-current" : ""}`} />
            </button>
            <button
              onClick={handleDownload}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="Download"
              aria-label="Download"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => void handleShare()}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title={shareCopied ? "Link copied" : "Copy share link"}
              aria-label={shareCopied ? "Share link copied" : "Copy share link"}
            >
              <Share2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleCopyPrompt}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="Copy prompt"
              aria-label="Copy prompt"
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownloadMetadata}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="Download metadata"
              aria-label="Download metadata"
            >
              <FileText className="w-4 h-4" />
            </button>
            {/* Workflow JSON exists only for local runs. */}
            {!isExternal && (
              <button
                onClick={() => void handleDownloadWorkflow()}
                className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                title="Download workflow JSON"
                aria-label="Download workflow JSON"
              >
                <WorkflowIcon className="w-4 h-4" />
              </button>
            )}

            {/* The 3D view shows these as labelled buttons under the model. */}
            {!currentImage?.meshUrl && (
              <BlenderExportActions
                source={blenderSource}
                variant="icon"
                className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-60"
              />
            )}

            <div className="flex-1" />

            {/* More menu */}
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMoreMenu((value) => !value);
                  setShowCopyOptions(false);
                }}
                className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                title="More actions"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>

              {showMoreMenu && (
                <div
                  className="absolute right-0 top-full mt-2 w-52 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1.5 text-sm text-[var(--text-primary)] shadow-2xl z-30"
                  role="menu"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    onClick={() => setShowCopyOptions((value) => !value)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
                    role="menuitem"
                    aria-expanded={showCopyOptions}
                    aria-label="Copy options"
                    title="Copy prompt, image URL, seed or metadata"
                  >
                    <Copy className="h-4 w-4 text-[var(--text-muted)]" />
                    <span className="flex-1">Copy</span>
                    <ChevronRight
                      className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${showCopyOptions ? "rotate-90" : ""}`}
                    />
                  </button>

                  {showCopyOptions && (
                    <div className="mb-1 ml-7 mt-1 space-y-1 border-l border-[var(--border-primary)] pl-2">
                      <button
                        onClick={() => runMenuItem(handleCopyPrompt)}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        role="menuitem"
                        aria-label="Copy prompt"
                        title="Copy the full prompt with its parameters"
                      >
                        Copy prompt
                      </button>
                      <button
                        onClick={() => runMenuItem(handleCopyImageUrl)}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                        role="menuitem"
                        aria-label="Copy image URL"
                        title="Copy this image's URL"
                        disabled={!currentImage.url}
                      >
                        Copy image URL
                      </button>
                      <button
                        onClick={() => runMenuItem(handleCopySeed)}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        role="menuitem"
                        aria-label="Copy seed"
                        title="Copy the seed as --seed N"
                      >
                        Copy seed
                      </button>
                      <button
                        onClick={() => runMenuItem(handleCopyMetadata)}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        role="menuitem"
                        aria-label="Copy metadata"
                        title="Copy prompt, seed, model and params as JSON"
                      >
                        Copy metadata
                      </button>
                    </div>
                  )}

                  <button
                    onClick={() => runMenuItem(handleDownload)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
                    role="menuitem"
                    aria-label={lightboxMediaKind(currentImage) === "image" ? "Download Image" : "Download"}
                    title="Download the original file"
                  >
                    <Download className="h-4 w-4 text-[var(--text-muted)]" />
                    <span>{lightboxMediaKind(currentImage) === "image" ? "Download Image" : "Download"}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          {/* Scrollable actions area */}
          <div
            data-lightbox-scroll
            className="p-5 space-y-6 md:flex-1 md:overflow-y-auto"
          >
            <LightboxActions
              media={lightboxMediaKind(currentImage)}
              upscaleContent={imageUpscaleContent(currentImage)}
              external={isExternal}
              hasImageUrl={Boolean(currentImage.url)}
              canQuickEdit={canQuickEdit}
              quickEditOpen={quickEditOpen}
              canRetake={Boolean(editableVideoUrl(currentImage))}
              isRunning={isInlineToolRunning}
              onRun={runInlineTool}
              onOpenTool={openInTools}
              rerunSheetOpen={showRerunSheet}
              rerunSheet={
                <RerunSheet
                  basePrompt={getRerunPrompt()}
                  loading={isActionLoading("rerun")}
                  onSubmit={(o) => void handleRerunWithOverrides(o)}
                  onCancel={() => setShowRerunSheet(false)}
                />
              }
              openGroup={openCreatorGroup}
              onOpenGroup={(g) => {
                setOpenCreatorGroup(g);
                setCreatorGroupEditing(false);
              }}
              groupEditing={creatorGroupEditing}
              onGroupEditing={setCreatorGroupEditing}
              customizeOpen={showCustomize}
              onToggleCustomize={() => setShowCustomize((v) => !v)}
              toolsOpen={showTools}
              onToggleTools={() => setShowTools((v) => !v)}
              renderToolsPanel={(hiddenTools) => (
                <LightboxToolsPanel
                  media={lightboxMediaKind(currentImage)}
                  external={isExternal}
                  extraTools={hiddenTools}
                  onRun={runInlineTool}
                  isRunning={isInlineToolRunning}
                  onOpenTool={openInTools}
                />
              )}
            />

            {/* Insights — Adrift's own style read of this image */}
            <ActionSection title="Insights">
              {/* Style DNA + palette insights */}
              <div className="pt-2">
                <StyleInsights image={currentImage} />
              </div>
            </ActionSection>

            {/* Text / latent / custom outputs the media view can't show */}
            <ExtraOutputs promptId={currentPromptId} title="Other outputs" />

            {/* Source images */}
            {currentImage.sourceImages &&
              currentImage.sourceImages.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-[var(--text-muted)] mb-2">
                    Source / Similar
                  </h3>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {currentImage.sourceImages.map((src, i) => (
                      <button
                        key={i}
                        type="button"
                        className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-primary)] cursor-pointer hover:ring-2 hover:ring-[var(--accent-primary)]"
                        onClick={() => {
                          if (src.url) window.open(src.url, "_blank");
                        }}
                        title={src.filename || `Source ${i + 1}`}
                        aria-label={`Open source image ${src.filename || i + 1}`}
                      >
                        {src.url ? (
                          <img
                            src={src.url}
                            alt={src.filename || `Source ${i + 1}`}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full bg-[var(--bg-tertiary)] flex items-center justify-center text-[10px] text-[var(--text-muted)]">
                            {src.mode}
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white text-center py-0.5">
                          {src.mode === "style_ref"
                            ? "Style"
                            : src.mode === "image_prompt"
                              ? "IP"
                              : src.mode === "starting_frame"
                                ? "SF"
                                : src.mode}
                          {src.weight !== 1 ? ` ${src.weight.toFixed(1)}` : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
          </div>
          {/* Image info — compact footer */}
          <div className="px-4 py-2.5 border-t border-[var(--border-primary)] flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>{currentImage.seed ? `Seed ${currentImage.seed}` : ""}</span>
            <span>
              {currentImage.width} × {currentImage.height}
            </span>
          </div>
          {/* Model details — local runs only */}
          {!isExternal && (
            <div className="p-4 border-t border-[var(--border-primary)] space-y-2">
              {(currentImage.model ||
                currentImage.vae ||
                currentImage.loras?.length) && (
                <div className="space-y-1">
                  {currentImage.model && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-muted)]">Model:</span>
                      <button
                        onClick={() =>
                          handleParamClick(`--model ${currentImage.model}`)
                        }
                        className="min-w-0 text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors truncate"
                        title={`Use model ${currentImage.model}`}
                        aria-label={`Use model ${currentImage.model}`}
                      >
                        {currentImage.model}
                      </button>
                    </div>
                  )}
                  {currentImage.vae &&
                    currentImage.vae !== currentImage.model && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-[var(--text-muted)]">VAE:</span>
                        <button
                          onClick={() =>
                            handleParamClick(`--vae ${currentImage.vae}`)
                          }
                          className="min-w-0 text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors truncate"
                          title={`Use VAE ${currentImage.vae}`}
                          aria-label={`Use VAE ${currentImage.vae}`}
                        >
                          {currentImage.vae}
                        </button>
                      </div>
                    )}
                  {currentImage.loras && currentImage.loras.length > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-muted)]">LoRA:</span>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {currentImage.loras.map((lora, i) => (
                          <button
                            key={i}
                            onClick={() =>
                              handleParamClick(
                                `--lora ${lora.name}::${lora.strength}`,
                              )
                            }
                            className="max-w-full truncate px-1.5 py-0.5 rounded text-xs bg-[var(--bg-tertiary)] border border-[var(--border-primary)] hover:bg-[var(--accent-primary)]/20 hover:border-[var(--accent-primary)]/50 transition-colors"
                            title={`Add LoRA ${lora.filename || lora.name} at ${lora.strength}`}
                            aria-label={`Add LoRA ${lora.filename || lora.name} at ${lora.strength}`}
                          >
                            {lora.filename || lora.name} ({lora.strength})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Source images */}
              {currentImage.sourceImages &&
                currentImage.sourceImages.length > 0 && (
                  <div className="text-xs text-[var(--text-muted)]">
                    <span>
                      Source images: {currentImage.sourceImages.length}
                    </span>
                  </div>
                )}
            </div>
          )}
        </div>

        {/* Far right: vertical feed thumbnail rail (reference site) */}
        {lightbox.images.length > 1 && (
          <div
            className="order-first flex shrink-0 gap-1.5 overflow-x-auto px-3 pt-3 pb-1 noScrollbar md:order-none md:block md:w-[72px] md:overflow-x-hidden md:overflow-y-auto md:py-3 md:px-2 md:space-y-1.5"
            data-lightbox-hscroll
          >
            {lightbox.images.map((img) => (
              <button
                key={img.id}
                onClick={() => handleRelatedClick(img)}
                className={`relative block h-12 w-12 shrink-0 aspect-square rounded-[4px] overflow-hidden transition-opacity md:h-auto md:w-full ${
                  img.id === currentImage.id
                    ? "ring-2 ring-[var(--text-primary)] opacity-100"
                    : "opacity-55 hover:opacity-100"
                }`}
                title={img.prompt}
                aria-label={`View image: ${img.prompt.slice(0, 40)}`}
              >
                {img.url ? (
                  <img
                    src={img.url}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full bg-[var(--bg-tertiary)]" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Lightbox video: tries to start with sound, and falls back to muted when
 * the browser's autoplay policy refuses (otherwise the clip just sits on
 * its first frame). `playsInline` keeps iOS from jumping to fullscreen.
 */
function LightboxVideo({
  src,
  label,
  className,
}: {
  src: string;
  label: string;
  className: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    el.play?.()?.catch(() => {
      if (!live || !ref.current) return;
      ref.current.muted = true;
      void ref.current.play?.()?.catch(() => {});
    });
    return () => {
      live = false;
    };
  }, [src]);
  return (
    <video
      ref={ref}
      key={src}
      src={src}
      controls
      loop
      playsInline
      preload="auto"
      aria-label={label ? `Video: ${label.slice(0, 80)}` : "Video"}
      className={className}
    />
  );
}

// Action section: small caps heading over a stack of ActionRows

interface ActionSectionProps {
  title: string;
  children: React.ReactNode;
}

function ActionSection({ title, children }: ActionSectionProps) {
  return (
    <section aria-label={title} data-lightbox-section={title}>
      <h3 className="mb-2.5 text-[11px] font-medium text-[var(--text-muted)]">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export default Lightbox;
