"use client";

import { createContext, useContext } from "react";
import { AlertCircle, ArrowLeft, Info, Loader2, Play } from "lucide-react";
import { useUIStore } from "@/store";
import { setupHint } from "@/lib/tools/setupHint";
import { ToolCover, useRunnerCard } from "./ToolCover";
import { SetupToolButton } from "./SetupDrawer";
import { OutputFormatPicker } from "./OutputFormatPicker";
import {
  RunHint,
  RunnerStage,
  RunnerStudio,
  useRecentToolRuns,
} from "./RunnerStudio";
import { outputForCategory, type RunOutput } from "@/lib/tools/runnerStudio";

/** Short "needs X" hint of the enclosing RunnerShell, for its RunFooter. */
const BlockedHintContext = createContext<string | null>(null);

/** Output kind of a studio RunnerShell, for its RunFooter time hint. */
const StudioOutputContext = createContext<RunOutput | null>(null);

/**
 * Blocked / checking banner: a short "Needs X model" headline with the full
 * install instructions underneath.
 */
export function RunnerNotice({
  checking,
  reason,
  model,
}: {
  checking?: boolean;
  reason?: string | null;
  model?: string | null;
}) {
  if (!checking && !reason) return null;
  if (checking)
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl bg-light-input p-3 text-xs text-light-500 dark:bg-dark-input dark:text-dark-400"
      >
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
        Checking what this server has installed...
      </div>
    );
  return <BlockedNotice reason={reason ?? null} model={model ?? null} />;
}

function BlockedNotice({
  reason,
  model,
}: {
  reason: string | null;
  model: string | null;
}) {
  const card = useRunnerCard();
  const hint = setupHint(reason, model);
  const detail = reason && reason !== hint ? reason : null;
  return (
    <div
      role="status"
      data-testid="runner-blocked"
      className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600 dark:text-amber-400"
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-[13px] font-semibold">{hint}</p>
        {detail && (
          <p className="break-words text-xs text-pretty opacity-85">
            {detail}
          </p>
        )}
        {card && card.kind !== "placeholder" && (
          <div className="pt-1.5">
            <SetupToolButton card={card} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Inline run error: icon + message, one visual language across runners. */
export function RunError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-2 text-xs text-red-600 dark:text-red-400"
    >
      <AlertCircle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

/**
 * Runner header: back pill, cover tile (from the hub card the runner was
 * opened from, via RunnerCardContext), title, subtitle, model + NC chips.
 */
export function RunnerHeader({
  title,
  subtitle,
  model,
  onBack,
}: {
  title: string;
  subtitle: string;
  model?: string | null;
  onBack: () => void;
}) {
  const card = useRunnerCard();
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-light-500 transition-[background-color,color,transform] duration-150 hover:bg-light-input hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash active:scale-[0.96] dark:text-dark-400 dark:hover:bg-dark-input dark:hover:text-dark-primary"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> All tools
      </button>
      <header className="flex items-start gap-3.5 animate-fade-in">
        {card && (
          <ToolCover
            card={card}
            size="md"
            className="h-14 w-14 flex-shrink-0 rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.3),0_2px_4px_rgba(0,0,0,0.15)] sm:h-16 sm:w-16"
          />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold tracking-tight text-balance text-light-primary dark:text-dark-primary">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-pretty text-light-500 dark:text-dark-400">
            {subtitle}
          </p>
          {(model || card?.nc) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {model && (
                <span className="max-w-full break-words rounded-full bg-light-input px-2 py-0.5 text-[11px] text-light-500 dark:bg-dark-input dark:text-dark-400">
                  {model}
                </span>
              )}
              {card?.nc && (
                <span
                  className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  title="Non-commercial model license"
                >
                  Non-commercial
                </span>
              )}
            </div>
          )}
        </div>
      </header>
    </div>
  );
}

/** Shared frame for the hub runners (templates, apps, color grade, cast). */
export function RunnerShell({
  title,
  subtitle,
  model,
  blockedReason,
  checking,
  onBack,
  testId,
  studio,
  recentKey,
  children,
}: {
  title: string;
  subtitle: string;
  model?: string | null;
  /** Shown as an amber banner; null = runnable. */
  blockedReason?: string | null;
  checking?: boolean;
  onBack: () => void;
  testId: string;
  /**
   * Studio layout: controls beside a large preview stage with this tool's
   * recent results; RunFooter adds the time hint. `true` infers the output
   * kind from the hub section.
   */
  studio?: boolean | RunOutput;
  /** Recent-results key when the runner has no hub card (default: card key). */
  recentKey?: string;
  children: React.ReactNode;
}) {
  const card = useRunnerCard();
  const hint =
    !checking && blockedReason ? setupHint(blockedReason, model) : null;
  if (studio) {
    const output =
      studio === true ? outputForCategory(card?.hubCategory) : studio;
    return (
      <RunnerStudio
        testId={testId}
        header={
          <>
            <RunnerHeader
              title={title}
              subtitle={subtitle}
              model={model}
              onBack={onBack}
            />
            <RunnerNotice
              checking={checking}
              reason={blockedReason}
              model={model}
            />
          </>
        }
        controls={
          <BlockedHintContext.Provider value={hint}>
            <StudioOutputContext.Provider value={output}>
              {children}
            </StudioOutputContext.Provider>
          </BlockedHintContext.Provider>
        }
        stage={<StudioStage cardKey={recentKey ?? card?.key ?? testId} />}
      />
    );
  }
  return (
    <div className="flex-1 min-w-0 overflow-y-auto" data-testid={testId}>
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-28 pt-5 sm:px-6 sm:pb-10">
        <RunnerHeader
          title={title}
          subtitle={subtitle}
          model={model}
          onBack={onBack}
        />
        <RunnerNotice
          checking={checking}
          reason={blockedReason}
          model={model}
        />
        <BlockedHintContext.Provider value={hint}>
          {children}
        </BlockedHintContext.Provider>
      </div>
    </div>
  );
}

/** Preview stage + recent strip of a studio RunnerShell. */
function StudioStage({ cardKey }: { cardKey: string }) {
  const runs = useRecentToolRuns(cardKey);
  return <RunnerStage runs={runs} />;
}

/** Primary run CTA, shared with ToolRunner. */
export const RUN_BUTTON =
  "flex h-11 items-center gap-2 rounded-full bg-splash px-6 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),0_4px_14px_-4px_rgb(var(--c-splash)/0.55)] transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash focus-visible:ring-offset-2 focus-visible:ring-offset-light-bg dark:focus-visible:ring-offset-dark-bg";

/** RUN_BUTTON in a runner's footer: full-width thumb target on phones. */
export const RUN_BUTTON_FOOTER =
  `${RUN_BUTTON} max-sm:w-full max-sm:justify-center`;

/** Run button + validation / error / queued lines. */
export function RunFooter({
  label,
  busy,
  disabled,
  validation,
  error,
  queuedText,
  onRun,
  icon,
  masterFile = true,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  validation: string | null;
  error: string | null;
  queuedText: string | null;
  onRun: () => void;
  icon?: React.ReactNode;
  /** Show the "Master file" picker (off for runs with no image/video output). */
  masterFile?: boolean;
}) {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const blockedHint = useContext(BlockedHintContext);
  const studioOutput = useContext(StudioOutputContext);
  return (
    <div className="space-y-2">
      {masterFile && <OutputFormatPicker />}
      <button
        type="button"
        onClick={onRun}
        disabled={busy || disabled || validation !== null}
        aria-busy={busy}
        className={RUN_BUTTON_FOOTER}
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          (icon ?? <Play className="w-4 h-4" />)
        )}
        {label}
      </button>
      {studioOutput && <RunHint output={studioOutput} />}
      {blockedHint && !busy ? (
        <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {blockedHint} to run this.
        </p>
      ) : (
        validation &&
        !busy && (
          <p className="text-[11px] text-light-500 dark:text-dark-400">
            {validation}
          </p>
        )
      )}
      {error && <RunError message={error} />}
      {queuedText && (
        <p className="text-xs text-light-500 dark:text-dark-400">
          {queuedText}{" "}
          <button
            type="button"
            className="text-splash underline"
            onClick={() => setActiveNav("create")}
          >
            Open Create
          </button>{" "}
          to watch progress.
        </p>
      )}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
