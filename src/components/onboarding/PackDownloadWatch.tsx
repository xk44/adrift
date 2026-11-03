"use client";

/**
 * "Watch the download" panel under the starter-pack command. Progress comes
 * from Adrift's server (which asks ComfyUI), so it works the same when
 * ComfyUI runs on another computer or over the internet.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  watchPackProgress,
  type ProgressUpdate,
} from "@/lib/onboarding/packProgressClient";
import { progressView } from "@/lib/onboarding/packProgressView";
import { BTN, MUTED } from "./ui";

export function PackDownloadPanel({
  update,
  quietForMs,
}: {
  update: ProgressUpdate | null;
  quietForMs: number;
}) {
  const view = progressView(update?.progress ?? null, {
    lostContact: update?.lostContact,
    quietForMs,
  });
  if (!update)
    return (
      <p
        role="status"
        className={`flex items-center gap-2 text-[12px] ${MUTED}`}
      >
        <Loader2 className="h-4 w-4 animate-spin" /> Checking ComfyUI...
      </p>
    );
  return (
    <div role="status" aria-live="polite" className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
        {view.tone === "done" && <Check className="h-4 w-4 text-emerald-500" />}
        {view.title}
      </p>
      <div
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent ?? undefined}
        className="relative h-2 overflow-hidden rounded-full bg-light-100 dark:bg-dark-750"
      >
        {view.percent == null ? (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-splash/60" />
        ) : (
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${
              view.tone === "done" ? "bg-emerald-500" : "bg-splash"
            }`}
            style={{ width: `${view.percent}%` }}
          />
        )}
      </div>
      <p className={`text-[12px] ${MUTED}`}>{view.detail}</p>
    </div>
  );
}

export function PackDownloadWatch({
  packIds,
  onDone,
}: {
  packIds: string[];
  /** Called once when every file is in ComfyUI (e.g. reload the packs). */
  onDone?: () => void;
}) {
  const [watching, setWatching] = useState(false);
  const [update, setUpdate] = useState<ProgressUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastChange = useRef({ key: "", at: Date.now() });
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const idsKey = packIds.join(",");

  useEffect(() => {
    if (!watching || !idsKey) return;
    setUpdate(null);
    lastChange.current = { key: "", at: Date.now() };
    const stop = watchPackProgress(idsKey.split(","), (u) => {
      const p = u.progress;
      const key = p ? `${p.doneFiles}/${p.doneBytes}` : "";
      if (key !== lastChange.current.key)
        lastChange.current = { key, at: Date.now() };
      setUpdate(u);
      setNow(Date.now());
      if (p?.complete) onDoneRef.current?.();
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      stop();
      clearInterval(tick);
    };
  }, [watching, idsKey]);

  if (!watching)
    return (
      <button
        type="button"
        onClick={() => setWatching(true)}
        className={BTN.secondary}
      >
        I started it: show progress
      </button>
    );
  return (
    <PackDownloadPanel
      update={update}
      quietForMs={now - lastChange.current.at}
    />
  );
}
