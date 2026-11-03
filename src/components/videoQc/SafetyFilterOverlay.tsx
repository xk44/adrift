"use client";

/**
 * Ideogram 4 safety-filter state for one image tile: when the server found
 * the output is a blank canvas, cover it with an explanation instead of a
 * silent flat tile, show the automatic re-roll, and offer a manual Re-roll.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { showToast } from "@/components/Toast";
import { useGenerationStore } from "@/store";
import {
  recentRunToImagineRun,
  type RecentHistoryRun,
} from "@/lib/historyHydration";
import { blankCheckSettled, SAFETY_FILTER_MESSAGE } from "@/lib/imageQc/blank";
import type { JobQc } from "@/lib/videoQc/server";
import type { ImagineRun } from "@/types";

interface Props {
  jobId: string;
  imageUrl: string;
  /** Run the check when the image has none yet (off for history tiles). */
  kick?: boolean;
}

const POLL_MS = 3000;
const MAX_POLLS = 60;

function outputKeyOf(url: string): string | null {
  try {
    const u = new URL(url, "http://local.invalid");
    const filename = u.searchParams.get("filename");
    if (!filename) return null;
    const subfolder = u.searchParams.get("subfolder") ?? "";
    const type = u.searchParams.get("type") ?? "output";
    return `${type}/${subfolder ? `${subfolder}/` : ""}${filename}`;
  } catch {
    return null;
  }
}

export function SafetyFilterOverlay({ jobId, imageUrl, kick = true }: Props) {
  const [qc, setQc] = useState<JobQc | null>(null);
  const [busy, setBusy] = useState(false);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const key = outputKeyOf(imageUrl);
  const hydrated = useRef(new Set<string>());

  const load = useCallback(
    async (withKick: boolean) => {
      const q = new URLSearchParams({ job_id: jobId, image: imageUrl });
      if (!withKick) q.set("kick", "0");
      const res = await fetch(`/api/jobs/qc/blank?${q}`);
      if (!res.ok) return null;
      const d = (await res.json()) as { qc: JobQc | null };
      setQc(d.qc);
      return d.qc;
    },
    [jobId, imageUrl],
  );

  useEffect(() => {
    if (!key) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (first: boolean) => {
      const next = await load(kick && first).catch(() => null);
      if (!live || !kick) return;
      if (blankCheckSettled(next, key) || ++polls > MAX_POLLS) return;
      timer = setTimeout(() => void tick(false), POLL_MS);
    };
    void tick(true);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, kick, load]);

  // The server queues the automatic re-roll; pull it into the feed so it
  // renders live like any other run.
  useEffect(() => {
    if (!kick) return;
    for (const r of qc?.rerolls ?? []) {
      if (!r.auto || hydrated.current.has(r.runId)) continue;
      hydrated.current.add(r.runId);
      if (useGenerationStore.getState().runs.some((x) => x.run_id === r.runId))
        continue;
      void fetch(`/api/jobs/recent?run_id=${encodeURIComponent(r.runId)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((d: { runs?: RecentHistoryRun[] } | null) => {
          const run = d?.runs?.find((x) => x.run_id === r.runId);
          if (!run) return;
          const { historySource: _h, ...rest } = recentRunToImagineRun(run);
          void _h;
          addRun(rest);
        })
        .catch(() => {});
    }
  }, [qc, kick, addRun]);

  const out = key ? qc?.outputs?.[key] : undefined;
  if (!out?.issues.some((i) => i.kind === "safety_filter")) return null;

  const rerolls = qc?.rerolls ?? [];
  const autoRerolled = rerolls.some((r) => r.auto);
  const note =
    qc!.attempt > 1
      ? "This re-roll was blocked too."
      : autoRerolled
        ? "Re-rolled once with a new seed."
        : qc?.error
          ? qc.error
          : null;

  const reroll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      const res = await fetch("/api/jobs/qc/reroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, client_id: clientId }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        run?: ImagineRun;
      };
      if (!res.ok || !d.ok || !d.run)
        throw new Error(d.error ?? `HTTP ${res.status}`);
      addRun(d.run);
      showToast("Re-rolling with a new seed.", "success");
      void load(false);
    } catch (err) {
      showToast(
        `Couldn't re-roll: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="safety-filter-overlay"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-tertiary)] p-3 text-center text-[var(--text-primary)]"
    >
      <ShieldAlert className="h-6 w-6 text-amber-500" aria-hidden />
      <span className="text-xs font-semibold">{SAFETY_FILTER_MESSAGE}</span>
      {note && (
        <span className="text-[10px] text-[var(--text-muted)]">{note}</span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={(e) => void reroll(e)}
        className="mt-1 flex items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="h-3 w-3" aria-hidden />
        )}
        Re-roll
      </button>
    </div>
  );
}
