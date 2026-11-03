/**
 * Overlay Store — Zustand store for ComfyUI overlay bridge state.
 *
 * Tracks received workflows, progress, generation results, bridge
 * connection phase, and overlay settings from the ComfyUI host frame
 * via postMessage bridge.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import type { OverlayLayout } from "@/lib/overlay/protocol";

export interface OverlayImage {
  filename: string;
  subfolder?: string;
  type: "output" | "input" | "temp";
}

export interface OverlayProgress {
  promptId: string;
  value: number;
  max: number;
  nodeId?: number;
}

/** Bridge connection phase — mirrors the handshake FSM in protocol.ts */
export type BridgePhase =
  "idle" | "hello-sent" | "configured" | "ready" | "error";

/** Extracted workflow name from a ComfyUI workflow JSON */
export function extractWorkflowName(workflow: unknown): string {
  if (!workflow || typeof workflow !== "object") return "ComfyUI Workflow";
  const w = workflow as Record<string, unknown>;
  // Try graph title first
  if (typeof w.title === "string" && w.title.trim()) return w.title.trim();
  // Try extra.title (ComfyUI metadata)
  if (w.extra && typeof w.extra === "object") {
    const extra = w.extra as Record<string, unknown>;
    if (typeof extra.title === "string" && extra.title.trim())
      return extra.title.trim();
  }
  // A node class_type is NOT a name — generic label beats a misleading one
  return "ComfyUI Workflow";
}

/** Node selection info from ComfyUI */
export interface SelectedNode {
  nodeId: number;
  nodeType: string;
  nodeTitle: string;
  inputs?: Record<string, unknown>;
}

/** Sync conflict state */
export interface SyncConflict {
  /** The remote workflow that arrived during local edits */
  remoteWorkflow: unknown;
  /** Remote revision number */
  remoteRevision: number;
  /** Timestamp when the conflict was detected */
  timestamp: number;
}

/** Connection quality based on latency */
export type ConnectionQuality = "good" | "degraded" | "poor" | "unknown";

/** Overlay settings — persisted to localStorage */
export interface OverlaySettings {
  /** Queue via ComfyUI host vs CJ API */
  queueViaComfyUI: boolean;
  /** Auto-sync workflow when switching overlay visibility */
  autoSyncWorkflow: boolean;
  /** Show progress from ComfyUI execution */
  showComfyProgress: boolean;
}

const defaultOverlaySettings: OverlaySettings = {
  queueViaComfyUI: false,
  autoSyncWorkflow: true,
  showComfyProgress: true,
};

interface OverlayStoreState {
  /** Raw workflow JSON received from ComfyUI host */
  overlayWorkflow: unknown | null;
  /** Extracted workflow name */
  overlayWorkflowName: string | null;
  /** Whether the user has accepted the workflow for use */
  workflowAccepted: boolean;
  /** Current execution progress from ComfyUI */
  progress: OverlayProgress | null;
  /** Completed images from ComfyUI execution */
  completedImages: OverlayImage[];
  /** Active prompt ID being tracked */
  activePromptId: string | null;
  /** Whether a queue request is in-flight via overlay bridge */
  isQueueing: boolean;
  /** Last queue ACK prompt ID */
  lastQueuedPromptId: string | null;
  /** Bridge connection phase */
  bridgePhase: BridgePhase;
  /** Overlay settings (persisted) */
  overlaySettings: OverlaySettings;
  /** Whether the settings panel is open */
  settingsPanelOpen: boolean;
  /** Local revision counter — incremented when CJ makes local changes */
  localRevision: number;
  /** Remote revision counter — latest revision received from ComfyUI */
  remoteRevision: number;
  /** Whether the user has unsaved local changes (modified prompt params, etc.) */
  hasLocalChanges: boolean;
  /** Pending sync conflict when remote changes arrive during local edits */
  syncConflict: SyncConflict | null;
  /** Currently selected node in ComfyUI */
  selectedNode: SelectedNode | null;
  /** Bridge latency in ms (round-trip) */
  bridgeLatency: number | null;
  /** Connection quality derived from latency */
  connectionQuality: ConnectionQuality;
  /** Timestamp of last ping sent */
  lastPingTime: number | null;
  /** Synced settings from ComfyUI KSampler/model nodes */
  syncedSettings: Record<string, unknown> | null;
  /** Host overlay layout (null until a host that supports layouts reports it) */
  hostLayout: OverlayLayout | null;
}

interface OverlayStoreActions {
  setOverlayWorkflow: (workflow: unknown, name?: string) => void;
  acceptWorkflow: () => void;
  dismissWorkflow: () => void;
  setProgress: (progress: OverlayProgress) => void;
  clearProgress: () => void;
  setCompletedImages: (promptId: string, images: OverlayImage[]) => void;
  clearCompletedImages: () => void;
  setIsQueueing: (queueing: boolean) => void;
  setLastQueuedPromptId: (promptId: string | null) => void;
  setBridgePhase: (phase: BridgePhase) => void;
  updateOverlaySettings: (update: Partial<OverlaySettings>) => void;
  setSettingsPanelOpen: (open: boolean) => void;
  setHasLocalChanges: (hasChanges: boolean) => void;
  incrementLocalRevision: () => void;
  setRemoteRevision: (revision: number) => void;
  setSyncConflict: (conflict: SyncConflict | null) => void;
  acceptRemoteWorkflow: () => void;
  keepLocalWorkflow: () => void;
  setSelectedNode: (node: SelectedNode | null) => void;
  setBridgeLatency: (latency: number) => void;
  setLastPingTime: (time: number) => void;
  setSyncedSettings: (settings: Record<string, unknown>) => void;
  setHostLayout: (layout: OverlayLayout | null) => void;
  /**
   * Drop transient per-handshake state (progress, in-flight queue, selected
   * node, latency, pending conflict) when the bridge session ends or a new
   * host session starts. Keeps the received workflow and settings.
   */
  resetSession: () => void;
  reset: () => void;
}

const initialState: OverlayStoreState = {
  overlayWorkflow: null,
  overlayWorkflowName: null,
  workflowAccepted: false,
  progress: null,
  completedImages: [],
  activePromptId: null,
  isQueueing: false,
  lastQueuedPromptId: null,
  bridgePhase: "idle",
  overlaySettings: defaultOverlaySettings,
  settingsPanelOpen: false,
  localRevision: 0,
  remoteRevision: 0,
  hasLocalChanges: false,
  syncConflict: null,
  selectedNode: null,
  bridgeLatency: null,
  connectionQuality: "unknown",
  lastPingTime: null,
  syncedSettings: null,
  hostLayout: null,
};

export const useOverlayStore = createWithEqualityFn<
  OverlayStoreState & OverlayStoreActions
>()(
  persist(
    (set) => ({
      ...initialState,

      setOverlayWorkflow: (workflow, name) => {
        // Persist to sessionStorage so useImagine can pick it up for generation
        try {
          if (typeof sessionStorage !== "undefined") {
            if (workflow != null) {
              sessionStorage.setItem(
                "cj_overlay_workflow_json",
                JSON.stringify(workflow),
              );
            } else {
              sessionStorage.removeItem("cj_overlay_workflow_json");
            }
          }
        } catch {
          // Quota exceeded (huge graph): drop the stale key so useImagine,
          // which reads sessionStorage first, falls back to this store
          // instead of submitting the previously loaded workflow.
          try {
            sessionStorage.removeItem("cj_overlay_workflow_json");
          } catch {
            /* sessionStorage unavailable — store is the only source */
          }
        }
        set({
          overlayWorkflow: workflow,
          overlayWorkflowName: name?.trim() || extractWorkflowName(workflow),
          workflowAccepted: false,
        });
      },

      acceptWorkflow: () => set({ workflowAccepted: true }),

      dismissWorkflow: () => {
        try {
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.removeItem("cj_overlay_workflow_json");
          }
        } catch {
          /* ignore */
        }
        set({
          overlayWorkflow: null,
          overlayWorkflowName: null,
          workflowAccepted: false,
        });
      },

      setProgress: (progress) =>
        set({ progress, activePromptId: progress.promptId }),

      clearProgress: () => set({ progress: null }),

      setCompletedImages: (promptId, images) =>
        set({
          completedImages: images,
          activePromptId: promptId,
          progress: null,
        }),

      clearCompletedImages: () => set({ completedImages: [] }),

      setIsQueueing: (queueing) => set({ isQueueing: queueing }),

      setLastQueuedPromptId: (promptId) =>
        set({ lastQueuedPromptId: promptId, isQueueing: false }),

      setBridgePhase: (phase) => set({ bridgePhase: phase }),

      updateOverlaySettings: (update) =>
        set((state) => ({
          overlaySettings: { ...state.overlaySettings, ...update },
        })),

      setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),

      setHasLocalChanges: (hasChanges) => set({ hasLocalChanges: hasChanges }),

      incrementLocalRevision: () =>
        set((state) => ({ localRevision: state.localRevision + 1 })),

      setRemoteRevision: (revision) => set({ remoteRevision: revision }),

      setSyncConflict: (conflict) => set({ syncConflict: conflict }),

      acceptRemoteWorkflow: () =>
        set((state) => {
          if (!state.syncConflict) return {};
          const workflow = state.syncConflict.remoteWorkflow;
          try {
            if (typeof sessionStorage !== "undefined" && workflow != null) {
              sessionStorage.setItem(
                "cj_overlay_workflow_json",
                JSON.stringify(workflow),
              );
            }
          } catch {
            /* ignore */
          }
          return {
            overlayWorkflow: workflow,
            overlayWorkflowName: extractWorkflowName(workflow),
            remoteRevision: state.syncConflict.remoteRevision,
            syncConflict: null,
            hasLocalChanges: false,
            workflowAccepted: false,
          };
        }),

      keepLocalWorkflow: () =>
        set((state) => ({
          localRevision: state.localRevision + 1,
          syncConflict: null,
        })),

      setSelectedNode: (node) => set({ selectedNode: node }),

      setBridgeLatency: (latency) => {
        const quality: ConnectionQuality =
          latency < 100 ? "good" : latency < 500 ? "degraded" : "poor";
        set({ bridgeLatency: latency, connectionQuality: quality });
      },

      setLastPingTime: (time) => set({ lastPingTime: time }),

      setSyncedSettings: (settings) => set({ syncedSettings: settings }),

      setHostLayout: (layout) => set({ hostLayout: layout }),

      resetSession: () =>
        set({
          progress: null,
          activePromptId: null,
          isQueueing: false,
          lastQueuedPromptId: null,
          syncConflict: null,
          selectedNode: null,
          bridgeLatency: null,
          connectionQuality: "unknown",
          lastPingTime: null,
          hostLayout: null,
        }),

      reset: () => {
        try {
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.removeItem("cj_overlay_workflow_json");
          }
        } catch {
          /* ignore */
        }
        set(initialState);
      },
    }),
    {
      name: STORAGE_KEYS.overlay,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        overlaySettings: state.overlaySettings,
      }),
    },
  ),
);
