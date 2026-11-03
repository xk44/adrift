"use client";

/**
 * Account settings card: live previews while an image renders (ComfyUI
 * `preview_method`, sent with every prompt). Server setting, default Auto.
 */

import { useEffect, useState } from "react";
import { showToast } from "@/components/Toast";
import type { PreviewMethod } from "@/lib/comfy/previewMethod";

const OPTIONS: { value: PreviewMethod; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "latent2rgb", label: "Fast (latent2rgb)" },
  { value: "none", label: "Off" },
];

const API = "/api/settings/previews";

const selectCls =
  "rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";

export function LivePreviewSettings() {
  const [method, setMethod] = useState<PreviewMethod | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(API)
      .then((r) => r.json())
      .then((d: { ok?: boolean; method?: PreviewMethod }) => {
        if (alive && d?.ok && d.method) setMethod(d.method);
      })
      .catch(() => {
        if (alive) showToast("Couldn't load the live preview setting.", "error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next: PreviewMethod) => {
    const prev = method;
    setMethod(next);
    setSaving(true);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: next }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || d.ok === false)
        throw new Error(typeof d.error === "string" ? d.error : `HTTP ${res.status}`);
    } catch (e) {
      setMethod(prev);
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex items-start justify-between gap-4"
      data-testid="live-preview-settings"
    >
      <div className="min-w-0 flex-1">
        <label
          htmlFor="live-preview-method"
          className="text-xs font-medium text-[var(--text-primary)]"
        >
          Live previews
        </label>
        <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
          Show the image sharpening in place while it renders. Auto uses the
          best decoder installed; Fast is a rough colour preview; Off sends
          none. Applies to new jobs.
        </p>
      </div>
      <select
        id="live-preview-method"
        className={selectCls}
        disabled={method == null || saving}
        value={method ?? "auto"}
        onChange={(e) => void save(e.target.value as PreviewMethod)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
