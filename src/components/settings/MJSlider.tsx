"use client";

import { SettingLabel } from "./SettingLabel";

interface MJSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  marks?: string[];
  disabled?: boolean;
  helpUrl?: string;
}

export function MJSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  marks,
  disabled = false,
  helpUrl,
}: MJSliderProps) {
  const range = max - min || 1;
  const progress = ((value - min) / range) * 100;

  return (
    <div className="group/bar">
      <div className="mb-2 flex items-center justify-between gap-3">
        <SettingLabel label={label} helpUrl={helpUrl} />
        <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-xs tabular-nums text-[var(--text-secondary)]">
          {value}
        </span>
      </div>

      <div className="relative flex h-8 items-center">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--bg-tertiary)]" />
        <div
          className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--text-secondary)]"
          style={{ width: `${progress}%` }}
        />
        {/* Tooltip above thumb */}
        <div
          className="pointer-events-none absolute -top-7 z-20 opacity-0 transition-opacity duration-150 group-hover/bar:opacity-100"
          style={{ left: `calc(${progress}% - 16px)` }}
        >
          <span className="rounded bg-[var(--text-secondary)] px-1 py-0.5 text-[10px] font-medium tabular-nums text-white">
            {value}
          </span>
        </div>
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          className="slider relative z-10 w-full"
          style={{
            background: "transparent",
          }}
        />
      </div>

      {marks ? (
        <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]">
          {marks.map((mark) => (
            <span key={mark}>{mark}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default MJSlider;
