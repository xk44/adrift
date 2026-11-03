/**
 * Zustand Stores
 * State management for generation tracking and UI state
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { getTabClientId, setTabClientId } from "@/lib/comfy/tabClientId";
import ojRegistry from "@/lib/oj/registry.json";
import { videoModelFlag } from "@/lib/oj/videoDefault";
import { normalizeSpeedSetting, speedTierFlag } from "@/lib/oj/speedTier";
import { isScopedOverrides } from "@/lib/workflowControlScope";
import { deriveRunStatus } from "@/lib/comfy/promptReconcile";
import {
  MOSS_LAYOUT_MAX_BOXES,
  type MossLayoutBox,
} from "@/lib/oj/mossLayout";
import {
  mergeRecentHistory,
  type RecentHistoryRun,
} from "@/lib/historyHydration";
import {
  DEFAULT_THEME_PREFS,
  getAccent,
  getPreset,
  sanitizeThemePrefs,
} from "@/lib/theme/themes";
import type {
  ImagineRun,
  ImagineJob,
  JobStatus,
  NavKey,
  StylesHubTab,
  NavParams,
  ThemeMode,
  GenerationSettings,
  GalleryImage,
  GalleryFolder,
  LightboxState,
  ContextMenuState,
  GenerationError,
  ErrorCategory,
  ImageAttachment,
} from "@/types";

type PromptParamDefinition = {
  flags?: string[];
  multi?: boolean;
};

const MULTI_VALUE_PROMPT_FLAGS = new Set(
  Object.values(
    (ojRegistry as { params?: Record<string, PromptParamDefinition> }).params ??
      {},
  )
    .filter((param) => param.multi === true)
    .flatMap((param) => param.flags ?? []),
);

// Generation Store - Tracks active generations and WebSocket state

/**
 * Draft-then-upscale: when a `--draft` run finishes, an entry is queued here.
 * The Gallery/Lightbox component subscribes and auto-fires the upscale action.
 */
export interface DraftUpscaleRequest {
  runId: string;
  jobIndex: number;
  refinerSlot: string;
  targetWidth: number;
  targetHeight: number;
}

interface GenerationState {
  // Stable client ID for ComfyUI (persisted)
  clientId: string;

  // Active runs being processed
  runs: ImagineRun[];

  // Draft-then-upscale: completed draft runs awaiting auto-upscale
  pendingDraftUpscales: DraftUpscaleRequest[];

  // WebSocket connection status
  wsConnected: boolean;
  wsReconnecting: boolean;

  // ComfyUI queue status
  queueRemaining: number;

  // Currently executing prompt
  currentPromptId: string | null;

  // Gallery of completed images
  gallery: GalleryImage[];

  // Folders for organizing gallery
  folders: GalleryFolder[];

  // Prompt history (last 50 prompts)
  promptHistory: string[];

  // Favorite prompts (persisted)
  favoritePrompts: Array<{
    id: string;
    prompt: string;
    createdAt: number;
    name?: string;
  }>;

  // Error state
  lastError: string | null;
  errors: GenerationError[];

  // ComfyUI reachability
  comfyReachable: boolean;
}

interface GenerationActions {
  // Run management
  addRun: (run: ImagineRun) => void;
  updateRun: (runId: string, update: Partial<ImagineRun>) => void;
  updateJob: (
    runId: string,
    jobIndex: number,
    update: Partial<ImagineJob>,
  ) => void;
  cancelJob: (promptId: string) => void;
  removeRun: (runId: string) => void;
  clearRuns: () => void;

  // Job status updates from WebSocket
  setJobStatus: (
    promptId: string,
    status: JobStatus,
    progress?: number,
    currentNode?: string | null,
    nodeLabel?: string | null,
    nodeProgress?: { current: number; total: number } | null,
  ) => void;
  setJobImages: (
    promptId: string,
    images: string[],
    media?: {
      videos?: string[];
      audios?: string[];
      meshes?: string[];
      texts?: string[];
    },
  ) => void;
  setJobError: (promptId: string, error: string) => void;

  // WebSocket state
  setWsConnected: (connected: boolean) => void;
  setWsReconnecting: (reconnecting: boolean) => void;
  setQueueRemaining: (count: number) => void;
  setCurrentPromptId: (promptId: string | null) => void;

  // Gallery management
  addToGallery: (images: GalleryImage[]) => void;
  removeFromGallery: (imageId: string) => void;
  toggleLiked: (imageId: string) => void;
  toggleHidden: (imageId: string) => void;
  clearGallery: () => void;
  addImageToFolder: (imageId: string, folderId: string) => void;
  removeImageFromFolder: (imageId: string, folderId: string) => void;
  hydrateRecentHistory: (runs: RecentHistoryRun[]) => void;

  // Folder management
  addFolder: (name: string) => void;
  removeFolder: (folderId: string) => void;
  renameFolder: (folderId: string, name: string) => void;

  // Prompt history
  addToPromptHistory: (prompt: string) => void;
  clearPromptHistory: () => void;

  // Prompt favorites
  addFavoritePrompt: (prompt: string, name?: string) => void;
  removeFavoritePrompt: (id: string) => void;
  renameFavoritePrompt: (id: string, name: string) => void;

  // Error handling
  setError: (error: string | null) => void;
  addError: (error: Omit<GenerationError, "timestamp">) => void;
  clearError: (index: number) => void;
  clearAllErrors: () => void;

  // ComfyUI reachability
  setComfyReachable: (reachable: boolean) => void;

  // Reset client ID (for debugging)
  resetClientId: () => void;

  // Draft-then-upscale: consume the next pending upscale request
  consumeDraftUpscale: () => DraftUpscaleRequest | undefined;
}

export const useGenerationStore = createWithEqualityFn<GenerationState & GenerationActions>()(
  persist(
    (set, get) => ({
      // Per tab (sessionStorage), never persisted: a clientId shared by two
      // tabs makes ComfyUI deliver each job's events to only one of them.
      clientId: getTabClientId(),
      runs: [],
      pendingDraftUpscales: [],
      wsConnected: false,
      wsReconnecting: false,
      queueRemaining: 0,
      currentPromptId: null,
      gallery: [],
      folders: [],
      promptHistory: [],
      favoritePrompts: [],
      lastError: null,
      errors: [],
      comfyReachable: false,

      // Run management
      addRun: (run) =>
        set((state) => ({
          runs: [run, ...state.runs],
        })),

      updateRun: (runId, update) =>
        set((state) => ({
          runs: state.runs.map((r) =>
            r.run_id === runId ? { ...r, ...update } : r,
          ),
        })),

      updateJob: (runId, jobIndex, update) =>
        set((state) => ({
          runs: state.runs.map((r) => {
            if (r.run_id !== runId) return r;
            const jobs = r.jobs.map((j, i) =>
              i === jobIndex ? { ...j, ...update } : j,
            );
            // Keep the run status in step with a job status change.
            return update.status
              ? { ...r, jobs, status: deriveRunStatus(jobs, r.status) }
              : { ...r, jobs };
          }),
        })),

      cancelJob: (promptId) =>
        set((state) => ({
          runs: state.runs.map((r) => {
            const jobs = r.jobs.map((j) =>
              j.prompt_id === promptId
                ? {
                    ...j,
                    status: "cancelled" as const,
                    progress: 0,
                    currentNode: undefined,
                    currentNodeLabel: undefined,
                    nodeProgress: undefined,
                    completedAt: Date.now(),
                  }
                : j,
            );
            return { ...r, jobs, status: deriveRunStatus(jobs, r.status) };
          }),
        })),

      removeRun: (runId) =>
        set((state) => ({
          runs: state.runs.filter((r) => r.run_id !== runId),
        })),

      clearRuns: () => set({ runs: [] }),

      // Job status updates (finds job by prompt_id)
      setJobStatus: (
        promptId,
        status,
        progress,
        currentNode,
        nodeLabel,
        nodeProgress,
      ) => {
        const target = get()
          .runs.flatMap((r) => r.jobs)
          .find((j) => j.prompt_id === promptId);
        if (!target) return;
        const nextNode =
          currentNode === null
            ? undefined
            : (currentNode ?? target.currentNode);
        const nextLabel =
          nodeLabel === null
            ? undefined
            : (nodeLabel ?? target.currentNodeLabel);
        const nextNodeProgress =
          nodeProgress === null
            ? undefined
            : (nodeProgress ?? target.nodeProgress);
        // No-op when the effective job state is unchanged — WS progress
        // floods otherwise hand every subscriber fresh identities each tick.
        if (
          status === target.status &&
          Math.round(progress ?? target.progress ?? -1) ===
            Math.round(target.progress ?? -1) &&
          nextNode === target.currentNode &&
          nextLabel === target.currentNodeLabel &&
          nextNodeProgress?.current === target.nodeProgress?.current &&
          nextNodeProgress?.total === target.nodeProgress?.total &&
          !(status === "running" && target.startedAt === undefined) &&
          !(
            (status === "done" || status === "error") &&
            target.completedAt === undefined
          )
        ) {
          return;
        }
        set((state) => ({
          runs: state.runs.map((r) => {
            // Only the run containing the job gets a new identity
            if (!r.jobs.some((j) => j.prompt_id === promptId)) return r;
            const jobs = r.jobs.map((j) => {
              if (j.prompt_id !== promptId) return j;
              // Track completed nodes: increment when moving to a new node
              const prevNode = j.currentNode;
              const completedNodes =
                currentNode === null
                  ? (j.completedNodes ?? 0) // completion, don't increment again
                  : currentNode !== undefined &&
                      currentNode !== prevNode &&
                      prevNode !== undefined
                    ? (j.completedNodes ?? 0) + 1
                    : (j.completedNodes ?? 0);
              return {
                ...j,
                status,
                progress: progress ?? j.progress,
                currentNode: nextNode,
                currentNodeLabel: nextLabel,
                nodeProgress: nextNodeProgress,
                completedNodes,
                startedAt:
                  status === "running"
                    ? (j.startedAt ?? Date.now())
                    : j.startedAt,
                completedAt:
                  status === "done" || status === "error"
                    ? (j.completedAt ?? Date.now())
                    : j.completedAt,
              };
            });
            const runStatus = deriveRunStatus(jobs, r.status);

            // Draft-then-upscale: if a draft run just completed, enqueue
            // upscale requests for each done job.
            if (r.draftUpscale && runStatus === "done" && r.status !== "done") {
              const upscales: DraftUpscaleRequest[] = jobs
                .filter((j) => j.status === "done" && j.images.length > 0)
                .map((j) => ({
                  runId: r.run_id,
                  jobIndex: j.index,
                  refinerSlot: r.refinerSlot ?? "upscale_subtle",
                  targetWidth: r.draftTargetWidth ?? r.width,
                  targetHeight: r.draftTargetHeight ?? r.height,
                }));
              if (upscales.length > 0) {
                // Queue draft upscales (will be picked up next tick)
                queueMicrotask(() => {
                  set((s) => ({
                    pendingDraftUpscales: [
                      ...s.pendingDraftUpscales,
                      ...upscales,
                    ],
                  }));
                });
              }
            }

            return { ...r, jobs, status: runStatus };
          }),
        }));
      },

      setJobImages: (promptId, images, media) =>
        set((state) => ({
          runs: state.runs.map((r) => ({
            ...r,
            jobs: r.jobs.map((j) =>
              j.prompt_id === promptId
                ? {
                    ...j,
                    images,
                    videos: media?.videos ?? j.videos,
                    audios: media?.audios ?? j.audios,
                    meshes: media?.meshes ?? j.meshes,
                    texts: media?.texts ?? j.texts,
                    status: "done" as const,
                    progress: 100,
                    currentNode: undefined,
                  }
                : j,
            ),
            status: (() => {
              const jobs = r.jobs.map((j) =>
                j.prompt_id === promptId
                  ? {
                      ...j,
                      images,
                      videos: media?.videos ?? j.videos,
                      audios: media?.audios ?? j.audios,
                      meshes: media?.meshes ?? j.meshes,
                      texts: media?.texts ?? j.texts,
                      status: "done" as const,
                      progress: 100,
                      currentNode: undefined,
                    }
                  : j,
              );
              return deriveRunStatus(jobs, r.status);
            })(),
          })),
        })),

      setJobError: (promptId, error) =>
        set((state) => ({
          runs: state.runs.map((r) => ({
            ...r,
            jobs: r.jobs.map((j) =>
              j.prompt_id === promptId
                ? {
                    ...j,
                    error,
                    status: "error" as const,
                    currentNode: undefined,
                  }
                : j,
            ),
            status: (() => {
              const jobs = r.jobs.map((j) =>
                j.prompt_id === promptId
                  ? {
                      ...j,
                      error,
                      status: "error" as const,
                      currentNode: undefined,
                    }
                  : j,
              );
              return deriveRunStatus(jobs, r.status);
            })(),
          })),
        })),

      // WebSocket state
      setWsConnected: (connected) =>
        set({ wsConnected: connected, wsReconnecting: false }),

      setWsReconnecting: (reconnecting) =>
        set({ wsReconnecting: reconnecting }),

      setQueueRemaining: (count) => set({ queueRemaining: count }),

      setCurrentPromptId: (promptId) => set({ currentPromptId: promptId }),

      // Gallery management
      addToGallery: (images) =>
        set((state) => {
          // Dedupe re-adds of the same run while keeping every output of
          // multi-image jobs: count existing images per runId:jobIndex and
          // only accept batch images at positions beyond that count (images
          // arrive in stable order from runToGalleryImages).
          const existingCounts = new Map<string, number>();
          for (const img of state.gallery) {
            if (img.runId == null || img.jobIndex == null) continue;
            const key = `${img.runId}:${img.jobIndex}`;
            existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
          }
          const batchPos = new Map<string, number>();
          const deduped = images.filter((img) => {
            if (img.runId == null || img.jobIndex == null) return true;
            const key = `${img.runId}:${img.jobIndex}`;
            const pos = batchPos.get(key) ?? 0;
            batchPos.set(key, pos + 1);
            return pos >= (existingCounts.get(key) ?? 0);
          });
          if (deduped.length === 0) return state;
          const combined = [...deduped, ...state.gallery];
          // Cap at 1000 entries — drop oldest (tail)
          const capped =
            combined.length > 1000 ? combined.slice(0, 1000) : combined;
          return { gallery: capped };
        }),

      removeFromGallery: (imageId) =>
        set((state) => ({
          gallery: state.gallery.filter((img) => img.id !== imageId),
        })),

      toggleLiked: (imageId) =>
        set((state) => ({
          gallery: state.gallery.map((img) =>
            img.id === imageId ? { ...img, liked: !img.liked } : img,
          ),
        })),

      toggleHidden: (imageId) =>
        set((state) => ({
          gallery: state.gallery.map((img) =>
            img.id === imageId ? { ...img, hidden: !img.hidden } : img,
          ),
        })),

      clearGallery: () => set({ gallery: [] }),

      addImageToFolder: (imageId, folderId) =>
        set((state) => ({
          gallery: state.gallery.map((img) =>
            img.id === imageId
              ? {
                  ...img,
                  folderIds: [...new Set([...(img.folderIds ?? []), folderId])],
                }
              : img,
          ),
        })),

      removeImageFromFolder: (imageId, folderId) =>
        set((state) => ({
          gallery: state.gallery.map((img) =>
            img.id === imageId
              ? {
                  ...img,
                  folderIds: (img.folderIds ?? []).filter(
                    (f) => f !== folderId,
                  ),
                }
              : img,
          ),
        })),

      hydrateRecentHistory: (runs) =>
        set((state) => mergeRecentHistory(runs, state.runs, state.gallery)),

      addFolder: (name) =>
        set((state) => ({
          folders: [
            ...state.folders,
            { id: crypto.randomUUID(), name, createdAt: Date.now() },
          ],
        })),

      removeFolder: (folderId) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== folderId),
          gallery: state.gallery.map((img) => ({
            ...img,
            folderIds: (img.folderIds ?? []).filter((f) => f !== folderId),
          })),
        })),

      renameFolder: (folderId, name) =>
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, name } : f,
          ),
        })),

      addToPromptHistory: (prompt) =>
        set((state) => {
          // Trim to 50, dedupe recent
          const trimmed = [
            prompt,
            ...state.promptHistory.filter((p) => p !== prompt),
          ].slice(0, 50);
          return { promptHistory: trimmed };
        }),

      clearPromptHistory: () => set({ promptHistory: [] }),

      addFavoritePrompt: (prompt, name) =>
        set((state) => ({
          favoritePrompts: [
            { id: crypto.randomUUID(), prompt, createdAt: Date.now(), name },
            ...state.favoritePrompts,
          ],
        })),

      removeFavoritePrompt: (id) =>
        set((state) => ({
          favoritePrompts: state.favoritePrompts.filter((p) => p.id !== id),
        })),

      renameFavoritePrompt: (id, name) =>
        set((state) => ({
          favoritePrompts: state.favoritePrompts.map((p) =>
            p.id === id ? { ...p, name } : p,
          ),
        })),

      // Error handling
      setError: (error) => set({ lastError: error }),
      addError: (error) =>
        set((state) => ({
          errors: [
            { ...error, timestamp: Date.now() },
            ...state.errors.slice(0, 9), // Keep last 10 errors
          ],
          lastError: error.message,
        })),
      clearError: (index) =>
        set((state) => ({
          errors: state.errors.filter((_, i) => i !== index),
          lastError: state.errors.length <= 1 ? null : state.lastError,
        })),
      clearAllErrors: () => set({ errors: [], lastError: null }),

      // ComfyUI reachability
      setComfyReachable: (reachable) => set({ comfyReachable: reachable }),

      resetClientId: () => {
        const clientId = crypto.randomUUID();
        setTabClientId(clientId);
        set({ clientId });
      },

      // Draft-then-upscale: pop the first pending request
      consumeDraftUpscale: () => {
        const pending = get().pendingDraftUpscales;
        if (pending.length === 0) return undefined;
        const [first, ...rest] = pending;
        set({ pendingDraftUpscales: rest });
        return first;
      },
    }),
    {
      name: STORAGE_KEYS.generation,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        gallery: state.gallery,
        folders: state.folders,
        promptHistory: state.promptHistory,
        favoritePrompts: state.favoritePrompts,
      }),
      // Older saves carry a localStorage clientId shared by every tab; keep
      // this tab's own id instead.
      merge: (persisted, current) => {
        const { clientId: _shared, ...rest } = (persisted ?? {}) as Partial<
          GenerationState & GenerationActions
        >;
        void _shared;
        return { ...current, ...rest };
      },
    },
  ),
);

// UI Store - UI state, settings, and preferences

interface UIState {
  // Navigation
  activeNav: NavKey;
  navParams: NavParams;
  stylesHubTab: StylesHubTab;

  // Theme (see src/lib/theme/themes.ts)
  theme: ThemeMode;
  /** Follow prefers-color-scheme; `theme` then tracks the system. */
  followSystem: boolean;
  /** Preset used in dark mode / light mode. */
  darkPalette: string;
  lightPalette: string;
  /** Accent swatch id. */
  accent: string;
  /**
   * Mode reported by the ComfyUI host while running as its overlay. Wins over
   * `theme` until the user picks a theme here. Never persisted.
   */
  hostTheme: ThemeMode | null;
  glassUI: boolean;

  // Settings panel
  settingsOpen: boolean;
  settings: GenerationSettings;

  // Lightbox
  lightbox: LightboxState | null;

  // Context menu
  contextMenu: ContextMenuState | null;

  // Prompt input
  promptValue: string;
  promptFocused: boolean;
  selectedWorkflowPath: string | null;
  selectedWorkflowName: string | null;

  // Default workflow (persisted)
  defaultWorkflowPath: string | null;
  defaultWorkflowName: string | null;

  // Action workflow overrides (persisted)
  actionWorkflowMap: Record<
    string,
    { workflowPath: string; workflowName?: string | null }
  >;

  // Workflow control overrides (persisted) — dynamic node input overrides
  // keyed as `${nodeId}.${inputKey}` → value, applied before queueing
  workflowControlOverrides: Record<string, unknown>;

  // MOSS-Image layout boxes (persisted); sent only for the MOSS t2i workflow
  mossLayoutBoxes: MossLayoutBox[];

  // Image attachments for prompt
  imageAttachments: import("@/types").ImageAttachment[];
  imageAttachmentsLocked: boolean; // Keep attachments after generation
  imageSelectorOpen: boolean;
  imageSelectorDefaultMode: import("@/types").ImageMode | null;

  // Loading states
  isGenerating: boolean;

  // Sidebar collapsed
  sidebarCollapsed: boolean;

  // Attachment sections expanded
  attachmentSectionsExpanded: boolean;
}

interface UIActions {
  // Navigation
  setActiveNav: (nav: NavKey) => void;
  setNavParams: (params: NavParams) => void;
  setStylesHubTab: (tab: StylesHubTab) => void;

  // Theme
  /** Pick a mode explicitly (turns off follow-system). */
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  /** Apply a preset: stores it for its mode and switches to that mode. */
  setPalette: (paletteId: string) => void;
  setAccent: (accentId: string) => void;
  setFollowSystem: (follow: boolean) => void;
  /** System color-scheme changed while following it (keeps followSystem). */
  syncSystemTheme: (theme: ThemeMode) => void;
  /** ComfyUI overlay host palette changed (null clears the override). */
  setHostTheme: (theme: ThemeMode | null) => void;
  setGlassUI: (v: boolean) => void;

  // Settings
  toggleSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (update: Partial<GenerationSettings>) => void;
  resetSettings: () => void;

  // Lightbox
  openLightbox: (state: LightboxState) => void;
  closeLightbox: () => void;
  setLightboxIndex: (index: number) => void;

  // Context menu
  openContextMenu: (state: ContextMenuState) => void;
  closeContextMenu: () => void;

  // Prompt
  setPromptValue: (value: string) => void;
  setPromptFocused: (focused: boolean) => void;
  /** Next submit jumps the ComfyUI pending queue (not persisted). */
  runNext: boolean;
  setRunNext: (runNext: boolean) => void;
  setSelectedWorkflow: (
    workflowPath: string | null,
    workflowName?: string | null,
  ) => void;
  appendToPrompt: (text: string) => void;
  replacePromptParam: (param: string, value: string) => void;

  // Default workflow
  setDefaultWorkflow: (
    workflowPath: string,
    workflowName: string | null,
  ) => void;
  clearDefaultWorkflow: () => void;
  useDefaultWorkflow: () => void;

  // Action workflow mapping
  setActionWorkflowMapping: (
    actionId: string,
    workflowPath: string,
    workflowName?: string | null,
  ) => void;
  clearActionWorkflowMapping: (actionId: string) => void;

  // Workflow control overrides
  setWorkflowControlOverrides: (overrides: Record<string, unknown>) => void;
  updateWorkflowControlOverride: (key: string, value: unknown) => void;
  clearWorkflowControlOverrides: () => void;
  addMossLayoutBox: (box: MossLayoutBox) => void;
  updateMossLayoutBox: (index: number, patch: Partial<MossLayoutBox>) => void;
  removeMossLayoutBox: (index: number) => void;
  clearMossLayoutBoxes: () => void;

  // Image attachments
  addImageAttachment: (attachment: import("@/types").ImageAttachment) => void;
  removeImageAttachment: (id: string) => void;
  updateImageAttachment: (
    id: string,
    update: Partial<import("@/types").ImageAttachment>,
  ) => void;
  reorderImageAttachment: (id: string, overId: string) => void;
  clearImageAttachments: () => void;
  setImageAttachmentsLocked: (locked: boolean) => void;
  setImageSelectorOpen: (open: boolean) => void;
  setImageSelectorDefaultMode: (
    mode: import("@/types").ImageMode | null,
  ) => void;

  // Loading
  setIsGenerating: (generating: boolean) => void;

  // Sidebar
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Attachment sections
  toggleAttachmentSections: () => void;
  setAttachmentSectionsExpanded: (expanded: boolean) => void;
}

const defaultSettings: GenerationSettings = {
  aspect: "1:1",
  ratio: 1,
  stylize: 100,
  weird: 0,
  chaos: 0,
  modelMode: "Standard",
  // Engine selector: custom | zimage-turbo | ideogram4 | krea-2-*
  modelVersion: "custom",
  krea2Backend: "comfyui",
  videoModel: "ltx25",
  h3Speed: "off",
  videoBatch: 1,
  personalize: false,
  speed: "Standard",
  privacy: "Public",
  quality: 1,
  loras: [],
  batchSize: 1,
};

/**
 * Persisted settings from older builds: the cosmetic Turbo / Fast / Relax
 * speed becomes the real tier (Turbo -> Draft, Fast -> Standard,
 * Relax -> Quality) and the hidden Weirdness value is cleared so it is never
 * sent again.
 */
export function migrateGenerationSettings(
  settings: Partial<GenerationSettings>,
): GenerationSettings {
  return {
    ...defaultSettings,
    ...settings,
    speed: normalizeSpeedSetting(settings.speed),
    weird: 0,
  };
}

const CREF_SEGMENT_RE = /(?:^|\s)--cref\s+(?!--)\S+(?:\s+--cw\s+(?!--)\S+)?/g;

function normalizeImageAttachment(
  attachment: ImageAttachment,
): ImageAttachment {
  if (attachment.mode !== "char_ref") return attachment;
  return {
    ...attachment,
    weight: Math.max(
      0,
      Math.min(100, attachment.weight === 1 ? 100 : attachment.weight),
    ),
  };
}

function formatCharacterRefs(attachments: ImageAttachment[]): string {
  return attachments
    .filter((attachment) => attachment.mode === "char_ref")
    .map(
      (attachment) =>
        `--cref ${attachment.url} --cw ${Math.max(
          0,
          Math.min(100, attachment.weight),
        )}`,
    )
    .join(" ");
}

function withSyncedCharacterRefs(state: {
  imageAttachments: ImageAttachment[];
  promptValue: string;
}) {
  const promptWithoutCharacterRefs = state.promptValue
    .replace(CREF_SEGMENT_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const characterRefs = formatCharacterRefs(state.imageAttachments);

  return {
    imageAttachments: state.imageAttachments,
    promptValue: [promptWithoutCharacterRefs, characterRefs]
      .filter(Boolean)
      .join(" "),
  };
}

export const useUIStore = createWithEqualityFn<UIState & UIActions>()(
  persist(
    (set, get) => ({
      activeNav: "create",
      navParams: {},
      stylesHubTab: "library",
      ...DEFAULT_THEME_PREFS,
      hostTheme: null,
      glassUI: false,
      settingsOpen: false,
      settings: defaultSettings,
      lightbox: null,
      contextMenu: null,
      promptValue: "",
      promptFocused: false,
      selectedWorkflowPath: null,
      selectedWorkflowName: null,
      defaultWorkflowPath: null,
      defaultWorkflowName: null,
      actionWorkflowMap: {},
      workflowControlOverrides: {},
      mossLayoutBoxes: [],
      imageAttachments: [],
      imageAttachmentsLocked: false,
      imageSelectorOpen: false,
      imageSelectorDefaultMode: null,
      isGenerating: false,
      sidebarCollapsed: false,
      // behavior: collapsed until an image is dragged in or attached
      attachmentSectionsExpanded: false,

      // Navigation
      setActiveNav: (nav) => set({ activeNav: nav }),
      setNavParams: (params) => set({ navParams: params }),
      setStylesHubTab: (tab) => set({ stylesHubTab: tab }),

      // Theme
      // An explicit pick in Adrift drops the host override.
      setTheme: (theme) => set({ theme, followSystem: false, hostTheme: null }),
      toggleTheme: () =>
        set((state) => ({
          theme: (state.hostTheme ?? state.theme) === "dark" ? "light" : "dark",
          followSystem: false,
          hostTheme: null,
        })),
      setPalette: (paletteId) => {
        const preset = getPreset(paletteId);
        if (!preset) return;
        set(
          preset.mode === "dark"
            ? {
                darkPalette: preset.id,
                theme: "dark",
                followSystem: false,
                hostTheme: null,
              }
            : {
                lightPalette: preset.id,
                theme: "light",
                followSystem: false,
                hostTheme: null,
              },
        );
      },
      setAccent: (accentId) => {
        if (getAccent(accentId)) set({ accent: accentId });
      },
      setFollowSystem: (follow) =>
        set(follow ? { followSystem: true, hostTheme: null } : { followSystem: false }),
      syncSystemTheme: (theme) => set({ theme }),
      setHostTheme: (hostTheme) => set({ hostTheme }),
      setGlassUI: (v) => set({ glassUI: v }),

      // Settings
      toggleSettings: () =>
        set((state) => ({ settingsOpen: !state.settingsOpen })),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      updateSettings: (update) =>
        set((state) => ({
          settings: { ...state.settings, ...update },
        })),
      resetSettings: () => set({ settings: defaultSettings }),

      // Lightbox
      openLightbox: (state) => set({ lightbox: state }),
      closeLightbox: () => set({ lightbox: null }),
      setLightboxIndex: (index) =>
        set((state) =>
          state.lightbox ? { lightbox: { ...state.lightbox, index } } : {},
        ),

      // Context menu
      openContextMenu: (state) => set({ contextMenu: state }),
      closeContextMenu: () => set({ contextMenu: null }),

      // Prompt
      setPromptValue: (value) => set({ promptValue: value }),
      setPromptFocused: (focused) => set({ promptFocused: focused }),
      runNext: false,
      setRunNext: (runNext) => set({ runNext }),
      setSelectedWorkflow: (workflowPath, workflowName = null) =>
        set({
          selectedWorkflowPath: workflowPath,
          selectedWorkflowName: workflowName,
        }),

      // Default workflow
      setDefaultWorkflow: (workflowPath, workflowName) =>
        set({
          defaultWorkflowPath: workflowPath,
          defaultWorkflowName: workflowName,
        }),

      clearDefaultWorkflow: () =>
        set({ defaultWorkflowPath: null, defaultWorkflowName: null }),

      useDefaultWorkflow: () => {
        const { defaultWorkflowPath, defaultWorkflowName } = get();
        if (defaultWorkflowPath) {
          set({
            selectedWorkflowPath: defaultWorkflowPath,
            selectedWorkflowName: defaultWorkflowName,
          });
        }
      },

      setActionWorkflowMapping: (actionId, workflowPath, workflowName = null) =>
        set((state) => ({
          actionWorkflowMap: {
            ...state.actionWorkflowMap,
            [actionId]: { workflowPath, workflowName },
          },
        })),

      clearActionWorkflowMapping: (actionId) =>
        set((state) => {
          const next = { ...state.actionWorkflowMap };
          delete next[actionId];
          return { actionWorkflowMap: next };
        }),

      setWorkflowControlOverrides: (overrides) =>
        set({ workflowControlOverrides: overrides }),

      updateWorkflowControlOverride: (key, value) =>
        set((state) => ({
          workflowControlOverrides: {
            ...state.workflowControlOverrides,
            [key]: value,
          },
        })),

      clearWorkflowControlOverrides: () =>
        set({ workflowControlOverrides: {} }),

      addMossLayoutBox: (box) =>
        set((state) =>
          state.mossLayoutBoxes.length >= MOSS_LAYOUT_MAX_BOXES
            ? state
            : { mossLayoutBoxes: [...state.mossLayoutBoxes, box] },
        ),
      updateMossLayoutBox: (index, patch) =>
        set((state) => ({
          mossLayoutBoxes: state.mossLayoutBoxes.map((b, i) =>
            i === index ? { ...b, ...patch } : b,
          ),
        })),
      removeMossLayoutBox: (index) =>
        set((state) => ({
          mossLayoutBoxes: state.mossLayoutBoxes.filter((_, i) => i !== index),
        })),
      clearMossLayoutBoxes: () => set({ mossLayoutBoxes: [] }),

      appendToPrompt: (text) =>
        set((state) => {
          const current = state.promptValue.trim();
          return { promptValue: current ? `${current} ${text}` : text };
        }),

      replacePromptParam: (param, value) =>
        set((state) => {
          const current = state.promptValue;
          const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const valuePattern = MULTI_VALUE_PROMPT_FLAGS.has(param)
            ? "(\\s+(?!--)\\S+)*"
            : "(\\s+(?!--)\\S+)?";
          // Match the flag at a word boundary plus its value token(s), if any.
          // Values must not be another flag, so "--raw --ar 1:1" doesn't
          // swallow "--ar" when matching "--raw". Multi-value params consume
          // every following non-flag token.
          const regex = new RegExp(`${escaped}(?=\\s|$)${valuePattern}`);
          const replacement = value ? `${param} ${value}` : param;

          if (regex.test(current)) {
            // Same flag present (any value) — replace in place. Clicking the
            // identical chip twice is a no-op rather than a duplicate.
            const replaced = current
              .replace(regex, replacement)
              .replace(/\s{2,}/g, " ")
              .trim();
            return { promptValue: replaced };
          }
          return { promptValue: `${current} ${replacement}`.trim() };
        }),

      // Image attachments — adding one reveals the attachment sections
      // (covers Use Image / Use Style / Use Start Frame and drops)
      addImageAttachment: (attachment) =>
        set((state) => {
          const imageAttachments = [
            ...state.imageAttachments,
            normalizeImageAttachment(attachment),
          ];
          const synced =
            attachment.mode === "char_ref"
              ? withSyncedCharacterRefs({ ...state, imageAttachments })
              : { imageAttachments };
          return {
            ...synced,
            attachmentSectionsExpanded: true,
          };
        }),

      removeImageAttachment: (id) =>
        set((state) => {
          const removed = state.imageAttachments.find((a) => a.id === id);
          const imageAttachments = state.imageAttachments.filter(
            (a) => a.id !== id,
          );
          return removed?.mode === "char_ref"
            ? withSyncedCharacterRefs({ ...state, imageAttachments })
            : { imageAttachments };
        }),

      updateImageAttachment: (id, update) =>
        set((state) => {
          const current = state.imageAttachments.find((a) => a.id === id);
          const imageAttachments = state.imageAttachments.map((a) =>
            a.id === id ? normalizeImageAttachment({ ...a, ...update }) : a,
          );
          return current?.mode === "char_ref" || update.mode === "char_ref"
            ? withSyncedCharacterRefs({ ...state, imageAttachments })
            : { imageAttachments };
        }),

      reorderImageAttachment: (id, overId) =>
        set((state) => {
          if (id === overId) return state;
          const fromIndex = state.imageAttachments.findIndex(
            (a) => a.id === id,
          );
          const toIndex = state.imageAttachments.findIndex(
            (a) => a.id === overId,
          );
          if (fromIndex < 0 || toIndex < 0) return state;

          const imageAttachments = [...state.imageAttachments];
          const [moved] = imageAttachments.splice(fromIndex, 1);
          imageAttachments.splice(toIndex, 0, moved);

          return state.imageAttachments.some((a) => a.mode === "char_ref")
            ? withSyncedCharacterRefs({ ...state, imageAttachments })
            : { imageAttachments };
        }),

      clearImageAttachments: () =>
        set((state) =>
          state.imageAttachments.some((a) => a.mode === "char_ref")
            ? withSyncedCharacterRefs({ ...state, imageAttachments: [] })
            : { imageAttachments: [] },
        ),

      setImageAttachmentsLocked: (locked) =>
        set({ imageAttachmentsLocked: locked }),

      setImageSelectorOpen: (open) => set({ imageSelectorOpen: open }),
      setImageSelectorDefaultMode: (mode) =>
        set({ imageSelectorDefaultMode: mode }),

      // Loading
      setIsGenerating: (generating) => set({ isGenerating: generating }),

      // Sidebar
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      // Attachment sections
      toggleAttachmentSections: () =>
        set((state) => ({
          attachmentSectionsExpanded: !state.attachmentSectionsExpanded,
        })),
      setAttachmentSectionsExpanded: (expanded) =>
        set({ attachmentSectionsExpanded: expanded }),
    }),
    {
      name: STORAGE_KEYS.ui,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        activeNav: state.activeNav,
        stylesHubTab: state.stylesHubTab,
        theme: state.theme,
        followSystem: state.followSystem,
        darkPalette: state.darkPalette,
        lightPalette: state.lightPalette,
        accent: state.accent,
        glassUI: state.glassUI,
        settings: state.settings,
        selectedWorkflowPath: state.selectedWorkflowPath,
        selectedWorkflowName: state.selectedWorkflowName,
        defaultWorkflowPath: state.defaultWorkflowPath,
        defaultWorkflowName: state.defaultWorkflowName,
        actionWorkflowMap: state.actionWorkflowMap,
        sidebarCollapsed: state.sidebarCollapsed,
        workflowControlOverrides: state.workflowControlOverrides,
        mossLayoutBoxes: state.mossLayoutBoxes,
      }),
      // Older builds persisted a flat node-id map that leaked into every
      // graph; only graph-scoped overrides survive a reload.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState>;
        // Workflows / Pipelines / Manager were merged into Setup.
        const legacyNav = p.activeNav as string | undefined;
        if (
          legacyNav === "workflows" ||
          legacyNav === "pipelines" ||
          legacyNav === "manager"
        ) {
          p.activeNav = "setup";
        }
        return {
          ...current,
          ...p,
          // Older builds stored only `theme`; bad ids fall back to defaults.
          ...sanitizeThemePrefs(p),
          ...(p.settings
            ? { settings: migrateGenerationSettings(p.settings) }
            : {}),
          workflowControlOverrides: isScopedOverrides(
            p.workflowControlOverrides,
          )
            ? p.workflowControlOverrides
            : {},
        };
      },
    },
  ),
);

// Selectors for common derived state

/**
 * Get runs that are currently processing
 */
/** Theme actually shown: the overlay host's mode wins while set. */
export const selectEffectiveTheme = (state: {
  theme: ThemeMode;
  hostTheme: ThemeMode | null;
}): ThemeMode => state.hostTheme ?? state.theme;

export const selectActiveRuns = (state: GenerationState) =>
  state.runs.filter((r) => r.status === "queued" || r.status === "running");

/**
 * Runs that belong in the Create page's generating section: active runs plus
 * this session's failed runs (shown with Retry / Dismiss instead of silently
 * vanishing). Server-hydrated failures stay in History only.
 */
export const isFailedLocalRun = (r: ImagineRun) =>
  r.status === "error" &&
  r.historySource !== "server" &&
  r.jobs.some((j) => j.status === "error");

export const selectGeneratingRowRuns = (state: GenerationState) =>
  state.runs.filter(
    (r) => r.status === "queued" || r.status === "running" || isFailedLocalRun(r),
  );

export const selectCompletedRuns = (state: GenerationState) =>
  state.runs.filter((r) => r.status === "done");

/**
 * Get visible gallery images (not hidden)
 */
export const selectVisibleGallery = (state: GenerationState) =>
  state.gallery.filter((img) => !img.hidden);

export const selectLikedImages = (state: GenerationState) =>
  state.gallery.filter((img) => img.liked);

export const selectErrorCount = (state: GenerationState) => state.errors.length;

function countJobsOfStatus(state: GenerationState, target: string): number {
  let count = 0;
  for (const run of state.runs) {
    for (const job of run.jobs) {
      if (job.status === target) count++;
    }
  }
  return count;
}

export const selectQueuedJobCount = (state: GenerationState) =>
  countJobsOfStatus(state, "queued");
export const selectRunningJobCount = (state: GenerationState) =>
  countJobsOfStatus(state, "running");
export const selectDoneJobCount = (state: GenerationState) =>
  countJobsOfStatus(state, "done");
export const selectTotalJobCount = (state: GenerationState) => {
  let count = 0;
  for (const run of state.runs) {
    count += run.jobs.length;
  }
  return count;
};

/**
 * Build settings string for prompt
 */
export const selectSettingsString = (state: UIState) => {
  const s = state.settings;
  const parts: string[] = [];

  if (s.aspect !== "1:1") parts.push(`--ar ${s.aspect}`);
  if (s.stylize !== 100) parts.push(`--stylize ${s.stylize}`);
  if (s.chaos > 0) parts.push(`--chaos ${s.chaos}`);
  if (s.modelMode === "Raw") parts.push("--raw");
  if (s.quality !== 1) parts.push(`--quality ${s.quality}`);
  const tier = speedTierFlag(s.speed);
  if (tier) parts.push(tier);
  // Only meaningful with --video; harmless otherwise. LTX-2.5 is the server
  // default (a stored legacy "ltxv" reads as default too: videoDefault.ts).
  const vmodel = videoModelFlag(s.videoModel);
  if (vmodel) parts.push(`--vmodel ${vmodel}`);
  if (s.videoModel === "minimax" && s.h3Speed === "fast8")
    parts.push("--h3speed fast8");

  return parts.join(" ");
};

export {
  useWorkflowControlStore,
  packSelectionKey,
  savedSelectionKey,
  computeEffectiveControls,
  getEditableControls,
} from "./workflowControlStore";
export type {
  ControlOverrides,
  WorkflowControlState,
  WorkflowControlActions,
} from "./workflowControlStore";

export { useEditorStore } from "./editorStore";
export type {
  EditorTool,
  PaintMode,
  EditorTab,
  EditorLayer,
} from "./editorStore";

// Re-export style store (SREF/LoRA management)
export {
  useStyleStore,
  selectFavoriteStyleCodes,
  selectFavoriteLoRAShortcodes,
  selectStyleCodesByTag,
  selectLoRAShortcodesBySet,
  selectSREFString,
  selectLoRAString,
} from "./styleStore";
export type { StyleCodeEntry, LoRAShortcodeEntry } from "./styleStore";

// Re-export overlay store (ComfyUI bridge state)
export { useOverlayStore, extractWorkflowName } from "./overlayStore";
export type {
  OverlayImage,
  OverlayProgress,
  BridgePhase,
  OverlaySettings,
} from "./overlayStore";
