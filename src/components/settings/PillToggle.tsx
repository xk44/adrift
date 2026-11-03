"use client";

import type { ReactNode } from "react";

interface PillToggleOption<T extends string | number> {
  label: string;
  value: T;
  icon?: ReactNode;
}

interface PillToggleProps<T extends string | number> {
  options: Array<PillToggleOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function PillToggle<T extends string | number>({
  options,
  value,
  onChange,
  className = "",
}: PillToggleProps<T>) {
  return (
    <div className={`flex items-center justify-end ${className}`}>
      {options.map((option, index) => {
        const isActive = option.value === value;
        const roundedClass =
          index === 0
            ? "rounded-l-full"
            : index === options.length - 1
              ? "rounded-r-full"
              : "";

        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex min-w-10 items-center justify-center gap-1 border px-2.5 py-1.5 text-sm font-semibold transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.96] ${roundedClass} ${
              isActive
                ? "border-splash/20 bg-splash/20 text-splash hover:!bg-splash/30"
                : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            } ${index > 0 ? "-ml-px" : ""}`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default PillToggle;
