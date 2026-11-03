"use client";

import { useEffect } from "react";
import {
  createToolsBridgeListener,
  requestGraphImage,
} from "@/lib/overlay/toolsBridge";
import { useOverlayStore } from "@/store/overlayStore";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";

/**
 * Wire the overlay Tools bridge: store graph-image / graph-inserted replies
 * and ask the host for the current graph image once the bridge is up.
 * Mount once (OverlayTopBar does) and only in overlay mode.
 */
export function useOverlayToolsBridge(enabled: boolean): void {
  const bridgePhase = useOverlayStore((s) => s.bridgePhase);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const { setGraphImage, markInsertResult } = useOverlayToolsStore.getState();
    const handler = createToolsBridgeListener({
      parent: window.parent !== window ? window.parent : null,
      onGraphImage: setGraphImage,
      onInserted: markInsertResult,
    });
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [enabled]);

  const live = bridgePhase === "configured" || bridgePhase === "ready";
  useEffect(() => {
    if (!enabled || !live) return;
    try {
      requestGraphImage();
    } catch (e) {
      console.warn("[CJ Overlay] graph image request failed:", e);
    }
  }, [enabled, live]);
}
