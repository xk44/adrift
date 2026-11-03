"use client";

/**
 * Small "Import from ComfyUI" control: pulls finished jobs from ComfyUI's
 * /history into the Adrift job list (server dedupes by prompt_id).
 */
import { useState } from "react";

type ImportResult = {
  ok?: boolean;
  error?: string;
  imported?: number;
  skipped_existing?: number;
  skipped_unusable?: number;
};

export function ComfyHistoryImport({
  onImported,
}: {
  onImported?: () => void | Promise<void>;
}) {
  const [maxItems, setMaxItems] = useState(50);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/jobs/import-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_items: maxItems }),
      });
      const data = (await res.json().catch(() => ({}))) as ImportResult;
      if (!res.ok || !data.ok) {
        setStatus(data.error ?? `Import failed (${res.status})`);
        return;
      }
      const imported = data.imported ?? 0;
      const existing = data.skipped_existing ?? 0;
      const unusable = data.skipped_unusable ?? 0;
      setStatus(
        `Imported ${imported}` +
          (existing ? ` · ${existing} already here` : "") +
          (unusable ? ` · ${unusable} without saved outputs` : ""),
      );
      if (imported > 0) await onImported?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-[var(--text-tertiary)]">
      <label className="flex items-center gap-1">
        <span>Last</span>
        <input
          type="number"
          min={1}
          max={200}
          value={maxItems}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            setMaxItems(Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 50);
          }}
          className="h-7 w-16 rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[var(--text-secondary)]"
          aria-label="Number of ComfyUI history items to import"
        />
      </label>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title="Import finished jobs from ComfyUI's history (read-only)"
        className="h-7 rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Importing…" : "Import from ComfyUI"}
      </button>
      {status && <span role="status">{status}</span>}
    </div>
  );
}
