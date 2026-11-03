"use client";

import { ChevronDown } from "lucide-react";
import { ReactNode, useMemo, useState } from "react";

interface SettingCardProps {
  title: string;
  children: ReactNode;
  onReset?: () => void;
  defaultOpen?: boolean;
  headerSummary?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function SettingCard({
  title,
  children,
  onReset,
  defaultOpen = true,
  headerSummary,
  className = "",
  bodyClassName = "",
}: SettingCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const sectionState = useMemo(() => (isOpen ? "open" : "closed"), [isOpen]);

  return (
    <div
      className={`group flex min-h-12 flex-col overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-panel ${className}`}
      data-fill-when-open="false"
      data-fill-when-expanded="false"
      data-min-open-body-height="0"
      data-section-state={sectionState}
    >
      <div className="group/title flex w-full select-none items-center gap-3 px-4 py-3 text-left">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={isOpen}
        >
          <div className="min-w-0 flex-1">
            <div className="text-balance text-sm font-semibold text-[var(--text-primary)]">
              {title}
            </div>
            {!isOpen && headerSummary ? (
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                {headerSummary}
              </div>
            ) : null}
          </div>

          <span className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-muted)] transition-[background-color,color,transform] duration-150 group-hover/title:bg-[var(--bg-hover)] group-hover/title:text-[var(--text-primary)]">
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
            />
          </span>
        </button>

        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="mr-2 text-xs font-normal tracking-wide text-[var(--text-muted)] opacity-70 transition-opacity hover:underline hover:opacity-100"
          >
            Reset
          </button>
        ) : null}
      </div>

      {isOpen ? (
        <div
          className={`@container/box flex h-full grow flex-col gap-2 px-5 pb-4 ${bodyClassName}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export default SettingCard;
