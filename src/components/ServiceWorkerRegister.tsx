"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker (public/sw.js) in production only —
 * dev builds keep hot reload untouched by a network-first navigation cache.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator))
      return;

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[adrift] service worker registration failed", err);
    });
  }, []);

  return null;
}
