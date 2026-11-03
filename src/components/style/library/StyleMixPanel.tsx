"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Blend,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyCheck,
  Loader2,
  Search,
  XCircle,
} from "lucide-react";
import { normalizeStyleSearch } from "@/lib/sref/vaultShapes";
import {
  svFetch,
  svPost,
  useLatestRequest,
  type SVMixResult,
  type SVStyle,
} from "./shared";

// Mix makes a new style code, so it only shows with STYLE_CODES_ENABLED on.

function StylePickerInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SVStyle | null;
  onChange: (s: SVStyle | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SVStyle[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const req = useLatestRequest();
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback((q: string) => {
    setQuery(q);
    const g = req.next();
    req.cancelDebounce();
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      setSearching(false);
      return;
    }
    setOpen(true);
    req.debounce(async () => {
      setSearching(true);
      try {
        const data = await svFetch<unknown>(
          `styles/search?query=${encodeURIComponent(q)}&limit=20`,
        );
        if (req.isCurrent(g)) setResults(normalizeStyleSearch(data));
      } catch {
        if (req.isCurrent(g)) setResults([]);
      } finally {
        if (req.isCurrent(g)) setSearching(false);
      }
    }, 300);
  }, [req]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const select = (s: SVStyle) => {
    onChange(s);
    setQuery(s.style_name ?? `Style ${s.id}`);
    setOpen(false);
    setResults([]);
  };

  const clear = () => {
    onChange(null);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5 min-w-0 flex-1" ref={containerRef}>
      <label className="text-[11px] font-medium text-light-400 dark:text-dark-500">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-400 dark:text-dark-500" />
        <input
          type="text"
          aria-label={label}
          value={
            value && !query.length
              ? (value.style_name ?? `Style ${value.id}`)
              : query
          }
          onChange={(e) => {
            if (value) clear();
            search(e.target.value);
          }}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          placeholder="Search styles…"
          className="w-full rounded-xl border border-light-100 bg-light-input py-2 pl-8 pr-8 text-sm text-light-primary placeholder:text-light-400 transition-[border-color] duration-150 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-500"
        />
        {searching ? (
          <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-light-400" />
        ) : value ? (
          <button
            aria-label="Clear search"
            onClick={clear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-light-400 transition-[color] duration-150 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {/* Dropdown */}
        {open && results.length > 0 && (
          <div className="absolute top-full z-50 mt-1 w-full overflow-hidden rounded-xl border border-light-100 bg-light-bg shadow-panel dark:border-dark-750 dark:bg-dark-900 dark:shadow-panel-dark">
            <div className="microScrollbar max-h-48 overflow-y-auto py-1">
              {results.map((s) => (
                <button
                  key={s.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(s);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-[background-color] duration-100 hover:bg-light-50 dark:hover:bg-dark-800"
                >
                  <span className="flex-1 truncate text-sm text-light-primary dark:text-dark-primary">
                    {s.style_name ?? `Style ${s.id}`}
                  </span>
                  {s.codes && s.codes.length > 0 && (
                    <span className="flex-shrink-0 font-mono text-[10px] text-light-400 dark:text-dark-500">
                      {s.codes[0]}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Selected badge */}
      {value && (
        <div className="flex items-center gap-1.5 rounded-lg bg-splash/8 px-2.5 py-1">
          <span className="truncate text-xs font-medium text-splash">
            {value.style_name ?? `Style ${value.id}`}
          </span>
          {value.codes && value.codes.length > 0 && (
            <span className="flex-shrink-0 font-mono text-[10px] text-splash/70">
              {value.codes[0]}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function StyleMixPanel() {
  const [open, setOpen] = useState(false);
  const [styleA, setStyleA] = useState<SVStyle | null>(null);
  const [styleB, setStyleB] = useState<SVStyle | null>(null);
  const [weight, setWeight] = useState(0.5);
  const [name, setName] = useState("");
  const [mixing, setMixing] = useState(false);
  const [result, setResult] = useState<SVMixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canMix = styleA !== null && styleB !== null && !mixing;

  const handleMix = async () => {
    if (!canMix) return;
    setMixing(true);
    setResult(null);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        style_a_id: styleA.id,
        style_b_id: styleB.id,
        weight,
      };
      if (name.trim()) body.name = name.trim();
      const res = await svPost<SVMixResult>("styles/mix", body);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setMixing(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.style_code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const weightPct = Math.round(weight * 100);

  return (
    <div className="rounded-xl border border-light-100 bg-light-input shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
      {/* Collapsible header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-[background-color] duration-150 hover:bg-light-50 dark:hover:bg-dark-800 rounded-xl"
      >
        <Blend className="h-4 w-4 text-splash flex-shrink-0" />
        <span className="flex-1 text-[11px] font-medium text-light-400 dark:text-dark-500">
          Mix styles
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
        )}
      </button>

      {open && (
        <div className="border-t border-light-100 px-4 pb-4 pt-3 dark:border-dark-750 space-y-4">
          {/* Style pickers row */}
          <div className="flex flex-wrap gap-3">
            <StylePickerInput
              label="Style A"
              value={styleA}
              onChange={setStyleA}
            />
            <StylePickerInput
              label="Style B"
              value={styleB}
              onChange={setStyleB}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-light-400 dark:text-dark-500">
                Blend weight
              </label>
              <span className="font-mono text-[11px] text-light-500 dark:text-dark-400">
                {weightPct}% B
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex-shrink-0 text-[11px] text-light-400 dark:text-dark-500">
                More A
              </span>
              <input
                type="range"
                aria-label="Blend weight"
                min={0}
                max={1}
                step={0.01}
                value={weight}
                onChange={(e) => setWeight(parseFloat(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-light-100 accent-splash dark:bg-dark-700"
              />
              <span className="flex-shrink-0 text-[11px] text-light-400 dark:text-dark-500">
                More B
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-light-400 dark:text-dark-500">
              Result name{" "}
              <span className="normal-case font-normal">(optional)</span>
            </label>
            <input
              type="text"
              aria-label="Blend name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Blend"
              className="w-full rounded-xl border border-light-100 bg-light-bg px-3 py-2 text-sm text-light-primary placeholder:text-light-400 transition-[border-color] duration-150 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary dark:placeholder:text-dark-500"
            />
          </div>

          <button
            onClick={handleMix}
            disabled={!canMix}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-splash px-4 py-2.5 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {mixing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Blend className="h-4 w-4" />
            )}
            {mixing ? "Mixing…" : "Mix Styles"}
          </button>

          {error && (
            <div className="flex items-start gap-1.5 rounded-xl bg-red-500/8 px-3 py-2.5 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
                  {result.style_name ?? `Style #${result.style_node_id}`}
                </p>
                {result.cluster_id != null && (
                  <span className="ml-auto flex-shrink-0 rounded-full bg-light-50 px-2 py-0.5 text-[10px] text-light-500 dark:bg-dark-750 dark:text-dark-400">
                    cluster {result.cluster_id}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-light-bg px-3 py-1.5 font-mono text-sm text-light-primary dark:bg-dark-900 dark:text-dark-primary">
                  --sref {result.style_code}
                </code>
                <button
                  onClick={handleCopy}
                  className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
                >
                  {copied ? (
                    <CopyCheck className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied!" : "Copy Code"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

