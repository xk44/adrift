"use client";

import { useEffect } from "react";
import { showToast } from "@/components/Toast";
import { applyInitialUrl, startNavUrlSync } from "@/lib/navUrlSync";

export { navigateTo, navigateToPath } from "@/lib/navUrlSync";

/**
 * Keeps the URL and the UI store's nav in sync (see lib/navUrlSync.ts):
 * reads the URL on mount, pushes store nav changes (restoring each page's
 * remembered query) and follows back/forward.
 */
export function useNavSync() {
  useEffect(() => {
    const notice = applyInitialUrl();
    if (notice) showToast(notice, "info", 5000);
    return startNavUrlSync();
  }, []);
}
