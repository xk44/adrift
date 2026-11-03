"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  HardDrive,
  Loader2,
  Monitor,
  Network,
  XCircle,
} from "lucide-react";
import {
  forgetConnection,
  saveConnection,
  testConnection,
  type ConnectionMode,
  type ConnectionStatus,
  type ProbeResult,
} from "./api";
import { BTN, CHIP_WARN, Chip, CommandBox, INPUT, MUTED, useCopy } from "./ui";
import {
  shouldAutoProbeLocal,
  splitCliFlags,
} from "@/lib/onboarding/connectUi";
import { insecureUrlWarning } from "@/lib/onboarding/comfyUrl";
import { ComfyInstancesSettings } from "@/components/settings/ComfyInstancesSettings";
import { OverlayInstallCard } from "@/components/settings/OverlayInstallCard";

export type Choice = ConnectionMode | "none";

const CHOICES: {
  id: Choice;
  title: string;
  hint: string;
  Icon: typeof Monitor;
}[] = [
  {
    id: "local",
    title: "This computer",
    hint: "ComfyUI runs here",
    Icon: Monitor,
  },
  {
    id: "lan",
    title: "Another computer on my network",
    hint: "A PC at home or in the office",
    Icon: Network,
  },
  {
    id: "wan",
    title: "Over the internet",
    hint: "A rented GPU or a remote box",
    Icon: Globe,
  },
  {
    id: "none",
    title: "I don't have ComfyUI yet",
    hint: "Show me how to get it",
    Icon: HardDrive,
  },
];

export function ProbeCard({ result }: { result: ProbeResult }) {
  if (!result.ok)
    return (
      <div
        role="alert"
        className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-700 dark:text-red-300"
      >
        <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0">
          <p>
            {/* Keep CLI flags like --listen on one line. */}
            {splitCliFlags(result.error).map((part, i) =>
              i % 2 ? (
                <code key={i} className="whitespace-nowrap">
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
          <p className="mt-0.5 break-all text-[12px] opacity-80">
            {result.url}
          </p>
        </div>
      </div>
    );
  const gb = result.memoryGb;
  return (
    <div
      role="status"
      className="flex gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px] text-emerald-800 dark:text-emerald-200"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">
          ComfyUI {result.comfyuiVersion ?? ""} found
        </p>
        <p className="break-all text-[12px] opacity-90">{result.url}</p>
        <p className="text-[12px]">
          {result.gpuName}
          {gb > 0 &&
            (result.unified
              ? ` · ${gb} GB unified memory (shared with the CPU)`
              : ` · ${gb} GB ${result.deviceType === "cpu" ? "RAM" : "VRAM"}`)}
          {result.nodeCount != null && ` · ${result.nodeCount} nodes`}
        </p>
      </div>
    </div>
  );
}

/** Arrow / Home / End target in the "where does ComfyUI run" group. */
export function nextChoice(current: Choice, key: string): Choice | null {
  const ids = CHOICES.map((c) => c.id);
  const i = Math.max(0, ids.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return ids[(i + 1) % ids.length];
    case "ArrowLeft":
    case "ArrowUp":
      return ids[(i - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return null;
  }
}

function pageOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return "http://localhost:3000";
  }
}

export function ConnectStep({
  status,
  onSaved,
  onContinueWithout,
  onChoiceChange,
  onNext,
}: {
  status: ConnectionStatus | null;
  onSaved: () => Promise<void> | void;
  onContinueWithout: () => void;
  onNext: () => void;
  /** Lets the wizard's footer Next follow the picked option. */
  onChoiceChange?: (choice: Choice) => void;
}) {
  const [choice, setChoice] = useState<Choice>(() =>
    status?.source === "saved" && status.mode ? status.mode : "local",
  );
  const [url, setUrl] = useState(() =>
    status?.source === "saved" && status.mode !== "local"
      ? (status.savedUrl ?? "")
      : "",
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [testedUrl, setTestedUrl] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** Warning from a save nobody acknowledged yet: hold the step until read. */
  const [savedWarning, setSavedWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advError, setAdvError] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const envLocked = !!status?.envLocked;
  const savedSame = (u: string | null) =>
    !!u && status?.source === "saved" && status.savedUrl === u;

  const reset = () => {
    setResult(null);
    setTestedUrl(null);
    setWarning(null);
    setSavedWarning(null);
    setError(null);
  };

  const probeLocal = useCallback(async () => {
    setBusy("test");
    setError(null);
    const r = await testConnection({ probeLocal: true });
    setBusy(null);
    if (!r.ok || !r.result) {
      setError(r.error ?? "Couldn't test.");
      return;
    }
    setResult(r.result);
    setTestedUrl(r.result.url);
  }, []);

  // "This computer" looks on its own: 8188 (ComfyUI), then 8000 (Desktop).
  useEffect(() => {
    if (
      shouldAutoProbeLocal({
        choice,
        hasResult: !!result,
        busy: !!busy,
        envLocked,
        reachable: !!status?.reachable,
      })
    )
      void probeLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);

  const testRemote = async (mode: ConnectionMode) => {
    setBusy("test");
    reset();
    const r = await testConnection({
      url,
      mode,
      token: token || undefined,
      useSavedToken: !token,
    });
    setBusy(null);
    if (!r.ok || !r.result) {
      setError(r.error ?? "Couldn't test.");
      return;
    }
    setResult(r.result);
    setTestedUrl(r.normalizedUrl ?? r.result.url);
    setWarning(r.warning ?? null);
  };

  const save = async (mode: ConnectionMode, target: string) => {
    setBusy("save");
    setError(null);
    const r = await saveConnection({
      url: target,
      mode,
      token: mode === "local" ? undefined : token || undefined,
      keepToken: !token,
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? "Couldn't save.");
      return;
    }
    await onSaved();
    onNext();
  };

  const forget = async () => {
    setBusy("save");
    const r = await forgetConnection();
    setBusy(null);
    if (!r.ok) setError(r.error ?? "Couldn't forget it.");
    else await onSaved();
  };

  const pick = (id: Choice) => {
    if (id === choice) return;
    reset();
    setChoice(id);
  };

  useEffect(() => {
    onChoiceChange?.(choice);
  }, [choice, onChoiceChange]);

  const [moreOpen, setMoreOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const remote = choice === "lan" || choice === "wan";
  const okResult = result?.ok ? result : null;

  return (
    <div className="space-y-4">
      <p className={`text-[13px] ${MUTED}`}>
        Adrift sends your prompts to ComfyUI, which does the actual work. Where
        is yours?
      </p>

      {status && (
        <div className="rounded-xl border border-light-100 p-3 text-[12px] dark:border-dark-750">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">Now:</span>
            <span className="break-all">{status.httpUrl}</span>
            {status.reachable ? (
              <Chip className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                Connected
              </Chip>
            ) : (
              <Chip className={CHIP_WARN}>Not answering</Chip>
            )}
          </p>
          <p className={`mt-1 ${MUTED}`}>
            {status.source === "env"
              ? "Set by COMFY_HTTP_URL in .env.local, which always wins. Remove it there to choose here."
              : status.source === "saved"
                ? "Saved by this wizard."
                : "Nothing chosen yet, so Adrift tries the usual address on this computer. Pick where ComfyUI runs below."}
          </p>
          {status.source === "saved" && (
            <button
              type="button"
              onClick={() => void forget()}
              disabled={!!busy}
              className={`${BTN.ghost} -ml-2 mt-1 min-h-[40px] text-[12px]`}
            >
              Forget the saved address
            </button>
          )}
        </div>
      )}

      <fieldset>
        <legend className="sr-only">Where ComfyUI runs</legend>
        <div
          className="grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Where ComfyUI runs"
          onKeyDown={(e) => {
            // One Tab stop; arrows move the choice (WAI-ARIA radio group).
            const next = nextChoice(choice, e.key);
            if (!next) return;
            e.preventDefault();
            pick(next);
            const group = e.currentTarget;
            requestAnimationFrame(() =>
              group
                .querySelector<HTMLElement>(`[data-choice="${next}"]`)
                ?.focus(),
            );
          }}
        >
          {CHOICES.map(({ id, title, hint, Icon }) => {
            const on = choice === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-choice={id}
                onClick={() => pick(id)}
                className={`flex min-h-[56px] items-start gap-2.5 rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${
                  on
                    ? "border-splash bg-splash/5"
                    : "border-light-200 hover:bg-light-100 dark:border-dark-750 dark:hover:bg-dark-850"
                }`}
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? "text-splash" : MUTED}`}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">
                    {title}
                  </span>
                  <span className={`block text-[12px] ${MUTED}`}>{hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {choice === "local" && (
        <div className="space-y-3">
          {busy === "test" && (
            <p
              role="status"
              className={`flex items-center gap-2 text-[13px] ${MUTED}`}
            >
              <Loader2 className="h-4 w-4 animate-spin" /> Looking on ports 8188
              and 8000...
            </p>
          )}
          {result && <ProbeCard result={result} />}
          {result && !result.ok && (
            <div className={`space-y-1.5 text-[12px] ${MUTED}`}>
              <p>
                Start ComfyUI (or ComfyUI Desktop) and look again. Already have
                a ComfyUI folder here? Point Adrift at it once, then{" "}
                <code className="font-mono">./adrift</code> starts it for you:
              </p>
              <CommandBox
                id="use-existing-comfy"
                text="./install.sh --comfy /path/to/ComfyUI"
                copied={copied}
                onCopy={copy}
                label="Copy the command"
              />
              <p>
                On another computer or a rented GPU? Pick that above. Not
                installed yet? Pick &ldquo;I don&apos;t have ComfyUI yet&rdquo;.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void probeLocal()}
              disabled={!!busy}
              className={BTN.secondary}
            >
              Look again
            </button>
            {okResult && testedUrl && (
              <button
                type="button"
                onClick={() =>
                  savedSame(testedUrl)
                    ? onNext()
                    : void save("local", testedUrl)
                }
                disabled={!!busy || envLocked}
                className={BTN.primary}
              >
                {busy === "save" && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Use this one
              </button>
            )}
          </div>
        </div>
      )}

      {remote && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void testRemote(choice);
          }}
        >
          {choice === "wan" && (
            <div
              role="note"
              className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                Anyone who can reach an open ComfyUI can run code on that
                machine. Safer: a VPN like Tailscale plus &ldquo;Another
                computer on my network&rdquo;, or a login proxy in front of
                ComfyUI with its token below.
              </p>
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[12px] font-semibold">
              {choice === "lan"
                ? "Address (host:port)"
                : "Address (https://...)"}
            </span>
            <input
              className={INPUT}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                reset();
              }}
              placeholder={
                choice === "lan"
                  ? "my-pc.local:8188"
                  : "https://comfy.example.com"
              }
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              required
            />
          </label>
          {choice === "wan" && (
            <label className="block space-y-1">
              <span className="text-[12px] font-semibold">
                Access token{" "}
                <span className={`font-normal ${MUTED}`}>(optional)</span>
              </span>
              <input
                className={INPUT}
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  reset();
                }}
                placeholder={
                  status?.hasToken && status.source === "saved"
                    ? "Saved (leave empty to keep)"
                    : "Sent as Authorization: Bearer ..."
                }
                autoComplete="off"
              />
              <span className={`block text-[11px] ${MUTED}`}>
                Stored only on the Adrift server. Never shown again.
              </span>
            </label>
          )}
          {choice === "lan" && (
            <div className={`space-y-1 text-[12px] ${MUTED}`}>
              <p>
                On that computer, start ComfyUI so it listens on the network and
                lets this page connect. ComfyUI has no login: anyone on this
                network can run code on it. An SSH tunnel is safer.
              </p>
              <CommandBox
                id="lan-flags"
                text={`--listen 0.0.0.0 --enable-cors-header ${pageOrigin()}`}
                copied={copied}
                onCopy={copy}
                label="Copy ComfyUI flags"
              />
            </div>
          )}
          {result && <ProbeCard result={result} />}
          {warning && (
            <p
              role="note"
              className="text-[12px] text-amber-700 dark:text-amber-300"
            >
              {warning}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!!busy || !url.trim()}
              className={BTN.secondary}
            >
              {busy === "test" && <Loader2 className="h-4 w-4 animate-spin" />}
              Test
            </button>
            {okResult && testedUrl && (
              <button
                type="button"
                onClick={() => void save(choice, testedUrl)}
                disabled={!!busy || envLocked}
                className={BTN.primary}
              >
                {busy === "save" && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Use this one
              </button>
            )}
          </div>
        </form>
      )}

      {choice === "none" && (
        <div className="space-y-3 text-[13px]">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <span className="font-semibold">Easiest:</span> in the Adrift
              folder, run the installer with ComfyUI (about 6 GB), then start
              Adrift again with{" "}
              <code className="font-mono text-[12px]">./adrift</code> (Windows:{" "}
              <code className="font-mono text-[12px]">adrift.cmd</code>).
              <div className="mt-1.5 space-y-1.5">
                <CommandBox
                  id="install-comfy"
                  text="./install.sh --install-comfy"
                  copied={copied}
                  onCopy={copy}
                />
                <CommandBox
                  id="install-comfy-win"
                  text="install.cmd -InstallComfy"
                  copied={copied}
                  onCopy={copy}
                  label="Copy the Windows command"
                />
              </div>
            </li>
            <li>
              <span className="font-semibold">Or</span> install{" "}
              <a
                href="https://www.comfy.org/download"
                target="_blank"
                rel="noreferrer noopener"
                className="text-splash underline underline-offset-2"
              >
                ComfyUI Desktop
              </a>{" "}
              (Windows, Mac) or the Windows{" "}
              <a
                href="https://github.com/comfyanonymous/ComfyUI/releases"
                target="_blank"
                rel="noreferrer noopener"
                className="text-splash underline underline-offset-2"
              >
                portable build
              </a>
              , start it, then pick &ldquo;This computer&rdquo;.
            </li>
          </ol>
          <p className={`text-[12px] ${MUTED}`}>
            No GPU handy? You can still browse Explore and Styles. Creating
            needs ComfyUI.
          </p>
          <button
            type="button"
            onClick={onContinueWithout}
            className={BTN.secondary}
          >
            Continue without it
          </button>
        </div>
      )}

      {/* Errors sit next to the buttons that caused them, not below the
          optional sections. */}
      {error && (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {choice !== "none" && (
        <details className="rounded-xl border border-light-100 p-3 text-[13px] dark:border-dark-750">
          <summary className="flex min-h-[32px] cursor-pointer items-center font-semibold">
            I know what I&apos;m doing
          </summary>
          <AdvancedForm
            disabled={!!busy || envLocked}
            onSave={async (mode, target, tok, acknowledged) => {
              setToken(tok);
              setBusy("save");
              setError(null);
              setAdvError(null);
              setSavedWarning(null);
              const r = await saveConnection({
                url: target,
                mode,
                token: tok || undefined,
                keepToken: !tok,
              });
              setBusy(null);
              if (!r.ok) return setAdvError(r.error ?? "Couldn't save.");
              await onSaved();
              // The server is the authority: a warning nobody agreed to
              // keeps the user here until they read it.
              if (r.warning && !acknowledged) return setSavedWarning(r.warning);
              onNext();
            }}
          />
          {advError && (
            <p
              role="alert"
              className="mt-2 text-[13px] text-red-600 dark:text-red-400"
            >
              {advError}
            </p>
          )}
        </details>
      )}

      {status?.reachable && (
        <details
          className="rounded-xl border border-light-100 p-3 text-[13px] dark:border-dark-750"
          onToggle={(e) => setMoreOpen(e.currentTarget.open)}
        >
          <summary className="flex min-h-[32px] cursor-pointer items-center font-semibold">
            Add another machine (optional)
          </summary>
          <p className={`mb-2 mt-1 text-[12px] ${MUTED}`}>
            Got a second computer with ComfyUI? Add it and Adrift sends each job
            to whichever machine is free. You can do this later in Settings.
          </p>
          {moreOpen && <ComfyInstancesSettings compact />}
        </details>
      )}

      {status?.reachable && (
        <details
          className="rounded-xl border border-light-100 p-3 text-[13px] dark:border-dark-750"
          onToggle={(e) => setOverlayOpen(e.currentTarget.open)}
          data-testid="connect-overlay-install"
        >
          <summary className="flex min-h-[32px] cursor-pointer items-center font-semibold">
            Add Adrift to ComfyUI (optional)
          </summary>
          {overlayOpen && <OverlayInstallCard />}
        </details>
      )}

      {savedWarning && (
        <div className="space-y-2">
          <p
            role="alert"
            className="text-[12px] text-amber-700 dark:text-amber-300"
          >
            Saved, but: {savedWarning}
          </p>
          <button type="button" onClick={onNext} className={BTN.secondary}>
            I understand, continue
          </button>
        </div>
      )}
    </div>
  );
}

function AdvancedForm({
  disabled,
  onSave,
}: {
  disabled: boolean;
  onSave: (
    mode: ConnectionMode,
    url: string,
    token: string,
    acknowledged: boolean,
  ) => Promise<void>;
}) {
  const [mode, setMode] = useState<ConnectionMode>("lan");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [ack, setAck] = useState(false);
  const warning = insecureUrlWarning(url, mode);
  const blocked = !!warning && !ack;
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        void onSave(mode, url, token, !!warning && ack);
      }}
    >
      <p className={`text-[12px] ${MUTED}`}>
        Save any ComfyUI URL without testing it. The browser&apos;s live
        progress socket follows it (unless NEXT_PUBLIC_COMFY_WS_BASE is set).
      </p>
      <div className="flex gap-2">
        <select
          aria-label="Kind of address"
          className={`${INPUT} w-auto`}
          value={mode}
          onChange={(e) => setMode(e.target.value as ConnectionMode)}
        >
          <option value="local">Local</option>
          <option value="lan">Network</option>
          <option value="wan">Internet</option>
        </select>
        <input
          aria-label="ComfyUI URL"
          className={INPUT}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://host:8188"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          required
        />
      </div>
      <input
        aria-label="Bearer token (optional)"
        className={INPUT}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Bearer token (optional)"
        autoComplete="off"
      />
      {warning && (
        <div
          role="note"
          className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-800 dark:text-amber-200"
        >
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {warning}
          </p>
          <label className="flex min-h-[32px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="h-4 w-4 accent-splash"
            />
            I understand, save it anyway
          </label>
        </div>
      )}
      <button
        type="submit"
        disabled={disabled || !url.trim() || blocked}
        className={BTN.secondary}
      >
        Save without testing
      </button>
    </form>
  );
}
