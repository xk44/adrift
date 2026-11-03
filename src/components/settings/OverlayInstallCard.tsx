"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { CopyCommand } from "@/components/setup/CopyCommand";
import {
  overlayInstallView,
  type OverlayInstallStatus,
} from "@/lib/overlay/installView";

const API = "/api/setup/overlay";
const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const BTN =
  "inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium disabled:opacity-50";
const PRIMARY = `${BTN} bg-splash text-white hover:bg-splash/90`;
const SECONDARY = `${BTN} border border-[var(--border-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`;
const MUTED = "text-[11px] text-pretty text-[var(--text-muted)]";

type Reply = { ok: boolean; status?: OverlayInstallStatus; error?: string };

async function call(method: "GET" | "POST"): Promise<Reply> {
  try {
    const res = await fetch(API, { method, cache: "no-store", headers: HEADERS });
    const data = (await res.json().catch(() => ({}))) as Reply;
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Sign in as admin to set this up." };
    if (!res.ok || data.ok === false)
      return { ...data, ok: false, error: data.error ?? `Server answered HTTP ${res.status}` };
    return { ...data, ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

/**
 * "Add Adrift to ComfyUI": installs the overlay pack into a ComfyUI on this
 * machine (or shows the steps for another machine), then asks for a ComfyUI
 * restart and a "Check again".
 */
export function OverlayInstallCard() {
  const [status, setStatus] = useState<OverlayInstallStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>("check");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (method: "GET" | "POST") => {
    setBusy(method === "GET" ? "check" : "install");
    setError(null);
    const r = await call(method);
    if (r.status) setStatus(r.status);
    if (!r.ok) setError(r.error ?? "Something went wrong.");
    setBusy(null);
  }, []);

  useEffect(() => {
    void run("GET");
  }, [run]);

  const view = status ? overlayInstallView(status) : null;

  const checkAgain = (
    <button
      type="button"
      onClick={() => void run("GET")}
      disabled={busy !== null}
      className={SECONDARY}
      data-testid="overlay-install-check"
    >
      {busy === "check" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      )}
      Check again
    </button>
  );
  const install = (label: string) => (
    <button
      type="button"
      onClick={() => void run("POST")}
      disabled={busy !== null}
      className={PRIMARY}
      data-testid="overlay-install-add"
    >
      {busy === "install" && (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      )}
      {label}
    </button>
  );

  return (
    <div className="space-y-2" data-testid="overlay-install-card">
      {!view && !error && <p className={MUTED}>Checking…</p>}
      {view && (
        <p className="text-[12px] text-pretty text-[var(--text-primary)]">
          {view.kind === "done" && (
            <CheckCircle2
              className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-[var(--success)]"
              aria-hidden
            />
          )}
          {view.text}
        </p>
      )}
      {view?.kind === "remote" && (
        <CopyCommand label="Add Adrift to ComfyUI" command={view.steps} />
      )}
      {(view?.kind === "restart" || view?.kind === "done") && view.urlStale && (
        <p className={MUTED}>
          It points at {status?.configUrl ?? "the default address"}; you are
          using {status?.adriftUrl}.
        </p>
      )}
      {status && !status.frameAllowed && (
        <p className={MUTED}>
          Restart Adrift so ComfyUI at {status.comfyUrl} is allowed to show it.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {view?.kind === "install" && install("Add Adrift to ComfyUI")}
        {(view?.kind === "restart" || view?.kind === "done") &&
          view.urlStale &&
          install("Use this address")}
        {checkAgain}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export default OverlayInstallCard;
