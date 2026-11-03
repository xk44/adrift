"use client";

import { useEffect, useRef, useState } from "react";
import type { RerunOverrides } from "@/lib/oj/rerun";

interface RerunSheetProps {
  /** The base prompt being rerun (seed already stripped), shown for context. */
  basePrompt: string;
  loading?: boolean;
  onSubmit: (overrides: RerunOverrides) => void;
  onCancel: () => void;
}

/** Parse an input value into a number, or null when blank (= leave untouched). */
function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

const S_PRESETS = [0, 100, 250, 500, 750, 1000];

/**
 * Compact editable-rerun panel: tweak stylize / chaos / aspect / seed
 * and fan out N variants. Blank numeric fields leave the prompt's existing flag
 * untouched. Built for the s-slider dataset loop (sweep --s, several seeds each).
 */
export function RerunSheet({
  basePrompt,
  loading = false,
  onSubmit,
  onCancel,
}: RerunSheetProps) {
  const [stylize, setStylize] = useState("");
  const [chaos, setChaos] = useState("");
  const [aspect, setAspect] = useState("");
  const [seed, setSeed] = useState("");
  const [count, setCount] = useState("1");
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss when clicking outside the panel.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onCancel]);

  const submit = () => {
    onSubmit({
      stylize: numOrNull(stylize),
      chaos: numOrNull(chaos),
      aspect: aspect.trim() || null,
      seed: numOrNull(seed),
      count: Math.max(1, Math.min(25, Number(count) || 1)),
    });
  };

  const field =
    "w-full h-8 bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-lg px-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-secondary)]";
  const label = "text-[11px] text-[var(--text-muted)] mb-1";

  return (
    <div
      ref={ref}
      // Inline fold-out under the Rerun row (not a popover): the lightbox
      // action list scrolls, and an absolutely-positioned sheet got clipped.
      className="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"
      role="dialog"
      aria-label="Rerun with parameters"
    >
      <div className="mb-2 line-clamp-2 text-xs text-[var(--text-tertiary)]">
        {basePrompt}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className={label}>Stylize (--s)</div>
          <input
            className={field}
            inputMode="numeric"
            placeholder="keep"
            value={stylize}
            onChange={(e) => setStylize(e.target.value)}
            aria-label="Stylize"
          />
        </div>
        <div>
          <div className={label}>Chaos</div>
          <input
            className={field}
            inputMode="numeric"
            placeholder="keep"
            value={chaos}
            onChange={(e) => setChaos(e.target.value)}
            aria-label="Chaos"
          />
        </div>
        <div>
          <div className={label}>Aspect (--ar)</div>
          <input
            className={field}
            placeholder="keep"
            value={aspect}
            onChange={(e) => setAspect(e.target.value)}
            aria-label="Aspect ratio"
          />
        </div>
        <div>
          <div className={label}>Base seed</div>
          <input
            className={field}
            inputMode="numeric"
            placeholder="random"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            aria-label="Base seed"
          />
        </div>
        <div>
          <div className={label}>Count</div>
          <input
            className={field}
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-label="Variant count"
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {S_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStylize(String(s))}
            className={`rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
              stylize === String(s)
                ? "bg-[var(--accent-primary)] text-white"
                : "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            aria-pressed={stylize === String(s)}
            aria-label={`Set stylize to ${s}`}
            title={`Set stylize to ${s}`}
          >
            s{s}
          </button>
        ))}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          title="Close without rerunning (Esc)"
          aria-label="Cancel rerun"
          className="h-8 rounded-lg px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={loading}
          title="Queue the rerun with these settings"
          aria-label="Rerun with these settings"
          className="h-8 rounded-lg bg-[var(--accent-primary)] px-3 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {loading ? "Running…" : "Rerun"}
        </button>
      </div>
    </div>
  );
}
