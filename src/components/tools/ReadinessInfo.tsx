"use client";

/**
 * The (i) next to "12 of 40 tools ready": what isn't ready and how to fix
 * it. Need-setup tools are grouped by what is missing (one node pack or
 * base model often unlocks several), each with the per-tool Setup drawer
 * (files, sizes, licenses, one-click download). Beta tools and the offline
 * case get their own short explanation. Native <dialog>, same pattern as
 * SetupDrawer: focus trapped, Esc closes, focus returns to the button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Info, RefreshCw, Wrench, X } from "lucide-react";
import type { HubCard } from "@/lib/tools/hub";
import { setupHint } from "@/lib/tools/setupHint";
import {
  readinessBreakdown,
  type ToolsReadiness,
} from "@/lib/tools/toolsReadiness";
import { SetupToolButton } from "./SetupDrawer";

const ICON_BTN =
  "rounded-lg p-1.5 text-light-500 hover:bg-light-100 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-50 dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary";

export function ReadinessInfo({
  readiness,
  cards,
  onOpen,
  onRecheck,
  rechecking = false,
}: {
  readiness: ToolsReadiness;
  cards: HubCard[];
  onOpen: (key: string) => void;
  onRecheck: () => void;
  rechecking?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const breakdown = useMemo(
    () =>
      readinessBreakdown(cards, (c) => setupHint(c.unavailableReason, c.model)),
    [cards],
  );
  const needCount = breakdown.needSetup.reduce((n, g) => n + g.cards.length, 0);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  const openTool = (key: string) => {
    setOpen(false);
    onOpen(key);
  };

  return (
    <>
      <button
        ref={btn}
        hidden={rechecking && !open}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Which tools aren't ready, and how to fix them"
        title="Which tools aren't ready, and how to fix them"
        data-testid="tools-readiness-info"
        className="-my-1 ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full align-middle text-light-500 transition-colors hover:bg-light-input hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-input dark:hover:text-dark-primary"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      <dialog
        ref={dlg}
        aria-labelledby="readiness-info-title"
        data-testid="readiness-info"
        onClose={() => setOpen(false)}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => {
          if (e.target === dlg.current) close();
        }}
        className="m-0 mt-auto max-h-[88dvh] w-full max-w-full overflow-hidden rounded-t-2xl bg-light-bg p-0 text-light-primary shadow-2xl backdrop:bg-black/50 dark:bg-dark-bg dark:text-dark-primary sm:my-0 sm:ml-auto sm:mr-0 sm:h-dvh sm:max-h-dvh sm:w-[460px] sm:rounded-none sm:rounded-l-2xl"
      >
        {open && (
          <div className="flex max-h-[88dvh] flex-col sm:h-dvh sm:max-h-dvh">
            <header className="flex items-start gap-3 border-b border-light-100 px-4 py-3 dark:border-dark-750">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-splash" />
              <div className="min-w-0 flex-1">
                <h2
                  id="readiness-info-title"
                  className="text-[15px] font-semibold"
                >
                  Tool readiness
                </h2>
                <p className="text-[12px] tabular-nums text-light-500 dark:text-dark-400">
                  {rechecking
                    ? "Checking…"
                    : readiness.offline
                    ? `${readiness.total} tools · can't check the server`
                    : `${readiness.ready} ready · ${readiness.notChecked} beta · ${needCount} need setup`}
                </p>
              </div>
              <button
                type="button"
                onClick={onRecheck}
                disabled={rechecking}
                aria-label="Check again"
                title="Check again"
                className={ICON_BTN}
              >
                <RefreshCw
                  className={`h-4 w-4 ${rechecking ? "animate-spin" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className={ICON_BTN}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 text-[13px]">
              {readiness.offline ? (
                <section className="space-y-2">
                  <h3 className="font-semibold text-amber-700 dark:text-amber-300">
                    Can&apos;t reach ComfyUI
                  </h3>
                  <ol className="list-decimal space-y-1.5 pl-5 text-light-600 dark:text-dark-300">
                    <li>
                      Start ComfyUI (
                      <code className="text-[12px]">
                        scripts/start-comfyui.sh
                      </code>{" "}
                      on this machine).
                    </li>
                    <li>
                      Check the ComfyUI address in Settings matches where it
                      runs (local, LAN or remote).
                    </li>
                    <li>Press Check again (top right).</li>
                  </ol>
                </section>
              ) : (
                <>
                  {needCount === 0 && breakdown.beta.length === 0 && (
                    <p className="text-light-600 dark:text-dark-300">
                      Every tool is ready.
                    </p>
                  )}

                  {needCount > 0 && (
                    <section
                      className="space-y-3"
                      data-testid="readiness-need-setup"
                    >
                      <div>
                        <h3 className="flex items-center gap-1.5 font-semibold">
                          <Wrench className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                          Need setup ({needCount})
                        </h3>
                        <p className="mt-1 text-[12px] text-pretty text-light-500 dark:text-dark-400">
                          Missing model files, LoRAs or custom nodes. Setup
                          lists each file with its size and license, and
                          downloads it in one click when ComfyUI runs on this
                          machine. Restart ComfyUI after new nodes, then check
                          again.
                        </p>
                      </div>
                      {breakdown.needSetup.map((g) => (
                        <div key={g.hint}>
                          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-light-500 dark:text-dark-400">
                            {g.hint}
                            {g.cards.length > 1 && ` · ${g.cards.length} tools`}
                          </p>
                          <ul className="divide-y divide-light-100 rounded-lg shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:divide-dark-750 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                            {g.cards.map((c) => (
                              <li
                                key={c.key}
                                className="flex items-center gap-2 px-2.5 py-1.5"
                              >
                                <span
                                  className="min-w-0 flex-1 truncate"
                                  title={c.unavailableReason ?? undefined}
                                >
                                  {c.title}
                                </span>
                                <SetupToolButton
                                  card={c}
                                  compact
                                  hint={c.unavailableReason}
                                />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </section>
                  )}

                  {breakdown.beta.length > 0 && (
                    <section className="space-y-2" data-testid="readiness-beta">
                      <h3 className="flex items-center gap-1.5 font-semibold">
                        <FlaskConical className="h-3.5 w-3.5 text-light-500 dark:text-dark-400" />
                        Beta ({breakdown.beta.length})
                      </h3>
                      <p className="text-[12px] text-pretty text-light-500 dark:text-dark-400">
                        Adrift has no model check for these, so it can&apos;t
                        confirm their files are installed. They usually work;
                        if one fails, its error names the missing file or node.
                      </p>
                      <ul className="flex flex-wrap gap-1.5">
                        {breakdown.beta.map((c) => (
                          <li key={c.key}>
                            <button
                              type="button"
                              onClick={() => openTool(c.openKey ?? c.key)}
                              className="rounded-full px-2.5 py-1 text-[12px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] hover:bg-light-input focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] dark:hover:bg-dark-input"
                            >
                              {c.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
