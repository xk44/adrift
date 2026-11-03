"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { FirstRunChecklist } from "@/components/setup/FirstRunChecklist";
import {
  currentPickedModel,
  refreshFirstRunStatus,
} from "@/hooks/useFirstRunStatus";
import { useOnboardingStore } from "@/store/onboardingStore";

/** Window event that opens the first-run checklist dialog ("Open checklist"). */
export const OPEN_SETUP_EVENT = "cj:open-setup";

export function openSetup() {
  window.dispatchEvent(new Event(OPEN_SETUP_EVENT));
}

/**
 * Mounted once by the app shell. Opens the first-run checklist in a native
 * modal <dialog> (focus trap + inert page for free) when anything dispatches
 * OPEN_SETUP_EVENT; re-checks on open so it shows the current state, not the
 * last poll. Closing hands focus back to whatever opened it.
 */
export function SetupDialogHost() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onOpen = () => {
      returnTo.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen(true);
      void refreshFirstRunStatus({
        model: currentPickedModel(),
        force: true,
      });
    };
    window.addEventListener(OPEN_SETUP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, onOpen);
  }, []);

  // "Change connection" opens the Setup wizard: step aside for it.
  useEffect(
    () =>
      useOnboardingStore.subscribe((s) => {
        if (s.open) setOpen(false);
      }),
    [],
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      if (!d.open) {
        if (typeof d.showModal === "function") d.showModal();
        else d.setAttribute("open", "");
      }
      closeRef.current?.focus();
    } else if (d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
      returnTo.current?.focus?.();
      returnTo.current = null;
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="setup-dialog-title"
      data-testid="setup-dialog"
      onCancel={(e) => {
        // Escape: close here, and keep page-level Escape handlers out.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === ref.current) setOpen(false);
      }}
      className="m-0 mt-auto max-h-[90dvh] w-full max-w-full overflow-y-auto rounded-t-2xl bg-[var(--bg-primary)] p-0 pb-[env(safe-area-inset-bottom)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] backdrop:bg-black/60 sm:m-auto sm:max-w-xl sm:rounded-2xl"
    >
      {open && (
        <>
          <div className="flex items-center justify-between px-4 pt-3">
            <h2
              id="setup-dialog-title"
              className="text-base font-semibold text-[var(--text-primary)]"
            >
              First-run checklist
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the first-run checklist"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <FirstRunChecklist compact />
          <div className="h-3" />
        </>
      )}
    </dialog>
  );
}

export default SetupDialogHost;
