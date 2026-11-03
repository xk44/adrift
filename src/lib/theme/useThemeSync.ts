"use client";

import { useEffect } from "react";
import { useUIStore } from "@/store";
import { applyThemeAttrs, resolveThemeAttrs } from "./themes";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Keeps <html data-theme/data-palette/data-accent> and meta theme-color in
 * step with the UI store, and tracks the system color scheme when the user
 * chose "System". The inline boot script did the same before first paint.
 * Inside the ComfyUI overlay, the host's palette mode (hostTheme) wins.
 */
export function useThemeSync() {
  const theme = useUIStore((s) => s.hostTheme ?? s.theme);
  const hostTheme = useUIStore((s) => s.hostTheme);
  const followSystem = useUIStore((s) => s.followSystem);
  const darkPalette = useUIStore((s) => s.darkPalette);
  const lightPalette = useUIStore((s) => s.lightPalette);
  const accent = useUIStore((s) => s.accent);
  const syncSystemTheme = useUIStore((s) => s.syncSystemTheme);

  useEffect(() => {
    if (
      !followSystem ||
      hostTheme !== null ||
      typeof window.matchMedia !== "function"
    )
      return;
    const mql = window.matchMedia(LIGHT_QUERY);
    const sync = () => syncSystemTheme(mql.matches ? "light" : "dark");
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, [followSystem, hostTheme, syncSystemTheme]);

  useEffect(() => {
    // `theme` already tracks the system while following it (synced above).
    applyThemeAttrs(
      resolveThemeAttrs({
        theme,
        followSystem: false,
        darkPalette,
        lightPalette,
        accent,
      }),
    );
  }, [theme, darkPalette, lightPalette, accent]);
}
