"use client";

/**
 * Account settings card: how long the video editor's saved projects keep
 * their uploaded clips safe from the work-dir sweep (server setting, default
 * forever), plus a by-hand "release projects not opened in N days".
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { showToast } from "@/components/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";

type KeepDays = null | 30 | 90 | 365;

const KEEP_OPTIONS: { value: KeepDays; label: string }[] = [
  { value: null, label: "Forever" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
];
const RELEASE_OPTIONS = [30, 90, 365] as const;

interface Status {
  keepDays: KeepDays;
  projects: number;
  oldestAt: number | null;
}

const API = "/api/settings/video-edit";

async function call(method: string, body?: unknown) {
  const res = await fetch(API, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false)
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  return data;
}

const selectCls =
  "rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";

export function VideoEditStorageSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [releaseDays, setReleaseDays] = useState<number>(90);
  const [releasing, setReleasing] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const d = await call("GET");
      setStatus({
        keepDays: (d.keepDays as KeepDays) ?? null,
        projects: typeof d.projects === "number" ? d.projects : 0,
        oldestAt: typeof d.oldestAt === "number" ? d.oldestAt : null,
      });
    } catch {
      showToast("Couldn't load the video editor storage setting.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKeep = async (keepDays: KeepDays) => {
    setSaving(true);
    try {
      await call("PUT", { keepDays });
      setStatus((s) => (s ? { ...s, keepDays } : s));
    } catch (e) {
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const release = async () => {
    const ok = await confirm({
      title: `Release projects not opened in ${releaseDays} days?`,
      message:
        "Their uploaded clips stay on disk for now, but may be removed when the video work folder runs out of room. Opening such a project again re-protects whatever is still there.",
      confirmLabel: "Release",
      danger: true,
    });
    if (!ok) return;
    setReleasing(true);
    try {
      const d = await call("POST", { releaseOlderThanDays: releaseDays });
      const n = typeof d.released === "number" ? d.released : 0;
      showToast(
        n === 0
          ? "No projects that old."
          : `Released ${n} project${n === 1 ? "" : "s"}.`,
        "success",
      );
      void load();
    } catch (e) {
      showToast(
        `Couldn't clean up: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setReleasing(false);
    }
  };

  const oldest =
    status?.oldestAt != null
      ? new Date(status.oldestAt).toLocaleDateString()
      : null;

  return (
    <div className="space-y-4" data-testid="video-edit-storage-settings">
      {confirmDialog}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="video-keep-days"
            className="text-xs font-medium text-[var(--text-primary)]"
          >
            Keep uploads for saved projects
          </label>
          <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
            Clips you upload into a video project are never cleaned up while the
            project is saved. With a time limit, a project not opened for that
            long stops protecting its clips.
          </p>
        </div>
        <select
          id="video-keep-days"
          className={selectCls}
          disabled={!status || saving}
          value={status?.keepDays == null ? "" : String(status.keepDays)}
          onChange={(e) =>
            void saveKeep(
              e.target.value === ""
                ? null
                : (Number(e.target.value) as KeepDays),
            )
          }
        >
          {KEEP_OPTIONS.map((o) => (
            <option key={o.label} value={o.value == null ? "" : o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <p className="text-[10px] text-[var(--text-muted)]">
          {status == null
            ? "Loading…"
            : status.projects === 0
              ? "No saved projects are protecting uploads."
              : `${status.projects} saved project${status.projects === 1 ? "" : "s"} protecting uploads${oldest ? `; least recently opened ${oldest}` : ""}.`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="video-release-days"
            className="text-xs text-[var(--text-primary)]"
          >
            Release projects not opened in
          </label>
          <select
            id="video-release-days"
            className={selectCls}
            value={releaseDays}
            onChange={(e) => setReleaseDays(Number(e.target.value))}
          >
            {RELEASE_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d === 365 ? "1 year" : `${d} days`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void release()}
            disabled={releasing || !status || status.projects === 0}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--border-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96] disabled:opacity-40"
          >
            {releasing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Clean up now
          </button>
        </div>
      </div>
    </div>
  );
}

export default VideoEditStorageSettings;
