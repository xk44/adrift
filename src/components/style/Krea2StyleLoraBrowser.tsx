"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useUIStore } from "@/store";

interface StyleLoraItem {
  id: string;
  name: string;
  trigger: string;
  file: string;
  installed: boolean;
}

interface ListResponse {
  repo: string;
  total: number;
  count: number;
  query: string;
  loras: StyleLoraItem[];
  error?: string;
}

/**
 * Browser for the fal Krea-2-Style-LoRAs collection. Search the catalog,
 * download a style LoRA on demand, and drop `--lora <id>` into the prompt;
 * the trigger phrase auto-appends at generation time.
 */
export function Krea2StyleLoraBrowser({
  query: externalQuery,
  onRemix,
}: {
  /** Controlled search (Styles page shares one search box); hides the input. */
  query?: string;
  /** Open the style creator seeded with this LoRA. */
  onRemix?: (item: { id: string; name: string }) => void;
} = {}) {
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);

  const [ownQuery, setQuery] = useState("");
  const query = externalQuery ?? ownQuery;
  const [items, setItems] = useState<StyleLoraItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/krea2-style-loras?q=${encodeURIComponent(q)}&limit=60`,
        { signal: ac.signal },
      );
      const data: ListResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setItems(data.loras);
      setTotal(data.total);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      // An aborted request's finally runs while its replacement is still
      // loading — only the current request owns the spinner.
      if (abortRef.current === ac) setLoading(false);
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const t = setTimeout(() => fetchList(query), 200);
    return () => clearTimeout(t);
  }, [query, fetchList]);

  const applyStyle = useCallback(
    async (item: StyleLoraItem) => {
      setBusyId(item.id);
      setError(null);
      try {
        if (!item.installed) {
          const res = await fetch("/api/krea2-style-loras/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.id }),
          });
          const data = await res.json();
          if (!res.ok)
            throw new Error(
              data.error ?? `Download failed (HTTP ${res.status})`,
            );
          setItems((prev) =>
            prev.map((p) => (p.id === item.id ? { ...p, installed: true } : p)),
          );
        }
        // Full filename — the engine sets lora_name verbatim (no .safetensors
        // normalization); the trigger phrase auto-appends via getTriggersForLora.
        appendToPrompt(`--lora ${item.id}.safetensors`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [appendToPrompt],
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-fuchsia-400" />
        <h2 className="text-sm font-semibold">Krea 2 Style LoRAs</h2>
        <span className="text-xs text-[var(--text-muted)]">{total} styles</span>
      </div>
      {externalQuery === undefined && (
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search styles (e.g. watercolor, noir, fresco)…"
        className="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-fuchsia-500"
      />
      )}
      {error && items.length > 0 && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      {error && items.length === 0 && !loading ? (
        // Optional catalog: degrade to one quiet line, not a raw HTTP error.
        <p
          className="rounded-md border border-dashed border-[var(--border-primary)] px-3 py-4 text-sm text-[var(--text-muted)]"
          data-testid="krea2-loras-unavailable"
        >
          The Style LoRA list isn&apos;t available right now.
        </p>
      ) : loading && items.length === 0 ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <div key={item.id} className="flex min-w-0 items-stretch gap-1">
            <button
              onClick={() => applyStyle(item)}
              disabled={busyId === item.id}
              title={`Trigger: ${item.trigger}`}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-left text-[var(--text-primary)] transition hover:border-fuchsia-600 hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm">{item.name}</span>
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  {item.trigger}
                </span>
              </span>
              {busyId === item.id ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
              ) : item.installed ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <Download className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              )}
            </button>
            {onRemix && (
              <button
                type="button"
                onClick={() => onRemix(item)}
                title="Make a style from this LoRA"
                aria-label={`Remix ${item.name}`}
                className="flex shrink-0 items-center rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[var(--text-secondary)] transition hover:border-fuchsia-600 hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500"
              >
                <Wand2 className="h-3.5 w-3.5" />
              </button>
            )}
            </div>
          ))}
          {!loading && items.length === 0 && (
            <p className="col-span-full py-8 text-center text-sm text-[var(--text-muted)]">
              No styles match “{query}”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
