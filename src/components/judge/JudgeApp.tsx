"use client";

/**
 * Judge studio: the Tools hub limited to the contest allowlist, the judge's
 * remaining runs, a queued banner while the single GPU slot is busy, and the
 * judge's own outputs (nothing else from this machine is reachable).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ToolsPage } from "@/components/tools/ToolsPage";
import { installJudgeFetch, useJudgeQueue } from "./judgeQueue";

interface JudgeStatus {
  used: number;
  quota: number;
  remaining: number;
  paused: boolean;
  queue: { busy: boolean; mine: boolean; position: number };
  cards: string[];
  outputs: { url: string; kind: string; promptId: string; at: number }[];
}

const POLL_MS = 10_000;

export function JudgeApp() {
  const [status, setStatus] = useState<JudgeStatus | null>(null);
  const queued = useJudgeQueue((s) => s.queued);
  const position = useJudgeQueue((s) => s.position);

  useEffect(() => installJudgeFetch(), []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/judge/status", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as JudgeStatus);
    } catch {
      /* keep the last status */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const allowKeys = useMemo(
    () => (status ? new Set(status.cards) : null),
    [status],
  );

  return (
    <main className="min-h-screen bg-light-bg text-light-primary dark:bg-dark-bg dark:text-dark-primary">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
        <span className="font-medium">Adrift preview</span>
        <span className="text-light-500 dark:text-dark-400">
          LTX VFX workflows on open weights, one GPU, one run at a time.
        </span>
        {status && (
          <span
            className="ml-auto rounded-full px-3 py-1 text-xs shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
            data-testid="judge-remaining"
          >
            {status.remaining} of {status.quota} runs left
          </span>
        )}
      </header>
      {status?.paused && (
        <p
          role="status"
          className="mx-4 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100"
        >
          The GPU is taking a short break. Runs will open again soon.
        </p>
      )}
      {queued && (
        <p
          role="status"
          aria-live="polite"
          data-testid="judge-queued"
          className="mx-4 rounded-lg bg-sky-100 px-3 py-2 text-sm text-sky-900 dark:bg-sky-900/30 dark:text-sky-100"
        >
          Queued: another run is on the GPU ({position === 1
            ? "you are next"
            : `position ${position}`}). Your run starts automatically.
        </p>
      )}
      {allowKeys ? (
        <ToolsPage allowKeys={allowKeys} />
      ) : (
        <p className="px-4 py-8 text-sm">Loading…</p>
      )}
      {status && status.outputs.length > 0 && (
        <section className="px-4 py-6" aria-label="Your outputs">
          <h2 className="mb-3 text-sm font-medium">Your outputs</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {status.outputs.map((o) => (
              <li key={`${o.promptId}:${o.url}`}>
                {o.kind === "video" ? (
                  <video
                    src={o.url}
                    controls
                    playsInline
                    className="w-full rounded-lg"
                  />
                ) : o.kind === "audio" ? (
                  <audio src={o.url} controls className="w-full" />
                ) : o.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={o.url}
                    alt="Your output"
                    loading="lazy"
                    className="w-full rounded-lg"
                  />
                ) : (
                  <a href={o.url} className="text-xs underline">
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
