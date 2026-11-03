"use client";

import { useEffect, useRef } from "react";
import {
  activateDialogFocus,
  type DialogFocusOptions,
  type FocusableLike,
} from "@/lib/ui/dialogFocus";

/**
 * Modal focus contract for any dialog/sheet: Tab stays inside, Escape closes
 * (when `onEscape` is given — leave it out if the dialog already handles
 * Escape), focus moves in on open and returns to the opener on close, and the
 * container gets role="dialog" + aria-modal="true" if it lacks them.
 */
export function useDialogFocus(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  options: DialogFocusOptions = {},
): void {
  // Latest options without re-running the effect (which would re-steal focus).
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    const el = containerRef.current;
    if (!active || !el || typeof document === "undefined") return;
    const { onEscape, ...rest } = optsRef.current;
    return activateDialogFocus(
      el as unknown as FocusableLike,
      document as unknown as Parameters<typeof activateDialogFocus>[1],
      {
        ...rest,
        onEscape: onEscape ? () => optsRef.current.onEscape?.() : undefined,
        trap: () => {
          const t = optsRef.current.trap;
          return typeof t === "function" ? t() : t !== false;
        },
      },
    );
  }, [active, containerRef]);
}
