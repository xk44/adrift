"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Compass, Plug, Sparkles, X } from "lucide-react";
import { useUIStore } from "@/store";
import {
  markOnboarded,
  useOnboardingStore,
  type OnboardingStep,
} from "@/store/onboardingStore";
import { getPacks, type ConnectionStatus, type PacksResponse } from "./api";
import { ConnectStep, type Choice } from "./ConnectStep";
import { FoldersEditor, type FoldersEditorHandle } from "./FoldersEditor";
import { PacksStep } from "./PacksStep";
import { NO_TOOL_PICKS, type ToolPicks } from "@/lib/onboarding/toolPicker";
import { BTN, MUTED } from "./ui";

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "folders", label: "Folders" },
  { id: "packs", label: "Models" },
  { id: "done", label: "Done" },
];

const TITLE: Record<OnboardingStep, string> = {
  connect: "Connect ComfyUI",
  folders: "Folders",
  packs: "Starter models",
  done: "You're set",
};

function DoneStep({
  status,
  packs,
  selected,
  toolCount,
}: {
  status: ConnectionStatus | null;
  packs: PacksResponse | null;
  selected: string[];
  toolCount: number;
}) {
  const all = packs?.packs ?? [];
  const ready = all.filter((p) => p.allInstalled);
  const pending = all.filter((p) => !p.allInstalled && selected.includes(p.id));
  const unlocks = (list: typeof all) => [
    ...new Set(list.flatMap((p) => p.unlocks)),
  ];
  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex gap-2">
        {status?.reachable ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
        ) : (
          <Circle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${MUTED}`} />
        )}
        <p>
          {status?.reachable && status.probe.ok
            ? `ComfyUI is connected (${status.probe.gpuName}).`
            : "ComfyUI isn't connected yet, so creating images is off for now. Explore and Styles still work."}
        </p>
      </div>
      <p data-testid="onboarding-next-step">
        <span className="font-semibold">What next: </span>
        {status?.reachable
          ? "press Try a prompt, type what you want to see, and press Enter."
          : "once ComfyUI is running, press Connect ComfyUI below, or open Settings, then Connection & models."}
      </p>
      {ready.length > 0 && (
        <div>
          <p className="font-semibold">Ready now</p>
          <ul className={`mt-1 list-disc space-y-0.5 pl-5 ${MUTED}`}>
            {unlocks(ready).map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {pending.length > 0 && (
        <div>
          <p className="font-semibold">After your download finishes</p>
          <ul className={`mt-1 list-disc space-y-0.5 pl-5 ${MUTED}`}>
            {unlocks(pending).map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <p className={`mt-1 text-[12px] ${MUTED}`}>
            Restart ComfyUI once the files are in place.
          </p>
        </div>
      )}
      {toolCount > 0 && (
        <p className={MUTED} data-testid="onboarding-tool-picks">
          When the download finishes, restart ComfyUI. The Tools page shows
          anything {toolCount === 1 ? "your tool" : `your ${toolCount} tools`}{" "}
          still {toolCount === 1 ? "needs" : "need"}, such as custom nodes or
          files to download by hand.
        </p>
      )}
      {!ready.length && !pending.length && !toolCount && status?.reachable && (
        <p className={MUTED}>
          No starter models picked. The Tools page shows what each tool needs
          whenever you want more.
        </p>
      )}
    </div>
  );
}

export function OnboardingWizard({
  status,
  refreshStatus,
}: {
  status: ConnectionStatus | null;
  refreshStatus: () => Promise<void>;
}) {
  const open = useOnboardingStore((s) => s.open);
  const step = useOnboardingStore((s) => s.step);
  const focus = useOnboardingStore((s) => s.focus);
  const setStep = useOnboardingStore((s) => s.setStep);
  const closeStore = useOnboardingStore((s) => s.close);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const ref = useRef<HTMLDialogElement>(null);
  const [packs, setPacks] = useState<PacksResponse | null>(null);
  const [packsLoading, setPacksLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const touched = useRef(false);
  const [toolPicks, setToolPicks] = useState<ToolPicks>(NO_TOOL_PICKS);
  // "I don't have ComfyUI yet": Folders shows only Adrift's own library.
  const [noComfy, setNoComfy] = useState(false);
  const folders = useRef<FoldersEditorHandle>(null);
  const [savingFolders, setSavingFolders] = useState(false);
  const [connectChoice, setConnectChoice] = useState<Choice | null>(null);

  const close = useCallback(() => {
    markOnboarded(); // closing at any step counts as "skip": don't nag again
    closeStore();
  }, [closeStore]);

  const loadPacks = useCallback(async () => {
    setPacksLoading(true);
    const data = await getPacks();
    setPacks(data);
    setPacksLoading(false);
    if (data && !touched.current) setSelected(data.preselected);
  }, []);

  useEffect(() => {
    if (open && step === "packs") void loadPacks();
  }, [open, step, loadPacks]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      if (!d.open) {
        if (typeof d.showModal === "function") d.showModal();
        else d.setAttribute("open", "");
        // Start on the choice that matters (the picked radio, else Next),
        // not on Close.
        requestAnimationFrame(() => {
          const target =
            d.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
            d.querySelector<HTMLElement>("[data-autofocus]");
          target?.focus();
        });
      }
    } else if (d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  // Next/Back can unmount the focused button (Next is gone on Done): put
  // focus on the step's main action instead of letting it drop to <body>.
  useEffect(() => {
    const d = ref.current;
    if (!open || !d) return;
    requestAnimationFrame(() => {
      if (d.contains(document.activeElement)) return;
      d.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")?.focus();
    });
  }, [open, step]);

  const select = useCallback((ids: string[]) => {
    touched.current = true;
    setSelected(ids);
  }, []);

  const tryPrompt = () => {
    close();
    setActiveNav("create");
    setTimeout(() => {
      const bar = document.querySelector(
        "#desktop_input_bar",
      ) as HTMLTextAreaElement | null;
      bar?.focus();
    }, 50);
  };

  const idx = STEPS.findIndex((s) => s.id === step);
  const next = async () => {
    if (step === "folders" && folders.current) {
      // Warnings never block; only a refused save (e.g. a system folder) does.
      setSavingFolders(true);
      const ok = await folders.current.save();
      setSavingFolders(false);
      if (!ok) return;
      if (noComfy) return setStep("done");
    }
    // "I don't have ComfyUI yet" + footer Next = "Continue without it".
    if (step === "connect" && connectChoice === "none")
      return continueWithout();
    if (step === "connect") setNoComfy(false);
    setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)].id);
  };
  const back = () => {
    if (step === "done" && noComfy) return setStep("folders");
    setStep(STEPS[Math.max(idx - 1, 0)].id);
  };
  const continueWithout = () => {
    setNoComfy(true);
    setStep("folders");
  };

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding-wizard"
      onClose={() => {
        if (useOnboardingStore.getState().open) close();
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-full overflow-hidden rounded-t-2xl bg-light-bg p-0 text-light-primary shadow-2xl backdrop:bg-black/50 dark:bg-dark-bg dark:text-dark-primary sm:m-auto sm:max-h-[min(760px,90dvh)] sm:w-[560px] sm:rounded-2xl"
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col sm:max-h-[min(760px,90dvh)]">
          <header
            className="flex items-start gap-3 border-b border-light-100 py-3 dark:border-dark-750"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
              paddingRight: "max(1rem, env(safe-area-inset-right))",
            }}
          >
            <Sparkles className="mt-1 h-4 w-4 flex-shrink-0 text-splash" />
            <div className="min-w-0 flex-1">
              <h2 id="onboarding-title" className="text-[16px] font-semibold">
                {step === "done" && !status?.reachable
                  ? "Setup saved"
                  : TITLE[step]}
              </h2>
              <ol className={`mt-0.5 flex gap-2 text-[11px] ${MUTED}`}>
                {STEPS.map((s, i) => (
                  <li
                    key={s.id}
                    aria-current={s.id === step ? "step" : undefined}
                    className={s.id === step ? "font-semibold text-splash" : ""}
                  >
                    {i + 1}. {s.label}
                  </li>
                ))}
              </ol>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close setup"
              className={`${BTN.ghost} w-10 px-0`}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-4"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
              paddingRight: "max(1rem, env(safe-area-inset-right))",
            }}
          >
            {step === "connect" && (
              <ConnectStep
                status={status}
                onSaved={refreshStatus}
                onContinueWithout={continueWithout}
                onNext={() => void next()}
                onChoiceChange={setConnectChoice}
              />
            )}
            {step === "folders" && (
              <FoldersEditor ref={folders} noComfy={noComfy} />
            )}
            {step === "packs" && (
              <PacksStep
                data={packs}
                loading={packsLoading}
                onReload={() => void loadPacks()}
                selected={selected}
                onSelect={select}
                focus={focus}
                toolPicks={toolPicks}
                onToolPicks={setToolPicks}
              />
            )}
            {step === "done" && (
              <DoneStep
                status={status}
                packs={packs}
                selected={selected}
                toolCount={toolPicks.tools.length}
              />
            )}
          </div>

          <footer
            className="flex flex-wrap items-center gap-2 border-t border-light-100 pt-3 dark:border-dark-750"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
              paddingRight: "max(1rem, env(safe-area-inset-right))",
              paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            }}
          >
            {idx > 0 && (
              <button type="button" onClick={back} className={BTN.ghost}>
                Back
              </button>
            )}
            <span className="flex-1" />
            {step !== "done" ? (
              <>
                <button type="button" onClick={close} className={BTN.ghost}>
                  Skip setup
                </button>
                <button
                  type="button"
                  onClick={() => void next()}
                  disabled={savingFolders}
                  data-autofocus=""
                  className={BTN.secondary}
                >
                  {step === "packs" &&
                  selected.length === 0 &&
                  toolPicks.tools.length === 0
                    ? "Skip models"
                    : "Next"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setActiveNav("explore");
                  }}
                  data-autofocus={status?.reachable ? undefined : ""}
                  className={BTN.secondary}
                >
                  <Compass className="h-4 w-4" /> Explore
                </button>
                {status?.reachable ? (
                  <button
                    type="button"
                    onClick={tryPrompt}
                    data-autofocus=""
                    className={`${BTN.primary} max-[379px]:w-full`}
                  >
                    <Sparkles className="h-4 w-4" /> Try a prompt
                  </button>
                ) : (
                  // No dead end: a disabled "Try a prompt" told people
                  // nothing. Send them back to the step that fixes it.
                  <button
                    type="button"
                    onClick={() => setStep("connect")}
                    data-testid="onboarding-connect-now"
                    className={`${BTN.primary} max-[379px]:w-full`}
                  >
                    <Plug className="h-4 w-4" /> Connect ComfyUI
                  </button>
                )}
              </>
            )}
          </footer>
        </div>
      )}
    </dialog>
  );
}
