"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useUIStore } from "@/store";
import { openOnboarding } from "@/store/onboardingStore";
import { useFirstRunStatus } from "@/hooks/useFirstRunStatus";
import { CopyCommand } from "@/components/setup/CopyCommand";
import {
  SAMPLE_PROMPT,
  checklistRows,
  comfyMainCommand,
  describeMissing,
  formatBytes,
  isLocalComfyUrl,
  startComfyCommand,
  starterDownloadCommand,
  type ChecklistRow,
} from "@/lib/setup/firstRun";

/** Put the sample prompt in the prompt bar and focus it. Never submits. */
export function fillSamplePrompt() {
  useUIStore.getState().setPromptValue(SAMPLE_PROMPT);
  window.setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>("#desktop_input_bar")?.focus();
  }, 0);
}

function useOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

function StateIcon({ state }: { state: ChecklistRow["state"] }) {
  if (state === "ok")
    return (
      <CheckCircle2
        className="h-5 w-5 text-[var(--success)]"
        aria-label="Done"
      />
    );
  if (state === "fail")
    return (
      <XCircle
        className="h-5 w-5 text-[var(--error)]"
        aria-label="Needs a fix"
      />
    );
  if (state === "todo")
    return (
      <Sparkles
        className="h-5 w-5 text-[var(--accent-primary)]"
        aria-label="Next step"
      />
    );
  return (
    <Circle
      className="h-5 w-5 text-[var(--text-muted)]"
      aria-label="Not checked yet"
    />
  );
}

function Row({
  row,
  title,
  children,
}: {
  row: ChecklistRow;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li
      className="flex gap-3 py-3"
      data-testid={`first-run-row-${row.id}`}
      data-state={row.state}
    >
      <div className="pt-0.5 flex-shrink-0">
        <StateIcon state={row.state} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p
          className={`text-sm font-medium ${
            row.state === "unknown"
              ? "text-[var(--text-tertiary)]"
              : "text-[var(--text-primary)]"
          }`}
        >
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

const hint = "text-xs leading-5 text-[var(--text-secondary)]";

/** Opens the Setup wizard on its Connect step (the one place to change it). */
export function ChangeConnectionButton() {
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => openOnboarding("connect")}
        className="btn btn-secondary min-h-[44px] text-sm"
        data-testid="change-connection"
      >
        Change connection
      </button>
      <p className="text-[11px] leading-4 text-[var(--text-tertiary)]">
        Advanced: COMFY_HTTP_URL in .env.local overrides this; remove it there
        to choose in Setup.
      </p>
    </div>
  );
}

/**
 * First-run checklist for Create's empty state (and the "Open checklist" dialog):
 * ComfyUI reachable, a Create model present, try a sample prompt. Failing
 * rows carry the exact command that fixes them.
 */
export function FirstRunChecklist({ compact = false }: { compact?: boolean }) {
  const { status, loading, error, refresh } = useFirstRunStatus();
  const origin = useOrigin();
  const rows = checklistRows(status);
  const [comfyRow, modelRow, sampleRow] = rows;
  const allGood = sampleRow.state === "todo";
  const comfyUrl = status?.comfy.url || undefined;
  const local = isLocalComfyUrl(comfyUrl);
  const model = status?.createModel;

  const heading = !status
    ? "Checking your setup…"
    : allGood
      ? "You're ready to create"
      : "A couple of steps before your first image";

  return (
    <section
      className={`mx-auto w-full max-w-xl px-4 ${compact ? "py-2" : "py-10"}`}
      aria-labelledby="first-run-heading"
      data-testid="first-run-checklist"
    >
      {!compact && (
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)]">
            <Sparkles
              className="h-5 w-5 text-[var(--accent-primary)]"
              aria-hidden
            />
          </div>
          <div className="min-w-0">
            <h3
              id="first-run-heading"
              className="text-base font-semibold text-[var(--text-primary)]"
            >
              {heading}
            </h3>
            <p className="text-xs text-[var(--text-tertiary)]">
              {allGood
                ? "Type a prompt above, or start with ours."
                : "Adrift makes images with ComfyUI running on your computer."}
            </p>
          </div>
        </div>
      )}
      {compact && (
        <h3 id="first-run-heading" className="sr-only">
          {heading}
        </h3>
      )}

      <ol className="divide-y divide-[var(--border-primary)] rounded-xl bg-[var(--bg-secondary)] px-4 shadow-[inset_0_0_0_1px_var(--border-primary)]">
        <Row
          row={comfyRow}
          title={
            comfyRow.state === "ok" ? "ComfyUI is running" : "Start ComfyUI"
          }
        >
          {comfyRow.state === "fail" &&
            (local ? (
              <>
                <p className={hint}>
                  Adrift can&apos;t reach ComfyUI
                  {comfyUrl ? ` at ${comfyUrl}` : ""}. In a terminal, from the
                  Adrift folder, run:
                </p>
                <CopyCommand
                  label="Start ComfyUI"
                  command={startComfyCommand({
                    comfyRoot: status?.comfyRoot,
                    comfyUrl,
                    origin,
                  })}
                />
                <p className={hint}>Or, from inside your ComfyUI folder:</p>
                <CopyCommand
                  label="Start ComfyUI from its folder"
                  command={comfyMainCommand({ comfyUrl, origin })}
                />
              </>
            ) : (
              <>
                <p className={hint}>
                  Adrift can&apos;t reach ComfyUI at {comfyUrl}. Make sure that
                  computer is on and ComfyUI is running there, or point Adrift
                  at another one.
                </p>
                <ChangeConnectionButton />
              </>
            ))}
          {error === "network" && !status && (
            <p className={hint}>
              Adrift&apos;s server didn&apos;t answer. Is it still running?
            </p>
          )}
        </Row>

        <Row
          row={modelRow}
          title={
            modelRow.state === "ok"
              ? `Model ready${model?.using ? `: ${model.using}` : ""}`
              : "Add a model for Create"
          }
        >
          {modelRow.state === "fail" && model && (
            <>
              <p className={hint}>
                Missing {model.missing.map(describeMissing).join(", ")}.
              </p>
              {model.starter ? (
                <>
                  <p className={hint}>
                    Download {model.starter.label} (
                    {formatBytes(model.starter.sizeBytes)}) into ComfyUI:
                  </p>
                  <CopyCommand
                    label={`Download ${model.starter.label}`}
                    command={starterDownloadCommand(
                      model.starter,
                      status?.comfyRoot,
                    )}
                  />
                  <p className={hint}>
                    Or put any SDXL .safetensors checkpoint in
                    models/checkpoints, then check again.
                  </p>
                </>
              ) : model.starterPack ? (
                <>
                  <p className={hint}>
                    Get the &quot;{model.starterPack.title}&quot; starter pack (
                    {formatBytes(model.starterPack.sizeBytes)}). From the
                    Adrift folder, run:
                  </p>
                  <CopyCommand
                    label={`Download ${model.starterPack.title}`}
                    command={model.starterPack.command}
                  />
                  <p className={hint}>
                    Or pick another model in Settings, then check again.
                  </p>
                </>
              ) : (
                <p className={hint}>
                  Add it to your ComfyUI folder (or pick another model in
                  Settings), then check again.
                </p>
              )}
            </>
          )}
          {modelRow.state === "unknown" &&
            comfyRow.state === "ok" &&
            error === "auth" && (
              <p className={hint}>
                Sign in as admin to see which models are installed.
              </p>
            )}
        </Row>

        <Row row={sampleRow} title="Try a sample prompt">
          {allGood && (
            <button
              type="button"
              onClick={fillSamplePrompt}
              className="btn btn-primary min-h-[44px] text-sm"
              data-testid="first-run-sample"
            >
              Use a sample prompt
            </button>
          )}
        </Row>
      </ol>

      {!allGood && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="btn btn-secondary min-h-[44px] text-sm inline-flex items-center gap-2"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Check again
          </button>
        </div>
      )}
    </section>
  );
}

export default FirstRunChecklist;
