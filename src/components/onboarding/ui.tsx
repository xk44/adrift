"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import type { CompatVerdict } from "@/lib/models/compat";
import { VERDICT_LABEL } from "@/lib/models/compat";

/** Copy to clipboard; `copied` holds the last id for ~1.6 s. */
export function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((id: string, text: string) => {
    const done = () => {
      setCopied(id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1600);
    };
    try {
      navigator.clipboard.writeText(text).then(done, () => {});
    } catch {
      /* no clipboard API (plain http on another device): text stays selectable */
    }
  }, []);
  return [copied, copy];
}

const BTN_BASE =
  "inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:cursor-not-allowed disabled:opacity-50";

export const BTN = {
  primary: `${BTN_BASE} bg-splash text-white hover:bg-splash/90`,
  secondary: `${BTN_BASE} border border-light-200 text-light-primary hover:bg-light-100 dark:border-dark-750 dark:text-dark-primary dark:hover:bg-dark-750`,
  ghost: `${BTN_BASE} text-light-500 hover:bg-light-100 hover:text-light-primary dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary`,
};

export const INPUT =
  "min-h-[40px] w-full rounded-xl border border-light-200 bg-transparent px-3 text-[14px] text-light-primary placeholder:text-light-400 focus:border-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash/40 dark:border-dark-750 dark:text-dark-primary dark:placeholder:text-dark-400";

export const MUTED = "text-light-500 dark:text-dark-400";

const VERDICT_STYLE: Record<CompatVerdict, string> = {
  fits: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  tight: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  too_big: "bg-red-500/10 text-red-600 dark:text-red-400",
  unsupported: "bg-red-500/10 text-red-600 dark:text-red-400",
  unknown: "bg-light-100 text-light-500 dark:bg-dark-750 dark:text-dark-400",
};

export function Chip({
  className,
  children,
  title,
}: {
  className: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

export function VerdictChip({
  verdict,
  reason,
}: {
  verdict: CompatVerdict;
  reason?: string | null;
}) {
  return (
    <Chip className={VERDICT_STYLE[verdict]} title={reason ?? undefined}>
      {VERDICT_LABEL[verdict]}
    </Chip>
  );
}

export const CHIP_NEUTRAL =
  "bg-light-100 text-light-500 dark:bg-dark-750 dark:text-dark-400";
export const CHIP_OK =
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
export const CHIP_WARN = "bg-amber-500/10 text-amber-600 dark:text-amber-400";

/** A command in a selectable box with a copy button. */
export function CommandBox({
  id,
  text,
  copied,
  onCopy,
  label = "Copy command",
}: {
  id: string;
  text: string;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
  label?: string;
}) {
  const done = copied === id;
  return (
    <div className="flex items-start gap-1 rounded-xl bg-light-100 p-2 dark:bg-dark-850">
      <code className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed">
        {text}
      </code>
      <button
        type="button"
        onClick={() => onCopy(id, text)}
        aria-label={done ? "Copied" : label}
        title={label}
        className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-light-500 hover:bg-light-200 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
      >
        {done ? (
          <Check className="h-4 w-4 text-emerald-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
