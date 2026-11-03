"use client";

/**
 * Post-render QC verdict for one video output: a pass / warn / fail chip
 * (hover title lists issues with timestamps), click for the issue list and
 * Re-roll (whole clip, or only the bad source clip of a stitched video).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Loader2, RefreshCw, X } from "lucide-react";
import { showToast } from "@/components/Toast";
import { useGenerationStore } from "@/store";
import { fmtTime, type QcIssue } from "@/lib/videoQc/qc";
import type { JobQc, StoredOutputQc } from "@/lib/videoQc/server";
import type { ImagineRun } from "@/types";

interface QcBadgeProps {
  jobId: string;
  videoUrl: string;
  /** Queue a QC pass when the video has none yet (off for history tiles). */
  kick?: boolean;
  className?: string;
}

const POLL_MS = 4000;
const MAX_POLLS = 90;

/** Same key as the server's outputKey(), from a /api/comfy/image or /view URL. */
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

function issueLine(i: QcIssue): string {
  const at =
    typeof i.start === "number"
      ? typeof i.end === "number" && i.end - i.start >= 0.05
        ? `${fmtTime(i.start)}–${fmtTime(i.end)} `
        : `${fmtTime(i.start)} `
      : "";
  return `${at}${i.message}`;
}

const STYLE = {
  pass: "bg-[var(--success)] text-white",
  warn: "bg-amber-500 text-black",
  fail: "bg-red-600 text-white",
  pending: "bg-black/60 text-white",
} as const;

export function QcBadge({
  jobId,
  videoUrl,
  kick = true,
  className = "",
}: QcBadgeProps) {
  const [qc, setQc] = useState<JobQc | null>(null);
  const [running, setRunning] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"whole" | "segment" | "recheck" | null>(
    null,
  );
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const key = outputKeyOf(videoUrl);
  const result: StoredOutputQc | undefined = key
    ? qc?.outputs?.[key]
    : undefined;

  const load = useCallback(
    async (withKick: boolean) => {
      const q = new URLSearchParams({ job_id: jobId, video: videoUrl });
      if (!withKick) q.set("kick", "0");
      const res = await fetch(`/api/jobs/qc?${q}`);
      if (!res.ok) return null;
      const d = (await res.json()) as {
        qc: JobQc | null;
        running: boolean;
        enabled: boolean;
      };
      setQc(d.qc);
      setRunning(d.running);
      setEnabled(d.enabled);
      return d;
    },
    [jobId, videoUrl],
  );

  useEffect(() => {
    if (!key) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (first: boolean) => {
      const d = await load(kick && first).catch(() => null);
      if (!live || !kick || !d?.enabled) return;
      const done = Boolean(d.qc?.outputs?.[key]) && !d.running;
      if (done || d.qc?.status === "error" || ++polls > MAX_POLLS) return;
      timer = setTimeout(() => void tick(false), POLL_MS);
    };
    void tick(true);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, kick, load]);

  useEffect(() => {
    if (!open) return;
    const r = chipRef.current?.getBoundingClientRect();
    if (r) {
      const width = 288;
      setPos({
        top: r.bottom + 6,
        left: Math.max(
          8,
          Math.min(r.right - width, window.innerWidth - width - 8),
        ),
      });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !chipRef.current?.contains(t))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!key || !enabled) return null;
  if (!result && !running && !kick) return null;

  const status = result?.status ?? "pending";
  const issues = result?.issues ?? [];
  const title =
    status === "pending"
      ? "Video QC: checking…"
      : issues.length === 0
        ? "Video QC: no problems found"
        : `Video QC ${status}:\n${issues.map(issueLine).join("\n")}`;

  const reroll = async (segment: boolean) => {
    setBusy(segment ? "segment" : "whole");
    try {
      const res = await fetch("/api/jobs/qc/reroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, client_id: clientId, segment }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        run?: ImagineRun;
        segment?: number;
      };
      if (!res.ok || !d.ok || !d.run)
        throw new Error(d.error ?? `HTTP ${res.status}`);
      addRun(d.run);
      showToast(
        typeof d.segment === "number"
          ? `Re-rolling clip ${d.segment + 1} with a new seed.`
          : "Re-rolling with a new seed.",
        "success",
      );
      setOpen(false);
      void load(false);
    } catch (e) {
      showToast(
        `Couldn't re-roll: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const recheck = async () => {
    setBusy("recheck");
    try {
      const res = await fetch("/api/jobs/qc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, video: videoUrl, force: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRunning(true);
      for (let n = 0; n < MAX_POLLS; n++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const d = await load(false);
        if (!d?.running) break;
      }
    } catch (e) {
      showToast(
        `Couldn't re-check: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const Icon =
    status === "pass"
      ? Check
      : status === "pending"
        ? Loader2
        : status === "fail"
          ? X
          : AlertTriangle;
  const rerolls = qc?.rerolls ?? [];

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        data-testid="qc-badge"
        data-qc-status={status}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none shadow ${STYLE[status]} ${className}`}
      >
        <Icon
          className={`h-3 w-3 ${status === "pending" ? "animate-spin" : ""}`}
          aria-hidden
        />
        QC
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Video QC"
            onClick={(e) => e.stopPropagation()}
            style={{ top: pos.top, left: pos.left, width: 288 }}
            className="fixed z-[200] space-y-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-3 text-xs text-[var(--text-primary)] shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                Video QC:{" "}
                {status === "pending"
                  ? "checking…"
                  : status === "pass"
                    ? "pass"
                    : status === "warn"
                      ? "warnings"
                      : "failed"}
              </span>
              {qc && qc.attempt > 1 && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  try {qc.attempt}
                </span>
              )}
            </div>
            {issues.length > 0 ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {issues.map((i, n) => (
                  <li key={n} className="flex gap-1.5">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${i.severity === "fail" ? "bg-red-600" : "bg-amber-500"}`}
                      aria-hidden
                    />
                    <span>{issueLine(i)}</span>
                  </li>
                ))}
              </ul>
            ) : status === "pass" ? (
              <p className="text-[var(--text-muted)]">No problems found.</p>
            ) : null}
            {qc?.error && (
              <p className="text-[10px] text-red-500">{qc.error}</p>
            )}
            {rerolls.length > 0 && (
              <p className="text-[10px] text-[var(--text-muted)]">
                Re-rolled {rerolls.length}×
                {rerolls.some((r) => r.auto) ? " (auto)" : ""}; new takes appear
                as their own runs.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void reroll(false)}
                className="flex items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2 py-1 font-medium text-white disabled:opacity-50"
              >
                {busy === "whole" ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3 w-3" aria-hidden />
                )}
                Re-roll
              </button>
              {typeof result?.segment === "number" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void reroll(true)}
                  className="flex items-center gap-1 rounded-md border border-[var(--border-secondary)] px-2 py-1 font-medium disabled:opacity-50"
                >
                  {busy === "segment" && (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  )}
                  Re-roll clip {result.segment + 1}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null || running}
                onClick={() => void recheck()}
                className="rounded-md border border-[var(--border-secondary)] px-2 py-1 disabled:opacity-50"
              >
                {busy === "recheck" ? "Checking…" : "Re-check"}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
