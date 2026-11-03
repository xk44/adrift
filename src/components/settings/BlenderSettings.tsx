"use client";

/**
 * Settings card: which Blender "Open in Blender" and the USDZ export use.
 * Shows what was detected and lets the user save a path; BLENDER_PATH in
 * the environment still wins.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { showToast } from "@/components/Toast";

const API = "/api/settings/blender";

export interface BlenderSettingsStatus {
  path: string | null;
  version?: string;
  source: "env" | "settings" | "auto" | "none";
  missing?: { source: "env" | "settings"; path: string };
  hint?: string;
  saved: string | null;
  envPath: string | null;
}

const SOURCE_LABEL: Record<BlenderSettingsStatus["source"], string> = {
  env: "from BLENDER_PATH",
  settings: "from Settings",
  auto: "auto-detected",
  none: "",
};

/** One-line summary of the detected Blender. */
export function blenderStatusLine(s: BlenderSettingsStatus): string {
  if (!s.path) return "Blender not found. Install it, or set its path below.";
  const name = s.version ? `Blender ${s.version}` : "Blender";
  return `${name} at ${s.path} (${SOURCE_LABEL[s.source]})`;
}

const inputCls =
  "w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-splash";
const btnCls =
  "flex items-center gap-1.5 rounded-xl border border-[var(--border-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96] disabled:opacity-40";

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
  return data as unknown as BlenderSettingsStatus;
}

export function BlenderSettings() {
  const [status, setStatus] = useState<BlenderSettingsStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    call("GET")
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setDraft(s.saved ?? "");
      })
      .catch(() => {
        if (alive) showToast("Couldn't load the Blender setting.", "error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (path: string | null) => {
    setSaving(true);
    try {
      const s = await call("PUT", { path });
      setStatus(s);
      setDraft(s.saved ?? "");
      showToast(
        path ? "Blender path saved." : "Blender path cleared.",
        "success",
      );
    } catch (e) {
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (!status)
    return (
      <p className="text-xs text-[var(--text-muted)]">Checking for Blender…</p>
    );

  return (
    <div className="space-y-3" data-testid="blender-settings">
      <p
        className={`text-xs break-all ${
          status.path ? "text-[var(--text-primary)]" : "text-amber-500"
        }`}
      >
        {blenderStatusLine(status)}
      </p>
      {status.missing && (
        <p className="text-[10px] break-all text-amber-500">
          {status.missing.source === "env" ? "BLENDER_PATH" : "Saved path"}{" "}
          points to a missing file: {status.missing.path}
        </p>
      )}
      {status.hint && (
        <p className="text-[10px] text-[var(--text-muted)]">{status.hint}</p>
      )}
      <label className="block space-y-1">
        <span className="text-[10px] text-[var(--text-muted)]">
          Blender path (leave empty to auto-detect)
        </span>
        <input
          className={inputCls}
          value={draft}
          placeholder={
            status.source === "auto" && status.path
              ? status.path
              : "/path/to/blender"
          }
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </label>
      {status.envPath && (
        <p className="text-[10px] break-all text-[var(--text-muted)]">
          BLENDER_PATH is set ({status.envPath}) and wins over this field.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnCls}
          onClick={() => void save(draft.trim() || null)}
          disabled={saving || draft.trim() === (status.saved ?? "")}
        >
          {saving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Save
        </button>
        {status.saved && (
          <button
            type="button"
            className={btnCls}
            onClick={() => void save(null)}
            disabled={saving}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export default BlenderSettings;
