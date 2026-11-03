"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { isOverlayMode } from "@/lib/overlay";
import {
  createOverlayInboundGuard,
  getActiveHostSession,
  resolveParentOrigin,
  setActiveHostSession,
} from "@/lib/overlay/session";
import {
  buildCjMessage,
  OVERLAY_MSG,
  HOST_MSG,
  CJ_PROTOCOL_VERSION,
  type ConfigPayload,
  type ProgressPayload,
  type ImagesPayload,
  type AckPayload,
  type ErrorPayload,
  type WorkflowPayload,
  type SettingsSyncPayload,
  type NodeSelectedPayload,
  type PongPayload,
  type ThemePayload,
  type LayoutPayload,
  type OverlayLayout,
} from "@/lib/overlay/protocol";
import { useOverlayStore } from "@/store/overlayStore";
import { useUIStore } from "@/store";

/** Timeout (ms) for queue requests before marking as failed */
const QUEUE_TIMEOUT_MS = 30_000;

export interface OverlayState {
  /** Whether the app is running inside the ComfyUI overlay iframe */
  isOverlay: boolean;
  /** Whether the overlay panel is currently visible (host controls this) */
  isVisible: boolean;
  /** ComfyUI config received from the host bridge */
  comfyConfig: ConfigPayload | null;
  /** Send images back to ComfyUI host */
  sendImagesToHost: (
    promptId: string,
    images: {
      filename: string;
      subfolder?: string;
      type: "output" | "input" | "temp";
    }[],
  ) => void;
  /** Queue a prompt through ComfyUI's /prompt endpoint via postMessage */
  queueViaHost: (prompt: unknown, clientId?: string) => void;
  /** Send a toggle-back message to host to hide the overlay */
  requestHideOverlay: () => void;
  /** Send a workflow to ComfyUI for loading into the graph editor */
  sendWorkflowToComfyUI: (workflow: unknown) => void;
  /** Send an image reference to ComfyUI (drag-and-drop) */
  sendImageToComfyUI: (
    filename: string,
    subfolder?: string,
    type?: "output" | "input" | "temp",
  ) => void;
}

/**
 * Ask the ComfyUI host to switch the overlay between full viewport and the
 * docked right panel. Needs the current host session: the host drops
 * cj:set-layout without its nonce. Returns false when nothing was sent.
 */
export function requestHostLayout(
  layout: OverlayLayout,
  win: Pick<Window, "parent"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): boolean {
  const session = getActiveHostSession();
  if (!win || !session) return false;
  try {
    win.parent.postMessage(
      buildCjMessage(OVERLAY_MSG.SET_LAYOUT, { layout }, session.nonce),
      session.origin,
    );
    return true;
  } catch (e) {
    console.warn("[CJ Overlay] Layout request failed:", e);
    return false;
  }
}

/**
 * React hook for overlay-mode integration.
 *
 * On mount (when in iframe mode):
 *  1. Sends cj:hello to parent to initiate handshake
 *  2. Sends cj:ready to signal the app is mounted
 *  3. Listens for cj:config, cj:visibility, cj:workflow, cj:progress, cj:images from host
 *  4. Provides helpers to send images, queue prompts, send workflows, and toggle back to ComfyUI
 *
 * SSR-safe: returns inert state when window is undefined.
 */
export function useOverlayMode(): OverlayState {
  // Hydration-safe: the server always renders non-overlay. Detecting the
  // iframe during the first client render would mismatch the SSR HTML, so
  // detection happens after mount.
  const [isOverlay, setIsOverlay] = useState(false);

  useEffect(() => {
    if (isOverlayMode()) setIsOverlay(true);
  }, []);

  const [isVisible, setIsVisible] = useState(true);
  const [comfyConfig, setComfyConfig] = useState<ConfigPayload | null>(null);

  const setOverlayWorkflow = useOverlayStore((s) => s.setOverlayWorkflow);
  const setProgress = useOverlayStore((s) => s.setProgress);
  const setCompletedImages = useOverlayStore((s) => s.setCompletedImages);
  const setLastQueuedPromptId = useOverlayStore((s) => s.setLastQueuedPromptId);
  const setIsQueueing = useOverlayStore((s) => s.setIsQueueing);
  const setBridgePhase = useOverlayStore((s) => s.setBridgePhase);
  const setRemoteRevision = useOverlayStore((s) => s.setRemoteRevision);
  const setSyncConflict = useOverlayStore((s) => s.setSyncConflict);
  const setSelectedNode = useOverlayStore((s) => s.setSelectedNode);
  const setBridgeLatency = useOverlayStore((s) => s.setBridgeLatency);
  const setLastPingTime = useOverlayStore((s) => s.setLastPingTime);
  const setSyncedSettings = useOverlayStore((s) => s.setSyncedSettings);
  const resetSession = useOverlayStore((s) => s.resetSession);
  const setHostLayout = useOverlayStore((s) => s.setHostLayout);
  const setHostTheme = useUIStore((s) => s.setHostTheme);
  /** Parent origin for outbound posts once known; "*" before the handshake */
  const targetOriginRef = useRef("*");
  const queueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueUnsubscribeRef = useRef<(() => void) | null>(null);

  const clearQueueSafety = useCallback(() => {
    if (queueTimeoutRef.current !== null) {
      clearTimeout(queueTimeoutRef.current);
      queueTimeoutRef.current = null;
    }
    if (queueUnsubscribeRef.current) {
      queueUnsubscribeRef.current();
      queueUnsubscribeRef.current = null;
    }
  }, []);

  useEffect(() => clearQueueSafety, [clearQueueSafety]);

  useEffect(() => {
    if (!isOverlay || typeof window === "undefined") return;

    setBridgePhase("hello-sent");

    // Every inbound message must come from window.parent, from the parent's
    // origin (ancestorOrigins/referrer, else locked on first message), pass
    // schema + direction checks, and carry the current session nonce.
    const guard = createOverlayInboundGuard({
      expectedSource: window.parent,
      parentOrigin: resolveParentOrigin(window),
    });
    targetOriginRef.current = guard.origin || "*";

    // Safe postMessage to parent — catches cross-origin failures
    const safePostToParent = (msg: unknown) => {
      try {
        window.parent.postMessage(msg, guard.origin || "*");
      } catch (e) {
        console.warn("[CJ Overlay] postMessage to parent failed:", e);
        setBridgePhase("error");
      }
    };

    // Listen before announcing ourselves so no host reply can be missed.
    const handler = (event: MessageEvent) => {
      const decision = guard.accept(event);
      if (!decision.ok) {
        if (decision.reason === "malformed" || decision.reason === "nonce") {
          console.warn("[CJ Overlay] Dropped host message:", decision.reason);
        }
        return;
      }
      const result = decision.message;
      targetOriginRef.current = guard.origin || "*";
      // A new host session invalidates in-flight queue/progress state.
      if (decision.newSession) resetSession();

      switch (result.type) {
        case HOST_MSG.CONFIG:
          setActiveHostSession(
            guard.sessionNonce
              ? { nonce: guard.sessionNonce, origin: guard.origin || "*" }
              : null,
          );
          setComfyConfig(result.payload as ConfigPayload);
          setBridgePhase("configured");
          break;

        case HOST_MSG.VISIBILITY:
          setIsVisible((result.payload as { visible: boolean }).visible);
          break;

        case HOST_MSG.WORKFLOW: {
          const wfPayload = result.payload as WorkflowPayload;
          const revision = wfPayload.revision ?? 0;
          const { hasLocalChanges, remoteRevision } =
            useOverlayStore.getState();

          // If user has unsaved local changes and this is a newer revision,
          // show a conflict banner instead of silently replacing
          if (hasLocalChanges && revision > remoteRevision) {
            setSyncConflict({
              remoteWorkflow: wfPayload.workflow,
              remoteRevision: revision,
              timestamp: Date.now(),
            });
          } else {
            // No conflict — accept the workflow
            setOverlayWorkflow(wfPayload.workflow, wfPayload.name);
            setRemoteRevision(revision);
          }
          // Receiving a workflow means the bridge is ready
          setBridgePhase("ready");
          break;
        }

        case HOST_MSG.PROGRESS: {
          const p = result.payload as ProgressPayload;
          setProgress({
            promptId: p.promptId,
            value: p.value,
            max: p.max,
            nodeId: p.nodeId,
          });
          break;
        }

        case HOST_MSG.IMAGES: {
          const img = result.payload as ImagesPayload;
          setCompletedImages(img.promptId, img.images);
          break;
        }

        case HOST_MSG.ERROR: {
          const err = result.payload as ErrorPayload;
          console.error("[CJ Overlay] Host error:", err.code, err.message);
          // If error is queue-related, clear the queueing state
          if (err.code === "QUEUE_FAILED") {
            setIsQueueing(false);
          }
          setBridgePhase("error");
          break;
        }

        case HOST_MSG.SETTINGS_SYNC: {
          const settings = result.payload as SettingsSyncPayload;
          const { revision: _rev, ...settingsData } = settings;
          setSyncedSettings(settingsData as Record<string, unknown>);
          break;
        }

        case HOST_MSG.NODE_SELECTED: {
          const node = result.payload as NodeSelectedPayload;
          setSelectedNode({
            nodeId: node.nodeId,
            nodeType: node.nodeType,
            nodeTitle: node.nodeTitle,
            inputs: node.inputs,
          });
          break;
        }

        case HOST_MSG.THEME: {
          // Match ComfyUI's palette (light/dark) while embedded in it.
          setHostTheme((result.payload as ThemePayload).mode);
          break;
        }

        case HOST_MSG.LAYOUT: {
          setHostLayout((result.payload as LayoutPayload).layout);
          break;
        }

        case HOST_MSG.PONG: {
          const pong = result.payload as PongPayload;
          const now = Date.now();
          const latency = now - pong.timestamp;
          setBridgeLatency(latency);
          break;
        }

        // Handle ACK messages (e.g. queue ACK from host)
        default: {
          if (result.type === OVERLAY_MSG.ACK) {
            const ack = result.payload as AckPayload;
            if (ack.ackType === "cj:queue") {
              if (ack.accepted) {
                setLastQueuedPromptId(ack.promptId ?? null);
              } else {
                // Queue was rejected — clear queueing state
                console.warn("[CJ Overlay] Queue rejected:", ack.error);
                setIsQueueing(false);
              }
            }
          }
          break;
        }
      }
    };

    window.addEventListener("message", handler);

    // Send cj:hello, then cj:ready, to the parent
    safePostToParent(
      buildCjMessage(OVERLAY_MSG.HELLO, {
        name: "adrift",
        version: CJ_PROTOCOL_VERSION,
      }),
    );
    safePostToParent(
      buildCjMessage(OVERLAY_MSG.READY, { timestamp: Date.now() }),
    );

    // Ping interval for latency measurement (every 5s)
    const pingInterval = setInterval(() => {
      const now = Date.now();
      setLastPingTime(now);
      const pingMsg = buildCjMessage(OVERLAY_MSG.PING, { timestamp: now });
      safePostToParent(pingMsg);
    }, 5_000);

    return () => {
      window.removeEventListener("message", handler);
      clearInterval(pingInterval);
      setActiveHostSession(null);
      setHostTheme(null);
      // Don't leave isQueueing/progress stuck from a session that is gone.
      resetSession();
      setBridgePhase("idle");
    };
  }, [
    isOverlay,
    setOverlayWorkflow,
    setProgress,
    setCompletedImages,
    setLastQueuedPromptId,
    setIsQueueing,
    setBridgePhase,
    setRemoteRevision,
    setSyncConflict,
    setSelectedNode,
    setBridgeLatency,
    setLastPingTime,
    setSyncedSettings,
    resetSession,
    setHostLayout,
    setHostTheme,
  ]);

  // Send generated images back to the ComfyUI host
  const sendImagesToHost = useCallback(
    (
      promptId: string,
      images: {
        filename: string;
        subfolder?: string;
        type: "output" | "input" | "temp";
      }[],
    ) => {
      if (!isOverlay || typeof window === "undefined") return;
      const msg = buildCjMessage(HOST_MSG.IMAGES, { promptId, images });
      window.parent.postMessage(msg, targetOriginRef.current);
    },
    [isOverlay],
  );

  // Queue a prompt through ComfyUI via the host bridge (with timeout)
  const queueViaHost = useCallback(
    (prompt: unknown, clientId?: string) => {
      if (!isOverlay || typeof window === "undefined") return;
      clearQueueSafety();
      setIsQueueing(true);
      const msg = buildCjMessage(OVERLAY_MSG.QUEUE, {
        prompt,
        ...(clientId ? { clientId } : {}),
      });
      try {
        window.parent.postMessage(msg, targetOriginRef.current);
      } catch (e) {
        console.error("[CJ Overlay] Failed to send queue message:", e);
        setIsQueueing(false);
        return;
      }
      // Safety timeout — if host never ACKs or errors, unblock the UI
      queueTimeoutRef.current = setTimeout(() => {
        const { isQueueing } = useOverlayStore.getState();
        if (isQueueing) {
          console.warn(
            "[CJ Overlay] Queue request timed out after",
            QUEUE_TIMEOUT_MS,
            "ms",
          );
          setIsQueueing(false);
        }
      }, QUEUE_TIMEOUT_MS);
      // Clear timeout if queueing resolves before timeout
      queueUnsubscribeRef.current = useOverlayStore.subscribe((state) => {
        if (!state.isQueueing) {
          clearQueueSafety();
        }
      });
    },
    [clearQueueSafety, isOverlay, setIsQueueing],
  );

  // Request the host to hide the overlay (toggle back to ComfyUI)
  const requestHideOverlay = useCallback(() => {
    if (!isOverlay || typeof window === "undefined") return;
    // Send a visibility toggle request — the host listens for this
    window.parent.postMessage(
      { type: "cj:toggle", payload: { visible: false } },
      targetOriginRef.current,
    );
  }, [isOverlay]);

  // Send a workflow to ComfyUI for loading into the graph editor
  const sendWorkflowToComfyUI = useCallback(
    (workflow: unknown) => {
      if (!isOverlay || typeof window === "undefined") return;
      const nonce = getActiveHostSession()?.nonce;
      if (!nonce) {
        console.warn("[CJ Overlay] No host session yet; workflow not sent");
        return;
      }
      const msg = buildCjMessage(OVERLAY_MSG.LOAD_WORKFLOW, { workflow }, nonce);
      window.parent.postMessage(msg, targetOriginRef.current);
    },
    [isOverlay],
  );

  // Send an image reference to ComfyUI (for drag-and-drop into LoadImage node)
  const sendImageToComfyUI = useCallback(
    (
      filename: string,
      subfolder?: string,
      type?: "output" | "input" | "temp",
    ) => {
      if (!isOverlay || typeof window === "undefined") return;
      const msg = buildCjMessage(OVERLAY_MSG.DRAG_IMAGE, {
        filename,
        ...(subfolder ? { subfolder } : {}),
        ...(type ? { type } : {}),
      });
      window.parent.postMessage(msg, targetOriginRef.current);
    },
    [isOverlay],
  );

  return useMemo(
    () => ({
      isOverlay,
      isVisible,
      comfyConfig,
      sendImagesToHost,
      queueViaHost,
      requestHideOverlay,
      sendWorkflowToComfyUI,
      sendImageToComfyUI,
    }),
    [
      isOverlay,
      isVisible,
      comfyConfig,
      sendImagesToHost,
      queueViaHost,
      requestHideOverlay,
      sendWorkflowToComfyUI,
      sendImageToComfyUI,
    ],
  );
}
