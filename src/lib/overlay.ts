/**
 * Overlay iframe detection and message listener setup.
 *
 * This module provides client-side utilities for detecting whether
 * Adrift is running inside the ComfyUI overlay iframe, and
 * sets up the postMessage listener with origin validation.
 */

import {
  parseCjMessage,
  validateOrigin,
  type ParseResult,
} from "./overlay/protocol";

/**
 * Returns true if the current window is inside an iframe.
 * Handles cross-origin cases where accessing window.top throws a DOMException.
 */
export function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin iframe — accessing window.top throws
    return true;
  }
}

/**
 * Returns true if the app is running in overlay mode (inside an iframe).
 * Only call this client-side (after hydration).
 */
export function isOverlayMode(): boolean {
  if (typeof window === "undefined") return false;
  return isInIframe();
}

export type OverlayMessageHandler = (parsed: ParseResult) => void;

/**
 * Set up a postMessage listener that validates origin and parses
 * incoming CJ protocol messages.
 *
 * @param allowedOrigins  Origins to accept messages from
 * @param onMessage       Callback for validated, parsed messages
 * @returns Cleanup function to remove the listener
 */
export function setupOverlayListener(
  allowedOrigins: readonly string[],
  onMessage: OverlayMessageHandler,
): () => void {
  const handler = (event: MessageEvent) => {
    // Only the embedding parent may drive the overlay — sibling frames on
    // an allowed origin can post to us too.
    if (event.source !== window.parent) return;

    const originCheck = validateOrigin(event.origin, allowedOrigins);
    if (!originCheck.ok) return;

    const result = parseCjMessage(event.data);
    if (!result.ok) return;

    onMessage(result);
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
